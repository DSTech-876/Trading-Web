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

function makeMonitorContext(variant, trade) {
  const ctx = {
    console,
    sessionRangesEnabled: true,
    sessionRangeTrade: trade,
    sessionRangeHistory: [trade],
    sessionRangeTradeWins: 0,
    sessionRangeTradeLosses: 0,
    telegramSessionRangeOutcomeSend: false,
    _historicalProcessing: false,
    _multiPanelProcessing: null,
    _checkProfitExitAlert: () => false,
    resolveBothHit: () => 'LOSS',
    sendStrategyOutcomeTelegram: () => {},
    sendSessionRangeOutcomeTelegram: () => {},
    addLog: () => {}, showToast: () => {}, playPhaseAlert: () => {}, renderStrategyAlerts: () => {},
    fmt: (v) => String(v), fmtPrice: (v) => String(v),
    setTimeout: () => 0,
    module: { exports: {} }
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(SOURCES[variant], 'monitorSessionRangeTradeOutcome')}\nmodule.exports = { monitorSessionRangeTradeOutcome };`,
    ctx
  );
  return ctx;
}

function makeBuildContext(variant, overrides) {
  const ctx = {
    console,
    SESSION_ASIAN: { start: 0, end: 9 },
    SESSION_LONDON: { start: 7, end: 16 },
    SESSION_NEW_YORK: { start: 12, end: 21 },
    ASIAN_TIGHT_ATR_MULT: 1.0,
    sessionRangesEnabled: true,
    atrValue: 2,
    asianRangeTight: false,
    sessionRangeAsian: null, sessionRangeLondon: null, sessionRangeNY: null,
    telegramSessionRangeAutoSend: false,
    _historicalProcessing: true,
    _multiPanelProcessing: null,
    CHART_RENDER_DELAY_MS: 0,
    setTimeout: () => 0,
    module: { exports: {} },
    ...overrides
  };
  vm.createContext(ctx);
  vm.runInContext(
    [
      extractFunction(SOURCES[variant], 'getCandleSessionFlags'),
      extractFunction(SOURCES[variant], 'resetSessionRanges'),
      extractFunction(SOURCES[variant], 'buildSessionRanges')
    ].join('\n') + '\nmodule.exports = { buildSessionRanges };',
    ctx
  );
  return ctx;
}

for (const variant of ['v1', 'v2']) {
  test(`[${variant}] entry candle's pre-entry wick cannot mark the trade a WIN`, () => {
    /* SELL sweep candle: high 111, close 109, low 100 — the low already sits
       below TP (105), but it printed before entry at the close. */
    const trade = { entry: 109, sl: 112, tp: 103, dir: 'BEAR', rr: 2, result: 'PENDING', epoch: 600 };
    const ctx = makeMonitorContext(variant, trade);

    ctx.module.exports.monitorSessionRangeTradeOutcome({ open: 105, high: 111, low: 100, close: 109, epoch: 600 });
    assert.equal(trade.result, 'PENDING', 'entry candle must not resolve the trade');
    assert.equal(ctx.sessionRangeTradeWins, 0);

    /* Next candle runs up through the stop — that is the real outcome (MT5 SL). */
    ctx.module.exports.monitorSessionRangeTradeOutcome({ open: 109, high: 113, low: 108, close: 112, epoch: 660 });
    assert.equal(trade.result, 'LOSS');
    assert.equal(ctx.sessionRangeTradeLosses, 1);
    assert.equal(ctx.sessionRangeTradeWins, 0);
  });

  test(`[${variant}] day rollover reset is deferred, not skipped, while a trade is PENDING`, () => {
    const day1 = Date.UTC(2026, 0, 1, 15, 0, 0) / 1000;
    const day2 = Date.UTC(2026, 0, 2, 1, 0, 0) / 1000;
    const pending = { entry: 100, sl: 95, tp: 110, dir: 'BULL', result: 'PENDING' };
    const ctx = makeBuildContext(variant, {
      candles: [{ epoch: day1, high: 105, low: 95 }, { epoch: day2, high: 106, low: 96 }],
      londonSweepSignal: { dir: 'LOW', candleIdx: 0, price: 95 },
      sessionRangeTrade: pending,
      lastSessionRangeBuildDate: '2026-01-01'
    });

    ctx.module.exports.buildSessionRanges();
    assert.equal(ctx.sessionRangeTrade, pending, 'open trade survives the rollover');
    assert.ok(ctx.londonSweepSignal, 'latch stays while the trade is open');

    /* Trade resolves later on day 2 — the next build must now clear
       yesterday's latch so today's London sweep can still be detected. */
    pending.result = 'WIN';
    ctx.sessionRangeTrade = null;
    ctx.candles.push({ epoch: day2 + 60, high: 106, low: 96 });
    ctx.module.exports.buildSessionRanges();
    assert.equal(ctx.londonSweepSignal, null, "yesterday's sweep latch must be cleared once the trade closes");
    assert.equal(ctx.lastSessionRangeBuildDate, '2026-01-02');
  });
}
