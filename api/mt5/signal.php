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
    mt5LogDiagnostic('signal.php', [
        'event' => 'VALIDATION_ERROR',
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
    $existingOrderId = $state['idempotency'][$incomingKey] ?? null;
    if (is_string($existingOrderId) && isset($state['orders'][$existingOrderId])) {
        $existing = $state['orders'][$existingOrderId];
        return ['duplicate' => true, 'order' => $existing];
    }

    $orderId = 'mt5_' . gmdate('YmdHis') . '_' . bin2hex(random_bytes(4));
    $now = time();
    $order = [
        'orderId' => $orderId,
        'userId' => $userId,
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

    return ['duplicate' => false, 'order' => $order];
});

$publicOrder = mt5PublicOrder($result['order']);

mt5LogDiagnostic('signal.php', [
    'event' => 'SIGNAL_QUEUED',
    'signalId' => $publicOrder['orderId'],
    'duplicate' => (bool) $result['duplicate'],
    'symbol' => $normalized['symbol'],
    'mappedSymbol' => $normalized['brokerSymbolHint'] !== '' ? $normalized['brokerSymbolHint'] : null,
    'status' => $publicOrder['status'],
    'rawBody' => $rawBody,
]);

jsonResponse([
    'ok' => true,
    'duplicate' => (bool) $result['duplicate'],
    'order' => $publicOrder,
]);
