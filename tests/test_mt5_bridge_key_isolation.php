<?php
/**
 * Regression tests for the per-user MT5 bridge key system.
 *
 * Unlike the other tests/test_mt5_*.php files (which are pure-function and
 * never touch the database), this file requires a real MySQL connection
 * because mt5LookupUserIdByBridgeKey()/mt5GetOrCreateBridgeKey()/
 * mt5RegenerateBridgeKey() all read/write the users.mt5_bridge_key column.
 *
 * If DB_HOST/DB_NAME/DB_USER/DB_PASSWORD are not set in the environment,
 * this test is skipped (exit 0) rather than failing, consistent with how a
 * missing MT5 bridge configuration is treated elsewhere in this bridge.
 *
 * To run locally:
 *   DB_HOST=localhost DB_NAME=trading_web_test DB_USER=testuser \
 *     DB_PASSWORD=testpass php tests/test_mt5_bridge_key_isolation.php
 */

declare(strict_types=1);

$dbName = getenv('DB_NAME') ?: ($_ENV['DB_NAME'] ?? '');
$dbUser = getenv('DB_USER') ?: ($_ENV['DB_USER'] ?? '');
if ($dbName === '' || $dbUser === '') {
    echo "SKIPPED: DB_NAME/DB_USER not set — no database available for this test.\n";
    exit(0);
}

require_once __DIR__ . '/../api/config.php';
require_once __DIR__ . '/../api/mt5/common.php';

$failures = 0;

function check(string $label, bool $cond): void
{
    global $failures;
    if ($cond) {
        echo "[PASS] $label\n";
    } else {
        echo "[FAIL] $label\n";
        $failures++;
    }
}

$pdo = getDB();

/** Creates a throwaway active user row and returns its id. */
function makeTestUser(PDO $pdo, string $username): int
{
    $pdo->prepare(
        'INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)'
    )->execute([$username, password_hash('x', PASSWORD_BCRYPT), 'user', 'active']);
    return (int) $pdo->lastInsertId();
}

$suffix = bin2hex(random_bytes(4));
$userA = makeTestUser($pdo, "mt5test_a_$suffix");
$userB = makeTestUser($pdo, "mt5test_b_$suffix");

try {
    // 1) Fresh user has no key until first use, then gets one on demand.
    $stmt = $pdo->prepare('SELECT mt5_bridge_key FROM users WHERE id = ?');
    $stmt->execute([$userA]);
    check('a freshly created user has no bridge key yet', $stmt->fetchColumn() === null);

    $keyA = mt5GetOrCreateBridgeKey($userA);
    check('mt5GetOrCreateBridgeKey mints a 64-char hex key', strlen($keyA) === 64 && ctype_xdigit($keyA));

    $keyAAgain = mt5GetOrCreateBridgeKey($userA);
    check('mt5GetOrCreateBridgeKey is idempotent for the same user', $keyAAgain === $keyA);

    // 2) A different user gets a different key.
    $keyB = mt5GetOrCreateBridgeKey($userB);
    check('two different users get two different keys', $keyB !== $keyA);

    // 3) Looking up by key resolves to the correct owning user, and only that user.
    check('mt5LookupUserIdByBridgeKey resolves userA key to userA', mt5LookupUserIdByBridgeKey($keyA) === $userA);
    check('mt5LookupUserIdByBridgeKey resolves userB key to userB', mt5LookupUserIdByBridgeKey($keyB) === $userB);
    check('mt5LookupUserIdByBridgeKey never cross-resolves', mt5LookupUserIdByBridgeKey($keyA) !== $userB);

    // 4) An unknown/garbage key resolves to nobody — this is the core guarantee
    //    that stops one user's EA from pulling another user's queued orders.
    check('an unrecognized key resolves to null', mt5LookupUserIdByBridgeKey(str_repeat('0', 64)) === null);

    // 5) Regenerating revokes the old key immediately.
    $keyARotated = mt5RegenerateBridgeKey($userA);
    check('mt5RegenerateBridgeKey returns a new key', $keyARotated !== $keyA);
    check('the old key no longer resolves after rotation', mt5LookupUserIdByBridgeKey($keyA) === null);
    check('the new key resolves to the same user', mt5LookupUserIdByBridgeKey($keyARotated) === $userA);

    // 6) A locked (non-active) user's key is refused — defense in depth so a
    //    disabled account can't keep dispatching trades via a leaked key.
    $pdo->prepare('UPDATE users SET status = ? WHERE id = ?')->execute(['locked', $userB]);
    check('a locked user\'s key no longer resolves', mt5LookupUserIdByBridgeKey($keyB) === null);
} finally {
    // Clean up the throwaway rows regardless of pass/fail.
    $pdo->prepare('DELETE FROM users WHERE id IN (?, ?)')->execute([$userA, $userB]);
}

if ($failures > 0) {
    echo "\n$failures check(s) FAILED.\n";
    exit(1);
}

echo "\nAll checks passed.\n";
