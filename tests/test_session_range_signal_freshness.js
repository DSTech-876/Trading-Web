/**
 * Session Range (London sweep) signal freshness regression tests.
 *
 * detectLondonAsianSweep() rescans the whole London window on every candle.
 * Without a freshness gate it re-emitted a "new" signal for a sweep that had
 * closed hours earlier — carrying that old candle's entry/SL/TP — whenever the
 * scan was re-armed (historical backfill, mid-session load, panel switch, or a
 * confluence-gate rejection that cleared the latch). That is the "session range
 * signals generating late" symptom these tests lock down.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCES = {
  v1: fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8'),
  v2: fs.readFileSync(path.resolve(__dirname, '../indicatorv2/indicator.js'), 'utf8')
};

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Missing function ${name}`);
  let i = source.indexOf('(', start);
  let parenDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        i = source.indexOf('{', i);
        break;
      }
    }
  }
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

const BAR_SEC = 60;
const ASIAN_HIGH = 110;
const ASIAN_LOW = 90;
const ASIAN_END_IDX = 9;

/**
 * Build a London window where the sweep of the Asian HIGH prints at `sweepIdx`
 * and every other candle stays strictly inside the Asian range.
 */
function buildCandles(totalLondon, sweepIdx) {
  const candles = [];
  for (let i = 0; i <= ASIAN_END_IDX; i++) {
    candles.push({ open: 100, high: ASIAN_HIGH, low: ASIAN_LOW, close: 100, epoch: i * BAR_SEC });
  }
  for (let n = 0; n < totalLondon; n++) {
    const i = ASIAN_END_IDX + 1 + n;
    candles.push(i === sweepIdx
      ? { open: 105, high: 111, low: 104, close: 109, epoch: i * BAR_SEC }   /* wick above, close back inside */
      : { open: 100, high: 105, low: 95, close: 100, epoch: i * BAR_SEC });
  }
  return candles;
}

function makeContext(variant, candles, overrides = {}) {
  const logs = [];
  const timeouts = [];
  const autoTrades = [];
  const ctx = {
    console,
    logs, timeouts, autoTrades,

    sessionRangesEnabled: true,
    sessionRangeAsian: { high: ASIAN_HIGH, low: ASIAN_LOW, startIdx: 0, endIdx: ASIAN_END_IDX },
    sessionRangeLondon: { high: 111, low: 95, startIdx: ASIAN_END_IDX + 1, endIdx: candles.length - 1 },
    sessionRangeNY: null,
    londonSweepSignal: null,
    sessionRangeTrade: null,
    sessionRangeHistory: [],
    SESSION_RANGE_MAX_HISTORY: 20,
    SESSION_RANGE_MAX_SIGNAL_AGE_CANDLES: 1,
    candles,
    atrValue: 1,

    minConfluenceEnabled: false,
    minConfluenceValue: 0,
    checkConfluenceGate: () => ({ pass: true, reason: '' }),
    computeConfluenceScore: () => 10,

    autoTradeStrategyEnabled: false,
    autoTradeSessionRange: false,
    _historicalProcessing: false,
    _multiPanelProcessing: null,
    telegramStrategyAutoSend: false,
    telegramSessionRangeAutoSend: false,
    CHART_RENDER_DELAY_MS: 100,

    UI: { riskInput: { value: '1' }, rewardInput: { value: '2' } },

    getActiveSymbol: () => 'R_100',
    fmt: (v) => String(v),
    fmtPrice: (v) => String(v),
    addLog: (m) => logs.push(m),
    showToast: () => {},
    renderStrategyAlerts: () => {},
    executeAutoTrade: (o) => autoTrades.push(o),
    sendTelegramStrategyAlert: () => {},
    sendTelegramSessionRangeAlert: () => {},
    setTimeout: (fn) => { timeouts.push(fn); return 0; }
  };
  Object.assign(ctx, overrides);
  ctx.module = { exports: {} };
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(SOURCES[variant], 'detectLondonAsianSweep')}\nmodule.exports = { detectLondonAsianSweep };`,
    ctx
  );
  return ctx;
}

for (const variant of ['v1', 'v2']) {
  test(`[${variant}] sweep on the just-closed candle generates a signal immediately`, () => {
    /* Candle-close pipeline: the completed sweep candle is the last element. */
    const candles = buildCandles(5, ASIAN_END_IDX + 5);
    const ctx = makeContext(variant, candles);
    ctx.module.exports.detectLondonAsianSweep(true);

    assert.ok(ctx.londonSweepSignal, 'sweep should latch');
    assert.equal(ctx.londonSweepSignal.candleIdx, candles.length - 1);
    assert.ok(ctx.sessionRangeTrade, 'fresh sweep must produce a trade');
    assert.equal(ctx.sessionRangeTrade.dir, 'BEAR');
    assert.equal(ctx.sessionRangeTrade.entry, 109);
    assert.equal(ctx.sessionRangeHistory.length, 1);
  });

  test(`[${variant}] tick mode: sweep on the previous (closed) candle still signals`, () => {
    /* Tick pipeline appends first, so the completed sweep candle is at len-2. */
    const candles = buildCandles(5, ASIAN_END_IDX + 4);
    const ctx = makeContext(variant, candles);
    ctx.module.exports.detectLondonAsianSweep(false);

    assert.ok(ctx.sessionRangeTrade, 'just-closed sweep must produce a trade in tick mode');
    assert.equal(ctx.sessionRangeTrade.entryIdx, candles.length - 2);
  });

  test(`[${variant}] stale sweep latches but never generates a late signal`, () => {
    /* Sweep printed 20 candles ago — the mid-session-load / backfill case. */
    const candles = buildCandles(25, ASIAN_END_IDX + 5);
    const ctx = makeContext(variant, candles, {
      autoTradeStrategyEnabled: true,
      autoTradeSessionRange: true,
      telegramStrategyAutoSend: true,
      telegramSessionRangeAutoSend: true
    });
    ctx.module.exports.detectLondonAsianSweep(true);

    assert.ok(ctx.londonSweepSignal, 'session should still be marked as swept');
    assert.equal(ctx.sessionRangeTrade, null, 'stale sweep must not create a trade');
    assert.equal(ctx.sessionRangeHistory.length, 0, 'stale sweep must not enter history');
    assert.equal(ctx.autoTrades.length, 0, 'stale sweep must not auto-trade');
    assert.equal(ctx.timeouts.length, 0, 'stale sweep must not queue Telegram alerts');
    assert.ok(ctx.logs.some(l => l.includes('stale')), 'stale sweep should be logged');
  });

  test(`[${variant}] still-forming candle neither latches nor signals`, () => {
    const candles = buildCandles(5, ASIAN_END_IDX + 5);
    const ctx = makeContext(variant, candles);
    ctx.module.exports.detectLondonAsianSweep(false); /* last element still forming */

    assert.equal(ctx.londonSweepSignal, null, 'forming candle must not latch the sweep');
    assert.equal(ctx.sessionRangeTrade, null, 'forming candle must not signal');

    /* Once that same candle closes, the signal fires on time. */
    ctx.module.exports.detectLondonAsianSweep(true);
    assert.ok(ctx.sessionRangeTrade, 'signal fires on the real close');
  });

  test(`[${variant}] confluence rejection consumes the sweep instead of re-firing later`, () => {
    const sweepIdx = ASIAN_END_IDX + 5;
    const candles = buildCandles(5, sweepIdx);
    const ctx = makeContext(variant, candles, {
      minConfluenceEnabled: true,
      minConfluenceValue: 8,
      checkConfluenceGate: () => ({ pass: false, reason: 'confluence 2/8 below minimum' }),
      computeConfluenceScore: () => 2
    });
    ctx.module.exports.detectLondonAsianSweep(true);

    assert.equal(ctx.sessionRangeTrade, null, 'rejected sweep must not trade');
    assert.ok(ctx.londonSweepSignal, 'rejected sweep must stay latched so it is not rescanned');

    /* Later candles arrive and confluence now passes — the old sweep must NOT
       resurface with its stale entry price. */
    for (let n = 0; n < 6; n++) {
      candles.push({ open: 100, high: 105, low: 95, close: 100, epoch: candles.length * BAR_SEC });
    }
    ctx.sessionRangeLondon.endIdx = candles.length - 1;
    ctx.checkConfluenceGate = () => ({ pass: true, reason: '' });
    ctx.computeConfluenceScore = () => 10;
    ctx.module.exports.detectLondonAsianSweep(true);

    assert.equal(ctx.sessionRangeTrade, null, 'stale sweep must never fire late');
    assert.equal(ctx.sessionRangeHistory.length, 0);
  });
}
