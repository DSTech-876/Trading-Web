<?php
/**
 * /api/admin/notifications.php
 * ────────────────────────────
 * Admin endpoint for sending in-app notifications to users.
 *
 * GET    — list the most recent notifications with read counts
 * POST   — send a notification { title, message, username? }
 *          username omitted/blank ⇒ broadcast to all users
 * DELETE — delete a notification (?id=<notification_id>)
 *
 * All requests require Authorization: Bearer <admin-token>
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth_guard.php';
require_once __DIR__ . '/../lib/APILogger.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$adminId = (int) ($GLOBALS['adminUserId'] ?? 0);
if ($adminId <= 0) {
    jsonResponse(['error' => 'Admin user ID is missing or invalid'], 500);
}

/* ═══════════════════════════════════════════════
   GET — list recent notifications
   ═══════════════════════════════════════════════ */
if ($method === 'GET') {
    try {
        $pdo  = getDB();
        $stmt = $pdo->query(
            'SELECT n.id, n.user_id, n.title, n.message, n.created_at,
                    tu.username  AS target_username,
                    au.username  AS created_by_username,
                    (SELECT COUNT(*) FROM user_notification_reads r
                      WHERE r.notification_id = n.id) AS read_count
               FROM user_notifications n
               LEFT JOIN users tu ON tu.id = n.user_id
               LEFT JOIN users au ON au.id = n.created_by
              ORDER BY n.created_at DESC, n.id DESC
              LIMIT 100'
        );
        jsonResponse(['notifications' => $stmt->fetchAll()]);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/notifications', 'GET', $e);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   POST — send a notification
   ═══════════════════════════════════════════════ */
if ($method === 'POST') {
    $body     = getJsonBody();
    $title    = trim((string) ($body['title']    ?? ''));
    $message  = trim((string) ($body['message']  ?? ''));
    $username = trim((string) ($body['username'] ?? ''));

    if ($title === '' || $message === '') {
        jsonResponse(['error' => 'Title and message are required'], 400);
    }
    if (mb_strlen($title) > 150) {
        jsonResponse(['error' => 'Title must be 150 characters or fewer'], 400);
    }
    if (mb_strlen($message) > 5000) {
        jsonResponse(['error' => 'Message must be 5000 characters or fewer'], 400);
    }

    try {
        $pdo    = getDB();
        $userId = null;

        if ($username !== '') {
            $stmt = $pdo->prepare('SELECT id FROM users WHERE username = ?');
            $stmt->execute([$username]);
            $target = $stmt->fetch();
            if (!$target) {
                jsonResponse(['error' => "User '{$username}' not found"], 404);
            }
            $userId = (int) $target['id'];
        }

        $pdo->prepare(
            'INSERT INTO user_notifications (user_id, title, message, created_by)
             VALUES (?, ?, ?, ?)'
        )->execute([$userId, $title, $message, $adminId]);
        
        $notifId = (int) $pdo->lastInsertId();
        
        // Diagnostic logging
        error_log("Notification CREATE: notifId=$notifId, userId=$userId, targetUser=$username, titleLen=" . strlen($title) . ", createdBy=$adminId");
        
        // Verify write
        $verify = $pdo->prepare('SELECT id, user_id, title FROM user_notifications WHERE id = ?');
        $verify->execute([$notifId]);
        $verifyRow = $verify->fetch(PDO::FETCH_ASSOC);
        
        if (!$verifyRow) {
            error_log("Notification CREATE VERIFICATION FAILED: notifId=$notifId not found");
        } else {
            error_log("Notification CREATE VERIFIED: " . json_encode($verifyRow));
        }

        jsonResponse([
            'ok'      => true,
            'id'      => $notifId,
            'target'  => $userId === null ? 'all' : $username,
        ], 201);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/notifications', 'POST', $e);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   DELETE — remove a notification
   ═══════════════════════════════════════════════ */
if ($method === 'DELETE') {
    $id = (int) ($_GET['id'] ?? 0);
    if ($id <= 0) {
        jsonResponse(['error' => 'Notification id is required'], 400);
    }
    try {
        $pdo  = getDB();
        
        // Get notification details before deletion
        $verify = $pdo->prepare('SELECT id, user_id, title FROM user_notifications WHERE id = ?');
        $verify->execute([$id]);
        $notifBefore = $verify->fetch(PDO::FETCH_ASSOC);
        
        $stmt = $pdo->prepare('DELETE FROM user_notifications WHERE id = ?');
        $stmt->execute([$id]);
        
        $affected = $stmt->rowCount();
        
        // Diagnostic logging
        error_log("Notification DELETE: notifId=$id, affected=$affected, deletedBy=$adminId");
        if ($notifBefore) {
            error_log("Notification DELETE DETAILS: " . json_encode($notifBefore));
        }
        
        if ($affected === 0) {
            jsonResponse(['error' => 'Notification not found'], 404);
        }
        
        // Verify deletion
        $verify = $pdo->prepare('SELECT id FROM user_notifications WHERE id = ?');
        $verify->execute([$id]);
        $stillExists = $verify->fetch();
        
        if ($stillExists) {
            error_log("Notification DELETE VERIFICATION FAILED: notifId=$id still exists after deletion");
        } else {
            error_log("Notification DELETE VERIFIED: Record successfully deleted");
        }
        
        jsonResponse(['ok' => true]);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/notifications', 'DELETE', $e);
        jsonResponse($response, 500);
    }
}

jsonResponse(['error' => 'Method not allowed'], 405);
