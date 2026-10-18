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

/* Base stub set covering every helper `processCandle` can call once a breakout
   is already active. Individual tests override the handful that matter for
   the scenario under test. */
function baseContext(overrides) {
  const logs = [];
  const base = {
    FALSE_BREAKOUT_CANDLES: 3,
    openingRange: { high: 110, low: 90 },
    retestCount: 0,
    retestInfo: null,
    indecisionInfo: null,
    confirmInfo: null,
    trade: null,
    phase: 'RETEST',
    confluenceScore: 0,
    multiRHitLevels: [],
    falseBreakoutEnabled: true,
    followThroughEnabled: true,
    rsiFilterEnabled: false,
    divergenceFilterEnabled: false,
    divergenceVisualEnabled: false,
    minConfluenceValue: 0,
    logs,
    addLog: (m) => logs.push(m),
    logSignalEngineDebug: () => {},
    logSignalLifecycleEvent: () => {},
    logMarketTypeContext: () => {},
    logMarketTypeSignals: () => {},
    logBreakoutRetestTiming: () => {},
    maybeSendBreakoutCancelled: () => {},
    noteBreakoutRetestDelay: () => {},
    noteEarliestValidSignalCandle: () => {},
    setPhase: (p) => { base.phase = p; },
    getMarketTuning: () => ({ preferredDir: null }),
    getActiveSymbol: () => 'R_75',
    getActiveSessionName: () => 'London',
    getRecommendedOrderType: () => '',
    getCurrentRSI: () => null,
    getCurrentEntryMode: () => 'confirmed_close',
    getFibRetestLevel: () => null,
    fmt: (x) => x,
    isRangeSizeOK: () => true,
    isADXInRange: () => true,
    isRepeatBreakoutSetup: () => false,
    isEmaAligned: () => true,
    isHTFAligned: () => true,
    isMTFStructureAligned: () => true,
    hasHHHLStructure: () => true,
    isWithinActiveSession: () => true,
    hasBreakoutConviction: () => true,
    hasVolumeSpikeOnBreakout: () => true,
    isTimeDecayOK: () => true,
    isBreakoutDistanceOK: () => true,
    isDoubleRetestSatisfied: () => true,
    isRSIFavorable: () => true,
    hasMomentumDivergence: () => true,
    hasSRConfluence: () => false,
    buildDivergenceMarkers: () => {},
    isBullishEngulfing: () => false,
    isBearishEngulfing: () => false,
    isRetestRejection: () => false,
    isIndecision: () => false,
    isPinBar: () => false,
    isInsideBar: () => false,
    hasConsecutiveDirection: () => true,
    isVWAPAligned: () => true,
    hasStochCrossover: () => true,
    isConfirmBarValid: () => true,
    isConfluenceSufficient: () => true,
    computeConfluenceScore: () => 10,
    recordConfirmedSignal: () => {},
    recordSignal: () => {},
    buildTrade: () => { base.trade = null; },
    generateSignalId: () => 'sig-1'
  };
  return Object.assign(base, overrides);
}

function touchesLevel(candle, level) {
  return candle.low <= level && candle.high >= level;
}

test('a retest touch on the still-forming follow-through candle defers retestInfo until the candle closes', () => {
  const context = baseContext({
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100 },
    candles: [
      { epoch: 0,  open: 95,  close: 101, high: 102, low: 94 },   /* 0: breakout candle */
      { epoch: 60, open: 100.4, close: 100.6, high: 101, low: 99 } /* 1: forming, touches level 100 intrabar */
    ],
    touchesLevel,
    getCurrentEntryMode: () => 'aggressive_intrabar'
  });
  const { processCandle, isFalseBreakout, hasFollowThrough, findHistoricalRetest } =
    run(['processCandle', 'isFalseBreakout', 'hasFollowThrough', 'findHistoricalRetest'], context);
  context.isFalseBreakout = isFalseBreakout;
  context.hasFollowThrough = hasFollowThrough;
  context.findHistoricalRetest = findHistoricalRetest;

  processCandle(1);

  /* retestInfo must NOT be set yet — the follow-through verdict for candle #1
     (breakout.candleIdx + 1) is still pending because it hasn't closed. */
  assert.equal(context.retestInfo, null);
  assert.equal(context.phase, 'RETEST');
  assert.ok(context.logs.some(l => /waiting for candle close/.test(l)));
});

test('a reversed follow-through candle still invalidates the breakout after a deferred intrabar touch', () => {
  const context = baseContext({
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100 },
    candles: [
      { epoch: 0,  open: 95,  close: 101, high: 102, low: 94 },
      { epoch: 60, open: 100.4, close: 100.6, high: 101, low: 99 }
    ],
    touchesLevel,
    getCurrentEntryMode: () => 'aggressive_intrabar'
  });
  const { processCandle, isFalseBreakout, hasFollowThrough, findHistoricalRetest } =
    run(['processCandle', 'isFalseBreakout', 'hasFollowThrough', 'findHistoricalRetest'], context);
  context.isFalseBreakout = isFalseBreakout;
  context.hasFollowThrough = hasFollowThrough;
  context.findHistoricalRetest = findHistoricalRetest;

  /* Tick 1: intrabar touch on the forming follow-through candle — deferred. */
  processCandle(1);
  assert.equal(context.retestInfo, null);

  /* The candle now closes reversed (close < open for a BULL breakout), which
     should invalidate the breakout on the next, non-intrabar pass. Before the
     fix, the earlier intrabar touch would already have set retestInfo and this
     invalidation branch would never run again. */
  context.candles[1] = { epoch: 60, open: 100.6, close: 100.3, high: 101, low: 99 };
  context.getCurrentEntryMode = () => 'confirmed_close';

  processCandle(1);

  assert.equal(context.breakout, null);
  assert.equal(context.phase, 'BREAKOUT');
  assert.equal(context.retestInfo, null);
  assert.ok(context.logs.some(l => /no follow-through/.test(l)));
});

test('fast-track CONFIRMED signal is recorded once per setup/candle even when buildTrade rejects entry on every retry tick', () => {
  let buildTradeCalls = 0;
  let recordConfirmedCalls = 0;
  const context = baseContext({
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100, strong: true },
    retestInfo: { candleIdx: 1 },
    candles: [
      { epoch: 0,  open: 95,  close: 101, high: 102, low: 94 },
      { epoch: 60, open: 100.4, close: 100.6, high: 101, low: 99 }
    ],
    phase: 'INDECISION',
    isBullishEngulfing: () => true,
    buildTrade: () => { buildTradeCalls++; context.trade = null; },
    recordConfirmedSignal: () => { recordConfirmedCalls++; }
  });
  const { processCandle } = run(['processCandle'], context);

  /* Simulate three retry ticks for the same candle, all rejected by buildTrade
     (e.g. news pause / timing-quality validation failing). */
  processCandle(1);
  processCandle(1);
  processCandle(1);

  assert.equal(buildTradeCalls, 3);
  assert.equal(recordConfirmedCalls, 1);
});

test('with only follow-through enabled, a retest touch on the forming follow-through candle defers', () => {
  const context = baseContext({
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100 },
    candles: [
      { epoch: 0,  open: 95,  close: 101, high: 102, low: 94 },   /* 0: breakout candle */
      { epoch: 60, open: 100.4, close: 100.6, high: 101, low: 99 } /* 1: forming, touches level 100 intrabar */
    ],
    touchesLevel,
    falseBreakoutEnabled: false,
    followThroughEnabled: true,
    getCurrentEntryMode: () => 'aggressive_intrabar'
  });
  const { processCandle, isFalseBreakout, hasFollowThrough, findHistoricalRetest } =
    run(['processCandle', 'isFalseBreakout', 'hasFollowThrough', 'findHistoricalRetest'], context);
  context.isFalseBreakout = isFalseBreakout;
  context.hasFollowThrough = hasFollowThrough;
  context.findHistoricalRetest = findHistoricalRetest;

  processCandle(1);

  /* retestInfo must NOT be set yet — waiting for the follow-through candle close */
  assert.equal(context.retestInfo, null);
  assert.equal(context.phase, 'RETEST');
  assert.ok(context.logs.some(l => /waiting for candle close/.test(l)));
});

test('with both false-breakout and follow-through disabled, a retest touch on the forming candle does not defer', () => {
  const context = baseContext({
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100 },
    candles: [
      { epoch: 0,  open: 95,  close: 101, high: 102, low: 94 },   /* 0: breakout candle */
      { epoch: 60, open: 100.4, close: 100.6, high: 101, low: 99 } /* 1: forming, touches level 100 intrabar */
    ],
    touchesLevel,
    falseBreakoutEnabled: false,
    followThroughEnabled: false,
    isDoubleRetestSatisfied: () => false,
    getCurrentEntryMode: () => 'aggressive_intrabar'
  });
  const { processCandle, isFalseBreakout, hasFollowThrough, findHistoricalRetest } =
    run(['processCandle', 'isFalseBreakout', 'hasFollowThrough', 'findHistoricalRetest'], context);
  context.isFalseBreakout = isFalseBreakout;
  context.hasFollowThrough = hasFollowThrough;
  context.findHistoricalRetest = findHistoricalRetest;

  processCandle(1);

  /* retestInfo should NOT be set yet — waiting for double retest since both features are disabled
     (no deferral guard applies, but double retest requirement blocks confirmation) */
  assert.equal(context.retestInfo, null);
  assert.equal(context.phase, 'RETEST');
  assert.ok(context.logs.some(l => /waiting for double retest/.test(l)));
});

test('regular confirmation path CONFIRMED signal is recorded once per setup/candle even when buildTrade rejects entry on every retry tick', () => {
  let buildTradeCalls = 0;
  let recordConfirmedCalls = 0;
  const context = baseContext({
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100, strong: true },
    retestInfo: { candleIdx: 1 },
    indecisionInfo: { candleIdx: 1 },
    candles: [
      { epoch: 0,  open: 95,  close: 101, high: 102, low: 94 },
      { epoch: 60, open: 100.4, close: 100.6, high: 101, low: 99 },
      { epoch: 120, open: 100.6, close: 100.8, high: 101, low: 100.5 }
    ],
    phase: 'CONFIRM',
    isDragonflyDoji: () => true,
    isBullishEngulfing: () => false,
    isMorningStar: () => false,
    isEveningStar: () => false,
    isPiercingLine: () => false,
    isDarkCloudCover: () => false,
    isTweezers: () => null,
    isRailwayTrack: () => null,
    detectMomentumImpulse: () => null,
    detectSupplyDemandZone: () => null,
    detectTrendlineTouch: () => null,
    detectMABounce: () => null,
    getStepRunLength: () => 0,
    detectDriftSwitchRegime: () => null,
    getDailyResetPreferredDir: () => null,
    detectSpikeRejection: () => null,
    detectInsideBarFalseBreakout: () => null,
    getMarketType: () => 'default',
    buildTrade: () => { buildTradeCalls++; context.trade = null; },
    recordConfirmedSignal: () => { recordConfirmedCalls++; }
  });
  const { processCandle } = run(['processCandle'], context);

  /* Simulate three retry ticks for the same candle, all rejected by buildTrade.
     This tests the regular confirmation path (dragonfly doji), not the fast-track engulfing path. */
  processCandle(2);
  processCandle(2);
  processCandle(2);

  assert.equal(buildTradeCalls, 3);
  assert.equal(recordConfirmedCalls, 1);
});
