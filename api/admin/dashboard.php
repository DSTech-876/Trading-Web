<?php
/**
 * Admin Dashboard Home API
 * Provides KPI metrics and summary statistics for the executive dashboard
 * 
 * GET /api/admin/dashboard - Get all dashboard metrics
 * GET /api/admin/dashboard?metric=users - Get specific metric
 */

header('Content-Type: application/json; charset=utf-8');

require_once(__DIR__ . '/../lib/Database.php');
require_once(__DIR__ . '/../lib/AuthGuard.php');

try {
    // Verify admin access
    $admin = AuthGuard::requireAdmin();
    
    $db = Database::getInstance();
    $metric = $_GET['metric'] ?? null;
    
    // Helper function to get metric
    function getMetric($name, $db) {
        switch ($name) {
            case 'users':
                return [
                    'total_users'      => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users")['cnt'],
                    'active_users'     => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'")['cnt'],
                    'premium_users'    => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE subscription_status = 'active'")['cnt'],
                    'online_users'     => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE last_login_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)")['cnt'],
                    'locked_accounts'  => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE status = 'locked'")['cnt'],
                ];
            
            case 'subscriptions':
                return [
                    'active_subscriptions'   => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE subscription_status = 'active' AND subscription_expires_at > NOW()")['cnt'],
                    'trial_users'            => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE subscription_plan = 'trial'")['cnt'],
                    'expiring_soon'          => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE subscription_expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)")['cnt'],
                    'expired_subscriptions'  => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE subscription_expires_at < NOW() AND subscription_status = 'active'")['cnt'],
                ];
            
            case 'strategies':
                return [
                    'active_strategies'      => (int) $db->fetchOne("SELECT COUNT(DISTINCT strategy_key) as cnt FROM strategy_access")['cnt'],
                    'users_with_strategies'  => (int) $db->fetchOne("SELECT COUNT(DISTINCT user_id) as cnt FROM strategy_access")['cnt'],
                ];
            
            case 'trading':
                return [
                    'signals_today'          => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM grid_scalper_ma_signals WHERE DATE(created_at) = CURDATE()")['cnt'],
                    'trades_today'           => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM trade_outcomes WHERE DATE(created_at) = CURDATE()")['cnt'],
                    'wins_today'             => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM trade_outcomes WHERE DATE(created_at) = CURDATE() AND outcome = 'WIN'")['cnt'],
                    'losses_today'           => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM trade_outcomes WHERE DATE(created_at) = CURDATE() AND outcome = 'LOSS'")['cnt'],
                ];
            
            case 'win_rate':
                $result = $db->fetchOne("
                    SELECT 
                        COUNT(*) as total,
                        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins
                    FROM trade_outcomes
                    WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
                ");
                $total = (int) $result['total'];
                $wins = (int) $result['wins'];
                return [
                    'win_rate_30d' => $total > 0 ? round(($wins / $total) * 100, 2) : 0,
                    'trades_30d'   => $total,
                ];
            
            case 'telegram':
                return [
                    'telegram_linked'    => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM users WHERE telegram_user_id IS NOT NULL AND telegram_linked_at IS NOT NULL")['cnt'],
                    'telegram_messages_24h' => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM telegram_delivery_log WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)")['cnt'],
                    'telegram_failures'  => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM telegram_delivery_log WHERE status = 'failed' AND sent_at > DATE_SUB(NOW(), INTERVAL 7 DAY)")['cnt'],
                ];
            
            case 'system':
                return [
                    'total_signals'                => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM grid_scalper_ma_signals")['cnt'],
                    'total_trades'                 => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM trade_outcomes")['cnt'],
                    // Raw per-scope adaptive profiles (adaptive_profiles table)
                    'adaptive_profiles'            => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM adaptive_profiles")['cnt'],
                    // Cached aggregate learning profiles (adaptive_learning_profiles table) - distinct from the above
                    'adaptive_learning_profiles'   => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM adaptive_learning_profiles")['cnt'],
                    'adaptive_factor_stats'        => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM adaptive_factor_stats")['cnt'],
                    'adaptive_qualification_rules' => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM adaptive_qualification_rules")['cnt'],
                    'adaptive_trade_history'       => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM adaptive_trade_history")['cnt'],
                    'adaptive_signal_decisions'    => (int) $db->fetchOne("SELECT COUNT(*) as cnt FROM adaptive_signal_decisions")['cnt'],
                ];
            
            case 'trends':
                // Return actual historical data for the last 7 days instead of hardcoded synthetic data
                $signals7d = $db->fetchAll("
                    SELECT DATE(created_at) as day, COUNT(*) as cnt 
                    FROM grid_scalper_ma_signals 
                    WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
                    GROUP BY DATE(created_at)
                    ORDER BY day ASC
                ");
                
                $trades7d = $db->fetchAll("
                    SELECT DATE(created_at) as day, COUNT(*) as cnt 
                    FROM trade_outcomes 
                    WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
                    GROUP BY DATE(created_at)
                    ORDER BY day ASC
                ");
                
                $wins7d = $db->fetchAll("
                    SELECT DATE(created_at) as day, COUNT(*) as cnt 
                    FROM trade_outcomes 
                    WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) AND outcome = 'WIN'
                    GROUP BY DATE(created_at)
                    ORDER BY day ASC
                ");
                
                $users7d = $db->fetchAll("
                    SELECT DATE(created_at) as day, COUNT(*) as cnt 
                    FROM users 
                    WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
                    GROUP BY DATE(created_at)
                    ORDER BY day ASC
                ");
                
                // Fill gaps for missing days with 0
                $signals = array_map(function($r) { return (int) $r['cnt']; }, $signals7d);
                $trades = array_map(function($r) { return (int) $r['cnt']; }, $trades7d);
                $wins = array_map(function($r) { return (int) $r['cnt']; }, $wins7d);
                $users = array_map(function($r) { return (int) $r['cnt']; }, $users7d);
                
                return [
                    'signals' => $signals,
                    'trades' => $trades,
                    'wins' => $wins,
                    'users' => $users,
                ];
            
            default:
                return null;
        }
    }
    
    if ($metric) {
        // Return specific metric
        $data = getMetric($metric, $db);
        if ($data === null) {
            http_response_code(400);
            echo json_encode(['error' => 'Unknown metric: ' . htmlspecialchars($metric)]);
            exit;
        }
        
        // Diagnostic logging
        error_log("Dashboard GET metric=$metric, dataKeys=" . implode(',', array_keys($data)));
        
        echo json_encode($data);
    } else {
        // Return all metrics
        $allData = [
            'users'         => getMetric('users', $db),
            'subscriptions' => getMetric('subscriptions', $db),
            'strategies'    => getMetric('strategies', $db),
            'trading'       => getMetric('trading', $db),
            'win_rate'      => getMetric('win_rate', $db),
            'telegram'      => getMetric('telegram', $db),
            'system'        => getMetric('system', $db),
            'trends'        => getMetric('trends', $db),
        ];
        
        // Diagnostic logging
        error_log("Dashboard GET all metrics, keys=" . implode(',', array_keys($allData)) . 
                  ", trading_signals=" . ($allData['trading']['signals_today'] ?? 0) .
                  ", trends_signals_count=" . count($allData['trends']['signals'] ?? []));
        
        echo json_encode($allData);
    }
    
} catch (\Throwable $e) {
    http_response_code(500);
    error_log('Admin dashboard error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    echo json_encode(['error' => 'Dashboard failed: ' . $e->getMessage()]);
}
?>
