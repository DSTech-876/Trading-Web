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
mt5RequireBridgeKey($body);

$updates = $body['updates'] ?? null;
if (!is_array($updates)) {
    $single = [
        'orderId' => $body['orderId'] ?? null,
        'status' => $body['status'] ?? null,
        'brokerTicket' => $body['brokerTicket'] ?? null,
        'message' => $body['message'] ?? null,
        'filledPrice' => $body['filledPrice'] ?? null,
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
    ];
}

if ($validUpdates === []) {
    mt5LogDiagnostic('status.php', [
        'event' => 'STATUS_UPDATE_REJECTED',
        'rawBody' => $rawBody,
        'validationErrors' => $rejectedUpdates,
    ]);
    jsonResponse(['error' => 'No valid updates provided', 'validationErrors' => $rejectedUpdates], 422);
}

$now = time();
$result = mt5WithStateLock(function (array &$state) use ($validUpdates, $now): array {
    $applied = 0;
    $missing = [];
    $transitions = [];

    foreach ($validUpdates as $u) {
        $orderId = $u['orderId'];
        if (!isset($state['orders'][$orderId])) {
            $missing[] = $orderId;
            continue;
        }
        $order = &$state['orders'][$orderId];
        $fromStatus = (string) ($order['status'] ?? 'UNKNOWN');
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
        $order['updatedAt'] = $now;
        if (!isset($order['history']) || !is_array($order['history'])) $order['history'] = [];
        $order['history'][] = [
            'status' => $u['status'],
            'ts' => $now,
            'message' => $u['message'] ?? null,
        ];
        $transitions[] = [
            'orderId' => $orderId,
            'symbol' => $order['symbol'] ?? null,
            'brokerSymbolHint' => $order['brokerSymbolHint'] ?? null,
            'from' => $fromStatus,
            'to' => $u['status'],
        ];
        $applied++;
        unset($order);
    }

    return ['applied' => $applied, 'missing' => $missing, 'transitions' => $transitions];
});

mt5LogDiagnostic('status.php', [
    'event' => 'STATUS_UPDATE_APPLIED',
    'rawBody' => $rawBody,
    'applied' => $result['applied'],
    'missingOrderIds' => $result['missing'],
    'lifecycleTransitions' => $result['transitions'],
]);

jsonResponse([
    'ok' => true,
    'applied' => $result['applied'],
    'missingOrderIds' => $result['missing'],
]);

