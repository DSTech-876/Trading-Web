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
    $state = is_string($raw) && $raw !== '' ? (json_decode($raw, true) ?: []) : [];
    if (!is_array($state)) $state = [];
    if (!isset($state['orders']) || !is_array($state['orders'])) $state['orders'] = [];
    if (!isset($state['idempotency']) || !is_array($state['idempotency'])) $state['idempotency'] = [];

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
 * @return array<string,mixed>
 */
function mt5ReadState(): array
{
    $path = mt5StoragePath();
    if (!is_file($path)) {
        return ['orders' => [], 'idempotency' => []];
    }
    $raw = @file_get_contents($path);
    $state = $raw ? (json_decode($raw, true) ?: []) : [];
    if (!is_array($state)) $state = [];
    if (!isset($state['orders']) || !is_array($state['orders'])) $state['orders'] = [];
    if (!isset($state['idempotency']) || !is_array($state['idempotency'])) $state['idempotency'] = [];
    return $state;
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
    @file_put_contents($path, $line . "\n", FILE_APPEND | LOCK_EX);
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

function mt5ResolveOrderType(string $side, float $entry, ?float $currentPrice, string $requested = ''): string
{
    $req = strtoupper(trim($requested));
    /* Only trust a client-requested order type when its BUY_/SELL_ prefix
     * matches the resolved trade side. Without this check a mismatched
     * payload (e.g. side=BUY with a stale/incorrect orderType=SELL_LIMIT)
     * would be placed as-is, sending a trade in the wrong direction while
     * every other field (side, sl/tp orientation) still reflects the
     * original side. */
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
        'brokerSymbolHint' => $order['brokerSymbolHint'] ?? null,
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
    ];
}

