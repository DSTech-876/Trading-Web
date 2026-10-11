# MT5 Bridge API Template (Minimal)

This document provides minimal request/response templates matching these endpoints exactly:

- `/api/mt5/signal.php`
- `/api/mt5/pull.php`
- `/api/mt5/status.php`
- `/api/mt5/order_status.php`

---

## 1) Queue order from web flow

### `POST /api/mt5/signal.php`

**Headers**
- `Authorization: Bearer <JWT>`
- Optional: `X-Idempotency-Key: <KEY>`

**Request (minimal valid JSON)**
```json
{
  "symbol": "EURUSD",
  "dir": "BUY",
  "entry": 1.085,
  "sl": 1.083,
  "tp": 1.089
}
```

**Response**
```json
{
  "ok": true,
  "duplicate": false,
  "order": {
    "orderId": "mt5_20260516235154_ab12cd34",
    "status": "QUEUED",
    "symbol": "EURUSD",
    "brokerSymbolHint": null,
    "side": "BUY",
    "orderType": "BUY_MARKET",
    "entry": 1.085,
    "sl": 1.083,
    "tp": 1.089,
    "lot": 0.01,
    "source": "breakout",
    "strategyName": "",
    "isOpposite": false,
    "brokerTicket": null,
    "message": null,
    "attempts": 0,
    "createdAt": 1710000000,
    "updatedAt": 1710000000
  }
}
```

---

## 2) EA poll for queued orders

### `GET|POST /api/mt5/pull.php`

**Auth options**
- Header: `X-MT5-BRIDGE-KEY: <your-personal-bridge-key>`
- Or request field/query: `bridge_key`

> **Per-user key, not a shared secret.** Unlike the admin-only `MT5_BRIDGE_KEY` env var (used
> solely by `audit.php`), `pull.php` and `status.php` require **each user's own personal bridge
> key**, fetched/rotated from the web app via `GET`/`POST /api/mt5/bridge_key.php` (authenticated
> with the user's normal login token) and configured into *that user's own* `ITGuruMt5Bridge.mq5`
> `InpBridgeKey` input. The key is resolved server-side to its owning user
> (`mt5ResolveBridgeUserId()` in `common.php`), and every order dispatched by `pull.php` — and every
> status update accepted by `status.php` — is filtered to that user's own orders. This is what
> stops one user's auto-trade signal from ever being dispatched to another user's MT5 account when
> multiple users share the same server deployment: previously, any EA that knew the single shared
> `MT5_BRIDGE_KEY` could pull *any* user's queued order.

**GET example**
```http
GET /api/mt5/pull.php?bridge_key=<your-personal-bridge-key>&limit=20&terminal=MT5-TERM-01
```

**POST request JSON (minimal)**
```json
{
  "bridge_key": "<your-personal-bridge-key>",
  "limit": 20,
  "terminal": "MT5-TERM-01"
}
```

**Response**
```json
{
  "ok": true,
  "serverTime": 1710000000,
  "halted": false,
  "haltReason": null,
  "count": 1,
  "orders": [
    {
      "orderId": "mt5_20260516235154_ab12cd34",
      "symbol": "EURUSD",
      "brokerSymbolHint": null,
      "side": "BUY",
      "orderType": "BUY_MARKET",
      "entry": 1.085,
      "sl": 1.083,
      "tp": 1.089,
      "lot": 0.01,
      "digits": 5,
      "point": 0.00001,
      "source": "breakout",
      "strategyName": "MyStrategy",
      "idempotencyKey": "abc123",
      "attempts": 1,
      "createdAt": 1710000000
    }
  ]
}
```

`createdAt` is a unix timestamp (seconds) the EA uses for staleness checks (`InpMaxSignalAgeSecs`).

When the operator sets `MT5_TRADING_HALTED=true` in `.env` (emergency kill-switch), `pull.php` returns
`"halted": true` with no orders, and the EA stops dispatching new trades until the flag is cleared.

---

## 3) EA callback status updates

### `POST /api/mt5/status.php`

**Auth options**
- Header: `X-MT5-BRIDGE-KEY: <your-personal-bridge-key>`
- Or request field: `bridge_key`

Same per-user key as `pull.php` (see above) — an update for an `orderId` that does not belong to
the resolved user is rejected the same way as an unknown `orderId` (reported under
`missingOrderIds`), so one user's EA cannot discover or alter another user's order status either.

### Single update request
```json
{
  "bridge_key": "<your-personal-bridge-key>",
  "orderId": "mt5_20260516235154_ab12cd34",
  "status": "FILLED",
  "brokerTicket": "12345678",
  "message": "Filled by broker",
  "filledPrice": 1.08502,
  "terminal": "MT5-TERM-01"
}
```

### Batch update request
```json
{
  "bridge_key": "<your-personal-bridge-key>",
  "updates": [
    {
      "orderId": "mt5_20260516235154_ab12cd34",
      "status": "RECEIVED",
      "brokerTicket": "12345678",
      "message": "Accepted",
      "filledPrice": 0,
      "terminal": "MT5-TERM-01"
    }
  ]
}
```

- `terminal` is optional and should be set to the EA's `InpTerminalId`. It is stored as
  `lastStatusTerminal` on the order and included in diagnostics/lifecycle-transition logs so a
  status update can always be traced back to the reporting terminal.

**Allowed status values**
- `QUEUED`, `DISPATCHED`, `RECEIVED`, `FILLED`, `MODIFIED`, `REJECTED`, `CANCELLED`, `EXPIRED`

**Lifecycle-revert guard**
Once an order reaches a final status (`FILLED`, `REJECTED`, `CANCELLED`, `EXPIRED`), that outcome is
permanent. Any later update that attempts to change it to a *different* status (e.g. a stale/duplicate
EA resync replaying an older `RECEIVED`/`DISPATCHED` state) is ignored rather than applied — the order
is never reverted. The request still returns `HTTP 200` for these ignored updates (so the EA does not
treat it as a failure and retry indefinitely); the ignored attempt is reported back in
`ignoredRevertAttempts` and logged via `mt5LogDiagnostic()`. A resync that resends the *same* final
status is accepted as a no-op/idempotent update.

**Response**
```json
{
  "ok": true,
  "applied": 1,
  "missingOrderIds": [],
  "ignoredRevertAttempts": [
    {
      "orderId": "mt5_20260516235154_ab12cd34",
      "symbol": "stpRNG5",
      "from": "REJECTED",
      "attemptedTo": "RECEIVED",
      "reason": "order already finalized; status update ignored to prevent lifecycle revert"
    }
  ]
}
```

---

## 4) Web UI poll order status

### `GET /api/mt5/order_status.php`

**Headers**
- `Authorization: Bearer <JWT>`

**Query params**
- `since` (unix timestamp, optional)
- `limit` (1..200, optional)

**Example**
```http
GET /api/mt5/order_status.php?since=0&limit=50
```

**Response**
```json
{
  "ok": true,
  "serverTime": 1710000000,
  "count": 1,
  "orders": [
    {
      "orderId": "mt5_20260516235154_ab12cd34",
      "status": "FILLED",
      "symbol": "EURUSD",
      "side": "BUY",
      "orderType": "BUY_MARKET",
      "entry": 1.085,
      "sl": 1.083,
      "tp": 1.089,
      "lot": 0.01,
      "source": "breakout",
      "strategyName": "",
      "brokerTicket": "12345678",
      "message": "Filled by broker",
      "attempts": 1,
      "createdAt": 1710000000,
      "updatedAt": 1710000030
    }
  ]
}
```

---

## 5) EA-side (`ITGuruMt5Bridge.mq5`) safeguards

The reference EA in the repo root implements, in addition to the server-side controls above:

- **Duplicate protection** — every `orderId` is recorded (with its last reported status) in a
  persisted local file; already-processed signals are not resent even across EA restarts, and a
  `comment`-tag match against existing positions/pending orders prevents a resend if a prior HTTP
  confirmation was lost. If a duplicate redispatch is received for an orderId whose status callback
  never reached (or was never persisted by) the server, the EA re-sends its last known status instead
  of silently dropping it, so the order can still be finalized server-side.
- **Risk limits** — `InpMaxLotSize`, `InpMaxTradesPerSymbol`, `InpMaxTotalExposureLots`,
  `InpAllowHedging`, `InpMaxSpreadPoints`, `InpDailyLossLimitPct` (auto-halts new trades for the
  remainder of the trading day), and an optional `InpUseSessionFilter` trading-hours window.
- **Connection resilience** — exponential backoff on repeated poll failures (capped at
  `InpMaxBackoffSeconds`) and a terminal `Alert()`/push notification after
  `InpAlertAfterFailures` consecutive failures, with a "reconnected" notice when polling recovers.
- **Order rejection handling** — bounded retries (`InpMaxOrderRetries`) only for retriable broker
  retcodes (requote/busy/timeout/price-changed), with every attempt logged.
- **Execution safety** — broker minimum stop/freeze level checks, free-margin checks via
  `OrderCalcMargin`, stale-signal rejection (`InpMaxSignalAgeSecs`, uses `createdAt`), and
  post-send confirmation against live positions/history before reporting `FILLED`.
- **Logging & monitoring** — every signal, validation outcome, order attempt, and status callback
  is written to `InpLogFileName` (CSV, in the terminal's `MQL5/Files` sandbox) with timestamps and
  broker return codes; a live `Comment()` dashboard shows connection state, halt state, and
  signal/poll counters.

`InpBridgeKey` has **no default value** — it must be set explicitly to **your own personal bridge
key**, fetched/rotated from the web app's MT5 Bridge settings panel (`GET`/`POST
/api/mt5/bridge_key.php`). It is *not* the server's admin-only `MT5_BRIDGE_KEY` env var, and must
never be shared across more than one user's EA — see the per-user key note under section 2 above.
Never commit a real bridge key into source control.

**Per-strategy magic numbers** — every order this EA places uses `InpMagic` as a base plus a small
deterministic offset derived from the order's `source`/`strategyName` (`EffectiveMagic()`), bounded
to `[InpMagic, InpMagic + 1000)`. This means trades from different strategies land on distinct,
stable magic numbers visible directly in MT5's Trade/History "Magic" column, without needing to
cross-reference the web dashboard to tell which strategy opened which trade. Every "does this
position belong to this EA" check (`IsOwnMagic()`) compares against that whole range rather than
exact equality to `InpMagic`, so open-trade counting, exposure totals, and duplicate-detection logic
still recognize all of this EA's own positions regardless of which strategy placed them.

**Opposite vs. normal trade comments** — every trade comment is the order's `orderId` with a short
tag appended: `opp` when the web app flipped the trade direction (opposite/grid-scalper-opposite
mode) or `norm` for an ordinary signal, e.g. `mt5_20260516235154_ab12cd34norm`. This makes the two
distinguishable directly in MT5's History tab without opening the web dashboard. `orderId` is always
exactly 27 characters (`"mt5_" + 14-digit UTC timestamp + "_" + 8 hex chars`), so it always fits as
the leading 27 characters of the comment even with the `opp`/`norm` tag appended (30-31 chars total,
within MT5's ~31-char comment limit); every place the EA matches a position/order back to an
`orderId` (`CommentMatchesOrderId()`) or recovers one from history (`ExtractOrderIdFromComment()`)
reads only those leading 27 characters, so the tag can never interfere with — or be mistaken for
part of — the orderId used for duplicate/position matching.

---

## 6) Diagnostics & symbol resolution

- **Request/response diagnostics** — `signal.php`, `pull.php`, and `status.php` log a structured line
  (via `mt5LogDiagnostic()` in `api/mt5/common.php`) for every call: endpoint, raw request body, signal
  id(s), mapped symbol, applied/validation results, and (for `status.php`) the full
  from-status → to-status lifecycle transition. Logs go to PHP's `error_log` and to
  `itguru_mt5_bridge_diagnostics_*.log` under the system temp directory. `getJsonBody()` (in
  `api/config.php`) additionally logs the raw body, `json_last_error()` reason, and a hex dump of the
  trailing bytes whenever a request fails to parse as JSON — the quickest way to catch stray bytes
  (e.g. a trailing NUL) in a non-PHP client's POST body.
- **Automatic symbol resolution** — `indicator/indicator.js`'s `BROKER_SYMBOL_HINTS` map already sends
  a default `brokerSymbolHint` for every synthetic index (e.g. `"stpRNG5"` → `"Step Index 500"`) on
  every push, so trades resolve out of the box without any server config. `MT5_SYMBOL_MAP` (server
  `.env`, JSON object mapping an internal/TradingView instrument code to the broker's actual
  MarketWatch name, e.g. `{"stpRNG5":"Step Index 500"}`) is only needed to **override** that default
  for brokers using non-standard names, and takes precedence over the client-supplied hint when set.
  Either way the result is surfaced to the EA as `brokerSymbolHint` on every order (`signal.php`
  response, `pull.php` queue, and `order_status.php`). `ITGuruMt5Bridge.mq5`'s `ResolveBrokerSymbol()`
  tries, in order: exact match → `brokerSymbolHint` → its own `InpSymbolAliasMap` input →
  `InpSymbolSuffixCandidates` → a case/punctuation-insensitive scan of every symbol the terminal knows
  about — logging each attempt (`SYMBOL_RESOLVE` / `SYMBOL_RESOLVE_FAIL` events) and caching the
  result per orderId's symbol code for the EA session.

---

## 7) Why `pull.php` returns `count: 0` — diagnosing an empty queue

`{"ok":true,"halted":false,"count":0,"orders":[]}` means the EA is authenticated and the server is
healthy; it only says the **queue had nothing dispatchable for this terminal**. Every poll now logs a
`PULL_RESPONSE_EMPTY` / `PULL_RESPONSE_DISPATCH` line (and returns a `queue` object in the response)
containing the queue census — `totalOrders`, `byStatus`, `byTerminal`, and, in the log, a
`notDispatched` list giving the exact per-order skip reason. Read that first; it distinguishes all of
the following causes, which are otherwise indistinguishable from the EA side:

| `queue` census shows | Cause |
| --- | --- |
| `totalOrders: 0` | No order was ever created. `signal.php` was never called successfully — the chain broke **upstream of the server**. |
| `byStatus` is all final (`FILLED`/`REJECTED`/`CANCELLED`/`EXPIRED`) | Everything already ran to completion; no new signals since. |
| `byTerminal` lists a different id than the polling terminal | Orders were pinned to another terminal on first dispatch. `terminal` is matched **exactly and case-sensitively** in `pull.php`; `MT5-TERM-01` and `mt5-term-01` are different queues. |
| `notDispatched` reason `awaiting retry window` | Orders are `DISPATCHED`; the EA already has them and a redispatch is throttled to 20 s. |
| `notDispatched` reason `dispatch halted` | `MT5_TRADING_HALTED` is set. |
| A `STATE_CORRUPT` line in the diagnostics log | The queue file was truncated/clobbered and the queue was reset. The unparseable payload is preserved as `<state file>.corrupt`. |

### `totalOrders: 0` — where orders come from

There is **no server-side signal generator and no signal/queue database table**. Orders exist only
when `POST /api/mt5/signal.php` is called, and the only caller is `submitMt5BridgeTrade()` in
`indicator/indicator.js`. All of the following must hold for a single order to be created:

1. The indicator page is open and streaming candles (it is the signal engine).
2. The user is logged in — `signal.php` requires a JWT; without one it returns `401`.
3. **Execution Mode is set to "MT5 Bridge"** (`autoTradeExecutionMode === "mt5"`). It defaults to
   `"deriv"`, in which case every signal is sent to Deriv and *nothing* is ever queued for MT5.
4. The relevant auto-trade master toggle is on for the signal's source
   (`autoTradeEnabled` / `autoTradeScalpEnabled` / `autoTradeStrategyEnabled`).
5. `executeAutoTrade()` passes every risk gate — session TP/SL halt, risk-config load, daily loss
   cap, symbol cooldown, trade-frequency cap, regime gating, strategy pause, **max concurrent trades
   per symbol**, hedging guard, confluence gate, weighted-confluence tier, correlated exposure. Each
   rejection is written to the indicator log with its reason.
6. SL/TP are finite, positive, and on the correct side of entry for the traded direction.

If `pull.php` reports `totalOrders: 0`, the failure is in that list, not in the bridge.

### Queue storage

Queue state is a single JSON file under the system temp directory
(`mt5StoragePath()` in `api/mt5/common.php`), guarded by `flock()`. Consequences to be aware of when
operating this bridge:

- It is **not** a database. There are no `trade_signals` / `signal_queue` / `queue` tables; MySQL is
  used only for auth, risk settings, and analytics.
- The file lives in `sys_get_temp_dir()`. If the web tier is load-balanced across more than one host,
  or PHP-FPM runs under a private/per-user temp directory that differs between the request that
  calls `signal.php` and the request that calls `pull.php`, the EA polls a **different, empty**
  queue. Pin `TMPDIR`/`sys_temp_dir` to a shared, persistent path in that case.
- The file is also subject to OS temp reaping. A reaped or truncated file is reported as
  `STATE_CORRUPT` rather than silently resetting the queue.

---

## 8) Signal ledger — `POST /api/mt5/signal_log.php`

The signal engine runs **in the browser** (`indicator/indicator.js`). Before this endpoint existed, a
signal that was generated and then discarded by one of the client-side risk filters left no
server-side trace whatsoever, so `pull.php` returning `count: 0` was indistinguishable from "no
signal ever fired". `executeAutoTrade()` and `submitMt5BridgeTrade()` now mirror two events here
(fire-and-forget; a logging failure never blocks or alters execution, and nothing is sent while
Execution Mode is `deriv`).

**Headers**
- `Authorization: ******

**Request**
```json
{
  "event": "SIGNAL_REJECTED",
  "signalId": "sig_1710000000_12_frxEURUSD_breakout",
  "symbol": "frxEURUSD",
  "direction": "BUY",
  "confidence": 0.72,
  "source": "breakout",
  "strategyName": "MyStrategy",
  "entry": 1.085,
  "sl": 1.083,
  "tp": 1.089,
  "reason": "confluence filter: dynamic confluence 2/4 (RANGING)"
}
```

- `event` is `SIGNAL_CREATED` or `SIGNAL_REJECTED`. `reason` is required for `SIGNAL_REJECTED` and is
  classified into an audited filter bucket (confluence / confidence / spread / ATR / cooldown /
  duplicate protection / daily loss protection / account protection / session filter / …) by
  `mt5ClassifyRejection()`.
- Batch form: `{"entries": [ … ]}`.
- `signalId` is sanitized to `[A-Za-z0-9_.:-]{1,80}` and is the join key between the signal ledger and
  the order queue. `signal.php` accepts the same `signalId` on the order payload.

**Response**
```json
{ "ok": true, "recorded": 1, "validationErrors": [] }
```

### Permanent lifecycle log

Every stage now appends a bounded, structured record to the state file (`MT5_LIFECYCLE_EVENTS` in
`api/mt5/common.php`):

| Event | Written by |
| --- | --- |
| `SIGNAL_CREATED`, `SIGNAL_REJECTED` | `signal_log.php` (client filters) and `signal.php` (payload validation) |
| `ORDER_CREATED`, `ORDER_QUEUED` | `signal.php` |
| `PULL_REQUEST`, `ORDER_ASSIGNED`, `PULL_RESPONSE` | `pull.php` |
| `ORDER_RECEIVED`, `ORDER_EXECUTED`, `ORDER_FAILED` | `status.php` (EA callbacks) |

`ORDER_SEND_ATTEMPT` and the raw `TRADE_RETCODE` / description are terminal-side facts and stay in the
EA's own CSV log (`ORDER_SEND_REQUEST` / `BROKER_RESPONSE` / `ORDER_REJECTED` in
`ITGuruMt5Bridge.mq5`); the outcome reaches the server as `ORDER_EXECUTED` / `ORDER_FAILED` with the
broker message attached.

`pull.php` deliberately does **not** write a ledger entry per poll — at the EA's 2 s default interval
that would evict every `SIGNAL_*`/`ORDER_*` record from the bounded ring within minutes. Instead it
maintains per-terminal counters (`pullStats`: `firstPullAt`, `lastPullAt`, `pollCount`,
`emptyPollCount`, `dispatchedCount`, `lastDispatchAt`) that prove the EA is polling, and only emits
discrete `PULL_REQUEST`/`ORDER_ASSIGNED`/`PULL_RESPONSE` events when a poll actually dispatched work.

---

## 9) Full execution audit — `GET|POST /api/mt5/audit.php`

One call that answers "why are trades not reaching MT5?" from the actual persisted state.

**Auth**: the bridge key (header `X-MT5-BRIDGE-KEY`, or `bridge_key` query/body field) — same secret
the EA uses. Never expose this endpoint unauthenticated; it dumps queue internals.

```http
GET /api/mt5/audit.php?bridge_key=<MT5_BRIDGE_KEY>&terminal=MT5-TERM-01
```

**Response sections**

| Section | Contents |
| --- | --- |
| `rootCause` | `stage` (`SIGNAL_GENERATION`, `SIGNAL_FILTERS`, `TERMINAL_BINDING`, `PULL_DISPATCH`, `EA_POLLING`, `IN_FLIGHT`, `NONE`) + human-readable detail |
| `storage` | The state-file path, and an explicit note that there is **no SQL** to inspect |
| `signals` | `signal_id`, `symbol`, `direction`, `confidence`, `created_time`, `status`, `order_id`, plus how many were discarded |
| `orderQueue` | `signal_id`, `order_id`, `status`, `terminal`, `symbol`, `volume`, entry/SL/TP, attempts, broker ticket |
| `filters` | Rejection counts per filter bucket and a `signal_id` → `rejection_reason` row per discarded signal |
| `pull` | The literal selection predicate, `recordsFound` vs `recordsReturnedIfPolledNow`, the status/terminal tokens actually present in the queue, unrecognized and **case-only** status/terminal mismatches, and the per-order skip reasons |
| `bridge` | Per-order terminal assignment and any order pinned to a different terminal |
| `derivValidation` | Per-order symbol/volume/SL/TP/order-type compliance; terminal-side facts (symbol existence, margin, permissions) are flagged as EA-reported |
| `ea` | `pullStats` per terminal — proof the EA polled and what it was given |
| `execution` | Per order: dispatched / received by EA / executed / failed, broker ticket and broker message |
| `discrepancies` | `signalsWithoutOrders`, `ordersWithoutSignals`, `queuedNotDelivered`, `deliveredNotExecuted` |
| `events` | The raw permanent lifecycle log |

Regression coverage: `php tests/test_mt5_audit_ledger.php`.
