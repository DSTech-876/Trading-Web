<?php
/**
 * GET|POST /api/mt5/pull.php
 * MT5 bridge polling endpoint (EA side) to fetch queued orders.
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
if (!rateLimit(180, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$body = $_SERVER['REQUEST_METHOD'] === 'POST' ? getJsonBody() : [];
// Resolves to the specific user who owns this bridge key — NOT the shared
// admin MT5_BRIDGE_KEY. Every order below is filtered to this user's own
// orders so a second user's EA (or a misconfigured/stale terminal id) can
// never be handed this user's trade (or vice versa).
$bridgeUserId = mt5ResolveBridgeUserId($body);

$limit = (int) ($_GET['limit'] ?? $body['limit'] ?? 20);
$limit = max(1, min(100, $limit));
$terminal = trim((string) ($_GET['terminal'] ?? $body['terminal'] ?? ''));
$retryAfterSecs = 20;
$now = time();
$halted = mt5IsHalted();

$census = ['totalOrders' => 0, 'byStatus' => [], 'byTerminal' => [], 'notDispatched' => []];

// While halted, do not dispatch any new/retry orders to the EA. Existing
// in-flight orders are left untouched so status callbacks still work.
$orders = $halted ? [] : mt5WithStateLock(function (array &$state) use ($limit, $terminal, $retryAfterSecs, $now, $bridgeUserId, &$census): array {
    $out = [];
    $assigned = [];
    foreach ($state['orders'] as &$order) {
        if (count($out) >= $limit) break;
        // Cross-user isolation: this terminal's bridge key only ever sees
        // its own user's orders, regardless of terminal id/pinning below.
        if ((int) ($order['userId'] ?? -1) !== $bridgeUserId) continue;
        $status = (string) ($order['status'] ?? '');
        if (in_array($status, MT5_FINAL_STATUS, true)) continue;

        $orderTerminal = trim((string) ($order['terminal'] ?? ''));
        if ($terminal !== '' && $orderTerminal !== '' && $orderTerminal !== $terminal) {
            continue;
        }

        $lastDispatch = (int) ($order['lastDispatchedAt'] ?? 0);
        $dispatchable = ($status === 'QUEUED')
            || ($status === 'DISPATCHED' && ($now - $lastDispatch) >= $retryAfterSecs);
        if (!$dispatchable) continue;

        $order['status'] = 'DISPATCHED';
        $order['attempts'] = ((int) ($order['attempts'] ?? 0)) + 1;
        $order['updatedAt'] = $now;
        $order['lastDispatchedAt'] = $now;
        if ($terminal !== '') $order['terminal'] = $terminal;
        if (!isset($order['history']) || !is_array($order['history'])) $order['history'] = [];
        $order['history'][] = ['status' => 'DISPATCHED', 'ts' => $now, 'message' => 'Dispatched to EA'];
        $assigned[] = [
            'signalId' => ($order['signalId'] ?? '') !== '' ? $order['signalId'] : null,
            'orderId' => (string) ($order['orderId'] ?? ''),
            'symbol' => $order['symbol'] ?? null,
            'lot' => $order['lot'] ?? null,
            // The terminal actually bound to the order, not merely the
            // request parameter: a blank-terminal poll is allowed to
            // dispatch an order that was already pinned to a terminal, and
            // recording the request's blank value here would falsely wipe
            // the assignment from the lifecycle event.
            'terminal' => ($order['terminal'] ?? '') !== '' ? $order['terminal'] : null,
            'status' => 'DISPATCHED',
        ];

        $out[] = $order;
    }
    unset($order);

    // Per-terminal poll counters, updated on EVERY poll. These are what prove
    // "the EA is reaching pull.php" without writing a ledger entry per poll:
    // at the EA's 2s default interval that would evict every SIGNAL_*/ORDER_*
    // record from the bounded event ring within minutes, destroying the very
    // audit trail this ledger exists for. Discrete PULL_REQUEST/PULL_RESPONSE/
    // ORDER_ASSIGNED events are therefore only recorded when a poll actually
    // dispatched something.
    $terminalKey = $terminal !== '' ? substr($terminal, 0, MT5_TERMINAL_KEY_MAX_LEN) : '(unassigned)';
    if (!isset($state['pullStats']) || !is_array($state['pullStats'])) $state['pullStats'] = [];
    $stats = is_array($state['pullStats'][$terminalKey] ?? null) ? $state['pullStats'][$terminalKey] : [];
    $state['pullStats'][$terminalKey] = [
        'terminal' => $terminalKey,
        'firstPullAt' => $stats['firstPullAt'] ?? $now,
        'lastPullAt' => $now,
        'pollCount' => ((int) ($stats['pollCount'] ?? 0)) + 1,
        'emptyPollCount' => ((int) ($stats['emptyPollCount'] ?? 0)) + ($out === [] ? 1 : 0),
        'dispatchedCount' => ((int) ($stats['dispatchedCount'] ?? 0)) + count($out),
        'lastDispatchAt' => $out !== [] ? $now : ($stats['lastDispatchAt'] ?? null),
    ];
    // Bound the number of distinct terminals retained: prune to the
    // MT5_PULL_STATS_MAX_TERMINALS most recently active ones so an
    // ever-growing stream of distinct terminal values cannot accumulate
    // permanent keys in the state file.
    if (count($state['pullStats']) > MT5_PULL_STATS_MAX_TERMINALS) {
        uasort(
            $state['pullStats'],
            static fn(array $a, array $b): int => ($b['lastPullAt'] ?? 0) <=> ($a['lastPullAt'] ?? 0)
        );
        $state['pullStats'] = array_slice($state['pullStats'], 0, MT5_PULL_STATS_MAX_TERMINALS, true);
    }

    if ($assigned !== []) {
        mt5RecordEvent($state, 'PULL_REQUEST', [
            'terminal' => $terminal !== '' ? $terminal : null,
            'limit' => $limit,
            'totalOrders' => count($state['orders']),
        ], $now);
        foreach ($assigned as $row) {
            mt5RecordEvent($state, 'ORDER_ASSIGNED', $row, $now);
        }
        mt5RecordEvent($state, 'PULL_RESPONSE', [
            'terminal' => $terminal !== '' ? $terminal : null,
            'count' => count($out),
            'orderIds' => array_column($assigned, 'orderId'),
        ], $now);
    }

    $census = mt5QueueCensus(
        array_filter($state['orders'], static fn($o): bool => is_array($o) && (int) ($o['userId'] ?? -1) === $bridgeUserId),
        array_map(static fn(array $o): string => (string) ($o['orderId'] ?? ''), $out),
        $terminal,
        $now,
        $retryAfterSecs
    );

    return $out;
});

if ($halted) {
    $state = mt5ReadState();
    $usersOrders = array_filter($state['orders'], static fn($o): bool => is_array($o) && (int) ($o['userId'] ?? -1) === $bridgeUserId);
    $census = mt5QueueCensus($usersOrders, [], $terminal, $now, $retryAfterSecs, true);
}

$public = array_map(static fn(array $o): array => [
    'orderId' => $o['orderId'] ?? '',
    'symbol' => $o['symbol'] ?? '',
    'brokerSymbolHint' => ($o['brokerSymbolHint'] ?? '') !== '' ? $o['brokerSymbolHint'] : null,
    'side' => $o['side'] ?? '',
    'orderType' => $o['orderType'] ?? '',
    'entry' => $o['entry'] ?? null,
    'sl' => $o['sl'] ?? null,
    'tp' => $o['tp'] ?? null,
    'lot' => $o['lot'] ?? null,
    'digits' => $o['digits'] ?? null,
    'point' => $o['point'] ?? null,
    'source' => $o['source'] ?? null,
    'strategyName' => $o['strategyName'] ?? null,
    'isOpposite' => (bool) ($o['isOpposite'] ?? false),
    'idempotencyKey' => $o['idempotencyKey'] ?? '',
    'attempts' => $o['attempts'] ?? 0,
    'createdAt' => $o['createdAt'] ?? null,
], $orders);

// Log pull.php diagnostics only when the queue state/reason summary changes
// (plus a throttled heartbeat), and summarize the per-order skip list rather
// than emitting one entry per retained order. Previously every poll was
// logged in full; at the EA's ~2s default interval that produced ~43,200
// entries per terminal per day — most of them identical "nothing changed"
// reports — with no pruning path for the resulting log file.
$notDispatchedSummary = mt5SummarizeNotDispatched($census['notDispatched']);
$event = $public !== [] ? 'PULL_RESPONSE_DISPATCH' : 'PULL_RESPONSE_EMPTY';
$logSignature = json_encode([
    'event' => $event,
    'halted' => $halted,
    'byStatus' => $census['byStatus'],
    'byTerminal' => $census['byTerminal'],
    'notDispatchedByReason' => $notDispatchedSummary['byReason'],
    'dispatchedCount' => count($public),
], JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);

if (mt5ShouldLogPullEvent($terminal, (string) $logSignature, $now)) {
    mt5LogDiagnostic('pull.php', [
        'event' => $event,
        'terminal' => $terminal !== '' ? $terminal : null,
        'limit' => $limit,
        'halted' => $halted,
        'count' => count($public),
        'queue' => [
            'totalOrders' => $census['totalOrders'],
            'byStatus' => $census['byStatus'],
            'byTerminal' => $census['byTerminal'],
            'notDispatchedSample' => $notDispatchedSummary['sample'],
            'notDispatchedTotal' => $notDispatchedSummary['total'],
            'notDispatchedTruncated' => $notDispatchedSummary['truncated'],
            'notDispatchedByReason' => $notDispatchedSummary['byReason'],
        ],
        'dispatchedOrderIds' => array_column($public, 'orderId'),
        'mappedSymbols' => $public !== []
            ? array_combine(
                array_column($public, 'orderId'),
                array_map(static fn(array $o) => $o['brokerSymbolHint'] ?? $o['symbol'], $public)
            )
            : [],
    ]);
}

jsonResponse([
    'ok' => true,
    'serverTime' => $now,
    'halted' => $halted,
    'haltReason' => $halted ? mt5HaltReason() : null,
    'dailyLossLimitPct' => mt5GetDailyLossLimitPct(),
    'count' => count($public),
    // Rows found vs rows returned, so an empty poll is self-explaining to the
    // operator without needing server log access.
    'queue' => [
        'totalOrders' => $census['totalOrders'],
        'byStatus' => $census['byStatus'],
        'byTerminal' => $census['byTerminal'],
    ],
    'orders' => $public,
]);

