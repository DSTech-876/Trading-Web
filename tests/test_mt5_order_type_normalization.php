#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Regression test for mt5ResolveOrderType()'s normalization contract
 * (api/mt5/common.php).
 *
 * Covers the behavior called out in PR #389 review thread
 * (https://github.com/DSTech-876/Trading-Web/pull/389#pullrequestreview-5423544021):
 * a client-supplied `orderType` that is valid but direction-mismatched with
 * `side` is NOT honored and is NOT rejected — it is silently discarded and a
 * fresh order type is derived from side/entry/currentPrice instead.
 *
 * Usage:
 *   php tests/test_mt5_order_type_normalization.php
 */

require_once __DIR__ . '/../api/mt5/common.php';

$failures = 0;

function check(string $label, string $actual, string $expected): void
{
    global $failures;
    if ($actual === $expected) {
        echo "[PASS] $label\n";
    } else {
        $failures++;
        echo "[FAIL] $label — expected '$expected', got '$actual'\n";
    }
}

/* A matching, valid orderType is always honored as-is, even when normal
 * derivation would pick the opposite pending type for these prices. */
check(
    'matching BUY_LIMIT is honored',
    mt5ResolveOrderType('BUY', 1.090, 1.085, 'BUY_LIMIT'),
    'BUY_LIMIT'
);
check(
    'matching SELL_STOP is honored',
    mt5ResolveOrderType('SELL', 1.090, 1.085, 'SELL_STOP'),
    'SELL_STOP'
);

/* A direction-mismatched orderType is discarded and re-derived from
 * side/entry/currentPrice, rather than being honored or rejected. */
check(
    'mismatched SELL_LIMIT on a BUY side is re-derived, not honored',
    mt5ResolveOrderType('BUY', 1.085, 1.084, 'SELL_LIMIT'),
    'BUY_STOP'
);
check(
    'mismatched BUY_STOP on a SELL side is re-derived, not honored',
    mt5ResolveOrderType('SELL', 1.085, 1.090, 'BUY_STOP'),
    'SELL_STOP'
);

/* An unrecognized/garbage orderType is likewise discarded and derived. */
check(
    'unknown orderType string falls back to derivation',
    mt5ResolveOrderType('BUY', 1.085, 1.085, 'NOT_A_TYPE'),
    'BUY_MARKET'
);

/* No orderType / no currentPrice falls back to a MARKET order. */
check(
    'missing currentPrice falls back to BUY_MARKET',
    mt5ResolveOrderType('BUY', 1.085, null, ''),
    'BUY_MARKET'
);
check(
    'missing currentPrice falls back to SELL_MARKET',
    mt5ResolveOrderType('SELL', 1.085, null, ''),
    'SELL_MARKET'
);

if ($failures > 0) {
    echo "\n$failures check(s) failed.\n";
    exit(1);
}

echo "\nAll checks passed.\n";
exit(0);
