const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

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

/*
 * Covers the SL/TP dispatch gate called out in PR #389 review thread
 * (https://github.com/DSTech-876/Trading-Web/pull/389#pullrequestreview-5423544021):
 * submitMt5BridgeTrade() must skip dispatch (no fetch call, no order built)
 * when entry/SL/TP are missing/invalid or SL/TP sit on the wrong side of
 * entry for the direction actually being sent, and must dispatch normally
 * otherwise.
 */
function makeContext({ fetchImpl } = {}) {
  const logs = [];
  const fetchCalls = [];
  const context = {
    module: { exports: {} },
    mt5SignalApiUrl: 'https://example.test/signal.php',
    ITGuruAuth: { isLoggedIn: () => true },
    addLog: (msg) => logs.push(msg),
    buildMt5BridgePayload: (signal, effectiveDir, tradeSl, tradeTp, symbol, stake) => ({
      orderType: 'BUY_MARKET',
      lot: 0.01,
      idempotencyKey: 'idem-1'
    }),
    mt5BridgeHeaders: (extra) => ({ ...extra }),
    /* Audit-trail helpers added alongside the MT5 signal ledger — stubbed so
       this gate test stays focused on dispatch behavior. */
    mt5SignalAuditContext: (signalId) => ({ signalId }),
    logMt5SignalEvent: () => {},
    fmt: (n) => String(n),
    maxConcurrentTrades: 1,
    safeJson: async () => ({ ok: true, order: { orderId: 'order-1' } }),
    fetch: (...args) => {
      fetchCalls.push(args);
      return (fetchImpl || (() => Promise.resolve({ ok: true, status: 200 })))(...args);
    },
    console,
    Number,
    String,
    Date
  };
  vm.createContext(context);
  return { context, logs, fetchCalls };
}

function run(contextObj) {
  const fnSource = extractFunction('submitMt5BridgeTrade');
  const harness = `${fnSource}\nmodule.exports = { submitMt5BridgeTrade };`;
  vm.runInContext(harness, contextObj);
  return contextObj.module.exports.submitMt5BridgeTrade;
}

function baseArgs(overrides = {}) {
  return {
    signal: { entry: 1.085, dir: 'BULL' },
    effectiveDir: 'BULL',
    tradeSl: 1.083,
    tradeTp: 1.089,
    symbol: 'EURUSD',
    slot: { activeTrades: [] },
    regime: 'TRENDING',
    stake: 0.01,
    contractType: 'BUY',
    label: 'Test',
    ...overrides
  };
}

test('submitMt5BridgeTrade dispatches when SL/TP are valid for the direction', () => {
  const { context, fetchCalls } = makeContext();
  const submitMt5BridgeTrade = run(context);
  submitMt5BridgeTrade(baseArgs());
  assert.equal(fetchCalls.length, 1);
});

const invalidValues = [['NaN', NaN], ['undefined', undefined], ['null', null], ['zero', 0], ['negative', -1]];
for (const field of ['entry', 'tradeSl', 'tradeTp']) {
  for (const [name, bad] of invalidValues) {
    test(`submitMt5BridgeTrade skips dispatch when ${field} is ${name}`, () => {
      const { context, fetchCalls, logs } = makeContext();
      const submitMt5BridgeTrade = run(context);
      const args = field === 'entry'
        ? baseArgs({ signal: { entry: bad, dir: 'BULL' } })
        : baseArgs({ [field]: bad });
      submitMt5BridgeTrade(args);
      assert.equal(fetchCalls.length, 0);
      assert.ok(logs.some(l => /missing a valid entry\/SL\/TP/.test(l)));
    });
  }
}

test('submitMt5BridgeTrade skips dispatch when SL is on the wrong side of entry', () => {
  const { context, fetchCalls, logs } = makeContext();
  const submitMt5BridgeTrade = run(context);
  // BULL trade but SL placed above entry (wrong side).
  submitMt5BridgeTrade(baseArgs({ tradeSl: 1.090, tradeTp: 1.095 }));
  assert.equal(fetchCalls.length, 0);
  assert.ok(logs.some(l => /wrong side of entry/.test(l)));
});

test('submitMt5BridgeTrade skips dispatch when TP is on the wrong side of entry', () => {
  const { context, fetchCalls, logs } = makeContext();
  const submitMt5BridgeTrade = run(context);
  // BULL trade but TP placed below entry (wrong side).
  submitMt5BridgeTrade(baseArgs({ tradeSl: 1.083, tradeTp: 1.080 }));
  assert.equal(fetchCalls.length, 0);
  assert.ok(logs.some(l => /wrong side of entry/.test(l)));
});

test('submitMt5BridgeTrade validates against effectiveDir, not the original signal dir', () => {
  const { context, fetchCalls } = makeContext();
  const submitMt5BridgeTrade = run(context);
  // Opposite-mode swap: signal.dir is BULL but effectiveDir is BEAR, so SL/TP
  // must be valid for a BEAR trade (sl above entry, tp below entry).
  submitMt5BridgeTrade(baseArgs({
    signal: { entry: 1.085, dir: 'BULL' },
    effectiveDir: 'BEAR',
    tradeSl: 1.090,
    tradeTp: 1.080
  }));
  assert.equal(fetchCalls.length, 1);
});
