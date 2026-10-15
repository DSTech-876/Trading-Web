/* Regression tests for the PR #449 review follow-up fixes:
 *   1. monitorTradeOutcome() must honor a partial-TP/Tesla-level deferral for the
 *      REST of the candle it occurred on, even across repeated intrabar calls.
 *   2. enforceTradeLifecycleIntegrity() must resolve by signalId first and only
 *      fall back to the symbol+entry lookup when the ID lookup misses.
 *   3. monitorTradeOutcome() must emit a level-hit lifecycle event for every
 *      SL/TP resolution path, including profitable trailing-stop exits and
 *      both-hit (SL+TP same candle) resolutions.
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

function baseTradeContext(overrides = {}) {
  return Object.assign({
    monitoringTrade: true,
    trade: {
      symbol: 'R_50', signalId: 'sig-1', entry: 100, sl: 95, tp: 115, dir: 'BULL'
    },
    signalHistory: [{ signalId: 'sig-1', result: 'PENDING', symbol: 'R_50', entry: 100, sl: 95, tp: 115, dir: 'BULL' }],
    trailingSL: null,
    partialTpHit: false,
    _deferredOutcomeCandleIdx: null,
    partialTpEnabled: true,
    trailingStopEnabled: false,
    teslaScalingEnabled: false,
    teslaBEHit: false,
    teslaT1Hit: false,
    teslaT2Hit: false,
    teslaT3Hit: false,
    pureTrailingEnabled: false,
    atrValue: 0,
    phase: 'TRADE',
    signalWins: 0,
    signalLosses: 0,
    signalBreakevens: 0,
    adaptiveConfluenceEnabled: false,
    _historicalProcessing: false,
    getActiveSymbol: () => 'R_50',
    findPendingTradeSignal: () => null,
    logSignalLifecycleEvent: () => {},
    logSignalEngineDebug: () => {},
    setPhase: (value) => { context.phase = value; },
    sendTradeOutcomeTelegram: () => {},
    persistSignalHistory: () => {},
    updateStatsUI: () => {},
    playPhaseAlert: () => {},
    recordConfluenceOutcome: () => false,
    rebuildWalkForwardProfilesFromHistory: () => {},
    isSymbolEligibleForNewSignal: () => true,
    releaseBreakoutRetestTradeState: () => {},
    addLog: () => {},
    fmt: (n, decimals) => n.toFixed(decimals),
    fmtPrice: (n) => String(n),
    showToast: () => {},
    sendPartialTpTelegram: () => {},
    sendTeslaLevelTelegram: () => {},
    logTradeLevelHit: () => {},
    resolveBothHit: () => 'LOSS',
    getCurrentRegimeTag: () => 'NEUTRAL',
    PRICE_EPSILON: 0.00001,
    TESLA_CONSERVATIVE_BE_TRIGGER: 1,
    TESLA_AGGRESSIVE_BE_TRIGGER: 2,
    TESLA_T1_R: 3,
    TESLA_T2_R: 6,
    TESLA_T3_R: 9,
    TRAILING_STOP_ATR_MULT: 2,
    SCALP_TRAILING_ATR_MULT: 1,
    GENERAL_TRADE_STALL_TIMEOUT_CANDLES: 999,
    SCALP_MAX_CANDLES: 999
  }, overrides);
}

test('monitorTradeOutcome keeps deferring SL/TP resolution across repeated calls on the same candle after a partial-TP hit', () => {
  const finalizeCalls = [];
  const candle = { high: 116, low: 99, close: 110 }; /* also touches TP (115) and SL would not be hit */
  const context = baseTradeContext({
    candles: [candle],
    finalizeBreakoutRetestTrade: (pending, tradeSymbol, currentIdx) => {
      finalizeCalls.push({ pending, tradeSymbol, currentIdx });
    }
  });
  const { monitorTradeOutcome } = run(['monitorTradeOutcome'], context);

  /* First call: partial TP (1:1 = entry+risk = 100+5=105) is hit by high=116,
     so the function must defer and return without checking TP (115, also hit by 116). */
  monitorTradeOutcome(candle);
  assert.equal(context.partialTpHit, true, 'partial TP flag should be set on first call');
  assert.equal(finalizeCalls.length, 0, 'trade must not resolve on the same candle as the partial TP hit');
  assert.equal(context._deferredOutcomeCandleIdx, 0, 'deferred candle index should be recorded');

  /* Second call on the SAME candle (candles.length unchanged): previously this would
     fall through the now-true partialTpHit guard and resolve the TP that is also hit
     by the same candle, defeating the one-candle deferral. */
  monitorTradeOutcome(candle);
  assert.equal(finalizeCalls.length, 0, 'repeated same-candle calls must continue to defer resolution');

  /* Once a new candle arrives, resolution should proceed normally. */
  const nextCandle = { high: 116, low: 99, close: 110 };
  context.candles.push(nextCandle);
  monitorTradeOutcome(nextCandle);
  assert.equal(finalizeCalls.length, 1, 'resolution should proceed on the next candle');
});

test('enforceTradeLifecycleIntegrity resolves a stale signalId by falling back to the symbol+entry lookup', () => {
  const lifecycle = [];
  const context = {
    trade: { symbol: 'R_75', signalId: 'stale-signal-id', entry: 100 },
    monitoringTrade: true,
    trailingSL: null,
    partialTpHit: false,
    teslaT1Hit: false, teslaT2Hit: false, teslaT3Hit: false, teslaBEHit: false,
    multiRHitLevels: [],
    phase: 'TRADE',
    autoResetEnabled: false,
    PRICE_EPSILON: 1e-8,
    /* No record carries the stale signalId, but a resolved record with the same
       symbol + entry exists (e.g. restored from older history without the id). */
    signalHistory: [{ signalId: 'other-id', symbol: 'R_75', result: 'WIN', entry: 100 }],
    getActiveSymbol: () => 'R_75',
    addLog: () => {},
    unregisterActiveTradeRecord: () => {},
    cleanupPendingSignalsForSymbol: () => {},
    logSignalLifecycleEvent: (...args) => lifecycle.push(args),
    logSignalEngineDebug: () => {},
    resetForNextSetup: () => {},
    setPhase: (p) => { context.phase = p; }
  };
  const { enforceTradeLifecycleIntegrity } = run(
    ['releaseBreakoutRetestTradeState', 'enforceTradeLifecycleIntegrity'], context);

  assert.equal(enforceTradeLifecycleIntegrity('test'), true,
    'fail-safe must force-remove the trade via the symbol+entry fallback when the id lookup misses');
  assert.equal(context.trade, null);
  assert.equal(context.monitoringTrade, false);
  assert.ok(lifecycle.some(([, stage]) => stage === 'Trade Removed'));
});

test('monitorTradeOutcome emits a level-hit event for a profitable trailing-stop SL exit', () => {
  const levelHitCalls = [];
  const finalizeCalls = [];
  const candle = { high: 101, low: 108, close: 108 }; /* BEAR trade: SL (trailing, below entry... see below) */
  const context = baseTradeContext({
    partialTpEnabled: false,
    trade: { symbol: 'R_50', signalId: 'sig-1', entry: 100, sl: 95, tp: 80, dir: 'BEAR' },
    signalHistory: [{ signalId: 'sig-1', result: 'PENDING', symbol: 'R_50', entry: 100, sl: 95, tp: 80, dir: 'BEAR' }],
    trailingSL: 97, /* below entry (100) is BULL profit-lock direction; for BEAR, below entry is... */
    candles: [{ high: 101, low: 108, close: 99 }],
    logTradeLevelHit: (...args) => levelHitCalls.push(args),
    finalizeBreakoutRetestTrade: (pending, tradeSymbol, currentIdx) => {
      finalizeCalls.push({ pending, tradeSymbol, currentIdx });
    }
  });
  /* For a BEAR trade, a profitable trailing stop sits BELOW entry (effectiveSL < entry)
     and is triggered when candle.high >= effectiveSL. */
  context.trailingSL = 97;
  const triggerCandle = { high: 98, low: 90, close: 92 };
  context.candles = [triggerCandle];
  const { monitorTradeOutcome } = run(['monitorTradeOutcome'], context);

  monitorTradeOutcome(triggerCandle);

  assert.equal(finalizeCalls.length, 1, 'trade should resolve on the profitable trailing-stop exit');
  assert.equal(finalizeCalls[0].pending.result, 'WIN', 'trailing stop below entry on a BEAR trade is a profit lock (WIN)');
  assert.equal(levelHitCalls.length, 1, 'a level-hit lifecycle event must be emitted for the profitable trailing-stop exit');
  assert.equal(levelHitCalls[0][0], 'SL', 'the emitted event should be tagged as an SL-level hit');
});

test('monitorTradeOutcome emits a level-hit event for a both-hit (SL+TP same candle) resolution', () => {
  const levelHitCalls = [];
  const finalizeCalls = [];
  const candle = { high: 116, low: 94, close: 100 }; /* both SL (95) and TP (115) touched */
  const context = baseTradeContext({
    partialTpEnabled: false,
    candles: [candle],
    resolveBothHit: () => 'LOSS',
    logTradeLevelHit: (...args) => levelHitCalls.push(args),
    finalizeBreakoutRetestTrade: (pending, tradeSymbol, currentIdx) => {
      finalizeCalls.push({ pending, tradeSymbol, currentIdx });
    }
  });
  const { monitorTradeOutcome } = run(['monitorTradeOutcome'], context);

  monitorTradeOutcome(candle);

  assert.equal(finalizeCalls.length, 1, 'trade should resolve on a both-hit candle');
  assert.equal(levelHitCalls.length, 1, 'a level-hit lifecycle event must be emitted for both-hit resolutions');
  assert.equal(levelHitCalls[0][0], 'SL', 'resolveBothHit returned LOSS, so the emitted event should be tagged SL');
});
