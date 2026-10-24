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

const EXPORTED = [
  'registerBacktestStrategy', 'getBacktestStrategies', 'getBacktestStrategy',
  'auditBacktestRegistry', 'backtestContractSize', 'backtestDirSign',
  'backtestExitPrice', 'computeBacktestMetrics', 'buildBacktestReportRows',
  'formatBacktestReport', 'exportBacktestCSV', 'getBacktestEquityCurve',
  'exportBacktestReport', '_btHarvest', '_btSnapshotStrategyState',
  '_btRestoreStrategyState', '_btNum', '_btPF'
];

function loadEngine() {
  const harness = [
    'const BACKTEST_STRATEGY_REGISTRY = new Map();',
    'const _BT_NOOP = () => {};',
    'const BT_TERMINAL_RESULTS = ["WIN", "LOSS", "BREAKEVEN", "EXPIRED"];',
    'const BACKTEST_REPORT_COLUMNS = ["Strategy","Trades","Win Rate","Profit","Profit %","Drawdown","Profit Factor"];',
    'let lastBacktestReport = null;',
    'const SYMBOL_SPECS = { R_100: { type: "synthetic", contractSize: 1 }, frxEURUSD: { type: "forex", contractSize: 100000 } };',
    'const STRATEGY_DISPLAY_LABELS = { demo_strat: "Demo Strategy" };',
    'const STRATEGY_TYPE_TO_OPPOSITE_KEY = { demo_strat: "demoStrat" };',
    'function resolveStrategyDisplayLabel(k, f) { return STRATEGY_DISPLAY_LABELS[k] || f; }',
    ...EXPORTED.map(extractFunction),
    `module.exports = { ${EXPORTED.join(', ')}, BACKTEST_STRATEGY_REGISTRY, BACKTEST_REPORT_COLUMNS };`
  ].join('\n');

  const context = { module: { exports: {} }, console };
  vm.createContext(context);
  vm.runInContext(harness, context);
  return context.module.exports;
}

test('registry auto-exposes any registered strategy, current or future', () => {
  const api = loadEngine();
  assert.equal(api.auditBacktestRegistry().sort().join(','), 'breakout_retest,demo_strat,live_scalp');

  let enabled = false;
  let history = [];
  api.registerBacktestStrategy({
    id: 'demo_strat',
    isEnabled: () => enabled,
    setEnabled: v => { enabled = v; },
    getHistory: () => history,
    setHistory: v => { history = v; }
  });

  const all = api.getBacktestStrategies();
  assert.equal(all.length, 1);
  assert.equal(all[0].label, 'Demo Strategy');
  assert.equal(api.getBacktestStrategy('demo_strat').id, 'demo_strat');
  assert.equal(api.getBacktestStrategy('demoStrat').id, 'demo_strat', 'camelCase alias resolves');
  assert.ok(!api.auditBacktestRegistry().includes('demo_strat'), 'registered id leaves the audit list');
});

test('a backtest run restores the user\'s live strategy state exactly', () => {
  const api = loadEngine();
  let enabled = true;
  let history = [{ result: 'WIN' }];
  let cooldown = 42;
  api.registerBacktestStrategy({
    id: 'demo_strat',
    isEnabled: () => enabled, setEnabled: v => { enabled = v; },
    getHistory: () => history, setHistory: v => { history = v; },
    getCooldown: () => cooldown, setCooldown: v => { cooldown = v == null ? -999 : v; }
  });

  const snap = api._btSnapshotStrategyState();
  const entry = api.BACKTEST_STRATEGY_REGISTRY.get('demo_strat');
  entry.setEnabled(false);
  entry.reset();
  assert.equal(enabled, false);
  assert.equal(history.length, 0);
  assert.equal(cooldown, -999);

  api._btRestoreStrategyState(snap);
  assert.equal(enabled, true);
  assert.equal(JSON.stringify(history), JSON.stringify([{ result: 'WIN' }]));
  assert.equal(cooldown, 42);
});

test('harvester captures each resolved signal exactly once', () => {
  const api = loadEngine();
  const history = [
    { dir: 'BULL', result: 'PENDING', entry: 1, sl: 0.5, tp: 2 },
    { dir: 'BEAR', result: 'LOSS', entry: 10, sl: 11, tp: 8, exitPrice: 11 }
  ];
  const strategy = api.registerBacktestStrategy({ id: 'demo_strat', getHistory: () => history });

  const sink = [];
  api._btHarvest(strategy, sink, { epoch: 100 });
  assert.equal(sink.length, 1);
  assert.equal(sink[0].strategy, 'demo_strat');
  assert.equal(sink[0].exitEpoch, 100);

  api._btHarvest(strategy, sink, { epoch: 200 });
  assert.equal(sink.length, 1, 'already-harvested signals are not double counted');

  history[0].result = 'WIN';
  api._btHarvest(strategy, sink, { epoch: 300 });
  assert.equal(sink.length, 2, 'newly resolved signals are picked up');
});

test('exit price honours trailing / break-even / partial exits recorded by live logic', () => {
  const api = loadEngine();
  assert.equal(api.backtestExitPrice({ result: 'WIN', entry: 100, sl: 95, tp: 110, exitPrice: 104 }), 104);
  assert.equal(api.backtestExitPrice({ result: 'WIN', entry: 100, sl: 95, tp: 110, closedPrice: 107 }), 107);
  assert.equal(api.backtestExitPrice({ result: 'WIN', entry: 100, sl: 95, tp: 110 }), 110);
  assert.equal(api.backtestExitPrice({ result: 'LOSS', entry: 100, sl: 95, tp: 110, trailingSL: 101 }), 101, 'trailing stop wins over the original SL');
  assert.equal(api.backtestExitPrice({ result: 'LOSS', entry: 100, sl: 95, tp: 110 }), 95);
  assert.equal(api.backtestExitPrice({ result: 'EXPIRED', entry: 100, sl: 95, tp: 110 }), 100, 'expired signals are flat');
});

test('metrics compute net profit, win rate, profit factor and max drawdown', () => {
  const api = loadEngine();
  const cfg = {
    symbol: 'R_100', startSec: 0, endSec: 1,
    initialBalance: 1000, sizingMode: 'lot', lotSize: 1, riskPercent: 0
  };
  const trades = [
    { strategy: 'demo_strat', dir: 'BULL', result: 'WIN',  entry: 100, sl: 90, tp: 120 }, /* +20 */
    { strategy: 'demo_strat', dir: 'BULL', result: 'LOSS', entry: 100, sl: 90, tp: 120 }, /* -10 */
    { strategy: 'demo_strat', dir: 'BEAR', result: 'WIN',  entry: 100, sl: 110, tp: 95 }, /*  +5 */
    { strategy: 'demo_strat', dir: 'BEAR', result: 'LOSS', entry: 100, sl: 110, tp: 95 }  /* -10 */
  ];

  const m = api.computeBacktestMetrics(trades, cfg);
  assert.equal(m.totalTrades, 4);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 2);
  assert.equal(m.winRate, 50);
  assert.equal(+m.netProfit.toFixed(6), 5);
  assert.equal(+m.profitPct.toFixed(6), 0.5);
  assert.equal(m.grossProfit, 25);
  assert.equal(m.grossLoss, 20);
  assert.equal(+m.profitFactor.toFixed(4), 1.25);
  assert.equal(m.finalBalance, 1005);
  /* Peak 1020 after trade 1, trough 1005 after trade 4 → 15 (1.47%) */
  assert.equal(+m.maxDrawdown.toFixed(6), 15);
  assert.equal(+m.maxDrawdownPct.toFixed(4), +(15 / 1020 * 100).toFixed(4));
  assert.equal(m.equityCurve.length, 5, 'equity curve seeds the opening balance then one point per trade');
  assert.equal(m.equityCurve[0].balance, 1000);
  assert.equal(m.equityCurve[4].balance, 1005);
  assert.equal(m.trades[0].rMultiple, 2);
});

test('risk % sizing compounds off the running balance', () => {
  const api = loadEngine();
  const cfg = {
    symbol: 'R_100', startSec: 0, endSec: 1,
    initialBalance: 1000, sizingMode: 'risk', riskPercent: 2, lotSize: 0
  };
  const trades = [
    { strategy: 's', dir: 'BULL', result: 'LOSS', entry: 100, sl: 90, tp: 120 },
    { strategy: 's', dir: 'BULL', result: 'LOSS', entry: 100, sl: 90, tp: 120 }
  ];
  const m = api.computeBacktestMetrics(trades, cfg);
  assert.equal(+m.trades[0].pnl.toFixed(4), -20, 'first loss risks 2% of 1000');
  assert.equal(+m.trades[1].pnl.toFixed(4), -19.6, 'second loss risks 2% of the reduced balance');
  assert.equal(+m.finalBalance.toFixed(4), 960.4);
});

test('lot sizing applies the symbol contract size', () => {
  const api = loadEngine();
  assert.equal(api.backtestContractSize('R_100'), 1);
  assert.equal(api.backtestContractSize('frxEURUSD'), 100000);
  assert.equal(api.backtestContractSize('UNKNOWN'), 1);

  const m = api.computeBacktestMetrics(
    [{ strategy: 's', dir: 'BULL', result: 'WIN', entry: 1.1, sl: 1.09, tp: 1.12 }],
    { symbol: 'frxEURUSD', startSec: 0, endSec: 1, initialBalance: 10000, sizingMode: 'lot', lotSize: 0.1 }
  );
  assert.equal(+m.netProfit.toFixed(2), 200);
});

test('profit factor is infinite with no losses and zero with no trades', () => {
  const api = loadEngine();
  const base = { symbol: 'R_100', startSec: 0, endSec: 1, initialBalance: 100, sizingMode: 'lot', lotSize: 1 };
  const winOnly = api.computeBacktestMetrics(
    [{ strategy: 's', dir: 'BULL', result: 'WIN', entry: 10, sl: 9, tp: 12 }], base);
  assert.equal(winOnly.profitFactor, Infinity);

  const none = api.computeBacktestMetrics([], base);
  assert.equal(none.profitFactor, 0);
  assert.equal(none.totalTrades, 0);
  assert.equal(none.winRate, 0);
  assert.equal(none.netProfit, 0);
});

test('report output is limited to the seven required columns', () => {
  const api = loadEngine();
  const report = {
    results: [Object.assign(
      { strategyId: 'demo_strat', strategy: 'Demo Strategy' },
      api.computeBacktestMetrics(
        [{ strategy: 'demo_strat', dir: 'BULL', result: 'WIN', entry: 100, sl: 90, tp: 120 }],
        { symbol: 'R_100', startSec: 0, endSec: 1, initialBalance: 1000, sizingMode: 'lot', lotSize: 1 }
      )
    )]
  };

  const rows = api.buildBacktestReportRows(report);
  assert.equal(Object.keys(rows[0]).join(','), Array.from(api.BACKTEST_REPORT_COLUMNS).join(','));
  assert.deepEqual(Object.assign({}, rows[0]), {
    Strategy: 'Demo Strategy', Trades: 1, 'Win Rate': '100.0%',
    Profit: '20.00', 'Profit %': '2.00%', Drawdown: '0.00%', 'Profit Factor': '∞'
  });

  const text = api.formatBacktestReport(report);
  assert.ok(text.startsWith('Strategy'));
  assert.equal(text.split('\n').length, 3);

  const csv = api.exportBacktestCSV(report);
  assert.equal(csv.split('\n')[0], Array.from(api.BACKTEST_REPORT_COLUMNS).join(','));
  assert.ok(csv.includes('"Demo Strategy"'));

  assert.equal(api.getBacktestEquityCurve('demo_strat', report).length, 2);
  const exported = api.exportBacktestReport(report);
  assert.notEqual(exported, report, 'export is a deep clone');
  assert.equal(exported.results[0].strategyId, 'demo_strat');
});

test('every live side effect is gated behind _btSilent', () => {
  for (const fn of ['addLog', 'showToast', 'drawChart', 'executeAutoTrade',
                    'sendTelegramMessage', 'sendTelegramPhoto', 'renderStrategyAlerts',
                    'playStrategyAlert', 'playPhaseAlert', 'sendPhaseNotification',
                    'throttledNotification', 'updateStatsUI', 'persistSignalLog']) {
    const body = extractFunction(fn);
    const firstStatement = body.slice(body.indexOf('{') + 1).trim();
    assert.ok(firstStatement.startsWith('if (_btSilent) return;'),
      `${fn}() must short-circuit when the backtest engine is replaying`);
  }
});

test('the replay pipeline mirrors the live candle pipeline, with no duplicated strategy logic', () => {
  const step = extractFunction('_btStep');
  for (const call of ['processLatestCandle()', 'processLiveScalp()', 'processCustomStrategies()',
                      'monitorTradeOutcome(candle)', 'monitorScalpOutcomes(candle)',
                      'monitorCustomStrategyOutcomes(candle)',
                      'monitorSessionRangeTradeOutcome(candle)',
                      'monitorNyOpenRangeTradeOutcome(candle)']) {
    assert.ok(step.includes(call), `_btStep() must reuse the live ${call} call`);
  }
});
