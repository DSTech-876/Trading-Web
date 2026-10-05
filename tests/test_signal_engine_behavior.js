const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

function extractBetween(startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start);
  if (start === -1 || end === -1) throw new Error(`Unable to extract snippet: ${startToken}`);
  return source.slice(start, end);
}

function extractFunction(name) {
  const startToken = `function ${name}(`;
  const asyncStartToken = `async function ${name}(`;
  const start = source.indexOf(asyncStartToken) !== -1
    ? source.indexOf(asyncStartToken)
    : source.indexOf(startToken);
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
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

test('symbol eligibility re-opens after TP/SL loop resolution', () => {
  const fnSource = extractFunction('isSymbolEligibleForNewSignal');
  const harness = `${fnSource}\nmodule.exports = { isSymbolEligibleForNewSignal };`;
  const context = {
    module: { exports: {} },
    monitoringTrade: false,
    trade: null,
    signalHistory: [],
    getActiveSymbol: () => 'R_100'
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { isSymbolEligibleForNewSignal } = context.module.exports;

  assert.equal(isSymbolEligibleForNewSignal('R_100', 'breakout_retest'), true);

  context.monitoringTrade = true;
  context.trade = { symbol: 'R_100' };
  assert.equal(isSymbolEligibleForNewSignal('R_100', 'breakout_retest'), false);

  context.monitoringTrade = false;
  context.trade = null;
  context.signalHistory = [{ symbol: 'R_100', strategyType: 'breakout_retest', result: 'PENDING' }];
  assert.equal(isSymbolEligibleForNewSignal('R_100', 'breakout_retest'), false);

  context.signalHistory[0].result = 'WIN';
  assert.equal(isSymbolEligibleForNewSignal('R_100', 'breakout_retest'), true);

  context.signalHistory[0].result = 'LOSS';
  assert.equal(isSymbolEligibleForNewSignal('R_100', 'breakout_retest'), true);

  context.monitoringTrade = true;
  context.trade = { symbol: 'R_100' };
  context.signalHistory = [];
  assert.equal(isSymbolEligibleForNewSignal('R_100', 'mtf_top_down'), true);
});

test('strategy reset contracts clear strategy registries/caches', () => {
  const snippet = extractBetween('const strategyStateRegistry = new Map();', 'function resetIndicator()');
  const context = {
    module: { exports: {} },
    Map,
    addLog: () => {},
    setPhase: () => {},
    resetNyOpenRange: () => {},
    resetSessionRanges: () => {},

    openingRange: { x: 1 },
    breakout: { x: 1 },
    retestInfo: { x: 1 },
    indecisionInfo: { x: 1 },
    confirmInfo: { x: 1 },
    trade: { x: 1 },
    monitoringTrade: true,
    trailingSL: 1,
    partialTpHit: true,
    teslaT1Hit: true,
    teslaT2Hit: true,
    teslaT3Hit: true,
    teslaBEHit: true,
    retestCount: 2,
    mtfSetupState: { x: 1 },
    lastMtfSetupAlertKey: 'x',
    lastMtfApproachAlertKey: 'y',

    signalHistory: [{}],
    liveScalpHistory: [{}],
    liquiditySweepHistory: [{}],
    stopLossHuntHistory: [{}],
    failedPinBarHistory: [{}],
    fibScalpHistory: [{}],
    po3History: [{}],
    gridScalperMAHistory: [{}],
    fvgStratHistory: [{}],
    mtfTopDownHistory: [{}],
    tiktokHistory: [{}],
    orderblockHistory: [{}],
    candleInterpHistory: [{}],
    po3_4hHistory: [{}],
    breakerBlockHistory: [{}],
    oteGoldenPocketHistory: [{}],
    orbHistory: [{}],
    crtTbsHistory: [{}],
    nyOpenRangeHistory: [{}],
    sessionRangeHistory: [{}],
    lastMtfTopDownIdx: 99
  };

  vm.createContext(context);
  vm.runInContext(`${snippet}\nmodule.exports = { initStrategyStateRegistry, resetStrategyStateContracts };`, context);

  const { initStrategyStateRegistry, resetStrategyStateContracts } = context.module.exports;
  initStrategyStateRegistry();
  resetStrategyStateContracts('core');
  assert.equal(context.trade, null);
  assert.equal(context.monitoringTrade, false);
  assert.equal(context.mtfSetupState, null);

  resetStrategyStateContracts('session');
  assert.equal(context.signalHistory.length, 0);
  assert.equal(context.mtfTopDownHistory.length, 0);
  assert.equal(context.breakerBlockHistory.length, 0);
  assert.equal(context.lastMtfTopDownIdx, -999);
});

test('MTF pipeline warmup uses expanded fetch count and session reset clears diagnostics', () => {
  assert.match(source, /\) \+ \(Math\.max\(MTF_BIAS_TF_MULT, MTF_SETUP_TF_MULT\) - 1\);/);
  assert.match(source, /const MTF_HISTORY_FETCH_COUNT = Math\.max\(100, MTF_REQUIRED_BASE_CANDLES \+ 32\)/);
  assert.match(source, /count: MTF_HISTORY_FETCH_COUNT/);
  assert.match(source, /resetMtfDiagnostics\(\);/);
});

test('processMtfTopDown records pipeline stages in feed→aggregation→queue order', () => {
  const fnSource = extractFunction('processMtfTopDown');
  const dataFeedPos = fnSource.indexOf('markMtfPipelineStage("data_feed"');
  const aggregationPos = fnSource.indexOf('markMtfPipelineStage("candle_aggregation"');
  const queuePos = fnSource.indexOf('markMtfPipelineStage("signal_queue"');
  const confluenceGatePos = fnSource.indexOf('if (minConfluenceEnabled)');
  assert.ok(dataFeedPos >= 0);
  assert.ok(aggregationPos > dataFeedPos);
  assert.ok(queuePos > confluenceGatePos);
});

test('detectMtfTopDown emits a signal when all MTF confirmations pass', () => {
  const fnSource = extractFunction('detectMtfTopDown');
  const harness = `${fnSource}\nmodule.exports = { detectMtfTopDown };`;
  const candles = Array.from({ length: 170 }, (_, i) => ({
    open: 100 + i * 0.01,
    high: 100 + i * 0.01 + 0.2,
    low: 100 + i * 0.01 - 0.2,
    close: 100 + i * 0.01 + 0.05,
    epoch: i * 60
  }));
  candles[candles.length - 2] = { open: 101, high: 101.1, low: 100.7, close: 100.8, epoch: (candles.length - 2) * 60 };
  candles[candles.length - 1] = { open: 100.9, high: 101.6, low: 100.8, close: 101.4, epoch: (candles.length - 1) * 60 };
  const state = { conditions: { ltfHtfAlignment: 'PASS' }, lastRejection: { reason: 'cooldown' } };
  const context = {
    module: { exports: {} },
    mtfTopDownEnabled: true,
    candles,
    atrValue: 0.5,
    lastMtfTopDownIdx: -999,
    mtfTopDownHistory: [],
    monitoringTrade: false,
    trade: null,
    MTF_REQUIRED_BASE_CANDLES: 132,
    MTF_TOP_DOWN_COOLDOWN: 5,
    MTF_BIAS_TF_MULT: 16,
    MTF_BIAS_LOOKBACK: 6,
    MTF_SL_ATR_BUFFER: 0.3,
    getActiveSymbol: () => 'R_100',
    getCurrentGranularitySec: () => 60,
    isSymbolEligibleForNewSignal: () => true,
    markMtfPipelineStage: () => {},
    recordMtfRejection: () => {},
    checkMtfFilterFeasibility: () => ({ pass: true, reasons: [] }),
    detectMtfConfirmation: () => ({ dir: 'BULL', level: 101, retestCandleIdx: candles.length - 2, setup: { breakoutEpoch: 1000 } }),
    getMaxEntryDriftAtr: () => 25,
    getCurrentEntryMode: () => 'close',
    evaluateEntryTimingQuality: () => ({ pass: true, progressAtr: 0.5, bodyAtr: 0.3, closeLocation: 0.8 }),
    shouldPauseAfterRecentLosses: () => ({ block: false }),
    isPinBar: () => false,
    isBullishEngulfing: () => false,
    isBearishEngulfing: () => false,
    getVolatilityAdjustedStopBufferAtr: () => 0.1,
    getStrategyProfitParams: () => ({ rrMTFMin: 2, slBufferMult: 1 }),
    synthesizeTfCandles: () => [{ high: 103, low: 99 }, { high: 104, low: 98 }],
    computeMtfExecutionLevels: () => ({
      valid: true,
      stopLoss: 100.2,
      takeProfit: 103,
      riskReward: 2,
      atr: 0.5,
      tradeManagement: { stopLossMethod: 'atr_structure' }
    }),
    computeMtfBias: () => 'BULL',
    buildNamedTriggerFactor: (factor, detail, group, weight, passed = true, extra = {}) => ({ factor, detail, group, weight, score: passed ? weight : 0, passed, persist: extra.persist !== false }),
    computeConfluenceScore: () => 11,
    getCurrentRegimeTag: () => 'TRENDING',
    getSignalValidityMs: () => 120000,
    getSignalDistanceLimitAtr: () => 2,
    stampSignalLifecycle: (signal) => { signal.signalId = 'sig-1'; return signal; },
    getMtfPipelineState: () => state,
    logSignalEngineDebug: () => {}
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { detectMtfTopDown } = context.module.exports;
  const signal = detectMtfTopDown({ dir: 'BULL', level: 101, retestCandleIdx: candles.length - 2, setup: { breakoutEpoch: 1000 } });
  assert.equal(signal.type, 'mtf_top_down');
  assert.equal(signal.signalId, 'sig-1');
  assert.equal(signal.dir, 'BULL');
  assert.equal(state.conditions.ltfHtfAlignment, 'PASS');
  assert.equal(state.conditions.signalGenerated, 'PASS');
  assert.equal(state.lastRejection, null);
});

test('MTF diagnostics timeframe map follows setup/bias synthesis ratios', () => {
  const harness = [
    extractFunction('formatMtfTfLabel'),
    extractFunction('getMtfTfMap'),
    'module.exports = { getMtfTfMap };'
  ].join('\n');
  const context = {
    module: { exports: {} },
    MTF_SETUP_TF_MULT: 4,
    MTF_BIAS_TF_MULT: 16,
    Number,
    Math,
    Set,
    Array
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { getMtfTfMap } = context.module.exports;
  const tfMap = getMtfTfMap(60);
  assert.deepEqual(Array.from(tfMap, (tf) => tf.ratio), [1, 4, 16]);
  assert.deepEqual(Array.from(tfMap, (tf) => tf.label), ['1m', '4m', '16m']);
});

test('symbol cooldown unlock cleanup and terminal unlock branch stay reachable', () => {
  assert.match(source, /logSignalEngineDebug\("SYMBOL_UNLOCKED", \{ symbol, reason: "cooldown_expired", cooldownUntil \}\);\s*symbolCooldownUntil\.delete\(symbol\);/);
  assert.match(source, /\n  }\n  if \(pending\.symbol && \(result === "WIN" \|\| result === "CANCELLED"\)\) \{\n    logSignalEngineDebug\("SYMBOL_UNLOCKED", \{ symbol: pending\.symbol, reason: result\.toLowerCase\(\), outcome: result \}\);\n  \}/);
});

test('MTF rejection breakdown tracks percentages by reason', () => {
  const harness = [
    extractFunction('getMtfPipelineState'),
    extractFunction('markMtfPipelineStage'),
    extractFunction('recordMtfRejection'),
    extractFunction('getMtfRejectionBreakdown'),
    'module.exports = { getMtfPipelineState, recordMtfRejection, getMtfRejectionBreakdown };'
  ].join('\n');
  const context = {
    module: { exports: {} },
    mtfPipelineStats: new Map(),
    getActiveSymbol: () => 'R_100',
    Date,
    Map,
    Object
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { getMtfPipelineState, recordMtfRejection, getMtfRejectionBreakdown } = context.module.exports;

  const state = getMtfPipelineState('R_100');
  recordMtfRejection('trend_gate', { symbol: 'R_100' });
  recordMtfRejection('trend_gate', { symbol: 'R_100' });
  recordMtfRejection('volume_gate', { symbol: 'R_100' });

  const breakdown = getMtfRejectionBreakdown(state);
  assert.equal(breakdown[0].reason, 'trend_gate');
  assert.equal(breakdown[0].count, 2);
  assert.equal(breakdown[0].percent, 67);
  assert.equal(breakdown[1].reason, 'volume_gate');
  assert.equal(breakdown[1].count, 1);
  assert.equal(breakdown[1].percent, 33);
});

test('signal lifecycle cleanup and logging paths stay wired after resolution', () => {
  assert.match(source, /function cleanupPendingSignalsForSymbol\(symbol, strategyType = null, options = \{\}\)/);
  assert.match(source, /const pending = \(releasedTrade\.signalId[\s\S]*\|\| findPendingTradeSignal\(tradeSymbol\);/);
  assert.match(source, /cleanupPendingSignalsForSymbol\(pending\.symbol \|\| tradeSymbol, "breakout_retest", \{ keepSignalId: pending\.signalId \|\| null \}\);/);
  assert.match(source, /logSignalLifecycleEvent\(pending\.symbol \|\| tradeSymbol, "Trade Closed"/);
  assert.match(source, /logSignalLifecycleEvent\([^)]+, "State Reset Complete"/);
});

test('historical replay exits cleanly and clears stale pending locks', () => {
  assert.match(source, /if \(candles\.length === 0\) \{\s*_historicalProcessing = false;\s*return;\s*\}/);
  assert.match(source, /cleanupPendingSignalsForSymbol\(getActiveSymbol\(\), "breakout_retest"\);/);
});

test('multi-symbol signal notifications include explicit lifecycle markers', () => {
  assert.match(source, /logSignalLifecycleEvent\(signal\.symbol, "Signal Generated"/);
  assert.match(source, /if \(!pending\._openedLogged\) \{/);
  assert.match(source, /logSignalLifecycleEvent\(pending\.symbol \|\| tradeSymbol, "Trade Opened"/);
  assert.match(source, /logSignalLifecycleEvent\(pending\.symbol \|\| symbol, "Signal Sent"/);
});

test('signal lifecycle FSM, active-trade registry, and health monitor remain wired', () => {
  assert.match(source, /const SIGNAL_LIFECYCLE_STATE_LS_KEY = `\$\{LS_PREFIX\}signalLifecycleBySymbol`/);
  assert.match(source, /const ACTIVE_TRADE_REGISTRY_LS_KEY = `\$\{LS_PREFIX\}activeTradeRegistry`/);
  assert.match(source, /function transitionSignalLifecycleState\(symbol, nextState, details = \{\}\)/);
  assert.match(source, /function registerActiveTradeRecord\(symbol, signalId, details = \{\}\)/);
  assert.match(source, /function collectLifecycleHealthReport\(options = \{\}\)/);
  assert.match(source, /startLifecycleHealthMonitor\(\);/);
  assert.match(source, /stopLifecycleHealthMonitor\(\);/);
});

test('collectLifecycleHealthReport preserves panel symbol context for entries without an explicit symbol', () => {
  const fnSource = extractFunction('collectLifecycleHealthReport');
  const harness = `${fnSource}\nmodule.exports = { collectLifecycleHealthReport };`;
  const now = 10_000;
  const context = {
    module: { exports: {} },
    signalHistory: [],
    multiPanels: new Map([
      ['R_50', { symbol: 'R_50', signalHistory: [{ result: 'PENDING', createdAtMs: 1_000 }] }]
    ]),
    activeTradeRegistry: new Map([['R_50|sig-1', { symbol: 'R_50', signalId: 'sig-1' }]]),
    getActiveSymbol: () => 'R_100',
    getSignalValidityMs: () => 1_000,
    getSignalCreatedAtMs: (entry) => entry.createdAtMs,
    Number,
    Math,
    Date,
    Map
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { collectLifecycleHealthReport } = context.module.exports;

  const report = collectLifecycleHealthReport({ now, staleAfterMs: 5_000 });
  assert.deepEqual(JSON.parse(JSON.stringify(report.symbols)), [
    { symbol: 'R_50', pending: 1, stalePending: 1 }
  ]);
  assert.equal(report.totalPending, 1);
  assert.equal(report.totalStalePending, 1);
  assert.equal(report.activeTradeRegistryCount, 1);
});

test('monitorTradeOutcome keeps the released signal id when the pending record is missing', () => {
  const fnSource = extractFunction('monitorTradeOutcome');
  const harness = `${fnSource}\nmodule.exports = { monitorTradeOutcome };`;
  const cleanupCalls = [];
  const lifecycleCalls = [];
  const phaseChanges = [];
  const context = {
    module: { exports: {} },
    monitoringTrade: true,
    trade: { symbol: 'R_50', signalId: 'sig-7', entry: 100, sl: 95, dir: 'BULL' },
    signalHistory: [],
    trailingSL: 10,
    partialTpHit: true,
    phase: 'TRADE',
    candles: [{ close: 100 }],
    getActiveSymbol: () => 'R_100',
    findPendingTradeSignal: () => null,
    cleanupPendingSignalsForSymbol: (...args) => cleanupCalls.push(args),
    logSignalLifecycleEvent: (...args) => lifecycleCalls.push(args),
    logSignalEngineDebug: () => {},
    setPhase: (value) => {
      phaseChanges.push(value);
      context.phase = value;
    }
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { monitorTradeOutcome } = context.module.exports;

  monitorTradeOutcome({ close: 100 });
  assert.deepEqual(JSON.parse(JSON.stringify(cleanupCalls)), [['R_50', 'breakout_retest', { keepSignalId: 'sig-7' }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycleCalls)), [['R_50', 'State Reset Complete', { signalId: 'sig-7', reason: 'missing_pending_signal_record' }]]);
  assert.equal(context.monitoringTrade, false);
  assert.equal(context.trade, null);
  assert.equal(context.trailingSL, null);
  assert.equal(context.partialTpHit, false);
  assert.deepEqual(phaseChanges, ['BREAKOUT']);
});

test('dynamic min confluence applies regime deltas and clamps to 6-16', () => {
  const fnSource = extractFunction('getDynamicMinConfluence');
  const harness = `${fnSource}\nmodule.exports = { getDynamicMinConfluence };`;
  const run = (min, regime, deltas = {}) => {
    const context = {
      module: { exports: {} },
      minConfluenceValue: min,
      dynamicConfTrendingDelta: deltas.trending ?? -1,
      dynamicConfTransitioningDelta: deltas.transitioning ?? 0,
      dynamicConfRangingDelta: deltas.ranging ?? 2,
      getCurrentRegimeTag: () => regime,
      getOptimizationProfile: () => null
    };
    vm.createContext(context);
    vm.runInContext(harness, context);
    return context.module.exports.getDynamicMinConfluence('R_100', 60, regime);
  };
  assert.equal(run(10, 'TRENDING'), 9);
  assert.equal(run(10, 'TRANSITIONING'), 10);
  assert.equal(run(10, 'RANGING'), 12);
  assert.equal(run(6, 'TRENDING'), 6);
  assert.equal(run(6, 'TRENDING', { trending: -8 }), 6);
  assert.equal(run(15, 'RANGING'), 16);
  assert.equal(run(16, 'RANGING', { ranging: 8 }), 16);
  assert.equal(run(8, 'TRANSITIONING', { transitioning: 3 }), 11);
});
