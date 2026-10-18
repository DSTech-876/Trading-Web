/**
 * Regression tests for evaluateCatchUpEntryAgainstLiveMarket() in indicator/indicator.js.
 *
 * The retest catch-up replay (and the post-range catch-up loop) can build a trade
 * for a candle that is no longer the live candle. The entry is priced at that old
 * candle's close while the real fill happens at the live price, so a stale entry
 * was being chased straight into the stop. Such entries are now rejected when the
 * market has already resolved or run away from the setup.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Missing function ${name}`);
  let i = source.indexOf('(', start);
  let parenDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) { i = source.indexOf('{', i); break; }
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

const MIN_RISK_REMAINING = Number(
  /const REPLAY_ENTRY_MIN_RISK_REMAINING = ([\d.]+)/.exec(source)[1]
);

function build(candles, options = {}) {
  const context = {
    candles,
    _historicalProcessing: options.historical === true,
    backtestMode: options.backtestMode === true,
    REPLAY_ENTRY_MIN_RISK_REMAINING: MIN_RISK_REMAINING,
    getSignalDistanceLimitAtr: () => (options.maxDistanceAtr != null ? options.maxDistanceAtr : 0.9),
    fmt: (v, d) => Number(v).toFixed(d),
    module: { exports: {} }
  };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction('evaluateCatchUpEntryAgainstLiveMarket')}\n` +
    `module.exports = { evaluateCatchUpEntryAgainstLiveMarket };`,
    context
  );
  return context.module.exports.evaluateCatchUpEntryAgainstLiveMarket;
}

/* entry 100, sl 98, tp 104 — bar 0 is the catch-up entry candle. */
function bullCandles(liveClose, extra = {}) {
  return [
    { open: 99, close: 100, high: 100.2, low: 99 },
    { open: 100, close: liveClose, high: extra.high != null ? extra.high : Math.max(100, liveClose), low: extra.low != null ? extra.low : Math.min(100, liveClose) }
  ];
}

test('live entry on the newest candle is never treated as a catch-up entry', () => {
  const fn = build(bullCandles(100.1));
  assert.equal(fn('BULL', 1, 100, 98, 104, 1), null);
});

test('BULL catch-up entry is rejected when the stop was already swept in the skipped window', () => {
  const fn = build(bullCandles(100.1, { low: 97.5 }));
  const reason = fn('BULL', 0, 100, 98, 104, 1);
  assert.match(String(reason), /already swept/);
});

test('BULL catch-up entry is rejected when the target was already reached', () => {
  const fn = build(bullCandles(104.2, { high: 104.5 }));
  const reason = fn('BULL', 0, 100, 98, 104, 1);
  assert.match(String(reason), /already reached/);
});

test('BULL catch-up entry is rejected when price has run too far from the entry', () => {
  const fn = build(bullCandles(101.5), { maxDistanceAtr: 0.9 });
  const reason = fn('BULL', 0, 100, 98, 104, 1);
  assert.match(String(reason), /ATR from entry/);
});

test('BULL catch-up entry is rejected when too little stop distance remains at the live price', () => {
  const fn = build(bullCandles(98.8), { maxDistanceAtr: 5 });
  const reason = fn('BULL', 0, 100, 98, 104, 1);
  assert.match(String(reason), /stop distance remains/);
});

test('BULL catch-up entry is allowed when price is still close to the entry', () => {
  const fn = build(bullCandles(100.2));
  assert.equal(fn('BULL', 0, 100, 98, 104, 1), null);
});

test('BEAR catch-up entry is rejected when the stop was already swept', () => {
  const candles = [
    { open: 101, close: 100, high: 101, low: 99.8 },
    { open: 100, close: 99.9, high: 102.5, low: 99.5 }
  ];
  const fn = build(candles);
  const reason = fn('BEAR', 0, 100, 102, 96, 1);
  assert.match(String(reason), /already swept/);
});

test('BEAR catch-up entry is allowed when price is still near the entry', () => {
  const candles = [
    { open: 101, close: 100, high: 101, low: 99.8 },
    { open: 100, close: 99.9, high: 100.1, low: 99.7 }
  ];
  const fn = build(candles);
  assert.equal(fn('BEAR', 0, 100, 102, 96, 1), null);
});

test('historical re-processing and backtests keep their existing behaviour', () => {
  const historical = build(bullCandles(100.1, { low: 97.5 }), { historical: true });
  assert.equal(historical('BULL', 0, 100, 98, 104, 1), null);
  const backtest = build(bullCandles(100.1, { low: 97.5 }), { backtestMode: true });
  assert.equal(backtest('BULL', 0, 100, 98, 104, 1), null);
});
