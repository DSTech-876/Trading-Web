<?php
/**
 * POST /api/mt5/signal_log.php
 * ────────────────────────────
 * Server-side signal lifecycle ledger for the MT5 bridge audit.
 *
 * The signal engine runs entirely in the browser (indicator/indicator.js).
 * Until this endpoint existed, a signal that was generated and then dropped
 * by one of the client-side risk filters left **no server-side trace at all**
 * — the only record was an addLog() line in the page, which disappears on
 * reload. That is precisely why `pull.php` returning `{"count":0}` was
 * unexplainable: the server genuinely had never been told the signal existed.
 *
 * This endpoint accepts two events from the signal engine:
 *   - SIGNAL_CREATED  — a signal passed generation + validation and is about
 *                       to be dispatched to signal.php.
 *   - SIGNAL_REJECTED — a signal was generated but a filter discarded it;
 *                       the filter name and raw reason are recorded.
 *
 * Records land in the same flock()-guarded JSON state file as the order queue
 * so audit.php can join signals to orders by `signalId`.
 */

declare(strict_types=1);
require_once __DIR__ . '/common.php';

requirePost();
if (!rateLimit(240, 60)) {
    jsonResponse(['error' => 'Rate limit exceeded'], 429);
}

$userId = mt5AuthUserId();
$body = getJsonBody();

$entriesRaw = is_array($body['entries'] ?? null) ? $body['entries'] : [$body];

$valid = [];
$errors = [];
foreach ($entriesRaw as $raw) {
    if (!is_array($raw)) {
        $errors[] = ['reason' => 'not an object'];
        continue;
    }
    $event = strtoupper(trim((string) ($raw['event'] ?? '')));
    if ($event !== 'SIGNAL_CREATED' && $event !== 'SIGNAL_REJECTED') {
        $errors[] = ['reason' => 'event must be SIGNAL_CREATED or SIGNAL_REJECTED', 'event' => $event];
        continue;
    }
    $signalId = mt5SanitizeSignalId((string) ($raw['signalId'] ?? ''));
    if ($signalId === '') {
        $errors[] = ['reason' => 'signalId is required', 'event' => $event];
        continue;
    }
    $symbol = substr(trim((string) ($raw['symbol'] ?? '')), 0, 40);
    $dirRaw = strtoupper(trim((string) ($raw['direction'] ?? $raw['dir'] ?? '')));
    $direction = match ($dirRaw) {
        'BUY', 'BULL', 'LONG' => 'BUY',
        'SELL', 'BEAR', 'SHORT' => 'SELL',
        default => '',
    };
    $reason = substr(trim((string) ($raw['reason'] ?? '')), 0, 300);
    if ($event === 'SIGNAL_REJECTED' && $reason === '') {
        $errors[] = ['reason' => 'reason is required for SIGNAL_REJECTED', 'signalId' => $signalId];
        continue;
    }

    $valid[] = [
        'event' => $event,
        'signalId' => $signalId,
        'symbol' => $symbol,
        'direction' => $direction,
        'confidence' => is_numeric($raw['confidence'] ?? null) ? (float) $raw['confidence'] : null,
        'source' => substr(trim((string) ($raw['source'] ?? '')), 0, 40),
        'strategyName' => substr(trim((string) ($raw['strategyName'] ?? '')), 0, 80),
        'entry' => is_numeric($raw['entry'] ?? null) ? (float) $raw['entry'] : null,
        'sl' => is_numeric($raw['sl'] ?? null) ? (float) $raw['sl'] : null,
        'tp' => is_numeric($raw['tp'] ?? null) ? (float) $raw['tp'] : null,
        'reason' => $reason !== '' ? $reason : null,
        'filter' => $event === 'SIGNAL_REJECTED' ? mt5ClassifyRejection($reason) : null,
    ];
}

if ($valid === []) {
    jsonResponse(['error' => 'No valid signal log entries provided', 'validationErrors' => $errors], 422);
}

$now = time();
$recorded = mt5WithStateLock(function (array &$state) use ($valid, $userId, $now): int {
    foreach ($valid as $entry) {
        $isRejection = $entry['event'] === 'SIGNAL_REJECTED';
        // SIGNAL_CREATED and SIGNAL_REJECTED are sent as independent
        // fire-and-forget requests and can therefore acquire the state lock
        // out of order. A late SIGNAL_CREATED must never regress a signal
        // that has since moved past ACCEPTED (REJECTED, or ORDERED once
        // signal.php created an order), or the audit would lose the
        // rejection and report the wrong root cause.
        $existingStatus = $state['signals'][$entry['signalId']]['status'] ?? null;
        $status = mt5NextSignalStatus($existingStatus, $isRejection);
        mt5RecordSignal($state, $entry['signalId'], [
            'signalId' => $entry['signalId'],
            'userId' => $userId,
            'symbol' => $entry['symbol'] !== '' ? $entry['symbol'] : null,
            'direction' => $entry['direction'] !== '' ? $entry['direction'] : null,
            'confidence' => $entry['confidence'],
            'source' => $entry['source'] !== '' ? $entry['source'] : null,
            'strategyName' => $entry['strategyName'] !== '' ? $entry['strategyName'] : null,
            'entry' => $entry['entry'],
            'sl' => $entry['sl'],
            'tp' => $entry['tp'],
            // createdTime is only stamped once; a later rejection for the same
            // signal must not overwrite when the signal was generated.
            'createdTime' => $state['signals'][$entry['signalId']]['createdTime'] ?? $now,
            'status' => $status,
            'rejectionReason' => $isRejection ? $entry['reason'] : null,
            'rejectionFilter' => $isRejection ? $entry['filter'] : null,
        ]);
        mt5RecordEvent($state, $entry['event'], [
            'signalId' => $entry['signalId'],
            'symbol' => $entry['symbol'] !== '' ? $entry['symbol'] : null,
            'direction' => $entry['direction'] !== '' ? $entry['direction'] : null,
            'reason' => $entry['reason'],
            'filter' => $entry['filter'],
        ], $now);
    }
    return count($valid);
});

jsonResponse([
    'ok' => true,
    'recorded' => $recorded,
    'validationErrors' => $errors,
]);
