/**
 * Opposite Mode execution tracking.
 *
 * With a strategy's Opposite Mode on, MT5 takes the reversed trade (risk/reward
 * mirrored around the signal entry). The indicator must grade THAT trade, so a
 * signal whose original direction hits TP while the reversed MT5 trade hits SL
 * shows LOSS, and the backtest's "live"/"compare" modes grade the same variant.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Missing function ${name}`);
  let i = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const FNS = [
  'getOppositeExecutionHistories', 'isSignalTypeOppositeActive', 'getEffectiveSignalResult',
  'buildOppositeExecution', '_resolveOppositeExecutionOnCandle', 'trackOppositeExecutions',
  '_btOppositeVariantsFor', '_btNormalizeOppositeMode'
];

function makeContext(overrides = {}) {
  const ctx = vm.createContext(Object.assign({
    candles: [], sessionRangeHistory: [], liveScalpHistory: [], signalHistory: [],
    autoTradeStrategyOppositeMap: { sessionRange: true },
    autoTradeBreakoutOpposite: false, autoTradeScalpOpposite: false,
    gridScalperMAOppositeEnabled: false, _btSilent: false,
    STRATEGY_TYPE_TO_OPPOSITE_KEY: { session_range: 'sessionRange', grid_scalper_ma: 'gridScalperMA' },
    resolved: [],
    onOppositeExecutionResolved(s) { this.resolved.push(s); }
  }, overrides));
  vm.runInContext(extractFunction(SOURCE, 'isStrategyOppositeEnabled'), ctx);
  for (const fn of FNS) vm.runInContext(extractFunction(SOURCE, fn), ctx);
  ctx.onOppositeExecutionResolved = (s) => ctx.resolved.push(s);
  return ctx;
}

test('reversed trade is graded on its own SL/TP: original TP-hit becomes a LOSS', () => {
  const ctx = makeContext();
  /* BUY signal at 100, SL 98 (risk 2), TP 104 (reward 4). Reversed SELL: SL 102, TP 96. */
  const signal = { dir: 'BULL', entry: 100, sl: 98, tp: 104, epoch: 1000, result: 'PENDING' };
  ctx.sessionRangeHistory.push(signal);
  ctx.candles.push({ epoch: 1000, open: 99, high: 103, low: 95, close: 100 });  /* entry candle wick ignored */
  ctx.trackOppositeExecutions(ctx.candles[0]);
  assert.equal(signal._oppExec.dir, 'BEAR');
  assert.equal(signal._oppExec.sl, 102);
  assert.equal(signal._oppExec.tp, 96);
  assert.equal(signal._oppExec.result, 'PENDING', 'entry candle must not resolve the reversed trade');

  ctx.candles.push({ epoch: 1060, open: 100, high: 102.5, low: 99.5, close: 102 });
  ctx.trackOppositeExecutions(ctx.candles[1]);
  assert.equal(signal._oppExec.result, 'LOSS');
  assert.equal(signal._oppExec.exitPrice, 102);
  assert.equal(ctx.resolved.length, 1);

  signal.result = 'WIN';  /* original direction later reaches TP */
  assert.equal(ctx.getEffectiveSignalResult(signal), 'LOSS');
});

test('strategies without Opposite Mode keep their original result', () => {
  const ctx = makeContext({ autoTradeStrategyOppositeMap: { sessionRange: false } });
  const signal = { dir: 'BULL', entry: 100, sl: 98, tp: 104, epoch: 1000, result: 'WIN' };
  ctx.sessionRangeHistory.push(signal);
  ctx.candles.push({ epoch: 1000, open: 99, high: 101, low: 99, close: 100 });
  ctx.trackOppositeExecutions(ctx.candles[0]);
  assert.equal(signal._oppExec, undefined);
  assert.equal(ctx.getEffectiveSignalResult(signal), 'WIN');
});

test('toggles are captured at signal time (later toggle changes do not restamp)', () => {
  const ctx = makeContext({ autoTradeStrategyOppositeMap: { sessionRange: false } });
  const signal = { dir: 'BEAR', entry: 100, sl: 102, tp: 96, epoch: 1000, result: 'PENDING' };
  ctx.sessionRangeHistory.push(signal);
  ctx.candles.push({ epoch: 1000, open: 100, high: 100.5, low: 99.5, close: 100 });
  ctx.trackOppositeExecutions(ctx.candles[0]);
  ctx.autoTradeStrategyOppositeMap.sessionRange = true;
  ctx.trackOppositeExecutions(ctx.candles[0]);
  assert.equal(signal._oppExec, undefined);
});

test('scalp and breakout use their dedicated opposite toggles; Grid MA honours its own toggle', () => {
  const ctx = makeContext({ autoTradeScalpOpposite: true, gridScalperMAOppositeEnabled: true });
  assert.equal(ctx.isSignalTypeOppositeActive('scalp'), true);
  assert.equal(ctx.isSignalTypeOppositeActive('breakout_retest'), false);
  assert.equal(ctx.isSignalTypeOppositeActive('grid_scalper_ma'), true);
});

test('backtest grades the variants live auto-trade would execute', () => {
  const ctx = makeContext({ autoTradeScalpOpposite: true });
  assert.deepEqual([...ctx._btOppositeVariantsFor('session_range', 'live')], [true]);
  assert.deepEqual([...ctx._btOppositeVariantsFor('live_scalp', 'live')], [true]);
  assert.deepEqual([...ctx._btOppositeVariantsFor('breakout_retest', 'live')], [false]);
  assert.deepEqual([...ctx._btOppositeVariantsFor('orb', 'compare')], [false, true]);
  assert.deepEqual([...ctx._btOppositeVariantsFor('orb', ctx._btNormalizeOppositeMode(true))], [true]);
  assert.deepEqual([...ctx._btOppositeVariantsFor('orb', ctx._btNormalizeOppositeMode(''))], [false]);
});
