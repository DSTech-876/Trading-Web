<?php
/**
 * /api/trades/post_sl_recovery.php
 * ────────────────────────────────
 * POST — store a completed post-stop-loss recovery analysis (scenarios A/B/C)
 *        for the authenticated user. Classification is assigned server-side.
 * GET  — per-strategy recovery statistics (?strategy=<name> optional).
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$userId = authenticateUserFromToken();

function psrNum($v): ?float
{
    return (isset($v) && is_numeric($v) && is_finite((float) $v)) ? (float) $v : null;
}

function psrTime($v): ?string
{
    $n = psrNum($v);
    return $n === null ? null : gmdate('Y-m-d H:i:s', (int) $n);
}

function psrClassify(bool $a, bool $bWin, bool $cWin, ?float $recovery, ?float $range): string
{
    if ($a && $bWin) {
        return 'HIGH_VOLATILITY_STOP';
    }
    if ($cWin) {
        return 'EARLY_ENTRY_REENTRY_SUCCESS';
    }
    if ($a) {
        return 'EARLY_ENTRY';
    }
    if ($bWin) {
        return 'WRONG_DIRECTION';
    }
    if ($range !== null && $range > 0 && $recovery !== null && $recovery >= 0.5 * $range) {
        return 'MISSED_REVERSAL';
    }
    return 'VALID_LOSS';
}

try {
    $pdo = getDB();

    if ($method === 'GET') {
        $sql = "SELECT strategy,
                    COUNT(*) AS total_losses,
                    ROUND(100 * AVG(a_eventual_tp_reached), 1) AS scenario_a_pct,
                    ROUND(100 * AVG(b_tp_hit AND NOT b_sl_hit), 1) AS scenario_b_pct,
                    ROUND(100 * AVG(c_tp_hit AND NOT c_sl_hit), 1) AS scenario_c_pct,
                    AVG(a_minutes_to_tp) AS avg_recovery_minutes,
                    AVG(CASE WHEN a_eventual_tp_reached = 1 THEN a_max_favorable_move END) AS avg_recovery_distance
                FROM post_sl_recovery WHERE user_id = ?";
        $params = [$userId];
        if (isset($_GET['strategy']) && $_GET['strategy'] !== '') {
            $sql .= ' AND strategy = ?';
            $params[] = (string) $_GET['strategy'];
        }
        $sql .= ' GROUP BY strategy ORDER BY total_losses DESC';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        jsonResponse(['stats' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    if ($method !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }

    $in = json_decode(file_get_contents('php://input'), true);
    if (!is_array($in)) {
        jsonResponse(['error' => 'Invalid JSON'], 400);
    }
    foreach (['trade_id', 'strategy', 'symbol', 'direction', 'entry', 'sl', 'tp', 'sl_hit_time'] as $f) {
        if (!isset($in[$f]) || $in[$f] === '') {
            jsonResponse(['error' => "Missing required field: $f"], 400);
        }
    }
    if (!in_array($in['direction'], ['BULL', 'BEAR'], true)) {
        jsonResponse(['error' => 'Invalid direction'], 400);
    }
    $entry = psrNum($in['entry']);
    $sl = psrNum($in['sl']);
    $tp = psrNum($in['tp']);
    $slTime = psrTime($in['sl_hit_time']);
    if ($entry === null || $sl === null || $tp === null || $slTime === null) {
        jsonResponse(['error' => 'entry, sl, tp and sl_hit_time must be numeric'], 400);
    }

    $a = is_array($in['scenarioA'] ?? null) ? $in['scenarioA'] : [];
    $b = is_array($in['scenarioB'] ?? null) ? $in['scenarioB'] : [];
    $c = is_array($in['scenarioC'] ?? null) ? $in['scenarioC'] : [];
    $aReached = !empty($a['eventual_tp_reached']);
    $bTp = !empty($b['tp_hit']);
    $bSl = !empty($b['sl_hit']);
    $cTp = !empty($c['tp_hit']);
    $cSl = !empty($c['sl_hit']);

    $classification = psrClassify(
        $aReached,
        $bTp && !$bSl,
        $cTp && !$cSl,
        psrNum($a['max_recovery'] ?? null),
        abs($tp - $sl)
    );

    $stmt = $pdo->prepare(
        "INSERT IGNORE INTO post_sl_recovery (
            user_id, trade_id, signal_id, strategy, symbol, direction,
            entry_price, sl_price, tp_price, lot_size, sl_hit_time, confirm_mode,
            a_eventual_tp_reached, a_minutes_to_tp, a_max_favorable_move, a_distance_beyond_tp,
            b_entry_time, b_entry_price, b_tp_hit, b_sl_hit, b_profit_potential, b_time_to_tp,
            c_confirmation_time, c_confirmation_price, c_tp_hit, c_sl_hit, c_profit_potential, c_time_to_tp,
            classification
        ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?)"
    );
    $stmt->execute([
        $userId,
        substr((string) $in['trade_id'], 0, 100),
        isset($in['signal_id']) ? substr((string) $in['signal_id'], 0, 100) : null,
        substr((string) $in['strategy'], 0, 80),
        substr((string) $in['symbol'], 0, 40),
        $in['direction'],
        $entry, $sl, $tp, psrNum($in['lot_size'] ?? null), $slTime,
        isset($in['confirm_mode']) ? substr((string) $in['confirm_mode'], 0, 30) : null,
        $aReached ? 1 : 0, psrNum($a['minutes_to_tp_after_sl'] ?? null),
        psrNum($a['max_favorable_move'] ?? null), psrNum($a['distance_beyond_tp'] ?? null),
        psrTime($b['entry_time'] ?? null), psrNum($b['entry_price'] ?? null),
        $bTp ? 1 : 0, $bSl ? 1 : 0, psrNum($b['profit_potential'] ?? null), psrNum($b['time_to_tp'] ?? null),
        psrTime($c['confirmation_time'] ?? null), psrNum($c['confirmation_price'] ?? null),
        $cTp ? 1 : 0, $cSl ? 1 : 0, psrNum($c['profit_potential'] ?? null), psrNum($c['time_to_tp'] ?? null),
        $classification,
    ]);

    jsonResponse(['success' => true, 'trade_id' => $in['trade_id'], 'classification' => $classification]);
} catch (\Throwable $e) {
    error_log('post_sl_recovery.php error: ' . $e->getMessage());
    jsonResponse(['error' => 'Database error'], 500);
}
