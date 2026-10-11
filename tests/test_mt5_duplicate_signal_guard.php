#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Regression test for mt5FindRecentDuplicateOrder() (api/mt5/common.php),
 * used by api/mt5/signal.php to stop the same trading decision from firing
 * twice when a user runs auto-trade in more than one browser session/tab.
 *
 * Each session mints its own signalId and idempotencyKey (a per-session
 * counter plus a wall-clock timestamp), so signal.php's exact idempotency-key
 * match cannot catch a cross-session duplicate — this fingerprint-based
 * guard (same user/symbol/side/source/strategy/entry/SL/TP within a short
 * recent window) does instead.
 *
 * Usage:
 *   php tests/test_mt5_duplicate_signal_guard.php
 */

require_once __DIR__ . '/../api/mt5/common.php';

$failures = 0;

function check(string $label, bool $condition): void
{
    global $failures;
    if ($condition) {
        echo "[PASS] $label\n";
    } else {
        $failures++;
        echo "[FAIL] $label\n";
    }
}

$baseOrders = [
    'mt5_1' => [
        'orderId' => 'mt5_1',
        'userId' => 7,
        'status' => 'QUEUED',
        'symbol' => 'frxEURUSD',
        'side' => 'BUY',
        'source' => 'breakout',
        'strategyName' => 'orb',
        'entry' => 1.10000,
        'sl' => 1.09800,
        'tp' => 1.10400,
        'createdAt' => 1000,
    ],
];

$normalized = [
    'symbol' => 'frxEURUSD',
    'side' => 'BUY',
    'source' => 'breakout',
    'strategyName' => 'orb',
    'entry' => 1.10001,
    'sl' => 1.09799,
    'tp' => 1.10401,
    'point' => 0.00001,
];

/* A second browser session/tab for the SAME user sends an independently
 * minted signal for the same trade within the dedup window -> flagged. */
check(
    'same user, near-identical trade within window is flagged as duplicate',
    mt5FindRecentDuplicateOrder($baseOrders, 7, $normalized, 1010) !== null
);

/* A different logged-in user placing the same trade must never be blocked
 * by someone else's order. */
check(
    'a different user is never flagged',
    mt5FindRecentDuplicateOrder($baseOrders, 8, $normalized, 1010) === null
);

/* Once the dedup window has elapsed, a new matching signal is a legitimate
 * resubmission (e.g. price revisits the same level later), not a dup. */
check(
    'a match outside the dedup window is not flagged',
    mt5FindRecentDuplicateOrder($baseOrders, 7, $normalized, 1000 + MT5_DUPLICATE_SIGNAL_WINDOW_SECS + 1) === null
);

/* A genuinely different signal (different entry/SL/TP) for the same user
 * must not be blocked. */
$differentPrice = $normalized;
$differentPrice['entry'] = 1.20000;
$differentPrice['sl'] = 1.19800;
$differentPrice['tp'] = 1.20400;
check(
    'a different entry/SL/TP is not flagged',
    mt5FindRecentDuplicateOrder($baseOrders, 7, $differentPrice, 1010) === null
);

/* A REJECTED/CANCELLED/EXPIRED order never reached (or was dropped from) the
 * broker, so it must not block a later resubmission of the same signal. */
$rejectedOrders = $baseOrders;
$rejectedOrders['mt5_1']['status'] = 'REJECTED';
check(
    'a REJECTED order does not block resubmission',
    mt5FindRecentDuplicateOrder($rejectedOrders, 7, $normalized, 1010) === null
);

/* A FILLED order means a real trade already happened — a matching signal
 * shortly after must still be blocked. */
$filledOrders = $baseOrders;
$filledOrders['mt5_1']['status'] = 'FILLED';
check(
    'a FILLED order still blocks a matching duplicate',
    mt5FindRecentDuplicateOrder($filledOrders, 7, $normalized, 1010) !== null
);

if ($failures > 0) {
    echo "\n$failures check(s) failed.\n";
    exit(1);
}

echo "\nAll checks passed.\n";
exit(0);
