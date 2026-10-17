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
