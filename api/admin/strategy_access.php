<?php
/**
 * /api/admin/strategy_access.php
 * ────────────────────────────────
 * POST   — grant a strategy to a user
 * DELETE — revoke a strategy from a user
 *
 * Body: { "user_id": 5, "strategy_key": "fvg_strat" }
 * All requests require Authorization: Bearer <admin-token>
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth_guard.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (!in_array($method, ['POST', 'DELETE'], true)) {
    jsonResponse(['error' => 'Method not allowed'], 405);
}

$adminId = (int) ($GLOBALS['adminUserId'] ?? 0);
if ($adminId <= 0) {
    jsonResponse(['error' => 'Admin user ID is missing or invalid'], 500);
}

$body       = getJsonBody();
$userId     = (int) ($body['user_id']      ?? 0);
$stratKey   = trim($body['strategy_key']  ?? '');

if ($userId <= 0) {
    jsonResponse(['error' => 'user_id is required'], 400);
}
if ($stratKey === '') {
    jsonResponse(['error' => 'strategy_key is required'], 400);
}

/* Valid strategy keys (must match strategies.php) */
$validKeys = [
    'bot_hc_1hz75v', 'bot_normal',
    'liquidity_sweep', 'stop_loss_hunt', 'failed_pin_bar', 'fib_scalp',
    'po3', 'ny_open_range', 'session_ranges', 'grid_scalper_ma',
    'fvg_strat', 'live_scalp', 'mtf_top_down', 'indicator_v2', 'tiktok',
    'candle_interp', 'orderblock', 'po3_4h', 'breaker_block',
    'ote_golden_pocket', 'orb', 'crt_tbs',
];
if (!in_array($stratKey, $validKeys, true)) {
    jsonResponse(['error' => 'Unknown strategy_key'], 400);
}

try {
    $pdo = getDB();

    /* Confirm user exists */
    $chk = $pdo->prepare('SELECT id FROM users WHERE id = ?');
    $chk->execute([$userId]);
    if (!$chk->fetch()) {
        jsonResponse(['error' => 'User not found'], 404);
    }

    if ($method === 'POST') {
        $stmt = $pdo->prepare(
            'INSERT IGNORE INTO strategy_access (user_id, strategy_key, granted_by) VALUES (?, ?, ?)'
        );
        $stmt->execute([$userId, $stratKey, $adminId]);
        jsonResponse(['message' => 'Strategy granted']);
    }

    if ($method === 'DELETE') {
        $stmt = $pdo->prepare(
            'DELETE FROM strategy_access WHERE user_id = ? AND strategy_key = ?'
        );
        $stmt->execute([$userId, $stratKey]);
        if ($stmt->rowCount() === 0) {
            jsonResponse(['error' => 'Strategy access not found'], 404);
        }
        jsonResponse(['message' => 'Strategy revoked']);
    }
} catch (\Throwable $e) {
    error_log('Admin strategy_access error: ' . $e->getMessage());
    jsonResponse(['error' => categoriseAuthError('Failed to update strategy access', $e)], 500);
}
