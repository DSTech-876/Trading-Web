<?php
/**
 * POST /api/mt5/signal.php
 * Queue an MT5 order request from authenticated web signal flow.
 */

declare(strict_types=1);
require_once __DIR__ . '/common.php';

requirePost();
if (!rateLimit(60, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$userId = mt5AuthUserId();
$body = getJsonBody();
$rawBody = file_get_contents('php://input');

try {
    $normalized = mt5NormalizeSignalPayload($body);
} catch (\Throwable $e) {
    // Server-side rejection record: without this, a payload that fails
    // normalization (bad SL/TP side, stop distance below broker minimum,
    // entry inside the freeze level, …) left no trace beyond a 422 the
    // browser swallowed, and the signal silently vanished from the audit.
    $rejectedSignalId = mt5SanitizeSignalId((string) ($body['signalId'] ?? ''));
    if ($rejectedSignalId !== '') {
        try {
            mt5WithStateLock(function (array &$state) use ($rejectedSignalId, $body, $e, $userId): void {
                $now = time();
                mt5RecordSignal($state, $rejectedSignalId, [
                    'signalId' => $rejectedSignalId,
                    'userId' => $userId,
                    'symbol' => substr(trim((string) ($body['symbol'] ?? '')), 0, 40) ?: null,
                    'createdTime' => $state['signals'][$rejectedSignalId]['createdTime'] ?? $now,
                    'status' => 'REJECTED',
                    'rejectionReason' => $e->getMessage(),
                    'rejectionFilter' => 'server payload validation',
                ]);
                mt5RecordEvent($state, 'SIGNAL_REJECTED', [
                    'signalId' => $rejectedSignalId,
                    'symbol' => substr(trim((string) ($body['symbol'] ?? '')), 0, 40) ?: null,
                    'reason' => $e->getMessage(),
                    'filter' => 'server payload validation',
                ], $now);
            });
        } catch (\Throwable $ignored) {
            // Never let ledger bookkeeping mask the original 422.
        }
    }
    mt5LogDiagnostic('signal.php', [
        'event' => 'VALIDATION_ERROR',
        'signalId' => $rejectedSignalId !== '' ? $rejectedSignalId : null,
        'rawBody' => $rawBody,
        'error' => $e->getMessage(),
    ]);
    jsonResponse(['error' => $e->getMessage()], 422);
}

$headerKey = trim((string) ($_SERVER['HTTP_X_IDEMPOTENCY_KEY'] ?? ''));
$incomingKey = $headerKey !== '' ? $headerKey : $normalized['idempotencyKey'];
if ($incomingKey === '') {
    $fingerprint = implode('|', [
        $userId,
        $normalized['symbol'],
        $normalized['side'],
        number_format((float) $normalized['entry'], $normalized['digits'], '.', ''),
        number_format((float) $normalized['sl'], $normalized['digits'], '.', ''),
        number_format((float) $normalized['tp'], $normalized['digits'], '.', ''),
        (string) $normalized['source'],
        (string) $normalized['strategyName'],
    ]);
    $incomingKey = 'auto_' . hash('sha256', $fingerprint);
}

$result = mt5WithStateLock(function (array &$state) use ($userId, $normalized, $incomingKey): array {
    $now = time();
    $signalId = (string) $normalized['signalId'];
    $existingOrderId = $state['idempotency'][$incomingKey] ?? null;
    if (is_string($existingOrderId) && isset($state['orders'][$existingOrderId])) {
        $existing = $state['orders'][$existingOrderId];
        mt5RecordEvent($state, 'ORDER_CREATED', [
            'signalId' => $signalId !== '' ? $signalId : null,
            'orderId' => $existingOrderId,
            'symbol' => $normalized['symbol'],
            'duplicate' => true,
            'reason' => 'duplicate protection: idempotency key already mapped to an order',
        ], $now);
        return ['duplicate' => true, 'order' => $existing, 'queueDepth' => count($state['orders'])];
    }

    // Cross-session duplicate guard: the idempotency key above only catches
    // an *exact* repeat (same key), but the same user running auto-trade in
    // two browser sessions/tabs independently mints a different signalId and
    // idempotency key for what is the same underlying signal — each tab
    // evaluates the same candle on its own and would otherwise queue, and the
    // EA would fire, two real trades for one trading decision. Catch that by
    // matching on the actual trade parameters (symbol/side/source/strategy/
    // entry/SL/TP) for this user within a short recent window instead of
    // relying on the client-supplied key matching exactly.
    $recentDuplicate = mt5FindRecentDuplicateOrder($state['orders'], $userId, $normalized, $now);
    if ($recentDuplicate !== null) {
        mt5RecordEvent($state, 'ORDER_CREATED', [
            'signalId' => $signalId !== '' ? $signalId : null,
            'orderId' => $recentDuplicate['orderId'] ?? null,
            'symbol' => $normalized['symbol'],
            'duplicate' => true,
            'reason' => 'duplicate protection: same user/symbol/side/entry/sl/tp within '
                . MT5_DUPLICATE_SIGNAL_WINDOW_SECS . 's (likely a second logged-in session/tab)',
        ], $now);
        return ['duplicate' => true, 'order' => $recentDuplicate, 'queueDepth' => count($state['orders'])];
    }

    $orderId = 'mt5_' . gmdate('YmdHis') . '_' . bin2hex(random_bytes(4));
    $order = [
        'orderId' => $orderId,
        'userId' => $userId,
        'signalId' => $signalId,
        'status' => 'QUEUED',
        'symbol' => $normalized['symbol'],
        'brokerSymbolHint' => $normalized['brokerSymbolHint'],
        'side' => $normalized['side'],
        'orderType' => $normalized['orderType'],
        'entry' => $normalized['entry'],
        'sl' => $normalized['sl'],
        'tp' => $normalized['tp'],
        'lot' => $normalized['lot'],
        'digits' => $normalized['digits'],
        'point' => $normalized['point'],
        'constraints' => $normalized['constraints'],
        'source' => $normalized['source'],
        'strategyName' => $normalized['strategyName'],
        'idempotencyKey' => $incomingKey,
        'brokerTicket' => null,
        'message' => null,
        'attempts' => 0,
        'createdAt' => $now,
        'updatedAt' => $now,
        'lastDispatchedAt' => null,
        'history' => [
            ['status' => 'QUEUED', 'ts' => $now, 'message' => 'Queued by web app'],
        ],
    ];

    $state['orders'][$orderId] = $order;
    $state['idempotency'][$incomingKey] = $orderId;

    if ($signalId !== '') {
        mt5RecordSignal($state, $signalId, [
            'signalId' => $signalId,
            'userId' => $userId,
            'symbol' => $normalized['symbol'],
            'direction' => $normalized['side'],
            'confidence' => $normalized['confidence'],
            'source' => $normalized['source'],
            'strategyName' => $normalized['strategyName'] !== '' ? $normalized['strategyName'] : null,
            'entry' => $normalized['entry'],
            'sl' => $normalized['sl'],
            'tp' => $normalized['tp'],
            'createdTime' => $state['signals'][$signalId]['createdTime'] ?? $now,
            'status' => 'ORDERED',
            'orderId' => $orderId,
        ]);
    }

    $eventCtx = [
        'signalId' => $signalId !== '' ? $signalId : null,
        'orderId' => $orderId,
        'symbol' => $normalized['symbol'],
        'direction' => $normalized['side'],
        'lot' => $normalized['lot'],
        // Orders are created with no terminal binding; pull.php assigns the
        // terminal on first dispatch.
        'terminal' => null,
    ];
    mt5RecordEvent($state, 'ORDER_CREATED', $eventCtx, $now);
    mt5RecordEvent($state, 'ORDER_QUEUED', $eventCtx + ['status' => 'QUEUED'], $now);

    return ['duplicate' => false, 'order' => $order, 'queueDepth' => count($state['orders'])];
});

$publicOrder = mt5PublicOrder($result['order']);

mt5LogDiagnostic('signal.php', [
    'event' => $result['duplicate'] ? 'ORDER_DUPLICATE' : 'ORDER_QUEUED',
    'signalId' => $normalized['signalId'] !== '' ? $normalized['signalId'] : null,
    'orderId' => $publicOrder['orderId'],
    'duplicate' => (bool) $result['duplicate'],
    'userId' => $userId,
    'symbol' => $normalized['symbol'],
    'mappedSymbol' => $normalized['brokerSymbolHint'] !== '' ? $normalized['brokerSymbolHint'] : null,
    'side' => $normalized['side'],
    'orderType' => $normalized['orderType'],
    'lot' => $normalized['lot'],
    'status' => $publicOrder['status'],
    // Orders are created with no terminal binding; pull.php assigns the
    // terminal on first dispatch. A non-null value here would mean the order
    // is pinned and will be invisible to every other terminal id.
    'terminal' => $result['order']['terminal'] ?? null,
    'queueDepth' => $result['queueDepth'],
    'rawBody' => $rawBody,
]);

jsonResponse([
    'ok' => true,
    'duplicate' => (bool) $result['duplicate'],
    'order' => $publicOrder,
]);
