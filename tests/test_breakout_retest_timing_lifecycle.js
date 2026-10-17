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

function run(names, context) {
  const harness = `${names.map(extractFunction).join('\n')}\nmodule.exports = { ${names.join(', ')} };`;
  context.module = { exports: {} };
  vm.createContext(context);
  vm.runInContext(harness, context);
  return context.module.exports;
}

test('findHistoricalRetest returns the FIRST touch of the breakout level', () => {
  const context = {
    breakout: { level: 100, candleIdx: 0 },
    candles: [
      { high: 105, low: 103 },  /* 0 breakout */
      { high: 104, low: 102 },  /* 1 */
      { high: 103, low: 100 },  /* 2 first touch */
      { high: 104, low: 101 },  /* 3 */
      { high: 102, low: 100 }   /* 4 later touch */
    ],
    touchesLevel: (candle, level) => candle.low <= level && candle.high >= level
  };
  const { findHistoricalRetest } = run(['findHistoricalRetest'], context);
  assert.equal(findHistoricalRetest(1, 4).candleIdx, 2);
});

test('isRetestRejection accepts a first-touch rejection that closes back beyond the level', () => {
  const context = {
    breakout: { dir: 'BULL', level: 100 },
    touchesLevel: () => true,
    isPinBar: () => true
  };
  const { isRetestRejection } = run(['isRetestRejection'], context);
  assert.equal(isRetestRejection({ open: 100.5, close: 101, high: 101.2, low: 99.5 }), true);
  /* Closing back below the breakout level is not a valid bullish rejection */
  assert.equal(isRetestRejection({ open: 100.5, close: 99.6, high: 101.2, low: 99.5 }), false);

  context.breakout = { dir: 'BEAR', level: 100 };
  const bear = run(['isRetestRejection'], context).isRetestRejection;
  assert.equal(bear({ open: 99.5, close: 99, high: 100.5, low: 98.8 }), true);
  assert.equal(bear({ open: 99.5, close: 100.4, high: 100.5, low: 98.8 }), false);
});

test('adjustIndicesAfterSlice shifts active trade indices so TP/SL monitoring keeps running', () => {
  const context = {
    openingRange: { startIdx: 10, endIdx: 20 },
    breakout: { candleIdx: 30 },
    retestInfo: { candleIdx: 32 },
    indecisionInfo: { candleIdx: 33 },
    confirmInfo: { candleIdx: 34 },
    trade: { entryIdx: 34, outcomeStartIdx: 35 },
    lastLiquiditySweepIdx: 0, lastStopLossHuntIdx: 0, lastFailedPinBarIdx: 0,
    lastFibScalpIdx: 0, lastPo3Idx: 0, lastGridScalperMAIdx: 0,
    lastScalpCandleIdx: 0, lastMtfTopDownIdx: 0,
    signalHistory: [{ candleIdx: 34, result: 'PENDING' }],
    liquiditySweepHistory: [], stopLossHuntHistory: [], failedPinBarHistory: [],
    fibScalpHistory: [], po3History: [], gridScalperMAHistory: [], liveScalpHistory: [],
    nyOpenRangeHistory: [], sessionRangeHistory: [], mtfTopDownHistory: [],
    gridScalperMALossReversalWatch: [],
    gridScalperMAPendingSetup: null,
    getActiveSymbol: () => 'R_75',
    resolvedBreakoutSetups: new Map([
      ['R_75', { dir: 'BULL', level: 100, closedAtIdx: 30 }],
      ['R_100', { dir: 'BULL', level: 50, closedAtIdx: 30 }]
    ])
  };
  const { adjustIndicesAfterSlice } = run(['adjustIndicesAfterSlice'], context);
  adjustIndicesAfterSlice(10);
  assert.equal(context.trade.entryIdx, 24);
  assert.equal(context.trade.outcomeStartIdx, 25);
  assert.equal(context.signalHistory[0].candleIdx, 24);
  assert.equal(context.resolvedBreakoutSetups.get('R_75').closedAtIdx, 20);
  /* A different symbol's record references an independent candle buffer that
     was not trimmed, so it must stay untouched. */
  assert.equal(context.resolvedBreakoutSetups.get('R_100').closedAtIdx, 30);
});

test('enforceTradeLifecycleIntegrity force-removes a trade whose signal already resolved', () => {
  const logs = [];
  const lifecycle = [];
  const context = {
    trade: { symbol: 'R_75', signalId: 'sig-1', entry: 100, dir: 'BULL' },
    breakout: { level: 100 },
    candles: [],
    resolvedBreakoutSetups: new Map(),
    rememberResolvedBreakoutSetup: () => {},
    monitoringTrade: true,
    trailingSL: 99,
    partialTpHit: true,
    teslaT1Hit: true, teslaT2Hit: true, teslaT3Hit: true, teslaBEHit: true,
    multiRHitLevels: [1, 2],
    phase: 'TRADE',
    autoResetEnabled: false,
    PRICE_EPSILON: 1e-8,
    signalHistory: [{ signalId: 'sig-1', symbol: 'R_75', result: 'WIN', entry: 100 }],
    getActiveSymbol: () => 'R_75',
    addLog: (m) => logs.push(m),
    unregisterActiveTradeRecord: () => {},
    cleanupPendingSignalsForSymbol: () => {},
    logSignalLifecycleEvent: (...args) => lifecycle.push(args),
    logSignalEngineDebug: () => {},
    resetForNextSetup: () => {},
    setPhase: (p) => { context.phase = p; }
  };
  const { enforceTradeLifecycleIntegrity } = run(
    ['releaseBreakoutRetestTradeState', 'enforceTradeLifecycleIntegrity'], context);

  assert.equal(enforceTradeLifecycleIntegrity('test'), true);
  assert.equal(context.trade, null);
  assert.equal(context.monitoringTrade, false);
  assert.equal(context.trailingSL, null);
  assert.equal(context.partialTpHit, false);
  assert.equal(context.teslaT1Hit, false);
  assert.equal(context.teslaBEHit, false);
  assert.equal(context.multiRHitLevels.length, 0);
  assert.equal(context.phase, 'BREAKOUT');
  assert.ok(lifecycle.some(([, stage]) => stage === 'Trade Removed'));
});

test('enforceTradeLifecycleIntegrity leaves a genuinely open trade untouched', () => {
  const context = {
    trade: { symbol: 'R_75', signalId: 'sig-2', entry: 100 },
    monitoringTrade: true,
    trailingSL: 99,
    partialTpHit: false,
    teslaT1Hit: false, teslaT2Hit: false, teslaT3Hit: false, teslaBEHit: false,
    multiRHitLevels: [],
    phase: 'TRADE',
    autoResetEnabled: true,
    PRICE_EPSILON: 1e-8,
    signalHistory: [{ signalId: 'sig-2', symbol: 'R_75', result: 'PENDING', entry: 100 }],
    getActiveSymbol: () => 'R_75',
    addLog: () => {},
    unregisterActiveTradeRecord: () => {},
    cleanupPendingSignalsForSymbol: () => {},
    logSignalLifecycleEvent: () => {},
    logSignalEngineDebug: () => {},
    resetForNextSetup: () => {},
    setPhase: (p) => { context.phase = p; }
  };
  const { enforceTradeLifecycleIntegrity } = run(
    ['releaseBreakoutRetestTradeState', 'enforceTradeLifecycleIntegrity'], context);

  assert.equal(enforceTradeLifecycleIntegrity('test'), false);
  assert.notEqual(context.trade, null);
  assert.equal(context.monitoringTrade, true);
  assert.equal(context.phase, 'TRADE');
});

test('enforceTradeLifecycleIntegrity clears an orphaned monitoring flag', () => {
  const context = {
    trade: null,
    monitoringTrade: true,
    trailingSL: null,
    partialTpHit: false,
    teslaT1Hit: false, teslaT2Hit: false, teslaT3Hit: false, teslaBEHit: false,
    multiRHitLevels: [],
    phase: 'TRADE',
    autoResetEnabled: false,
    PRICE_EPSILON: 1e-8,
    signalHistory: [],
    getActiveSymbol: () => 'R_75',
    addLog: () => {},
    unregisterActiveTradeRecord: () => {},
    cleanupPendingSignalsForSymbol: () => {},
    logSignalLifecycleEvent: () => {},
    logSignalEngineDebug: () => {},
    resetForNextSetup: () => {},
    setPhase: (p) => { context.phase = p; }
  };
  const { enforceTradeLifecycleIntegrity } = run(
    ['releaseBreakoutRetestTradeState', 'enforceTradeLifecycleIntegrity'], context);

  assert.equal(enforceTradeLifecycleIntegrity('test'), true);
  assert.equal(context.monitoringTrade, false);
  assert.equal(context.phase, 'BREAKOUT');
});

test('logBreakoutRetestTiming reports breakout/retest/signal indices and the delay cause', () => {
  const logs = [];
  const debug = [];
  const context = {
    breakout: { candleIdx: 10, level: 100, _earliestValidSignalIdx: 12, _delayReasons: ['#12: VWAP filter'] },
    retestInfo: { candleIdx: 12 },
    getActiveSymbol: () => 'R_100',
    addLog: (m) => logs.push(m),
    logSignalEngineDebug: (stage, details) => debug.push([stage, details])
  };
  const { logBreakoutRetestTiming } = run(['logBreakoutRetestTiming'], context);
  logBreakoutRetestTiming(15, 'bullish engulfing');

  const [stage, details] = debug[0];
  assert.equal(stage, 'BREAKOUT_RETEST_TIMING');
  assert.equal(details.breakoutCandleIdx, 10);
  assert.equal(details.retestCandleIdx, 12);
  assert.equal(details.signalCandleIdx, 15);
  assert.equal(details.earliestValidSignalIdx, 12);
  assert.equal(details.delayCandlesFromRetest, 3);
  assert.equal(details.delayCandlesFromEarliestValid, 3);
  assert.ok(logs.some(m => m.includes('VWAP filter')));
});
