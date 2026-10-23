const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

function extractFunction(name) {
  const startToken = `function ${name}(`;
  const start = source.indexOf(startToken);
  if (start === -1) throw new Error(`Missing function ${name}`);
  let i = source.indexOf('(', start);
  let parenDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    if (ch === ')') { parenDepth--; if (parenDepth === 0) { i = source.indexOf('{', i); break; } }
  }
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`Unclosed function ${name}`);
}

function buildHarness() {
  const fnSource = extractFunction('applyRecoveryAdviceToCandleInterp');
  return `
    let candleInterpSlBufferAdj = 1.0;
    const CANDLE_INTERP_SL_BUFFER_ADJ_MAX = 1.6;
    const CANDLE_INTERP_SL_BUFFER_ADJ_STEP = 0.2;
    const CANDLE_INTERP_RECOVERY_MIN_LOSSES = 3;
    const CANDLE_INTERP_RECOVERY_WINDOW = 10;
    ${fnSource}
    module.exports = { applyRecoveryAdviceToCandleInterp, get adj() { return candleInterpSlBufferAdj; } };
  `;
}

function makeContext(trailingStats, threshold, logs) {
  const context = {
    module: { exports: {} },
    window: {
      postSLRecoveryAnalyzer: {
        threshold,
        getTrailingStats: () => trailingStats
      }
    },
    addLog: (msg) => logs.push(msg),
    Number
  };
  vm.createContext(context);
  vm.runInContext(buildHarness(), context);
  return context;
}

test('widens SL buffer once scenario-A recovery % exceeds threshold with enough samples', () => {
  const logs = [];
  const context = makeContext(
    [{ strategy: 'candle_interp', total_losses: 5, scenario_a_pct: 80 }],
    60,
    logs
  );
  context.module.exports.applyRecoveryAdviceToCandleInterp();
  assert.equal(context.module.exports.adj, 1.2);
  assert.ok(logs.some(l => l.includes('widening SL buffer')));
});

test('does not widen with too few sampled losses', () => {
  const logs = [];
  const context = makeContext(
    [{ strategy: 'candle_interp', total_losses: 2, scenario_a_pct: 95 }],
    60,
    logs
  );
  context.module.exports.applyRecoveryAdviceToCandleInterp();
  assert.equal(context.module.exports.adj, 1.0);
  assert.equal(logs.length, 0);
});

test('does not widen when scenario-A percentage is below threshold', () => {
  const logs = [];
  const context = makeContext(
    [{ strategy: 'candle_interp', total_losses: 8, scenario_a_pct: 40 }],
    60,
    logs
  );
  context.module.exports.applyRecoveryAdviceToCandleInterp();
  assert.equal(context.module.exports.adj, 1.0);
});

test('caps widening at CANDLE_INTERP_SL_BUFFER_ADJ_MAX across repeated triggers', () => {
  const logs = [];
  const trailingStats = [{ strategy: 'candle_interp', total_losses: 6, scenario_a_pct: 90 }];
  const context = makeContext(trailingStats, 60, logs);
  for (let i = 0; i < 10; i++) context.module.exports.applyRecoveryAdviceToCandleInterp();
  assert.equal(context.module.exports.adj, 1.6);
});

test('ignores stats for other strategies', () => {
  const logs = [];
  const context = makeContext(
    [{ strategy: 'grid_scalper_ma', total_losses: 10, scenario_a_pct: 90 }],
    60,
    logs
  );
  context.module.exports.applyRecoveryAdviceToCandleInterp();
  assert.equal(context.module.exports.adj, 1.0);
});
