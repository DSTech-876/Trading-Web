<?php
/**
 * POST /api/mt5/status.php
 * MT5 bridge callback endpoint to acknowledge/update order statuses.
 */

declare(strict_types=1);
require_once __DIR__ . '/common.php';

requirePost();
if (!rateLimit(180, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$rawBody = file_get_contents('php://input');
$body = getJsonBody();
// Resolves this EA's own user — see mt5ResolveBridgeUserId() doc in
// common.php. Every order update below is rejected unless the order being
// updated actually belongs to this user, so one user's EA can never alter
// another user's order lifecycle (even by guessing/replaying an orderId).
$bridgeUserId = mt5ResolveBridgeUserId($body);

$updates = $body['updates'] ?? null;
if (!is_array($updates)) {
    $single = [
        'orderId' => $body['orderId'] ?? null,
        'status' => $body['status'] ?? null,
        'brokerTicket' => $body['brokerTicket'] ?? null,
        'message' => $body['message'] ?? null,
        'filledPrice' => $body['filledPrice'] ?? null,
        'terminal' => $body['terminal'] ?? null,
    ];
    $updates = [$single];
}

$validUpdates = [];
$rejectedUpdates = [];
foreach ($updates as $u) {
    if (!is_array($u)) {
        $rejectedUpdates[] = ['reason' => 'not an object', 'raw' => $u];
        continue;
    }
    $orderId = trim((string) ($u['orderId'] ?? ''));
    $status = strtoupper(trim((string) ($u['status'] ?? '')));
    if ($orderId === '' || $status === '' || !in_array($status, MT5_ALLOWED_STATUS, true)) {
        $rejectedUpdates[] = [
            'reason' => $orderId === '' ? 'missing orderId' : ($status === '' ? 'missing status' : 'unrecognized status: ' . $status),
            'orderId' => $orderId,
            'status' => $status,
        ];
        continue;
    }
    $validUpdates[] = [
        'orderId' => $orderId,
        'status' => $status,
        'brokerTicket' => isset($u['brokerTicket']) ? (string) $u['brokerTicket'] : null,
        'message' => isset($u['message']) ? (string) $u['message'] : null,
        'filledPrice' => isset($u['filledPrice']) ? (float) $u['filledPrice'] : null,
        'terminal' => isset($u['terminal']) ? trim((string) $u['terminal']) : null,
    ];
}

if ($validUpdates === []) {
    mt5LogDiagnostic('status.php', [
        'event' => 'STATUS_UPDATE_REJECTED',
        'bodyBytes' => strlen((string) $rawBody),
        'validationErrors' => $rejectedUpdates,
    ]);
    jsonResponse(['error' => 'No valid updates provided', 'validationErrors' => $rejectedUpdates], 422);
}

$now = time();
$result = mt5WithStateLock(function (array &$state) use ($validUpdates, $now, $bridgeUserId): array {
    $applied = 0;
    $missing = [];
    $transitions = [];
    $ignored = [];

    foreach ($validUpdates as $u) {
        $orderId = $u['orderId'];
        if (!isset($state['orders'][$orderId])) {
            $missing[] = $orderId;
            continue;
        }
        $order = &$state['orders'][$orderId];
        // Cross-user isolation: report the order as "missing" (not a
        // separate "forbidden" reason) rather than disclosing to a caller
        // that an orderId they don't own exists at all.
        if ((int) ($order['userId'] ?? -1) !== $bridgeUserId) {
            $missing[] = $orderId;
            unset($order);
            continue;
        }
        $fromStatus = (string) ($order['status'] ?? 'UNKNOWN');

        /* Lifecycle-revert guard: once an order has reached a FINAL status
         * (FILLED/REJECTED/CANCELLED/EXPIRED), that outcome is permanent —
         * never let a later status update (a redelivered/duplicate signal
         * resync, an out-of-order callback, or a stale retry) overwrite it
         * with a different status. Without this guard a late-arriving
         * non-final update (e.g. "RECEIVED") could silently revert an
         * already-finalized order, which both corrupts the persisted
         * lifecycle and can resurrect an order for further dispatch. The
         * EA's resync of a terminal status it already knows about (see
         * SIGNAL_DUPLICATE handling in ITGuruMt5Bridge.mq5) is still
         * accepted/no-op'd below so it is acknowledged with HTTP 200 and the
         * EA stops retrying. */
        if (in_array($fromStatus, MT5_FINAL_STATUS, true)) {
            if ($u['status'] === $fromStatus) {
                continue;
            }
            $ignored[] = [
                'orderId' => $orderId,
                'symbol' => $order['symbol'] ?? null,
                'from' => $fromStatus,
                'attemptedTo' => $u['status'],
                'reason' => 'order already finalized; status update ignored to prevent lifecycle revert',
            ];
            continue;
        }

        $order['status'] = $u['status'];
        if ($u['brokerTicket'] !== null && $u['brokerTicket'] !== '') {
            $order['brokerTicket'] = $u['brokerTicket'];
        }
        if ($u['message'] !== null) {
            $order['message'] = $u['message'];
        }
        if ($u['filledPrice'] !== null && $u['filledPrice'] > 0) {
            $order['filledPrice'] = $u['filledPrice'];
        }
        if (isset($u['terminal']) && $u['terminal'] !== '') {
            $order['lastStatusTerminal'] = $u['terminal'];
        }
        $order['updatedAt'] = $now;
        if (!isset($order['history']) || !is_array($order['history'])) $order['history'] = [];
        $order['history'][] = [
            'status' => $u['status'],
            'ts' => $now,
            'message' => $u['message'] ?? null,
        ];
        $transitions[] = [
            'orderId' => $orderId,
            'terminal' => $u['terminal'] ?? null,
            'symbol' => $order['symbol'] ?? null,
            'brokerSymbolHint' => $order['brokerSymbolHint'] ?? null,
            'from' => $fromStatus,
            'to' => $u['status'],
        ];

        /* Map the EA's status callback onto the canonical audit lifecycle so
         * audit.php can answer "delivered but not executed" without parsing
         * free-text history. DISPATCHED->RECEIVED proves the payload reached
         * the EA; FILLED proves OrderSend() succeeded; REJECTED/CANCELLED/
         * EXPIRED proves it failed and carries the broker retcode message. */
        $ledgerEvent = match ($u['status']) {
            'RECEIVED' => 'ORDER_RECEIVED',
            'FILLED' => 'ORDER_EXECUTED',
            'REJECTED', 'CANCELLED', 'EXPIRED' => 'ORDER_FAILED',
            default => null,
        };
        if ($ledgerEvent !== null) {
            mt5RecordEvent($state, $ledgerEvent, [
                'signalId' => ($order['signalId'] ?? '') !== '' ? $order['signalId'] : null,
                'orderId' => $orderId,
                'symbol' => $order['symbol'] ?? null,
                'terminal' => $u['terminal'] ?? null,
                'status' => $u['status'],
                'brokerTicket' => $order['brokerTicket'] ?? null,
                'reason' => $u['message'],
            ], $now);
        }
        $applied++;
        unset($order);
    }

    return ['applied' => $applied, 'missing' => $missing, 'transitions' => $transitions, 'ignored' => $ignored];
});

mt5LogDiagnostic('status.php', [
    'event' => 'STATUS_UPDATE_APPLIED',
    'bodyBytes' => strlen((string) $rawBody),
    'applied' => $result['applied'],
    'missingOrderIds' => $result['missing'],
    'lifecycleTransitions' => $result['transitions'],
    'ignoredRevertAttempts' => $result['ignored'],
]);

jsonResponse([
    'ok' => true,
    'applied' => $result['applied'],
    'missingOrderIds' => $result['missing'],
    'ignoredRevertAttempts' => $result['ignored'],
]);

