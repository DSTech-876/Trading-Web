/**
 * Regression tests for resolveBreakoutRetestStopAnchor() in indicator/indicator.js.
 *
 * Breakout-retest trades were being stopped out by the deeper retest wick and
 * only afterwards running to TP, because the stop was anchored to the retest
 * zone extreme — which can sit on the *inside* of the broken breakout level.
 * The anchor is now always pushed to (at least) the broken level, which is the
 * real invalidation point of the setup.
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

const STRUCTURAL_SL_MIN_RISK_ATR = Number(
  /const STRUCTURAL_SL_MIN_RISK_ATR = ([\d.]+)/.exec(source)[1]
);

const context = { STRUCTURAL_SL_MIN_RISK_ATR, module: { exports: {} } };
vm.createContext(context);
vm.runInContext(
  `${extractFunction('resolveBreakoutRetestStopAnchor')}\nmodule.exports = { resolveBreakoutRetestStopAnchor };`,
  context
);
const { resolveBreakoutRetestStopAnchor } = context.module.exports;

test('BULL: stop anchor is pushed below the broken level when the zone low sits above it', () => {
  const r = resolveBreakoutRetestStopAnchor({
    dir: 'BULL', entry: 105, zoneExtreme: 102, swingAnchor: 95,
    breakoutLevel: 100, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(r.anchor, 100);
  assert.equal(r.anchorSource, 'breakout_level');
  assert.equal(r.levelExtended, true);
});

test('BEAR: stop anchor is pushed above the broken level when the zone high sits below it', () => {
  const r = resolveBreakoutRetestStopAnchor({
    dir: 'BEAR', entry: 95, zoneExtreme: 98, swingAnchor: 105,
    breakoutLevel: 100, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(r.anchor, 100);
  assert.equal(r.anchorSource, 'breakout_level');
  assert.equal(r.levelExtended, true);
});

test('a zone extreme already beyond the broken level is kept as-is', () => {
  const bull = resolveBreakoutRetestStopAnchor({
    dir: 'BULL', entry: 110, zoneExtreme: 99, swingAnchor: 90,
    breakoutLevel: 100, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(bull.anchor, 99);
  assert.equal(bull.anchorSource, 'zone');
  assert.equal(bull.levelExtended, false);

  const bear = resolveBreakoutRetestStopAnchor({
    dir: 'BEAR', entry: 90, zoneExtreme: 101, swingAnchor: 110,
    breakoutLevel: 100, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(bear.anchor, 101);
  assert.equal(bear.levelExtended, false);
});

test('an unrealistically tight zone stop still falls back to the swing anchor', () => {
  const r = resolveBreakoutRetestStopAnchor({
    dir: 'BULL', entry: 100.1, zoneExtreme: 100.05, swingAnchor: 97,
    breakoutLevel: 100, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(r.zoneTooTight, true);
  assert.equal(r.anchor, 97);
  assert.equal(r.anchorSource, 'swing');
});

test('swing anchor is used when no retest zone candles are available', () => {
  const r = resolveBreakoutRetestStopAnchor({
    dir: 'BULL', entry: 105, zoneExtreme: null, swingAnchor: 98,
    breakoutLevel: null, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(r.anchor, 98);
  assert.equal(r.anchorSource, 'swing');
});

test('no usable anchor returns null instead of NaN levels', () => {
  const r = resolveBreakoutRetestStopAnchor({
    dir: 'BEAR', entry: 105, zoneExtreme: null, swingAnchor: null,
    breakoutLevel: null, atrRef: 2, bufferAtr: 0.3
  });
  assert.equal(r.anchor, null);
  assert.equal(r.anchorSource, 'none');
});

test('resulting stop sits beyond the broken level by the full ATR buffer', () => {
  const atrRef = 2;
  const bufferAtr = 0.3;
  const bull = resolveBreakoutRetestStopAnchor({
    dir: 'BULL', entry: 105, zoneExtreme: 103, swingAnchor: 94,
    breakoutLevel: 100, atrRef, bufferAtr
  });
  assert.equal(bull.anchor - atrRef * bufferAtr, 99.4);
  const bear = resolveBreakoutRetestStopAnchor({
    dir: 'BEAR', entry: 95, zoneExtreme: 97, swingAnchor: 106,
    breakoutLevel: 100, atrRef, bufferAtr
  });
  assert.equal(bear.anchor + atrRef * bufferAtr, 100.6);
});
