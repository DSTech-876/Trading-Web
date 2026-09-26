<?php
/**
 * /api/lib/SchemaValidator.php
 * ────────────────────────────────────────────────────────────
 * Database schema validation to ensure all required tables and columns exist
 * Run on application startup or on-demand for troubleshooting
 */

declare(strict_types=1);

class SchemaValidator
{
    // Define all required tables and their critical columns
    private const REQUIRED_TABLES = [
        'users' => [
            'id', 'username', 'email', 'password_hash', 'role', 'status',
            'subscription_status', 'subscription_plan', 'telegram_user_id',
            'telegram_username', 'telegram_linked_at', 'created_at', 'updated_at'
        ],
        'strategy_access' => [
            'id', 'user_id', 'strategy_key', 'granted_at', 'granted_by'
        ],
        'indicator_profiles' => [
            'id', 'name', 'settings_json', 'created_by', 'is_admin_profile', 'created_at', 'updated_at'
        ],
        'user_profile_assignments' => [
            'id', 'user_id', 'profile_id', 'assigned_by', 'assigned_at'
        ],
        'user_notification_preferences' => [
            'id', 'user_id', 'telegram_trade_setup', 'telegram_trade_activation',
            'telegram_take_profit', 'telegram_stop_loss', 'telegram_trade_cancelled',
            'telegram_trade_expired', 'telegram_market_alerts', 'telegram_scanner_alerts'
        ],
        'telegram_delivery_log' => [
            'id', 'user_id', 'signal_id', 'notification_type', 'strategy',
            'symbol', 'status', 'telegram_response', 'error_detail', 'sent_at'
        ],
        'adaptive_factor_stats' => [
            'id', 'user_id', 'factor_key', 'market_category', 'strategy_key',
            'symbol_scope', 'wins', 'losses', 'cancelled', 'sample_size',
            'avg_r_multiple', 'confidence_score', 'base_weight', 'current_weight',
            'trend_direction', 'last_adjustment_reason', 'locked_by_admin',
            'locked_at', 'locked_by_user_id', 'locked_reason', 'created_at', 'updated_at'
        ],
        'adaptive_trade_history' => [
            'id', 'user_id', 'trade_id', 'symbol', 'market_category', 'strategy_key',
            'entry_price', 'exit_price', 'result', 'r_multiple', 'created_at'
        ],
        'adaptive_signal_decisions' => [
            'id', 'user_id', 'signal_id', 'symbol', 'market_category',
            'strategy_key', 'direction', 'signal_timestamp', 'telegram_action', 
            'qualification_band', 'signal_score', 'final_confidence_score', 'created_at'
        ],
        'adaptive_qualification_rules' => [
            'id', 'user_id', 'market_category', 'strategy_key', 'symbol_scope',
            'reject_below', 'watchlist_below', 'high_confidence_min',
            'min_sample_size', 'min_weight_adjustment_samples', 'max_weight_step',
            'base_weight_default', 'confidence_blend_signal', 'confidence_blend_history',
            'confidence_blend_market', 'confidence_blend_strategy', 'watchlist_sends_to_telegram',
            'enabled', 'created_at', 'updated_at'
        ],
        'adaptive_learning_profiles' => [
            'id', 'user_id', 'market_category', 'strategy_key', 'symbol_scope',
            'scope_type', 'trade_count', 'wins', 'losses', 'cancelled',
            'avg_r_multiple', 'confidence_score', 'created_at', 'updated_at'
        ],
        'trade_outcomes' => [
            'id', 'user_id', 'trade_id', 'strategy', 'entry_time', 'exit_time',
            'entry_price', 'exit_price', 'direction', 'outcome', 'r_multiple', 'created_at'
        ]
    ];

    /**
     * Validate the entire database schema
     * Returns an array of issues found, empty array if all is well
     *
     * @param PDO $pdo
     * @return array Array of error messages
     */
    public static function validate(PDO $pdo): array
    {
        $issues = [];
        
        foreach (self::REQUIRED_TABLES as $tableName => $requiredColumns) {
            // Check if table exists
            if (!self::tableExists($pdo, $tableName)) {
                $issues[] = "Table '{$tableName}' does not exist — run database/schema.sql";
                continue;
            }
            
            // Check if all required columns exist
            $existingColumns = self::getTableColumns($pdo, $tableName);
            $missingColumns = array_diff($requiredColumns, $existingColumns);
            
            if (!empty($missingColumns)) {
                $issues[] = "Table '{$tableName}' missing columns: " . implode(', ', $missingColumns);
            }
        }
        
        return $issues;
    }

    /**
     * Check if a table exists
     *
     * @param PDO $pdo
     * @param string $tableName
     * @return bool
     */
    private static function tableExists(PDO $pdo, string $tableName): bool
    {
        try {
            $stmt = $pdo->prepare('SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()');
            $stmt->execute([$tableName]);
            return (bool) $stmt->fetch();
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * Get all column names from a table
     *
     * @param PDO $pdo
     * @param string $tableName
     * @return array List of column names
     */
    private static function getTableColumns(PDO $pdo, string $tableName): array
    {
        try {
            $stmt = $pdo->prepare('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()');
            $stmt->execute([$tableName]);
            $results = $stmt->fetchAll() ?: [];
            return array_column($results, 'COLUMN_NAME');
        } catch (\Throwable $e) {
            return [];
        }
    }

    /**
     * Validate and report schema issues on startup
     * Logs warnings to error_log if issues are found
     *
     * @param PDO $pdo
     * @return bool True if schema is valid, false if issues found
     */
    public static function validateOnStartup(PDO $pdo): bool
    {
        $issues = self::validate($pdo);
        
        if (!empty($issues)) {
            $logMessage = "DATABASE SCHEMA VALIDATION FAILED:\n";
            foreach ($issues as $issue) {
                $logMessage .= "  - {$issue}\n";
            }
            $logMessage .= "\nTo fix, run: mysql -u <user> -p <database> < database/schema.sql";
            
            error_log("[SCHEMA VALIDATION] " . $logMessage);
            return false;
        }
        
        return true;
    }

    /**
     * Get a human-readable report of all schema issues
     *
     * @param PDO $pdo
     * @return array Report with 'valid' boolean and 'issues' array
     */
    public static function getReport(PDO $pdo): array
    {
        $issues = self::validate($pdo);
        
        return [
            'valid' => empty($issues),
            'timestamp' => gmdate('c'),
            'issues_count' => count($issues),
            'issues' => $issues,
            'recommendation' => empty($issues) 
                ? 'Schema is valid'
                : 'Run database/schema.sql to apply missing tables or columns',
        ];
    }
}
?>
