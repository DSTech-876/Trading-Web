<?php
/**
 * Admin Strategy Statistics API
 * Provides comprehensive statistics for each strategy
 * 
 * GET /api/admin/strategies/stats?strategy=grid_scalper_ma - Get strategy statistics
 * GET /api/admin/strategies/signals?strategy=grid_scalper_ma&page=1 - Get signals for strategy
 * GET /api/admin/strategies/performance - Get performance comparison across strategies
 */

header('Content-Type: application/json; charset=utf-8');

require_once(__DIR__ . '/../lib/Database.php');
require_once(__DIR__ . '/../lib/AuthGuard.php');

try {
    // Verify admin access
    $admin = AuthGuard::requireAdmin();
    $db = Database::getInstance();
    
    $action = $_GET['action'] ?? 'stats';
    
    if ($action === 'stats') {
        // Get statistics for a specific strategy
        $strategy = $_GET['strategy'] ?? 'grid_scalper_ma';
        
        // Filter by strategy
        $strategy_filter = " AND strategy_type = :strategy";
        $params = [':strategy' => $strategy];
        
        // Basic stats
        $total_signals = $db->fetchOne(
            "SELECT COUNT(*) as cnt FROM grid_scalper_ma_signals WHERE strategy_mode = :strategy",
            [':strategy' => $strategy]
        )['cnt'] ?? 0;
        
        $active_signals = $db->fetchOne(
            "SELECT COUNT(*) as cnt FROM grid_scalper_ma_signals WHERE strategy_mode = :strategy AND status = 'PENDING'",
            [':strategy' => $strategy]
        )['cnt'] ?? 0;
        
        $completed_signals = $db->fetchOne(
            "SELECT COUNT(*) as cnt FROM grid_scalper_ma_signals WHERE strategy_mode = :strategy AND status != 'PENDING'",
            [':strategy' => $strategy]
        )['cnt'] ?? 0;
        
        // Trade stats
        $trade_stats = $db->fetchOne("
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
                SUM(CASE WHEN outcome = 'BREAKEVEN' THEN 1 ELSE 0 END) as breakeven,
                AVG(CASE WHEN profit_loss_percent IS NOT NULL THEN profit_loss_percent ELSE NULL END) as avg_return,
                MAX(profit_loss_percent) as best_trade,
                MIN(profit_loss_percent) as worst_trade,
                SUM(CASE WHEN profit_loss_percent > 0 THEN 1 ELSE 0 END) as profitable_trades
            FROM trade_outcomes
            WHERE strategy_type = :strategy AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ", [':strategy' => $strategy]);
        
        // Today's stats
        $today_stats = $db->fetchOne("
            SELECT 
                COUNT(*) as trades_today,
                SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins_today,
                SUM(profit_loss_percent) as total_return_today
            FROM trade_outcomes
            WHERE strategy_type = :strategy AND DATE(created_at) = CURDATE()
        ", [':strategy' => $strategy]);
        
        // Win rate calculation
        $total_trades = (int) $trade_stats['total_trades'];
        $wins = (int) $trade_stats['wins'];
        $win_rate = $total_trades > 0 ? round(($wins / $total_trades) * 100, 2) : 0;
        
        // Top performers
        $top_symbols = $db->fetchAll("
            SELECT 
                symbol,
                COUNT(*) as trades,
                SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
                AVG(profit_loss_percent) as avg_return
            FROM trade_outcomes
            WHERE strategy_type = :strategy AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY symbol
            ORDER BY avg_return DESC
            LIMIT 5
        ", [':strategy' => $strategy]);

        $sl_then_tp = $db->fetchOne("
            SELECT
                SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS total_losses,
                SUM(CASE WHEN outcome = 'LOSS' AND sl_then_tp_flag = 1 THEN 1 ELSE 0 END) AS losses_then_tp,
                AVG(CASE WHEN outcome = 'LOSS' THEN sl_overshoot END) AS avg_sl_overshoot,
                AVG(CASE WHEN outcome = 'LOSS' AND sl_then_tp_flag = 1 THEN reversal_distance END) AS avg_reversal_distance,
                AVG(CASE WHEN outcome = 'LOSS' AND sl_then_tp_flag = 1 THEN tp_after_sl_seconds END) AS avg_time_to_reversal
            FROM trade_outcomes
            WHERE strategy_type = :strategy AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ", [':strategy' => $strategy]);

        $entry_quality_by_outcome = $db->fetchAll("
            SELECT
                outcome,
                COUNT(*) AS trades,
                AVG(entry_quality_score) AS avg_entry_quality
            FROM trade_outcomes
            WHERE strategy_type = :strategy
              AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
              AND entry_quality_score IS NOT NULL
              AND outcome IN ('WIN', 'LOSS')
            GROUP BY outcome
            ORDER BY outcome
        ", [':strategy' => $strategy]);

        $timing_patterns = $db->fetchAll("
            SELECT
                DAYNAME(COALESCE(entry_timestamp, created_at)) AS day_name,
                HOUR(COALESCE(entry_timestamp, created_at)) AS hour_of_day,
                COUNT(*) AS losses_then_tp
            FROM trade_outcomes
            WHERE strategy_type = :strategy
              AND DATE(COALESCE(entry_timestamp, created_at)) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
              AND sl_then_tp_flag = 1
            GROUP BY day_name, hour_of_day
            ORDER BY losses_then_tp DESC
            LIMIT 20
        ", [':strategy' => $strategy]);
        
        echo json_encode([
            'success' => true,
            'strategy' => $strategy,
            'signals' => [
                'total' => (int) $total_signals,
                'active' => (int) $active_signals,
                'completed' => (int) $completed_signals,
            ],
            'trades_30d' => [
                'total' => (int) $trade_stats['total_trades'],
                'wins' => (int) $trade_stats['wins'],
                'losses' => (int) $trade_stats['losses'],
                'breakeven' => (int) $trade_stats['breakeven'],
                'win_rate' => $win_rate,
                'avg_return' => round($trade_stats['avg_return'] ?? 0, 2),
                'best_trade' => round($trade_stats['best_trade'] ?? 0, 2),
                'worst_trade' => round($trade_stats['worst_trade'] ?? 0, 2),
                'profitable_trades' => (int) $trade_stats['profitable_trades'],
            ],
            'today' => [
                'trades' => (int) $today_stats['trades_today'],
                'wins' => (int) $today_stats['wins_today'],
                'total_return' => round($today_stats['total_return_today'] ?? 0, 2),
            ],
            'top_symbols' => array_map(function($s) {
                return [
                    'symbol' => $s['symbol'],
                    'trades' => (int) $s['trades'],
                    'wins' => (int) $s['wins'],
                    'avg_return' => round($s['avg_return'] ?? 0, 2)
                ];
            }, $top_symbols),
            'sl_then_tp_30d' => [
                'total_losses' => (int)($sl_then_tp['total_losses'] ?? 0),
                'losses_then_tp' => (int)($sl_then_tp['losses_then_tp'] ?? 0),
                'pct_losses_then_tp' => ((int)($sl_then_tp['total_losses'] ?? 0) > 0)
                    ? round(((int)$sl_then_tp['losses_then_tp'] / (int)$sl_then_tp['total_losses']) * 100, 2)
                    : 0,
                'avg_sl_overshoot' => round($sl_then_tp['avg_sl_overshoot'] ?? 0, 6),
                'avg_reversal_distance' => round($sl_then_tp['avg_reversal_distance'] ?? 0, 6),
                'avg_time_to_reversal_seconds' => round($sl_then_tp['avg_time_to_reversal'] ?? 0, 2),
            ],
            'entry_quality_30d' => array_map(function($row) {
                return [
                    'outcome' => $row['outcome'],
                    'trades' => (int)$row['trades'],
                    'avg_entry_quality' => round($row['avg_entry_quality'] ?? 0, 2),
                ];
            }, $entry_quality_by_outcome ?? []),
            'sl_then_tp_timing_patterns_30d' => array_map(function($row) {
                return [
                    'day' => $row['day_name'] ?? 'Unknown',
                    'hour' => isset($row['hour_of_day']) ? (int)$row['hour_of_day'] : null,
                    'count' => (int)($row['losses_then_tp'] ?? 0),
                ];
            }, $timing_patterns ?? [])
        ]);
    }
    elseif ($action === 'signals') {
        // Get signals for a specific strategy with pagination
        $strategy = $_GET['strategy'] ?? 'grid_scalper_ma';
        $page = (int) ($_GET['page'] ?? 1);
        $per_page = min(max((int) ($_GET['per_page'] ?? 50), 10), 500);
        $offset = ($page - 1) * $per_page;
        
        $total = (int) (($db->fetchOne(
            "SELECT COUNT(*) as cnt FROM grid_scalper_ma_signals WHERE strategy_mode = :strategy",
            [':strategy' => $strategy]
        )['cnt']) ?? 0);
        
        $signals = $db->fetchAll("
            SELECT id, user_id, signal_id, symbol, timeframe, direction, status,
                   entry_price, stop_loss, take_profit, entry_epoch, result_timestamp,
                   confluence_score, created_at
            FROM grid_scalper_ma_signals
            WHERE strategy_mode = :strategy
            ORDER BY created_at DESC
            LIMIT $per_page OFFSET $offset
        ", [
            ':strategy' => $strategy
        ]);
        
        echo json_encode([
            'success' => true,
            'strategy' => $strategy,
            'page' => $page,
            'per_page' => $per_page,
            'total' => (int) $total,
            'last_page' => max(1, ceil($total / $per_page)),
            'signals' => $signals
        ]);
    }
    elseif ($action === 'performance') {
        // Get performance comparison across all strategies
        $strategies = ['grid_scalper_ma', 'mtf', 'breakout_retest'];
        $results = [];
        
        foreach ($strategies as $strat) {
            $stats = $db->fetchOne("
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
                    AVG(profit_loss_percent) as avg_return
                FROM trade_outcomes
                WHERE strategy_type = :strategy AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            ", [':strategy' => $strat]);
            
            $total = (int) $stats['total'];
            $wins = (int) $stats['wins'];
            $win_rate = $total > 0 ? round(($wins / $total) * 100, 2) : 0;
            
            $results[] = [
                'strategy' => $strat,
                'trades_30d' => $total,
                'win_rate' => $win_rate,
                'avg_return' => round($stats['avg_return'] ?? 0, 2)
            ];
        }
        
        usort($results, fn($a, $b) => $b['win_rate'] <=> $a['win_rate']);
        
        echo json_encode([
            'success' => true,
            'strategies' => $results
        ]);
    }
    elseif ($action === 'trend') {
        // Real daily performance trend for a strategy over the last 30 days, grouped by week
        // (no synthetic/derived data - direct aggregation from trade_outcomes)
        $strategy = $_GET['strategy'] ?? 'grid_scalper_ma';
        $rows = $db->fetchAll("
            SELECT
                YEARWEEK(created_at, 3) as yw,
                MIN(DATE(created_at)) as week_start,
                COUNT(*) as total,
                SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
                AVG(profit_loss_percent) as avg_return
            FROM trade_outcomes
            WHERE strategy_type = :strategy AND created_at >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)
            GROUP BY yw
            ORDER BY yw ASC
        ", [':strategy' => $strategy]);

        $labels = [];
        $winRates = [];
        $avgReturns = [];
        $totals = [];
        foreach ($rows as $row) {
            $total = (int) $row['total'];
            $wins = (int) $row['wins'];
            $labels[] = $row['week_start'];
            $winRates[] = $total > 0 ? round(($wins / $total) * 100, 2) : 0;
            $avgReturns[] = round($row['avg_return'] ?? 0, 2);
            $totals[] = $total;
        }

        echo json_encode([
            'success' => true,
            'strategy' => $strategy,
            'labels' => $labels,
            'win_rate' => $winRates,
            'avg_return' => $avgReturns,
            'total_trades' => $totals
        ]);
    }
    else {
        http_response_code(400);
        echo json_encode(['error' => 'Unknown action: ' . htmlspecialchars($action)]);
    }
    
} catch (\Throwable $e) {
    error_log('Admin strategy_stats error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
?>
