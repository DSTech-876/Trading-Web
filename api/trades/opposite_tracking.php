<?php
/**
 * /api/trades/opposite_tracking.php
 * ─────────────────────────────────
 * POST — upsert an opposite-trade tracking row for a stop-loss trade.
 *        Sent once when the SL closes (status TRACKING) and again when the
 *        post-SL monitoring window ends (status COMPLETE). The classification
 *        is always assigned server-side from the reported results.
 * GET  — signal-improvement advice for the authenticated user's strategies
 *        (?strategy=<name> optional). Falls back to platform-wide data when
 *        the user has too little history of their own.
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../lib/OppositeTradeService.php';

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$userId = authenticateUserFromToken();

function ottNum($v): ?float
{
    return (isset($v) && is_numeric($v) && is_finite((float) $v)) ? (float) $v : null;
}

try {
    $pdo = getDB();

    if ($method === 'GET') {
        $strategy = isset($_GET['strategy']) ? (string) $_GET['strategy'] : null;
        $advice = [];
        foreach (OppositeTradeService::strategyStats($pdo, $userId) as $s) {
            if ($strategy !== null && $s['strategy'] !== $strategy) {
                continue;
            }
            $advice[$s['strategy']] = $s['recommendations'] + ['diagnosis' => $s['diagnosis']];
        }
        jsonResponse(['advice' => $advice]);
    }

    if ($method !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }

    $in = json_decode(file_get_contents('php://input'), true);
    if (!is_array($in)) {
        jsonResponse(['error' => 'Invalid JSON'], 400);
    }
    foreach (['trade_id', 'strategy', 'symbol', 'direction', 'entry', 'sl', 'tp', 'close_time'] as $f) {
        if (!isset($in[$f]) || $in[$f] === '') {
            jsonResponse(['error' => "Missing required field: $f"], 400);
        }
    }
    if (ottNum($in['entry']) === null || ottNum($in['sl']) === null || ottNum($in['tp']) === null) {
        jsonResponse(['error' => 'Price fields (entry, sl, tp) must be numeric'], 400);
    }
    if (!in_array($in['direction'], ['BULL', 'BEAR'], true)) {
        jsonResponse(['error' => 'Invalid direction'], 400);
    }
    $closeReason = strtoupper((string) ($in['close_reason'] ?? 'STOP_LOSS'));
    if ($closeReason !== 'STOP_LOSS') {
        jsonResponse(['success' => true, 'skipped' => 'Only STOP_LOSS closes are analysed']);
    }
    $closeTs = strtotime((string) $in['close_time']);
    if ($closeTs === false) {
        jsonResponse(['error' => 'Invalid close_time'], 400);
    }

    $status = (($in['status'] ?? 'TRACKING') === 'COMPLETE') ? 'COMPLETE' : 'TRACKING';
    $oppDir = $in['direction'] === 'BULL' ? 'BEAR' : 'BULL';
    $oppHitTp = !empty($in['opposite_hit_tp']);
    $oppHitSl = !empty($in['opposite_hit_sl']);
    $oppResult = $oppHitTp && !$oppHitSl ? 'WIN' : ($oppHitSl ? 'LOSS' : 'NONE');
    if ($oppHitTp && $oppHitSl) {
        // Both reported: whichever came first decides.
        $tTp = ottNum($in['opposite_time_to_tp_min'] ?? null);
        $tSl = ottNum($in['opposite_time_to_sl_min'] ?? null);
        $oppResult = ($tTp !== null && ($tSl === null || $tTp < $tSl)) ? 'WIN' : 'LOSS';
    }
    $reachedTp = !empty($in['eventual_original_tp']) ? 1 : 0;
    $reversalRatio = ottNum($in['reversal_ratio'] ?? null);
    $classification = $status === 'COMPLETE'
        ? OppositeTradeService::classify((bool) $reachedTp, $oppResult, $reversalRatio)
        : null;

    $stmt = $pdo->prepare(
        "INSERT INTO opposite_trade_tracking (
            user_id, trade_id, signal_id, strategy, symbol,
            original_direction, original_entry, original_result, original_sl, original_tp, lot_size,
            close_reason, close_time,
            opposite_direction, opposite_result, opposite_hit_tp, opposite_hit_sl,
            opposite_mfe, opposite_mae, opposite_time_to_tp_min, opposite_time_to_sl_min,
            eventual_original_tp, minutes_after_sl, pips_beyond_tp, reversal_ratio,
            status, classification
        ) VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?)
        ON DUPLICATE KEY UPDATE
            opposite_result = IF(status != 'COMPLETE', VALUES(opposite_result), opposite_result),
            opposite_hit_tp = IF(status != 'COMPLETE', VALUES(opposite_hit_tp), opposite_hit_tp),
            opposite_hit_sl = IF(status != 'COMPLETE', VALUES(opposite_hit_sl), opposite_hit_sl),
            opposite_mfe = IF(status != 'COMPLETE', VALUES(opposite_mfe), opposite_mfe),
            opposite_mae = IF(status != 'COMPLETE', VALUES(opposite_mae), opposite_mae),
            opposite_time_to_tp_min = IF(status != 'COMPLETE', VALUES(opposite_time_to_tp_min), opposite_time_to_tp_min),
            opposite_time_to_sl_min = IF(status != 'COMPLETE', VALUES(opposite_time_to_sl_min), opposite_time_to_sl_min),
            eventual_original_tp = IF(status != 'COMPLETE', VALUES(eventual_original_tp), eventual_original_tp),
            minutes_after_sl = IF(status != 'COMPLETE', VALUES(minutes_after_sl), minutes_after_sl),
            pips_beyond_tp = IF(status != 'COMPLETE', VALUES(pips_beyond_tp), pips_beyond_tp),
            reversal_ratio = IF(status != 'COMPLETE', VALUES(reversal_ratio), reversal_ratio),
            status = IF(status = 'COMPLETE', status, VALUES(status)),
            classification = IF(status = 'COMPLETE', classification, VALUES(classification))"
    );
    $stmt->execute([
        $userId,
        substr((string) $in['trade_id'], 0, 100),
        isset($in['signal_id']) ? substr((string) $in['signal_id'], 0, 100) : null,
        substr((string) $in['strategy'], 0, 80),
        substr((string) $in['symbol'], 0, 40),
        $in['direction'], (float) $in['entry'], 'LOSS', (float) $in['sl'], (float) $in['tp'], ottNum($in['lot_size'] ?? null),
        $closeReason, gmdate('Y-m-d H:i:s', $closeTs),
        $oppDir, $oppResult, $oppHitTp ? 1 : 0, $oppHitSl ? 1 : 0,
        ottNum($in['opposite_mfe'] ?? null), ottNum($in['opposite_mae'] ?? null),
        ottNum($in['opposite_time_to_tp_min'] ?? null), ottNum($in['opposite_time_to_sl_min'] ?? null),
        $reachedTp, ottNum($in['minutes_after_sl'] ?? null), ottNum($in['pips_beyond_tp'] ?? null), $reversalRatio,
        $status, $classification,
    ]);

    $alerts = [];
    if ($status === 'COMPLETE') {
        $alerts = OppositeTradeService::checkAlerts($pdo, substr((string) $in['strategy'], 0, 80));
    }

    jsonResponse([
        'success' => true,
        'trade_id' => $in['trade_id'],
        'status' => $status,
        'classification' => $classification,
        'diagnosis' => $classification ? OppositeTradeService::diagnosis($classification) : null,
        'alerts' => $alerts,
    ]);
} catch (\Throwable $e) {
    error_log('opposite_tracking.php error: ' . $e->getMessage());
    jsonResponse(['error' => 'Database error'], 500);
}
