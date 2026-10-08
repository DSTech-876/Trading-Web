<?php
/**
 * api/mt5/common.php
 * ──────────────────
 * Shared helpers for MT5 bridge endpoints.
 */

declare(strict_types=1);
require_once __DIR__ . '/../config.php';

const MT5_ALLOWED_ORDER_TYPES = [
    'BUY_MARKET', 'SELL_MARKET',
    'BUY_LIMIT', 'SELL_LIMIT',
    'BUY_STOP', 'SELL_STOP',
];

const MT5_ALLOWED_STATUS = [
    'QUEUED', 'DISPATCHED', 'RECEIVED', 'FILLED', 'MODIFIED', 'REJECTED', 'CANCELLED', 'EXPIRED',
];

const MT5_FINAL_STATUS = ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

function mt5StoragePath(): string
{
    return rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR)
        . DIRECTORY_SEPARATOR
        . 'itguru_mt5_bridge_' . sha1(__DIR__) . '.json';
}

/**
 * @template T
 * @param callable(array<string,mixed>):T $callback
 * @return T
 */
function mt5WithStateLock(callable $callback): mixed
{
    $path = mt5StoragePath();
    $fh = fopen($path, 'c+');
    if ($fh === false) {
        throw new RuntimeException('Cannot open MT5 bridge storage file');
    }

    if (!flock($fh, LOCK_EX)) {
        fclose($fh);
        throw new RuntimeException('Cannot lock MT5 bridge storage file');
    }

    $raw = stream_get_contents($fh);
    $state = mt5DecodeState(is_string($raw) ? $raw : '', $path);

    if (!empty($state['__corrupt'])) {
        flock($fh, LOCK_UN);
        fclose($fh);
        throw new RuntimeException('Refusing to mutate MT5 bridge state: stored payload is corrupt');
    }

    $result = $callback($state);

    $state['updatedAt'] = time();
    $encoded = json_encode($state, JSON_UNESCAPED_SLASHES);
    if ($encoded === false) {
        flock($fh, LOCK_UN);
        fclose($fh);
        throw new RuntimeException('Cannot encode MT5 bridge state');
    }

    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, $encoded);
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    return $result;
}

/**
 * Decodes the persisted bridge state.
 *
 * A non-empty payload that does not decode into an array means the queue file
 * is corrupt (partial write, disk-full truncation, concurrent clobber). The
 * previous behaviour (`json_decode(...) ?: []`) silently replaced it with an
 * empty queue, so every QUEUED order vanished without a single log line and
 * pull.php reported `count: 0` forever with no trace of why. Now the corrupt
 * payload is preserved next to the state file and the event is logged as
 * STATE_CORRUPT so the loss is attributable.
 *
 * @return array<string,mixed>
 */
function mt5DecodeState(string $raw, string $path): array
{
    $state = [];
    if ($raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $state = $decoded;
        } else {
            $preserved = @copy($path, $path . '.corrupt');
            mt5LogDiagnostic('state', [
                'event' => 'STATE_CORRUPT',
                'path' => $path,
                'bytes' => strlen($raw),
                'jsonError' => json_last_error_msg(),
                'preservedCopy' => $preserved ? ($path . '.corrupt') : null,
                'preservationSucceeded' => $preserved,
            ]);
            $state['__corrupt'] = true;
        }
    }
    if (!isset($state['orders']) || !is_array($state['orders'])) $state['orders'] = [];
    if (!isset($state['idempotency']) || !is_array($state['idempotency'])) $state['idempotency'] = [];
    if (!isset($state['signals']) || !is_array($state['signals'])) $state['signals'] = [];
    if (!isset($state['events']) || !is_array($state['events'])) $state['events'] = [];
    return $state;
}

/**
 * @return array<string,mixed>
 */
function mt5ReadState(): array
{
    $path = mt5StoragePath();
    if (!is_file($path)) {
        return ['orders' => [], 'idempotency' => [], 'signals' => [], 'events' => []];
    }
    $raw = @file_get_contents($path);
    return mt5DecodeState(is_string($raw) ? $raw : '', $path);
}

/**
 * Reads the bridge state under a shared lock and returns a watermark
 * timestamp captured while that lock is still held, so the returned snapshot
 * and watermark are ordered with any concurrent writer.
 *
 * `mt5WithStateLock()` writers hold an exclusive lock while they mutate
 * `updatedAt`-stamped orders and flush the file. If a reader captures its own
 * "now" before acquiring any lock (or reads the file without one at all), a
 * writer can land in between the timestamp capture and the actual read —
 * or even in the same second — making the returned watermark newer than the
 * snapshot it is paired with. A later poll that filters on `since > that
 * watermark` would then permanently skip the transition it raced with.
 * Acquiring a shared lock first forces us to wait out any in-flight writer,
 * and capturing the timestamp while still holding that lock guarantees no
 * writer can sneak a state change in before we report our watermark.
 *
 * @return array{0: array<string,mixed>, 1: int} [$state, $watermark]
 */
function mt5ReadStateLockedWithWatermark(): array
{
    $path = mt5StoragePath();
    $fh = fopen($path, 'c+');
    if ($fh === false) {
        throw new RuntimeException('Cannot open MT5 bridge storage file');
    }
    if (!flock($fh, LOCK_SH)) {
        fclose($fh);
        throw new RuntimeException('Cannot lock MT5 bridge storage file');
    }

    $raw = stream_get_contents($fh);
    // Captured while the shared lock is held: no exclusive-lock writer can
    // be mutating `updatedAt` concurrently, so this timestamp and the raw
    // snapshot above are consistently ordered.
    $watermark = max(0, time() - 1);

    flock($fh, LOCK_UN);
    fclose($fh);

    $state = mt5DecodeState(is_string($raw) ? $raw : '', $path);
    return [$state, $watermark];
}

/**
 * Builds a census of the queue so an *empty* pull.php response is explainable
 * without shell access to the server: how many orders exist at all, how they
 * break down by status, which terminals they are pinned to, and — for every
 * order that was not dispatched — the exact reason it was skipped.
 *
 * @param array<string,mixed> $orders           $state['orders']
 * @param list<string>        $dispatchedIds    order ids actually returned
 * @param bool                $halted           true when dispatch is suppressed
 * @return array<string,mixed>
 */
function mt5QueueCensus(array $orders, array $dispatchedIds, string $terminal, int $now, int $retryAfterSecs, bool $halted = false): array
{
    $dispatched = array_flip($dispatchedIds);
    $byStatus = [];
    $byTerminal = [];
    $skipped = [];

    foreach ($orders as $orderId => $order) {
        if (!is_array($order)) continue;
        $status = (string) ($order['status'] ?? 'UNKNOWN');
        $byStatus[$status] = ($byStatus[$status] ?? 0) + 1;

        $orderTerminal = trim((string) ($order['terminal'] ?? ''));
        $terminalKey = $orderTerminal === '' ? '(unassigned)' : $orderTerminal;
        $byTerminal[$terminalKey] = ($byTerminal[$terminalKey] ?? 0) + 1;

        if (isset($dispatched[(string) $orderId])) continue;

        if (in_array($status, MT5_FINAL_STATUS, true)) {
            $reason = 'final status ' . $status;
        } elseif ($halted) {
            $reason = 'dispatch halted (MT5_TRADING_HALTED)';
        } elseif ($terminal !== '' && $orderTerminal !== '' && $orderTerminal !== $terminal) {
            $reason = sprintf('terminal mismatch (order="%s", request="%s")', $orderTerminal, $terminal);
        } elseif ($status === 'QUEUED') {
            $reason = 'limit reached before this order was reached';
        } elseif ($status === 'DISPATCHED') {
            $age = $now - (int) ($order['lastDispatchedAt'] ?? 0);
            $reason = $age >= $retryAfterSecs
                ? 'limit reached before this order was reached'
                : sprintf('awaiting retry window (%ds of %ds elapsed)', $age, $retryAfterSecs);
        } else {
            $reason = 'in-flight at EA (status ' . $status . ')';
        }

        $skipped[] = [
            'orderId' => (string) $orderId,
            'symbol' => $order['symbol'] ?? null,
            'status' => $status,
            'terminal' => $orderTerminal !== '' ? $orderTerminal : null,
            'reason' => $reason,
        ];
    }

    return [
        'totalOrders' => count($orders),
        'byStatus' => $byStatus,
        'byTerminal' => $byTerminal,
        'notDispatched' => $skipped,
    ];
}

/**
 * Collapses a `notDispatched` list into a bounded summary for logging: a
 * capped sample of individual orders plus counts grouped by skip reason, so
 * a queue with thousands of retained orders still produces a log line of
 * roughly constant size instead of one entry per order.
 *
 * @param list<array<string,mixed>> $skipped
 * @return array{sample: list<array<string,mixed>>, total: int, truncated: bool, byReason: array<string,int>}
 */
function mt5SummarizeNotDispatched(array $skipped, int $maxSample = 20): array
{
    $byReason = [];
    foreach ($skipped as $row) {
        $reason = (string) ($row['reason'] ?? 'unknown');
        $byReason[$reason] = ($byReason[$reason] ?? 0) + 1;
    }
    return [
        'sample' => array_slice($skipped, 0, $maxSample),
        'total' => count($skipped),
        'truncated' => count($skipped) > $maxSample,
        'byReason' => $byReason,
    ];
}

/**
 * Gates pull.php's detailed diagnostic log so a steady-state queue does not
 * produce a log line on every poll. The EA's default 2s poll interval would
 * otherwise emit roughly 43,200 entries per terminal per day even when
 * nothing changed between polls, with no pruning path for the resulting log
 * file. A per-terminal signature (built from the event type, status/terminal
 * breakdown, and skip-reason counts) is persisted between requests; a
 * detailed log is only emitted when that signature changes or when
 * `$heartbeatSecs` has elapsed since the last log, so operators still get a
 * periodic "still alive" entry even in a fully idle steady state.
 */
function mt5ShouldLogPullEvent(string $terminal, string $signature, int $now, int $heartbeatSecs = 300): bool
{
    $path = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR)
        . DIRECTORY_SEPARATOR
        . 'itguru_mt5_pull_log_state_' . sha1(__DIR__) . '.json';
    $fh = fopen($path, 'c+');
    if ($fh === false) {
        return true;
    }
    if (!flock($fh, LOCK_EX)) {
        fclose($fh);
        return true;
    }

    $raw = stream_get_contents($fh);
    $all = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    if (!is_array($all)) $all = [];

    $key = $terminal !== '' ? $terminal : '(unassigned)';
    $prev = $all[$key] ?? null;
    $changed = !is_array($prev) || (($prev['signature'] ?? null) !== $signature);
    $stale = !is_array($prev) || ($now - (int) ($prev['loggedAt'] ?? 0)) >= $heartbeatSecs;
    $shouldLog = $changed || $stale;

    if ($shouldLog) {
        $all[$key] = ['signature' => $signature, 'loggedAt' => $now];
        $encoded = json_encode($all, JSON_UNESCAPED_SLASHES);
        if ($encoded !== false) {
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, $encoded);
            fflush($fh);
        }
    }

    flock($fh, LOCK_UN);
    fclose($fh);
    return $shouldLog;
}

/**
 * Structured diagnostic logger for the MT5 bridge pipeline. Writes to PHP's
 * error_log AND to a dedicated file under sys_get_temp_dir() (so logs are
 * available even when error_log is redirected/disabled), tagged with the
 * endpoint, so HTTP 400s, status-sync failures, and symbol-resolution issues
 * can be traced end-to-end: raw request body, response body/code, endpoint
 * URL, signal id, and mapped symbol.
 *
 * @param array<string,mixed> $context
 */
function mt5LogDiagnostic(string $endpoint, array $context): void
{
    $line = sprintf(
        '[%s] endpoint=%s %s',
        gmdate('Y-m-d\TH:i:s\Z'),
        $endpoint,
        json_encode($context, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR)
    );
    error_log('[MT5_BRIDGE] ' . $line);

    $path = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR)
        . DIRECTORY_SEPARATOR
        . 'itguru_mt5_bridge_diagnostics_' . sha1(__DIR__) . '.log';
    $lockPath = $path . '.lock';
    // Serialize the size check, rotation, and append with a dedicated lock
    // file (distinct from the log being rotated) so two concurrent requests
    // cannot both observe an oversized file and race to rotate it, which
    // would otherwise let the second rotation discard the first's archive.
    $lockFh = fopen($lockPath, 'c');
    if ($lockFh !== false && flock($lockFh, LOCK_EX)) {
        // Cap the file so a long-running bridge cannot fill the temp filesystem.
        clearstatcache(true, $path);
        if (is_file($path) && (int) @filesize($path) > 1048576) {
            @rename($path, $path . '.1');
        }
        @file_put_contents($path, $line . "\n", FILE_APPEND);
        flock($lockFh, LOCK_UN);
        fclose($lockFh);
    } else {
        // Fall back to best-effort unsynchronized append if the lock file
        // cannot be opened or advisory locking is unavailable.
        if ($lockFh !== false) {
            fclose($lockFh);
        }
        clearstatcache(true, $path);
        if (is_file($path) && (int) @filesize($path) > 1048576) {
            @rename($path, $path . '.1');
        }
        @file_put_contents($path, $line . "\n", FILE_APPEND | LOCK_EX);
    }
}

/**
 * Optional admin-configured symbol map (MT5_SYMBOL_MAP env var, JSON object)
 * translating internal/TradingView instrument codes (e.g. "stpRNG5") to the
 * broker's actual MarketWatch symbol name (e.g. "Step Index 500"). Surfaced
 * to the EA as `brokerSymbolHint` via pull.php so ITGuruMt5Bridge.mq5's
 * ResolveBrokerSymbol() can try it before falling back to its own alias
 * map/fuzzy MarketWatch scan. Example:
 *   MT5_SYMBOL_MAP={"stpRNG5":"Step Index 500","EURUSD":"EURUSD.m"}
 *
 * @return array<string,string>
 */
function mt5SymbolMap(): array
{
    static $map = null;
    if ($map !== null) return $map;

    $raw = env('MT5_SYMBOL_MAP', '');
    $decoded = $raw !== '' ? json_decode($raw, true) : null;
    $map = [];
    if (is_array($decoded)) {
        foreach ($decoded as $k => $v) {
            if (is_string($k) && is_string($v) && $v !== '') {
                $map[$k] = $v;
            }
        }
    } elseif ($raw !== '') {
        error_log('[MT5_BRIDGE] MT5_SYMBOL_MAP env var is not valid JSON: ' . json_last_error_msg());
    }
    return $map;
}

/** Case-insensitive lookup into mt5SymbolMap(); returns null if unmapped. */
function mt5ResolveBrokerSymbolHint(string $symbol): ?string
{
    foreach (mt5SymbolMap() as $code => $brokerSymbol) {
        if (strcasecmp($code, $symbol) === 0) return $brokerSymbol;
    }
    return null;
}

function mt5AuthUserId(): int
{
    return authenticateUserFromToken();
}

/**
 * Global kill-switch so an operator can halt all new MT5 dispatch instantly
 * (e.g. during an incident) without redeploying the EA. Checked by pull.php
 * and surfaced to the EA so it can stop sending new trades while still
 * reporting status for in-flight orders.
 */
function mt5IsHalted(): bool
{
    $raw = strtolower(trim(env('MT5_TRADING_HALTED', 'false')));
    return in_array($raw, ['1', 'true', 'yes', 'on'], true);
}

function mt5HaltReason(): string
{
    $reason = trim(env('MT5_TRADING_HALT_REASON', ''));
    return $reason !== '' ? $reason : 'Trading halted by operator (MT5_TRADING_HALTED)';
}

/**
 * Admin-editable daily loss limit %, stored in risk_settings (single row,
 * id=1). Surfaced to the EA via pull.php so ITGuruMt5Bridge.mq5 can honor
 * admin changes without recompiling, and to the web client via
 * risk_config.php instead of a hardcoded constant. Falls back to 5.0 on any
 * DB error so a misconfigured/unreachable DB never breaks signal dispatch.
 */
function mt5GetDailyLossLimitPct(): float
{
    static $cached = null;
    if ($cached !== null) return $cached;

    try {
        $pdo = getDB();
        $stmt = $pdo->query('SELECT daily_loss_limit_pct FROM risk_settings WHERE id = 1');
        $row = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : false;
        if (is_array($row) && isset($row['daily_loss_limit_pct'])) {
            $pct = (float) $row['daily_loss_limit_pct'];
            if ($pct > 0) {
                $cached = $pct;
                return $cached;
            }
        }
    } catch (\Throwable $e) {
        error_log('mt5GetDailyLossLimitPct DB error: ' . $e->getMessage());
    }

    $cached = 5.0;
    return $cached;
}

/**
 * @param array<string,mixed> $body
 */
function mt5RequireBridgeKey(array $body = []): void
{
    $expected = env('MT5_BRIDGE_KEY');
    if ($expected === '') {
        jsonResponse(['error' => 'MT5 bridge is not configured'], 503);
    }

    $incoming = (string) ($_SERVER['HTTP_X_MT5_BRIDGE_KEY'] ?? '');
    if ($incoming === '') {
        $incoming = (string) ($_GET['bridge_key'] ?? $body['bridge_key'] ?? '');
    }
    if ($incoming === '' || !hash_equals($expected, $incoming)) {
        jsonResponse(['error' => 'Unauthorized bridge key'], 403);
    }
}

function mt5InferDigits(string $symbol, float $price): int
{
    $s = strtoupper($symbol);
    if (str_contains($s, 'JPY')) return 3;
    if (str_contains($s, 'XAU') || str_contains($s, 'XAG')) return 2;
    if (str_starts_with($s, 'FRX') || preg_match('/^[A-Z]{6}$/', $s) === 1) return 5;

    $txt = rtrim(rtrim(sprintf('%.8F', $price), '0'), '.');
    $parts = explode('.', $txt);
    $decimals = isset($parts[1]) ? strlen($parts[1]) : 2;
    return max(2, min(8, $decimals));
}

/**
 * Resolves the final order type dispatched to MT5, normalizing against the
 * resolved trade `$side` (which is itself derived from `dir`/`direction` and
 * is treated as the source of truth for trade direction).
 *
 * Contract:
 *  - A client-supplied `$requested` order type is only honored when it is one
 *    of MT5_ALLOWED_ORDER_TYPES AND its BUY_/SELL_ prefix matches `$side`.
 *    Without this check, a mismatched payload (e.g. side=BUY with a
 *    stale/incorrect orderType=SELL_LIMIT) would be placed as-is, sending a
 *    trade in the wrong direction while every other field (side, sl/tp
 *    orientation) still reflects the original side.
 *  - A direction-mismatched `$requested` value is NOT honored and is NOT
 *    rejected either: it is silently discarded and a fresh order type is
 *    derived from `$side`, `$entry`, and `$currentPrice` using the same
 *    pending/market rules as when no order type was supplied at all (see
 *    below). Callers that need to detect/reject a mismatched order type
 *    must compare the canonicalized input (trim + strtoupper of
 *    `$requested`, since valid requests like `buy_limit` are accepted and
 *    returned as `BUY_LIMIT`) against the returned value themselves, but
 *    only when that canonicalized input is non-empty: an empty canonicalized
 *    `$requested` (i.e. no order type was supplied) is the normal, supported
 *    case and must not be treated as a mismatch, even though the returned
 *    value will differ from it. This function never surfaces a validation
 *    error for a mismatch.
 *  - When no (or an invalid) order type is requested, the type is derived
 *    from the entry price relative to `$currentPrice`: entry beyond current
 *    price yields a STOP order, entry before current price yields a LIMIT
 *    order, and an equal (or missing `$currentPrice`) entry yields a MARKET
 *    order.
 */
function mt5ResolveOrderType(string $side, float $entry, ?float $currentPrice, string $requested = ''): string
{
    $req = strtoupper(trim($requested));
    if ($req !== '' && in_array($req, MT5_ALLOWED_ORDER_TYPES, true) && str_starts_with($req, $side . '_')) {
        return $req;
    }

    if ($currentPrice === null || $currentPrice <= 0) {
        return $side === 'BUY' ? 'BUY_MARKET' : 'SELL_MARKET';
    }
    if ($side === 'BUY') {
        if ($entry > $currentPrice) return 'BUY_STOP';
        if ($entry < $currentPrice) return 'BUY_LIMIT';
        return 'BUY_MARKET';
    }
    if ($entry < $currentPrice) return 'SELL_STOP';
    if ($entry > $currentPrice) return 'SELL_LIMIT';
    return 'SELL_MARKET';
}

/**
 * @param array<string,mixed> $constraints
 * @return array<string,float>
 */
function mt5NormalizeConstraints(array $constraints): array
{
    $minStopPoints = max(0.0, (float) ($constraints['minStopPoints'] ?? 0));
    $freezePoints  = max(0.0, (float) ($constraints['freezePoints'] ?? 0));
    $lotStep       = max(0.00001, (float) ($constraints['lotStep'] ?? 0.01));
    $minLot        = max($lotStep, (float) ($constraints['minLot'] ?? $lotStep));
    $maxLot        = max($minLot, (float) ($constraints['maxLot'] ?? 100));
    return [
        'minStopPoints' => $minStopPoints,
        'freezePoints' => $freezePoints,
        'lotStep' => $lotStep,
        'minLot' => $minLot,
        'maxLot' => $maxLot,
    ];
}

/**
 * @param array<string,mixed> $body
 * @return array<string,mixed>
 */
function mt5NormalizeSignalPayload(array $body): array
{
    $symbol = trim((string) ($body['symbol'] ?? ''));
    if ($symbol === '') {
        throw new InvalidArgumentException('symbol is required');
    }

    $dirRaw = strtoupper(trim((string) ($body['dir'] ?? $body['direction'] ?? '')));
    $side = match ($dirRaw) {
        'BUY', 'BULL', 'LONG' => 'BUY',
        'SELL', 'BEAR', 'SHORT' => 'SELL',
        default => '',
    };
    if ($side === '') {
        throw new InvalidArgumentException('dir must be BUY/SELL or BULL/BEAR');
    }

    $entry = (float) ($body['entry'] ?? 0);
    $sl = (float) ($body['sl'] ?? 0);
    $tp = (float) ($body['tp'] ?? 0);
    if ($entry <= 0 || $sl <= 0 || $tp <= 0) {
        throw new InvalidArgumentException('entry, sl, tp must be positive numbers');
    }

    if ($side === 'BUY') {
        if ($sl >= $entry) throw new InvalidArgumentException('BUY orders require sl below entry');
        if ($tp <= $entry) throw new InvalidArgumentException('BUY orders require tp above entry');
    } else {
        if ($sl <= $entry) throw new InvalidArgumentException('SELL orders require sl above entry');
        if ($tp >= $entry) throw new InvalidArgumentException('SELL orders require tp below entry');
    }

    $currentPrice = isset($body['currentPrice']) ? (float) $body['currentPrice'] : null;
    if ($currentPrice !== null && $currentPrice <= 0) $currentPrice = null;

    $digits = mt5InferDigits($symbol, $entry);
    $point  = pow(10, -$digits);
    $entry  = round($entry, $digits);
    $sl     = round($sl, $digits);
    $tp     = round($tp, $digits);
    if ($currentPrice !== null) $currentPrice = round($currentPrice, $digits);

    $constraints = mt5NormalizeConstraints(
        is_array($body['constraints'] ?? null) ? $body['constraints'] : []
    );

    $slPoints = abs($entry - $sl) / $point;
    $tpPoints = abs($tp - $entry) / $point;
    if ($constraints['minStopPoints'] > 0) {
        if ($slPoints < $constraints['minStopPoints']) {
            throw new InvalidArgumentException('SL distance is below broker minimum stop distance');
        }
        if ($tpPoints < $constraints['minStopPoints']) {
            throw new InvalidArgumentException('TP distance is below broker minimum stop distance');
        }
    }

    $orderType = mt5ResolveOrderType($side, $entry, $currentPrice, (string) ($body['orderType'] ?? ''));
    if (($orderType === 'BUY_LIMIT' || $orderType === 'BUY_STOP' || $orderType === 'SELL_LIMIT' || $orderType === 'SELL_STOP')
        && $constraints['freezePoints'] > 0
        && $currentPrice !== null
    ) {
        $entryGapPoints = abs($entry - $currentPrice) / $point;
        if ($entryGapPoints < $constraints['freezePoints']) {
            throw new InvalidArgumentException('Entry is inside broker freeze level');
        }
    }

    $lot = (float) ($body['lot'] ?? $body['lotSize'] ?? $constraints['minLot']);
    if ($lot <= 0) $lot = $constraints['minLot'];
    $lot = round($lot / $constraints['lotStep']) * $constraints['lotStep'];
    $lot = min($constraints['maxLot'], max($constraints['minLot'], $lot));
    $lot = (float) number_format($lot, 4, '.', '');

    $source = trim((string) ($body['source'] ?? 'breakout'));
    $strategyName = trim((string) ($body['strategyName'] ?? ''));
    $idempotencyKey = trim((string) ($body['idempotencyKey'] ?? ''));
    // Correlation id minted by the signal engine when the signal was created
    // (see logMt5SignalEvent() in indicator/indicator.js). Carrying it onto
    // the order is what makes "signals without orders" / "orders without
    // signals" answerable in audit.php instead of guesswork.
    $signalId = mt5SanitizeSignalId((string) ($body['signalId'] ?? ''));
    $confidence = isset($body['confidence']) && is_numeric($body['confidence'])
        ? (float) $body['confidence']
        : null;

    // Client may pass an explicit brokerSymbolHint; otherwise fall back to the
    // admin-configured MT5_SYMBOL_MAP so the EA gets an automatic resolution
    // candidate for shorthand/TradingView instrument codes (e.g. "stpRNG5").
    $brokerSymbolHint = trim((string) ($body['brokerSymbolHint'] ?? ''));
    if ($brokerSymbolHint === '') {
        $brokerSymbolHint = mt5ResolveBrokerSymbolHint($symbol) ?? '';
    }

    return [
        'symbol' => $symbol,
        'brokerSymbolHint' => $brokerSymbolHint,
        'side' => $side,
        'entry' => $entry,
        'sl' => $sl,
        'tp' => $tp,
        'digits' => $digits,
        'point' => $point,
        'orderType' => $orderType,
        'currentPrice' => $currentPrice,
        'lot' => $lot,
        'constraints' => $constraints,
        'source' => $source,
        'strategyName' => $strategyName,
        'idempotencyKey' => $idempotencyKey,
        'signalId' => $signalId,
        'confidence' => $confidence,
    ];
}

/**
 * @param array<string,mixed> $order
 * @return array<string,mixed>
 */
function mt5PublicOrder(array $order): array
{
    return [
        'orderId' => $order['orderId'] ?? '',
        'status' => $order['status'] ?? 'UNKNOWN',
        'symbol' => $order['symbol'] ?? '',
        'brokerSymbolHint' => ($order['brokerSymbolHint'] ?? '') !== '' ? $order['brokerSymbolHint'] : null,
        'side' => $order['side'] ?? '',
        'orderType' => $order['orderType'] ?? '',
        'entry' => $order['entry'] ?? null,
        'sl' => $order['sl'] ?? null,
        'tp' => $order['tp'] ?? null,
        'lot' => $order['lot'] ?? null,
        'source' => $order['source'] ?? null,
        'strategyName' => $order['strategyName'] ?? null,
        'brokerTicket' => $order['brokerTicket'] ?? null,
        'message' => $order['message'] ?? null,
        'attempts' => $order['attempts'] ?? 0,
        'terminal' => $order['terminal'] ?? null,
        'lastStatusTerminal' => $order['lastStatusTerminal'] ?? null,
        'createdAt' => $order['createdAt'] ?? null,
        'updatedAt' => $order['updatedAt'] ?? null,
        'signalId' => ($order['signalId'] ?? '') !== '' ? $order['signalId'] : null,
    ];
}

/* ===================================================================== *
 * Signal + lifecycle ledger
 * ---------------------------------------------------------------------
 * The MT5 bridge has no database table: queue state is a single JSON file
 * (mt5StoragePath()). Before this ledger existed, the only record that a
 * signal had ever been *considered* lived in the browser's in-page log —
 * so when pull.php returned `count: 0` there was no server-side evidence
 * to distinguish "no signal fired", "signal fired but a client-side risk
 * filter rejected it", and "order was created but pinned to another
 * terminal". Every stage of the pipeline now appends a bounded, structured
 * record here, and audit.php renders them as the end-to-end report.
 * ===================================================================== */

/** Hard caps so the ledger can never grow the state file without bound. */
const MT5_SIGNAL_LOG_MAX = 500;
const MT5_EVENT_LOG_MAX = 1000;

/** Canonical lifecycle event names recorded in $state['events']. */
const MT5_LIFECYCLE_EVENTS = [
    'SIGNAL_CREATED',
    'SIGNAL_REJECTED',
    'ORDER_CREATED',
    'ORDER_QUEUED',
    'ORDER_ASSIGNED',
    'PULL_REQUEST',
    'PULL_RESPONSE',
    'ORDER_RECEIVED',
    'ORDER_SEND_ATTEMPT',
    'ORDER_EXECUTED',
    'ORDER_FAILED',
];

/**
 * Signal ids are used as array keys in the state file and echoed back in
 * audit responses, so constrain them to a safe, bounded character set.
 */
function mt5SanitizeSignalId(string $raw): string
{
    $clean = preg_replace('/[^A-Za-z0-9_.:-]/', '', trim($raw)) ?? '';
    return substr($clean, 0, 80);
}

/**
 * Appends a lifecycle event to the in-state ring buffer. Must be called from
 * inside mt5WithStateLock() so the append is serialized with queue mutations.
 *
 * @param array<string,mixed> $state
 * @param array<string,mixed> $context
 */
function mt5RecordEvent(array &$state, string $event, array $context = [], ?int $now = null): void
{
    if (!isset($state['events']) || !is_array($state['events'])) $state['events'] = [];
    $state['events'][] = [
        'event' => $event,
        'ts' => $now ?? time(),
    ] + $context;
    $overflow = count($state['events']) - MT5_EVENT_LOG_MAX;
    if ($overflow > 0) {
        $state['events'] = array_slice($state['events'], $overflow);
    }
}

/**
 * Records (or updates) a signal in the signal ledger. Must be called from
 * inside mt5WithStateLock().
 *
 * @param array<string,mixed> $state
 * @param array<string,mixed> $signal
 */
function mt5RecordSignal(array &$state, string $signalId, array $signal): void
{
    if ($signalId === '') return;
    if (!isset($state['signals']) || !is_array($state['signals'])) $state['signals'] = [];

    $existing = is_array($state['signals'][$signalId] ?? null) ? $state['signals'][$signalId] : [];
    // array_filter drops nulls so a later partial update (e.g. the order link)
    // never erases fields captured at signal-creation time.
    $state['signals'][$signalId] = array_merge(
        $existing,
        array_filter($signal, static fn($v): bool => $v !== null)
    );

    $overflow = count($state['signals']) - MT5_SIGNAL_LOG_MAX;
    if ($overflow > 0) {
        $state['signals'] = array_slice($state['signals'], $overflow, null, true);
    }
}

/**
 * Normalizes a free-text client rejection reason into one of the audited
 * filter buckets so rejections can be counted per filter, not per message.
 */
function mt5ClassifyRejection(string $reason): string
{
    $r = strtolower($reason);
    $map = [
        'confluence' => 'confluence filter',
        'confidence' => 'confidence filter',
        'spread' => 'spread filter',
        'atr' => 'ATR filter',
        'cooldown' => 'cooldown filter',
        'duplicate' => 'duplicate protection',
        'daily loss' => 'daily loss protection',
        'session' => 'session filter',
        'hedging' => 'hedging protection',
        'opposing' => 'hedging protection',
        'max concurrent' => 'max concurrent trades',
        'frequency' => 'trade frequency cap',
        'regime' => 'regime gating',
        'paused' => 'strategy pause',
        'exposure' => 'correlated exposure',
        'c-setup' => 'weighted confluence tier',
        'sl/tp' => 'SL/TP validation',
        'entry/sl/tp' => 'SL/TP validation',
        'risk config' => 'account protection',
        'not authorized' => 'account protection',
        'log in' => 'account protection',
        'session limit' => 'account protection',
    ];
    foreach ($map as $needle => $bucket) {
        if (str_contains($r, $needle)) return $bucket;
    }
    return 'other';
}

