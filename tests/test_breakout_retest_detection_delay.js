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

const BAR_SEC = 60;

/* Breakout at bar 0 (level 100). The retest touch AND its rejection candle both
   print at bar 2, but the live loop only ever evaluates the newest candle, so the
   retest is first adopted (as a historical retest) at bar 4. */
function scenarioContext() {
  const logs = [];
  const base = {
    MAX_PHASE_ADVANCES_PER_CANDLE: 5,
    FALSE_BREAKOUT_CANDLES: 3,
    _retestCatchUpFromIdx: null,
    _retestCatchUpActive: false,
    _historicalProcessing: false,
    openingRange: { high: 100, low: 90, endIdx: 0 },
    breakout: { dir: 'BULL', candleIdx: 0, level: 100, lockedLevel: 100 },
    retestCount: 0,
    retestInfo: null,
    indecisionInfo: null,
    confirmInfo: null,
    trade: null,
    phase: 'RETEST',
    monitoringTrade: false,
    autoResetEnabled: false,
    nyOpenRangeEnabled: false,
    sessionRangesEnabled: false,
    confluenceScore: 0,
    multiRHitLevels: [],
    falseBreakoutEnabled: false,
    followThroughEnabled: false,
    rsiFilterEnabled: false,
    divergenceFilterEnabled: false,
    divergenceVisualEnabled: false,
    minConfluenceValue: 0,
    candles: [
      { epoch: 0 * BAR_SEC, open: 95,    close: 101,   high: 102,   low: 94 },    /* 0 breakout */
      { epoch: 1 * BAR_SEC, open: 101,   close: 101.5, high: 102,   low: 100.8 }, /* 1 */
      { epoch: 2 * BAR_SEC, open: 100.5, close: 101.2, high: 101.4, low: 99.6 },  /* 2 retest + rejection */
      { epoch: 3 * BAR_SEC, open: 101.2, close: 101.6, high: 101.9, low: 101.0 }, /* 3 */
      { epoch: 4 * BAR_SEC, open: 101.6, close: 101.8, high: 102.1, low: 101.4 }  /* 4 live, no pattern */
    ],
    logs,
    addLog: (m) => logs.push(m),
    logSignalEngineDebug: () => {},
    logSignalLifecycleEvent: () => {},
    logMarketTypeContext: () => {},
    logMarketTypeSignals: () => {},
    maybeSendBreakoutCancelled: () => {},
    noteBreakoutRetestDelay: () => {},
    setPhase: (p) => { base.phase = p; },
    updateStateUI: () => {},
    enforceTradeLifecycleIntegrity: () => {},
    cleanupPendingSignalsForSymbol: () => {},
    buildOpeningRange: () => {},
    resetForNextSetup: () => {},
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
    touchesLevel: (candle, level) => candle.low <= level && candle.high >= level,
    isBullishEngulfing: () => false,
    isBearishEngulfing: () => false,
    /* Only bar 2 is a valid retest rejection */
    isRetestRejection: (c) => c.epoch === 2 * BAR_SEC,
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
    buildTrade: (c, idx) => { base.trade = { entryIdx: idx, entry: c.close }; },
    generateSignalId: () => 'sig-1'
  };
  return base;
}

const FNS = [
  'processLatestCandle', 'replaySkippedRetestCandles', 'replaySkippedRetestCandlesInner',
  'processCandle', 'findHistoricalRetest', 'isFalseBreakout', 'hasFollowThrough',
  'noteEarliestValidSignalCandle', 'logBreakoutRetestTiming', 'fmtBarTime', 'getBarEpoch'
];

test('a retest adopted from an earlier candle replays the skipped candles so the entry fires at the earliest valid bar', () => {
  const context = scenarioContext();
  const api = run(FNS, context);
  Object.assign(context, api);

  context.processLatestCandle();

  assert.equal(context.retestInfo.candleIdx, 2);
  assert.ok(context.trade, 'a trade must be built from the skipped rejection candle');
  assert.equal(context.trade.entryIdx, 2, 'entry must be taken at the earliest valid candle, not the live candle');
  assert.equal(context.phase, 'TRADE');
  /* Detection delay collapses from 2 candles (bar 2 → bar 4) to 0. */
  assert.equal(context.trade.entryIdx - context.retestInfo.candleIdx, 0);
  assert.equal(context._retestCatchUpFromIdx, null, 'catch-up flag must be cleared after the replay');
});

test('timing log reports time, bar index and delay in seconds and candles', () => {
  const context = scenarioContext();
  const api = run(FNS, context);
  Object.assign(context, api);

  context.processLatestCandle();
  context.logBreakoutRetestTiming(4, 'fast-track bullish retest rejection');

  const joined = context.logs.join('\n');
  assert.match(joined, /Breakout detected: \d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2} \| Bar 0/);
  assert.match(joined, /Retest detected: \d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2} \| Bar 2/);
  assert.match(joined, /Setup became valid: \d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2} \| Bar 2/);
  assert.match(joined, /Signal generated: \d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2} \| Bar 4/);
  assert.match(joined, /Detection delay: 120 second\(s\), 2 candle\(s\)/);
});

test('fmtBarTime formats epochs as MT5-style UTC timestamps', () => {
  const context = scenarioContext();
  const { fmtBarTime } = run(['fmtBarTime'], context);
  assert.equal(fmtBarTime(Date.UTC(2026, 9, 18, 10, 32, 0) / 1000), '2026.10.18 10:32:00');
  assert.equal(fmtBarTime(null), 'n/a');
});
