<?php
/**
 * GET|POST /api/mt5/bridge_key.php
 * ─────────────────────────────────
 * Lets a logged-in user fetch (GET, minting on first use) or rotate (POST)
 * their own personal MT5 bridge key.
 *
 * This key is configured into that user's own ITGuruMt5Bridge.mq5 instance
 * (InpBridgeKey) and is what api/mt5/pull.php and api/mt5/status.php use to
 * resolve which user's EA is calling — see mt5ResolveBridgeUserId() in
 * common.php. It is deliberately separate from the single admin-operator
 * MT5_BRIDGE_KEY env var: issuing one unique key per user (instead of
 * sharing one secret across every user's EA) is what stops one user's
 * auto-trade signal from ever being dispatched to another user's MT5
 * terminal.
 *
 * GET  -> returns the existing key, generating one if the user has none yet.
 * POST -> generates and persists a brand new key, immediately revoking the
 *         old one (any EA still configured with it will start getting 403s
 *         from pull.php/status.php until reconfigured).
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
if (!rateLimit(20, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$userId = authenticateUserFromToken();

try {
    $bridgeKey = $_SERVER['REQUEST_METHOD'] === 'POST'
        ? mt5RegenerateBridgeKey($userId)
        : mt5GetOrCreateBridgeKey($userId);
} catch (\Throwable $e) {
    error_log('bridge_key.php error: ' . $e->getMessage());
    jsonResponse(['error' => 'Failed to generate MT5 bridge key'], 500);
}

jsonResponse([
    'ok' => true,
    'bridgeKey' => $bridgeKey,
    'rotated' => $_SERVER['REQUEST_METHOD'] === 'POST',
]);
