<?php
/**
 * GET /api/mt5/risk_config.php
 * ─────────────────────────────
 * Authenticated, read-only endpoint exposing the admin-configured platform
 * risk settings (currently just the daily loss limit %) to the logged-in
 * web client, so indicator.js no longer relies on a hardcoded constant.
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
if (!rateLimit(60, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

/* Any authenticated user may read the current risk settings. */
authenticateUserFromToken();

jsonResponse([
    'ok' => true,
    'dailyLossLimitPct' => mt5GetDailyLossLimitPct(),
]);
