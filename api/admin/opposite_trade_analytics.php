<?php
/**
 * /api/admin/opposite_trade_analytics.php
 * ───────────────────────────────────────
 * GET — Opposite Trade Analytics for the admin dashboard.
 *   stats:   per-strategy loss statistics, health diagnosis and recommendations
 *   recent:  latest analysed trades (optional ?strategy= filter)
 * Requires admin Authorization.
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth_guard.php';
require_once __DIR__ . '/../lib/OppositeTradeService.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = getDB();
    $stats = OppositeTradeService::strategyStats($pdo);

    $sql = "SELECT trade_id, strategy, symbol, original_direction, original_sl, original_tp,
                   opposite_direction, opposite_result, eventual_original_tp, minutes_after_sl,
                   classification, status, close_time
              FROM opposite_trade_tracking";
    $params = [];
    if (!empty($_GET['strategy'])) {
        $sql .= ' WHERE strategy = ?';
        $params[] = (string) $_GET['strategy'];
    }
    $sql .= ' ORDER BY close_time DESC LIMIT 50';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    jsonResponse([
        'stats' => $stats,
        'recent' => $stmt->fetchAll(PDO::FETCH_ASSOC),
        'minSample' => OppositeTradeService::MIN_SAMPLE,
        'alertThresholdPct' => OppositeTradeService::ALERT_THRESHOLD * 100,
    ]);
} catch (\Throwable $e) {
    error_log('Admin opposite_trade_analytics error: ' . $e->getMessage());
    jsonResponse(['error' => categoriseAuthError('Failed to load opposite trade analytics', $e)], 500);
}
