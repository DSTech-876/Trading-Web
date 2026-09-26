<?php
/**
 * /api/admin/telegram_delivery_log.php
 * ──────────────────────────────────────
 * Admin-only view of the Telegram notification delivery log.
 *
 * GET /api/admin/telegram_delivery_log
 *   Optional filters: ?user_id=, ?notification_type=, ?status=, ?signal_id=,
 *   ?limit= (default 100, max 500), ?offset=
 *
 * Returns rows joined with the username for readability.
 *
 * All requests require Authorization: ****** (admin role).
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

if ($method !== 'GET') {
    jsonResponse(['error' => 'Method not allowed'], 405);
}

$lastQuery = null;
$lastParams = [];

try {
    $pdo = getDB();

    $where  = [];
    $params = [];

    if (!empty($_GET['user_id'])) {
        $where[] = 'l.user_id = ?';
        $params[] = (int) $_GET['user_id'];
    }
    if (!empty($_GET['notification_type'])) {
        $where[] = 'l.notification_type = ?';
        $params[] = (string) $_GET['notification_type'];
    }
    if (!empty($_GET['status']) && in_array($_GET['status'], ['sent', 'failed', 'skipped'], true)) {
        $where[] = 'l.status = ?';
        $params[] = (string) $_GET['status'];
    }
    if (!empty($_GET['signal_id'])) {
        $where[] = 'l.signal_id = ?';
        $params[] = (string) $_GET['signal_id'];
    }

    $limit  = max(1, min(500, (int) ($_GET['limit'] ?? 100)));
    $offset = max(0, (int) ($_GET['offset'] ?? 0));

    $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

    $lastQuery = "SELECT l.id, l.user_id, u.username, l.signal_id, l.notification_type, l.strategy,
                l.symbol, l.status, l.telegram_response, l.error_detail, l.sent_at
           FROM telegram_delivery_log l
           LEFT JOIN users u ON u.id = l.user_id
           $whereSql
          ORDER BY l.sent_at DESC, l.id DESC
          LIMIT ? OFFSET ?";
    $lastParams = $params;
    $stmt = $pdo->prepare($lastQuery);
    
    // Bind all parameters with explicit types
    $paramIndex = 1;
    
    // Bind filter parameters
    foreach ($params as $value) {
        if (is_int($value)) {
            $stmt->bindValue($paramIndex++, $value, \PDO::PARAM_INT);
        } else {
            $stmt->bindValue($paramIndex++, $value, \PDO::PARAM_STR);
        }
    }
    
    // Bind LIMIT and OFFSET as integers
    $stmt->bindValue($paramIndex++, $limit, \PDO::PARAM_INT);
    $stmt->bindValue($paramIndex++, $offset, \PDO::PARAM_INT);
    
    $stmt->execute();
    $rows = $stmt->fetchAll() ?: [];

    // Count total
    $lastQuery = "SELECT COUNT(*) FROM telegram_delivery_log l $whereSql";
    $lastParams = $params;
    $countStmt = $pdo->prepare($lastQuery);
    $paramIndex = 1;
    foreach ($params as $value) {
        if (is_int($value)) {
            $countStmt->bindValue($paramIndex++, $value, \PDO::PARAM_INT);
        } else {
            $countStmt->bindValue($paramIndex++, $value, \PDO::PARAM_STR);
        }
    }
    $countStmt->execute();
    $total = (int) ($countStmt->fetchColumn() ?: 0);

    // Get status stats
    $lastQuery = "SELECT status, COUNT(*) AS c FROM telegram_delivery_log GROUP BY status";
    $lastParams = [];
    $statStmt = $pdo->prepare($lastQuery);
    $statStmt->execute($lastParams);
    $statResults = $statStmt->fetchAll() ?: [];
    $statusCounts = ['sent' => 0, 'failed' => 0, 'skipped' => 0];
    foreach ($statResults as $s) {
        if ($s && isset($s['status'], $s['c'])) {
            $statusCounts[$s['status']] = (int) $s['c'];
        }
    }

    jsonResponse([
        'entries' => $rows,
        'total'   => $total,
        'limit'   => $limit,
        'offset'  => $offset,
        'stats'   => $statusCounts,
    ]);
} catch (\Throwable $e) {
    $response = APILogger::logEndpointError('/api/admin/telegram_delivery_log', 'GET', $e, $lastQuery, $lastParams);
    jsonResponse($response, 500);
}
