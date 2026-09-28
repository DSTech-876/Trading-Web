<?php
/**
 * /api/admin/notification_preferences.php
 * ─────────────────────────────────────────
 * Admin-only management of per-user Telegram/notification preferences.
 *
 * GET  /api/admin/notification_preferences
 *   List all users with their current preferences (defaults shown for
 *   users who never saved custom preferences) plus aggregate statistics.
 *
 * GET  /api/admin/notification_preferences?id=<user_id>
 *   Get a single user's preferences.
 *
 * POST /api/admin/notification_preferences?id=<user_id>
 *   Modify a single user's preferences (partial update body).
 *
 * POST /api/admin/notification_preferences?action=reset&id=<user_id>
 *   Reset a single user's preferences back to defaults.
 *
 * POST /api/admin/notification_preferences?action=apply_defaults
 *   Apply the default preferences to every user who has no saved row yet.
 *
 * POST /api/admin/notification_preferences?action=bulk_update
 *   Body: { "user_ids": [1,2,3], "updates": { "telegram_take_profit": true, ... } }
 *   Bulk-apply the given updates to the listed users (creates rows as needed).
 *
 * All requests require Authorization: ****** (admin role).
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth_guard.php';
require_once __DIR__ . '/../lib/APILogger.php';

const ADMIN_NOTIF_PREF_COLUMNS = [
    'telegram_trade_setup'          => true,
    'telegram_trade_activation'     => true,
    'telegram_take_profit'          => true,
    'telegram_stop_loss'            => true,
    'telegram_trade_cancelled'      => true,
    'telegram_trade_expired'        => true,
    'telegram_market_alerts'        => true,
    'telegram_scanner_alerts'       => true,
    'telegram_high_confidence_only' => false,
];

function adminNotifPrefDefaults(): array
{
    $out = [];
    foreach (ADMIN_NOTIF_PREF_COLUMNS as $col => $default) {
        $out[$col] = $default;
    }
    return $out;
}

function adminNotifPrefRowToBool(array $row): array
{
    $out = [];
    foreach (array_keys(ADMIN_NOTIF_PREF_COLUMNS) as $col) {
        $out[$col] = !empty($row[$col] ?? false) ? true : false;
    }
    return $out;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    $pdo = getDB();
} catch (\Throwable $e) {
    $response = APILogger::logEndpointError('/api/admin/notification_preferences', $_SERVER['REQUEST_METHOD'], $e);
    jsonResponse($response, 500);
}

/* ═══════════════════════════════════════════════
   GET — list all users' preferences + stats, or one user
   ═══════════════════════════════════════════════ */
if ($method === 'GET') {
    $targetId = (int) ($_GET['id'] ?? 0);

    try {
        if ($targetId > 0) {
            $stmt = $pdo->prepare('SELECT username FROM users WHERE id = ?');
            $stmt->execute([$targetId]);
            $user = $stmt->fetch();
            if (!$user) {
                jsonResponse(['error' => 'User not found'], 404);
            }

            $stmt = $pdo->prepare('SELECT * FROM user_notification_preferences WHERE user_id = ?');
            $stmt->execute([$targetId]);
            $row = $stmt->fetch();

            jsonResponse([
                'user_id'     => $targetId,
                'username'    => $user['username'],
                'preferences' => $row ? adminNotifPrefRowToBool($row) : adminNotifPrefDefaults(),
                'is_default'  => !$row,
            ]);
        }

        /* Server-side pagination + search, matching every other admin list
           endpoint (Requirement 7: server-side pagination only, accurate
           total counts, search compatible with pagination). Stats/total
           user count are aggregated across the ENTIRE user base — not just
           the current page — because they represent system-wide totals. */
        $page    = max(1, (int) ($_GET['page'] ?? 1));
        $perPage = min(200, max(10, (int) ($_GET['per_page'] ?? 50)));
        $search  = trim((string) ($_GET['search'] ?? ''));

        /* List all users with their preferences (defaults if not saved) */
        $userStmt = $pdo->prepare('SELECT id, username FROM users ORDER BY username');
        $userStmt->execute();
        $users = $userStmt->fetchAll() ?: [];

        $prefStmt = $pdo->prepare('SELECT * FROM user_notification_preferences');
        $prefStmt->execute();
        $prefRows = $prefStmt->fetchAll() ?: [];
        $byUser = [];
        foreach ($prefRows as $r) {
            if ($r && isset($r['user_id'])) {
                $byUser[(int) $r['user_id']] = adminNotifPrefRowToBool($r);
            }
        }

        $fullList = [];
        $stats = array_fill_keys(array_keys(ADMIN_NOTIF_PREF_COLUMNS), 0);
        foreach ($users as $u) {
            if (!$u || !isset($u['id'])) {
                continue;
            }
            $uid = (int) $u['id'];
            $prefs = $byUser[$uid] ?? adminNotifPrefDefaults();
            foreach ($prefs as $col => $val) {
                if ($val) $stats[$col]++;
            }
            $fullList[] = [
                'user_id'     => $uid,
                'username'    => $u['username'] ?? 'unknown',
                'preferences' => $prefs,
                'is_default'  => !isset($byUser[$uid]),
            ];
        }

        /* Search filter applies to the paginated view only — stats and
           total_users above always reflect the full, unfiltered user base. */
        $filteredList = $search === ''
            ? $fullList
            : array_values(array_filter($fullList, function ($row) use ($search) {
                return stripos($row['username'], $search) !== false;
            }));

        $total = count($filteredList);
        $lastPage = max(1, (int) ceil($total / $perPage));
        if ($page > $lastPage) {
            $page = $lastPage;
        }
        $offset = ($page - 1) * $perPage;
        $pagedList = array_slice($filteredList, $offset, $perPage);

        jsonResponse([
            'users'       => $pagedList,
            'page'        => $page,
            'per_page'    => $perPage,
            'total'       => $total,
            'last_page'   => $lastPage,
            'total_users' => count($users),
            'stats'       => $stats,
        ]);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/notification_preferences', 'GET', $e);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   POST — modify / reset / apply_defaults / bulk_update
   ═══════════════════════════════════════════════ */
if ($method === 'POST') {
    $action   = trim($_GET['action'] ?? '');
    $targetId = (int) ($_GET['id'] ?? 0);
    $body     = getJsonBody();

    /* ── apply_defaults: create default rows for users missing one ── */
    if ($action === 'apply_defaults') {
        try {
            $missing = $pdo->query(
                'SELECT u.id FROM users u
                  LEFT JOIN user_notification_preferences p ON p.user_id = u.id
                 WHERE p.id IS NULL'
            )->fetchAll();

            $cols = array_keys(ADMIN_NOTIF_PREF_COLUMNS);
            $placeholders = implode(', ', array_fill(0, count($cols) + 1, '?'));
            $stmt = $pdo->prepare(
                'INSERT INTO user_notification_preferences (user_id, ' . implode(', ', $cols) . ") VALUES ($placeholders)"
            );
            foreach ($missing as $row) {
                $params = array_map(fn($v) => $v ? 1 : 0, array_values(ADMIN_NOTIF_PREF_COLUMNS));
                array_unshift($params, (int) $row['id']);
                $stmt->execute($params);
            }

            jsonResponse(['ok' => true, 'applied_count' => count($missing)]);
        } catch (\Throwable $e) {
            $response = APILogger::logEndpointError('/api/admin/notification_preferences', 'POST', $e);
            jsonResponse($response, 500);
        }
    }

    /* ── bulk_update: apply the same changes to a list of users ── */
    if ($action === 'bulk_update') {
        $userIds = array_values(array_filter(array_map('intval', $body['user_ids'] ?? []), fn($v) => $v > 0));
        $updates = is_array($body['updates'] ?? null) ? $body['updates'] : [];

        if (empty($userIds) || empty($updates)) {
            jsonResponse(['error' => 'user_ids and updates are required'], 400);
        }

        $validUpdates = [];
        foreach ($updates as $col => $val) {
            if (array_key_exists($col, ADMIN_NOTIF_PREF_COLUMNS)) {
                $validUpdates[$col] = !empty($val) ? 1 : 0;
            }
        }
        if (empty($validUpdates)) {
            jsonResponse(['error' => 'No valid preference columns in updates'], 400);
        }

        try {
            $updatedCount = 0;
            foreach ($userIds as $uid) {
                $stmt = $pdo->prepare('SELECT id FROM user_notification_preferences WHERE user_id = ?');
                $stmt->execute([$uid]);
                $exists = $stmt->fetch();

                if ($exists) {
                    $sets = [];
                    $params = [];
                    foreach ($validUpdates as $col => $val) {
                        $sets[] = "$col = ?";
                        $params[] = $val;
                    }
                    $params[] = $uid;
                    $pdo->prepare('UPDATE user_notification_preferences SET ' . implode(', ', $sets) . ' WHERE user_id = ?')
                        ->execute($params);
                } else {
                    $current = array_map(fn($v) => $v ? 1 : 0, ADMIN_NOTIF_PREF_COLUMNS);
                    $current = array_merge($current, $validUpdates);
                    $cols = array_keys($current);
                    $placeholders = implode(', ', array_fill(0, count($cols) + 1, '?'));
                    $params = array_values($current);
                    array_unshift($params, $uid);
                    $pdo->prepare(
                        'INSERT INTO user_notification_preferences (user_id, ' . implode(', ', $cols) . ") VALUES ($placeholders)"
                    )->execute($params);
                }
                $updatedCount++;
            }

            jsonResponse(['ok' => true, 'updated_count' => $updatedCount]);
        } catch (\Throwable $e) {
            $response = APILogger::logEndpointError('/api/admin/notification_preferences', 'POST', $e);
            jsonResponse($response, 500);
        }
    }

    /* ── reset: restore one user's preferences to defaults ── */
    if ($action === 'reset') {
        if ($targetId <= 0) {
            jsonResponse(['error' => 'Missing or invalid ?id parameter'], 400);
        }
        try {
            $pdo->prepare('DELETE FROM user_notification_preferences WHERE user_id = ?')->execute([$targetId]);
            $cols = array_keys(ADMIN_NOTIF_PREF_COLUMNS);
            $placeholders = implode(', ', array_fill(0, count($cols) + 1, '?'));
            $params = array_map(fn($v) => $v ? 1 : 0, array_values(ADMIN_NOTIF_PREF_COLUMNS));
            array_unshift($params, $targetId);
            $pdo->prepare(
                'INSERT INTO user_notification_preferences (user_id, ' . implode(', ', $cols) . ") VALUES ($placeholders)"
            )->execute($params);

            jsonResponse(['ok' => true, 'preferences' => adminNotifPrefDefaults()]);
        } catch (\Throwable $e) {
            $response = APILogger::logEndpointError('/api/admin/notification_preferences', 'POST', $e);
            jsonResponse($response, 500);
        }
    }

    /* ── default action: modify a single user's preferences ── */
    if ($targetId <= 0) {
        jsonResponse(['error' => 'Missing or invalid ?id parameter, or unknown ?action'], 400);
    }

    try {
        $stmt = $pdo->prepare('SELECT id FROM users WHERE id = ?');
        $stmt->execute([$targetId]);
        if (!$stmt->fetch()) {
            jsonResponse(['error' => 'User not found'], 404);
        }

        $stmt = $pdo->prepare('SELECT * FROM user_notification_preferences WHERE user_id = ?');
        $stmt->execute([$targetId]);
        $existing = $stmt->fetch();

        $current = $existing ? adminNotifPrefRowToBool($existing) : adminNotifPrefDefaults();
        foreach (array_keys(ADMIN_NOTIF_PREF_COLUMNS) as $col) {
            if (array_key_exists($col, $body)) {
                $current[$col] = !empty($body[$col]);
            }
        }

        if ($existing) {
            $sets = [];
            $params = [];
            foreach ($current as $col => $val) {
                $sets[] = "$col = ?";
                $params[] = $val ? 1 : 0;
            }
            $params[] = $targetId;
            $pdo->prepare('UPDATE user_notification_preferences SET ' . implode(', ', $sets) . ' WHERE user_id = ?')
                ->execute($params);
        } else {
            $cols = array_keys($current);
            $placeholders = implode(', ', array_fill(0, count($cols) + 1, '?'));
            $params = array_map(fn($v) => $v ? 1 : 0, array_values($current));
            array_unshift($params, $targetId);
            $pdo->prepare(
                'INSERT INTO user_notification_preferences (user_id, ' . implode(', ', $cols) . ") VALUES ($placeholders)"
            )->execute($params);
        }

        jsonResponse(['ok' => true, 'preferences' => $current]);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/notification_preferences', 'POST', $e);
        jsonResponse($response, 500);
    }
}

jsonResponse(['error' => 'Method not allowed'], 405);
