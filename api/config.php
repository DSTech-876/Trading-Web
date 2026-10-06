<?php
/**
 * Trading-Web — Server Configuration
 * ───────────────────────────────────
 * Loads .env, establishes DB connection, and provides JWT + utility helpers.
 * Required by every API endpoint — never accessed directly by the browser.
 */

declare(strict_types=1);

/* ── Prevent direct access ── */
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    http_response_code(403);
    exit(json_encode(['error' => 'Direct access forbidden']));
}

/* ══════════════════════════════════════════════
   1. Load .env file
   ══════════════════════════════════════════════ */

function loadEnv(string $path): void
{
    if (!is_file($path) || !is_readable($path)) {
        return;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return;
    }

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        if (!str_contains($line, '=')) {
            continue;
        }

        [$key, $value] = explode('=', $line, 2);
        $key   = trim($key);
        $value = trim($value);

        /* Remove surrounding quotes ("value" or 'value') */
        if (preg_match('/^(["\'])(.*)\\1$/', $value, $m)) {
            $value = $m[2];
        }

        $_ENV[$key] = $value;
        putenv("$key=$value");
    }
}

/* Search for .env in common locations */
$envSearchPaths = [
    __DIR__ . '/../.env',          // repo root  (same level as api/)
    dirname(__DIR__, 2) . '/.env', // one level above document root
    __DIR__ . '/.env',             // inside api/ folder
];

foreach ($envSearchPaths as $envPath) {
    if (is_file($envPath)) {
        loadEnv($envPath);
        break;
    }
}

/** Read an environment variable with an optional default. */
function env(string $key, string $default = ''): string
{
    return $_ENV[$key] ?? (getenv($key) ?: $default);
}

/* ── Auto-generate JWT_SECRET if missing or placeholder ──────
   Generates a cryptographically secure 64-char hex secret and
   persists it to .jwt_secret so it survives across requests.
   This lets the app work out-of-the-box without manual setup. */
(function (): void {
    $current = env('JWT_SECRET');
    $placeholder = 'generate_a_random_64_char_string_here';

    if ($current !== '' && $current !== $placeholder) {
        return;                                        // already configured
    }

    $secretFile = dirname(__DIR__) . '/.jwt_secret';

    /* Try to load a previously auto-generated secret */
    if (is_file($secretFile) && is_readable($secretFile)) {
        $saved = trim((string) file_get_contents($secretFile));
        if ($saved !== '' && $saved !== $placeholder) {
            $_ENV['JWT_SECRET'] = $saved;
            putenv("JWT_SECRET=$saved");
            return;
        }
    }

    /* Generate a new secret and persist it */
    $secret = bin2hex(random_bytes(32));               // 64 hex chars
    $written = @file_put_contents($secretFile, $secret, LOCK_EX);
    if ($written !== false) {
        @chmod($secretFile, 0600);
    } else {
        /* Cannot persist — log a warning so the admin knows */
        error_log('JWT_SECRET auto-generation: could not write ' . $secretFile
            . ' — a new secret will be generated on every request until this is fixed.');
    }

    $_ENV['JWT_SECRET'] = $secret;
    putenv("JWT_SECRET=$secret");
})();

/* ── Auto-generate CRON_SECRET_KEY if missing or placeholder ─
   Scheduled jobs (cron/*.php) are triggered via a public URL on
   hosts like Hostinger that only support HTTP-based cron. This key
   must be appended to that URL (?key=...) so the endpoint can tell a
   legitimate cron trigger apart from a random visitor. Auto-generates
   and persists a secret to .cron_secret so it works out-of-the-box. */
(function (): void {
    $current = env('CRON_SECRET_KEY');
    $placeholder = 'REPLACE_WITH_LONG_RANDOM_KEY';

    if ($current !== '' && $current !== $placeholder) {
        define('CRON_SECRET_KEY', $current);
        return;                                        // already configured
    }

    $secretFile = dirname(__DIR__) . '/.cron_secret';

    /* Try to load a previously auto-generated secret */
    if (is_file($secretFile) && is_readable($secretFile)) {
        $saved = trim((string) file_get_contents($secretFile));
        if ($saved !== '' && $saved !== $placeholder) {
            $_ENV['CRON_SECRET_KEY'] = $saved;
            putenv("CRON_SECRET_KEY=$saved");
            define('CRON_SECRET_KEY', $saved);
            return;
        }
    }

    /* Generate a new secret and persist it */
    $secret = bin2hex(random_bytes(32));               // 64 hex chars
    $written = @file_put_contents($secretFile, $secret, LOCK_EX);
    if ($written !== false) {
        @chmod($secretFile, 0600);
    } else {
        /* Cannot persist — log a warning so the admin knows */
        error_log('CRON_SECRET_KEY auto-generation: could not write ' . $secretFile
            . ' — a new secret will be generated on every request until this is fixed.');
    }

    $_ENV['CRON_SECRET_KEY'] = $secret;
    putenv("CRON_SECRET_KEY=$secret");
    define('CRON_SECRET_KEY', $secret);
})();

/**
 * Guard a cron endpoint that is triggered over a public URL (Hostinger-style
 * "run via cron URL" hosting). Direct/unauthenticated HTTP access is
 * rejected; requests carrying the correct CRON_SECRET_KEY are allowed
 * through, and CLI execution (e.g. a traditional shell cron entry) is
 * always allowed since it never touches the public network.
 *
 * The key may be supplied as a query string / POST param (?key=...) or via
 * the X-Cron-Key header.
 */
function requireCronSecret(string $paramName = 'key'): void
{
    if (PHP_SAPI === 'cli') {
        return; // invoked directly from a shell/cron entry — no HTTP surface
    }

    $incoming = (string) ($_SERVER['HTTP_X_CRON_KEY'] ?? '');
    if ($incoming === '') {
        $incoming = (string) ($_GET[$paramName] ?? $_POST[$paramName] ?? '');
    }

    if ($incoming === '' || !hash_equals(CRON_SECRET_KEY, $incoming)) {
        http_response_code(403);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Forbidden']));
    }
}

/** Check whether debug mode is enabled in .env (APP_DEBUG=true). */
function isDebug(): bool
{
    $val = env('APP_DEBUG', 'false');
    return in_array(strtolower($val), ['true', '1', 'yes', 'on'], true);
}

/* ══════════════════════════════════════════════
   2. Database connection (PDO — MySQL)
   ══════════════════════════════════════════════ */

function getDB(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $host = env('DB_HOST', 'localhost');
    $name = env('DB_NAME');
    $user = env('DB_USER');
    $pass = env('DB_PASSWORD');

    if ($name === '' || $user === '') {
        throw new RuntimeException(
            'Database not configured — DB_NAME or DB_USER is empty. Check your .env file.'
        );
    }

    try {
        $pdo = new PDO(
            "mysql:host=$host;dbname=$name;charset=utf8mb4",
            $user,
            $pass,
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]
        );
        return $pdo;
    } catch (PDOException $e) {
        error_log('DB connection failed: ' . $e->getMessage());
        $detail = '';
        if (isDebug()) {
            if (str_contains($e->getMessage(), 'Unknown database')) {
                $detail = ': database "' . $name . '" does not exist — create it in your hosting panel';
            } elseif (str_contains($e->getMessage(), 'Access denied')) {
                $detail = ': access denied — check DB_USER and DB_PASSWORD in your .env file';
            } elseif (str_contains($e->getMessage(), 'Connection refused') || str_contains($e->getMessage(), 'No such file')) {
                $detail = ': cannot reach DB host "' . $host . '" — check DB_HOST in .env';
            } else {
                $detail = ': ' . $e->getMessage();
            }
        }
        throw new RuntimeException('Database connection failed' . $detail, 0, $e);
    }
}

/**
 * Return the set of columns present on a table.
 *
 * @return array<string,bool>
 */
function getTableColumns(PDO $pdo, string $table): array
{
    static $cache = [];

    if (isset($cache[$table])) {
        return $cache[$table];
    }

    if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $table)) {
        return $cache[$table] = [];
    }

    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM `{$table}`");
        $cols = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $field = (string) ($row['Field'] ?? '');
            if ($field !== '') {
                $cols[$field] = true;
            }
        }
        return $cache[$table] = $cols;
    } catch (\Throwable $e) {
        return $cache[$table] = [];
    }
}

function tableHasColumn(PDO $pdo, string $table, string $column): bool
{
    return isset(getTableColumns($pdo, $table)[$column]);
}

function tableExists(PDO $pdo, string $table): bool
{
    return getTableColumns($pdo, $table) !== [];
}

/**
 * Load a user row while tolerating optional schema columns missing from older databases.
 *
 * @return array<string,mixed>|null
 */
function fetchAuthUser(PDO $pdo, string $lookupField, mixed $lookupValue, bool $includePasswordHash = false): ?array
{
    if (!in_array($lookupField, ['id', 'username', 'email'], true)) {
        return null;
    }
    if (!tableHasColumn($pdo, 'users', $lookupField)) {
        return null;
    }

    $baseFields = ['id', 'username', 'display_name'];
    if ($includePasswordHash) {
        if (!tableHasColumn($pdo, 'users', 'password_hash')) {
            return null;
        }
        $baseFields[] = 'password_hash';
    }

    $optionalFields = [
        'email',
        'role',
        'status',
        'subscription_status',
        'subscription_plan',
        'subscription_expires_at',
        'telegram_user_id',
        'telegram_username',
        'telegram_linked_at',
        'last_login_at',
    ];

    $selectFields = [];
    foreach (array_merge($baseFields, $optionalFields) as $field) {
        if (tableHasColumn($pdo, 'users', $field)) {
            $selectFields[] = $field;
        }
    }

    if ($selectFields === []) {
        return null;
    }

    $sql = 'SELECT ' . implode(', ', $selectFields) . " FROM users WHERE {$lookupField} = ? LIMIT 1";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$lookupValue]);
    $user = $stmt->fetch();

    if (!$user) {
        return null;
    }

    $user['display_name'] = $user['display_name'] ?? $user['username'] ?? null;
    $user['role'] = $user['role'] ?? 'user';
    $user['status'] = $user['status'] ?? 'active';
    $user['subscription_status'] = $user['subscription_status'] ?? 'inactive';
    $user['subscription_plan'] = $user['subscription_plan'] ?? null;
    $user['subscription_expires_at'] = $user['subscription_expires_at'] ?? null;
    $user['telegram_user_id'] = $user['telegram_user_id'] ?? null;
    $user['telegram_username'] = $user['telegram_username'] ?? null;
    $user['telegram_linked_at'] = $user['telegram_linked_at'] ?? null;

    return $user;
}

/**
 * Return granted strategy keys when the strategy_access table is available.
 *
 * @return list<string>
 */
function fetchUserStrategies(PDO $pdo, int $userId): array
{
    if (!tableExists($pdo, 'strategy_access')
        || !tableHasColumn($pdo, 'strategy_access', 'user_id')
        || !tableHasColumn($pdo, 'strategy_access', 'strategy_key')) {
        return [];
    }

    try {
        $stmt = $pdo->prepare('SELECT strategy_key FROM strategy_access WHERE user_id = ? ORDER BY strategy_key');
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
    } catch (\Throwable $e) {
        error_log('Strategy access lookup skipped: ' . $e->getMessage());
        return [];
    }
}

/* ══════════════════════════════════════════════
   3. JWT helpers (HMAC-SHA256)
   ══════════════════════════════════════════════ */

function base64url_encode(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64url_decode(string $data): string
{
    return base64_decode(strtr($data, '-_', '+/'));
}

/**
 * Create a signed JWT token.
 *
 * @param  array<string,mixed> $payload
 * @return string
 */
function jwtEncode(array $payload): string
{
    $secret = env('JWT_SECRET');
    if ($secret === '') {
        throw new RuntimeException('JWT_SECRET is not set in .env');
    }

    $header  = base64url_encode(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));
    $body    = base64url_encode(json_encode($payload));
    $sig     = base64url_encode(hash_hmac('sha256', "$header.$body", $secret, true));

    return "$header.$body.$sig";
}

/**
 * Decode and verify a JWT token.
 *
 * @return array<string,mixed>|null  Decoded payload on success, null on failure.
 */
function jwtDecode(string $token): ?array
{
    $secret = env('JWT_SECRET');
    if ($secret === '') {
        return null;
    }

    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        return null;
    }

    [$header, $payload, $sig] = $parts;

    $expected = base64url_encode(hash_hmac('sha256', "$header.$payload", $secret, true));
    if (!hash_equals($expected, $sig)) {
        return null;
    }

    $data = json_decode(base64url_decode($payload), true);
    if (!is_array($data)) {
        return null;
    }

    /* Check expiration */
    if (isset($data['exp']) && $data['exp'] < time()) {
        return null;
    }

    return $data;
}

/**
 * Authenticate user from JWT token in Authorization header.
 * Returns user ID on success, exits with standardized JSON response on failure.
 * Logs auth failures with structured context.
 *
 * @return int User ID
 */
function authenticateUserFromToken(): int
{
    $authHeader = $_SERVER['HTTP_AUTHORIZATION']
        ?? (function_exists('apache_request_headers')
            ? (apache_request_headers()['Authorization'] ?? '')
            : '');
    
    if ($authHeader === '') {
        error_log(sprintf(
            '[%s] Auth failure: Missing Authorization header [%s %s from %s]',
            date('Y-m-d H:i:s'),
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'Authentication required'], 401);
    }
    
    if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
        error_log(sprintf(
            '[%s] Auth failure: Malformed Authorization header [%s %s from %s]',
            date('Y-m-d H:i:s'),
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'Invalid authorization header'], 401);
    }
    
    $payload = jwtDecode($m[1]);
    if (!$payload || empty($payload['sub'])) {
        error_log(sprintf(
            '[%s] Auth failure: Invalid or expired token [%s %s from %s]',
            date('Y-m-d H:i:s'),
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'Invalid or expired token'], 401);
    }
    
    $userId = (int) $payload['sub'];
    
    // Check user exists and is not locked
    try {
        $pdo = getDB();
        $stmt = $pdo->prepare('SELECT id, status FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $user = $stmt->fetch();
    } catch (\Throwable $e) {
        error_log(sprintf(
            '[%s] Auth failure: Database error checking user [%s %s from %s]: %s',
            date('Y-m-d H:i:s'),
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? '',
            $e->getMessage()
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 500, 'message' => 'Database error during authentication'], 500);
    }
    
    if (!$user) {
        error_log(sprintf(
            '[%s] Auth failure: User not found [user_id: %d, %s %s from %s]',
            date('Y-m-d H:i:s'),
            $userId,
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Unauthorized', 'code' => 401, 'message' => 'User not found'], 401);
    }
    
    if (($user['status'] ?? 'active') === 'locked') {
        error_log(sprintf(
            '[%s] Auth failure: Account locked [user_id: %d, %s %s from %s]',
            date('Y-m-d H:i:s'),
            $userId,
            $_SERVER['REQUEST_METHOD'] ?? '',
            $_SERVER['REQUEST_URI'] ?? '',
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        jsonResponse(['error' => 'Forbidden', 'code' => 403, 'message' => 'Account is locked'], 403);
    }
    
    return $userId;
}

/* ══════════════════════════════════════════════
   4. IP-based rate limiting (file-system)
   ══════════════════════════════════════════════ */

/**
 * Simple rate limiter.  Returns TRUE if the request is allowed.
 *
 * Each caller is bucketed separately by (IP, endpoint) by default, keyed off
 * the calling script's filename. Without this, every endpoint that calls
 * rateLimit() would share a single IP-wide counter, so high-frequency polling
 * endpoints (e.g. the MT5 bridge's pull.php/status.php) would exhaust the
 * shared quota and cause unrelated, low-frequency endpoints (e.g. signal.php)
 * to be falsely throttled with "Rate limit exceeded" even though that
 * specific endpoint was called well within its own configured limit.
 *
 * @param int         $maxAttempts  Maximum requests per window
 * @param int         $windowSecs   Window duration in seconds
 * @param string|null $bucket       Explicit bucket name to rate-limit on
 *                                  instead of the calling script (use this to
 *                                  intentionally share a quota across
 *                                  endpoints).
 */
function rateLimit(int $maxAttempts = 5, int $windowSecs = 60, ?string $bucket = null): bool
{
    /* Resolve client IP.
     * Only trust X-Forwarded-For when TRUSTED_PROXY_IPS is configured in .env
     * (comma-separated list of trusted reverse-proxy IPs).  Without that setting
     * the header is user-controlled and must be ignored to prevent rate-limit bypass. */
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $trustedProxies = array_filter(array_map('trim', explode(',', env('TRUSTED_PROXY_IPS', ''))));
    if (!empty($trustedProxies) && in_array($ip, $trustedProxies, true)) {
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $forwarded = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
            $candidate = trim($forwarded[0]);
            if (filter_var($candidate, FILTER_VALIDATE_IP)) {
                $ip = $candidate;
            }
        }
    }

    if ($bucket === null) {
        $bucket = basename((string) ($_SERVER['SCRIPT_FILENAME'] ?? $_SERVER['SCRIPT_NAME'] ?? 'default'));
    }

    $rateDir = sys_get_temp_dir() . '/trading_rate_limits';

    if (!is_dir($rateDir) && !mkdir($rateDir, 0700, true)) {
        error_log('Rate-limit: could not create directory ' . $rateDir);
        return true; /* fail open — don't block requests if dir creation fails */
    }

    $file     = $rateDir . '/' . md5($ip . '|' . $bucket) . '.json';
    $attempts = [];

    if (is_file($file)) {
        $raw      = @file_get_contents($file);
        $attempts = $raw ? (json_decode($raw, true) ?? []) : [];
    }

    $now      = time();
    $attempts = array_values(array_filter($attempts, fn($t) => $t > ($now - $windowSecs)));

    if (count($attempts) >= $maxAttempts) {
        return false;
    }

    $attempts[] = $now;
    @file_put_contents($file, json_encode($attempts), LOCK_EX);

    return true;
}

/* ══════════════════════════════════════════════
   5. Common response helpers
   ══════════════════════════════════════════════ */

/** Send a JSON response and terminate. */
function jsonResponse(mixed $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

/** Reject non-POST requests. */
function requirePost(): void
{
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
}

/**
 * Read and decode the JSON request body.
 *
 * On failure, logs the raw body (trimmed) plus the exact json_last_error()
 * reason and a hex dump of the trailing bytes before rejecting the request.
 * This is essential for diagnosing "Invalid JSON body" errors from non-PHP
 * clients (e.g. the MT5 bridge EA): a stray trailing byte — such as the NUL
 * terminator MQL5's StringToCharArray() can include — is invisible in a
 * plain-text log but decodes JSON to NULL, and the hex dump makes it obvious.
 */
function getJsonBody(): array
{
    $raw  = file_get_contents('php://input');
    $raw  = $raw === false ? '' : $raw;
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        $script = basename((string) ($_SERVER['SCRIPT_NAME'] ?? 'unknown'));
        error_log(sprintf(
            '[JSON_BODY_INVALID] endpoint=%s error=%s bytes=%d preview=%s trailingHex=%s',
            $script,
            json_last_error_msg(),
            strlen($raw),
            substr($raw, 0, 1000),
            bin2hex(substr($raw, -8))
        ));
        jsonResponse(['error' => 'Invalid JSON body', 'detail' => json_last_error_msg()], 400);
    }
    return $data;
}

/**
 * Categorise a caught exception into an actionable error message.
 *
 * Always returns a user-facing hint (DB not configured, connection failed,
 * missing table, missing JWT_SECRET).  Sensitive details are only appended
 * when APP_DEBUG=true.
 *
 * @param string      $prefix  e.g. "Login failed" or "Registration failed"
 * @param \Throwable  $e       the caught exception
 */
function categoriseAuthError(string $prefix, \Throwable $e): string
{
    $em  = $e->getMessage();
    $msg = $prefix;

    if (str_contains($em, 'DB_NAME') || str_contains($em, 'DB_USER') || str_contains($em, 'Database not configured')) {
        $msg .= ': database is not configured — check your .env file';
    } elseif (str_contains($em, 'Connection refused') || str_contains($em, 'No such file') || str_contains($em, 'Access denied') || str_contains($em, 'Unknown database') || str_contains($em, 'connection failed')) {
        $msg .= ': cannot connect to the database';
        if (isDebug()) $msg .= ' — ' . $em;
    } elseif (str_contains($em, "doesn't exist") || (str_contains($em, 'Table') && str_contains($em, 'exist'))) {
        $msg .= ': users table not found — run database/schema.sql on your database';
    } elseif (str_contains($em, 'Unknown column') || str_contains($em, 'Column not found') || str_contains($em, '42S22')) {
        $msg .= ': database schema mismatch — re-run database/schema.sql to update your table';
        if (isDebug()) $msg .= ' — ' . $em;
    } elseif (str_contains($em, 'server has gone away') || str_contains($em, 'Lost connection')) {
        $msg .= ': database connection was lost — please try again';
    } elseif ($e instanceof \RuntimeException && str_contains($em, 'JWT_SECRET')) {
        $msg .= ': JWT_SECRET is not set in your .env file';
    } else {
        /* Always include the exception class so the user can report/search it,
           but keep sensitive details behind APP_DEBUG. */
        $class = basename(str_replace('\\', '/', get_class($e)));
        $msg  .= isDebug()
            ? ": $em"
            : ". Unexpected error ({$class}). Enable APP_DEBUG=true in .env for details, then retry.";
    }

    return $msg . ' (visit /api/auth/status to diagnose)';
}

/* ── Shared headers for every API response ── */
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

/* CORS — same-origin in production, open in dev */
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (env('APP_ENV') !== 'production') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
} elseif ($origin !== '') {
    /* In production only allow your own domain */
    $allowed = env('AUTH_API_BASE');
    $parsed  = parse_url($allowed);
    $scheme  = ($parsed['scheme'] ?? 'https') . '://' . ($parsed['host'] ?? '');
    if (str_starts_with($origin, $scheme)) {
        header("Access-Control-Allow-Origin: $origin");
        header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
    }
}
