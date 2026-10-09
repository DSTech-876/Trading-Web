<?php
/**
 * /api/admin/profiles.php
 * ───────────────────────
 * Admin endpoint for managing indicator settings profiles.
 *
 * GET                      — list all profiles (optional ?user_id=<n> to filter assigned ones)
 * POST                     — create a new profile
 * PATCH  ?id=<profile_id>  — update profile name / settings
 * DELETE ?id=<profile_id>  — delete a profile (also removes all assignments)
 *
 * POST  ?action=assign      body: { profile_id, user_id }   — assign profile to user
 * DELETE?action=unassign    body: { profile_id, user_id }   — remove assignment
 *
 * GET   ?action=assignments&user_id=<n>  — list profiles assigned to a specific user
 *
 * All requests require  Authorization: Bearer <admin-token>
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth_guard.php';
require_once __DIR__ . '/../lib/APILogger.php';

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$adminId = (int) ($GLOBALS['adminUserId'] ?? 0);
if ($adminId <= 0) {
    jsonResponse(['error' => 'Admin user ID is missing or invalid'], 500);
}

/* ═══════════════════════════════════════════════
   GET — list profiles
   ═══════════════════════════════════════════════ */
if ($method === 'GET') {
    try {
        $pdo = getDB();

        /* List profiles assigned to a specific user */
        if ($action === 'assignments') {
            $userId = (int) ($_GET['user_id'] ?? 0);
            if ($userId <= 0) {
                jsonResponse(['error' => 'Missing or invalid ?user_id parameter'], 400);
            }
            $stmt = $pdo->prepare(
                'SELECT ip.id, ip.name, ip.is_admin_profile,
                        ip.created_at, ip.updated_at,
                        upa.assigned_at,
                        COALESCE(u.username, \'[deleted user]\') AS assigned_by_username
                   FROM user_profile_assignments upa
                   JOIN indicator_profiles ip ON ip.id = upa.profile_id
                   LEFT JOIN users u ON u.id = upa.assigned_by
                  WHERE upa.user_id = ?
                  ORDER BY upa.assigned_at DESC'
            );
            $stmt->execute([$userId]);
            $rows = $stmt->fetchAll() ?: [];
            foreach ($rows as &$r) {
                if ($r) {
                    $r['is_admin_profile'] = (bool) ($r['is_admin_profile'] ?? false);
                }
            }
            jsonResponse(['assignments' => $rows]);
        }

        /* List user IDs that have a specific profile assigned */
        if ($action === 'assignments_for_profile') {
            $profileId = (int) ($_GET['profile_id'] ?? 0);
            if ($profileId <= 0) {
                jsonResponse(['error' => 'Missing or invalid ?profile_id parameter'], 400);
            }
            $stmt = $pdo->prepare(
                'SELECT user_id FROM user_profile_assignments WHERE profile_id = ?'
            );
            $stmt->execute([$profileId]);
            $results = $stmt->fetchAll() ?: [];
            $ids = array_column($results, 'user_id') ?: [];
            jsonResponse(['assigned_user_ids' => array_map('intval', $ids)]);
        }

        /* List all profiles */
        $stmt = $pdo->prepare(
            'SELECT ip.id, ip.name, ip.is_admin_profile, ip.created_at, ip.updated_at,
                    COALESCE(u.username, \'[deleted user]\') AS created_by_username,
                    (SELECT COUNT(*) FROM user_profile_assignments upa WHERE upa.profile_id = ip.id) AS assignment_count
               FROM indicator_profiles ip
               LEFT JOIN users u ON u.id = ip.created_by
              ORDER BY ip.is_admin_profile DESC, ip.updated_at DESC'
        );
        $stmt->execute();
        $rows = $stmt->fetchAll() ?: [];
        foreach ($rows as &$r) {
            $r['is_admin_profile']  = (bool) ($r['is_admin_profile'] ?? false);
            $r['assignment_count']  = (int)  ($r['assignment_count'] ?? 0);
        }
        jsonResponse(['profiles' => $rows]);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/profiles', 'GET', $e);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   POST — create profile  OR  assign profile to user
   ═══════════════════════════════════════════════ */
if ($method === 'POST') {
    $body = getJsonBody();

    /* Assign profile to user */
    if ($action === 'assign') {
        $profileId = (int) ($body['profile_id'] ?? 0);
        $userId    = (int) ($body['user_id']    ?? 0);
        if ($profileId <= 0 || $userId <= 0) {
            jsonResponse(['error' => 'profile_id and user_id are required'], 400);
        }
        try {
            $pdo = getDB();
            /* Verify profile and user exist */
            $chkP = $pdo->prepare('SELECT id FROM indicator_profiles WHERE id = ?');
            $chkP->execute([$profileId]);
            if (!$chkP->fetch()) {
                jsonResponse(['error' => 'Profile not found'], 404);
            }
            $chkU = $pdo->prepare('SELECT id FROM users WHERE id = ?');
            $chkU->execute([$userId]);
            if (!$chkU->fetch()) {
                jsonResponse(['error' => 'Invalid user_id: user does not exist'], 400);
            }

            $ins = $pdo->prepare(
                'INSERT IGNORE INTO user_profile_assignments (user_id, profile_id, assigned_by)
                 VALUES (?, ?, ?)'
            );
            $ins->execute([$userId, $profileId, $adminId]);
            jsonResponse(['message' => 'Profile assigned']);
        } catch (\Throwable $e) {
            $response = APILogger::logEndpointError('/api/admin/profiles', 'POST', $e);
            jsonResponse($response, 500);
        }
    }

    /* Create new profile */
    $name    = trim((string) ($body['name']     ?? ''));
    $settings = $body['settings'] ?? null;
    $isAdmin  = !empty($body['is_admin_profile']);

    if ($name === '' || mb_strlen($name) > 60) {
        jsonResponse(['error' => 'Profile name must be 1–60 characters'], 400);
    }
    if (!is_array($settings) && !is_object($settings)) {
        jsonResponse(['error' => 'settings must be a JSON object'], 400);
    }

    $settingsJson = json_encode($settings, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (strlen($settingsJson) > 512000) {
        jsonResponse(['error' => 'Settings snapshot is too large (max 500 KB)'], 400);
    }

    try {
        $pdo = getDB();
        $ins  = $pdo->prepare(
            'INSERT INTO indicator_profiles (name, settings_json, created_by, is_admin_profile)
             VALUES (?, ?, ?, ?)'
        );
        $ins->execute([$name, $settingsJson, $adminId, $isAdmin ? 1 : 0]);
        jsonResponse(['message' => 'Profile created', 'id' => (int) $pdo->lastInsertId()], 201);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/profiles', 'POST', $e);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   PATCH — update profile name / settings
   ═══════════════════════════════════════════════ */
if ($method === 'PATCH') {
    $profileId = (int) ($_GET['id'] ?? 0);
    if ($profileId <= 0) {
        jsonResponse(['error' => 'Missing or invalid ?id parameter'], 400);
    }

    $body = getJsonBody();
    $set  = [];
    $params = [];

    if (isset($body['name'])) {
        $name = trim((string) $body['name']);
        if ($name === '' || mb_strlen($name) > 60) {
            jsonResponse(['error' => 'Profile name must be 1–60 characters'], 400);
        }
        $set[]    = 'name = ?';
        $params[] = $name;
    }

    if (array_key_exists('settings', $body)) {
        $settings = $body['settings'];
        if (!is_array($settings) && !is_object($settings)) {
            jsonResponse(['error' => 'settings must be a JSON object'], 400);
        }
        $json = json_encode($settings, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > 512000) {
            jsonResponse(['error' => 'Settings snapshot is too large (max 500 KB)'], 400);
        }
        $set[]    = 'settings_json = ?';
        $params[] = $json;
    }

    if (isset($body['is_admin_profile'])) {
        $set[]    = 'is_admin_profile = ?';
        $params[] = $body['is_admin_profile'] ? 1 : 0;
    }

    if (!$set) {
        jsonResponse(['error' => 'No updatable fields provided'], 400);
    }

    $params[] = $profileId;

    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare('UPDATE indicator_profiles SET ' . implode(', ', $set) . ' WHERE id = ?');
        $stmt->execute($params);
        if ($stmt->rowCount() === 0) {
            jsonResponse(['error' => 'Profile not found'], 404);
        }
        jsonResponse(['message' => 'Profile updated']);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/profiles', 'PATCH', $e);
        jsonResponse($response, 500);
    }
}

/* ═══════════════════════════════════════════════
   DELETE — delete profile  OR  remove assignment
   ═══════════════════════════════════════════════ */
if ($method === 'DELETE') {
    /* Remove profile assignment */
    if ($action === 'unassign') {
        $body      = getJsonBody();
        $profileId = (int) ($body['profile_id'] ?? 0);
        $userId    = (int) ($body['user_id']    ?? 0);
        if ($profileId <= 0 || $userId <= 0) {
            jsonResponse(['error' => 'profile_id and user_id are required'], 400);
        }
        try {
            $pdo  = getDB();
            $del  = $pdo->prepare(
                'DELETE FROM user_profile_assignments WHERE user_id = ? AND profile_id = ?'
            );
            $del->execute([$userId, $profileId]);
            jsonResponse(['message' => 'Assignment removed']);
        } catch (\Throwable $e) {
            $response = APILogger::logEndpointError('/api/admin/profiles', 'DELETE', $e);
            jsonResponse($response, 500);
        }
    }

    /* Delete profile entirely */
    $profileId = (int) ($_GET['id'] ?? 0);
    if ($profileId <= 0) {
        jsonResponse(['error' => 'Missing or invalid ?id parameter'], 400);
    }

    try {
        $pdo  = getDB();
        $del  = $pdo->prepare('DELETE FROM indicator_profiles WHERE id = ?');
        $del->execute([$profileId]);
        if ($del->rowCount() === 0) {
            jsonResponse(['error' => 'Profile not found'], 404);
        }
        jsonResponse(['message' => 'Profile deleted']);
    } catch (\Throwable $e) {
        $response = APILogger::logEndpointError('/api/admin/profiles', 'DELETE', $e);
        jsonResponse($response, 500);
    }
}

jsonResponse(['error' => 'Method not allowed'], 405);
