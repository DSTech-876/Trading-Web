<?php
/**
 * OppositeTradeService
 * ────────────────────
 * Classification, per-strategy statistics, health scoring, signal-improvement
 * recommendations and admin alerting for the opposite_trade_tracking table.
 * Strategy-agnostic: any strategy name stored in the table is analysed.
 */

declare(strict_types=1);

final class OppositeTradeService
{
    public const CLASS_EARLY_ENTRY = 'EARLY_ENTRY';
    public const CLASS_WRONG_DIRECTION = 'WRONG_DIRECTION';
    public const CLASS_HIGH_VOLATILITY_STOP = 'HIGH_VOLATILITY_STOP';
    public const CLASS_VALID_LOSS = 'VALID_LOSS';
    public const CLASS_MISSED_REVERSAL = 'MISSED_REVERSAL';

    public const CLASSIFICATIONS = [
        self::CLASS_EARLY_ENTRY,
        self::CLASS_WRONG_DIRECTION,
        self::CLASS_HIGH_VOLATILITY_STOP,
        self::CLASS_VALID_LOSS,
        self::CLASS_MISSED_REVERSAL,
    ];

    /** Fraction of the SL→TP range price must recover after SL to count as a missed reversal. */
    public const MISSED_REVERSAL_RATIO = 0.5;
    /** Minimum completed SL trades before alerts / recommendations are produced. */
    public const MIN_SAMPLE = 10;
    /** Share of SL trades showing a pattern that makes it "significant". */
    public const ALERT_THRESHOLD = 0.70;
    public const ALERT_COOLDOWN_HOURS = 24;

    /**
     * Auto-assign a classification to a completed SL trade.
     *
     * @param bool       $reachedOrigTp  price later reached the original TP
     * @param string     $oppositeResult WIN | LOSS | NONE
     * @param float|null $reversalRatio  max recovery from SL in the original direction / (TP-SL range)
     */
    public static function classify(bool $reachedOrigTp, string $oppositeResult, ?float $reversalRatio): string
    {
        $oppWins = $oppositeResult === 'WIN';
        if ($reachedOrigTp && $oppWins) {
            return self::CLASS_HIGH_VOLATILITY_STOP; // both sides were swept
        }
        if ($reachedOrigTp) {
            return self::CLASS_EARLY_ENTRY;
        }
        if ($oppWins) {
            return self::CLASS_WRONG_DIRECTION;
        }
        if ($reversalRatio !== null && $reversalRatio >= self::MISSED_REVERSAL_RATIO) {
            return self::CLASS_MISSED_REVERSAL;
        }
        return self::CLASS_VALID_LOSS;
    }

    /** Health diagnosis for a classification (Case A / B / C). */
    public static function diagnosis(string $classification): string
    {
        switch ($classification) {
            case self::CLASS_EARLY_ENTRY:
            case self::CLASS_MISSED_REVERSAL:
                return 'ENTRY_TIMING';
            case self::CLASS_WRONG_DIRECTION:
                return 'DIRECTION';
            case self::CLASS_HIGH_VOLATILITY_STOP:
                return 'VOLATILITY';
            default:
                return 'POOR_SIGNAL_QUALITY';
        }
    }

    /**
     * Per-strategy statistics over completed SL trades.
     *
     * @return array<int,array<string,mixed>>
     */
    public static function strategyStats(PDO $pdo, ?int $userId = null): array
    {
        $where = "status = 'COMPLETE'";
        $params = [];
        if ($userId !== null) {
            $where .= ' AND user_id = ?';
            $params[] = $userId;
        }
        $stmt = $pdo->prepare(
            "SELECT strategy,
                    COUNT(*) AS losses,
                    SUM(eventual_original_tp = 1) AS reached_tp,
                    SUM(opposite_result = 'WIN') AS opp_wins,
                   SUM(opposite_result = 'LOSS') AS opp_losses,
                   SUM(opposite_result <> 'WIN' AND eventual_original_tp = 0) AS neither,
                   AVG(CASE WHEN eventual_original_tp = 1 THEN minutes_after_sl END) AS avg_recovery_min,
                   SUM(classification = 'EARLY_ENTRY') AS early_entry,
                   SUM(classification = 'WRONG_DIRECTION') AS wrong_direction,
                   SUM(classification = 'HIGH_VOLATILITY_STOP') AS high_vol,
                   SUM(classification = 'VALID_LOSS') AS valid_loss,
                   SUM(classification = 'MISSED_REVERSAL') AS missed_reversal
              FROM opposite_trade_tracking
             WHERE $where
          GROUP BY strategy
          ORDER BY losses DESC"
        );
        $stmt->execute($params);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $losses = (int) $r['losses'];
            $reached = (int) $r['reached_tp'];
            $oppWins = (int) $r['opp_wins'];
           $oppLosses = (int) $r['opp_losses'];
           $counts = [
               self::CLASS_EARLY_ENTRY => (int) $r['early_entry'],
               self::CLASS_WRONG_DIRECTION => (int) $r['wrong_direction'],
               self::CLASS_HIGH_VOLATILITY_STOP => (int) $r['high_vol'],
               self::CLASS_VALID_LOSS => (int) $r['valid_loss'],
               self::CLASS_MISSED_REVERSAL => (int) $r['missed_reversal'],
           ];
           arsort($counts);
           $dominant = (string) array_key_first($counts);
           $row = [
               'strategy' => (string) $r['strategy'],
               'losses' => $losses,
               'reachedTpAfterSl' => $reached,
               'oppositeWins' => $oppWins,
               'oppositeLosses' => $oppLosses,
               'neitherWorks' => (int) $r['neither'],
               'reachedTpPct' => $losses ? round($reached / $losses * 100, 1) : 0.0,
               'oppositeWinPct' => $losses ? round($oppWins / $losses * 100, 1) : 0.0,
               'avgRecoveryMinutes' => $r['avg_recovery_min'] !== null ? round((float) $r['avg_recovery_min'], 1) : null,
               'classifications' => $counts,
               'dominantClassification' => $counts[$dominant] > 0 ? $dominant : null,
               'diagnosis' => $counts[$dominant] > 0 ? self::diagnosis($dominant) : null,
           ];
           $row['healthScore'] = self::healthScore($row);
           $row['recommendations'] = self::recommendations($row);
           $out[] = $row;
        }
        return $out;
    }

    /** 0-100: share of SL trades that were genuinely valid (neither side worked). Low = fixable problem. */
    public static function healthScore(array $s): ?float
    {
        if ($s['losses'] < 1) {
            return null;
        }
        return round(($s['classifications'][self::CLASS_VALID_LOSS] / $s['losses']) * 100, 1);
    }

    /**
     * Signal-improvement recommendations / machine-readable filter advice.
     *
     * @return array{filters:array<string,bool>,messages:array<int,string>,sampleSize:int}
     */
    public static function recommendations(array $s): array
    {
        $filters = [
            'delayEntry' => false,
            'requireCandleCloseConfirmation' => false,
            'requireRetestConfirmation' => false,
            'addReversalFilter' => false,
            'requireTrendConfirmation' => false,
            'reduceCounterTrendEntries' => false,
            'widenStopLoss' => false,
        ];
        $messages = [];
        $n = (int) $s['losses'];
        if ($n < self::MIN_SAMPLE) {
            return ['filters' => $filters, 'messages' => ["Need at least " . self::MIN_SAMPLE . " analysed stop-loss trades (have $n)."], 'sampleSize' => $n];
        }
        $timing = ($s['classifications'][self::CLASS_EARLY_ENTRY] + $s['classifications'][self::CLASS_MISSED_REVERSAL]) / $n;
        $direction = $s['classifications'][self::CLASS_WRONG_DIRECTION] / $n;
        $vol = $s['classifications'][self::CLASS_HIGH_VOLATILITY_STOP] / $n;
        $valid = $s['classifications'][self::CLASS_VALID_LOSS] / $n;

        if ($timing >= 0.4) {
            $filters['delayEntry'] = true;
            $filters['requireCandleCloseConfirmation'] = true;
            $messages[] = 'Losses frequently hit the original TP afterwards: delay entry and require candle-close confirmation.';
            if ($timing >= self::ALERT_THRESHOLD) {
                $filters['requireRetestConfirmation'] = true;
                $messages[] = 'Require a retest confirmation before entering.';
            }
        }
        if ($direction >= 0.3) {
            $filters['addReversalFilter'] = true;
            $filters['requireTrendConfirmation'] = true;
            $filters['reduceCounterTrendEntries'] = true;
            $messages[] = 'Opposite trades frequently win: add a reversal filter, require trend confirmation and reduce counter-trend entries.';
        }
        if ($vol >= 0.3) {
            $filters['widenStopLoss'] = true;
            $messages[] = 'Price often sweeps both sides: stops are inside the noise; widen SL or require lower volatility.';
        }
        if ($valid >= 0.5) {
            $messages[] = 'Neither side works for most losses: poor signal quality, tighten the base entry criteria.';
        }
        if (!$messages) {
            $messages[] = 'No dominant failure pattern detected.';
        }
        return ['filters' => $filters, 'messages' => $messages, 'sampleSize' => $n];
    }

    /**
     * Check one strategy's stats and raise admin warnings for significant patterns.
     * Deduplicated per strategy/pattern within ALERT_COOLDOWN_HOURS.
     *
     * @return array<int,string> messages raised
     */
    public static function checkAlerts(PDO $pdo, string $strategy): array
    {
        $raised = [];
        foreach (self::strategyStats($pdo) as $s) {
            if ($s['strategy'] !== $strategy || $s['losses'] < self::MIN_SAMPLE) {
                continue;
            }
            $label = self::strategyLabel($strategy);
            $patterns = [];
            if ($s['reachedTpPct'] / 100 >= self::ALERT_THRESHOLD) {
                $patterns['EARLY_ENTRY'] = [
                    sprintf('%s of %s losses later hit original TP', rtrim(rtrim(number_format($s['reachedTpPct'], 1), '0'), '.') . '%', $label),
                    "$label appears to be entering too early. Review entry timing logic.",
                ];
            }
            if ($s['oppositeWinPct'] / 100 >= self::ALERT_THRESHOLD) {
                $patterns['WRONG_DIRECTION'] = [
                    sprintf('%s%% of %s losses would have won as opposite trades', number_format($s['oppositeWinPct'], 1), $label),
                    "$label appears to be trading in the wrong direction. Review trend/direction filters.",
                ];
            }
            foreach ($patterns as $key => [$title, $message]) {
                $sourceId = $strategy . '|' . $key;
                $pdo->prepare(
                    "INSERT INTO admin_notifications_center
                       (notification_type, category, title, message, severity, source_entity, source_id, related_data, is_read, created_at)
                     VALUES ('warning', 'strategy_health', ?, ?, 'high', 'opposite_trade', ?, ?, 0, NOW())
                     ON DUPLICATE KEY UPDATE
                       created_at = IF(NOW() < DATE_ADD(created_at, INTERVAL " . self::ALERT_COOLDOWN_HOURS . " HOUR), created_at, NOW()),
                       title = IF(NOW() < DATE_ADD(created_at, INTERVAL " . self::ALERT_COOLDOWN_HOURS . " HOUR), title, VALUES(title)),
                       message = IF(NOW() < DATE_ADD(created_at, INTERVAL " . self::ALERT_COOLDOWN_HOURS . " HOUR), message, VALUES(message)),
                       related_data = IF(NOW() < DATE_ADD(created_at, INTERVAL " . self::ALERT_COOLDOWN_HOURS . " HOUR), related_data, VALUES(related_data))"
                )->execute([$title, $message, $sourceId, json_encode($s)]);
                $raised[] = $message;
            }
        }
        return $raised;
    }

    public static function strategyLabel(string $strategy): string
    {
        $map = [
            'grid_scalper_ma' => 'Grid Scalper MA',
            'gridScalperMA' => 'Grid Scalper MA',
            'breakout' => 'Breakout',
            'adaptive_intelligence' => 'Adaptive Intelligence',
            'trend_following' => 'Trend Following',
            'reversal' => 'Reversal',
        ];
        return $map[$strategy] ?? ucwords(str_replace(['_', '-'], ' ', $strategy));
    }
}
