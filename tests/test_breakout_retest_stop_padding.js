/**
 * Regression tests for the breakout-retest stop padding added after faster
 * (intrabar) detection started producing trades that hit SL and only afterwards
 * ran to TP:
 *   - collectBreakoutRetestZoneCandles() now includes the whole retest →
 *     confirmation leg (including the still-forming entry candle) so the stop is
 *     anchored beyond the full adverse excursion of the setup.
 *   - getEntryModeStopPadAtr() adds fixed room to intrabar entries, whose
 *     confirmation candle can still wick against the trade after entry.
 *   - getSlThenTpStopPadAtr() widens stops while the Post-SL recovery analytics
 *     show stops being swept before price reaches the original target.
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

function constant(name) {
  const m = new RegExp(`const ${name}\\s*=\\s*([\\d.]+)`).exec(source);
  if (!m) throw new Error(`Missing constant ${name}`);
  return Number(m[1]);
}

const INTRABAR_STOP_PAD_ATR = constant('INTRABAR_STOP_PAD_ATR');
const SL_THEN_TP_PAD_MAX_ATR = constant('SL_THEN_TP_PAD_MAX_ATR');
const SL_THEN_TP_PAD_MIN_SAMPLE = constant('SL_THEN_TP_PAD_MIN_SAMPLE');
const SL_THEN_TP_PAD_THRESHOLD_PCT = constant('SL_THEN_TP_PAD_THRESHOLD_PCT');

const context = {
  INTRABAR_STOP_PAD_ATR, SL_THEN_TP_PAD_MAX_ATR,
  SL_THEN_TP_PAD_MIN_SAMPLE, SL_THEN_TP_PAD_THRESHOLD_PCT,
  module: { exports: {} }
};
vm.createContext(context);
vm.runInContext(
  `${extractFunction('collectBreakoutRetestZoneCandles')}\n` +
  `${extractFunction('getEntryModeStopPadAtr')}\n` +
  `${extractFunction('getSlThenTpStopPadAtr')}\n` +
  'module.exports = { collectBreakoutRetestZoneCandles, getEntryModeStopPadAtr, getSlThenTpStopPadAtr };',
  context
);
const {
  collectBreakoutRetestZoneCandles, getEntryModeStopPadAtr, getSlThenTpStopPadAtr
} = context.module.exports;

const c = (low, high) => ({ low, high, open: low, close: high });

/* The helper runs inside a vm realm, so its arrays are not reference-equal to
   host arrays — compare the element references instead. */
function assertSameCandles(actual, expected) {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => assert.equal(actual[i], e));
}

test('the zone spans the retest leg through the confirmation candle', () => {
  const candles = [c(100, 105), c(98, 103), c(96, 101), c(97, 104), c(99, 106)];
  const zone = collectBreakoutRetestZoneCandles(candles, 1, 2, 4, candles[4]);
  assertSameCandles(zone, [candles[1], candles[2], candles[3], candles[4]]);
  assert.equal(Math.min(...zone.map(x => x.low)), 96);
});

test('the confirmation candle wick is part of the stop zone (intrabar sweep)', () => {
  const candles = [c(100, 105), c(99, 104)];
  /* The forming entry candle dipped to 97 — deeper than the retest candle. */
  const forming = c(97, 106);
  const zone = collectBreakoutRetestZoneCandles(candles, 1, null, 1, forming);
  assert.ok(zone.indexOf(forming) >= 0);
  assert.equal(Math.min(...zone.map(x => x.low)), 97);
});

test('a confirmation candle already inside the span is not duplicated', () => {
  const candles = [c(100, 105), c(99, 104), c(98, 103)];
  const zone = collectBreakoutRetestZoneCandles(candles, 1, 2, 2, candles[2]);
  assertSameCandles(zone, [candles[1], candles[2]]);
});

test('missing zone indexes still fall back to the confirmation candle only', () => {
  const forming = c(97, 106);
  assertSameCandles(collectBreakoutRetestZoneCandles([], null, null, null, forming), [forming]);
  assertSameCandles(collectBreakoutRetestZoneCandles(null, null, null, null, null), []);
});

test('out-of-range indexes are ignored instead of producing holes', () => {
  const candles = [c(100, 105), c(99, 104)];
  const zone = collectBreakoutRetestZoneCandles(candles, 1, 9, 9, candles[1]);
  assertSameCandles(zone, [candles[1]]);
});

test('intrabar entries get extra stop room, confirmed-close entries do not', () => {
  assert.equal(getEntryModeStopPadAtr('aggressive_intrabar'), INTRABAR_STOP_PAD_ATR);
  assert.equal(getEntryModeStopPadAtr('confirmed_close'), 0);
  assert.equal(getEntryModeStopPadAtr(undefined), 0);
});

const analyzer = stats => ({ getStats: () => stats });

test('no adaptive pad without an analyzer or a matching strategy', () => {
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', null), 0);
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', analyzer([])), 0);
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', analyzer([
    { strategy: 'grid_scalper_ma', total_losses: 20, scenario_a_pct: 90 }
  ])), 0);
});

test('no adaptive pad below the minimum sample size or the threshold', () => {
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', analyzer([
    { strategy: 'breakout_retest', total_losses: SL_THEN_TP_PAD_MIN_SAMPLE - 1, scenario_a_pct: 100 }
  ])), 0);
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', analyzer([
    { strategy: 'breakout_retest', total_losses: 50, scenario_a_pct: SL_THEN_TP_PAD_THRESHOLD_PCT }
  ])), 0);
});

test('the adaptive pad scales with the SL-then-TP rate and is capped', () => {
  const mid = getSlThenTpStopPadAtr('breakout_retest', analyzer([
    { strategy: 'breakout_retest', total_losses: 10, scenario_a_pct: (100 + SL_THEN_TP_PAD_THRESHOLD_PCT) / 2 }
  ]));
  assert.ok(mid > 0 && mid < SL_THEN_TP_PAD_MAX_ATR);
  const full = getSlThenTpStopPadAtr('breakout_retest', analyzer([
    { strategy: 'breakout_retest', total_losses: 10, scenario_a_pct: 100 }
  ]));
  assert.equal(full, SL_THEN_TP_PAD_MAX_ATR);
  assert.ok(full > mid);
});

test('a throwing analyzer never blocks trade construction', () => {
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', {
    getStats() { throw new Error('storage unavailable'); }
  }), 0);
  assert.equal(getSlThenTpStopPadAtr('breakout_retest', { getStats: () => null }), 0);
});
