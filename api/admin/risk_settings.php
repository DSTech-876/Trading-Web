<?php
/**
 * /api/admin/risk_settings.php
 * ────────────────────────────────
 * GET            — fetch the current platform risk settings (daily loss limit %)
 * POST|PUT|PATCH — update the daily loss limit % (admin only)
 *
 * This value is the single source of truth for the "Daily Loss Limit":
 *  - Relayed to the MT5 bridge EA via api/mt5/pull.php so ITGuruMt5Bridge.mq5
 *    can honor it without recompiling/redeploying the EA.
 *  - Read by the web app's own auto-trade engine via api/mt5/risk_config.php
 *    instead of a hardcoded constant.
 *
 * Body (POST|PUT|PATCH): { "dailyLossLimitPct": 5 }
 * All requests require Authorization: ******
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth_guard.php';

const RISK_SETTINGS_MIN_PCT = 0.1;
const RISK_SETTINGS_MAX_PCT = 100.0;

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function riskSettingsRow(PDO $pdo): array
{
    $pdo->exec('INSERT IGNORE INTO risk_settings (id, daily_loss_limit_pct) VALUES (1, 5.00)');
    $stmt = $pdo->query('SELECT daily_loss_limit_pct, updated_by, updated_at FROM risk_settings WHERE id = 1');
    $row = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : false;
    return is_array($row) ? $row : ['daily_loss_limit_pct' => 5.00, 'updated_by' => null, 'updated_at' => null];
}

function riskSettingsPublic(array $row): array
{
    return [
        'dailyLossLimitPct' => (float) $row['daily_loss_limit_pct'],
        'updatedBy' => $row['updated_by'] !== null ? (int) $row['updated_by'] : null,
        'updatedAt' => $row['updated_at'],
    ];
}

try {
    $pdo = getDB();
    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        jsonResponse(riskSettingsPublic(riskSettingsRow($pdo)));
    }

    if (!in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }

    $body = getJsonBody();
    if (!array_key_exists('dailyLossLimitPct', $body)) {
        jsonResponse(['error' => 'dailyLossLimitPct is required'], 400);
    }
    if (!is_numeric($body['dailyLossLimitPct'])) {
        jsonResponse(['error' => 'dailyLossLimitPct must be a number'], 400);
    }

    $newPct = round((float) $body['dailyLossLimitPct'], 2);
    if ($newPct < RISK_SETTINGS_MIN_PCT || $newPct > RISK_SETTINGS_MAX_PCT) {
        jsonResponse([
            'error' => sprintf(
                'dailyLossLimitPct must be between %.1f and %.1f',
                RISK_SETTINGS_MIN_PCT,
                RISK_SETTINGS_MAX_PCT
            ),
        ], 400);
    }

    $before = riskSettingsRow($pdo);
    $adminId = (int) $GLOBALS['adminUserId'];

    $pdo->beginTransaction();
    try {
        $pdo->exec('INSERT IGNORE INTO risk_settings (id, daily_loss_limit_pct) VALUES (1, 5.00)');
        $lockStmt = $pdo->query('SELECT daily_loss_limit_pct FROM risk_settings WHERE id = 1 FOR UPDATE');
        $lockedRow = $lockStmt ? $lockStmt->fetch(PDO::FETCH_ASSOC) : false;
        $oldValue = is_array($lockedRow) ? (string) $lockedRow['daily_loss_limit_pct'] : (string) $before['daily_loss_limit_pct'];

        $stmt = $pdo->prepare(
            'UPDATE risk_settings SET daily_loss_limit_pct = ?, updated_by = ? WHERE id = 1'
        );
        $stmt->execute([$newPct, $adminId]);

        $pdo->prepare(
            'INSERT INTO admin_audit_trail
                (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())'
        )->execute([
            $adminId,
            'risk_settings_updated',
            'risk_settings',
            'daily_loss_limit_pct',
            $oldValue,
            (string) $newPct,
            $_SERVER['REMOTE_ADDR'] ?? null,
            $_SERVER['HTTP_USER_AGENT'] ?? null,
        ]);

        $pdo->commit();
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    jsonResponse(riskSettingsPublic(riskSettingsRow($pdo)));
} catch (\Throwable $e) {
    error_log('Admin risk_settings error: ' . $e->getMessage());
    jsonResponse(['error' => categoriseAuthError('Failed to update risk settings', $e)], 500);
}
