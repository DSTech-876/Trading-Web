<?php
/**
 * GET|POST /api/mt5/audit.php
 * ───────────────────────────
 * End-to-end MT5 trade execution audit.
 *
 * Answers, from the actual persisted bridge state (never from guesses), the
 * single question an operator has when `pull.php` keeps returning
 * `{"count":0,"orders":[]}` while the EA is plainly connected and `halted` is
 * false: **at which stage of the pipeline did the chain break?**
 *
 *   Indicator → Signal Generation → Signal Validation → Signal Ledger
 *   → Order Queue → pull.php → EA → MT5 OrderSend → Deriv MT5 execution
 *
 * Sections mirror the audit checklist:
 *   1 signals            — every signal the engine reported, with timestamps
 *   2 orderQueue         — every queued order and the signal it came from
 *   3 filters            — rejection counts/rows grouped by filter
 *   4 pull               — the exact selection predicate, rows found vs rows
 *                          returned, case/terminal-mismatch checks
 *   5 bridge             — per-order terminal assignment
 *   6 derivValidation    — per-order compliance with Deriv MT5 constraints
 *   7 ea                 — proof the EA polled, received and acted on orders
 *   8 execution          — OrderSend outcomes reported back by the EA
 *   9 discrepancies      — signals without orders, orders without signals,
 *                          queued-but-not-delivered, delivered-but-not-executed
 *  10 events             — the raw permanent lifecycle log
 *
 * Auth: the bridge key (same secret the EA uses). This endpoint exposes queue
 * internals, so it must never be reachable unauthenticated.
 */

declare(strict_types=1);
require_once __DIR__ . '/common.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'Method not allowed'], 405);
}
if (!rateLimit(30, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$body = $_SERVER['REQUEST_METHOD'] === 'POST' ? getJsonBody() : [];
mt5RequireBridgeKey($body);

$terminal = trim((string) ($_GET['terminal'] ?? $body['terminal'] ?? ''));
$now = time();
$halted = mt5IsHalted();
$retryAfterSecs = 20;

// Read under the shared lock writers hold while truncating/rewriting the
// state file, so this endpoint never observes an empty/partial in-flight
// write (which would otherwise falsely report SIGNAL_GENERATION or preserve
// a transient partial write as `.corrupt`).
[$state, ] = mt5ReadStateLockedWithWatermark();
$orders = is_array($state['orders'] ?? null) ? $state['orders'] : [];
$signals = is_array($state['signals'] ?? null) ? $state['signals'] : [];
$events = is_array($state['events'] ?? null) ? $state['events'] : [];
$pullStats = is_array($state['pullStats'] ?? null) ? $state['pullStats'] : [];

$iso = static fn($ts): ?string => is_numeric($ts) && (int) $ts > 0
    ? gmdate('Y-m-d\TH:i:s\Z', (int) $ts)
    : null;

/* ── 1. SIGNAL AUDIT ────────────────────────────────────────────────── */
$signalRows = [];
$signalsByOrderId = [];
foreach ($signals as $signalId => $s) {
    if (!is_array($s)) continue;
    $orderId = (string) ($s['orderId'] ?? '');
    if ($orderId !== '') $signalsByOrderId[$orderId] = (string) $signalId;
    $signalRows[] = [
        'signal_id' => (string) $signalId,
        'symbol' => $s['symbol'] ?? null,
        'direction' => $s['direction'] ?? null,
        'confidence' => $s['confidence'] ?? null,
        'source' => $s['source'] ?? null,
        'strategy_name' => $s['strategyName'] ?? null,
        'created_time' => $iso($s['createdTime'] ?? null),
        'created_ts' => isset($s['createdTime']) ? (int) $s['createdTime'] : null,
        'status' => $s['status'] ?? 'UNKNOWN',
        'order_id' => $orderId !== '' ? $orderId : null,
        'rejection_reason' => $s['rejectionReason'] ?? null,
        'rejection_filter' => $s['rejectionFilter'] ?? null,
    ];
}
usort($signalRows, static fn(array $a, array $b): int => ($a['created_ts'] ?? 0) <=> ($b['created_ts'] ?? 0));

$discardedSignals = array_values(array_filter(
    $signalRows,
    static fn(array $r): bool => $r['status'] === 'REJECTED'
));

/* ── 2. ORDER QUEUE AUDIT ───────────────────────────────────────────── */
$orderRows = [];
foreach ($orders as $orderId => $o) {
    if (!is_array($o)) continue;
    $orderRows[] = [
        'signal_id' => ($o['signalId'] ?? '') !== '' ? $o['signalId'] : ($signalsByOrderId[(string) $orderId] ?? null),
        'order_id' => (string) $orderId,
        'status' => $o['status'] ?? 'UNKNOWN',
        'terminal' => ($o['terminal'] ?? '') !== '' ? $o['terminal'] : null,
        'last_status_terminal' => $o['lastStatusTerminal'] ?? null,
        'symbol' => $o['symbol'] ?? null,
        'broker_symbol_hint' => ($o['brokerSymbolHint'] ?? '') !== '' ? $o['brokerSymbolHint'] : null,
        'side' => $o['side'] ?? null,
        'order_type' => $o['orderType'] ?? null,
        'volume' => $o['lot'] ?? null,
        'entry' => $o['entry'] ?? null,
        'sl' => $o['sl'] ?? null,
        'tp' => $o['tp'] ?? null,
        'digits' => $o['digits'] ?? null,
        'attempts' => (int) ($o['attempts'] ?? 0),
        'broker_ticket' => $o['brokerTicket'] ?? null,
        'message' => $o['message'] ?? null,
        'created_time' => $iso($o['createdAt'] ?? null),
        'updated_time' => $iso($o['updatedAt'] ?? null),
        'last_dispatched_at' => $iso($o['lastDispatchedAt'] ?? null),
    ];
}
usort($orderRows, static fn(array $a, array $b): int => strcmp((string) $a['order_id'], (string) $b['order_id']));

/* ── 3. ORDER FILTER AUDIT ──────────────────────────────────────────── */
$rejectionsByFilter = [];
$rejectionRows = [];
foreach ($signalRows as $r) {
    if ($r['status'] !== 'REJECTED') continue;
    $filter = (string) ($r['rejection_filter'] ?? 'other');
    $rejectionsByFilter[$filter] = ($rejectionsByFilter[$filter] ?? 0) + 1;
    $rejectionRows[] = [
        'signal_id' => $r['signal_id'],
        'symbol' => $r['symbol'],
        'filter' => $filter,
        'rejection_reason' => $r['rejection_reason'],
        'created_time' => $r['created_time'],
    ];
}
arsort($rejectionsByFilter);

/* ── 4. PULL.PHP AUDIT ──────────────────────────────────────────────── */
$census = mt5QueueCensus($orders, [], $terminal, $now, $retryAfterSecs, $halted);
$statusTokens = [];
$terminalTokens = [];
foreach ($orders as $o) {
    if (!is_array($o)) continue;
    $statusTokens[(string) ($o['status'] ?? '')] = true;
    $t = trim((string) ($o['terminal'] ?? ''));
    if ($t !== '') $terminalTokens[$t] = true;
}
$statusTokens = array_keys($statusTokens);
$terminalTokens = array_keys($terminalTokens);

$unrecognizedStatuses = array_values(array_filter(
    $statusTokens,
    static fn(string $s): bool => $s !== '' && !in_array($s, MT5_ALLOWED_STATUS, true)
));
$caseOnlyStatusMismatch = array_values(array_filter(
    $unrecognizedStatuses,
    static fn(string $s): bool => in_array(strtoupper($s), MT5_ALLOWED_STATUS, true)
));
$caseOnlyTerminalMismatch = $terminal === '' ? [] : array_values(array_filter(
    $terminalTokens,
    static fn(string $t): bool => $t !== $terminal && strcasecmp($t, $terminal) === 0
));
$exactTerminalMismatch = $terminal === '' ? [] : array_values(array_filter(
    $terminalTokens,
    static fn(string $t): bool => strcasecmp($t, $terminal) !== 0
));

// Terminals actually capable of blocking dispatch: only orders still
// QUEUED/DISPATCHED can be pulled at all, so a terminal pinned to a FILLED,
// RECEIVED or other historical order must not be blamed for an empty queue.
// pull.php compares with strict `!==`, so any inequality — including a
// case-only difference such as "mt5-term-01" vs "MT5-TERM-01" — blocks it.
$blockingTerminalTokens = [];
foreach ($orders as $o) {
    if (!is_array($o)) continue;
    $status = (string) ($o['status'] ?? '');
    if ($status !== 'QUEUED' && $status !== 'DISPATCHED') continue;
    $t = trim((string) ($o['terminal'] ?? ''));
    if ($t !== '') $blockingTerminalTokens[$t] = true;
}
$blockingTerminalMismatches = $terminal === '' ? [] : array_values(array_filter(
    array_keys($blockingTerminalTokens),
    static fn(string $t): bool => $t !== $terminal
));

// pull.php performs no SQL: the queue is a flock()-guarded JSON document.
// This is the literal selection predicate it applies, reproduced so the
// "exact query executed" question has a truthful answer.
$selectionPredicate = 'status NOT IN (FILLED, REJECTED, CANCELLED, EXPIRED)'
    . ' AND (order.terminal = "" OR request.terminal = "" OR order.terminal === request.terminal)'
    . ' AND (status === "QUEUED" OR (status === "DISPATCHED" AND now - lastDispatchedAt >= ' . $retryAfterSecs . '))'
    . ' LIMIT :limit  /* evaluated in PHP over ' . mt5StoragePath() . ' — comparisons are case-sensitive (===) */';

$dispatchableNow = 0;
foreach ($orders as $o) {
    if (!is_array($o)) continue;
    $status = (string) ($o['status'] ?? '');
    if (in_array($status, MT5_FINAL_STATUS, true)) continue;
    $ot = trim((string) ($o['terminal'] ?? ''));
    if ($terminal !== '' && $ot !== '' && $ot !== $terminal) continue;
    if ($status === 'QUEUED'
        || ($status === 'DISPATCHED' && ($now - (int) ($o['lastDispatchedAt'] ?? 0)) >= $retryAfterSecs)) {
        $dispatchableNow++;
    }
}

/* ── 5. MT5 BRIDGE AUDIT ────────────────────────────────────────────── */
$assignments = array_map(static fn(array $r): array => [
    'order_id' => $r['order_id'],
    'symbol' => $r['symbol'],
    'volume' => $r['volume'],
    'terminal' => $r['terminal'],
    'status' => $r['status'],
], $orderRows);
$misassigned = $terminal === '' ? [] : array_values(array_filter(
    $assignments,
    static fn(array $r): bool => $r['terminal'] !== null && $r['terminal'] !== $terminal
));

/* ── 6. DERIV MT5 VALIDATION ────────────────────────────────────────── */
$invalidOrders = [];
foreach ($orderRows as $r) {
    $problems = [];
    if (($r['symbol'] ?? '') === '') $problems[] = 'symbol missing';
    if (!in_array((string) $r['order_type'], MT5_ALLOWED_ORDER_TYPES, true)) {
        $problems[] = 'unsupported orderType: ' . (string) $r['order_type'];
    }
    $vol = (float) ($r['volume'] ?? 0);
    if ($vol <= 0) $problems[] = 'volume must be > 0';
    $entry = (float) ($r['entry'] ?? 0);
    $sl = (float) ($r['sl'] ?? 0);
    $tp = (float) ($r['tp'] ?? 0);
    if ($entry <= 0) $problems[] = 'entry must be > 0';
    if ($sl <= 0) $problems[] = 'SL missing — Deriv MT5 order would be unprotected';
    if ($tp <= 0) $problems[] = 'TP missing';
    if ($entry > 0 && $sl > 0 && $tp > 0) {
        if ($r['side'] === 'BUY' && !($sl < $entry && $tp > $entry)) {
            $problems[] = 'BUY requires sl < entry < tp';
        }
        if ($r['side'] === 'SELL' && !($sl > $entry && $tp < $entry)) {
            $problems[] = 'SELL requires tp < entry < sl';
        }
    }
    if ($problems !== []) {
        $invalidOrders[] = ['order_id' => $r['order_id'], 'symbol' => $r['symbol'], 'problems' => $problems];
    }
}

/* ── 7/8. EA + ORDERSEND AUDIT ──────────────────────────────────────── */
$eventsByOrder = [];
foreach ($events as $e) {
    if (!is_array($e)) continue;
    $oid = (string) ($e['orderId'] ?? '');
    if ($oid === '') continue;
    $eventsByOrder[$oid][] = (string) ($e['event'] ?? '');
}
$executionRows = [];
foreach ($orderRows as $r) {
    $seen = $eventsByOrder[$r['order_id']] ?? [];
    $executionRows[] = [
        'order_id' => $r['order_id'],
        'signal_id' => $r['signal_id'],
        'symbol' => $r['broker_symbol_hint'] ?? $r['symbol'],
        'volume' => $r['volume'],
        'entry' => $r['entry'],
        'sl' => $r['sl'],
        'tp' => $r['tp'],
        'dispatched' => in_array('ORDER_ASSIGNED', $seen, true),
        'received_by_ea' => in_array('ORDER_RECEIVED', $seen, true),
        // The 1,000-entry event ring can evict the lifecycle events that
        // proved these outcomes (or pre-existing orders may never have had
        // one logged at all). Fall back to the durable order status, which
        // persists independently of the ring, so a persisted FILLED/REJECTED
        // order is never misreported as not executed/not failed.
        'executed' => in_array('ORDER_EXECUTED', $seen, true) || $r['status'] === 'FILLED',
        'failed' => in_array('ORDER_FAILED', $seen, true) || $r['status'] === 'REJECTED',
        'broker_ticket' => $r['broker_ticket'],
        // The EA reports the MT5 retcode + description in the status message.
        'broker_message' => $r['message'],
        'attempts' => $r['attempts'],
        'final_status' => $r['status'],
    ];
}

/* ── 9. DATABASE DISCREPANCY REPORT ─────────────────────────────────── */
$orderIdSet = [];
foreach ($orderRows as $r) $orderIdSet[$r['order_id']] = $r;

$signalsWithoutOrders = array_values(array_map(
    static fn(array $r): array => [
        'signal_id' => $r['signal_id'],
        'symbol' => $r['symbol'],
        'status' => $r['status'],
        'reason' => $r['status'] === 'REJECTED'
            ? ($r['rejection_reason'] ?? 'rejected')
            : 'accepted by the signal engine but signal.php never created an order',
    ],
    array_filter($signalRows, static fn(array $r): bool => $r['order_id'] === null || !isset($orderIdSet[$r['order_id']]))
));
$ordersWithoutSignals = array_values(array_map(
    static fn(array $r): array => ['order_id' => $r['order_id'], 'symbol' => $r['symbol'], 'status' => $r['status']],
    array_filter($orderRows, static fn(array $r): bool => $r['signal_id'] === null || !isset($signals[(string) $r['signal_id']]))
));
$queuedNotDelivered = array_values(array_map(
    static fn(array $r): array => [
        'order_id' => $r['order_id'],
        'symbol' => $r['symbol'],
        'status' => $r['status'],
        'terminal' => $r['terminal'],
        'age_secs' => $r['created_time'] !== null ? $now - strtotime($r['created_time']) : null,
    ],
    array_filter($orderRows, static fn(array $r): bool => $r['status'] === 'QUEUED')
));
$deliveredNotExecuted = array_values(array_map(
    static fn(array $r): array => [
        'order_id' => $r['order_id'],
        'symbol' => $r['symbol'],
        'status' => $r['status'],
        'terminal' => $r['terminal'],
        'attempts' => $r['attempts'],
    ],
    array_filter(
        $orderRows,
        static fn(array $r): bool => in_array($r['status'], ['DISPATCHED', 'RECEIVED', 'MODIFIED'], true)
    )
));

/* ── Root-cause classification ──────────────────────────────────────── */
$totalOrders = count($orderRows);
// Polling is per-terminal: pull.php keys pullStats by the request's own
// terminal (or "(unassigned)" when blank). Checking $pullStats !== []
// treats any OTHER terminal's poll history as proof this terminal polled,
// which misclassifies a never-polled terminal as IN_FLIGHT instead of
// EA_POLLING. Check the requested terminal's own key when one was supplied.
$polled = $terminal !== '' ? isset($pullStats[$terminal]) : $pullStats !== [];
if ($halted) {
    $stage = 'PULL_DISPATCH';
    $rootCause = 'MT5_TRADING_HALTED is set — pull.php suppresses all dispatch. ' . mt5HaltReason();
} elseif ($signalRows === [] && $totalOrders === 0) {
    $stage = 'SIGNAL_GENERATION';
    $rootCause = 'No signal was ever reported to the server. The signal engine runs in the browser '
        . '(indicator/indicator.js); the chain breaks upstream of this API. Check that the indicator page is '
        . 'open and streaming, the user is logged in, and Execution Mode is "MT5 Bridge" (autoTradeExecutionMode '
        . '=== "mt5"); it defaults to "deriv", in which case nothing is ever queued for MT5.';
} elseif ($totalOrders === 0 && $signalRows !== [] && count($discardedSignals) === count($signalRows)) {
    $stage = 'SIGNAL_FILTERS';
    $rootCause = sprintf(
        'Signals were generated (%d) but every one was discarded before an order could be created. '
            . 'Top rejecting filter: %s.',
        count($signalRows),
        $rejectionsByFilter !== [] ? (string) array_key_first($rejectionsByFilter) : 'unknown'
    );
} elseif ($totalOrders === 0) {
    // Some signals were accepted (not rejected by a filter) yet no order
    // exists for them: the break is between the signal engine and
    // signal.php, not a filter decision, so it must not be reported as
    // SIGNAL_FILTERS, which would contradict the ACCEPTED signal rows.
    $stage = 'SIGNAL_TO_ORDER_BREAK';
    $rootCause = sprintf(
        'Signals were generated (%d) and %d were accepted by the engine, but none resulted in a queued order. '
            . 'The chain breaks between the signal engine and signal.php (request never sent, auth failure, '
            . 'or an error in signal.php that was never reported back).',
        count($signalRows),
        count($signalRows) - count($discardedSignals)
    );
} elseif ($unrecognizedStatuses !== [] && $dispatchableNow === 0) {
    $stage = 'PULL_DISPATCH';
    $rootCause = sprintf(
        'Order(s) have unrecognized status token(s) [%s]. pull.php only dispatches QUEUED/retryable-DISPATCHED '
            . 'orders and only treats %s as final, so these orders are neither dispatchable nor final — they are '
            . 'permanently stuck.',
        implode(', ', $unrecognizedStatuses),
        implode(', ', MT5_FINAL_STATUS)
    );
} elseif ($dispatchableNow === 0 && $queuedNotDelivered === [] && $deliveredNotExecuted === []) {
    $stage = 'NONE';
    $rootCause = 'Every order in the queue has reached a final status. An empty pull.php response is correct here.';
} elseif ($blockingTerminalMismatches !== [] && $dispatchableNow === 0) {
    $stage = 'TERMINAL_BINDING';
    $rootCause = sprintf(
        'Orders exist but are pinned to terminal(s) [%s] while this request polls as "%s". pull.php matches '
            . 'terminal with strict equality (case-sensitive), so they are invisible to this EA.',
        implode(', ', $blockingTerminalMismatches),
        $terminal
    );
} elseif (!$polled) {
    $stage = 'EA_POLLING';
    $rootCause = 'Dispatchable orders exist but no EA poll has ever been recorded by pull.php.';
} else {
    $stage = 'IN_FLIGHT';
    $rootCause = sprintf(
        '%d order(s) are currently dispatchable and %d are in flight at the EA; dispatch is working.',
        $dispatchableNow,
        count($deliveredNotExecuted)
    );
}

jsonResponse([
    'ok' => true,
    'serverTime' => $now,
    'generatedAt' => $iso($now),
    'terminal' => $terminal !== '' ? $terminal : null,
    'halted' => $halted,
    'haltReason' => $halted ? mt5HaltReason() : null,
    'storage' => [
        'kind' => 'json-file',
        'path' => mt5StoragePath(),
        'note' => 'The MT5 bridge has no SQL tables. Queue, signal ledger and lifecycle events all live in '
            . 'this flock()-guarded JSON document, so there is no SQL query to inspect.',
    ],
    'rootCause' => ['stage' => $stage, 'detail' => $rootCause],

    'signals' => [
        'total' => count($signalRows),
        'discarded' => count($discardedSignals),
        'rows' => $signalRows,
    ],
    'orderQueue' => [
        'total' => $totalOrders,
        'byStatus' => $census['byStatus'],
        'byTerminal' => $census['byTerminal'],
        'rows' => $orderRows,
    ],
    'filters' => [
        'byFilter' => $rejectionsByFilter,
        'rows' => $rejectionRows,
    ],
    'pull' => [
        'selectionPredicate' => $selectionPredicate,
        'recordsFound' => $totalOrders,
        'recordsMatchingTerminal' => $totalOrders - count($misassigned),
        'recordsReturnedIfPolledNow' => $dispatchableNow,
        'statusTokensInQueue' => $statusTokens,
        'allowedStatusTokens' => MT5_ALLOWED_STATUS,
        'unrecognizedStatusTokens' => $unrecognizedStatuses,
        'caseOnlyStatusMismatches' => $caseOnlyStatusMismatch,
        'terminalTokensInQueue' => $terminalTokens,
        'caseOnlyTerminalMismatches' => $caseOnlyTerminalMismatch,
        'terminalMismatches' => $exactTerminalMismatch,
        'notDispatched' => $census['notDispatched'],
    ],
    'bridge' => ['assignments' => $assignments, 'misassigned' => $misassigned],
    'derivValidation' => [
        'checked' => $totalOrders,
        'invalid' => count($invalidOrders),
        'rows' => $invalidOrders,
        'note' => 'Symbol existence, trading-enabled, margin sufficiency and account permissions are terminal-side '
            . 'facts the server cannot observe; ITGuruMt5Bridge.mq5 checks them and reports SYMBOL_RESOLVE_FAIL / '
            . 'VALIDATION_FAIL / RISK_REJECT back through status.php.',
    ],
    'ea' => ['pullStats' => array_values($pullStats), 'everPolled' => $polled],
    'execution' => ['rows' => $executionRows],
    'discrepancies' => [
        'signalsWithoutOrders' => $signalsWithoutOrders,
        'ordersWithoutSignals' => $ordersWithoutSignals,
        'queuedNotDelivered' => $queuedNotDelivered,
        'deliveredNotExecuted' => $deliveredNotExecuted,
    ],
    'events' => $events,
]);
