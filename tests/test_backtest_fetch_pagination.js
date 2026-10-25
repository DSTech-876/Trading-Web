const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
 * Regression test for a real-world bug: Deriv's public `ticks_history` feed
 * can silently cap a single "candles" response at 1000 rows regardless of
 * the `count` requested (e.g. 5000), with no error returned. The old
 * `backtestFetchHistory` loop treated *any* short page as "we've reached the
 * start of available history" and stopped paging — silently handing back a
 * much shorter window than the user configured, with no truncation warning
 * (a 24-day backtest request quietly became ~17 hours of data for every
 * symbol). The fix must keep paging backward past a short page as long as
 * it's still making progress, and only report `truncated: true` once the
 * feed genuinely stops yielding older candles before the requested start.
 */

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

function extractFunction(name) {
  const token = `function ${name}(`;
  const start = source.indexOf(token);
  if (start === -1) throw new Error(`Missing function ${name}`);
  let i = source.indexOf('(', start);
  let parenDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    if (source[i] === ')') { parenDepth--; if (parenDepth === 0) { i = source.indexOf('{', i); break; } }
  }
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`Unclosed function ${name}`);
}

const GRAN = 60;
const TOTAL_CANDLES = 3000;
const BASE = 1700000000;
const ALL_EPOCHS = Array.from({ length: TOTAL_CANDLES }, (_, i) => BASE + i * GRAN);

function loadFetchHistory(requestsSink, { capPerPage = 1000 } = {}) {
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
    }
    send(raw) {
      const req = JSON.parse(raw);
      requestsSink.push(req);
      const matching = ALL_EPOCHS.filter(e => e >= req.start && e <= req.end);
      /* Simulate the provider silently capping every response, independent of
         the `count` actually requested. */
      const page = matching.slice(-capPerPage).map(e => ({ epoch: e, open: 1, high: 1, low: 1, close: 1 }));
      setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ candles: page }) }); }, 0);
    }
    close() {}
  }

  const ctx = {
    WebSocket: FakeWebSocket,
    PUBLIC_WS_URL: 'wss://fake',
    BT_FETCH_TIMEOUT_MS: 5000,
    BT_MAX_HISTORY_PAGES: 24,
    BT_PAGE_SIZE: 5000,
    BT_MAX_CANDLES: 60000,
    setTimeout, clearTimeout, console, Array, Number, Math, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction('backtestFetchHistory')}\nthis.backtestFetchHistory = backtestFetchHistory;`, ctx);
  return ctx.backtestFetchHistory;
}

test('backtestFetchHistory pages past a provider that caps every response below the requested count', async () => {
  const reqs = [];
  const backtestFetchHistory = loadFetchHistory(reqs, { capPerPage: 1000 });
  const startSec = BASE;
  const endSec = BASE + (TOTAL_CANDLES - 1) * GRAN;

  const result = await backtestFetchHistory('SYM', GRAN, startSec, endSec, () => {});

  assert.equal(result.data.length, TOTAL_CANDLES, 'must retrieve the full history, not just the first capped page');
  assert.equal(result.truncated, false, 'the full requested window was actually covered');
  assert.equal(result.data[0].epoch, startSec);
  assert.ok(reqs.length > 1, 'must have made more than one page request to get past the 1000-row cap');
});

test('backtestFetchHistory reports truncated when the feed genuinely runs out before the requested start', async () => {
  const reqs = [];
  const backtestFetchHistory = loadFetchHistory(reqs, { capPerPage: 1000 });
  const startSec = BASE - 10000 * GRAN;  /* predates all available history */
  const endSec = BASE + (TOTAL_CANDLES - 1) * GRAN;

  const result = await backtestFetchHistory('SYM', GRAN, startSec, endSec, () => {});

  assert.equal(result.data.length, TOTAL_CANDLES, 'should still return everything the feed actually has');
  assert.equal(result.truncated, true, 'must flag truncation so the UI warns the user the range was not fully covered');
});

test('backtestFetchHistory finishes cleanly (not truncated) when a single page already covers the whole window', async () => {
  const reqs = [];
  const backtestFetchHistory = loadFetchHistory(reqs, { capPerPage: 5000 });
  const startSec = BASE + 2500 * GRAN;
  const endSec = BASE + (TOTAL_CANDLES - 1) * GRAN;

  const result = await backtestFetchHistory('SYM', GRAN, startSec, endSec, () => {});

  assert.equal(result.truncated, false);
  assert.equal(reqs.length, 1);
  assert.equal(result.data[0].epoch, startSec);
});

test('backtestFetchHistory accommodates capped responses with increased page limit (>24000 candles)', async () => {
  /* Create a larger fixture to test the increased BT_MAX_HISTORY_PAGES limit.
     With 1000 candles per page, 24 pages = 24,000 candles.
     With increased limit to 75, we should support up to 75,000 candles (more than 60K safety cap). */
  const TOTAL = 30000;  /* 30,000 candles: more than 24,000 but less than 60,000 cap */
  const ALL_EPOCHS_LARGE = Array.from({ length: TOTAL }, (_, i) => BASE + i * GRAN);

  const reqs = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
    }
    send(raw) {
      const req = JSON.parse(raw);
      reqs.push(req);
      const matching = ALL_EPOCHS_LARGE.filter(e => e >= req.start && e <= req.end);
      /* Simulate provider capping at 1000 per page */
      const page = matching.slice(-1000).map(e => ({ epoch: e, open: 1, high: 1, low: 1, close: 1 }));
      setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ candles: page }) }); }, 0);
    }
    close() {}
  }

  const ctx = {
    WebSocket: FakeWebSocket,
    PUBLIC_WS_URL: 'wss://fake',
    BT_FETCH_TIMEOUT_MS: 5000,
    BT_MAX_HISTORY_PAGES: 75,  /* increased from 24 */
    BT_PAGE_SIZE: 5000,
    BT_MAX_CANDLES: 60000,
    setTimeout, clearTimeout, console, Array, Number, Math, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction('backtestFetchHistory')}\nthis.backtestFetchHistory = backtestFetchHistory;`, ctx);
  const backtestFetchHistory = ctx.backtestFetchHistory;

  const startSec = BASE;
  const endSec = BASE + (TOTAL - 1) * GRAN;

  const result = await backtestFetchHistory('SYM', GRAN, startSec, endSec, () => {});

  /* With 30,000 candles and 1000 per page, we need 30 pages.
     The original limit of 24 would truncate at 24,000.
     The new limit of 75 should allow 30 pages. */
  assert.equal(result.data.length, TOTAL, `must retrieve all ${TOTAL} candles with increased page limit`);
  assert.equal(result.truncated, false, 'should not be truncated when within 60K safety cap');
  assert.ok(reqs.length >= 30, `must make at least 30 page requests for ${TOTAL} candles at 1K per page`);
});
