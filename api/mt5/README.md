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
- Header: `X-MT5-BRIDGE-KEY: <MT5_BRIDGE_KEY>`
- Or request field/query: `bridge_key`

**GET example**
```http
GET /api/mt5/pull.php?bridge_key=<MT5_BRIDGE_KEY>&limit=20&terminal=MT5-TERM-01
```

**POST request JSON (minimal)**
```json
{
  "bridge_key": "<MT5_BRIDGE_KEY>",
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
- Header: `X-MT5-BRIDGE-KEY: <MT5_BRIDGE_KEY>`
- Or request field: `bridge_key`

### Single update request
```json
{
  "bridge_key": "<MT5_BRIDGE_KEY>",
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
  "bridge_key": "<MT5_BRIDGE_KEY>",
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

`InpBridgeKey` has **no default value** — it must be set explicitly to match `MT5_BRIDGE_KEY` on the
server. Never commit a real bridge key into source control.

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
- **Automatic symbol resolution** — `MT5_SYMBOL_MAP` (server `.env`, JSON object mapping an internal/
  TradingView instrument code to the broker's actual MarketWatch name, e.g.
  `{"stpRNG5":"Step Index 500"}`) is surfaced to the EA as `brokerSymbolHint` on every order
  (`signal.php` response, `pull.php` queue, and `order_status.php`). `ITGuruMt5Bridge.mq5`'s
  `ResolveBrokerSymbol()` tries, in order: exact match → `brokerSymbolHint` → its own
  `InpSymbolAliasMap` input → `InpSymbolSuffixCandidates` → a case/punctuation-insensitive scan of
  every symbol the terminal knows about — logging each attempt (`SYMBOL_RESOLVE` /
  `SYMBOL_RESOLVE_FAIL` events) and caching the result per orderId's symbol code for the EA session.
