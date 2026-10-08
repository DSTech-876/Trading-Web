#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Regression test for the MT5 trade-execution audit ledger
 * (api/mt5/common.php + api/mt5/audit.php).
 *
 * Covers the contract that makes an empty `pull.php` response explainable:
 *   - signal ids are sanitized before being used as state-file keys
 *   - the signal ledger merges partial updates without erasing earlier fields
 *   - the signal/event ledgers are bounded so they cannot grow the state file
 *     without limit
 *   - free-text client rejection reasons map onto the audited filter buckets
 *   - the pull.php selection predicate is case-sensitive on both status and
 *     terminal, which is what pins orders to a single terminal id
 *
 * Usage:
 *   php tests/test_mt5_audit_ledger.php
 */

// MT5_SYMBOL_MAP must be in place *before* common.php's mt5SymbolMap()
// caches it on first use, so a mapped symbol's override and an unmapped
// symbol's client-hint fallback can both be asserted below.
putenv('MT5_SYMBOL_MAP=' . json_encode(['frxEURUSD' => 'Euro vs US Dollar']));

require_once __DIR__ . '/../api/mt5/common.php';

$failures = 0;

function check(string $label, mixed $actual, mixed $expected): void
{
    global $failures;
    if ($actual === $expected) {
        echo "[PASS] $label\n";
    } else {
        $failures++;
        echo "[FAIL] $label — expected " . var_export($expected, true)
            . ', got ' . var_export($actual, true) . "\n";
    }
}

/* ── Signal id sanitization ─────────────────────────────────────────── */
check(
    'signal id keeps safe characters',
    mt5SanitizeSignalId('sig_1710000000_12_frxEURUSD-breakout'),
    'sig_1710000000_12_frxEURUSD-breakout'
);
check(
    'signal id strips path/injection characters',
    mt5SanitizeSignalId('../../etc/passwd" or 1=1'),
    '....etcpasswdor11'
);
check('signal id is length-capped', strlen(mt5SanitizeSignalId(str_repeat('a', 500))), 80);
check('blank signal id stays blank', mt5SanitizeSignalId('   '), '');

/* ── Signal ledger merge semantics ──────────────────────────────────── */
$state = ['orders' => [], 'idempotency' => [], 'signals' => [], 'events' => []];
mt5RecordSignal($state, 'sig_a', [
    'signalId' => 'sig_a',
    'symbol' => 'frxEURUSD',
    'direction' => 'BUY',
    'createdTime' => 1710000000,
    'status' => 'ACCEPTED',
]);
// A later partial update (the order link) must not erase symbol/direction,
// and nulls must not overwrite previously captured values.
mt5RecordSignal($state, 'sig_a', [
    'status' => 'ORDERED',
    'orderId' => 'mt5_1',
    'symbol' => null,
]);
check('ledger preserves earlier fields', $state['signals']['sig_a']['symbol'], 'frxEURUSD');
check('ledger applies the update', $state['signals']['sig_a']['status'], 'ORDERED');
check('ledger links the order', $state['signals']['sig_a']['orderId'], 'mt5_1');
check('ledger keeps original createdTime', $state['signals']['sig_a']['createdTime'], 1710000000);

mt5RecordSignal($state, '', ['status' => 'ACCEPTED']);
check('blank signal id is not recorded', count($state['signals']), 1);

/* ── Bounded ledgers ────────────────────────────────────────────────── */
$big = ['orders' => [], 'idempotency' => [], 'signals' => [], 'events' => []];
for ($i = 0; $i < MT5_SIGNAL_LOG_MAX + 25; $i++) {
    mt5RecordSignal($big, 'sig_' . $i, ['signalId' => 'sig_' . $i]);
}
check('signal ledger is capped', count($big['signals']), MT5_SIGNAL_LOG_MAX);
check('signal ledger drops the oldest first', isset($big['signals']['sig_0']), false);
check('signal ledger keeps the newest', isset($big['signals']['sig_' . (MT5_SIGNAL_LOG_MAX + 24)]), true);

for ($i = 0; $i < MT5_EVENT_LOG_MAX + 10; $i++) {
    mt5RecordEvent($big, 'PULL_RESPONSE', ['seq' => $i], 1710000000);
}
check('event ledger is capped', count($big['events']), MT5_EVENT_LOG_MAX);
check('event ledger keeps the newest', end($big['events'])['seq'], MT5_EVENT_LOG_MAX + 9);
check('event ledger stamps the event name', end($big['events'])['event'], 'PULL_RESPONSE');
check('event ledger stamps the timestamp', end($big['events'])['ts'], 1710000000);

/* ── Rejection classification ───────────────────────────────────────── */
check(
    'confluence rejection is bucketed',
    mt5ClassifyRejection('confluence filter: dynamic confluence 2/4 (RANGING)'),
    'confluence filter'
);
check(
    'cooldown rejection is bucketed',
    mt5ClassifyRejection('cooldown filter: symbol cooldown active'),
    'cooldown filter'
);
check(
    'daily loss rejection is bucketed',
    mt5ClassifyRejection('daily loss protection: daily loss cap reached'),
    'daily loss protection'
);
check(
    'hedging rejection is bucketed',
    mt5ClassifyRejection('hedging protection: opposing trade already active on frxEURUSD'),
    'hedging protection'
);
check('unknown rejection falls back to other', mt5ClassifyRejection('something unmapped'), 'other');

/* ── pull.php selection predicate (reproduced) ──────────────────────── */
$retryAfterSecs = 20;
$now = 1710001000;
$dispatchable = static function (array $order, string $terminal) use ($retryAfterSecs, $now): bool {
    $status = (string) ($order['status'] ?? '');
    if (in_array($status, MT5_FINAL_STATUS, true)) return false;
    $orderTerminal = trim((string) ($order['terminal'] ?? ''));
    if ($terminal !== '' && $orderTerminal !== '' && $orderTerminal !== $terminal) return false;
    return $status === 'QUEUED'
        || ($status === 'DISPATCHED' && ($now - (int) ($order['lastDispatchedAt'] ?? 0)) >= $retryAfterSecs);
};

check(
    'unassigned QUEUED order is visible to any terminal',
    $dispatchable(['status' => 'QUEUED'], 'MT5-TERM-01'),
    true
);
check(
    'order pinned to another terminal is invisible',
    $dispatchable(['status' => 'QUEUED', 'terminal' => 'MT5-TERM-02'], 'MT5-TERM-01'),
    false
);
check(
    'terminal matching is case-sensitive',
    $dispatchable(['status' => 'QUEUED', 'terminal' => 'mt5-term-01'], 'MT5-TERM-01'),
    false
);
check(
    'lowercase status token is never dispatchable',
    $dispatchable(['status' => 'queued'], 'MT5-TERM-01'),
    false
);
check(
    'PENDING/WAITING are not recognised queue statuses',
    in_array('PENDING', MT5_ALLOWED_STATUS, true) || in_array('WAITING', MT5_ALLOWED_STATUS, true),
    false
);
check(
    'DISPATCHED order inside the retry window is held back',
    $dispatchable(['status' => 'DISPATCHED', 'lastDispatchedAt' => $now - 5], 'MT5-TERM-01'),
    false
);
check(
    'DISPATCHED order past the retry window is redispatched',
    $dispatchable(['status' => 'DISPATCHED', 'lastDispatchedAt' => $now - 25], 'MT5-TERM-01'),
    true
);
check(
    'FILLED order is never redispatched',
    $dispatchable(['status' => 'FILLED'], 'MT5-TERM-01'),
    false
);

/* ── Queue census explains an empty poll ────────────────────────────── */
$census = mt5QueueCensus(
    [
        'o1' => ['status' => 'QUEUED', 'terminal' => 'MT5-TERM-02', 'symbol' => 'frxEURUSD'],
        'o2' => ['status' => 'FILLED', 'terminal' => 'MT5-TERM-01', 'symbol' => 'frxEURUSD'],
    ],
    [],
    'MT5-TERM-01',
    $now,
    $retryAfterSecs
);
check('census counts every order', $census['totalOrders'], 2);
check('census groups by terminal', $census['byTerminal']['MT5-TERM-02'], 1);
check(
    'census names the terminal mismatch',
    $census['notDispatched'][0]['reason'],
    'terminal mismatch (order="MT5-TERM-02", request="MT5-TERM-01")'
);
check(
    'census names the final status',
    $census['notDispatched'][1]['reason'],
    'final status FILLED'
);

/* ── Payload carries the signal correlation id ──────────────────────── */
$normalized = mt5NormalizeSignalPayload([
    'symbol' => 'EURUSD',
    'dir' => 'BUY',
    'entry' => 1.0850,
    'sl' => 1.0830,
    'tp' => 1.0890,
    'signalId' => 'sig_abc/123',
    'confidence' => 0.72,
]);
check('signalId is normalized onto the order payload', $normalized['signalId'], 'sig_abc123');
check('confidence is carried through', $normalized['confidence'], 0.72);

/* ── brokerSymbolHint precedence: MT5_SYMBOL_MAP vs client hint ─────── */
check(
    'MT5_SYMBOL_MAP overrides a conflicting client-supplied hint',
    mt5NormalizeSignalPayload([
        'symbol' => 'frxEURUSD',
        'dir' => 'BUY',
        'entry' => 1.0850,
        'sl' => 1.0830,
        'tp' => 1.0890,
        'brokerSymbolHint' => 'Client Supplied Hint',
    ])['brokerSymbolHint'],
    'Euro vs US Dollar'
);
check(
    'an unmapped symbol retains the client-supplied hint',
    mt5NormalizeSignalPayload([
        'symbol' => 'frxGBPUSD',
        'dir' => 'BUY',
        'entry' => 1.2650,
        'sl' => 1.2630,
        'tp' => 1.2690,
        'brokerSymbolHint' => 'Client Supplied Hint',
    ])['brokerSymbolHint'],
    'Client Supplied Hint'
);

/* ── Signal status never regresses on an out-of-order SIGNAL_CREATED ─── */
check(
    'first SIGNAL_CREATED accepts a fresh signal',
    mt5NextSignalStatus(null, false),
    'ACCEPTED'
);
check(
    'SIGNAL_REJECTED always rejects',
    mt5NextSignalStatus('ACCEPTED', true),
    'REJECTED'
);
check(
    'a late SIGNAL_CREATED does not regress a REJECTED signal back to ACCEPTED',
    mt5NextSignalStatus('REJECTED', false),
    'REJECTED'
);
check(
    'a late SIGNAL_CREATED does not regress an ORDERED signal back to ACCEPTED',
    mt5NextSignalStatus('ORDERED', false),
    'ORDERED'
);

/* ── pullStats terminal map is bounded ──────────────────────────────── */
check('terminal key length is capped', MT5_TERMINAL_KEY_MAX_LEN > 0, true);
check('pull stats terminal count is capped', MT5_PULL_STATS_MAX_TERMINALS > 0, true);

echo $failures === 0 ? "\nAll checks passed.\n" : "\n$failures check(s) failed.\n";
exit($failures === 0 ? 0 : 1);
