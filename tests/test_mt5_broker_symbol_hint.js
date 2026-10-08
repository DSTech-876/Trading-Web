const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
 * Regression test for the MT5 brokerSymbolHint mapping called out in PR #403
 * review thread (https://github.com/DSTech-876/Trading-Web/pull/403#pullrequestreview-5450331022):
 * getBrokerSymbolHint()/buildMt5BridgePayload() must supply the correct
 * broker MarketWatch name guess for every synthetic-index family (Step,
 * volatility, Boom/Crash, Jump, Daily Reset), and must leave brokerSymbolHint
 * null for symbols with no known alternate broker naming (e.g. forex), so
 * server-side MT5_SYMBOL_MAP / the client-hint fallback behave as designed.
 * This exercises the real functions rather than a stub, so it would fail if
 * brokerSymbolHint were removed or a synthetic code mapped to the wrong
 * MarketWatch name.
 */

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
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

function buildSandbox() {
  const stepIndexLabels = extractBetween(
    'const STEP_INDEX_LABELS = {',
    '};'
  ) + '};';
  const brokerSymbolHints = extractBetween(
    'const BROKER_SYMBOL_HINTS = {',
    '};'
  ) + '};';
  const script = [
    stepIndexLabels,
    brokerSymbolHints,
    extractFunction('getBrokerSymbolHint'),
    extractFunction('buildMt5BridgePayload'),
    'this.getBrokerSymbolHint = getBrokerSymbolHint;',
    'this.buildMt5BridgePayload = buildMt5BridgePayload;'
  ].join('\n\n');

  const sandbox = {
    /* buildMt5BridgePayload reads the module-scoped `candles` array directly;
       an empty array keeps it on the no-current-price (*_MARKET) branch so
       the test stays focused on brokerSymbolHint. */
    candles: [],
    fmtPrice: (price) => (price == null ? '--' : String(price)),
    mt5MinStopPoints: 0,
    mt5FreezePoints: 0,
    mt5LotStep: 0.01,
    mt5MinLot: 0.01,
    mt5MaxLot: 100,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox;
}

const sandbox = buildSandbox();

function hintFor(symbol) {
  const payload = sandbox.buildMt5BridgePayload(
    { entry: 1.085, source: 'breakout', strategyName: 'test' },
    'BULL',
    1.083,
    1.089,
    symbol,
    0.01,
    'sig_test'
  );
  return payload.brokerSymbolHint;
}

const representativeSymbols = [
  ['stpRNG', 'Step Index 100'],
  ['stpRNG4', 'Step Index 400'],
  ['stpRNG5', 'Step Index 500'],
  ['R_10', 'Volatility 10 Index'],
  ['R_100', 'Volatility 100 Index'],
  ['1HZ25V', 'Volatility 25 (1s) Index'],
  ['BOOM500', 'Boom 500 Index'],
  ['CRASH1000', 'Crash 1000 Index'],
  ['JD50', 'Jump 50 Index'],
  ['RDBULL', 'Bull Market Index'],
  ['RDBEAR', 'Bear Market Index']
];

for (const [symbol, expectedHint] of representativeSymbols) {
  test(`getBrokerSymbolHint maps ${symbol} to its broker MarketWatch name`, () => {
    assert.equal(sandbox.getBrokerSymbolHint(symbol), expectedHint);
  });

  test(`buildMt5BridgePayload carries the ${symbol} hint onto the payload`, () => {
    assert.equal(hintFor(symbol), expectedHint);
  });
}

test('getBrokerSymbolHint returns null for a symbol with no known alternate broker naming', () => {
  assert.equal(sandbox.getBrokerSymbolHint('EURUSD'), null);
});

test('buildMt5BridgePayload leaves brokerSymbolHint null for an unmapped symbol', () => {
  assert.equal(hintFor('EURUSD'), null);
});
