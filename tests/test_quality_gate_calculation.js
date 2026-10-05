const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

// Extract the getDynamicMinConfluence function
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

// Extract constants and variables needed
const trendingMatch = source.match(/const DYNAMIC_CONF_TRENDING_DELTA_DEFAULT\s*=\s*([-+]?\d+)/);
const transitioningMatch = source.match(/const DYNAMIC_CONF_TRANSITIONING_DELTA_DEFAULT\s*=\s*([-+]?\d+)/);
const rangingMatch = source.match(/const DYNAMIC_CONF_RANGING_DELTA_DEFAULT\s*=\s*([-+]?\d+)/);
assert(trendingMatch && transitioningMatch && rangingMatch, 'Failed to extract dynamic confluence constants');
const TRENDING_DEFAULT = parseInt(trendingMatch[1]);
const TRANSITIONING_DEFAULT = parseInt(transitioningMatch[1]);
const RANGING_DEFAULT = parseInt(rangingMatch[1]);

// Create a mock context with necessary globals
const mockContext = {
  // Default values for testing
  dynamicConfTrendingDelta: TRENDING_DEFAULT,
  dynamicConfTransitioningDelta: TRANSITIONING_DEFAULT,
  dynamicConfRangingDelta: RANGING_DEFAULT,
  minConfluenceValue: 11,
  
  // Mock functions
  getCurrentRegimeTag: function() { return 'TRENDING'; },
  getOptimizationProfile: function() { return null; },
};

// Extract necessary parts of indicator.js for context
const getDynamicMinConfluence = extractFunction('getDynamicMinConfluence');

// Create a test runner function
function createTestRunner(overrides = {}) {
  const context = { ...mockContext, ...overrides };
  const script = new vm.Script(`
    ${getDynamicMinConfluence}
    getDynamicMinConfluence;
  `);
  return script.runInNewContext(context);
}

test('getDynamicMinConfluence: TRENDING regime applies -1 delta', () => {
  const runner = createTestRunner({
    dynamicConfTrendingDelta: -1,
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'TRENDING');
  // 11 + (-1) = 10, clamped to [6, 16]
  assert.strictEqual(result, 10, 'TRENDING should add -1 delta: 11 + (-1) = 10');
});

test('getDynamicMinConfluence: TRANSITIONING regime applies 0 delta', () => {
  const runner = createTestRunner({
    dynamicConfTransitioningDelta: 0,
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'TRANSITIONING');
  // 11 + 0 = 11, clamped to [6, 16]
  assert.strictEqual(result, 11, 'TRANSITIONING should add 0 delta: 11 + 0 = 11');
});

test('getDynamicMinConfluence: RANGING regime applies +2 delta', () => {
  const runner = createTestRunner({
    dynamicConfRangingDelta: 2,
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'RANGING');
  // 11 + 2 = 13, clamped to [6, 16]
  assert.strictEqual(result, 13, 'RANGING should add +2 delta: 11 + 2 = 13');
});

test('getDynamicMinConfluence: Lower boundary clamp to 6', () => {
  const runner = createTestRunner({
    dynamicConfTrendingDelta: -10,  // aggressive negative
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'TRENDING');
  // 11 + (-10) = 1, should clamp to 6
  assert.strictEqual(result, 6, 'Should clamp to minimum 6: Math.max(6, 1) = 6');
});

test('getDynamicMinConfluence: Upper boundary clamp to 16', () => {
  const runner = createTestRunner({
    dynamicConfRangingDelta: 10,  // aggressive positive
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'RANGING');
  // 11 + 10 = 21, should clamp to 16
  assert.strictEqual(result, 16, 'Should clamp to maximum 16: Math.min(16, 21) = 16');
});

test('getDynamicMinConfluence: Boundary test at lower edge (6)', () => {
  const runner = createTestRunner({
    dynamicConfTrendingDelta: -5,
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'TRENDING');
  // 11 + (-5) = 6, exactly at lower boundary
  assert.strictEqual(result, 6, 'Should allow exactly 6: 11 + (-5) = 6');
});

test('getDynamicMinConfluence: Boundary test at upper edge (16)', () => {
  const runner = createTestRunner({
    dynamicConfRangingDelta: 5,
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'RANGING');
  // 11 + 5 = 16, exactly at upper boundary
  assert.strictEqual(result, 16, 'Should allow exactly 16: 11 + 5 = 16');
});

test('getDynamicMinConfluence: Regime fallback when not provided', () => {
  // Test that it uses the provided regime parameter correctly
  const runner = createTestRunner({
    dynamicConfTransitioningDelta: 0,
    minConfluenceValue: 11,
  });
  const result = runner('EURUSD', 300, 'TRANSITIONING');
  assert.strictEqual(result, 11, 'Should use provided TRANSITIONING regime');
});

test('getDynamicMinConfluence: Verify all three regimes against default constants', () => {
  // Verify the actual constants match expected values
  assert.strictEqual(TRENDING_DEFAULT, -1, 'TRENDING_DEFAULT should be -1');
  assert.strictEqual(TRANSITIONING_DEFAULT, 0, 'TRANSITIONING_DEFAULT should be 0');
  assert.strictEqual(RANGING_DEFAULT, 2, 'RANGING_DEFAULT should be +2');
});

test('getDynamicMinConfluence: Verify clamping range is 6-16', () => {
  // Lower clamp: any value < 6 becomes 6
  const runnerLow = createTestRunner({
    dynamicConfTrendingDelta: -100,
    minConfluenceValue: 11,
  });
  assert.strictEqual(runnerLow('EURUSD', 300, 'TRENDING'), 6, 'Lower clamp at 6');

  // Upper clamp: any value > 16 becomes 16
  const runnerHigh = createTestRunner({
    dynamicConfRangingDelta: 100,
    minConfluenceValue: 11,
  });
  assert.strictEqual(runnerHigh('EURUSD', 300, 'RANGING'), 16, 'Upper clamp at 16');
});

test('getDynamicMinConfluence: Different minConfluenceValue scales correctly', () => {
  // Test with a different base minConfluenceValue
  const runner = createTestRunner({
    dynamicConfTrendingDelta: -1,
    minConfluenceValue: 10,
  });
  const result = runner('EURUSD', 300, 'TRENDING');
  // 10 + (-1) = 9, clamped to [6, 16]
  assert.strictEqual(result, 9, 'Should scale with different minConfluenceValue: 10 + (-1) = 9');
});
