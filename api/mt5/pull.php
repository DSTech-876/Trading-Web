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
mt5RequireBridgeKey($body);

$limit = (int) ($_GET['limit'] ?? $body['limit'] ?? 20);
$limit = max(1, min(100, $limit));
$terminal = trim((string) ($_GET['terminal'] ?? $body['terminal'] ?? ''));
$retryAfterSecs = 20;
$now = time();
$halted = mt5IsHalted();

// While halted, do not dispatch any new/retry orders to the EA. Existing
// in-flight orders are left untouched so status callbacks still work.
$orders = $halted ? [] : mt5WithStateLock(function (array &$state) use ($limit, $terminal, $retryAfterSecs, $now): array {
    $out = [];
    foreach ($state['orders'] as &$order) {
        if (count($out) >= $limit) break;
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

        $out[] = $order;
    }
    unset($order);
    return $out;
});

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
    'idempotencyKey' => $o['idempotencyKey'] ?? '',
    'attempts' => $o['attempts'] ?? 0,
    'createdAt' => $o['createdAt'] ?? null,
], $orders);

if ($public !== []) {
    mt5LogDiagnostic('pull.php', [
        'event' => 'DISPATCH',
        'terminal' => $terminal,
        'dispatchedOrderIds' => array_column($public, 'orderId'),
        'mappedSymbols' => array_combine(
            array_column($public, 'orderId'),
            array_map(static fn(array $o) => $o['brokerSymbolHint'] ?? $o['symbol'], $public)
        ),
    ]);
}

jsonResponse([
    'ok' => true,
    'serverTime' => $now,
    'halted' => $halted,
    'haltReason' => $halted ? mt5HaltReason() : null,
    'dailyLossLimitPct' => mt5GetDailyLossLimitPct(),
    'count' => count($public),
    'orders' => $public,
]);

