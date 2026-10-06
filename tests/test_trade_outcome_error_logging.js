/*
 * Validation test for: TradeOutcomeService logging a blank
 * "Failed to log outcome:" message when a failed fetch response has an
 * empty statusText (common for HTTP/2 responses and many fetch polyfills).
 *
 * This loads the real TradeOutcomeService.js source into a sandbox (same
 * pattern used by other tests in this directory) so the assertions exercise
 * the exact production logic instead of a re-implementation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/TradeOutcomeService.js'), 'utf8');

function loadTradeOutcomeService(fetchImpl) {
  const sandbox = {
    window: {},
    sessionStorage: { getItem: () => '' },
    localStorage: { getItem: () => null },
    getTelegramCredentials: () => ({ token: 'test-token' }),
    getActiveSymbol: () => 'R_25',
    fetch: fetchImpl || (async () => { throw new Error('fetch not mocked'); }),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'TradeOutcomeService.js' });
  return sandbox.window.TradeOutcomeService;
}

function makeResponse({ ok, status = 500, statusText = '', body = '' }) {
  return {
    ok,
    status,
    statusText,
    text: async () => body
  };
}

test('_describeErrorResponse falls back to the JSON error body when statusText is blank', async () => {
  const TradeOutcomeService = loadTradeOutcomeService();
  const svc = new TradeOutcomeService();
  const response = makeResponse({ ok: false, status: 500, statusText: '', body: JSON.stringify({ error: 'database is not configured' }) });
  const message = await svc._describeErrorResponse(response);
  assert.equal(message, 'database is not configured');
});

test('_describeErrorResponse falls back to raw text when body is not JSON', async () => {
  const TradeOutcomeService = loadTradeOutcomeService();
  const svc = new TradeOutcomeService();
  const response = makeResponse({ ok: false, status: 502, statusText: '', body: 'Bad Gateway' });
  const message = await svc._describeErrorResponse(response);
  assert.equal(message, 'Bad Gateway');
});

test('_describeErrorResponse falls back to HTTP status when body and statusText are both empty', async () => {
  const TradeOutcomeService = loadTradeOutcomeService();
  const svc = new TradeOutcomeService();
  const response = makeResponse({ ok: false, status: 500, statusText: '', body: '' });
  const message = await svc._describeErrorResponse(response);
  assert.equal(message, 'HTTP 500');
});

test('_logOutcomeToDatabase logs a non-blank warning when the server returns a JSON error with no statusText', async () => {
  const fetchImpl = async () => makeResponse({
    ok: false,
    status: 500,
    statusText: '',
    body: JSON.stringify({ error: 'cannot connect to the database (visit /api/auth/status to diagnose)' })
  });
  const TradeOutcomeService = loadTradeOutcomeService(fetchImpl);
  const svc = new TradeOutcomeService();
  const logs = [];
  svc._log = (level, msg) => logs.push({ level, msg });

  await svc._logOutcomeToDatabase({ tradeId: 't1', signalId: 's1', symbol: 'R_25', type: 'grid_scalper_ma', dir: 'BULL', entry: 1, sl: 0.9, tp: 1.1, result: 'LOSS' });

  const warn = logs.find(l => l.msg.startsWith('Failed to log outcome:'));
  assert.ok(warn, 'expected a "Failed to log outcome:" warning to be logged');
  assert.notEqual(warn.msg.trim(), 'Failed to log outcome:', 'warning message must include error detail, not be blank');
  assert.match(warn.msg, /cannot connect to the database/);
});
