<?php

declare(strict_types=1);

const ADAPTIVE_MARKET_CATEGORIES = [
    'VOLATILITY_1S',
    'VOLATILITY_STANDARD',
    'BOOM_INDICES',
    'CRASH_INDICES',
    'JUMP_INDICES',
    'STEP_INDICES',
    'FOREX_MAJORS',
    'FOREX_CROSSES',
    'COMMODITIES',
];

const ADAPTIVE_FACTOR_ALIASES = [
    'EMA Aligned' => 'Trend Alignment',
    'EMA Alignment' => 'Trend Alignment',
    'HTF Trend' => 'MTF Confirmation',
    'HTF Trend Alignment' => 'MTF Confirmation',
    'HTF Breakout Confirmed' => 'Breakout Quality',
    'LTF Retest Completed' => 'Retest Quality',
    'MTF Bias Aligned' => 'MTF Confirmation',
    'Entry Pattern Trigger' => 'Structure Strength',
    'Market Structure Alignment' => 'Structure Strength',
    'MTF Structure' => 'MTF Confirmation',
    'Confirm Quality' => 'Structure Strength',
    'Confirm Pattern' => 'Structure Strength',
    'S/R Level' => 'Structure Strength',
    'Strong Breakout' => 'Breakout Quality',
    'Fib Level' => 'Retest Quality',
    'RSI Favors' => 'RSI Confirmation',
    'MACD Aligned' => 'MACD Confirmation',
    'Volume Spike' => 'Volume Confirmation',
    'ATR Volatility Acceptable' => 'ATR Confirmation',
    'Distance From Entry Within Threshold' => 'ATR Confirmation',
    'Active Session' => 'Session Timing',
    'ADX Strong' => 'Trend Strength',
    'Market Signal' => 'Market Regime',
    'Preferred Dir' => 'Trend Strength',
    'Momentum' => 'Momentum Score',
    'Momentum Confirmation' => 'Momentum Score',
    'Stoch Cross' => 'Momentum Score',
    'BB Squeeze' => 'Market Regime',
    'ATR Tolerance' => 'ATR Confirmation',
    'Trend Alignment' => 'Trend Alignment',
    'MTF Confirmation' => 'MTF Confirmation',
    'RSI Confirmation' => 'RSI Confirmation',
    'MACD Confirmation' => 'MACD Confirmation',
    'Structure Strength' => 'Structure Strength',
    'ATR Confirmation' => 'ATR Confirmation',
    'Breakout Quality' => 'Breakout Quality',
    'Retest Quality' => 'Retest Quality',
    'Volume Confirmation' => 'Volume Confirmation',
    'Session Timing' => 'Session Timing',
    'Trend Strength' => 'Trend Strength',
    'Market Regime' => 'Market Regime',
    'Momentum Score' => 'Momentum Score',
];

const ADAPTIVE_DEFAULT_FACTOR_WEIGHTS = [
    'Trend Alignment' => 5.00,
    'MTF Confirmation' => 6.00,
    'RSI Confirmation' => 5.00,
    'MACD Confirmation' => 5.00,
    'Structure Strength' => 5.00,
    'ATR Confirmation' => 4.00,
    'Breakout Quality' => 5.00,
    'Retest Quality' => 5.00,
    'Volume Confirmation' => 4.00,
    'Session Timing' => 4.00,
    'Trend Strength' => 5.00,
    'Market Regime' => 5.00,
    'Momentum Score' => 5.00,
];

function adaptiveAuthUserId(PDO $pdo): int
{
    $authHeader = $_SERVER['HTTP_AUTHORIZATION']
        ?? (function_exists('apache_request_headers') ? (apache_request_headers()['Authorization'] ?? '') : '');
    
    if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
        error_log(sprintf(
            '[%s] Adaptive auth failure: Missing or malformed Authorization header [%s %s from %s]',
            date('Y-m-d H:i:s'),
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'Authentication required'], 401);
    }
    
    $payload = jwtDecode($m[1]);
    if (!$payload || empty($payload['sub'])) {
        error_log(sprintf(
            '[%s] Adaptive auth failure: Invalid or expired token [%s %s from %s]',
            date('Y-m-d H:i:s'),
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'Invalid or expired token'], 401);
    }
    
    $stmt = $pdo->prepare('SELECT id, status FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([$payload['sub']]);
    $user = $stmt->fetch();
    
    if (!$user) {
        error_log(sprintf(
            '[%s] Adaptive auth failure: User not found (ID: %d) [%s %s from %s]',
            date('Y-m-d H:i:s'),
            (int) $payload['sub'],
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'User not found'], 401);
    }
    
    if (($user['status'] ?? 'active') === 'locked') {
        error_log(sprintf(
            '[%s] Adaptive auth failure: Account locked (ID: %d) [%s %s from %s]',
            date('Y-m-d H:i:s'),
            (int) $user['id'],
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Forbidden', 'code' => 403, 'message' => 'Account is locked'], 403);
    }
    
    return (int) $user['id'];
}

function adaptiveClamp(float $value, float $min, float $max): float
{
    return max($min, min($max, $value));
}

function adaptiveNormalizeCategory(?string $category, ?string $symbol = null, ?int $timeframeSec = null): string
{
    $candidate = strtoupper(trim((string) $category));
    if ($candidate !== '' && in_array($candidate, ADAPTIVE_MARKET_CATEGORIES, true)) {
        return $candidate;
    }

    $sym = strtoupper(trim((string) $symbol));
    $tf = max(0, (int) $timeframeSec);

    if (preg_match('/^1HZ/', $sym)) {
        return 'VOLATILITY_1S';
    }
    if (preg_match('/^R_/', $sym) || preg_match('/^RDBULL$|^RDBEAR$|^DEX|^DRIFTSWITCH/', $sym)) {
        return $tf <= 1 && $tf > 0 ? 'VOLATILITY_1S' : 'VOLATILITY_STANDARD';
    }
    if (preg_match('/^BOOM/', $sym)) {
        return 'BOOM_INDICES';
    }
    if (preg_match('/^CRASH/', $sym)) {
        return 'CRASH_INDICES';
    }
    if (preg_match('/^JD/', $sym)) {
        return 'JUMP_INDICES';
    }
    if (preg_match('/^STPRNG\d*$/', $sym)) {
        return 'STEP_INDICES';
    }
    if (preg_match('/^FRX(XAU|XAG|XPT|XPD)USD$/', $sym)) {
        return 'COMMODITIES';
    }
    if (preg_match('/^FRX(EURUSD|GBPUSD|USDJPY|AUDUSD|NZDUSD|USDCHF|USDCAD)$/', $sym)) {
        return 'FOREX_MAJORS';
    }
    if (preg_match('/^FRX[A-Z]{6}$/', $sym)) {
        return 'FOREX_CROSSES';
    }
    return 'VOLATILITY_STANDARD';
}

function adaptiveNormalizeRuleCategory(?string $category, ?string $symbol = null, ?int $timeframeSec = null): string
{
    $candidate = strtoupper(trim((string) $category));
    if ($candidate === '*') {
        return '*';
    }
    return adaptiveNormalizeCategory($category, $symbol, $timeframeSec);
}

function adaptiveNormalizeScopeValue(?string $value, string $fallback = '*'): string
{
    $trimmed = trim((string) $value);
    return $trimmed === '' ? $fallback : mb_substr($trimmed, 0, 64);
}

function adaptiveNormalizeDirection(?string $direction): string
{
    return match (strtoupper(trim((string) $direction))) {
        'BULL', 'BUY', 'LONG' => 'BULL',
        'BEAR', 'SELL', 'SHORT' => 'BEAR',
        default => 'NEUTRAL',
    };
}

function adaptiveNormalizeResult(?string $result): string
{
    $normalized = strtoupper(trim((string) $result));
    return in_array($normalized, ['WIN', 'LOSS', 'CANCELLED'], true) ? $normalized : 'CANCELLED';
}

function adaptiveNormalizeDbTimestamp(mixed $value, ?string $fallback = null): string
{
    $raw = trim((string) $value);
    if ($raw === '') {
        $raw = $fallback ?? gmdate('Y-m-d H:i:s');
    }

    $utc = new DateTimeZone('UTC');
    try {
        $dt = new DateTimeImmutable($raw, $utc);
    } catch (Throwable) {
        $dt = new DateTimeImmutable($fallback ?? 'now', $utc);
    }

    return $dt->setTimezone($utc)->format('Y-m-d H:i:s');
}

function adaptiveAcquireUserTradeLock(PDO $pdo, int $userId): void
{
    $stmt = $pdo->prepare('SELECT GET_LOCK(?, 10)');
    $stmt->execute(['adaptive_trade_user_' . $userId]);
    if ((int) $stmt->fetchColumn() !== 1) {
        throw new RuntimeException('Unable to acquire adaptive trade lock');
    }
}

function adaptiveReleaseUserTradeLock(PDO $pdo, int $userId): void
{
    try {
        $stmt = $pdo->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->execute(['adaptive_trade_user_' . $userId]);
    } catch (Throwable) {
    }
}

/**
 * @param mixed $factors
 * @return array<int,array<string,mixed>>
 */
function adaptiveNormalizeFactorDetails(mixed $factors, ?string $mtfStatus = null): array
{
    $items = is_array($factors) ? $factors : [];
    $normalized = [];
    foreach ($items as $factor) {
        if (is_array($factor)) {
            $label = trim((string) ($factor['factor'] ?? $factor['name'] ?? $factor['label'] ?? $factor['group'] ?? ''));
            $group = trim((string) ($factor['group'] ?? $factor['groupKey'] ?? $factor['factorGroup'] ?? $label));
            $passed = array_key_exists('passed', $factor) ? (bool) $factor['passed'] : true;
            $persist = array_key_exists('persist', $factor) ? (bool) $factor['persist'] : true;
            $normalized[] = [
                'factor' => $label,
                'group' => ADAPTIVE_FACTOR_ALIASES[$group] ?? ADAPTIVE_FACTOR_ALIASES[$label] ?? ($group !== '' ? $group : $label),
                'passed' => $passed,
                'weight' => isset($factor['weight']) ? (float) $factor['weight'] : (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[ADAPTIVE_FACTOR_ALIASES[$group] ?? ADAPTIVE_FACTOR_ALIASES[$label] ?? ($group !== '' ? $group : $label)] ?? 5.0),
                'score' => isset($factor['score']) ? (float) $factor['score'] : ($passed ? (float) ($factor['weight'] ?? (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[ADAPTIVE_FACTOR_ALIASES[$group] ?? ADAPTIVE_FACTOR_ALIASES[$label] ?? ($group !== '' ? $group : $label)] ?? 5.0)) : 0.0),
                'detail' => array_key_exists('detail', $factor) ? (string) $factor['detail'] : null,
                'persist' => $persist,
            ];
            continue;
        }
        $label = trim((string) $factor);
        if ($label === '') {
            continue;
        }
        $group = ADAPTIVE_FACTOR_ALIASES[$label] ?? $label;
        $normalized[] = [
            'factor' => $label,
            'group' => $group,
            'passed' => true,
            'weight' => (float) (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[$group] ?? 5.0),
            'score' => (float) (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[$group] ?? 5.0),
            'detail' => null,
            'persist' => true,
        ];
    }

    $mtf = strtoupper(trim((string) $mtfStatus));
    if (($mtf === 'CONFIRMED' || $mtf === 'PASS' || $mtf === 'TRUE')) {
        $hasMtf = false;
        foreach ($normalized as $row) {
            if (($row['group'] ?? '') === 'MTF Confirmation' && ($row['persist'] ?? true) && ($row['passed'] ?? true)) {
                $hasMtf = true;
                break;
            }
        }
        if (!$hasMtf) {
            $normalized[] = [
                'factor' => 'MTF Bias Aligned',
                'group' => 'MTF Confirmation',
                'passed' => true,
                'weight' => (float) (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS['MTF Confirmation'] ?? 6.0),
                'score' => (float) (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS['MTF Confirmation'] ?? 6.0),
                'detail' => null,
                'persist' => true,
            ];
        }
    }

    return $normalized;
}

/**
 * @param mixed $factors
 * @return array<int,string>
 */
function adaptiveNormalizeFactors(mixed $factors, ?string $mtfStatus = null): array
{
    $normalized = [];
    foreach (adaptiveNormalizeFactorDetails($factors, $mtfStatus) as $factor) {
        $group = trim((string) ($factor['group'] ?? ''));
        if ($group === '' || !($factor['persist'] ?? true) || !($factor['passed'] ?? true)) {
            continue;
        }
        $normalized[$group] = $group;
    }
    return array_values($normalized);
}

function adaptiveJsonEncode(mixed $value): string
{
    return (string) json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * @return array<string,mixed>
 */
function adaptiveDefaultRule(string $category = '*', string $strategy = '*', string $symbolScope = '*'): array
{
    return [
        'market_category' => $category,
        'strategy_key' => $strategy,
        'symbol_scope' => $symbolScope,
        'reject_below' => 65.00,
        'watchlist_below' => 80.00,
        'high_confidence_min' => 90.00,
        'min_sample_size' => 10,
        'min_weight_adjustment_samples' => 15,
        'max_weight_step' => 1.00,
        'base_weight_default' => 5.00,
        'confidence_blend_signal' => 0.30,
        'confidence_blend_history' => 0.30,
        'confidence_blend_market' => 0.20,
        'confidence_blend_strategy' => 0.20,
        'watchlist_sends_to_telegram' => 0,
        'enabled' => 1,
    ];
}

function adaptiveEnsureDefaultRules(PDO $pdo, int $userId): void
{
    $existing = (int) $pdo->query('SELECT COUNT(*) FROM adaptive_qualification_rules WHERE user_id = ' . (int) $userId)->fetchColumn();
    if ($existing > 0) {
        return;
    }

    $rows = [adaptiveDefaultRule('*', '*', '*')];
    foreach (ADAPTIVE_MARKET_CATEGORIES as $category) {
        $rows[] = adaptiveDefaultRule($category, '*', '*');
    }

    $stmt = $pdo->prepare(
        'INSERT INTO adaptive_qualification_rules
        (user_id, market_category, strategy_key, symbol_scope, reject_below, watchlist_below, high_confidence_min,
         min_sample_size, min_weight_adjustment_samples, max_weight_step, base_weight_default,
         confidence_blend_signal, confidence_blend_history, confidence_blend_market, confidence_blend_strategy,
         watchlist_sends_to_telegram, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE updated_at = updated_at'
    );

    foreach ($rows as $row) {
        $stmt->execute([
            $userId,
            $row['market_category'],
            $row['strategy_key'],
            $row['symbol_scope'],
            $row['reject_below'],
            $row['watchlist_below'],
            $row['high_confidence_min'],
            $row['min_sample_size'],
            $row['min_weight_adjustment_samples'],
            $row['max_weight_step'],
            $row['base_weight_default'],
            $row['confidence_blend_signal'],
            $row['confidence_blend_history'],
            $row['confidence_blend_market'],
            $row['confidence_blend_strategy'],
            $row['watchlist_sends_to_telegram'],
            $row['enabled'],
        ]);
    }
}

function adaptiveHealthScore(array $row): float
{
    $sample = max(0, (int) ($row['sample_size'] ?? (($row['wins'] ?? 0) + ($row['losses'] ?? 0))));
    $winRate = isset($row['win_rate']) ? (float) $row['win_rate'] : ($sample > 0 ? ((int) ($row['wins'] ?? 0) / max(1, $sample)) : 0.0);
    $avgR = isset($row['avg_r_multiple']) ? (float) $row['avg_r_multiple'] : 0.0;
    return ($avgR * 100.0) + ($winRate * 100.0) + min(25.0, $sample / 4.0);
}

function adaptiveLatestTimestamp(?string ...$values): ?string
{
    $latest = null;
    $latestTs = 0;
    foreach ($values as $value) {
        if ($value === null || trim($value) === '') {
            continue;
        }
        $ts = strtotime($value);
        if ($ts !== false && $ts >= $latestTs) {
            $latestTs = $ts;
            $latest = $value;
        }
    }
    return $latest;
}

const ADAPTIVE_PAGINATION_ALLOWED_SIZES = [10, 25, 50, 100];

/**
 * Extract normalized server-side pagination/sort/search parameters for a
 * given list prefix (e.g. "rules", "trades", "decisions", "audit") from the
 * incoming filter/query array. Keeps page size bounded to the supported
 * presets and sort column restricted to an allow-list to avoid SQL injection.
 *
 * @return array{0:int,1:int,2:string,3:string,4:string} [page, perPage, sortColumn, sortDir, search]
 */
function adaptivePaginationInput(array $filters, string $prefix, string $defaultSort, array $allowedSort): array
{
    $page = max(1, (int) ($filters[$prefix . '_page'] ?? 1));
    $perPage = (int) ($filters[$prefix . '_per_page'] ?? 25);
    if (!in_array($perPage, ADAPTIVE_PAGINATION_ALLOWED_SIZES, true)) {
        $perPage = 25;
    }
    $sortCol = (string) ($filters[$prefix . '_sort'] ?? $defaultSort);
    if (!in_array($sortCol, $allowedSort, true)) {
        $sortCol = $defaultSort;
    }
    $sortDir = strtolower((string) ($filters[$prefix . '_dir'] ?? 'desc')) === 'asc' ? 'ASC' : 'DESC';
    $search = trim((string) ($filters[$prefix . '_search'] ?? ''));
    return [$page, $perPage, $sortCol, $sortDir, $search];
}

/**
 * Build the pagination metadata block returned alongside a page of rows.
 */
function adaptiveBuildPageMeta(int $total, int $page, int $perPage): array
{
    $lastPage = max(1, (int) ceil($total / max(1, $perPage)));
    $page = min($page, $lastPage);
    return [
        'total' => $total,
        'page' => $page,
        'per_page' => $perPage,
        'last_page' => $lastPage,
    ];
}

/**
 * Run a paginated, sorted, optionally-searched SELECT against a table given
 * an existing WHERE clause/params, returning rows + pagination metadata.
 * $searchColumns lists columns eligible for the free-text LIKE search.
 */
function adaptiveFetchPaginated(
    PDO $pdo,
    string $table,
    array $whereClauses,
    array $whereParams,
    array $filters,
    string $prefix,
    string $defaultSort,
    array $allowedSort,
    array $searchColumns,
    string $columns = '*'
): array {
    [$page, $perPage, $sortCol, $sortDir, $search] = adaptivePaginationInput($filters, $prefix, $defaultSort, $allowedSort);

    $clauses = $whereClauses;
    $params = $whereParams;
    if ($search !== '' && $searchColumns) {
        $likeParts = [];
        $like = '%' . $search . '%';
        foreach ($searchColumns as $col) {
            $likeParts[] = "$col LIKE ?";
            $params[] = $like;
        }
        $clauses[] = '(' . implode(' OR ', $likeParts) . ')';
    }
    $whereSql = $clauses ? ('WHERE ' . implode(' AND ', $clauses)) : '';

    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM {$table} {$whereSql}");
    $countStmt->execute($params);
    $total = (int) $countStmt->fetchColumn();

    $meta = adaptiveBuildPageMeta($total, $page, $perPage);
    $offset = ($meta['page'] - 1) * $perPage;

    $rowsStmt = $pdo->prepare(
        "SELECT {$columns} FROM {$table} {$whereSql} ORDER BY {$sortCol} {$sortDir} LIMIT {$perPage} OFFSET {$offset}"
    );
    $rowsStmt->execute($params);
    $rows = $rowsStmt->fetchAll();

    return ['rows' => $rows] + $meta;
}

const ADAPTIVE_LEARNING_ACTIVE_MIN_TRADES = 10;
const ADAPTIVE_LEARNING_MATURE_MIN_TRADES = 20;
const ADAPTIVE_CLIENT_TRUST_PROMOTION_WINDOW_SECONDS = 21600;

function adaptiveLearningStatusCode(int $tradeCount, int $lockedFactorCount, int $factorCount = 0): string
{
    if ($tradeCount <= 0) {
        return 'NOT_STARTED';
    }
    if ($lockedFactorCount > 0) {
        if ($factorCount > $lockedFactorCount) {
            return 'MIXED';
        }
        return 'LOCKED';
    }
    if ($tradeCount < ADAPTIVE_LEARNING_ACTIVE_MIN_TRADES) {
        return 'LEARNING';
    }
    if ($tradeCount < ADAPTIVE_LEARNING_MATURE_MIN_TRADES) {
        return 'ACTIVE';
    }
    return 'MATURE';
}

function adaptiveLearningStatusLabel(string $code): string
{
    return match ($code) {
        'LOCKED' => 'Locked',
        'MIXED' => 'Mixed',
        'LEARNING' => 'Learning',
        'ACTIVE' => 'Active',
        'MATURE' => 'Mature',
        'AUTO_LEARNING' => 'Auto Learning',
        default => 'Not Started',
    };
}

/**
 * @param array<int,array<string,mixed>> $users
 * @return array<int,array<string,mixed>>
 */
function adaptiveHydrateUserSummaries(PDO $pdo, array $users): array
{
    if (!$users) {
        return [];
    }

    $ids = array_map(static fn(array $row): int => (int) $row['id'], $users);
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $summaryById = [];

    foreach ($users as $user) {
        $id = (int) $user['id'];
        $summaryById[$id] = [
            'user_id' => $id,
            'name' => (string) ($user['display_name'] ?? $user['username']),
            'username' => (string) $user['username'],
            'email' => $user['email'] ?? null,
            'subscription_plan' => $user['subscription_plan'] ?? null,
            'subscription_status' => $user['subscription_status'] ?? 'inactive',
            'status' => $user['status'] ?? 'active',
            'assigned_strategies' => [],
            'assigned_adaptive_profiles' => 0,
            'learning_profile_count' => 0,
            'market_categories_enabled' => [],
            'learning_status' => 'Not Started',
            'learning_status_code' => 'NOT_STARTED',
            'last_updated' => $user['updated_at'] ?? $user['created_at'] ?? null,
            'active_confidence_threshold' => 90.0,
            'telegram_qualification_threshold' => 80.0,
            'rule_count' => 0,
            'enabled_rule_count' => 0,
            'factor_count' => 0,
            'locked_factor_count' => 0,
            'trade_count' => 0,
            'wins' => 0,
            'losses' => 0,
            'win_rate' => 0.0,
            'avg_r_multiple' => null,
            'avg_confidence' => null,
        ];
    }

    $st = $pdo->prepare("SELECT user_id, strategy_key FROM strategy_access WHERE user_id IN ($placeholders) ORDER BY strategy_key");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $summaryById[(int) $row['user_id']]['assigned_strategies'][] = (string) $row['strategy_key'];
    }

    $st = $pdo->prepare("SELECT user_id, COUNT(*) AS profile_count, MAX(updated_at) AS updated_at FROM adaptive_profiles WHERE user_id IN ($placeholders) GROUP BY user_id");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $id = (int) $row['user_id'];
        $summaryById[$id]['assigned_adaptive_profiles'] = (int) $row['profile_count'];
        $summaryById[$id]['last_updated'] = adaptiveLatestTimestamp($summaryById[$id]['last_updated'], $row['updated_at'] ?? null);
    }

    $st = $pdo->prepare("SELECT user_id, COUNT(*) AS learning_profile_count, MAX(updated_at) AS updated_at FROM adaptive_learning_profiles WHERE user_id IN ($placeholders) GROUP BY user_id");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $id = (int) $row['user_id'];
        $summaryById[$id]['learning_profile_count'] = (int) $row['learning_profile_count'];
        $summaryById[$id]['last_updated'] = adaptiveLatestTimestamp($summaryById[$id]['last_updated'], $row['updated_at'] ?? null);
    }

    $st = $pdo->prepare("SELECT user_id, COUNT(*) AS trade_count, SUM(result = 'WIN') AS wins, SUM(result = 'LOSS') AS losses, AVG(CASE WHEN result IN ('WIN','LOSS') THEN r_multiple END) AS avg_r_multiple, AVG(confidence_score) AS avg_confidence, MAX(updated_at) AS updated_at FROM adaptive_trade_history WHERE user_id IN ($placeholders) AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, '$.trust_source')), '') <> 'UNTRUSTED_CLIENT_REPORTED' GROUP BY user_id");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $id = (int) $row['user_id'];
        $wins = (int) ($row['wins'] ?? 0);
        $losses = (int) ($row['losses'] ?? 0);
        $sample = $wins + $losses;
        $summaryById[$id]['trade_count'] = (int) ($row['trade_count'] ?? 0);
        $summaryById[$id]['wins'] = $wins;
        $summaryById[$id]['losses'] = $losses;
        $summaryById[$id]['win_rate'] = $sample > 0 ? round(($wins / $sample) * 100, 1) : 0.0;
        $summaryById[$id]['avg_r_multiple'] = $row['avg_r_multiple'] !== null ? round((float) $row['avg_r_multiple'], 2) : null;
        $summaryById[$id]['avg_confidence'] = $row['avg_confidence'] !== null ? round((float) $row['avg_confidence'], 1) : null;
        $summaryById[$id]['last_updated'] = adaptiveLatestTimestamp($summaryById[$id]['last_updated'], $row['updated_at'] ?? null);
    }

    $st = $pdo->prepare("SELECT user_id, COUNT(*) AS factor_count, SUM(locked_by_admin = 1) AS locked_factor_count, MAX(updated_at) AS updated_at FROM adaptive_factor_stats WHERE user_id IN ($placeholders) GROUP BY user_id");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $id = (int) $row['user_id'];
        $summaryById[$id]['factor_count'] = (int) ($row['factor_count'] ?? 0);
        $summaryById[$id]['locked_factor_count'] = (int) ($row['locked_factor_count'] ?? 0);
        $summaryById[$id]['last_updated'] = adaptiveLatestTimestamp($summaryById[$id]['last_updated'], $row['updated_at'] ?? null);
    }

    $st = $pdo->prepare("SELECT user_id, COUNT(*) AS rule_count, SUM(enabled = 1) AS enabled_rule_count, MAX(CASE WHEN market_category = '*' AND strategy_key = '*' AND symbol_scope = '*' THEN high_confidence_min END) AS active_confidence_threshold, MAX(CASE WHEN market_category = '*' AND strategy_key = '*' AND symbol_scope = '*' THEN watchlist_below END) AS telegram_qualification_threshold, MAX(updated_at) AS updated_at FROM adaptive_qualification_rules WHERE user_id IN ($placeholders) GROUP BY user_id");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $id = (int) $row['user_id'];
        $summaryById[$id]['rule_count'] = (int) ($row['rule_count'] ?? 0);
        $summaryById[$id]['enabled_rule_count'] = (int) ($row['enabled_rule_count'] ?? 0);
        if ($row['active_confidence_threshold'] !== null) {
            $summaryById[$id]['active_confidence_threshold'] = round((float) $row['active_confidence_threshold'], 1);
        }
        if ($row['telegram_qualification_threshold'] !== null) {
            $summaryById[$id]['telegram_qualification_threshold'] = round((float) $row['telegram_qualification_threshold'], 1);
        }
        $summaryById[$id]['last_updated'] = adaptiveLatestTimestamp($summaryById[$id]['last_updated'], $row['updated_at'] ?? null);
    }

    $st = $pdo->prepare("SELECT user_id, market_category FROM adaptive_qualification_rules WHERE user_id IN ($placeholders) AND enabled = 1 AND market_category <> '*' GROUP BY user_id, market_category ORDER BY market_category");
    $st->execute($ids);
    foreach ($st->fetchAll() as $row) {
        $summaryById[(int) $row['user_id']]['market_categories_enabled'][] = (string) $row['market_category'];
    }

    foreach ($summaryById as &$summary) {
        $statusCode = adaptiveLearningStatusCode((int) $summary['trade_count'], (int) $summary['locked_factor_count'], (int) $summary['factor_count']);
        $summary['learning_status_code'] = $statusCode;
        $summary['learning_status'] = adaptiveLearningStatusLabel($statusCode);
    }
    unset($summary);

    return array_values($summaryById);
}

/**
 * @return array<string,mixed>
 */
function adaptiveListUserIntelligenceProfiles(PDO $pdo, array $filters = []): array
{
    $page = max(1, (int) ($filters['page'] ?? 1));
    $perPage = min(50, max(5, (int) ($filters['per_page'] ?? 10)));
    $offset = ($page - 1) * $perPage;
    $search = trim((string) ($filters['search'] ?? ''));
    $status = trim((string) ($filters['status'] ?? ''));
    $plan = trim((string) ($filters['plan'] ?? ''));
    $category = trim((string) ($filters['market_category'] ?? ''));
    $learningStatus = trim((string) ($filters['learning_status'] ?? ''));
    $sortKey = trim((string) ($filters['sort_key'] ?? 'name'));
    $sortDirection = strtolower(trim((string) ($filters['sort_direction'] ?? 'asc'))) === 'desc' ? 'DESC' : 'ASC';

    $baseWhere = [];
    $params = [];
    if ($search !== '') {
        $like = '%' . $search . '%';
        $baseWhere[] = '(__USER__.username LIKE ? OR __USER__.display_name LIKE ? OR __USER__.email LIKE ?)';
        array_push($params, $like, $like, $like);
    }
    if (in_array($status, ['active', 'locked'], true)) {
        $baseWhere[] = '__USER__.status = ?';
        $params[] = $status;
    }
    if (in_array($plan, ['trial', 'weekly', 'monthly'], true)) {
        $baseWhere[] = '__USER__.subscription_plan = ?';
        $params[] = $plan;
    }
    if ($category !== '') {
        $baseWhere[] = "EXISTS (SELECT 1 FROM adaptive_qualification_rules ar WHERE ar.user_id = __USER__.id AND ar.enabled = 1 AND ar.market_category IN (?, '*'))";
        $params[] = strtoupper($category);
    }
    $applyUserAlias = static function (array $clauses, string $alias): array {
        return array_map(static fn(string $clause): string => str_replace('__USER__', $alias, $clause), $clauses);
    };
    $trustedTradeFilterSql = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ath.notes_json, '$.trust_source')), '') <> 'UNTRUSTED_CLIENT_REPORTED'";
    $trustedTradeCountColumn = 'COALESCE(ath_counts.trusted_trade_count, 0)';
    $factorRowCountColumn = 'COALESCE(afs_counts.factor_row_count, 0)';
    $lockedFactorCountColumn = 'COALESCE(afs_counts.locked_factor_count, 0)';
    $unlockedFactorCountColumn = 'COALESCE(afs_counts.unlocked_factor_count, 0)';
    $learningWhere = [];
    $learningStatusJoinSql = '';
    $queryParams = $params;
    if ($learningStatus !== '') {
        $tradeScopedBaseWhere = $baseWhere ? ' AND ' . implode(' AND ', $applyUserAlias($baseWhere, 'u_filter')) : '';
        $factorScopedBaseWhere = $baseWhere ? ' WHERE ' . implode(' AND ', $applyUserAlias($baseWhere, 'u_factor_filter')) : '';
        $learningStatusJoinSql =
            " LEFT JOIN (SELECT ath.user_id, COUNT(*) AS trusted_trade_count FROM adaptive_trade_history ath INNER JOIN users u_filter ON u_filter.id = ath.user_id WHERE $trustedTradeFilterSql$tradeScopedBaseWhere GROUP BY ath.user_id) ath_counts ON ath_counts.user_id = u.id" .
            " LEFT JOIN (SELECT afs.user_id, COUNT(*) AS factor_row_count, SUM(afs.locked_by_admin = 1) AS locked_factor_count, SUM(afs.locked_by_admin = 0) AS unlocked_factor_count FROM adaptive_factor_stats afs INNER JOIN users u_factor_filter ON u_factor_filter.id = afs.user_id$factorScopedBaseWhere GROUP BY afs.user_id) afs_counts ON afs_counts.user_id = u.id";
        $queryParams = array_merge($params, $params, $params);
    }
    if ($learningStatus === 'NOT_STARTED') {
        $learningWhere[] = "$trustedTradeCountColumn = 0";
    } elseif ($learningStatus === 'LEARNING') {
        $learningWhere[] = "$trustedTradeCountColumn >= 1";
        $learningWhere[] = "$trustedTradeCountColumn < " . ADAPTIVE_LEARNING_ACTIVE_MIN_TRADES;
        $learningWhere[] = "$lockedFactorCountColumn = 0";
    } elseif ($learningStatus === 'ACTIVE') {
        $learningWhere[] = "$trustedTradeCountColumn >= " . ADAPTIVE_LEARNING_ACTIVE_MIN_TRADES;
        $learningWhere[] = "$trustedTradeCountColumn < " . ADAPTIVE_LEARNING_MATURE_MIN_TRADES;
        $learningWhere[] = "$lockedFactorCountColumn = 0";
    } elseif ($learningStatus === 'MATURE') {
        $learningWhere[] = "$trustedTradeCountColumn >= " . ADAPTIVE_LEARNING_MATURE_MIN_TRADES;
        $learningWhere[] = "$lockedFactorCountColumn = 0";
    } elseif ($learningStatus === 'AUTO_LEARNING') {
        $learningWhere[] = "$trustedTradeCountColumn >= 1";
        $learningWhere[] = "$lockedFactorCountColumn = 0";
    } elseif ($learningStatus === 'LOCKED') {
        $learningWhere[] = "$factorRowCountColumn >= 1";
        $learningWhere[] = "$trustedTradeCountColumn >= 1";
        $learningWhere[] = "$lockedFactorCountColumn >= 1";
        $learningWhere[] = "$unlockedFactorCountColumn = 0";
    } elseif ($learningStatus === 'MIXED') {
        $learningWhere[] = "$factorRowCountColumn >= 1";
        $learningWhere[] = "$trustedTradeCountColumn >= 1";
        $learningWhere[] = "$lockedFactorCountColumn >= 1";
        $learningWhere[] = "$unlockedFactorCountColumn >= 1";
    }

    $where = array_merge($applyUserAlias($baseWhere, 'u'), $learningWhere);
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $count = $pdo->prepare("SELECT COUNT(*) FROM users u$learningStatusJoinSql $whereSql");
    $count->execute($queryParams);
    $total = (int) $count->fetchColumn();

    $sortMap = [
        'name' => 'COALESCE(u.display_name, u.username)',
        'subscription_plan' => "COALESCE(u.subscription_plan, '')",
        'status' => "COALESCE(u.status, '')",
    ];
    $sortColumn = $sortMap[$sortKey] ?? $sortMap['name'];
    $stmt = $pdo->prepare("SELECT u.id, u.username, u.display_name, u.email, u.subscription_plan, u.subscription_status, u.status, u.updated_at, u.created_at FROM users u$learningStatusJoinSql $whereSql ORDER BY $sortColumn $sortDirection, COALESCE(u.display_name, u.username) ASC, u.id DESC LIMIT ? OFFSET ?");
    $stmt->execute(array_merge($queryParams, [$perPage, $offset]));
    $users = $stmt->fetchAll();
    $rows = adaptiveHydrateUserSummaries($pdo, $users);

    return [
        'rows' => $rows,
        'page' => $page,
        'per_page' => $perPage,
        'total' => $total,
        'last_page' => (int) max(1, ceil($total / $perPage)),
    ];
}

/**
 * @return array<int,array<string,mixed>>
 */
function adaptiveExportUserTrades(PDO $pdo, int $userId, array $filters = []): array
{
    $where = ['user_id = ?'];
    $params = [$userId];

    $category = trim((string) ($filters['market_category'] ?? ''));
    if ($category !== '') {
        $where[] = "market_category IN (?, '*')";
        $params[] = strtoupper($category);
    }
    $strategy = trim((string) ($filters['strategy_key'] ?? ''));
    if ($strategy !== '') {
        $where[] = 'strategy_key = ?';
        $params[] = $strategy;
    }
    $symbol = trim((string) ($filters['symbol'] ?? ''));
    if ($symbol !== '') {
        $where[] = 'symbol = ?';
        $params[] = $symbol;
    }

    /* This export is the full audit-trail for a user's adaptive trade history, so it must include
     * every recorded trade — including untrusted client-reported ones that did not contribute to
     * learning aggregates — each explicitly labeled with a `trusted` flag rather than silently
     * dropped, so an inspector can always tell which trades counted toward adaptive learning. */
    $stmt = $pdo->prepare('SELECT * FROM adaptive_trade_history WHERE ' . implode(' AND ', $where) . ' ORDER BY created_at DESC, id DESC');
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    return array_map(static function (array $row): array {
        $row['confluence_factors_present'] = json_decode((string) ($row['confluence_factors_json'] ?? ''), true) ?: [];
        $row['confluence_factors_raw'] = json_decode((string) ($row['confluence_factors_raw_json'] ?? ''), true) ?: [];
        $row['notes'] = json_decode((string) ($row['notes_json'] ?? ''), true) ?: [];
        $row['trusted'] = ($row['notes']['trust_source'] ?? null) !== 'UNTRUSTED_CLIENT_REPORTED';
        unset($row['id'], $row['user_id'], $row['confluence_factors_json'], $row['confluence_factors_raw_json'], $row['notes_json'], $row['created_at'], $row['updated_at']);
        return $row;
    }, $rows);
}

/**
 * @return array<string,mixed>
 */
function adaptiveResolveRule(PDO $pdo, int $userId, string $category, string $strategy, string $symbolScope): array
{
    adaptiveEnsureDefaultRules($pdo, $userId);

    $stmt = $pdo->prepare(
        'SELECT *
           FROM adaptive_qualification_rules
          WHERE user_id = ?
            AND enabled = 1
            AND market_category IN (?, ?)
            AND strategy_key IN (?, ?)
            AND symbol_scope IN (?, ?)
          ORDER BY
            (market_category = ?) DESC,
            (symbol_scope = ?) DESC,
           (strategy_key = ?) DESC,
            updated_at DESC
          LIMIT 1'
    );
    $stmt->execute([$userId, $category, '*', $strategy, '*', $symbolScope, '*', $category, $symbolScope, $strategy]);
    $row = $stmt->fetch();
    return is_array($row) ? $row : adaptiveDefaultRule($category, $strategy, $symbolScope);
}

function adaptiveConfidenceFromStats(int $sampleSize, float $winRate, float $avgR): float
{
    $sampleScore = adaptiveClamp($sampleSize / 50.0, 0.0, 1.0);
    $winScore = adaptiveClamp($winRate, 0.0, 1.0);
    $expectancyScore = adaptiveClamp(($avgR + 1.0) / 3.0, 0.0, 1.0);
    return round((($sampleScore * 0.45) + ($winScore * 0.35) + ($expectancyScore * 0.20)) * 100, 2);
}

function adaptiveReliabilityFromProfile(?array $profile): float
{
    if (!$profile) {
        return 50.0;
    }
    $winRate = isset($profile['win_rate']) ? (float) $profile['win_rate'] : 0.0;
    $avgR = isset($profile['avg_r_multiple']) ? (float) $profile['avg_r_multiple'] : 0.0;
    $confidence = isset($profile['confidence_score']) ? (float) $profile['confidence_score'] : 0.0;
    return round(adaptiveClamp(($winRate * 100.0 * 0.60) + (adaptiveClamp(($avgR + 1.0) / 3.0, 0.0, 1.0) * 20.0) + ($confidence * 0.20), 0.0, 100.0), 2);
}

/**
 * @return array<int,array<string,string>>
 */
function adaptiveBuildScopes(string $category, string $strategy, string $symbol): array
{
    return [
        ['scope_type' => 'category', 'market_category' => $category, 'strategy_key' => '*', 'symbol_scope' => '*'],
        ['scope_type' => 'strategy', 'market_category' => $category, 'strategy_key' => $strategy, 'symbol_scope' => '*'],
        ['scope_type' => 'symbol', 'market_category' => $category, 'strategy_key' => $strategy, 'symbol_scope' => $symbol],
    ];
}

/**
 * @return array<string,mixed>
 */
function adaptiveNormalizeTradePayload(array $body, bool $allowCategoryOverride = false): array
{
    $symbol = adaptiveNormalizeScopeValue($body['symbol'] ?? '', '');
    if ($symbol === '') {
        throw new InvalidArgumentException('symbol is required');
    }

    $strategy = adaptiveNormalizeScopeValue($body['strategy'] ?? $body['strategy_key'] ?? $body['strategyName'] ?? '', 'breakout_retest');
    $symbolScope = adaptiveNormalizeScopeValue($symbol, '*');
    $timeframeSec = max(1, (int) ($body['timeframe_sec'] ?? $body['timeframeSec'] ?? 60));
    $derivedCategory = adaptiveNormalizeCategory(null, $symbol, $timeframeSec);
    $category = $allowCategoryOverride
        ? adaptiveNormalizeCategory($body['market_category'] ?? null, $symbol, $timeframeSec)
        : $derivedCategory;
    $signalId = trim((string) ($body['signal_id'] ?? $body['signalId'] ?? ''));
    $tradeId = trim((string) ($body['trade_id'] ?? $body['tradeId'] ?? ''));
    if ($tradeId === '') {
        $tradeId = $signalId !== ''
            ? 'trade_' . preg_replace('/[^A-Za-z0-9_\-]/', '_', $signalId)
            : 'trade_' . hash('sha256', $symbol . '|' . $strategy . '|' . ($body['signal_timestamp'] ?? $body['created_at'] ?? microtime(true)));
    }

    $entry = isset($body['entry_price']) ? (float) $body['entry_price'] : (isset($body['entry']) ? (float) $body['entry'] : null);
    $sl = isset($body['stop_loss']) ? (float) $body['stop_loss'] : (isset($body['sl']) ? (float) $body['sl'] : null);
    $tp = isset($body['take_profit']) ? (float) $body['take_profit'] : (isset($body['tp']) ? (float) $body['tp'] : null);
    $exitPrice = isset($body['exit_price']) ? (float) $body['exit_price'] : null;
    $result = adaptiveNormalizeResult($body['result'] ?? null);
    $direction = adaptiveNormalizeDirection($body['direction'] ?? $body['dir'] ?? null);
    $mtfStatus = strtoupper(trim((string) ($body['mtf_status'] ?? $body['mtfStatus'] ?? 'UNKNOWN')));
    $factorsRaw = is_array($body['confluence_factors_raw'] ?? null)
        ? $body['confluence_factors_raw']
        : (is_array($body['confluenceFactorsRaw'] ?? null)
            ? $body['confluenceFactorsRaw']
            : (is_array($body['factor_details'] ?? null)
                ? $body['factor_details']
                : (is_array($body['factorDetails'] ?? null)
                    ? $body['factorDetails']
                    : (is_array($body['confluence_factors_present'] ?? null)
                        ? $body['confluence_factors_present']
                        : (is_array($body['confluenceFactorsPresent'] ?? null) ? $body['confluenceFactorsPresent'] : [])))));
    $factorDetails = adaptiveNormalizeFactorDetails($factorsRaw, $mtfStatus);
    $factors = adaptiveNormalizeFactors($factorDetails, $mtfStatus);

    return [
        'trade_id' => mb_substr($tradeId, 0, 100),
        'signal_id' => $signalId !== '' ? mb_substr($signalId, 0, 100) : null,
        'symbol' => $symbol,
        'market_category' => $category,
        'strategy_key' => $strategy,
        'direction' => $direction,
        'signal_timestamp' => adaptiveNormalizeDbTimestamp($body['signal_timestamp'] ?? $body['signalTimestamp'] ?? null),
        'entry_timestamp' => adaptiveNormalizeDbTimestamp($body['entry_timestamp'] ?? $body['entryTimestamp'] ?? $body['signal_timestamp'] ?? $body['signalTimestamp'] ?? null),
        'exit_timestamp' => adaptiveNormalizeDbTimestamp($body['exit_timestamp'] ?? $body['exitTimestamp'] ?? null),
        'entry_price' => $entry,
        'stop_loss' => $sl,
        'take_profit' => $tp,
        'exit_price' => $exitPrice,
        'result' => $result,
        'r_multiple' => isset($body['r_multiple']) ? (float) $body['r_multiple'] : (isset($body['rMultiple']) ? (float) $body['rMultiple'] : null),
        'profit_points' => isset($body['profit_points']) ? (float) $body['profit_points'] : (isset($body['profitPoints']) ? (float) $body['profitPoints'] : null),
        'telegram_sent' => !empty($body['telegram_sent']) || !empty($body['telegramSent']) ? 1 : 0,
        'telegram_decision' => adaptiveNormalizeScopeValue($body['telegram_decision'] ?? $body['telegramDecision'] ?? 'UNKNOWN', 'UNKNOWN'),
        'confidence_score' => isset($body['confidence_score']) ? (float) $body['confidence_score'] : (isset($body['confidenceScore']) ? (float) $body['confidenceScore'] : null),
        'signal_score' => isset($body['signal_score']) ? (float) $body['signal_score'] : (isset($body['signalScore']) ? (float) $body['signalScore'] : null),
        'historical_reliability_score' => isset($body['historical_reliability_score']) ? (float) $body['historical_reliability_score'] : (isset($body['historicalReliabilityScore']) ? (float) $body['historicalReliabilityScore'] : null),
        'market_category_score' => isset($body['market_category_score']) ? (float) $body['market_category_score'] : (isset($body['marketCategoryScore']) ? (float) $body['marketCategoryScore'] : null),
        'strategy_reliability_score' => isset($body['strategy_reliability_score']) ? (float) $body['strategy_reliability_score'] : (isset($body['strategyReliabilityScore']) ? (float) $body['strategyReliabilityScore'] : null),
        'qualification_band' => adaptiveNormalizeScopeValue($body['qualification_band'] ?? $body['qualificationBand'] ?? 'UNQUALIFIED', 'UNQUALIFIED'),
        'confluence_factors_present' => $factors,
        'has_raw_factor_details' => count($factorsRaw) > 0,
        'confluence_factors_raw' => $factorDetails,
        'mtf_status' => mb_substr($mtfStatus === '' ? 'UNKNOWN' : $mtfStatus, 0, 32),
        'timeframe_sec' => $timeframeSec,
        'strategy_label' => adaptiveNormalizeScopeValue($body['strategy_label'] ?? $body['strategyLabel'] ?? $strategy, $strategy),
        'notes_json' => is_array($body['notes'] ?? null) ? $body['notes'] : [],
    ];
}

function adaptiveCanTrustClientTrade(PDO $pdo, int $userId, array $trade): bool
{
    $signalId = trim((string) ($trade['signal_id'] ?? ''));
    if ($signalId === '') {
        return false;
    }
    $symbol = adaptiveNormalizeScopeValue($trade['symbol'] ?? '', '');
    $strategy = adaptiveNormalizeScopeValue($trade['strategy_key'] ?? '', '');
    if ($symbol === '' || $strategy === '') {
        return false;
    }
    $stmt = $pdo->prepare(
        'SELECT 1 FROM adaptive_signal_decisions
         WHERE user_id = ? AND signal_id = ? AND symbol = ? AND strategy_key = ?
           AND created_at IS NOT NULL
           AND TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP()) BETWEEN 0 AND ?
         LIMIT 1'
    );
    $stmt->execute([$userId, $signalId, $symbol, $strategy, ADAPTIVE_CLIENT_TRUST_PROMOTION_WINDOW_SECONDS]);
    return (bool) $stmt->fetchColumn();
}

function adaptiveAudit(
    PDO $pdo,
    ?int $actorUserId,
    string $actorRole,
    ?int $targetUserId,
    string $actionType,
    string $entityType,
    string $entityKey,
    ?string $category,
    ?string $strategy,
    ?string $symbolScope,
    mixed $previousValue,
    mixed $newValue,
    string $reason
): void {
    $stmt = $pdo->prepare(
        'INSERT INTO adaptive_learning_audit_log
        (actor_user_id, actor_role, target_user_id, action_type, entity_type, entity_key, market_category, strategy_key, symbol_scope,
         previous_value_json, new_value_json, reason_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $actorUserId,
        mb_substr($actorRole, 0, 20),
        $targetUserId,
        mb_substr($actionType, 0, 64),
        mb_substr($entityType, 0, 64),
        mb_substr($entityKey, 0, 120),
        $category,
        $strategy,
        $symbolScope,
        adaptiveJsonEncode($previousValue),
        adaptiveJsonEncode($newValue),
        $reason,
    ]);
}

/**
 * @return array<string,mixed>|null
 */
function adaptiveFetchLearningProfile(PDO $pdo, int $userId, string $category, string $strategy, string $symbolScope): ?array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM adaptive_learning_profiles
          WHERE user_id = ? AND market_category = ? AND strategy_key = ? AND symbol_scope = ?
          LIMIT 1'
    );
    $stmt->execute([$userId, $category, $strategy, $symbolScope]);
    $row = $stmt->fetch();
    return is_array($row) ? $row : null;
}

function adaptiveUpsertLearningProfile(PDO $pdo, int $userId, array $scope, array $trade): void
{
    $existing = adaptiveFetchLearningProfile($pdo, $userId, $scope['market_category'], $scope['strategy_key'], $scope['symbol_scope']);
    $wins = (int) ($existing['wins'] ?? 0);
    $losses = (int) ($existing['losses'] ?? 0);
    $cancelled = (int) ($existing['cancelled'] ?? 0);
    $trades = (int) ($existing['trade_count'] ?? 0);
    $rSum = (float) ($existing['r_multiple_sum'] ?? 0.0);
    $profitSum = (float) ($existing['profit_points_sum'] ?? 0.0);

    $trades++;
    if ($trade['result'] === 'WIN') {
        $wins++;
    } elseif ($trade['result'] === 'LOSS') {
        $losses++;
    } else {
        $cancelled++;
    }

    if (($trade['result'] === 'WIN' || $trade['result'] === 'LOSS') && $trade['r_multiple'] !== null) {
        $rSum += (float) $trade['r_multiple'];
    }
    if ($trade['profit_points'] !== null) {
        $profitSum += (float) $trade['profit_points'];
    }

    $sample = $wins + $losses;
    $winRate = $sample > 0 ? round($wins / $sample, 6) : 0.0;
    $lossRate = $sample > 0 ? round($losses / $sample, 6) : 0.0;
    $avgR = $sample > 0 ? round($rSum / $sample, 4) : 0.0;
    $confidence = adaptiveConfidenceFromStats($sample, $winRate, $avgR);

    $learningProfile = [
        'sampleSize' => $sample,
        'winRate' => $winRate,
        'lossRate' => $lossRate,
        'avgRMultiple' => $avgR,
        'confidenceScore' => $confidence,
        'lastResult' => $trade['result'],
    ];

    $stmt = $pdo->prepare(
        'INSERT INTO adaptive_learning_profiles
        (user_id, scope_type, market_category, strategy_key, symbol_scope, trade_count, wins, losses, cancelled, r_multiple_sum,
         profit_points_sum, win_rate, loss_rate, avg_r_multiple, confidence_score, qualification_threshold, learning_profile_json,
         last_trade_id, last_signal_id, last_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           trade_count = VALUES(trade_count),
           wins = VALUES(wins),
           losses = VALUES(losses),
           cancelled = VALUES(cancelled),
           r_multiple_sum = VALUES(r_multiple_sum),
           profit_points_sum = VALUES(profit_points_sum),
           win_rate = VALUES(win_rate),
           loss_rate = VALUES(loss_rate),
           avg_r_multiple = VALUES(avg_r_multiple),
           confidence_score = VALUES(confidence_score),
           qualification_threshold = VALUES(qualification_threshold),
           learning_profile_json = VALUES(learning_profile_json),
           last_trade_id = VALUES(last_trade_id),
           last_signal_id = VALUES(last_signal_id),
           last_result = VALUES(last_result),
           updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([
        $userId,
        $scope['scope_type'],
        $scope['market_category'],
        $scope['strategy_key'],
        $scope['symbol_scope'],
        $trades,
        $wins,
        $losses,
        $cancelled,
        round($rSum, 4),
        round($profitSum, 4),
        $winRate,
        $lossRate,
        $avgR,
        $confidence,
        80.00,
        adaptiveJsonEncode($learningProfile),
        $trade['trade_id'],
        $trade['signal_id'],
        $trade['result'],
    ]);
}

/**
 * @return array<string,mixed>|null
 */
function adaptiveFetchFactorStat(PDO $pdo, int $userId, string $category, string $strategy, string $symbolScope, string $factor): ?array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM adaptive_factor_stats
          WHERE user_id = ? AND market_category = ? AND strategy_key = ? AND symbol_scope = ? AND factor_key = ?
          LIMIT 1'
    );
    $stmt->execute([$userId, $category, $strategy, $symbolScope, $factor]);
    $row = $stmt->fetch();
    return is_array($row) ? $row : null;
}

function adaptiveEnsureFactorStatRows(PDO $pdo, int $userId, array $scope, array $factors, array $rule): void
{
    if (!$factors) {
        return;
    }
    $stmt = $pdo->prepare(
        'INSERT INTO adaptive_factor_stats
        (user_id, market_category, strategy_key, symbol_scope, factor_key, wins, losses, cancelled, win_rate, sample_size,
         r_multiple_sum, avg_r_multiple, confidence_score, base_weight, current_weight, trend_direction, last_adjustment_reason, last_updated)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, "FLAT", "Awaiting resolved trades", CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE last_updated = last_updated'
    );
    foreach ($factors as $factor) {
        $label = trim((string) $factor);
        if ($label === '') {
            continue;
        }
        $weight = (float) (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[$label] ?? $rule['base_weight_default'] ?? 5.0);
        $stmt->execute([
            $userId,
            $scope['market_category'],
            $scope['strategy_key'],
            $scope['symbol_scope'],
            $label,
            round($weight, 2),
            round($weight, 2),
        ]);
    }
}

/**
 * @return array<string,mixed>
 */
function adaptiveComputeWeightUpdate(?array $existing, array $trade, array $rule, string $factor): array
{
    $baseWeight = isset($existing['base_weight']) ? (float) $existing['base_weight'] : (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[$factor] ?? (float) $rule['base_weight_default']);
    $currentWeight = isset($existing['current_weight']) ? (float) $existing['current_weight'] : $baseWeight;
    $wins = (int) ($existing['wins'] ?? 0);
    $losses = (int) ($existing['losses'] ?? 0);
    $cancelled = (int) ($existing['cancelled'] ?? 0);
    $sample = (int) ($existing['sample_size'] ?? 0);
    $rSum = (float) ($existing['r_multiple_sum'] ?? 0.0);

    if ($trade['result'] === 'WIN') {
        $wins++;
        $sample++;
    } elseif ($trade['result'] === 'LOSS') {
        $losses++;
        $sample++;
    } else {
        $cancelled++;
    }

    if (($trade['result'] === 'WIN' || $trade['result'] === 'LOSS') && $trade['r_multiple'] !== null) {
        $rSum += (float) $trade['r_multiple'];
    }

    $winRate = $sample > 0 ? $wins / $sample : 0.0;
    $avgR = $sample > 0 ? $rSum / $sample : 0.0;
    $confidence = adaptiveConfidenceFromStats($sample, $winRate, $avgR);
    $target = $baseWeight;
    $trend = 'FLAT';
    $reason = 'Insufficient sample size for adaptive adjustment';

    if ($sample >= (int) $rule['min_weight_adjustment_samples']) {
        $edge = ($winRate - 0.5) * 8.0;
        $expectancy = adaptiveClamp($avgR, -1.5, 2.5) * 1.35;
        $overfitGuard = adaptiveClamp($sample / 60.0, 0.2, 1.0);
        $target = adaptiveClamp($baseWeight + (($edge + $expectancy) * ($confidence / 100.0) * $overfitGuard), 1.0, 10.0);
        $step = adaptiveClamp((float) $rule['max_weight_step'], 0.10, 2.00);
        if ($target > $currentWeight) {
            $currentWeight = min($target, $currentWeight + $step);
            $trend = 'UP';
        } elseif ($target < $currentWeight) {
            $currentWeight = max($target, $currentWeight - $step);
            $trend = 'DOWN';
        }
        $reason = $trend === 'UP'
            ? 'Historical performance exceeded adaptive threshold'
            : ($trend === 'DOWN' ? 'Historical performance weakened below adaptive threshold' : 'Historical performance remained within neutral range');
    }

    return [
        'base_weight' => round($baseWeight, 2),
        'current_weight' => round($currentWeight, 2),
        'wins' => $wins,
        'losses' => $losses,
        'cancelled' => $cancelled,
        'sample_size' => $sample,
        'r_multiple_sum' => round($rSum, 4),
        'win_rate' => round($winRate, 6),
        'avg_r_multiple' => round($avgR, 4),
        'confidence_score' => $confidence,
        'trend_direction' => $trend,
        'reason' => $reason,
    ];
}

function adaptiveUpsertFactorStat(PDO $pdo, int $userId, array $scope, string $factor, array $trade, array $rule, ?int $actorUserId = null): void
{
    $existing = adaptiveFetchFactorStat($pdo, $userId, $scope['market_category'], $scope['strategy_key'], $scope['symbol_scope'], $factor);
    $next = adaptiveComputeWeightUpdate($existing, $trade, $rule, $factor);
    $isLocked = !empty($existing['locked_by_admin']);
    if ($isLocked && $existing) {
        $next['base_weight'] = round((float) ($existing['base_weight'] ?? $next['base_weight']), 2);
        $next['current_weight'] = round((float) ($existing['current_weight'] ?? $next['current_weight']), 2);
        $next['trend_direction'] = 'FLAT';
        $next['reason'] = (string) (($existing['locked_reason'] ?? '') !== '' ? $existing['locked_reason'] : 'Admin locked adaptive weight');
    }

    $stmt = $pdo->prepare(
        'INSERT INTO adaptive_factor_stats
        (user_id, market_category, strategy_key, symbol_scope, factor_key, wins, losses, cancelled, win_rate, sample_size,
         r_multiple_sum, avg_r_multiple, confidence_score, base_weight, current_weight, locked_by_admin, locked_reason, locked_at,
         locked_by_user_id, trend_direction, last_adjustment_reason, last_trade_id, last_signal_id, last_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           wins = VALUES(wins),
           losses = VALUES(losses),
           cancelled = VALUES(cancelled),
           win_rate = VALUES(win_rate),
           sample_size = VALUES(sample_size),
           r_multiple_sum = VALUES(r_multiple_sum),
           avg_r_multiple = VALUES(avg_r_multiple),
           confidence_score = VALUES(confidence_score),
           base_weight = VALUES(base_weight),
           current_weight = VALUES(current_weight),
           locked_by_admin = VALUES(locked_by_admin),
           locked_reason = VALUES(locked_reason),
           locked_at = VALUES(locked_at),
           locked_by_user_id = VALUES(locked_by_user_id),
           trend_direction = VALUES(trend_direction),
           last_adjustment_reason = VALUES(last_adjustment_reason),
           last_trade_id = VALUES(last_trade_id),
           last_signal_id = VALUES(last_signal_id),
           last_result = VALUES(last_result),
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([
        $userId,
        $scope['market_category'],
        $scope['strategy_key'],
        $scope['symbol_scope'],
        $factor,
        $next['wins'],
        $next['losses'],
        $next['cancelled'],
        $next['win_rate'],
        $next['sample_size'],
        $next['r_multiple_sum'],
        $next['avg_r_multiple'],
        $next['confidence_score'],
        $next['base_weight'],
        $next['current_weight'],
        $isLocked ? 1 : 0,
        $existing['locked_reason'] ?? null,
        $existing['locked_at'] ?? null,
        $existing['locked_by_user_id'] ?? null,
        $next['trend_direction'],
        $next['reason'],
        $trade['trade_id'],
        $trade['signal_id'],
        $trade['result'],
    ]);

    $prevWeight = isset($existing['current_weight']) ? (float) $existing['current_weight'] : $next['base_weight'];
    if (!$isLocked && round($prevWeight, 2) !== round((float) $next['current_weight'], 2)) {
        adaptiveAudit(
            $pdo,
            $actorUserId,
            $actorUserId ? 'user' : 'system',
            $userId,
            'WEIGHT_AUTO_ADJUST',
            'factor_weight',
            $factor,
            $scope['market_category'],
            $scope['strategy_key'],
            $scope['symbol_scope'],
            ['current_weight' => $prevWeight],
            ['current_weight' => $next['current_weight'], 'confidence_score' => $next['confidence_score'], 'sample_size' => $next['sample_size']],
            $next['reason']
        );
    }
}

/**
 * @return array<string,mixed>
 */
function adaptivePersistSignalDecision(PDO $pdo, int $userId, array $decision): array
{
    $stmt = $pdo->prepare(
        'INSERT INTO adaptive_signal_decisions
        (user_id, signal_id, symbol, market_category, strategy_key, direction, signal_timestamp, telegram_action,
         qualification_band, signal_score, historical_reliability_score, market_category_score, strategy_reliability_score,
         final_confidence_score, factors_json, mtf_status, rule_snapshot_json, decision_trace_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           telegram_action = VALUES(telegram_action),
           qualification_band = VALUES(qualification_band),
           signal_score = VALUES(signal_score),
           historical_reliability_score = VALUES(historical_reliability_score),
           market_category_score = VALUES(market_category_score),
           strategy_reliability_score = VALUES(strategy_reliability_score),
           final_confidence_score = VALUES(final_confidence_score),
           factors_json = VALUES(factors_json),
           mtf_status = VALUES(mtf_status),
           rule_snapshot_json = VALUES(rule_snapshot_json),
           decision_trace_json = VALUES(decision_trace_json),
           updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([
        $userId,
        $decision['signal_id'],
        $decision['symbol'],
        $decision['market_category'],
        $decision['strategy_key'],
        $decision['direction'],
        $decision['signal_timestamp'],
        $decision['telegram_action'],
        $decision['qualification_band'],
        $decision['signal_score'],
        $decision['historical_reliability_score'],
        $decision['market_category_score'],
        $decision['strategy_reliability_score'],
        $decision['final_confidence_score'],
        adaptiveJsonEncode($decision['factors']),
        $decision['mtf_status'],
        adaptiveJsonEncode($decision['rule_snapshot']),
        adaptiveJsonEncode($decision['trace']),
    ]);
    $decisionId = (int) $pdo->lastInsertId();
    if ($decisionId <= 0) {
        $idStmt = $pdo->prepare(
            'SELECT id
               FROM adaptive_signal_decisions
              WHERE user_id = ? AND signal_id = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT 1'
        );
        $idStmt->execute([$userId, (string) $decision['signal_id']]);
        $decisionId = (int) ($idStmt->fetchColumn() ?: 0);
    }
    $decision['id'] = $decisionId;
    $decision['weight_version'] = 'v' . (int) max(1, $decisionId);
    return $decision;
}

function adaptiveFetchSignalDecision(PDO $pdo, int $userId, string $signalId): ?array
{
    if ($signalId === '') {
        return null;
    }
    $stmt = $pdo->prepare(
        'SELECT id, signal_id, symbol, market_category, strategy_key, telegram_action, qualification_band, signal_score,
                historical_reliability_score, market_category_score, strategy_reliability_score, final_confidence_score,
                mtf_status, factors_json
           FROM adaptive_signal_decisions
          WHERE user_id = ? AND signal_id = ?
          ORDER BY created_at DESC
          LIMIT 1'
    );
    $stmt->execute([$userId, $signalId]);
    $row = $stmt->fetch();
    return is_array($row) ? $row : null;
}

/**
 * @return array<string,mixed>|null
 */
function adaptiveFetchProfileForDecision(PDO $pdo, int $userId, string $category, string $strategy, string $symbolScope): ?array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM adaptive_learning_profiles
          WHERE user_id = ?
            AND market_category = ?
            AND strategy_key IN (?, ?)
            AND symbol_scope IN (?, ?)
          ORDER BY (strategy_key = ?) DESC, (symbol_scope = ?) DESC, updated_at DESC
          LIMIT 1'
    );
    $stmt->execute([$userId, $category, $strategy, '*', $symbolScope, '*', $strategy, $symbolScope]);
    $row = $stmt->fetch();
    return is_array($row) ? $row : null;
}

/**
 * @return array<int,array<string,mixed>>
 */
function adaptiveFetchFactorRows(PDO $pdo, int $userId, string $category, string $strategy, string $symbolScope, array $factors): array
{
    if (!$factors) {
        return [];
    }
    $placeholders = implode(',', array_fill(0, count($factors), '?'));
    $params = array_merge([$userId, $category, $strategy, '*', $symbolScope, '*'], $factors, [$symbolScope, $strategy]);
    $stmt = $pdo->prepare(
        "SELECT * FROM adaptive_factor_stats
           WHERE user_id = ?
             AND market_category = ?
             AND strategy_key IN (?, ?)
             AND symbol_scope IN (?, ?)
             AND factor_key IN ($placeholders)
           ORDER BY (symbol_scope = ?) DESC, (strategy_key = ?) DESC, sample_size DESC"
    );
    $stmt->execute($params);
    return $stmt->fetchAll();
}

/**
 * @return array<string,mixed>
 */
function adaptiveQualifySignal(PDO $pdo, int $userId, array $payload): array
{
    $symbol = adaptiveNormalizeScopeValue($payload['symbol'] ?? '', '');
    if ($symbol === '') {
        throw new InvalidArgumentException('symbol is required');
    }
    $strategy = adaptiveNormalizeScopeValue($payload['strategy'] ?? $payload['strategy_key'] ?? $payload['strategyName'] ?? '', 'breakout_retest');
    $timeframeSec = max(1, (int) ($payload['timeframe_sec'] ?? $payload['timeframeSec'] ?? 60));
    $category = adaptiveNormalizeCategory(null, $symbol, $timeframeSec);
    $symbolScope = adaptiveNormalizeScopeValue($symbol, '*');
    $rule = adaptiveResolveRule($pdo, $userId, $category, $strategy, $symbolScope);
    $signalId = trim((string) ($payload['signal_id'] ?? $payload['signalId'] ?? ''));
    if ($signalId === '') {
        $signalId = 'sig_' . hash('sha256', $symbol . '|' . $strategy . '|' . ($payload['signal_timestamp'] ?? microtime(true)) . '|' . random_int(1, PHP_INT_MAX));
    }

    $direction = adaptiveNormalizeDirection($payload['direction'] ?? $payload['dir'] ?? null);
    $mtfStatus = strtoupper(trim((string) ($payload['mtf_status'] ?? $payload['mtfStatus'] ?? 'UNKNOWN')));
    $factorInput = $payload['factor_details'] ?? $payload['factorDetails'] ?? $payload['confluence_factors_raw'] ?? $payload['confluenceFactorsRaw'] ?? $payload['confluence_factors_present'] ?? $payload['factors'] ?? [];
    $factorDetails = adaptiveNormalizeFactorDetails($factorInput, $mtfStatus);
    $factors = adaptiveNormalizeFactors($factorDetails, $mtfStatus);
    $confluenceScore = isset($payload['confluence_score']) ? (float) $payload['confluence_score'] : (isset($payload['confluenceScore']) ? (float) $payload['confluenceScore'] : 0.0);
    $confluenceMax = max(1.0, isset($payload['confluence_max']) ? (float) $payload['confluence_max'] : 16.0);

    $categoryProfile = adaptiveFetchLearningProfile($pdo, $userId, $category, '*', '*');
    $strategyProfile = adaptiveFetchLearningProfile($pdo, $userId, $category, $strategy, '*');
    $symbolProfile = adaptiveFetchLearningProfile($pdo, $userId, $category, $strategy, $symbolScope);
    $historyProfile = $symbolProfile ?: ($strategyProfile ?: $categoryProfile);
    $scopes = adaptiveBuildScopes($category, $strategy, $symbol);
    foreach ($scopes as $scope) {
        $scopeRule = adaptiveResolveRule($pdo, $userId, $scope['market_category'], $scope['strategy_key'], $scope['symbol_scope']);
        adaptiveEnsureFactorStatRows($pdo, $userId, $scope, $factors, $scopeRule);
    }

    $factorRows = adaptiveFetchFactorRows($pdo, $userId, $category, $strategy, $symbolScope, $factors);
    $factorMap = [];
    foreach ($factorRows as $row) {
        if (!isset($factorMap[$row['factor_key']])) {
            $factorMap[$row['factor_key']] = $row;
        }
    }

    $factorScores = [];
    foreach ($factors as $factor) {
        $row = $factorMap[$factor] ?? null;
        $weight = $row ? (float) $row['current_weight'] : (ADAPTIVE_DEFAULT_FACTOR_WEIGHTS[$factor] ?? (float) $rule['base_weight_default']);
        $sample = $row ? (int) $row['sample_size'] : 0;
        $confidence = $row ? (float) $row['confidence_score'] : 0.0;
        $factorScores[] = adaptiveClamp(($weight / 10.0) * 100.0 * max(0.40, $confidence > 0 ? $confidence / 100.0 : 0.5), 0.0, 100.0);
        if ($sample < (int) $rule['min_sample_size']) {
            $factorScores[count($factorScores) - 1] = max(45.0, min(60.0, $factorScores[count($factorScores) - 1]));
        }
    }

    $factorScore = $factorScores ? array_sum($factorScores) / count($factorScores) : 50.0;
    $baseSignal = adaptiveClamp(($confluenceScore / $confluenceMax) * 100.0, 0.0, 100.0);
    $mtfAdjustment = ($mtfStatus === 'CONFIRMED' || $mtfStatus === 'PASS' || $mtfStatus === 'TRUE')
        ? 6.0
        : (($mtfStatus === 'REJECTED' || $mtfStatus === 'FAIL' || $mtfStatus === 'FALSE') ? -8.0 : 0.0);
    $signalScore = round(adaptiveClamp(($baseSignal * 0.65) + ($factorScore * 0.35) + $mtfAdjustment, 0.0, 100.0), 2);
    $historicalReliabilityScore = adaptiveReliabilityFromProfile($historyProfile);
    $marketCategoryScore = adaptiveReliabilityFromProfile($categoryProfile);
    $strategyReliabilityScore = adaptiveReliabilityFromProfile($strategyProfile);

    $finalConfidence = round(adaptiveClamp(
        ((float) $rule['confidence_blend_signal'] * $signalScore)
        + ((float) $rule['confidence_blend_history'] * $historicalReliabilityScore)
        + ((float) $rule['confidence_blend_market'] * $marketCategoryScore)
        + ((float) $rule['confidence_blend_strategy'] * $strategyReliabilityScore),
        0.0,
        100.0
    ), 2);

    $action = 'REJECT';
    $band = 'REJECT';
    if ($finalConfidence >= (float) $rule['high_confidence_min']) {
        $action = 'SEND_HIGH_CONFIDENCE';
        $band = 'HIGH_CONFIDENCE';
    } elseif ($finalConfidence >= (float) $rule['watchlist_below']) {
        $action = 'SEND_NORMAL';
        $band = 'NORMAL';
    } elseif ($finalConfidence >= (float) $rule['reject_below']) {
        $action = !empty($rule['watchlist_sends_to_telegram']) ? 'SEND_WATCHLIST' : 'WATCHLIST_ONLY';
        $band = 'WATCHLIST';
    }

    $trace = [
        'signal' => ['base' => round($baseSignal, 2), 'factorScore' => round($factorScore, 2), 'mtfAdjustment' => round($mtfAdjustment, 2)],
        'historical' => ['score' => $historicalReliabilityScore, 'sample_size' => (int) ($historyProfile['wins'] ?? 0) + (int) ($historyProfile['losses'] ?? 0)],
        'market' => ['score' => $marketCategoryScore, 'sample_size' => (int) ($categoryProfile['wins'] ?? 0) + (int) ($categoryProfile['losses'] ?? 0)],
        'strategy' => ['score' => $strategyReliabilityScore, 'sample_size' => (int) ($strategyProfile['wins'] ?? 0) + (int) ($strategyProfile['losses'] ?? 0)],
    ];

    return adaptivePersistSignalDecision($pdo, $userId, [
        'signal_id' => $signalId,
        'symbol' => $symbol,
        'market_category' => $category,
        'strategy_key' => $strategy,
        'direction' => $direction,
        'signal_timestamp' => adaptiveNormalizeDbTimestamp($payload['signal_timestamp'] ?? $payload['signalTimestamp'] ?? null),
        'telegram_action' => $action,
        'qualification_band' => $band,
        'signal_score' => $signalScore,
        'historical_reliability_score' => round($historicalReliabilityScore, 2),
        'market_category_score' => round($marketCategoryScore, 2),
        'strategy_reliability_score' => round($strategyReliabilityScore, 2),
        'final_confidence_score' => $finalConfidence,
        'factors' => $factorDetails,
        'mtf_status' => $mtfStatus === '' ? 'UNKNOWN' : $mtfStatus,
        'rule_snapshot' => $rule,
        'trace' => $trace,
        'weight_version' => 'v' . max(1, count($factorRows)),
    ]);
}

/**
 * @return array<string,mixed>
 */
function adaptiveRecordTrade(PDO $pdo, int $userId, array $payload, ?int $actorUserId = null, string $actorRole = 'system'): array
{
    $trustedSource = $actorRole !== 'user';
    $trade = adaptiveNormalizeTradePayload($payload, $trustedSource);
    $signalDecision = $trade['signal_id'] ? adaptiveFetchSignalDecision($pdo, $userId, (string) $trade['signal_id']) : null;
    if ($signalDecision) {
        if (!empty($signalDecision['symbol'])) {
            $trade['symbol'] = adaptiveNormalizeScopeValue((string) $signalDecision['symbol'], $trade['symbol']);
        }
        if (!empty($signalDecision['market_category'])) {
            $trade['market_category'] = adaptiveNormalizeCategory((string) $signalDecision['market_category'], $trade['symbol'], (int) ($trade['timeframe_sec'] ?? 60));
        }
        if (!empty($signalDecision['strategy_key'])) {
            $trade['strategy_key'] = adaptiveNormalizeScopeValue((string) $signalDecision['strategy_key'], $trade['strategy_key']);
        }
        if (empty($trade['has_raw_factor_details'])) {
            $decisionFactors = json_decode((string) ($signalDecision['factors_json'] ?? ''), true) ?: [];
            $trade['confluence_factors_raw'] = adaptiveNormalizeFactorDetails($decisionFactors, $signalDecision['mtf_status'] ?? $trade['mtf_status']);
            $trade['confluence_factors_present'] = adaptiveNormalizeFactors($trade['confluence_factors_raw'], $signalDecision['mtf_status'] ?? $trade['mtf_status']);
            $trade['has_raw_factor_details'] = count($trade['confluence_factors_raw']) > 0;
        }
        if (($trade['mtf_status'] ?? 'UNKNOWN') === 'UNKNOWN' && !empty($signalDecision['mtf_status'])) {
            $trade['mtf_status'] = (string) $signalDecision['mtf_status'];
        }
        if (($trade['telegram_decision'] ?? 'UNKNOWN') === 'UNKNOWN' && !empty($signalDecision['telegram_action'])) {
            $trade['telegram_decision'] = (string) $signalDecision['telegram_action'];
        }
        if (($trade['qualification_band'] ?? 'UNQUALIFIED') === 'UNQUALIFIED' && !empty($signalDecision['qualification_band'])) {
            $trade['qualification_band'] = (string) $signalDecision['qualification_band'];
        }
        if ($trade['confidence_score'] === null && isset($signalDecision['final_confidence_score'])) {
            $trade['confidence_score'] = (float) $signalDecision['final_confidence_score'];
        }
        if ($trade['signal_score'] === null && isset($signalDecision['signal_score'])) {
            $trade['signal_score'] = (float) $signalDecision['signal_score'];
        }
        if ($trade['historical_reliability_score'] === null && isset($signalDecision['historical_reliability_score'])) {
            $trade['historical_reliability_score'] = (float) $signalDecision['historical_reliability_score'];
        }
        if ($trade['market_category_score'] === null && isset($signalDecision['market_category_score'])) {
            $trade['market_category_score'] = (float) $signalDecision['market_category_score'];
        }
        if ($trade['strategy_reliability_score'] === null && isset($signalDecision['strategy_reliability_score'])) {
            $trade['strategy_reliability_score'] = (float) $signalDecision['strategy_reliability_score'];
        }
    }
    if (!$trustedSource && adaptiveCanTrustClientTrade($pdo, $userId, $trade)) {
        $trustedSource = true;
        $trade['notes_json']['trust_source'] = 'QUALIFIED_CLIENT_SIGNAL';
    }
    if (!$trustedSource) {
        $trade['notes_json']['trust_source'] = 'UNTRUSTED_CLIENT_REPORTED';
    }

    adaptiveAcquireUserTradeLock($pdo, $userId);
    try {
        $lookupStmt = $pdo->prepare(
            'SELECT id FROM adaptive_trade_history WHERE user_id = ? AND (trade_id = ? OR (? IS NOT NULL AND signal_id = ?)) LIMIT 1'
        );
        $lookupStmt->execute([$userId, $trade['trade_id'], $trade['signal_id'], $trade['signal_id']]);
        $existing = $lookupStmt->fetch();
        if ($existing) {
            return ['duplicate' => true, 'trade_id' => $trade['trade_id'], 'id' => (int) $existing['id']];
        }

        $pdo->beginTransaction();
        $stmt = $pdo->prepare(
            'INSERT INTO adaptive_trade_history
            (user_id, trade_id, signal_id, symbol, market_category, strategy_key, strategy_label, direction, signal_timestamp,
             entry_timestamp, exit_timestamp, entry_price, stop_loss, take_profit, exit_price, result, r_multiple, profit_points,
             telegram_sent, telegram_decision, confidence_score, signal_score, historical_reliability_score, market_category_score,
             strategy_reliability_score, qualification_band, confluence_factors_json, confluence_factors_raw_json, mtf_status, notes_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $userId,
            $trade['trade_id'],
            $trade['signal_id'],
            $trade['symbol'],
            $trade['market_category'],
            $trade['strategy_key'],
            $trade['strategy_label'],
            $trade['direction'],
            $trade['signal_timestamp'],
            $trade['entry_timestamp'],
            $trade['exit_timestamp'],
            $trade['entry_price'],
            $trade['stop_loss'],
            $trade['take_profit'],
            $trade['exit_price'],
            $trade['result'],
            $trade['r_multiple'],
            $trade['profit_points'],
            $trade['telegram_sent'],
            $trade['telegram_decision'],
            $trade['confidence_score'],
            $trade['signal_score'],
            $trade['historical_reliability_score'],
            $trade['market_category_score'],
            $trade['strategy_reliability_score'],
            $trade['qualification_band'],
            adaptiveJsonEncode($trade['confluence_factors_present']),
            adaptiveJsonEncode($trade['confluence_factors_raw']),
            $trade['mtf_status'],
            adaptiveJsonEncode($trade['notes_json']),
        ]);

        if ($trustedSource) {
            $scopes = adaptiveBuildScopes($trade['market_category'], $trade['strategy_key'], $trade['symbol']);
            foreach ($scopes as $scope) {
                adaptiveUpsertLearningProfile($pdo, $userId, $scope, $trade);
                $rule = adaptiveResolveRule($pdo, $userId, $scope['market_category'], $scope['strategy_key'], $scope['symbol_scope']);
                foreach ($trade['confluence_factors_present'] as $factor) {
                    adaptiveUpsertFactorStat($pdo, $userId, $scope, $factor, $trade, $rule, $actorUserId);
                }
            }
        }

        adaptiveAudit(
            $pdo,
            $actorUserId,
            $actorRole,
            $userId,
            'TRADE_RECORDED',
            'trade_history',
            $trade['trade_id'],
            $trade['market_category'],
            $trade['strategy_key'],
            $trade['symbol'],
            null,
            ['result' => $trade['result'], 'confidence_score' => $trade['confidence_score'], 'telegram_decision' => $trade['telegram_decision'], 'trusted_source' => $trustedSource],
            $trustedSource
                ? 'Completed trade stored for persistent adaptive learning'
                : 'Client-reported trade stored as untrusted history and excluded from adaptive learning aggregates'
        );

        $pdo->commit();
        return [
            'duplicate' => false,
            'trade_id' => $trade['trade_id'],
            'id' => (int) $pdo->lastInsertId(),
            'market_category' => $trade['market_category'],
            'learning_applied' => $trustedSource,
        ];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    } finally {
        adaptiveReleaseUserTradeLock($pdo, $userId);
    }
}

/**
 * @return array<string,mixed>
 */
function adaptiveBootstrap(PDO $pdo, int $userId, array $filters = []): array
{
    adaptiveEnsureDefaultRules($pdo, $userId);

    $symbol = adaptiveNormalizeScopeValue($filters['symbol'] ?? '', '');
    $strategy = adaptiveNormalizeScopeValue($filters['strategy_key'] ?? $filters['strategy'] ?? '', '*');
    $timeframeSec = max(1, (int) ($filters['timeframe_sec'] ?? $filters['timeframeSec'] ?? 60));
    $category = $symbol !== '' ? adaptiveNormalizeCategory($filters['market_category'] ?? null, $symbol, $timeframeSec) : adaptiveNormalizeCategory($filters['market_category'] ?? 'VOLATILITY_STANDARD');
    $symbolScope = $symbol !== '' ? $symbol : '*';
    $resolvedRule = adaptiveResolveRule($pdo, $userId, $category, $strategy, $symbolScope);

    $rulesStmt = $pdo->prepare('SELECT * FROM adaptive_qualification_rules WHERE user_id = ? ORDER BY market_category, strategy_key, symbol_scope');
    $rulesStmt->execute([$userId]);
    $rules = $rulesStmt->fetchAll();

    $profilesStmt = $pdo->prepare(
        'SELECT * FROM adaptive_learning_profiles WHERE user_id = ? AND market_category = ? ORDER BY updated_at DESC LIMIT 200'
    );
    $profilesStmt->execute([$userId, $category]);
    $profiles = $profilesStmt->fetchAll();

    $factorStmt = $pdo->prepare(
        'SELECT * FROM adaptive_factor_stats
          WHERE user_id = ? AND market_category = ? AND strategy_key IN (?, ?)
            AND symbol_scope IN (?, ?)
          ORDER BY (symbol_scope = ?) DESC, (strategy_key = ?) DESC, sample_size DESC, last_updated DESC LIMIT 200'
    );
    $factorStmt->execute([$userId, $category, $strategy, '*', $symbolScope, '*', $symbolScope, $strategy]);
    $factors = $factorStmt->fetchAll();

    $tradeStmt = $pdo->prepare(
        "SELECT id, trade_id, signal_id, symbol, market_category, strategy_key, direction, result, r_multiple, profit_points,
                telegram_sent, telegram_decision, confidence_score, qualification_band, mtf_status, created_at,
                CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, '\$.trust_source')), '') = 'UNTRUSTED_CLIENT_REPORTED' THEN 0 ELSE 1 END AS trusted
           FROM adaptive_trade_history
          WHERE user_id = ? AND market_category = ?
          ORDER BY created_at DESC LIMIT 100"
    );
    $tradeStmt->execute([$userId, $category]);
    $trades = array_map(static function (array $row): array {
        $row['trusted'] = (bool) $row['trusted'];
        return $row;
    }, $tradeStmt->fetchAll());

    $decisionStmt = $pdo->prepare(
        'SELECT signal_id, symbol, market_category, strategy_key, telegram_action, qualification_band, signal_score,
                historical_reliability_score, market_category_score, strategy_reliability_score, final_confidence_score,
                mtf_status, created_at
           FROM adaptive_signal_decisions
          WHERE user_id = ? AND market_category = ?
          ORDER BY created_at DESC LIMIT 50'
    );
    $decisionStmt->execute([$userId, $category]);
    $decisions = $decisionStmt->fetchAll();

    return [
        'categories' => ADAPTIVE_MARKET_CATEGORIES,
        'current_category' => $category,
        'resolved_rule' => $resolvedRule,
        'rules' => $rules,
        'profiles' => $profiles,
        'factor_stats' => $factors,
        'recent_trades' => $trades,
        'recent_decisions' => $decisions,
    ];
}

/**
 * @return array<string,mixed>
 */
function adaptiveUserIntelligenceDetail(PDO $pdo, int $userId, array $filters = []): array
{
    $stmt = $pdo->prepare('SELECT id, username, display_name, email, subscription_plan, subscription_status, status, updated_at, created_at FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([$userId]);
    $user = $stmt->fetch();
    if (!$user) {
        throw new RuntimeException('User not found');
    }

    adaptiveEnsureDefaultRules($pdo, $userId);
    $profileRows = adaptiveHydrateUserSummaries($pdo, [$user]);
    $profile = $profileRows[0] ?? null;
    if (!$profile) {
        throw new RuntimeException('User profile summary unavailable');
    }

    $category = trim((string) ($filters['market_category'] ?? ''));
    $strategy = trim((string) ($filters['strategy_key'] ?? ''));
    $symbol = trim((string) ($filters['symbol'] ?? ''));
    $categoryValue = $category !== '' ? strtoupper($category) : null;
    $strategyValue = $strategy !== '' ? $strategy : null;
    $symbolValue = $symbol !== '' ? $symbol : null;
    $trustedTradeFilterSql = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, '$.trust_source')), '') <> 'UNTRUSTED_CLIENT_REPORTED'";

    $ruleWhere = ['user_id = ?'];
    $ruleParams = [$userId];
    if ($categoryValue !== null) {
        $ruleWhere[] = "market_category IN (?, '*')";
        $ruleParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $ruleWhere[] = "strategy_key IN (?, '*')";
        $ruleParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $ruleWhere[] = "symbol_scope IN (?, '*')";
        $ruleParams[] = $symbolValue;
    }
    $ruleSql = 'WHERE ' . implode(' AND ', $ruleWhere);

    $factorWhere = ['user_id = ?'];
    $factorParams = [$userId];
    if ($categoryValue !== null) {
        $factorWhere[] = 'market_category = ?';
        $factorParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $factorWhere[] = 'strategy_key = ?';
        $factorParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $factorWhere[] = 'symbol_scope = ?';
        $factorParams[] = $symbolValue;
    }
    $factorSql = 'WHERE ' . implode(' AND ', $factorWhere);

    $tradeWhere = ['user_id = ?', $trustedTradeFilterSql];
    $tradeParams = [$userId];
    if ($categoryValue !== null) {
        $tradeWhere[] = 'market_category = ?';
        $tradeParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $tradeWhere[] = 'strategy_key = ?';
        $tradeParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $tradeWhere[] = 'symbol = ?';
        $tradeParams[] = $symbolValue;
    }
    $tradeSql = 'WHERE ' . implode(' AND ', $tradeWhere);

    /* Separate, trust-unfiltered where-clause for the raw per-trade "Trade History" list/export
     * below. Aggregate learning stats above intentionally exclude untrusted client-reported trades
     * so weight adjustments are not spoofable, but the raw trade list must show every recorded
     * trade (including untrusted ones) with an explicit trusted flag so it is always possible to
     * tell, per trade, whether it counted toward adaptive learning. */
    $tradeHistoryWhere = ['user_id = ?'];
    $tradeHistoryParams = [$userId];
    if ($categoryValue !== null) {
        $tradeHistoryWhere[] = 'market_category = ?';
        $tradeHistoryParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $tradeHistoryWhere[] = 'strategy_key = ?';
        $tradeHistoryParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $tradeHistoryWhere[] = 'symbol = ?';
        $tradeHistoryParams[] = $symbolValue;
    }
    $tradeHistorySql = 'WHERE ' . implode(' AND ', $tradeHistoryWhere);
    $trustedColumnSql = "CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, '\$.trust_source')), '') = 'UNTRUSTED_CLIENT_REPORTED' THEN 0 ELSE 1 END";

    $decisionWhere = ['user_id = ?'];
    $decisionParams = [$userId];
    if ($categoryValue !== null) {
        $decisionWhere[] = 'market_category = ?';
        $decisionParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $decisionWhere[] = 'strategy_key = ?';
        $decisionParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $decisionWhere[] = 'symbol = ?';
        $decisionParams[] = $symbolValue;
    }
    $decisionSql = 'WHERE ' . implode(' AND ', $decisionWhere);

    $rulesStmt = $pdo->prepare('SELECT * FROM adaptive_qualification_rules ' . $ruleSql . ' ORDER BY market_category, strategy_key, symbol_scope LIMIT 250');
    $rulesStmt->execute($ruleParams);
    $rules = $rulesStmt->fetchAll();

    /* Server-side paginated/sortable/searchable view of the same rule scope for the UI table. */
    $rulesPaginated = adaptiveFetchPaginated(
        $pdo,
        'adaptive_qualification_rules',
        $ruleWhere,
        $ruleParams,
        $filters,
        'rules',
        'updated_at',
        ['market_category', 'strategy_key', 'symbol_scope', 'min_sample_size', 'enabled', 'updated_at', 'created_at'],
        ['market_category', 'strategy_key', 'symbol_scope']
    );

    $factorStmt = $pdo->prepare('SELECT * FROM adaptive_factor_stats ' . $factorSql . ' ORDER BY sample_size DESC, current_weight DESC, factor_key ASC LIMIT 250');
    $factorStmt->execute($factorParams);
    $factorStats = $factorStmt->fetchAll();
    $resolveFactorMinSample = static function (array $factorRow) use ($rules): int {
        $rowCategory = strtoupper(trim((string) ($factorRow['market_category'] ?? '')));
        $rowStrategy = trim((string) ($factorRow['strategy_key'] ?? ''));
        $rowSymbol = trim((string) ($factorRow['symbol_scope'] ?? ''));
        $bestRule = null;
        $bestScore = -1;
        $bestUpdatedAt = '';
        foreach ($rules as $ruleRow) {
            $ruleCategory = strtoupper(trim((string) ($ruleRow['market_category'] ?? '*')));
            $ruleStrategy = trim((string) ($ruleRow['strategy_key'] ?? '*'));
            $ruleSymbol = trim((string) ($ruleRow['symbol_scope'] ?? '*'));
            if ($ruleCategory !== '*' && $ruleCategory !== $rowCategory) {
                continue;
            }
            if ($ruleStrategy !== '*' && $ruleStrategy !== $rowStrategy) {
                continue;
            }
            if ($ruleSymbol !== '*' && $ruleSymbol !== $rowSymbol) {
                continue;
            }
            $score = 0;
            if ($ruleCategory === $rowCategory) {
                $score += 4;
            }
            if ($ruleSymbol === $rowSymbol) {
                $score += 2;
            }
            if ($ruleStrategy === $rowStrategy) {
                $score += 1;
            }
            $updatedAt = trim((string) ($ruleRow['updated_at'] ?? ''));
            if ($score > $bestScore || ($score === $bestScore && $updatedAt > $bestUpdatedAt)) {
                $bestRule = $ruleRow;
                $bestScore = $score;
                $bestUpdatedAt = $updatedAt;
            }
        }
        return max(1, (int) (($bestRule['min_sample_size'] ?? 10)));
    };
    $minObservedFactorSample = 10;
    $ratedFactorCount = 0;
    $factorStatsWithThresholds = [];
    foreach ($factorStats as $factorRow) {
        $rowMinSample = $resolveFactorMinSample($factorRow);
        $sampleSize = (int) ($factorRow['sample_size'] ?? 0);
        $isRated = $sampleSize >= $rowMinSample ? 1 : 0;
        $minObservedFactorSample = min($minObservedFactorSample, $rowMinSample);
        if ($isRated === 1) {
            $ratedFactorCount++;
        }
        $factorStatsWithThresholds[] = $factorRow + [
            '_row_min_sample' => $rowMinSample,
            '_row_is_rated' => $isRated,
            '_row_sample_size' => $sampleSize,
        ];
    }

    $adaptiveProfileStmt = $pdo->prepare('SELECT symbol, timeframe_sec, strategy_key, regime, adaptive_mode, confidence_score, sample_size, updated_at FROM adaptive_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 12');
    $adaptiveProfileStmt->execute([$userId]);
    $adaptiveProfiles = $adaptiveProfileStmt->fetchAll();

    $tradesStmt = $pdo->prepare("SELECT id, trade_id, symbol, market_category, strategy_key, result, r_multiple, confidence_score, created_at, $trustedColumnSql AS trusted FROM adaptive_trade_history " . $tradeHistorySql . ' ORDER BY created_at DESC LIMIT 30');
    $tradesStmt->execute($tradeHistoryParams);
    $trades = array_map(static function (array $row): array {
        $row['trusted'] = (bool) $row['trusted'];
        return $row;
    }, $tradesStmt->fetchAll());

    /* Server-side paginated/sortable/searchable "Recent Trades" view. */
    $tradesPaginated = adaptiveFetchPaginated(
        $pdo,
        'adaptive_trade_history',
        $tradeHistoryWhere,
        $tradeHistoryParams,
        $filters,
        'trades',
        'created_at',
        ['created_at', 'symbol', 'market_category', 'strategy_key', 'result', 'r_multiple', 'confidence_score'],
        ['trade_id', 'symbol', 'market_category', 'strategy_key', 'result'],
        "id, trade_id, symbol, market_category, strategy_key, result, r_multiple, confidence_score, created_at, $trustedColumnSql AS trusted"
    );
    $tradesPaginated['rows'] = array_map(static function (array $row): array {
        $row['trusted'] = (bool) $row['trusted'];
        return $row;
    }, $tradesPaginated['rows']);

    $decisionStmt = $pdo->prepare('SELECT signal_id, market_category, strategy_key, telegram_action, qualification_band, final_confidence_score, created_at FROM adaptive_signal_decisions ' . $decisionSql . ' ORDER BY created_at DESC LIMIT 30');
    $decisionStmt->execute($decisionParams);
    $decisions = $decisionStmt->fetchAll();

    /* Server-side paginated/sortable/searchable "Recent Decisions" view. */
    $decisionsPaginated = adaptiveFetchPaginated(
        $pdo,
        'adaptive_signal_decisions',
        $decisionWhere,
        $decisionParams,
        $filters,
        'decisions',
        'created_at',
        ['created_at', 'symbol', 'market_category', 'strategy_key', 'telegram_action', 'qualification_band', 'final_confidence_score'],
        ['signal_id', 'symbol', 'market_category', 'strategy_key', 'telegram_action', 'qualification_band'],
        'signal_id, market_category, strategy_key, telegram_action, qualification_band, final_confidence_score, created_at'
    );

    $factorStatsByStrategyMap = [];
    $factorStatsBySymbolMap = [];
    $factorStatsByCategoryMap = [];
    foreach ($factorStatsWithThresholds as $factorRow) {
        $sampleSize = (int) ($factorRow['_row_sample_size'] ?? $factorRow['sample_size'] ?? 0);
        $currentWeight = (float) ($factorRow['current_weight'] ?? 0);
        $isRated = (int) ($factorRow['_row_is_rated'] ?? 0);

        $strategyKey = trim((string) ($factorRow['strategy_key'] ?? ''));
        $strategyKey = $strategyKey !== '' ? $strategyKey : '*';
        if (!isset($factorStatsByStrategyMap[$strategyKey])) {
            $factorStatsByStrategyMap[$strategyKey] = ['strategy_key' => $strategyKey, 'factor_count' => 0, 'rated_factor_count' => 0, 'total_samples' => 0, 'weight_sum' => 0.0];
        }
        $factorStatsByStrategyMap[$strategyKey]['factor_count']++;
        $factorStatsByStrategyMap[$strategyKey]['rated_factor_count'] += $isRated;
        $factorStatsByStrategyMap[$strategyKey]['total_samples'] += $sampleSize;
        $factorStatsByStrategyMap[$strategyKey]['weight_sum'] += $currentWeight;

        $symbolScope = trim((string) ($factorRow['symbol_scope'] ?? ''));
        $symbolScope = $symbolScope !== '' ? $symbolScope : '*';
        if (!isset($factorStatsBySymbolMap[$symbolScope])) {
            $factorStatsBySymbolMap[$symbolScope] = ['symbol_scope' => $symbolScope, 'factor_count' => 0, 'rated_factor_count' => 0, 'total_samples' => 0, 'weight_sum' => 0.0];
        }
        $factorStatsBySymbolMap[$symbolScope]['factor_count']++;
        $factorStatsBySymbolMap[$symbolScope]['rated_factor_count'] += $isRated;
        $factorStatsBySymbolMap[$symbolScope]['total_samples'] += $sampleSize;
        $factorStatsBySymbolMap[$symbolScope]['weight_sum'] += $currentWeight;

        $marketCategory = strtoupper(trim((string) ($factorRow['market_category'] ?? '')));
        $marketCategory = $marketCategory !== '' ? $marketCategory : 'UNCATEGORIZED';
        if (!isset($factorStatsByCategoryMap[$marketCategory])) {
            $factorStatsByCategoryMap[$marketCategory] = ['market_category' => $marketCategory, 'factor_count' => 0, 'rated_factor_count' => 0, 'total_samples' => 0, 'weight_sum' => 0.0];
        }
        $factorStatsByCategoryMap[$marketCategory]['factor_count']++;
        $factorStatsByCategoryMap[$marketCategory]['rated_factor_count'] += $isRated;
        $factorStatsByCategoryMap[$marketCategory]['total_samples'] += $sampleSize;
        $factorStatsByCategoryMap[$marketCategory]['weight_sum'] += $currentWeight;
    }

    $finalizeFactorBreakdown = static function (array $rows): array {
        foreach ($rows as &$row) {
            $count = max(1, (int) ($row['factor_count'] ?? 0));
            $row['avg_weight'] = round(((float) ($row['weight_sum'] ?? 0.0)) / $count, 4);
            unset($row['weight_sum']);
        }
        unset($row);
        usort($rows, static function (array $a, array $b): int {
            $ratedCmp = ((int) ($b['rated_factor_count'] ?? 0)) <=> ((int) ($a['rated_factor_count'] ?? 0));
            if ($ratedCmp !== 0) {
                return $ratedCmp;
            }
            $factorCmp = ((int) ($b['factor_count'] ?? 0)) <=> ((int) ($a['factor_count'] ?? 0));
            if ($factorCmp !== 0) {
                return $factorCmp;
            }
            $leftKey = (string) ($a['strategy_key'] ?? $a['symbol_scope'] ?? $a['market_category'] ?? '');
            $rightKey = (string) ($b['strategy_key'] ?? $b['symbol_scope'] ?? $b['market_category'] ?? '');
            return strcmp($leftKey, $rightKey);
        });
        return array_slice($rows, 0, 100);
    };

    $factorStatsByStrategy = $finalizeFactorBreakdown(array_values($factorStatsByStrategyMap));
    $factorStatsBySymbol = $finalizeFactorBreakdown(array_values($factorStatsBySymbolMap));
    $factorStatsByCategory = $finalizeFactorBreakdown(array_values($factorStatsByCategoryMap));

    $auditWhere = ['target_user_id = ?'];
    $auditParams = [$userId];
    if ($categoryValue !== null) {
        $auditWhere[] = 'market_category = ?';
        $auditParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $auditWhere[] = 'strategy_key = ?';
        $auditParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $auditWhere[] = 'symbol_scope = ?';
        $auditParams[] = $symbolValue;
    }
    $auditStmt = $pdo->prepare('SELECT * FROM adaptive_learning_audit_log WHERE ' . implode(' AND ', $auditWhere) . ' ORDER BY created_at DESC LIMIT 100');
    $auditStmt->execute($auditParams);
    $audits = $auditStmt->fetchAll();

    /* Server-side paginated/sortable/searchable audit log view. */
    $auditPaginated = adaptiveFetchPaginated(
        $pdo,
        'adaptive_learning_audit_log',
        $auditWhere,
        $auditParams,
        $filters,
        'audit',
        'created_at',
        ['created_at', 'action_type', 'entity_type', 'market_category', 'strategy_key', 'symbol_scope'],
        ['action_type', 'entity_type', 'entity_key', 'market_category', 'strategy_key', 'symbol_scope', 'reason_text']
    );

    $categoryStmt = $pdo->prepare('SELECT market_category, COUNT(*) AS trade_count, SUM(result = "WIN") AS wins, SUM(result = "LOSS") AS losses, AVG(CASE WHEN result IN ("WIN","LOSS") THEN r_multiple END) AS avg_r_multiple, AVG(confidence_score) AS avg_confidence FROM adaptive_trade_history ' . $tradeSql . ' GROUP BY market_category ORDER BY market_category');
    $categoryStmt->execute($tradeParams);
    $categoryRows = $categoryStmt->fetchAll();

    $strategyStmt = $pdo->prepare('SELECT market_category, strategy_key, COUNT(*) AS trade_count, SUM(result = "WIN") AS wins, SUM(result = "LOSS") AS losses, AVG(CASE WHEN result IN ("WIN","LOSS") THEN r_multiple END) AS avg_r_multiple, AVG(confidence_score) AS avg_confidence, AVG(CASE WHEN result IN ("WIN","LOSS") THEN IF(result = "WIN", 1, 0) END) AS win_rate FROM adaptive_trade_history ' . $tradeSql . ' GROUP BY market_category, strategy_key ORDER BY market_category, strategy_key');
    $strategyStmt->execute($tradeParams);
    $strategyRows = $strategyStmt->fetchAll();

    $strategiesByCategory = [];
    foreach ($strategyRows as $row) {
        $strategiesByCategory[$row['market_category']][] = $row;
    }

    $categoryAnalytics = [];
    foreach ($categoryRows as $row) {
        $categoryKey = (string) $row['market_category'];
        $wins = (int) ($row['wins'] ?? 0);
        $losses = (int) ($row['losses'] ?? 0);
        $sample = $wins + $losses;
        $strategies = $strategiesByCategory[$categoryKey] ?? [];
        usort($strategies, static fn(array $a, array $b): int => adaptiveHealthScore($b) <=> adaptiveHealthScore($a));
        $best = $strategies[0] ?? null;
        $worst = $strategies ? $strategies[count($strategies) - 1] : null;
        $categoryAnalytics[] = [
            'market_category' => $categoryKey,
            'trade_count' => (int) ($row['trade_count'] ?? 0),
            'wins' => $wins,
            'losses' => $losses,
            'win_rate' => $sample > 0 ? round(($wins / $sample) * 100, 1) : 0.0,
            'avg_r_multiple' => $row['avg_r_multiple'] !== null ? round((float) $row['avg_r_multiple'], 2) : null,
            'confidence' => $row['avg_confidence'] !== null ? round((float) $row['avg_confidence'], 1) : null,
            'best_strategy' => $best ? [
                'strategy_key' => $best['strategy_key'],
                'win_rate' => $best['win_rate'] !== null ? round((float) $best['win_rate'] * 100, 1) : 0.0,
                'avg_r_multiple' => $best['avg_r_multiple'] !== null ? round((float) $best['avg_r_multiple'], 2) : null,
                'trade_count' => (int) ($best['trade_count'] ?? 0),
            ] : null,
            'worst_strategy' => $worst ? [
                'strategy_key' => $worst['strategy_key'],
                'win_rate' => $worst['win_rate'] !== null ? round((float) $worst['win_rate'] * 100, 1) : 0.0,
                'avg_r_multiple' => $worst['avg_r_multiple'] !== null ? round((float) $worst['avg_r_multiple'], 2) : null,
                'trade_count' => (int) ($worst['trade_count'] ?? 0),
            ] : null,
        ];
    }

    $diagStmt = $pdo->prepare(
        'SELECT COUNT(*) AS total_trades,
                SUM(CASE WHEN COALESCE(NULLIF(TRIM(market_category), \'\'), \'UNCATEGORIZED\') = \'UNCATEGORIZED\' THEN 1 ELSE 0 END) AS uncategorized_trades
         FROM adaptive_trade_history ' . $tradeSql
    );
    $diagStmt->execute($tradeParams);
    $diag = $diagStmt->fetch() ?: ['total_trades' => 0, 'uncategorized_trades' => 0];
    $totalTrades = (int) ($diag['total_trades'] ?? 0);
    $uncategorizedTrades = (int) ($diag['uncategorized_trades'] ?? 0);
    $ingestStmt = $pdo->prepare(
        'SELECT
            SUM(CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, \'$.trust_source\')), \'\') = \'UNTRUSTED_CLIENT_REPORTED\' THEN 1 ELSE 0 END) AS untrusted_total,
            SUM(CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, \'$.trust_source\')), \'\') <> \'UNTRUSTED_CLIENT_REPORTED\' THEN 1 ELSE 0 END) AS trusted_total,
            SUM(CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR) AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, \'$.trust_source\')), \'\') = \'UNTRUSTED_CLIENT_REPORTED\' THEN 1 ELSE 0 END) AS untrusted_24h,
            SUM(CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR) AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, \'$.trust_source\')), \'\') <> \'UNTRUSTED_CLIENT_REPORTED\' THEN 1 ELSE 0 END) AS trusted_24h
         FROM adaptive_trade_history
         WHERE user_id = ?'
    );
    $ingestStmt->execute([$userId]);
    $ingest = $ingestStmt->fetch() ?: [];
    $trustedTotal = (int) ($ingest['trusted_total'] ?? 0);
    $untrustedTotal = (int) ($ingest['untrusted_total'] ?? 0);
    $trusted24h = (int) ($ingest['trusted_24h'] ?? 0);
    $untrusted24h = (int) ($ingest['untrusted_24h'] ?? 0);
    $ingestTotal = $trustedTotal + $untrustedTotal;
    $ingest24hTotal = $trusted24h + $untrusted24h;

    /* ── Issue 5: full pipeline diagnostics report ──────────────────────
       Signal Generated → Signal Stored → Trade Opened → Trade Closed →
       Outcome Recorded → Strategy Statistics Updated → Adaptive Learning
       Updated → Factor Performance Updated → Market Category Updated →
       Dashboard Updated. Every count below is scoped by the same
       category/strategy/symbol filters as the rest of this payload so the
       report reflects exactly what the admin is looking at. */
    $pipelineWhere = ['user_id = ?'];
    $pipelineParams = [$userId];
    if ($categoryValue !== null) {
        $pipelineWhere[] = 'market_category = ?';
        $pipelineParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $pipelineWhere[] = 'strategy_key = ?';
        $pipelineParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $pipelineWhere[] = 'symbol = ?';
        $pipelineParams[] = $symbolValue;
    }
    $pipelineSql = 'WHERE ' . implode(' AND ', $pipelineWhere);

    $pipelineTradeStmt = $pdo->prepare(
        "SELECT COUNT(*) AS opened_trades,
                SUM(result = 'WIN') AS wins,
                SUM(result = 'LOSS') AS losses,
                SUM(result = 'CANCELLED') AS cancelled,
                SUM(result IN ('WIN','LOSS','CANCELLED')) AS closed_trades,
                SUM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(notes_json, '\$.trust_source')), '') = 'UNTRUSTED_CLIENT_REPORTED') AS untrusted_trades
         FROM adaptive_trade_history " . $pipelineSql
    );
    $pipelineTradeStmt->execute($pipelineParams);
    $pipelineTradeRow = $pipelineTradeStmt->fetch() ?: [];

    $pipelineDecisionStmt = $pdo->prepare('SELECT COUNT(*) FROM adaptive_signal_decisions ' . $decisionSql);
    $pipelineDecisionStmt->execute($decisionParams);
    $generatedSignals = (int) $pipelineDecisionStmt->fetchColumn();

    $adaptiveUpdatesWhere = ['target_user_id = ?', "action_type = 'WEIGHT_AUTO_ADJUST'", "actor_role = 'system'"];
    $adaptiveUpdatesParams = [$userId];
    if ($categoryValue !== null) {
        $adaptiveUpdatesWhere[] = 'market_category = ?';
        $adaptiveUpdatesParams[] = $categoryValue;
    }
    if ($strategyValue !== null) {
        $adaptiveUpdatesWhere[] = 'strategy_key = ?';
        $adaptiveUpdatesParams[] = $strategyValue;
    }
    if ($symbolValue !== null) {
        $adaptiveUpdatesWhere[] = 'symbol_scope = ?';
        $adaptiveUpdatesParams[] = $symbolValue;
    }
    $adaptiveUpdatesStmt = $pdo->prepare('SELECT COUNT(*) FROM adaptive_learning_audit_log WHERE ' . implode(' AND ', $adaptiveUpdatesWhere));
    $adaptiveUpdatesStmt->execute($adaptiveUpdatesParams);
    $adaptiveUpdates = (int) $adaptiveUpdatesStmt->fetchColumn();

    $categoryUpdatesStmt = $pdo->prepare('SELECT COUNT(DISTINCT market_category) FROM adaptive_trade_history ' . $pipelineSql);
    $categoryUpdatesStmt->execute($pipelineParams);
    $categoryUpdates = (int) $categoryUpdatesStmt->fetchColumn();

    $pipelineOpenedTrades = (int) ($pipelineTradeRow['opened_trades'] ?? 0);
    $pipelineClosedTrades = (int) ($pipelineTradeRow['closed_trades'] ?? 0);
    $pipelineFailedUpdates = (int) ($pipelineTradeRow['untrusted_trades'] ?? 0);

    $pipelineDiagnostics = [
        'generated_signals' => $generatedSignals,
        'opened_trades' => $pipelineOpenedTrades,
        'closed_trades' => $pipelineClosedTrades,
        'recorded_wins' => (int) ($pipelineTradeRow['wins'] ?? 0),
        'recorded_losses' => (int) ($pipelineTradeRow['losses'] ?? 0),
        'recorded_cancelled' => (int) ($pipelineTradeRow['cancelled'] ?? 0),
        'adaptive_updates' => $adaptiveUpdates,
        'category_updates' => $categoryUpdates,
        'failed_updates' => $pipelineFailedUpdates,
        'failed_updates_reason' => 'Untrusted client-reported trade outcomes are recorded in trade history but intentionally excluded from adaptive learning weight updates (see adaptiveRecordTrade).',
    ];

    return [
        'profile' => $profile,
        'adaptive_profiles' => $adaptiveProfiles,
        'rules' => $rules,
        'rules_page' => $rulesPaginated,
        'factor_stats' => $factorStats,
        'trades' => $trades,
        'trades_page' => $tradesPaginated,
        'decisions' => $decisions,
        'decisions_page' => $decisionsPaginated,
        'audits' => $audits,
        'audits_page' => $auditPaginated,
        'category_analytics' => $categoryAnalytics,
        'pipeline_diagnostics' => $pipelineDiagnostics,
        'category_diagnostics' => [
            'total_trades' => $totalTrades,
            'categorized_trades' => max(0, $totalTrades - $uncategorizedTrades),
            'uncategorized_trades' => $uncategorizedTrades,
        ],
        'ingestion_diagnostics' => [
            'trusted_total' => $trustedTotal,
            'untrusted_total' => $untrustedTotal,
            'trusted_rate_pct' => $ingestTotal > 0 ? round(($trustedTotal / $ingestTotal) * 100, 1) : 0.0,
            'untrusted_rate_pct' => $ingestTotal > 0 ? round(($untrustedTotal / $ingestTotal) * 100, 1) : 0.0,
            'trusted_24h' => $trusted24h,
            'untrusted_24h' => $untrusted24h,
            'trusted_24h_rate_pct' => $ingest24hTotal > 0 ? round(($trusted24h / $ingest24hTotal) * 100, 1) : 0.0,
            'untrusted_24h_rate_pct' => $ingest24hTotal > 0 ? round(($untrusted24h / $ingest24hTotal) * 100, 1) : 0.0,
            'trust_promotion_window_seconds' => ADAPTIVE_CLIENT_TRUST_PROMOTION_WINDOW_SECONDS,
        ],
        'factor_diagnostics' => [
            'total_resolved_trades' => $trustedTotal,
            'total_adaptive_trades' => $totalTrades,
            'total_factors_recorded' => count($factorStats),
            'rated_factors' => $ratedFactorCount,
            'unrated_factors' => max(0, count($factorStats) - $ratedFactorCount),
            'min_sample_size' => $minObservedFactorSample,
        ],
        'factor_statistics_by_strategy' => $factorStatsByStrategy,
        'factor_statistics_by_symbol' => $factorStatsBySymbol,
        'factor_statistics_by_category' => $factorStatsByCategory,
    ];
}

/**
 * @return array<int,array<string,mixed>>
 */
function adaptiveFactorHistory(PDO $pdo, int $userId, array $filters = []): array
{
    $factorKey = trim((string) ($filters['factor_key'] ?? ''));
    if ($factorKey === '') {
        throw new InvalidArgumentException('factor_key is required');
    }
    $where = ['target_user_id = ?', 'entity_key = ?'];
    $params = [$userId, $factorKey];
    $category = trim((string) ($filters['market_category'] ?? ''));
    $strategy = trim((string) ($filters['strategy_key'] ?? ''));
    $symbol = trim((string) ($filters['symbol_scope'] ?? ''));
    if ($category !== '') {
        $where[] = 'market_category = ?';
        $params[] = strtoupper($category);
    }
    if ($strategy !== '') {
        $where[] = 'strategy_key = ?';
        $params[] = $strategy;
    }
    if ($symbol !== '') {
        $where[] = 'symbol_scope = ?';
        $params[] = $symbol;
    }
    $stmt = $pdo->prepare('SELECT * FROM adaptive_learning_audit_log WHERE ' . implode(' AND ', $where) . ' ORDER BY created_at DESC LIMIT 100');
    $stmt->execute($params);
    return $stmt->fetchAll();
}

function adaptiveCloneRulesFromUser(PDO $pdo, int $adminUserId, int $targetUserId, int $sourceUserId, string $reason = 'Cloned adaptive qualification rules'): int
{
    if ($targetUserId === $sourceUserId) {
        throw new InvalidArgumentException('Source and target users must differ');
    }

    adaptiveEnsureDefaultRules($pdo, $sourceUserId);
    $select = $pdo->prepare('SELECT market_category, strategy_key, symbol_scope, reject_below, watchlist_below, high_confidence_min, min_sample_size, min_weight_adjustment_samples, max_weight_step, base_weight_default, confidence_blend_signal, confidence_blend_history, confidence_blend_market, confidence_blend_strategy, watchlist_sends_to_telegram, enabled FROM adaptive_qualification_rules WHERE user_id = ? ORDER BY market_category, strategy_key, symbol_scope');
    $select->execute([$sourceUserId]);
    $rows = $select->fetchAll();
    if (!$rows) {
        throw new RuntimeException('Source user has no adaptive rules to clone');
    }

    $pdo->prepare('DELETE FROM adaptive_qualification_rules WHERE user_id = ?')->execute([$targetUserId]);
    $insert = $pdo->prepare('INSERT INTO adaptive_qualification_rules (user_id, market_category, strategy_key, symbol_scope, reject_below, watchlist_below, high_confidence_min, min_sample_size, min_weight_adjustment_samples, max_weight_step, base_weight_default, confidence_blend_signal, confidence_blend_history, confidence_blend_market, confidence_blend_strategy, watchlist_sends_to_telegram, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    foreach ($rows as $row) {
        $insert->execute([
            $targetUserId,
            $row['market_category'],
            $row['strategy_key'],
            $row['symbol_scope'],
            $row['reject_below'],
            $row['watchlist_below'],
            $row['high_confidence_min'],
            $row['min_sample_size'],
            $row['min_weight_adjustment_samples'],
            $row['max_weight_step'],
            $row['base_weight_default'],
            $row['confidence_blend_signal'],
            $row['confidence_blend_history'],
            $row['confidence_blend_market'],
            $row['confidence_blend_strategy'],
            $row['watchlist_sends_to_telegram'],
            $row['enabled'],
        ]);
    }

    adaptiveAudit($pdo, $adminUserId, 'admin', $targetUserId, 'ADMIN_CLONE_RULES', 'qualification_rule_set', 'rules_from_user_' . $sourceUserId, null, null, null, ['source_user_id' => $sourceUserId], ['cloned_rule_count' => count($rows)], $reason);
    return count($rows);
}

function adaptiveAssignDefaultProfile(PDO $pdo, int $adminUserId, int $targetUserId, string $reason = 'Assigned default adaptive profile'): int
{
    $pdo->prepare('DELETE FROM adaptive_qualification_rules WHERE user_id = ?')->execute([$targetUserId]);
    adaptiveEnsureDefaultRules($pdo, $targetUserId);
    $countStmt = $pdo->prepare('SELECT COUNT(*) FROM adaptive_qualification_rules WHERE user_id = ?');
    $countStmt->execute([$targetUserId]);
    $count = (int) $countStmt->fetchColumn();
    adaptiveAudit($pdo, $adminUserId, 'admin', $targetUserId, 'ADMIN_ASSIGN_DEFAULTS', 'qualification_rule_set', 'default_profile', null, null, null, null, ['rule_count' => $count], $reason);
    return $count;
}

/**
 * @return array<string,mixed>
 */
function adaptiveResetFactorStat(PDO $pdo, int $adminUserId, int $targetUserId, int $factorId, string $reason = 'Admin reset adaptive factor'): array
{
    $stmt = $pdo->prepare('SELECT * FROM adaptive_factor_stats WHERE id = ? AND user_id = ? LIMIT 1');
    $stmt->execute([$factorId, $targetUserId]);
    $row = $stmt->fetch();
    if (!$row) {
        throw new RuntimeException('Factor stat not found');
    }

    $next = $row;
    $next['current_weight'] = $row['base_weight'];
    $next['locked_by_admin'] = 0;
    $next['locked_reason'] = null;
    $next['locked_at'] = null;
    $next['locked_by_user_id'] = null;
    $next['trend_direction'] = 'FLAT';
    $next['last_adjustment_reason'] = 'Admin reset to base weight';

    $upd = $pdo->prepare('UPDATE adaptive_factor_stats SET current_weight = base_weight, locked_by_admin = 0, locked_reason = NULL, locked_at = NULL, locked_by_user_id = NULL, trend_direction = "FLAT", last_adjustment_reason = ? , updated_at = CURRENT_TIMESTAMP, last_updated = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?');
    $upd->execute([$next['last_adjustment_reason'], $factorId, $targetUserId]);
    adaptiveAudit($pdo, $adminUserId, 'admin', $targetUserId, 'ADMIN_FACTOR_RESET', 'factor_stat', (string) $row['factor_key'], (string) $row['market_category'], (string) $row['strategy_key'], (string) $row['symbol_scope'], $row, $next, $reason);
    return $next;
}

/**
 * @return array<string,mixed>
 */
function adaptiveAdminDashboard(PDO $pdo, array $filters = []): array
{
    $targetUserId = isset($filters['user_id']) && (int) $filters['user_id'] > 0 ? (int) $filters['user_id'] : null;
    $category = trim((string) ($filters['market_category'] ?? ''));
    $strategy = trim((string) ($filters['strategy_key'] ?? ''));
    $symbol = trim((string) ($filters['symbol'] ?? ''));

    $where = [];
    $params = [];
    foreach ([
        ['col' => 'user_id', 'val' => $targetUserId],
        ['col' => 'market_category', 'val' => $category !== '' ? strtoupper($category) : null],
        ['col' => 'strategy_key', 'val' => $strategy !== '' ? $strategy : null],
        ['col' => 'symbol', 'val' => $symbol !== '' ? $symbol : null],
    ] as $part) {
        if ($part['val'] === null) {
            continue;
        }
        $where[] = $part['col'] . ' = ?';
        $params[] = $part['val'];
    }
    $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

    $summarySql = 'SELECT COUNT(*) AS trade_count,
                          SUM(result = "WIN") AS wins,
                          SUM(result = "LOSS") AS losses,
                          SUM(result = "CANCELLED") AS cancelled,
                          AVG(CASE WHEN result IN ("WIN","LOSS") THEN r_multiple END) AS avg_r_multiple,
                          AVG(confidence_score) AS avg_confidence
                     FROM adaptive_trade_history ' . $whereSql;
    $summaryStmt = $pdo->prepare($summarySql);
    $summaryStmt->execute($params);
    $summary = $summaryStmt->fetch() ?: [];

    $tradesStmt = $pdo->prepare('SELECT * FROM adaptive_trade_history ' . $whereSql . ' ORDER BY created_at DESC LIMIT 200');
    $tradesStmt->execute($params);
    $trades = $tradesStmt->fetchAll();

    $factorWhere = [];
    $factorParams = [];
    foreach ([
        ['col' => 'user_id', 'val' => $targetUserId],
        ['col' => 'market_category', 'val' => $category !== '' ? strtoupper($category) : null],
        ['col' => 'strategy_key', 'val' => $strategy !== '' ? $strategy : null],
        ['col' => 'symbol_scope', 'val' => $symbol !== '' ? $symbol : null],
    ] as $part) {
        if ($part['val'] === null) {
            continue;
        }
        $factorWhere[] = $part['col'] . ' = ?';
        $factorParams[] = $part['val'];
    }
    $factorWhereSql = $factorWhere ? ('WHERE ' . implode(' AND ', $factorWhere)) : '';

    $factorStmt = $pdo->prepare('SELECT * FROM adaptive_factor_stats ' . $factorWhereSql . ' ORDER BY sample_size DESC, current_weight DESC LIMIT 200');
    $factorStmt->execute($factorParams);
    $factors = $factorStmt->fetchAll();

    $profileStmt = $pdo->prepare('SELECT * FROM adaptive_learning_profiles ' . $factorWhereSql . ' ORDER BY updated_at DESC LIMIT 200');
    $profileStmt->execute($factorParams);
    $profiles = $profileStmt->fetchAll();

    $ruleStmt = $pdo->prepare('SELECT * FROM adaptive_qualification_rules ' . ($targetUserId ? 'WHERE user_id = ?' : '') . ' ORDER BY user_id, market_category, strategy_key, symbol_scope LIMIT 200');
    $ruleStmt->execute($targetUserId ? [$targetUserId] : []);
    $rules = $ruleStmt->fetchAll();

    $decisionStmt = $pdo->prepare('SELECT * FROM adaptive_signal_decisions ' . $whereSql . ' ORDER BY created_at DESC LIMIT 200');
    $decisionStmt->execute($params);
    $decisions = $decisionStmt->fetchAll();

    $auditWhereSql = $targetUserId ? 'WHERE target_user_id = ?' : '';
    $auditStmt = $pdo->prepare('SELECT * FROM adaptive_learning_audit_log ' . $auditWhereSql . ' ORDER BY created_at DESC LIMIT 200');
    $auditStmt->execute($targetUserId ? [$targetUserId] : []);
    $audits = $auditStmt->fetchAll();

    return [
        'summary' => $summary,
        'trades' => $trades,
        'factor_stats' => $factors,
        'profiles' => $profiles,
        'rules' => $rules,
        'decisions' => $decisions,
        'audits' => $audits,
    ];
}

function adaptiveRebuildUserHistory(PDO $pdo, int $userId, ?string $category = null): void
{
    if ($category !== null && $category !== '') {
        $category = strtoupper($category);
        $del1 = $pdo->prepare('DELETE FROM adaptive_learning_profiles WHERE user_id = ? AND market_category = ?');
        $del2 = $pdo->prepare('DELETE FROM adaptive_factor_stats WHERE user_id = ? AND market_category = ?');
        $del1->execute([$userId, $category]);
        $del2->execute([$userId, $category]);
        $tradeStmt = $pdo->prepare('SELECT * FROM adaptive_trade_history WHERE user_id = ? AND market_category = ? ORDER BY created_at ASC, id ASC');
        $tradeStmt->execute([$userId, $category]);
    } else {
        $pdo->prepare('DELETE FROM adaptive_learning_profiles WHERE user_id = ?')->execute([$userId]);
        $pdo->prepare('DELETE FROM adaptive_factor_stats WHERE user_id = ?')->execute([$userId]);
        $tradeStmt = $pdo->prepare('SELECT * FROM adaptive_trade_history WHERE user_id = ? ORDER BY created_at ASC, id ASC');
        $tradeStmt->execute([$userId]);
    }

    foreach ($tradeStmt->fetchAll() as $row) {
        $notes = json_decode((string) $row['notes_json'], true);
        if (($notes['trust_source'] ?? null) === 'UNTRUSTED_CLIENT_REPORTED') {
            continue;
        }
        $trade = [
            'trade_id' => $row['trade_id'],
            'signal_id' => $row['signal_id'],
            'symbol' => $row['symbol'],
            'market_category' => $row['market_category'],
            'strategy_key' => $row['strategy_key'],
            'strategy_label' => $row['strategy_label'],
            'direction' => $row['direction'],
            'signal_timestamp' => $row['signal_timestamp'],
            'entry_timestamp' => $row['entry_timestamp'],
            'exit_timestamp' => $row['exit_timestamp'],
            'entry_price' => $row['entry_price'],
            'stop_loss' => $row['stop_loss'],
            'take_profit' => $row['take_profit'],
            'exit_price' => $row['exit_price'],
            'result' => $row['result'],
            'r_multiple' => $row['r_multiple'],
            'profit_points' => $row['profit_points'],
            'telegram_sent' => $row['telegram_sent'],
            'telegram_decision' => $row['telegram_decision'],
            'confidence_score' => $row['confidence_score'],
            'signal_score' => $row['signal_score'],
            'historical_reliability_score' => $row['historical_reliability_score'],
            'market_category_score' => $row['market_category_score'],
            'strategy_reliability_score' => $row['strategy_reliability_score'],
            'qualification_band' => $row['qualification_band'],
            'confluence_factors_present' => json_decode((string) $row['confluence_factors_json'], true) ?: [],
            'mtf_status' => $row['mtf_status'],
        ];
        foreach (adaptiveBuildScopes($trade['market_category'], $trade['strategy_key'], $trade['symbol']) as $scope) {
            adaptiveUpsertLearningProfile($pdo, $userId, $scope, $trade);
            $rule = adaptiveResolveRule($pdo, $userId, $scope['market_category'], $scope['strategy_key'], $scope['symbol_scope']);
            foreach ($trade['confluence_factors_present'] as $factor) {
                adaptiveUpsertFactorStat($pdo, $userId, $scope, (string) $factor, $trade, $rule, null);
            }
        }
    }
}
