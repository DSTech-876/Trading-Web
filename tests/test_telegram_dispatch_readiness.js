/**
 * Regression tests for the Telegram dispatch guard in indicator/indicator.js.
 *
 * TRADE auto-sends are scheduled and only run after the chart render delay. By
 * then the setup may already have been reset — the alert then went out as an
 * empty "Entry Active" card in RANGE phase with no direction, confluence 0/16
 * and no levels — or price may have run past the entry, so the pending order
 * the user places from the alert never activates. Both cases must be dropped,
 * and a caption without a live trade must not claim "Entry Active".
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

const context = {
  REPLAY_ENTRY_MIN_RISK_REMAINING: MIN_RISK_REMAINING,
  fmt: (v, d) => Number(v).toFixed(d),
  module: { exports: {} }
};
vm.createContext(context);
vm.runInContext(
  `${extractFunction('evaluateTelegramDispatchReadiness')}\n` +
  `${extractFunction('describeEntryPriceInvalidation')}\n` +
  `${extractFunction('telegramCaptionHeadline')}\n` +
  `module.exports = { evaluateTelegramDispatchReadiness, telegramCaptionHeadline };`,
  context
);
const { evaluateTelegramDispatchReadiness, telegramCaptionHeadline } = context.module.exports;

/* BULL setup: entry 100, sl 98, tp 104, ATR 1, max chase 0.9 ATR. */
function bullState(livePrice, overrides = {}) {
  return {
    phase: 'TRADE',
    breakout: { dir: 'BULL', level: 100 },
    candles: [{ close: livePrice }],
    trade: Object.assign({
      dir: 'BULL', entry: 100, sl: 98, tp: 104, atrAtEntry: 1, maxEntryDistanceAtr: 0.9
    }, overrides)
  };
}

test('a live, still-reachable entry is dispatched', () => {
  const res = evaluateTelegramDispatchReadiness(bullState(100.2));
  assert.equal(res.ready, true);
  assert.equal(res.reason, null);
});

test('an alert scheduled before a reset is not sent once the phase is back in RANGE', () => {
  const state = bullState(100.2);
  state.phase = 'RANGE';
  state.trade = null;
  const res = evaluateTelegramDispatchReadiness(state);
  assert.equal(res.ready, false);
  assert.match(res.reason, /no longer active/);
});

test('an alert is not sent when the trade was cleared but the phase lagged behind', () => {
  const state = bullState(100.2);
  state.trade = null;
  assert.equal(evaluateTelegramDispatchReadiness(state).ready, false);
});

test('a BULL alert is dropped when price already ran past the entry', () => {
  const res = evaluateTelegramDispatchReadiness(bullState(101.5));
  assert.equal(res.ready, false);
  assert.match(res.reason, /ATR from entry/);
});

test('a BULL alert is dropped when price already swept the stop', () => {
  const res = evaluateTelegramDispatchReadiness(bullState(97.9));
  assert.equal(res.ready, false);
  assert.match(res.reason, /past the stop/);
});

test('a BULL alert is dropped when price already reached the target', () => {
  const res = evaluateTelegramDispatchReadiness(bullState(104.1));
  assert.equal(res.ready, false);
  assert.match(res.reason, /reached the target/);
});

test('a BULL alert is dropped when too little stop distance remains', () => {
  const res = evaluateTelegramDispatchReadiness(bullState(98.8, { maxEntryDistanceAtr: 5 }));
  assert.equal(res.ready, false);
  assert.match(res.reason, /stop distance remains/);
});

test('a BEAR alert is dropped when price already ran past the entry', () => {
  const state = {
    phase: 'TRADE',
    breakout: { dir: 'BEAR', level: 100 },
    candles: [{ close: 98.5 }],
    trade: { dir: 'BEAR', entry: 100, sl: 102, tp: 96, atrAtEntry: 1, maxEntryDistanceAtr: 0.9 }
  };
  const res = evaluateTelegramDispatchReadiness(state);
  assert.equal(res.ready, false);
  assert.match(res.reason, /ATR from entry/);
});

test('a BEAR alert is dispatched while price is still near the entry', () => {
  const state = {
    phase: 'TRADE',
    breakout: { dir: 'BEAR', level: 100 },
    candles: [{ close: 99.8 }],
    trade: { dir: 'BEAR', entry: 100, sl: 102, tp: 96, atrAtEntry: 1, maxEntryDistanceAtr: 0.9 }
  };
  assert.equal(evaluateTelegramDispatchReadiness(state).ready, true);
});

test('captions only claim "Entry Active" when a live trade exists', () => {
  assert.equal(telegramCaptionHeadline('TRADE', { entry: 100 }), 'Entry Active');
  assert.match(telegramCaptionHeadline('RANGE', null), /^Status Update/);
  assert.match(telegramCaptionHeadline('TRADE', null), /^Status Update/);
  assert.match(telegramCaptionHeadline('RETEST', { entry: 100 }), /^Status Update/);
});
