<?php
/**
 * Admin Adaptive Intelligence Management API
 * Provides management endpoints for adaptive intelligence data
 * 
 * GET /api/admin/adaptive_intelligence?user_id=123 - Get user's adaptive profiles
 * GET /api/admin/adaptive_intelligence/rules?user_id=123 - Get user's adaptive rules
 * GET /api/admin/adaptive_intelligence/stats - Get adaptive system statistics
 * POST /api/admin/adaptive_intelligence/reset - Reset adaptive data for user
 */

header('Content-Type: application/json; charset=utf-8');

require_once(__DIR__ . '/../lib/Database.php');
require_once(__DIR__ . '/../lib/AuthGuard.php');
require_once(__DIR__ . '/../lib/AdminHelper.php');

try {
    // Verify admin access
    $admin = AuthGuard::requireAdmin();
    $admin_id = $admin['id'];
    $db = Database::getInstance();
    $helper = new AdminHelper($db);
    
    $method = $_SERVER['REQUEST_METHOD'];
    $action = $_GET['action'] ?? 'profiles';
    
    if ($method === 'GET') {
        if ($action === 'profiles') {
            // Get adaptive profiles for a user
            $user_id = (int) ($_GET['user_id'] ?? 0);
            if ($user_id === 0) {
                http_response_code(400);
                echo json_encode(['error' => 'user_id is required']);
                exit;
            }
            
            $page = (int) ($_GET['page'] ?? 1);
            $per_page = min(max((int) ($_GET['per_page'] ?? 50), 10), 500);
            $offset = ($page - 1) * $per_page;
            
            $total = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_learning_profiles WHERE user_id = ?",
                [$user_id]
            )['cnt']) ?? 0);
            
            $profiles = $db->fetchAll("
                SELECT id, user_id, scope_type, market_category, strategy_key, symbol_scope,
                       trade_count, wins, losses, confidence_score, created_at, updated_at
                FROM adaptive_learning_profiles
                WHERE user_id = ?
                ORDER BY updated_at DESC
                LIMIT $per_page OFFSET $offset
            ", [
                $user_id
            ]);
            
            echo json_encode([
                'success' => true,
                'user_id' => $user_id,
                'page' => $page,
                'per_page' => $per_page,
                'total' => (int) $total,
                'last_page' => max(1, ceil($total / $per_page)),
                'profiles' => $profiles
            ]);
        }
        elseif ($action === 'rules') {
            // Get qualification rules for a user
            $user_id = (int) ($_GET['user_id'] ?? 0);
            if ($user_id === 0) {
                http_response_code(400);
                echo json_encode(['error' => 'user_id is required']);
                exit;
            }
            
            $page = (int) ($_GET['page'] ?? 1);
            $per_page = min(max((int) ($_GET['per_page'] ?? 50), 10), 500);
            $offset = ($page - 1) * $per_page;
            
            $total = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_qualification_rules WHERE user_id = ?",
                [$user_id]
            )['cnt']) ?? 0);
            
            $rules = $db->fetchAll("
                SELECT id, user_id, market_category, strategy_key, symbol_scope, reject_below,
                       watchlist_below, high_confidence_min, min_sample_size, enabled, created_at, updated_at
                FROM adaptive_qualification_rules
                WHERE user_id = ?
                ORDER BY updated_at DESC
                LIMIT $per_page OFFSET $offset
            ", [
                $user_id
            ]);
            
            echo json_encode([
                'success' => true,
                'user_id' => $user_id,
                'page' => $page,
                'per_page' => $per_page,
                'total' => (int) $total,
                'last_page' => max(1, ceil($total / $per_page)),
                'rules' => $rules
            ]);
        }
        elseif ($action === 'stats') {
            // Get adaptive system statistics
            // total_profiles reflects the cached aggregate table (adaptive_learning_profiles).
            // This is intentionally distinct from the raw per-scope adaptive_profiles table,
            // which is exposed separately as raw_adaptive_profiles below.
            $total_profiles = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_learning_profiles"
            )['cnt']) ?? 0);
            
            $total_rules = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_qualification_rules"
            )['cnt']) ?? 0);
            
            $active_profiles = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_learning_profiles WHERE confidence_score >= 50"
            )['cnt']) ?? 0);
            
            $users_with_adaptive = (int) (($db->fetchOne(
                "SELECT COUNT(DISTINCT user_id) as cnt FROM adaptive_learning_profiles"
            )['cnt']) ?? 0);

            $raw_adaptive_profiles = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_profiles"
            )['cnt']) ?? 0);

            $factor_stats_count = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_factor_stats"
            )['cnt']) ?? 0);

            $trade_history_count = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_trade_history"
            )['cnt']) ?? 0);

            $signal_decisions_count = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_signal_decisions"
            )['cnt']) ?? 0);
            
            // Get strategy breakdown
            $by_strategy = $db->fetchAll("
                SELECT strategy_key, COUNT(*) as count, AVG(confidence_score) as avg_confidence
                FROM adaptive_learning_profiles
                GROUP BY strategy_key
                ORDER BY count DESC
            ");

            $rules_by_strategy = $db->fetchAll("
                SELECT strategy_key, COUNT(*) as count
                FROM adaptive_qualification_rules
                GROUP BY strategy_key
                ORDER BY count DESC
            ");
            
            echo json_encode([
                'success' => true,
                'total_profiles' => $total_profiles,
                'total_rules' => $total_rules,
                'active_profiles' => $active_profiles,
                'users_with_adaptive' => $users_with_adaptive,
                'raw_adaptive_profiles' => $raw_adaptive_profiles,
                'factor_stats_count' => $factor_stats_count,
                'trade_history_count' => $trade_history_count,
                'signal_decisions_count' => $signal_decisions_count,
                'by_strategy' => array_map(function($s) {
                    return [
                        'strategy' => $s['strategy_key'],
                        'count' => (int) $s['count'],
                        'avg_confidence' => round($s['avg_confidence'] ?? 0, 2)
                    ];
                }, $by_strategy),
                'rules_by_strategy' => array_map(function($s) {
                    return [
                        'strategy' => $s['strategy_key'],
                        'count' => (int) $s['count']
                    ];
                }, $rules_by_strategy)
            ]);
        }
        elseif ($action === 'all_profiles') {
            // System-wide, real-paginated listing of learning profiles across all users
            $page = (int) ($_GET['page'] ?? 1);
            $per_page = min(max((int) ($_GET['per_page'] ?? 25), 5), 200);
            $offset = ($page - 1) * $per_page;
            $search = trim((string) ($_GET['search'] ?? ''));

            $where = '';
            $params = [];
            if ($search !== '') {
                $where = "WHERE u.username LIKE ? OR u.display_name LIKE ? OR alp.strategy_key LIKE ? OR alp.market_category LIKE ?";
                $like = '%' . $search . '%';
                $params = [$like, $like, $like, $like];
            }

            $total = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_learning_profiles alp
                 JOIN users u ON u.id = alp.user_id $where",
                $params
            )['cnt']) ?? 0);

            $profiles = $db->fetchAll("
                SELECT alp.id, alp.user_id, u.username, u.display_name, alp.scope_type,
                       alp.market_category, alp.strategy_key, alp.symbol_scope,
                       alp.trade_count, alp.wins, alp.losses, alp.confidence_score,
                       alp.updated_at, alp.created_at
                FROM adaptive_learning_profiles alp
                JOIN users u ON u.id = alp.user_id
                $where
                ORDER BY alp.updated_at DESC
                LIMIT $per_page OFFSET $offset
            ", $params);

            echo json_encode([
                'success' => true,
                'page' => $page,
                'per_page' => $per_page,
                'total' => $total,
                'last_page' => max(1, (int) ceil($total / $per_page)),
                'profiles' => $profiles
            ]);
        }
        elseif ($action === 'all_rules') {
            // System-wide, real-paginated listing of qualification rules across all users
            $page = (int) ($_GET['page'] ?? 1);
            $per_page = min(max((int) ($_GET['per_page'] ?? 25), 5), 200);
            $offset = ($page - 1) * $per_page;
            $search = trim((string) ($_GET['search'] ?? ''));

            $where = '';
            $params = [];
            if ($search !== '') {
                $where = "WHERE u.username LIKE ? OR u.display_name LIKE ? OR aqr.strategy_key LIKE ? OR aqr.market_category LIKE ?";
                $like = '%' . $search . '%';
                $params = [$like, $like, $like, $like];
            }

            $total = (int) (($db->fetchOne(
                "SELECT COUNT(*) as cnt FROM adaptive_qualification_rules aqr
                 JOIN users u ON u.id = aqr.user_id $where",
                $params
            )['cnt']) ?? 0);

            $rules = $db->fetchAll("
                SELECT aqr.id, aqr.user_id, u.username, u.display_name, aqr.market_category,
                       aqr.strategy_key, aqr.symbol_scope, aqr.reject_below, aqr.watchlist_below,
                       aqr.high_confidence_min, aqr.min_sample_size, aqr.enabled,
                       aqr.updated_at, aqr.created_at
                FROM adaptive_qualification_rules aqr
                JOIN users u ON u.id = aqr.user_id
                $where
                ORDER BY aqr.updated_at DESC
                LIMIT $per_page OFFSET $offset
            ", $params);

            echo json_encode([
                'success' => true,
                'page' => $page,
                'per_page' => $per_page,
                'total' => $total,
                'last_page' => max(1, (int) ceil($total / $per_page)),
                'rules' => $rules
            ]);
        }
        elseif ($action === 'trend') {
            // Real 7-day activity trend sourced directly from adaptive_trade_history,
            // adaptive_qualification_rules, and adaptive_learning_profiles (no synthetic data).
            $days = 7;
            $tradesByDay = $db->fetchAll("
                SELECT DATE(created_at) as d, COUNT(*) as cnt, SUM(result = 'WIN') as wins
                FROM adaptive_trade_history
                WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL " . ($days - 1) . " DAY)
                GROUP BY DATE(created_at)
            ");
            $rulesByDay = $db->fetchAll("
                SELECT DATE(updated_at) as d, COUNT(*) as cnt
                FROM adaptive_qualification_rules
                WHERE updated_at >= DATE_SUB(CURDATE(), INTERVAL " . ($days - 1) . " DAY)
                GROUP BY DATE(updated_at)
            ");
            $usersByDay = $db->fetchAll("
                SELECT DATE(updated_at) as d, COUNT(DISTINCT user_id) as cnt
                FROM adaptive_learning_profiles
                WHERE updated_at >= DATE_SUB(CURDATE(), INTERVAL " . ($days - 1) . " DAY)
                GROUP BY DATE(updated_at)
            ");

            $tradesMap = [];
            $winsMap = [];
            foreach ($tradesByDay as $row) {
                $tradesMap[$row['d']] = (int) $row['cnt'];
                $winsMap[$row['d']] = (int) $row['wins'];
            }
            $rulesMap = [];
            foreach ($rulesByDay as $row) {
                $rulesMap[$row['d']] = (int) $row['cnt'];
            }
            $usersMap = [];
            foreach ($usersByDay as $row) {
                $usersMap[$row['d']] = (int) $row['cnt'];
            }

            $labels = [];
            $trades = [];
            $wins = [];
            $ruleUpdates = [];
            $usersActive = [];
            for ($i = $days - 1; $i >= 0; $i--) {
                $date = gmdate('Y-m-d', strtotime("-$i day"));
                $labels[] = gmdate('M j', strtotime($date));
                $trades[] = $tradesMap[$date] ?? 0;
                $wins[] = $winsMap[$date] ?? 0;
                $ruleUpdates[] = $rulesMap[$date] ?? 0;
                $usersActive[] = $usersMap[$date] ?? 0;
            }

            echo json_encode([
                'success' => true,
                'labels' => $labels,
                'trades' => $trades,
                'wins' => $wins,
                'rule_updates' => $ruleUpdates,
                'users_active' => $usersActive
            ]);
        }
        else {
            http_response_code(400);
            echo json_encode(['error' => 'Unknown action: ' . htmlspecialchars($action)]);
        }
    }
    elseif ($method === 'POST') {
        // Reset adaptive intelligence for user
        $body = json_decode(file_get_contents('php://input'), true);
        
        if (!isset($body['user_id'])) {
            http_response_code(400);
            echo json_encode(['error' => 'user_id is required']);
            exit;
        }
        
        $user_id = (int) $body['user_id'];
        
        // Verify user exists
        $user = $db->fetchOne("SELECT id FROM users WHERE id = ?", [$user_id]);
        if (!$user) {
            http_response_code(404);
            echo json_encode(['error' => 'User not found']);
            exit;
        }
        
        // Reset adaptive data
        $helper->resetAdaptiveIntelligence($user_id, $admin_id);
        
        echo json_encode([
            'success' => true,
            'user_id' => $user_id,
            'message' => 'Adaptive intelligence reset successfully'
        ]);
    }
    else {
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
    }
    
} catch (\Throwable $e) {
    http_response_code(500);
    error_log('Admin adaptive_intelligence error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    echo json_encode(['error' => 'Failed to process request: ' . $e->getMessage()]);
}
?>
