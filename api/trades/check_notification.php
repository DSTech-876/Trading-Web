<?php
/**
 * /api/trades/check_notification.php
 * ───────────────────────────────────
 * Check if a notification has been sent and register it if not.
 * Implements persistent deduplication across app restarts.
 *
 * POST: Register a notification as sent
 * {
 *   "trade_id": "TRADE_UUID_1234",
 *   "signal_id": "SIGNAL_UUID_5678",
 *   "notification_type": "PARTIAL_TP_1" | "TRADE_WIN" | "TRADE_LOSS" | etc.
 *   "telegram_status": "sent" | "failed" | "skipped"
 * }
 *
 * GET: Check if notification was already sent
 * ?trade_id=...&notification_type=...
 *
 * Returns for POST: { "success": true, "registered": true }
 *         for POST (duplicate): { "success": true, "registered": false, "already_sent": "..." }
 *         for GET: { "sent": true|false, "sent_at": "...", "retry_count": N }
 *                  { "sent": false }
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* ── Authenticate ── */
$userId = authenticateUserFromToken();

try {
    $pdo = getDB();
    
    if ($method === 'GET') {
        /* ── Check if notification was already sent ── */
        $tradeId = $_GET['trade_id'] ?? null;
        $notifType = $_GET['notification_type'] ?? null;
        
        if (!$tradeId || !$notifType) {
            jsonResponse(['error' => 'Missing trade_id or notification_type'], 400);
        }
        
        $stmt = $pdo->prepare(
            "SELECT id, sent_timestamp, retry_count, telegram_status
             FROM notification_dedup_registry
             WHERE user_id = ? AND trade_id = ? AND notification_type = ?
             LIMIT 1"
        );
        $stmt->execute([$userId, $tradeId, $notifType]);
        $row = $stmt->fetch();
        
        if ($row) {
            jsonResponse([
                'sent' => true,
                'sent_at' => $row['sent_timestamp'],
                'retry_count' => (int)$row['retry_count'],
                'telegram_status' => $row['telegram_status']
            ], 200);
        } else {
            jsonResponse(['sent' => false], 200);
        }
        
    } elseif ($method === 'POST') {
        /* ── Register notification as sent ── */
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            jsonResponse(['error' => 'Invalid JSON'], 400);
        }
        
        $tradeId = $input['trade_id'] ?? null;
        $signalId = $input['signal_id'] ?? null;
        $notifType = $input['notification_type'] ?? null;
        $status = $input['telegram_status'] ?? 'sent';
        
        if (!$tradeId || !$notifType) {
            jsonResponse(['error' => 'Missing trade_id or notification_type'], 400);
        }
        
        /* ── Validate notification type enum ── */
        $validTypes = [
            'TRADE_SETUP', 'TRADE_TRIGGERED',
            'PARTIAL_TP_1', 'PARTIAL_TP_2', 'PARTIAL_TP_3',
            'TRADE_WIN', 'TRADE_LOSS', 'TRADE_BREAKEVEN',
            'TRADE_EXPIRED', 'TRADE_CANCELLED',
            'ENTRY_ALERT', 'OUTCOME_ALERT',
            /* Generic signal-lifecycle notification kinds shared by every
               strategy (MTF Top-Down, Breakout, Adaptive Intelligence, etc.)
               via sendSignalLifecycleTelegram(). These map 1:1 to the "kind"
               argument of that function so any strategy can be protected by
               the same DB-backed idempotency registry as Grid Scalper MA. */
            'LIFECYCLE_SETUP', 'LIFECYCLE_APPROACHING', 'LIFECYCLE_ACTIVE',
            'LIFECYCLE_TP', 'LIFECYCLE_SL', 'LIFECYCLE_CANCELLED', 'LIFECYCLE_EXPIRED'
        ];
        if (!in_array($notifType, $validTypes, true)) {
            jsonResponse(['error' => 'Invalid notification_type: ' . $notifType], 400);
        }
        
        /* ── Validate status enum ── */
        if (!in_array($status, ['sent', 'failed', 'skipped'], true)) {
            $status = 'sent';
        }
        
        /* ── Try insert; if duplicate, return already_sent ── */
        try {
            $stmt = $pdo->prepare(
                "INSERT INTO notification_dedup_registry
                (user_id, trade_id, signal_id, notification_type, sent_timestamp, telegram_status)
                VALUES (?, ?, ?, ?, NOW(), ?)"
            );
            $stmt->execute([$userId, $tradeId, $signalId, $notifType, $status]);
            
            jsonResponse([
                'success' => true,
                'registered' => true,
                'message' => 'Notification registered'
            ], 200);
            
        } catch (\PDOException $e) {
            /* ── Duplicate key error (1062) ── */
            if ($e->getCode() == '23000') {
                jsonResponse([
                    'success' => true,
                    'registered' => false,
                    'already_sent' => true,
                    'message' => 'Notification already registered'
                ], 200);
            } else {
                throw $e;
            }
        }
        
    } else {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    
} catch (\Throwable $e) {
    error_log('check_notification.php error: ' . $e->getMessage());
    jsonResponse(['error' => 'Database error', 'detail' => $e->getMessage()], 500);
}
