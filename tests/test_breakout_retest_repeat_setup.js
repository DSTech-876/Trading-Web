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

function makeCandles(specs) {
  return specs.map(([epoch, high, low]) => ({ epoch, high, low, open: low, close: high }));
}

test('buildOpeningRange only uses candles from rangeStartEpoch onwards', () => {
  const context = {
    candles: makeCandles([
      [0,   200, 100],   /* old candles — must NOT influence the new range */
      [60,  190, 110],
      [120, 150, 140],   /* new range starts here */
      [180, 152, 141]
    ]),
    rangeStartEpoch: 120,
    scalpingModeEnabled: false,
    RANGE_MINUTES: 5,
    SCALP_RANGE_MINUTES: 1,
    openingRange: null,
    breakout: null,
    phase: 'RANGE',
    setPhase(p) { context.phase = p; }
  };
  const { buildOpeningRange } = run(['buildOpeningRange'], context);
  buildOpeningRange();
  assert.deepEqual(
    { high: context.openingRange.high, low: context.openingRange.low,
      startIdx: context.openingRange.startIdx, endIdx: context.openingRange.endIdx },
    { high: 152, low: 140, startIdx: 2, endIdx: 3 }
  );
});

test('buildOpeningRange ignores ranges whose window has no candles yet', () => {
  const context = {
    candles: makeCandles([[0, 200, 100], [60, 190, 110]]),
    rangeStartEpoch: 600,
    scalpingModeEnabled: false,
    RANGE_MINUTES: 5,
    SCALP_RANGE_MINUTES: 1,
    openingRange: null,
    breakout: null,
    phase: 'RANGE',
    setPhase(p) { context.phase = p; }
  };
  const { buildOpeningRange } = run(['buildOpeningRange'], context);
  buildOpeningRange();
  assert.equal(context.openingRange, null);
});

function repeatGuardContext() {
  const context = {
    candles: new Array(50).fill(null).map((_, i) => ({ epoch: i * 60, high: 1, low: 1, close: 1 })),
    PRICE_EPSILON: 1e-6,
    getActiveSymbol: () => 'R_75',
    getAtrReference: () => 1,
    REPEAT_SETUP_BLOCK_CANDLES: 30,
    REPEAT_SETUP_LEVEL_ATR: 0.5,
    resolvedBreakoutSetups: new Map()
  };
  const api = run(['rememberResolvedBreakoutSetup', 'isRepeatBreakoutSetup'], context);
  return { context, api };
}

test('an identical breakout level right after a close is treated as a repeat setup', () => {
  const { api } = repeatGuardContext();
  api.rememberResolvedBreakoutSetup('R_75', 'BULL', 100, 40);
  assert.equal(api.isRepeatBreakoutSetup('R_75', 'BULL', 100, 41, 1), true);
  assert.equal(api.isRepeatBreakoutSetup('R_75', 'BULL', 100.2, 42, 1), true);
});

test('repeat guard releases once price level moves far enough away', () => {
  const { api, context } = repeatGuardContext();
  api.rememberResolvedBreakoutSetup('R_75', 'BULL', 100, 40);
  assert.equal(api.isRepeatBreakoutSetup('R_75', 'BULL', 101, 41, 1), false);
  assert.equal(context.resolvedBreakoutSetups.has('R_75'), false);
});

test('repeat guard expires after the block window and never blocks other dirs/symbols', () => {
  const { api } = repeatGuardContext();
  api.rememberResolvedBreakoutSetup('R_75', 'BULL', 100, 10);
  assert.equal(api.isRepeatBreakoutSetup('R_75', 'BEAR', 100, 11, 1), false);
  assert.equal(api.isRepeatBreakoutSetup('R_100', 'BULL', 100, 11, 1), false);
  api.rememberResolvedBreakoutSetup('R_75', 'BULL', 100, 10);
  assert.equal(api.isRepeatBreakoutSetup('R_75', 'BULL', 100, 40, 1), false);
});

test('resetIndicator only drops the active symbol repeat-setup guard, leaving other panels intact', () => {
  const context = {
    module: { exports: {} },
    Map,
    getActiveSymbol: () => 'R_75',
    initStrategyStateRegistry: () => {},
    resetStrategyStateContracts: () => {},
    updateStateUI: () => {},
    candles: [], rangeStartEpoch: 0,
    _lastRepeatSetupLogKey: 'x',
    emaFast: [], emaSlow: [], emaHTF: [],
    atrValue: 1, atrValues: [1], _atrPrev: 1, _atrCandleCount: 1,
    rsiValues: [1], macdLine: [1], macdSignal: [1], macdHistogram: [1],
    bbUpper: [1], bbLower: [1], bbMiddle: [1], bbWidth: [1], _bbValidWidths: [1],
    adxValue: 1, adxDiPlus: 1, adxDiMinus: 1,
    stochK: [1], stochD: [1],
    emaMTF: [1], vwapValues: [1],
    resolvedBreakoutSetups: new Map([
      ['R_75', { dir: 'BULL', level: 100, closedAtIdx: 10 }],
      ['R_100', { dir: 'BULL', level: 50, closedAtIdx: 10 }]
    ])
  };
  const harness = `${extractFunction('resetIndicator')}\nmodule.exports = { resetIndicator };`;
  vm.createContext(context);
  vm.runInContext(harness, context);
  context.module.exports.resetIndicator();
  assert.equal(context.resolvedBreakoutSetups.has('R_75'), false);
  assert.equal(context.resolvedBreakoutSetups.has('R_100'), true);
});

test('remapPendingSignalIndices remaps the repeat-setup guard by epoch against the replacement buffer', () => {
  const context = {
    module: { exports: {} },
    Map,
    addLog: () => {},
    fmt: (v) => v,
    getActiveSymbol: () => 'R_75',
    /* Replacement history after reconnect: same epochs, but now at different
       array positions than when the guard was recorded. */
    candles: [
      { epoch: 1000 }, { epoch: 1060 }, { epoch: 1120 }, { epoch: 1180 }, { epoch: 1240 }
    ],
    liquiditySweepHistory: [], stopLossHuntHistory: [], failedPinBarHistory: [],
    fibScalpHistory: [], po3History: [], gridScalperMAHistory: [], gridScalperV2History: [],
    liveScalpHistory: [], nyOpenRangeHistory: [], sessionRangeHistory: [], mtfTopDownHistory: [],
    tiktokHistory: [], orderblockHistory: [], fvgStratHistory: [], candleInterpHistory: [],
    po3_4hHistory: [], breakerBlockHistory: [], oteGoldenPocketHistory: [],
    signalHistory: [],
    trade: null, monitoringTrade: false,
    _reconnectSavedNyTrade: null, _reconnectSavedSessionTrade: null,
    nyOpenRangeTrade: null, sessionRangeTrade: null,
    lastScalpCandleIdx: -999, lastLiquiditySweepIdx: -999, lastStopLossHuntIdx: -999,
    lastFailedPinBarIdx: -999, lastFibScalpIdx: -999, lastPo3Idx: -999,
    lastGridScalperMAIdx: -999, lastGridScalperV2Idx: -999, lastFvgStratIdx: -999,
    lastMtfTopDownIdx: -999, lastCandleInterpIdx: -999, lastOrderblockIdx: -999,
    lastTiktokIdx: -999, lastPo3_4hIdx: -999, lastBreakerBlockIdx: -999,
    lastOteGoldenPocketIdx: -999,
    resolvedBreakoutSetups: new Map([
      ['R_75', { dir: 'BULL', level: 100, closedAtIdx: 1, closedAtEpoch: 1120 }]
    ])
  };
  const harness = `${extractFunction('remapPendingSignalIndices')}\nmodule.exports = { remapPendingSignalIndices };`;
  vm.createContext(context);
  vm.runInContext(harness, context);
  context.module.exports.remapPendingSignalIndices();
  /* Epoch 1120 is now at index 2 in the replacement buffer — the stale
     index 1 must be corrected, not left pointing at the wrong candle. */
  assert.equal(context.resolvedBreakoutSetups.get('R_75').closedAtIdx, 2);
});
