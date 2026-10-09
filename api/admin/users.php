<?php
/**
 * /api/admin/users.php
 * ─────────────────────
 * GET  — paginated list of all users with strategies
 * POST — create a new user
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
   GET — list users
   ═══════════════════════════════════════════════ */
if ($method === 'GET') {
    $lastQuery = null;
    $lastParams = [];
    try {
        $pdo = getDB();

        /* Pagination */
        $page    = max(1, (int) ($_GET['page']    ?? 1));
        $perPage = min(100, max(1, (int) ($_GET['per_page'] ?? 25)));
        $offset  = ($page - 1) * $perPage;

        /* Filters */
        $search       = trim($_GET['search']       ?? '');
        $filterStatus = trim($_GET['status']       ?? '');
        $filterSub    = trim($_GET['subscription'] ?? '');
        $filterRole   = trim($_GET['role']         ?? '');

        $where   = [];
        $params  = [];

        if ($search !== '') {
            $where[]  = '(u.username LIKE ? OR u.email LIKE ?)';
            $like     = '%' . $search . '%';
            $params[] = $like;
            $params[] = $like;
        }
        if ($filterStatus !== '' && in_array($filterStatus, ['active', 'locked'], true)) {
            $where[]  = 'u.status = ?';
            $params[] = $filterStatus;
        }
        if ($filterSub !== '' && in_array($filterSub, ['active', 'inactive', 'trial'], true)) {
            $where[]  = 'u.subscription_status = ?';
            $params[] = $filterSub;
        }
        if ($filterRole !== '' && in_array($filterRole, ['admin', 'user'], true)) {
            $where[]  = 'u.role = ?';
            $params[] = $filterRole;
        }

        $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';

        /* Total count */
        $lastQuery = "SELECT COUNT(*) FROM users u $whereSql";
        $lastParams = $params;
        $countStmt = $pdo->prepare($lastQuery);
        $countStmt->execute($lastParams);
        $total = (int) $countStmt->fetchColumn();

        /* Users */
        $paginatedParams = array_merge($params, [$perPage, $offset]);
        $lastQuery = "SELECT u.id, u.username, u.email, u.display_name, u.role, u.status,
                u.subscription_status, u.subscription_plan, u.subscription_expires_at, u.last_login_at,
                u.telegram_user_id, u.telegram_username, u.telegram_linked_at,
                u.created_at
         FROM users u
         $whereSql
         ORDER BY u.id DESC
         LIMIT ? OFFSET ?";
        $lastParams = $paginatedParams;
        $stmt = $pdo->prepare($lastQuery);
        $stmt->execute($lastParams);
        $users = $stmt->fetchAll();

        /* Attach strategies */
        if ($users) {
            $ids   = array_column($users, 'id');
            $in    = implode(',', array_fill(0, count($ids), '?'));
            $lastQuery = "SELECT user_id, strategy_key FROM strategy_access WHERE user_id IN ($in) ORDER BY strategy_key";
            $lastParams = $ids;
            $saStmt = $pdo->prepare($lastQuery);
            $saStmt->execute($lastParams);
            $stratMap = [];
            foreach ($saStmt->fetchAll() ?: [] as $row) {
                if ($row && isset($row['user_id'], $row['strategy_key'])) {
                    $stratMap[(int) $row['user_id']][] = $row['strategy_key'];
                }
            }
            foreach ($users as &$u) {
                $u['strategies']      = $stratMap[(int) ($u['id'] ?? 0)] ?? [];
                $u['telegram_linked'] = !empty($u['telegram_user_id']);
            }
            unset($u);
        }

        /* Aggregate stats across all matching users (not just current page) */
        $lastQuery = "SELECT
            SUM(subscription_status = 'active')  AS active_subs,
            SUM(subscription_status = 'trial')   AS trial_subs,
            SUM(status = 'locked')               AS locked_count,
            SUM(subscription_expires_at IS NOT NULL
                AND subscription_expires_at > NOW()
                AND subscription_expires_at <= DATE_ADD(NOW(), INTERVAL 7 DAY)) AS expiring_soon
         FROM users u $whereSql";
        $lastParams = $params;
        $statsStmt = $pdo->prepare($lastQuery);
        $statsStmt->execute($lastParams);
        $stats = $statsStmt->fetch() ?: ['active_subs' => 0, 'trial_subs' => 0, 'locked_count' => 0, 'expiring_soon' => 0];

        /* Global count of users with any bot strategy access */
        $lastQuery = "SELECT COUNT(DISTINCT user_id) FROM strategy_access
         WHERE strategy_key IN (?, ?)";
        $lastParams = ['bot_hc_1hz75v', 'bot_normal'];
        $botStmt = $pdo->prepare($lastQuery);
        $botStmt->execute($lastParams);
        $botAccessCount = (int) ($botStmt->fetchColumn() ?: 0);

        jsonResponse([
            'users'        => $users,
            'total'        => $total,
            'page'         => $page,
            'per_page'     => $perPage,
            'last_page'    => (int) ceil($total / $perPage),
            'stats'        => [
                'active_subs'      => (int) ($stats['active_subs']   ?? 0),
                'trial_subs'       => (int) ($stats['trial_subs']    ?? 0),
                'locked_count'     => (int) ($stats['locked_count']  ?? 0),
                'expiring_soon'    => (int) ($stats['expiring_soon'] ?? 0),
                'bot_access_count' => $botAccessCount,
            ],
        ]);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/users', 'GET', $e, $lastQuery, $lastParams);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   POST — create user
   ═══════════════════════════════════════════════ */
if ($method === 'POST') {
    $body        = getJsonBody();
    $username    = trim($body['username'] ?? '');
    $password    = $body['password'] ?? '';
    $email       = trim($body['email'] ?? '');
    $role        = $body['role'] ?? 'user';
    $status      = $body['status'] ?? 'active';
    $sub         = $body['subscription_status'] ?? 'inactive';
    $subPlan     = array_key_exists('subscription_plan', $body) ? ($body['subscription_plan'] ?? null) : null;
    $subExp      = $body['subscription_expires_at'] ?? null;
    $tgUsername  = isset($body['telegram_username']) ? ltrim(trim((string) $body['telegram_username']), '@') : null;

    /* Validation */
    if ($username === '' || $password === '') {
        jsonResponse(['error' => 'Username and password are required'], 400);
    }
    if (strlen($username) < 3 || strlen($username) > 50) {
        jsonResponse(['error' => 'Username must be 3–50 characters'], 400);
    }
    if (!preg_match('/^[a-zA-Z0-9_.\-]+$/', $username)) {
        jsonResponse(['error' => 'Invalid username characters'], 400);
    }
    if (strlen($password) < 8) {
        jsonResponse(['error' => 'Password must be at least 8 characters'], 400);
    }
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        jsonResponse(['error' => 'Invalid email address'], 400);
    }
    if (!in_array($role, ['user', 'admin'], true)) {
        jsonResponse(['error' => 'Invalid role'], 400);
    }
    if (!in_array($status, ['active', 'locked'], true)) {
        jsonResponse(['error' => 'Invalid status'], 400);
    }
    if (!in_array($sub, ['active', 'inactive', 'trial'], true)) {
        jsonResponse(['error' => 'Invalid subscription_status'], 400);
    }
    if ($subPlan !== null && $subPlan !== '' && !in_array($subPlan, ['trial', 'weekly', 'monthly'], true)) {
        jsonResponse(['error' => 'Invalid subscription_plan value (use trial, weekly, monthly, or null)'], 400);
    }
    $subPlan = ($subPlan === '') ? null : $subPlan;

    /* Auto-calculate expiry when activating with a plan and no explicit expiry provided */
    if ($sub === 'active' && ($subExp === null || $subExp === '')) {
        $daysMap = ['weekly' => 7, 'monthly' => 30];
        if (isset($daysMap[$subPlan])) {
            $subExp = (new \DateTime())->modify('+' . $daysMap[$subPlan] . ' days')->format('Y-m-d H:i:s');
        }
    }

    if ($subExp !== null && $subExp !== '') {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}/', $subExp)
            || !\DateTime::createFromFormat('Y-m-d', substr($subExp, 0, 10))) {
            jsonResponse(['error' => 'Invalid subscription_expires_at format (use YYYY-MM-DD)'], 400);
        }
    }

    /* Validate optional Telegram username */
    $tgUsername = ($tgUsername === '') ? null : $tgUsername;
    if ($tgUsername !== null) {
        if (strlen($tgUsername) > 32 || !preg_match('/^[a-zA-Z0-9_]{5,32}$/', $tgUsername)) {
            jsonResponse(['error' => 'Invalid Telegram username (5–32 chars, letters/numbers/underscores, no @)'], 400);
        }
    }

    try {
        $lastQuery = null;
        $lastParams = [];
        $pdo = getDB();

        /* Duplicate username */
        $lastQuery = 'SELECT id FROM users WHERE username = ?';
        $lastParams = [$username];
        $stmt = $pdo->prepare($lastQuery);
        $stmt->execute($lastParams);
        if ($stmt->fetch()) {
            jsonResponse(['error' => 'Username already exists'], 409);
        }

        /* Duplicate email */
        if ($email !== '') {
            $lastQuery = 'SELECT id FROM users WHERE email = ?';
            $lastParams = [$email];
            $stmt = $pdo->prepare($lastQuery);
            $stmt->execute($lastParams);
            if ($stmt->fetch()) {
                jsonResponse(['error' => 'Email already registered'], 409);
            }
        }

        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        $lastQuery = 'INSERT INTO users (username, email, password_hash, display_name, role, status, subscription_status, subscription_plan, subscription_expires_at, telegram_username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        $lastParams = [
            $username,
            $email ?: null,
            $hash,
            $username,
            $role,
            $status,
            $sub,
            $subPlan,
            ($subExp !== '' && $subExp !== null) ? $subExp : null,
            $tgUsername,
        ];
        $stmt = $pdo->prepare($lastQuery);
        $stmt->execute($lastParams);
        $newId = (int) $pdo->lastInsertId();
        
        // Diagnostic logging
        error_log("User CREATE: username=$username, role=$role, status=$status, sub=$sub, newId=$newId");
        
        // Verify write
        $verify = $pdo->prepare('SELECT id, username, role, status FROM users WHERE id = ?');
        $verify->execute([$newId]);
        $verifyRow = $verify->fetch(PDO::FETCH_ASSOC);
        
        if (!$verifyRow) {
            error_log("User CREATE VERIFICATION FAILED: id=$newId not found in database");
        } else {
            error_log("User CREATE VERIFIED: " . json_encode($verifyRow));
        }

        /* Grant initial strategies if provided */
        $strategies = $body['strategies'] ?? [];
        if (is_array($strategies) && $strategies) {
            $lastQuery = 'INSERT IGNORE INTO strategy_access (user_id, strategy_key, granted_by) VALUES (?, ?, ?)';
            $lastParams = [];
            $ins = $pdo->prepare($lastQuery);
            foreach ($strategies as $key) {
                $key = trim((string) $key);
                if ($key !== '') {
                    $lastParams = [$newId, $key, $adminId];
                    $ins->execute($lastParams);
                    error_log("User Strategy GRANT: userId=$newId, strategy=$key, grantedBy=$adminId");
                }
            }
        }

        jsonResponse(['id' => $newId, 'message' => 'User created'], 201);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/users', 'POST', $e, $lastQuery, $lastParams);
        jsonResponse($response, 500);
    }
}

jsonResponse(['error' => 'Method not allowed'], 405);
