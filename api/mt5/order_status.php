<?php
/**
 * GET /api/mt5/order_status.php
 * Returns MT5 bridge order statuses for the authenticated user.
 */

declare(strict_types=1);
require_once __DIR__ . '/common.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'Method not allowed'], 405);
}
if (!rateLimit(120, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$userId = mt5AuthUserId();
$since = (int) ($_GET['since'] ?? 0);
$limit = (int) ($_GET['limit'] ?? 50);
$limit = max(1, min(200, $limit));

/* Read the queue under a shared lock and take the watermark while that lock
 * is still held, reported one second behind. `updatedAt` only has second
 * resolution, so if the timestamp were captured before the lock (or before
 * the read), a status callback could land in between — or in the same
 * second — making the watermark newer than the snapshot it is paired with.
 * The client would then advance `since` past that second and the transition
 * would be invisible to every later poll: an MT5 order never leaves
 * `activeTrades`, the symbol stays permanently at its max-concurrent-trades
 * cap, and no further signal is ever dispatched to the bridge. Reading and
 * timestamping under the shared lock orders the snapshot and watermark
 * consistently with any concurrent writer; overlapping by one second can
 * only ever redeliver a status, which the client resolves idempotently by
 * orderId. */
[$state, $watermark] = mt5ReadStateLockedWithWatermark();
$orders = [];
foreach ($state['orders'] as $order) {
    if (!is_array($order)) continue;
    if ((int) ($order['userId'] ?? 0) !== $userId) continue;
    if ($since > 0 && (int) ($order['updatedAt'] ?? 0) <= $since) continue;
    $orders[] = mt5PublicOrder($order);
}

usort($orders, static function (array $a, array $b): int {
    return ((int) ($b['updatedAt'] ?? 0)) <=> ((int) ($a['updatedAt'] ?? 0));
});
if (count($orders) > $limit) {
    $orders = array_slice($orders, 0, $limit);
}

jsonResponse([
    'ok' => true,
    'serverTime' => $watermark,
    'count' => count($orders),
    'orders' => $orders,
]);

