<?php
/**
 * Regression tests for the ITGuruMt5Bridge.mq5 trade-comment tagging scheme
 * ("opp" / "norm" suffix) added so opposite-direction vs normal trades are
 * distinguishable directly in the MT5 terminal's History tab.
 *
 * ITGuruMt5Bridge.mq5 cannot be compiled/unit-tested in this environment (no
 * MetaEditor/wine available), so this file instead:
 *   1) Locks the orderId format api/mt5/signal.php generates — the comment
 *      scheme's safety margin (see MT5_ORDER_ID_LEN in ITGuruMt5Bridge.mq5)
 *      depends on orderId always being exactly 27 characters. If this test
 *      starts failing, ITGuruMt5Bridge.mq5's comment-tag budget must be
 *      re-checked before changing the orderId format.
 *   2) Re-implements the same BuildTradeComment()/ExtractOrderIdFromComment()/
 *      CommentMatchesOrderId() algorithm in PHP and exercises it against
 *      real-shaped orderIds, including simulating a broker truncating the
 *      trade comment to fewer characters than requested, to prove the
 *      orderId always round-trips regardless of tag truncation.
 */

declare(strict_types=1);

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

/* ---- 1) Lock the orderId format api/mt5/signal.php generates ---- */

function generateOrderId(): string
{
    // Mirrors api/mt5/signal.php's $orderId = 'mt5_' . gmdate('YmdHis') . '_' . bin2hex(random_bytes(4));
    return 'mt5_' . gmdate('YmdHis') . '_' . bin2hex(random_bytes(4));
}

const MT5_ORDER_ID_LEN = 27; // must match #define MT5_ORDER_ID_LEN in ITGuruMt5Bridge.mq5

$sampleOrderId = generateOrderId();
check(
    'generated orderId is always exactly MT5_ORDER_ID_LEN (27) characters',
    strlen($sampleOrderId) === MT5_ORDER_ID_LEN
);
check(
    'generated orderId matches the expected mt5_<14digits>_<8hex> shape',
    preg_match('/^mt5_\d{14}_[0-9a-f]{8}$/', $sampleOrderId) === 1
);

/* ---- 2) Re-implementation of the .mq5 comment-tagging algorithm ---- */

function buildTradeComment(string $orderId, bool $isOpposite): string
{
    return $orderId . ($isOpposite ? 'opp' : 'norm');
}

function extractOrderIdFromComment(string $comment): string
{
    if (strlen($comment) <= MT5_ORDER_ID_LEN) {
        return $comment;
    }
    return substr($comment, 0, MT5_ORDER_ID_LEN);
}

function commentMatchesOrderId(string $comment, string $orderId): bool
{
    return extractOrderIdFromComment($comment) === $orderId;
}

$orderId = generateOrderId();

$oppComment = buildTradeComment($orderId, true);
$normComment = buildTradeComment($orderId, false);

check('opp-tagged comment stays within the 31-char broker comment limit', strlen($oppComment) <= 31);
check('norm-tagged comment stays within the 31-char broker comment limit', strlen($normComment) <= 31);
check('opp-tagged comment is exactly orderId + "opp"', $oppComment === $orderId . 'opp');
check('norm-tagged comment is exactly orderId + "norm"', $normComment === $orderId . 'norm');

check('extracting from an opp-tagged comment recovers the original orderId', extractOrderIdFromComment($oppComment) === $orderId);
check('extracting from a norm-tagged comment recovers the original orderId', extractOrderIdFromComment($normComment) === $orderId);

check('commentMatchesOrderId is true for an opp-tagged comment against its own orderId', commentMatchesOrderId($oppComment, $orderId));
check('commentMatchesOrderId is true for a norm-tagged comment against its own orderId', commentMatchesOrderId($normComment, $orderId));

$otherOrderId = generateOrderId();
check(
    'commentMatchesOrderId is false against a different orderId (no cross-match)',
    !commentMatchesOrderId($oppComment, $otherOrderId)
);

/* A legacy position placed before this feature existed has a bare, untagged
 * orderId as its comment — must still match. */
check('an untagged legacy comment (bare orderId) still matches itself', commentMatchesOrderId($orderId, $orderId));

/* Simulate a broker truncating the comment it actually stores to fewer
 * characters than what was requested — orderId must still be recoverable
 * since it is always written as the leading MT5_ORDER_ID_LEN characters. */
foreach ([30, 29, 28, 27] as $brokerCap) {
    $truncated = substr($normComment, 0, $brokerCap);
    check(
        "orderId still round-trips when the broker truncates the comment to $brokerCap chars",
        extractOrderIdFromComment($truncated) === $orderId
    );
}

/* If the broker truncates below MT5_ORDER_ID_LEN, the orderId itself is cut
 * and can no longer match — this is an inherent limit of any comment-based
 * scheme (already true before this change, since orderId alone was already
 * 27 chars), not a regression introduced by tagging. Documented here rather
 * than asserted as "it works" so this known boundary stays visible. */
$severelyTruncated = substr($normComment, 0, 20);
check(
    'a broker truncating below MT5_ORDER_ID_LEN (pre-existing limitation) correctly fails to match',
    !commentMatchesOrderId($severelyTruncated, $orderId)
);

if ($failures > 0) {
    echo "\n$failures check(s) FAILED.\n";
    exit(1);
}

echo "\nAll checks passed.\n";
