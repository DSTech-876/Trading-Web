const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

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

test('stampSignalLifecycle captures adaptive regime only for pending signals', () => {
  const fnSource = extractFunction('stampSignalLifecycle');
  const harness = `${fnSource}\nmodule.exports = { stampSignalLifecycle };`;
  const context = {
    module: { exports: {} },
    generateSignalId: (prefix) => `${prefix}-generated`,
    getAdaptiveRuntimeScopeKey: () => 'user:alice',
    getSignalValidityMs: () => 60000,
    getSignalDistanceLimitAtr: () => 1.5,
    getAtrReference: () => 2.25,
    getCurrentRegimeTag: () => 'TRENDING',
    Number,
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { stampSignalLifecycle } = context.module.exports;

  const pending = { result: 'PENDING', type: 'mtf_top_down' };
  stampSignalLifecycle(pending);
  assert.equal(pending.adaptiveRegime, 'TRENDING');
  assert.equal(pending.signalId, 'mtf_top_down-generated');

  const resolved = { result: 'WIN', type: 'mtf_top_down' };
  stampSignalLifecycle(resolved);
  assert.equal(resolved.adaptiveRegime, undefined);
});

test('qualifySignalForTelegram fails closed when the adaptive service errors', async () => {
  const fnSource = extractFunction('qualifySignalForTelegram');
  const harness = `${fnSource}\nmodule.exports = { qualifySignalForTelegram };`;
  const context = {
    module: { exports: {} },
    adaptiveIntelligenceClient: {
      isAuthenticated: () => true,
      qualifySignal: async () => { throw new Error('db offline'); }
    },
    initAdaptiveIntelligenceClient: () => {},
    hydrateAdaptiveRuntimeFromDb: () => {},
    buildAdaptiveQualificationPayload: () => ({ signal_id: 'sig-1' }),
    addLog: () => {},
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { qualifySignalForTelegram } = context.module.exports;

  const result = await qualifySignalForTelegram({ signalId: 'sig-1' }, 'MTF Top-Down');
  assert.equal(result.allowed, false);
  assert.equal(result.decision, null);
});

test('mergeRemoteConfluenceStats replaces stale scope data and keeps the first scoped factor row', () => {
  const fnSource = extractFunction('mergeRemoteConfluenceStats');
  const harness = `${fnSource}\nmodule.exports = { mergeRemoteConfluenceStats };`;
  const renders = [];
  const context = {
    module: { exports: {} },
    confluenceFactorStats: {
      Legacy: { wins: 99, losses: 1, currentWeight: 9, confidenceScore: 99, sampleSize: 100 }
    },
    Number,
    Object,
    renderAdaptiveConfluenceTable: () => renders.push('rendered')
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { mergeRemoteConfluenceStats } = context.module.exports;

  mergeRemoteConfluenceStats({
    factor_stats: [
      { factor_key: 'EMA Aligned', wins: 3, losses: 1, current_weight: 5, confidence_score: 60, sample_size: 4 },
      { factor_key: 'EMA Aligned', wins: 30, losses: 10, current_weight: 8, confidence_score: 90, sample_size: 40 }
    ]
  });

  assert.deepEqual(Object.keys(context.confluenceFactorStats), ['EMA Aligned']);
  assert.equal(context.confluenceFactorStats['EMA Aligned'].wins, 3);
  assert.equal(renders.length, 1);
});

test('mergeRemoteConfluenceStats re-renders cleared state for empty bootstrap replacements', () => {
  const fnSource = extractFunction('mergeRemoteConfluenceStats');
  const harness = `${fnSource}\nmodule.exports = { mergeRemoteConfluenceStats };`;
  const renders = [];
  const context = {
    module: { exports: {} },
    confluenceFactorStats: {
      Legacy: { wins: 99, losses: 1, currentWeight: 9, confidenceScore: 99, sampleSize: 100 }
    },
    Number,
    Object,
    renderAdaptiveConfluenceTable: () => renders.push('rendered')
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { mergeRemoteConfluenceStats } = context.module.exports;

  mergeRemoteConfluenceStats({ factor_stats: [] });

  assert.deepEqual(Object.keys(context.confluenceFactorStats), []);
  assert.equal(renders.length, 1);
});

test('bootstrapAdaptiveIntelligence keeps requests scoped and ignores stale responses after a panel switch', async () => {
  const harness = [
    extractFunction('getAdaptiveBootstrapLatestSignal'),
    extractFunction('getAdaptiveBootstrapStrategy'),
    extractFunction('getAdaptiveBootstrapScope'),
    extractFunction('mergeRemoteConfluenceStats'),
    extractFunction('bootstrapAdaptiveIntelligence'),
    'module.exports = { bootstrapAdaptiveIntelligence, getAdaptiveBootstrapScope };'
  ].join('\n');
  const renders = [];
  const syncs = [];
  const requests = [];
  const resolvers = [];
  let activeSymbol = 'R_25';
  const context = {
    module: { exports: {} },
    adaptiveIntelligenceClient: {
      isAuthenticated: () => true,
      bootstrap: ({ symbol, strategy_key }) => {
        requests.push({ symbol, strategy_key });
        return new Promise((resolve) => resolvers.push(resolve));
      }
    },
    adaptiveIntelligenceBootstrap: null,
    adaptiveIntelligenceBootstrapPromise: null,
    adaptiveIntelligenceBootstrapScopeKey: '',
    adaptiveIntelligenceBootstrapCache: new Map(),
    adaptiveIntelligenceBootstrapPromises: new Map(),
    adaptiveIntelligenceBootstrapLatestRequestIds: new Map(),
    adaptiveIntelligenceBootstrapRequestSeq: 0,
    confluenceFactorStats: {},
    renderAdaptiveConfluenceTable: () => renders.push(activeSymbol),
    syncPersistentAdaptiveTradeHistory: () => syncs.push(activeSymbol),
    initAdaptiveIntelligenceClient: () => {},
    ensureAdaptiveRuntimeScope: () => true,
    hydrateAdaptiveRuntimeFromDb: () => {},
    getActiveSymbol: () => activeSymbol,
    getCurrentGranularitySec: () => 60,
    getAggregatedStrategyHistory: () => {
      if (activeSymbol === 'R_25') return [{ symbol: 'R_25', strategyType: 'mtf_top_down', epoch: 25 }];
      return [{ symbol: 'R_50', strategyType: 'session_range', epoch: 50 }];
    },
    multiPanels: new Map(),
    gridScalperV2History: [],
    trade: { symbol: 'R_100', strategyType: 'breakout_retest', epoch: 1000 },
    sessionRangeTrade: null,
    nyOpenRangeTrade: null,
    Number,
    Object,
    Date,
    Promise,
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { bootstrapAdaptiveIntelligence, getAdaptiveBootstrapScope } = context.module.exports;

  const firstPromise = bootstrapAdaptiveIntelligence();
  activeSymbol = 'R_50';
  const secondPromise = bootstrapAdaptiveIntelligence();

  assert.notEqual(firstPromise, secondPromise);
  assert.deepEqual(requests, [
    { symbol: 'R_25', strategy_key: 'mtf_top_down' },
    { symbol: 'R_50', strategy_key: 'session_range' }
  ]);
  assert.equal(getAdaptiveBootstrapScope().strategy, 'session_range');

  resolvers[0]({ factor_stats: [{ factor_key: 'MTF Confirmation', wins: 2, losses: 0 }] });
  await firstPromise;
  assert.deepEqual(Object.keys(context.confluenceFactorStats), []);
  assert.equal(renders.length, 0);

  resolvers[1]({ factor_stats: [{ factor_key: 'London Sweep', wins: 4, losses: 1 }] });
  await secondPromise;
  assert.deepEqual(Object.keys(context.confluenceFactorStats), ['London Sweep']);
  assert.equal(context.confluenceFactorStats['London Sweep'].wins, 4);
  assert.deepEqual(renders, ['R_50']);
  assert.deepEqual(syncs, ['R_50']);
});

test('bootstrapAdaptiveIntelligence does not let an older forced refresh overwrite a newer scoped response', async () => {
  const harness = [
    extractFunction('getAdaptiveBootstrapLatestSignal'),
    extractFunction('getAdaptiveBootstrapStrategy'),
    extractFunction('getAdaptiveBootstrapScope'),
    extractFunction('mergeRemoteConfluenceStats'),
    extractFunction('bootstrapAdaptiveIntelligence'),
    'module.exports = { bootstrapAdaptiveIntelligence };'
  ].join('\n');
  const resolvers = [];
  const context = {
    module: { exports: {} },
    adaptiveIntelligenceClient: {
      isAuthenticated: () => true,
      bootstrap: () => new Promise((resolve) => resolvers.push(resolve))
    },
    adaptiveIntelligenceBootstrap: null,
    adaptiveIntelligenceBootstrapPromise: null,
    adaptiveIntelligenceBootstrapScopeKey: '',
    adaptiveIntelligenceBootstrapCache: new Map(),
    adaptiveIntelligenceBootstrapPromises: new Map(),
    adaptiveIntelligenceBootstrapLatestRequestIds: new Map(),
    adaptiveIntelligenceBootstrapRequestSeq: 0,
    confluenceFactorStats: {},
    renderAdaptiveConfluenceTable: () => {},
    syncPersistentAdaptiveTradeHistory: () => {},
    initAdaptiveIntelligenceClient: () => {},
    ensureAdaptiveRuntimeScope: () => true,
    hydrateAdaptiveRuntimeFromDb: () => {},
    getActiveSymbol: () => 'R_25',
    getCurrentGranularitySec: () => 60,
    getAggregatedStrategyHistory: () => [{ symbol: 'R_25', strategyType: 'mtf_top_down', epoch: 25 }],
    multiPanels: new Map(),
    gridScalperV2History: [],
    trade: null,
    sessionRangeTrade: null,
    nyOpenRangeTrade: null,
    Number,
    Object,
    Date,
    Promise,
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { bootstrapAdaptiveIntelligence } = context.module.exports;

  const firstPromise = bootstrapAdaptiveIntelligence();
  const secondPromise = bootstrapAdaptiveIntelligence(true);
  resolvers[0]({ factor_stats: [{ factor_key: 'Old', wins: 1, losses: 0 }] });
  await firstPromise;
  assert.deepEqual(Object.keys(context.confluenceFactorStats), []);

  resolvers[1]({ factor_stats: [{ factor_key: 'New', wins: 3, losses: 1 }] });
  await secondPromise;
  assert.deepEqual(Object.keys(context.confluenceFactorStats), ['New']);
});

test('bootstrapAdaptiveIntelligence reuses the current cached scope without rerendering unchanged confluence stats', async () => {
  const harness = [
    extractFunction('getAdaptiveBootstrapLatestSignal'),
    extractFunction('getAdaptiveBootstrapStrategy'),
    extractFunction('getAdaptiveBootstrapScope'),
    extractFunction('mergeRemoteConfluenceStats'),
    extractFunction('bootstrapAdaptiveIntelligence'),
    'module.exports = { bootstrapAdaptiveIntelligence };'
  ].join('\n');
  const cached = { factor_stats: [{ factor_key: 'Scoped', wins: 2, losses: 1 }] };
  const renders = [];
  const context = {
    module: { exports: {} },
    adaptiveIntelligenceClient: {
      isAuthenticated: () => true,
      bootstrap: async () => {
        throw new Error('should not fetch when cache exists');
      }
    },
    adaptiveIntelligenceBootstrap: cached,
    adaptiveIntelligenceBootstrapScopeKey: 'R_25|60|grid_scalper_v2',
    adaptiveIntelligenceBootstrapCache: new Map([['R_25|60|grid_scalper_v2', cached]]),
    adaptiveIntelligenceBootstrapPromises: new Map(),
    adaptiveIntelligenceBootstrapLatestRequestIds: new Map(),
    adaptiveIntelligenceBootstrapRequestSeq: 0,
    confluenceFactorStats: {
      Scoped: { wins: 2, losses: 1, currentWeight: 1, confidenceScore: 50, sampleSize: 3 }
    },
    renderAdaptiveConfluenceTable: () => renders.push('rendered'),
    syncPersistentAdaptiveTradeHistory: () => {},
    initAdaptiveIntelligenceClient: () => {},
    ensureAdaptiveRuntimeScope: () => true,
    hydrateAdaptiveRuntimeFromDb: () => {},
    getActiveSymbol: () => 'R_25',
    getCurrentGranularitySec: () => 60,
    getAggregatedStrategyHistory: () => [],
    multiPanels: new Map([['R_25', { symbol: 'R_25' }]]),
    gridScalperV2History: [{ symbol: 'R_25', strategyType: 'grid_scalper_v2', epoch: 25 }],
    trade: null,
    sessionRangeTrade: null,
    nyOpenRangeTrade: null,
    Number,
    Object,
    Date,
    Promise,
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { bootstrapAdaptiveIntelligence } = context.module.exports;

  const result = await bootstrapAdaptiveIntelligence();
  assert.equal(result, cached);
  assert.equal(renders.length, 0);
});

test('sendSignalLifecycleTelegram keeps terminal TP alerts as terminal alerts', async () => {
  const fnSource = extractFunction('sendSignalLifecycleTelegram');
  const harness = `${fnSource}\nmodule.exports = { sendSignalLifecycleTelegram };`;
  const seenKinds = [];
  const context = {
    module: { exports: {} },
    telegramLifecycleAlertsEnabled: true,
    telegramStrategyAutoSend: true,
    telegramAutoSend: true,
    getActiveSymbol: () => 'R_100',
    getCurrentGranularitySec: () => 60,
    fmt: (value, dp) => Number(value).toFixed(dp),
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    buildLifecycleTelegramCaption: (kind) => {
      seenKinds.push(kind);
      return kind;
    },
    sendTelegramMessage: async () => {},
    addLog: () => {},
    logSignalEngineDebug: () => {},
    isNotificationKindEnabled: () => true,
    recordTelegramDeliveryLog: () => {},
    notificationPreferences: { telegram_high_confidence_only: false },
    HIGH_CONFIDENCE_TELEGRAM_THRESHOLD: 75,
    Date,
    Math,
    Number,
    Set
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendSignalLifecycleTelegram } = context.module.exports;

  const sent = await sendSignalLifecycleTelegram('tp', {
    signalId: 'sig-1',
    channel: 'strategy',
    strategyLabel: 'MTF Top-Down',
    symbol: 'R_100',
    timeframeSec: 60,
    dir: 'BULL',
    entry: 100,
    validUntilMs: 1,
    distanceAtr: 9,
    maxDistanceAtr: 1
  });

  assert.equal(sent, true);
  assert.deepEqual(seenKinds, ['tp']);
});

test('sendTelegramSessionRangeAlert updates the originating panel trade instead of the active global trade', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const panelTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const globalTrade = { dir: 'BEAR', entry: 200, sl: 205, tp: 190 };
  let qualifiedSignal = null;
  let qualificationOverrides = null;
  let activePanelSymbol = 'R_100';
  let captureArg = undefined;
  let screenshotContext = null;
  let captionContext = null;
  const ui = {
    telegramStatus: { textContent: '', className: '' },
    symbolSelect: { value: 'R_100' },
    granSelect: { value: '60' }
  };
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: new Map([['R_25', { symbol: 'R_25', gran: 300, sessionRangeTrade: panelTrade }]]),
    sessionRangeTrade: globalTrade,
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => activePanelSymbol === 'R_25' ? ['Panel Factor'] : ['Wrong Panel Factor'],
    qualifySignalForTelegram: async (signal, _label, _force, overrides) => {
      qualifiedSignal = signal;
      qualificationOverrides = overrides;
      return { allowed: true, decision: { action: 'SEND' } };
    },
    UI: ui,
    captureTelegramScreenshot: async (panelArg) => {
      captureArg = panelArg;
      screenshotContext = {
        activePanelSymbol,
        symbol: ui.symbolSelect.value,
        gran: ui.granSelect.value
      };
      activePanelSymbol = 'R_100';
      ui.symbolSelect.value = 'R_100';
      ui.granSelect.value = '60';
      return null;
    },
    _snapshotChartGlobals: () => ({ activePanelSymbol }),
    activatePanel: (panel) => { activePanelSymbol = panel.symbol; },
    _restoreChartGlobals: (snapshot) => { activePanelSymbol = snapshot.activePanelSymbol; },
    buildSessionRangeTelegramCaption: () => {
      captionContext = {
        activePanelSymbol,
        symbol: ui.symbolSelect.value,
        gran: ui.granSelect.value
      };
      return 'caption';
    },
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => {},
    sendTelegramMessage: async () => {},
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  await sendTelegramSessionRangeAlert('LONDON_SWEEP', 'R_25');

  assert.equal(qualifiedSignal.entry, 100);
  assert.deepEqual(qualifiedSignal._confFactors, ['Panel Factor']);
  assert.equal(qualificationOverrides.symbol, 'R_25');
  assert.equal(qualificationOverrides.timeframeSec, 300);
  assert.equal(captureArg, null);
  assert.deepEqual(screenshotContext, { activePanelSymbol: 'R_25', symbol: 'R_25', gran: '300' });
  assert.deepEqual(captionContext, { activePanelSymbol: 'R_25', symbol: 'R_25', gran: '300' });
  assert.equal(ui.symbolSelect.value, 'R_100');
  assert.equal(ui.granSelect.value, '60');
  assert.equal(activePanelSymbol, 'R_100');
  assert.deepEqual(panelTrade._adaptiveDecision, { action: 'SEND' });
  assert.equal(panelTrade._sentViaTelegram, true);
  assert.equal(panelTrade._telegramDelivered, true);
  assert.equal(globalTrade._telegramDelivered, undefined);
});

test('sendTelegramSessionRangeAlert restores panel context and aborts delivery when the panel goes stale before screenshot resolves', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const panelTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const replacementTrade = { dir: 'BEAR', entry: 120, sl: 125, tp: 110 };
  const panels = new Map([['R_25', { symbol: 'R_25', gran: 300, sessionRangeTrade: panelTrade }]]);
  let activePanelSymbol = 'R_100';
  let captureArg = undefined;
  let screenshotContext = null;
  let captionContext = null;
  let resolveScreenshot;
  let sendCount = 0;
  const ui = {
    telegramStatus: { textContent: '', className: '' },
    symbolSelect: { value: 'R_100' },
    granSelect: { value: '60' }
  };
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: panels,
    sessionRangeTrade: { dir: 'BEAR', entry: 200, sl: 205, tp: 190 },
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => activePanelSymbol === 'R_25' ? ['Panel Factor'] : ['Wrong Panel Factor'],
    qualifySignalForTelegram: async () => ({ allowed: true, decision: { action: 'SEND' } }),
    UI: ui,
    captureTelegramScreenshot: async (panelArg) => {
      captureArg = panelArg;
      screenshotContext = {
        activePanelSymbol,
        symbol: ui.symbolSelect.value,
        gran: ui.granSelect.value
      };
      return await new Promise((resolve) => {
        resolveScreenshot = () => resolve(null);
      });
    },
    _snapshotChartGlobals: () => ({ activePanelSymbol }),
    activatePanel: (panel) => { activePanelSymbol = panel.symbol; },
    _restoreChartGlobals: (snapshot) => { activePanelSymbol = snapshot.activePanelSymbol; },
    buildSessionRangeTelegramCaption: () => {
      captionContext = {
        activePanelSymbol,
        symbol: ui.symbolSelect.value,
        gran: ui.granSelect.value
      };
      return 'caption';
    },
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => { sendCount++; },
    sendTelegramMessage: async () => { sendCount++; },
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  const sendPromise = sendTelegramSessionRangeAlert('LONDON_SWEEP', 'R_25');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captureArg, null);
  assert.deepEqual(screenshotContext, { activePanelSymbol: 'R_25', symbol: 'R_25', gran: '300' });
  assert.deepEqual(captionContext, { activePanelSymbol: 'R_25', symbol: 'R_25', gran: '300' });
  assert.equal(ui.symbolSelect.value, 'R_100');
  assert.equal(ui.granSelect.value, '60');
  assert.equal(activePanelSymbol, 'R_100');

  activePanelSymbol = 'R_50';
  ui.symbolSelect.value = 'R_50';
  ui.granSelect.value = '900';
  panels.get('R_25').sessionRangeTrade = replacementTrade;
  panels.delete('R_25');
  resolveScreenshot();
  await sendPromise;

  assert.equal(ui.symbolSelect.value, 'R_50');
  assert.equal(ui.granSelect.value, '900');
  assert.equal(activePanelSymbol, 'R_50');
  assert.equal(sendCount, 0);
  assert.equal(ui.telegramStatus.textContent, '');
  assert.equal(ui.telegramStatus.className, 'hint telegram-status');
});

test('sendTelegramSessionRangeAlert aborts delivery if the panel is removed during async qualification', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const panelTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const panel = { symbol: 'R_25', gran: 300, sessionRangeTrade: panelTrade };
  const panels = new Map([['R_25', panel]]);
  let activePanelSymbol = 'R_100';
  let sent = false;
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: panels,
    sessionRangeTrade: { dir: 'BEAR', entry: 200, sl: 205, tp: 190 },
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => activePanelSymbol === 'R_25' ? ['Panel Factor'] : ['Wrong Panel Factor'],
    qualifySignalForTelegram: async () => {
      panels.delete('R_25');
      return { allowed: true, decision: { action: 'SEND' } };
    },
    UI: { telegramStatus: { textContent: '', className: '' }, symbolSelect: null, granSelect: null },
    captureTelegramScreenshot: async () => null,
    _snapshotChartGlobals: () => ({ activePanelSymbol }),
    activatePanel: (nextPanel) => { activePanelSymbol = nextPanel.symbol; },
    _restoreChartGlobals: (snapshot) => { activePanelSymbol = snapshot.activePanelSymbol; },
    buildSessionRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => { sent = true; },
    sendTelegramMessage: async () => { sent = true; },
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  await sendTelegramSessionRangeAlert('LONDON_SWEEP', 'R_25');

  assert.equal(sent, false);
  assert.equal(panelTrade._adaptiveDecision, undefined);
  assert.equal(panelTrade._telegramDelivered, false);
});

test('sendTelegramSessionRangeAlert aborts delivery if panel trade is replaced during async qualification', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const panelTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const replacementTrade = { dir: 'BEAR', entry: 120, sl: 125, tp: 110 };
  const panel = { symbol: 'R_25', gran: 300, sessionRangeTrade: panelTrade };
  const panels = new Map([['R_25', panel]]);
  let activePanelSymbol = 'R_100';
  let sent = false;
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: panels,
    sessionRangeTrade: { dir: 'BEAR', entry: 200, sl: 205, tp: 190 },
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => activePanelSymbol === 'R_25' ? ['Panel Factor'] : ['Wrong Panel Factor'],
    qualifySignalForTelegram: async () => {
      panel.sessionRangeTrade = replacementTrade;
      return { allowed: true, decision: { action: 'SEND' } };
    },
    UI: { telegramStatus: { textContent: '', className: '' }, symbolSelect: null, granSelect: null },
    captureTelegramScreenshot: async () => null,
    _snapshotChartGlobals: () => ({ activePanelSymbol }),
    activatePanel: (nextPanel) => { activePanelSymbol = nextPanel.symbol; },
    _restoreChartGlobals: (snapshot) => { activePanelSymbol = snapshot.activePanelSymbol; },
    buildSessionRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => { sent = true; },
    sendTelegramMessage: async () => { sent = true; },
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  await sendTelegramSessionRangeAlert('LONDON_SWEEP', 'R_25');

  assert.equal(sent, false);
  assert.equal(panelTrade._adaptiveDecision, undefined);
  assert.equal(panelTrade._telegramDelivered, false);
  assert.equal(replacementTrade._adaptiveDecision, undefined);
  assert.equal(replacementTrade._telegramDelivered, undefined);
});

test('sendTelegramSessionRangeAlert clears its cancelled status without clobbering newer alerts when global trade is replaced during async screenshot capture', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const globalTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const replacementTrade = { dir: 'BEAR', entry: 120, sl: 125, tp: 110 };
  let sent = false;
  let builtCaption = false;
  let timeoutCalls = 0;
  let scheduledClear = null;
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: new Map(),
    sessionRangeTrade: globalTrade,
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => ['Global Factor'],
    qualifySignalForTelegram: async () => ({ allowed: true, decision: { action: 'SEND' } }),
    UI: { telegramStatus: { textContent: '', className: '' }, symbolSelect: null, granSelect: null },
    captureTelegramScreenshot: async () => {
      context.sessionRangeTrade = replacementTrade;
      return null;
    },
    _snapshotChartGlobals: () => ({}),
    activatePanel: () => {},
    _restoreChartGlobals: () => {},
    buildSessionRangeTelegramCaption: () => {
      builtCaption = true;
      return 'caption';
    },
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => { sent = true; },
    sendTelegramMessage: async () => { sent = true; },
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: (fn) => {
      timeoutCalls++;
      scheduledClear = fn;
    },
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  await sendTelegramSessionRangeAlert('LONDON_SWEEP');

  assert.equal(builtCaption, false);
  assert.equal(sent, false);
  assert.deepEqual(globalTrade._adaptiveDecision, { action: 'SEND' });
  assert.equal(globalTrade._telegramDelivered, false);
  assert.equal(replacementTrade._adaptiveDecision, undefined);
  assert.equal(replacementTrade._telegramDelivered, undefined);
  assert.equal(timeoutCalls, 1);
  assert.equal(typeof scheduledClear, 'function');
  assert.equal(context.UI.telegramStatus.textContent, '');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');

  context.UI.telegramStatus.textContent = 'Sending strategy alert…';
  context.UI.telegramStatus.className = 'hint telegram-status telegram-ok';
  scheduledClear();
  assert.equal(context.UI.telegramStatus.textContent, 'Sending strategy alert…');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status telegram-ok');
});

test('sendTelegramSessionRangeAlert does not let an older cancelled invocation clear a newer session-range status with the same text', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const originalTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const replacementTrade = { dir: 'BULL', entry: 101, sl: 96, tp: 111 };
  const qualificationResolvers = [];
  const captureResolvers = [];
  const timeoutCallbacks = [];
  let sendCount = 0;
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: new Map(),
    sessionRangeTrade: originalTrade,
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => ['Global Factor'],
    qualifySignalForTelegram: () => new Promise((resolve) => {
      qualificationResolvers.push(resolve);
    }),
    UI: { telegramStatus: { textContent: '', className: '' }, symbolSelect: null, granSelect: null },
    captureTelegramScreenshot: () => new Promise((resolve) => {
      if (captureResolvers.length === 0) context.sessionRangeTrade = replacementTrade;
      captureResolvers.push(resolve);
    }),
    _snapshotChartGlobals: () => ({}),
    activatePanel: () => {},
    _restoreChartGlobals: () => {},
    buildSessionRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => { sendCount++; },
    sendTelegramMessage: async () => { sendCount++; },
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: (fn) => { timeoutCallbacks.push(fn); },
    Date,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  const firstPromise = sendTelegramSessionRangeAlert('LONDON_SWEEP');
  await Promise.resolve();

  qualificationResolvers[0]({ allowed: true, decision: { action: 'SEND' } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(captureResolvers.length, 1);
  const secondPromise = sendTelegramSessionRangeAlert('LONDON_SWEEP');
  await Promise.resolve();
  qualificationResolvers[1]({ allowed: true, decision: { action: 'SEND' } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(captureResolvers.length, 2);
  assert.equal(context.UI.telegramStatus.textContent, 'Sending session range…');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');

  captureResolvers[0](null);
  await firstPromise;
  assert.equal(timeoutCallbacks.length, 1);

  timeoutCallbacks[0]();
  assert.equal(context.UI.telegramStatus.textContent, 'Sending session range…');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');

  captureResolvers[1](null);
  await secondPromise;
  assert.equal(sendCount, 1);
  assert.equal(timeoutCallbacks.length, 2);

  timeoutCallbacks[1]();
  assert.equal(context.UI.telegramStatus.textContent, '');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');
});

test('sendTelegramSessionRangeAlert does not let an older successful invocation replace a newer pending session-range status', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  const sharedTrade = { dir: 'BULL', entry: 100, sl: 95, tp: 110 };
  const qualificationResolvers = [];
  const captureResolvers = [];
  const timeoutCallbacks = [];
  let sendCount = 0;
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: new Map(),
    sessionRangeTrade: sharedTrade,
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getCurrentGranularitySec: () => 60,
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => ['Global Factor'],
    qualifySignalForTelegram: () => new Promise((resolve) => {
      qualificationResolvers.push(resolve);
    }),
    UI: { telegramStatus: { textContent: '', className: '' }, symbolSelect: null, granSelect: null },
    captureTelegramScreenshot: () => new Promise((resolve) => {
      captureResolvers.push(resolve);
    }),
    _snapshotChartGlobals: () => ({}),
    activatePanel: () => {},
    _restoreChartGlobals: () => {},
    buildSessionRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => { sendCount++; },
    sendTelegramMessage: async () => { sendCount++; },
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: (fn) => { timeoutCallbacks.push(fn); },
    Date,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  const firstPromise = sendTelegramSessionRangeAlert('LONDON_SWEEP');
  await Promise.resolve();
  qualificationResolvers[0]({ allowed: true, decision: { action: 'SEND' } });
  await Promise.resolve();
  await Promise.resolve();

  const secondPromise = sendTelegramSessionRangeAlert('LONDON_SWEEP');
  await Promise.resolve();
  qualificationResolvers[1]({ allowed: true, decision: { action: 'SEND' } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(context.UI.telegramStatus.textContent, 'Sending session range…');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');

  captureResolvers[0](null);
  await firstPromise;
  assert.equal(sendCount, 1);
  assert.equal(timeoutCallbacks.length, 1);
  assert.equal(context.UI.telegramStatus.textContent, 'Sending session range…');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');

  timeoutCallbacks[0]();
  assert.equal(context.UI.telegramStatus.textContent, 'Sending session range…');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');

  captureResolvers[1](null);
  await secondPromise;
  assert.equal(sendCount, 2);
  assert.equal(timeoutCallbacks.length, 2);

  timeoutCallbacks[1]();
  assert.equal(context.UI.telegramStatus.textContent, '');
  assert.equal(context.UI.telegramStatus.className, 'hint telegram-status');
});

test('sendTelegramSessionRangeAlert skips removed panels instead of falling back to the active global trade', async () => {
  const fnSource = extractFunction('sendTelegramSessionRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramSessionRangeAlert };`;
  let qualified = false;
  const context = {
    module: { exports: {} },
    telegramSessionRangeAutoSend: true,
    multiPanels: new Map(),
    sessionRangeTrade: { dir: 'BEAR', entry: 200, sl: 205, tp: 190 },
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getActiveSymbol: () => 'R_100',
    _multiPanelProcessing: null,
    _multiPanelGran: null,
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => ['Wrong Panel Factor'],
    qualifySignalForTelegram: async () => {
      qualified = true;
      return { allowed: true, decision: { action: 'SEND' } };
    },
    UI: { telegramStatus: { textContent: '', className: '' } },
    captureTelegramScreenshot: async () => null,
    _snapshotChartGlobals: () => ({}),
    activatePanel: () => {},
    _restoreChartGlobals: () => {},
    buildSessionRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => {},
    sendTelegramMessage: async () => {},
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramSessionRangeAlert } = context.module.exports;

  await sendTelegramSessionRangeAlert('LONDON_SWEEP', 'R_25');
  assert.equal(qualified, false);
});

test('sendTelegramNyOpenRangeAlert uses the originating panel breakout and confluence factors', async () => {
  const fnSource = extractFunction('sendTelegramNyOpenRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramNyOpenRangeAlert };`;
  let qualifiedSignal = null;
  let activePanelSymbol = 'R_100';
  const context = {
    module: { exports: {} },
    telegramStrategyAutoSend: true,
    multiPanels: new Map([['R_25', { symbol: 'R_25', nyOpenRangeTrade: null, nyOpenRangeBreakout: { dir: 'BULL', level: 100 } }]]),
    nyOpenRangeTrade: { dir: 'BEAR', entry: 200, sl: 205, tp: 190 },
    nyOpenRangeBreakout: { dir: 'BEAR', level: 200 },
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => activePanelSymbol === 'R_25' ? ['Panel Factor'] : ['Wrong Panel Factor'],
    qualifySignalForTelegram: async (signal) => {
      qualifiedSignal = signal;
      return { allowed: true, decision: { action: 'SEND' } };
    },
    UI: { telegramStatus: { textContent: '', className: '' } },
    captureTelegramScreenshot: async () => null,
    _snapshotChartGlobals: () => ({ activePanelSymbol }),
    activatePanel: (panel) => { activePanelSymbol = panel.symbol; },
    _restoreChartGlobals: (snapshot) => { activePanelSymbol = snapshot.activePanelSymbol; },
    buildNyOpenRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => {},
    sendTelegramMessage: async () => {},
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramNyOpenRangeAlert } = context.module.exports;

  await sendTelegramNyOpenRangeAlert('BREAKOUT', 'R_25');

  assert.equal(qualifiedSignal.dir, 'BULL');
  assert.deepEqual(qualifiedSignal._confFactors, ['Panel Factor']);
});

test('sendTelegramNyOpenRangeAlert skips removed panels instead of falling back to the active global trade', async () => {
  const fnSource = extractFunction('sendTelegramNyOpenRangeAlert');
  const harness = `${fnSource}\nmodule.exports = { sendTelegramNyOpenRangeAlert };`;
  let qualified = false;
  const context = {
    module: { exports: {} },
    telegramStrategyAutoSend: true,
    multiPanels: new Map(),
    nyOpenRangeTrade: { dir: 'BEAR', entry: 200, sl: 205, tp: 190 },
    nyOpenRangeBreakout: { dir: 'BEAR', level: 200 },
    getTelegramCredentials: () => ({ token: '123:abc', chatId: '1' }),
    validateTelegramCredentials: () => {},
    getActiveSymbol: () => 'R_100',
    getSymbolLabel: (symbol) => symbol,
    getActiveConfluenceFactors: () => ['Wrong Panel Factor'],
    qualifySignalForTelegram: async () => {
      qualified = true;
      return { allowed: true, decision: { action: 'SEND' } };
    },
    UI: { telegramStatus: { textContent: '', className: '' } },
    captureTelegramScreenshot: async () => null,
    _snapshotChartGlobals: () => ({}),
    activatePanel: () => {},
    _restoreChartGlobals: () => {},
    buildNyOpenRangeTelegramCaption: () => 'caption',
    decorateAdaptiveTelegramCaption: (caption) => caption,
    sendTelegramPhoto: async () => {},
    sendTelegramMessage: async () => {},
    addLog: () => {},
    TELEGRAM_STATUS_CLEAR_MS: 1,
    setTimeout: () => {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTelegramNyOpenRangeAlert } = context.module.exports;

  await sendTelegramNyOpenRangeAlert('BREAKOUT', 'R_25');
  assert.equal(qualified, false);
});

test('sendTradeOutcomeTelegram retries after a failed fallback send', async () => {
  const fnSource = extractFunction('sendTradeOutcomeTelegram');
  const harness = `${fnSource}\nmodule.exports = { sendTradeOutcomeTelegram };`;
  let sendAttempts = 0;
  const context = {
    module: { exports: {} },
    telegramOutcomeSend: true,
    getSymbolLabel: (symbol) => symbol,
    getActiveSymbol: () => 'R_100',
    fmtPrice: (value) => String(value),
    sendSignalLifecycleTelegram: async () => false,
    buildLifecyclePayloadFromSignal: () => ({}),
    sendTelegramMessage: async () => {
      sendAttempts++;
      if (sendAttempts === 1) throw new Error('rate limited');
    },
    addLog: () => {},
    autoTradeHistory: [],
    signalWins: 3,
    signalLosses: 1,
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { sendTradeOutcomeTelegram } = context.module.exports;

  const signal = {
    signalId: 'sig-1',
    symbol: 'R_100',
    dir: 'BULL',
    result: 'WIN',
    entry: 100,
    exitPrice: 102,
    sl: 99,
    tp: 102,
    rr: 2,
    confluenceScore: 12
  };

  await sendTradeOutcomeTelegram(signal);
  assert.equal(sendAttempts, 1);
  assert.equal(signal._outcomeSent, undefined);
  assert.equal(signal._outcomeSending, false);

  await sendTradeOutcomeTelegram(signal);
  assert.equal(sendAttempts, 2);
  assert.equal(signal._outcomeSent, true);
  assert.equal(signal._outcomeSending, false);
});

test('restoreSignalHistory persists migrated legacy signal IDs', () => {
  const harness = [
    extractFunction('stampSignalLifecycle'),
    extractFunction('ensureAdaptiveTradeResolutionTimestamp'),
    extractFunction('ensureAllKnownSignalIds'),
    extractFunction('persistSignalHistory'),
    extractFunction('restoreSignalHistory'),
    'module.exports = { restoreSignalHistory };'
  ].join('\n');
  const store = new Map();
  const context = {
    module: { exports: {} },
    LS_PREFIX: 'tg_',
    signalHistory: [],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [],
    gridScalperMAHistory: [],
    fvgStratHistory: [],
    mtfTopDownHistory: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    tiktokHistory: [],
    orderblockHistory: [],
    candleInterpHistory: [],
    po3_4hHistory: [],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    orbHistory: [],
    crtTbsHistory: [],
    generateSignalId: () => 'sig-migrated',
    getAdaptiveRuntimeScopeKey: () => 'user:alice',
    getSignalValidityMs: () => 60000,
    getSignalDistanceLimitAtr: () => 1.5,
    getAtrReference: () => 2,
    getCurrentRegimeTag: () => 'TRENDING',
    isBreakevenSignal: () => false,
    updateStatsUI: () => {},
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key)
    },
    console,
    JSON,
    Number,
    Date
  };
  store.set('tg_signalHistory', JSON.stringify([{ result: 'WIN', type: 'breakout_retest', entry: 101, time: '2026-01-01T00:00:00Z' }]));
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { restoreSignalHistory } = context.module.exports;

  restoreSignalHistory();

  assert.equal(context.signalHistory[0].signalId, 'sig-migrated');
  const persisted = JSON.parse(store.get('tg_signalHistory'));
  assert.equal(persisted[0].signalId, 'sig-migrated');
});

test('activatePanel restores MTF setup only when the exact breakout epoch exists', () => {
  const fnSource = extractFunction('activatePanel');
  const harness = `${fnSource}\nmodule.exports = { activatePanel };`;
  const context = {
    module: { exports: {} },
    MTF_RETEST_LOOKBACK: 8,
    lockIndicatorFilters: true,
    candles: [],
    rangeStartEpoch: null,
    openingRange: null,
    breakout: null,
    retestInfo: null,
    indecisionInfo: null,
    confirmInfo: null,
    trade: null,
    phase: 'WAITING',
    monitoringTrade: false,
    emaFast: [],
    emaSlow: [],
    emaHTF: [],
    atrValue: 0,
    atrValues: [],
    rsiValues: [],
    macdLine: [],
    macdSignal: [],
    macdHistogram: [],
    bbUpper: [],
    bbLower: [],
    bbMiddle: [],
    bbWidth: [],
    adxValue: 0,
    adxDiPlus: 0,
    adxDiMinus: 0,
    stochK: [],
    stochD: [],
    emaMTF: [],
    vwapValues: [],
    retestCount: 0,
    trailingSL: null,
    partialTpHit: false,
    teslaT1Hit: false,
    teslaT2Hit: false,
    teslaT3Hit: false,
    teslaBEHit: false,
    confluenceScore: 0,
    signalHistory: [],
    signalWins: 0,
    signalLosses: 0,
    signalBreakevens: 0,
    liveScalpHistory: [],
    lastScalpCandleIdx: -999,
    ws: null,
    liquiditySweepHistory: [],
    lastLiquiditySweepIdx: -999,
    stopLossHuntHistory: [],
    lastStopLossHuntIdx: -999,
    failedPinBarHistory: [],
    lastFailedPinBarIdx: -999,
    fibScalpHistory: [],
    lastFibScalpIdx: -999,
    po3History: [],
    lastPo3Idx: -999,
    gridScalperMAHistory: [],
    lastGridScalperMAIdx: -999,
    fvgStratHistory: [],
    lastFvgStratIdx: -999,
    mtfTopDownHistory: [],
    lastMtfTopDownIdx: -999,
    mtfSetupState: null,
    mtfTerminalBreakoutEpoch: null,
    lastMtfSetupAlertKey: '',
    lastMtfApproachAlertKey: '',
    candleInterpHistory: [],
    lastCandleInterpIdx: -999,
    orderblockHistory: [],
    lastOrderblockIdx: -999,
    tiktokHistory: [],
    lastTiktokIdx: -999,
    po3_4hHistory: [],
    lastPo3_4hIdx: -999,
    breakerBlockHistory: [],
    lastBreakerBlockIdx: -999,
    oteGoldenPocketHistory: [],
    lastOteGoldenPocketIdx: -999,
    sessionRangeAsian: null,
    sessionRangeLondon: null,
    sessionRangeNY: null,
    asianRangeTight: false,
    londonSweepSignal: null,
    sessionRangeTrade: null,
    sessionRangeTradeWins: 0,
    sessionRangeTradeLosses: 0,
    sessionRangeHistory: [],
    nyOpenRange: null,
    nyOpenRangeBreakout: null,
    nyOpenRangeRetest: null,
    nyOpenRangeTrade: null,
    nyOpenRangePhase: 'IDLE',
    nyOpenRangeTradeWins: 0,
    nyOpenRangeTradeLosses: 0,
    nyOpenRangeHistory: []
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { activatePanel } = context.module.exports;

  const missingEpochPanel = {
    candles: [{ epoch: 100 }, { epoch: 200 }],
    mtfTopDownHistory: [],
    lastMtfTopDownIdx: 0,
    mtfSetupState: { breakoutEpoch: 150, dir: 'BULL', level: 1.2 },
    mtfTerminalBreakoutEpoch: 150,
    lastMtfSetupAlertKey: 'setup-missing',
    lastMtfApproachAlertKey: 'approach-missing',
    filters: {}
  };
  activatePanel(missingEpochPanel);
  assert.equal(context.mtfSetupState, null);
  assert.equal(context.lastMtfSetupAlertKey, 'setup-missing');

  const exactEpochPanel = {
    candles: [{ epoch: 100 }, { epoch: 200 }],
    mtfTopDownHistory: [],
    lastMtfTopDownIdx: 0,
    mtfSetupState: { breakoutEpoch: 200, dir: 'BULL', level: 1.2 },
    mtfTerminalBreakoutEpoch: 200,
    lastMtfSetupAlertKey: 'setup-exact',
    lastMtfApproachAlertKey: 'approach-exact',
    filters: {}
  };
  activatePanel(exactEpochPanel);
  assert.equal(context.mtfSetupState.breakoutEpoch, 200);
  assert.equal(context.mtfSetupState.setupDetectedIdx, 1);
  assert.equal(context.lastMtfApproachAlertKey, 'approach-exact');
});

test('resetSession keeps only contract-backed active trades and their pending settlement records', () => {
  const harness = [
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('resetSession'),
    'module.exports = { resetSession };'
  ].join('\n');
  const clearedTimeouts = [];
  const removedLocalStorageKeys = [];
  const sentKeys = { cleared: false, clear() { this.cleared = true; } };
  const inFlightKeys = { cleared: false, clear() { this.cleared = true; } };
  const context = {
    module: { exports: {} },
    resetIndicator: () => {},
    resetStrategyStateContracts: () => {},
    resetMtfDiagnostics: () => {},
    multiPanels: new Map([['R_25', {
      mtfSetupState: { breakoutEpoch: 1 },
      mtfTerminalBreakoutEpoch: 1,
      lastMtfSetupAlertKey: 'a',
      lastMtfApproachAlertKey: 'b'
    }]]),
    mtfSetupState: { breakoutEpoch: 2 },
    mtfTerminalBreakoutEpoch: 2,
    lastMtfSetupAlertKey: 'live-a',
    lastMtfApproachAlertKey: 'live-b',
    sendSignalLifecycleTelegram: { _sentKeys: sentKeys, _inFlightKeys: inFlightKeys },
    logSignalEngineDebug: () => {},
    signalHistory: [{}],
    signalWins: 2,
    signalLosses: 1,
    signalBreakevens: 0,
    updateStatsUI: () => {},
    liveScalpHistory: [{}],
    lastScalpCandleIdx: 9,
    renderScalpAlerts: () => {},
    updateScalpStatsUI: () => {},
    renderScalpTickerBanner: () => {},
    renderStrategyTickerBanner: () => {},
    UI: { scalpAlertBanner: null, signalLog: null },
    sessionRangeTradeWins: 1,
    sessionRangeTradeLosses: 1,
    sessionRangeTrade: { id: 1 },
    londonSweepSignal: { id: 1 },
    liquiditySweepHistory: [{}],
    stopLossHuntHistory: [{}],
    failedPinBarHistory: [{}],
    fibScalpHistory: [{}],
    po3History: [{}],
    gridScalperMAHistory: [{}],
    fvgStratHistory: [{}],
    mtfTopDownHistory: [{}],
    tiktokHistory: [{}],
    orderblockHistory: [{}],
    candleInterpHistory: [{}],
    po3_4hHistory: [{}],
    breakerBlockHistory: [{}],
    oteGoldenPocketHistory: [{}],
    orbHistory: [{}],
    crtTbsHistory: [{}],
    nyOpenRangeHistory: [{}],
    sessionRangeHistory: [{}],
    renderStrategyAlerts: () => {},
    updateSignalBanners: () => {},
    document: { getElementById: () => null },
    localStorage: { removeItem: (key) => removedLocalStorageKeys.push(key) },
    sessionStorage: { removeItem: () => {} },
    LS_PREFIX: 'tg_',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    SIGNAL_NOTES_LS_KEY: 'tg_notes',
    confluenceFactorStats: { stale: { wins: 5, losses: 1 } },
    adaptiveConfluenceEnabled: true,
    renderAdaptiveConfluenceTable: () => {},
    getAdaptiveRuntimeScopeKey: () => 'user:alice',
    autoTradeHistory: [
      { symbol: 'R_100', tradeId: 'keep', result: 'PENDING' },
      { symbol: 'R_100', tradeId: 'drop', result: 'PENDING' }
    ],
    autoTradePL: 4,
    MIN_AUTO_TRADE_STAKE: 1,
    autoTradeStake: 1,
    autoTradeCurrentStake: 4,
    autoTradeWinStreak: 3,
    autoTradeLossCount: 1,
    autoTradeHalted: true,
    symbolTradeTimestamps: new Map([['R_100', [1]]]),
    strategyTradeTimestamps: new Map([['breakout', [1]]]),
    symbolCooldownUntil: new Map([['R_100', 123]]),
    autoTradeSlots: new Map([['R_100', {
      pendingTimer: 'slot-timer',
      activeTrades: [
        { tradeId: 'keep', contractId: 'cid-1', pendingTimer: 'trade-timer-1' },
        { tradeId: 'drop', contractId: null, pendingTimer: 'trade-timer-2' }
      ],
      contractId: null,
      pendingContractId: null,
      inProgress: true,
      fetchingMultiplier: true,
      consecutiveErrors: 9
    }]]),
    clearTimeout: (id) => clearedTimeouts.push(id),
    clearInterval: () => {},
    autoTradePendingTimer: null,
    uptimeInterval: null,
    candleCountdownInterval: null,
    _nyOpenRangeTimerInterval: null,
    pingTimer: null,
    watchdogTimer: null,
    reconnectTimer: null,
    reconnectDebounceTimer: null,
    backtestInterval: null,
    multiViewRefreshTimer: null,
    strategyRegimePausedUntil: {},
    updateAutoTradeCurrentStakeUI: () => {},
    autoTradeBalance: 100,
    sessionStartBalance: 50,
    getUtcDateKey: () => '2026-09-15',
    autoTradeDailyDateKey: null,
    autoTradeDailyStartBalance: null,
    autoTradeDailyPeakBalance: null,
    renderAutoTradeHistory: () => {},
    updateAutoTradePLUI: () => {},
    drawChart: () => {},
    addLog: () => {},
    parseFloat,
    Math,
    Date,
    Map,
    Set,
    Object,
    Array,
    encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { resetSession } = context.module.exports;

  resetSession();

  const slot = context.autoTradeSlots.get('R_100');
  assert.deepEqual(clearedTimeouts.sort(), ['slot-timer', 'trade-timer-1', 'trade-timer-2']);
  assert.equal(slot.activeTrades.length, 1);
  assert.equal(slot.activeTrades[0].tradeId, 'keep');
  assert.equal(slot.inProgress, true);
  assert.equal(Array.from(context.autoTradeHistory, (entry) => entry.tradeId).join(','), 'keep');
  const panel = context.multiPanels.get('R_25');
  assert.equal(panel.mtfSetupState, null);
  assert.equal(panel.lastMtfSetupAlertKey, '');
  assert.equal(sentKeys.cleared, true);
  assert.equal(inFlightKeys.cleared, true);
  assert.deepEqual(Object.keys(context.confluenceFactorStats), []);
  assert.ok(removedLocalStorageKeys.includes('tg_confStats::user%3Aalice'));
});

test('processMtfTopDown keeps debug diagnostics but skips strategy processing when disabled', () => {
  const fnSource = extractFunction('processMtfTopDown');
  const harness = `${fnSource}\nmodule.exports = { processMtfTopDown };`;
  const stageOrder = [];
  let setupCalls = 0;
  let confirmationCalls = 0;
  let signalCalls = 0;
  const context = {
    module: { exports: {} },
    mtfTopDownEnabled: false,
    mtfDebugMode: true,
    candles: [{ close: 101 }],
    MTF_REQUIRED_BASE_CANDLES: 120,
    getActiveSymbol: () => 'R_100',
    getCurrentGranularitySec: () => 60,
    markMtfPipelineStage: (stage) => stageOrder.push(stage),
    captureMtfHtfDiagnostics: () => stageOrder.push('higher_timeframe_retrieval'),
    getMtfSetupState: () => { setupCalls++; return null; },
    detectMtfConfirmation: () => { confirmationCalls++; return null; },
    detectMtfTopDown: () => { signalCalls++; return null; }
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { processMtfTopDown } = context.module.exports;

  processMtfTopDown();

  assert.deepEqual(stageOrder, ['data_feed', 'candle_aggregation', 'higher_timeframe_retrieval']);
  assert.equal(setupCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(signalCalls, 0);
});

test('processMtfTopDown records signal validation before queueing successful signals', () => {
  const fnSource = extractFunction('processMtfTopDown');
  const harness = `${fnSource}\nmodule.exports = { processMtfTopDown };`;
  const stageOrder = [];
  const context = {
    module: { exports: {} },
    mtfTopDownEnabled: true,
    mtfDebugMode: false,
    candles: [{ close: 101 }],
    MTF_REQUIRED_BASE_CANDLES: 120,
    MTF_TOP_DOWN_MAX_HISTORY: 10,
    mtfTopDownHistory: [],
    mtfSetupState: null,
    mtfTerminalBreakoutEpoch: null,
    lastMtfTopDownIdx: -1,
    _historicalProcessing: false,
    telegramStrategyAutoSend: false,
    notificationsEnabled: false,
    autoTradeStrategyEnabled: false,
    autoTradeMtfTopDown: false,
    window: {},
    Notification: { permission: 'default' },
    getActiveSymbol: () => 'R_100',
    getCurrentGranularitySec: () => 60,
    markMtfPipelineStage: (stage) => stageOrder.push(stage),
    captureMtfHtfDiagnostics: () => stageOrder.push('higher_timeframe_retrieval'),
    getMtfSetupState: () => null,
    detectMtfConfirmation: () => null,
    detectMtfTopDown: () => ({
      symbol: 'R_100',
      signalId: 'sig-1',
      candleIdx: 7,
      dir: 'BULL',
      entry: 100,
      level: 100,
      sl: 99,
      tp: 102,
      rr: 2,
      mtfBias: 'BULL',
      patternType: 'pin_bar'
    }),
    stampSignalLifecycle: () => {},
    minConfluenceEnabled: false,
    computeConfluenceScore: () => 11,
    getActiveConfluenceFactors: () => ['factor'],
    resolveSignalFactorGroup: (value) => value,
    SIGNAL_FACTOR_DEFAULT_WEIGHTS: { factor: 5 },
    mergeSignalTriggerFactorDetails: () => [],
    buildNamedTriggerFactor: (factor, detail, group, weight, passed = true, extra = {}) => ({ factor, detail, group, weight, score: passed ? weight : 0, passed, persist: extra.persist !== false }),
    qualifySignalForTelegram: async () => ({ allowed: true, decision: null }),
    playStrategyAlert: () => {},
    addLog: () => {},
    fmtPrice: (value) => String(value),
    fmt: (value, dp) => Number(value).toFixed(dp),
    logSignalEngineDebug: () => {},
    showToast: () => {},
    throttledNotification: () => {},
    sendSignalLifecycleTelegram: () => {},
    buildLifecyclePayloadFromSignal: () => ({}),
    renderStrategyAlerts: () => {},
    executeAutoTrade: () => {},
    Date,
    Object,
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { processMtfTopDown } = context.module.exports;

  processMtfTopDown();

  assert.deepEqual(stageOrder.slice(0, 5), [
    'data_feed',
    'candle_aggregation',
    'higher_timeframe_retrieval',
    'signal_validation',
    'signal_queue'
  ]);
  assert.equal(context.lastMtfTopDownIdx, 7);
  assert.equal(context.mtfTopDownHistory.length, 1);
});

test('initAdaptiveRuntime loads the authenticated user scoped state instead of the legacy shared key', () => {
  const harness = [
    extractFunction('getAdaptiveRuntimeScopeKey'),
    extractFunction('getAdaptiveRuntimeStorageKey'),
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('loadConfluenceStats'),
    extractFunction('resetAdaptiveRuntimeSyncState'),
    extractFunction('initAdaptiveRuntime'),
    'module.exports = { initAdaptiveRuntime, getAdaptiveRuntimeStorageKey };'
  ].join('\n');
  const store = new Map();
  function AdaptiveEngine(state) {
    this.state = state;
    this.setMode = (mode) => { this.mode = mode; };
    this.exportState = () => this.state;
  }
  const context = {
    module: { exports: {} },
    ADAPTIVE_STATE_LS_KEY: 'tg_adaptiveState',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    LS_PREFIX: 'tg_',
    adaptiveRuntime: null,
    adaptiveRuntimeStorageScopeKey: '__guest__',
    adaptiveMode: 'FULL_AUTO',
    adaptiveRuntimeDbHydrated: true,
    adaptiveIntelligenceBootstrap: { stale: true },
    adaptiveIntelligenceBootstrapPromise: Promise.resolve(),
    adaptiveIntelligenceBootstrapScopeKey: 'old-scope',
    adaptiveIntelligenceBootstrapCache: new Map([['old-scope', { stale: true }]]),
    adaptiveIntelligenceBootstrapPromises: new Map([['old-scope', Promise.resolve()]]),
    adaptiveIntelligenceBootstrapLatestRequestIds: new Map([['old-scope', 1]]),
    confluenceFactorStats: { stale: { wins: 1, losses: 9 } },
    AdaptiveEngine,
    ITGuruAuth: { getUser: () => ({ username: 'Alice' }) },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value)
    },
    encodeURIComponent,
    JSON,
    String,
    console
  };
  store.set('tg_adaptiveState', JSON.stringify({ owner: 'legacy-shared' }));
  store.set('tg_adaptiveState::user%3Aalice', JSON.stringify({ owner: 'alice-only' }));
  store.set('tg_confStats::user%3Aalice', JSON.stringify({ 'EMA Aligned': { wins: 3, losses: 1 } }));
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { initAdaptiveRuntime, getAdaptiveRuntimeStorageKey } = context.module.exports;

  initAdaptiveRuntime();

  assert.equal(context.adaptiveRuntime.state.owner, 'alice-only');
  assert.equal(context.adaptiveRuntimeStorageScopeKey, 'user:alice');
  assert.equal(getAdaptiveRuntimeStorageKey(), 'tg_adaptiveState::user%3Aalice');
  assert.equal(context.adaptiveRuntimeDbHydrated, false);
  assert.equal(context.adaptiveIntelligenceBootstrapCache.size, 0);
  assert.deepEqual(context.confluenceFactorStats, { 'EMA Aligned': { wins: 3, losses: 1 } });
});

test('initAdaptiveRuntime refreshes the confluence table after loading scoped stats', () => {
  const harness = [
    extractFunction('getAdaptiveRuntimeScopeKey'),
    extractFunction('getAdaptiveRuntimeStorageKey'),
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('loadConfluenceStats'),
    extractFunction('resetAdaptiveRuntimeSyncState'),
    extractFunction('initAdaptiveRuntime'),
    'module.exports = { initAdaptiveRuntime };'
  ].join('\n');
  const store = new Map();
  const renders = [];
  function AdaptiveEngine(state) {
    this.state = state;
    this.setMode = () => {};
  }
  const context = {
    module: { exports: {} },
    ADAPTIVE_STATE_LS_KEY: 'tg_adaptiveState',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    LS_PREFIX: 'tg_',
    adaptiveRuntime: null,
    adaptiveRuntimeStorageScopeKey: '__guest__',
    adaptiveMode: 'FULL_AUTO',
    adaptiveRuntimeDbHydrated: false,
    adaptiveIntelligenceBootstrap: null,
    adaptiveIntelligenceBootstrapPromise: null,
    adaptiveIntelligenceBootstrapScopeKey: '',
    adaptiveIntelligenceBootstrapCache: new Map(),
    adaptiveIntelligenceBootstrapPromises: new Map(),
    adaptiveIntelligenceBootstrapLatestRequestIds: new Map(),
    confluenceFactorStats: {},
    AdaptiveEngine,
    ITGuruAuth: { getUser: () => ({ username: 'alice' }) },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value)
    },
    renderAdaptiveConfluenceTable: () => renders.push('rendered'),
    encodeURIComponent,
    JSON,
    String,
    console
  };
  store.set('tg_confStats::user%3Aalice', JSON.stringify({ 'EMA Aligned': { wins: 4, losses: 2 } }));
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { initAdaptiveRuntime } = context.module.exports;

  initAdaptiveRuntime(true);

  assert.equal(renders.length, 1);
  assert.deepEqual(context.confluenceFactorStats, { 'EMA Aligned': { wins: 4, losses: 2 } });
});

test('ensureAdaptiveRuntimeScope reinitializes adaptive state when the authenticated user changes', () => {
  const harness = [
    extractFunction('getAdaptiveRuntimeScopeKey'),
    extractFunction('getAdaptiveRuntimeStorageKey'),
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('loadConfluenceStats'),
    extractFunction('resetAdaptiveRuntimeSyncState'),
    extractFunction('initAdaptiveRuntime'),
    extractFunction('ensureAdaptiveRuntimeScope'),
    'module.exports = { initAdaptiveRuntime, ensureAdaptiveRuntimeScope };'
  ].join('\n');
  const store = new Map();
  let currentUser = { username: 'alice' };
  function AdaptiveEngine(state) {
    this.state = state;
    this.setMode = (mode) => { this.mode = mode; };
    this.exportState = () => this.state;
  }
  const context = {
    module: { exports: {} },
    ADAPTIVE_STATE_LS_KEY: 'tg_adaptiveState',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    LS_PREFIX: 'tg_',
    adaptiveRuntime: null,
    adaptiveRuntimeStorageScopeKey: '__guest__',
    adaptiveMode: 'FULL_AUTO',
    adaptiveRuntimeDbHydrated: false,
    adaptiveIntelligenceBootstrap: null,
    adaptiveIntelligenceBootstrapPromise: null,
    adaptiveIntelligenceBootstrapScopeKey: '',
    adaptiveIntelligenceBootstrapCache: new Map(),
    adaptiveIntelligenceBootstrapPromises: new Map(),
    adaptiveIntelligenceBootstrapLatestRequestIds: new Map(),
    confluenceFactorStats: { stale: { wins: 8, losses: 2 } },
    AdaptiveEngine,
    ITGuruAuth: { getUser: () => currentUser },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value)
    },
    encodeURIComponent,
    JSON,
    String,
    console
  };
  store.set('tg_adaptiveState::user%3Aalice', JSON.stringify({ owner: 'alice-state' }));
  store.set('tg_adaptiveState::user%3Abob', JSON.stringify({ owner: 'bob-state' }));
  store.set('tg_confStats::user%3Abob', JSON.stringify({ 'EMA Aligned': { wins: 2, losses: 3 } }));
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { initAdaptiveRuntime, ensureAdaptiveRuntimeScope } = context.module.exports;

  initAdaptiveRuntime();
  context.adaptiveRuntimeDbHydrated = true;
  context.adaptiveIntelligenceBootstrap = { stale: true };
  context.adaptiveIntelligenceBootstrapPromise = Promise.resolve();
  context.adaptiveIntelligenceBootstrapScopeKey = 'alice-scope';
  context.adaptiveIntelligenceBootstrapCache.set('alice-scope', { stale: true });
  context.adaptiveIntelligenceBootstrapPromises.set('alice-scope', Promise.resolve());
  context.adaptiveIntelligenceBootstrapLatestRequestIds.set('alice-scope', 7);
  currentUser = { username: 'bob' };

  const alreadyScoped = ensureAdaptiveRuntimeScope();

  assert.equal(alreadyScoped, false);
  assert.equal(context.adaptiveRuntime.state.owner, 'bob-state');
  assert.equal(context.adaptiveRuntimeStorageScopeKey, 'user:bob');
  assert.equal(context.adaptiveRuntimeDbHydrated, false);
  assert.equal(context.adaptiveIntelligenceBootstrap, null);
  assert.equal(context.adaptiveIntelligenceBootstrapPromise, null);
  assert.equal(context.adaptiveIntelligenceBootstrapScopeKey, '');
  assert.equal(context.adaptiveIntelligenceBootstrapCache.size, 0);
  assert.equal(context.adaptiveIntelligenceBootstrapPromises.size, 0);
  assert.equal(context.adaptiveIntelligenceBootstrapLatestRequestIds.size, 0);
  assert.deepEqual(context.confluenceFactorStats, { 'EMA Aligned': { wins: 2, losses: 3 } });
});

test('confluence stats persistence is scoped per authenticated user', () => {
  const harness = [
    extractFunction('getAdaptiveRuntimeScopeKey'),
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('recordConfluenceOutcome'),
    extractFunction('loadConfluenceStats'),
    'module.exports = { recordConfluenceOutcome, loadConfluenceStats, getConfluenceStatsStorageKey };'
  ].join('\n');
  const store = new Map();
  let currentUser = { username: 'alice' };
  const context = {
    module: { exports: {} },
    LS_PREFIX: 'tg_',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    adaptiveConfluenceEnabled: true,
    confluenceFactorStats: {},
    ITGuruAuth: { getUser: () => currentUser },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value)
    },
    encodeURIComponent,
    JSON,
    Number,
    String
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { recordConfluenceOutcome, loadConfluenceStats, getConfluenceStatsStorageKey } = context.module.exports;

  recordConfluenceOutcome(['EMA Aligned'], 'WIN', 'user:alice');
  assert.equal(store.has('tg_confStats'), false);
  assert.ok(store.has('tg_confStats::user%3Aalice'));
  assert.equal(getConfluenceStatsStorageKey(), 'tg_confStats::user%3Aalice');

  currentUser = { username: 'bob' };
  store.set('tg_confStats::user%3Abob', JSON.stringify({ 'EMA Aligned': { wins: 2, losses: 3 } }));
  context.confluenceFactorStats = { stale: { wins: 99, losses: 1 } };
  loadConfluenceStats();

  assert.deepEqual(context.confluenceFactorStats, { 'EMA Aligned': { wins: 2, losses: 3 } });

  currentUser = { username: 'charlie' };
  context.confluenceFactorStats = { stale: { wins: 7, losses: 4 } };
  loadConfluenceStats();

  assert.deepEqual(Object.keys(context.confluenceFactorStats), []);
});

test('recordConfluenceOutcome ignores stale outcomes after an auth scope change', () => {
  const harness = [
    extractFunction('getAdaptiveRuntimeScopeKey'),
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('recordConfluenceOutcome'),
    'module.exports = { recordConfluenceOutcome };'
  ].join('\n');
  const store = new Map();
  let currentUser = { username: 'bob' };
  const context = {
    module: { exports: {} },
    LS_PREFIX: 'tg_',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    adaptiveConfluenceEnabled: true,
    confluenceFactorStats: {},
    ITGuruAuth: { getUser: () => currentUser },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value)
    },
    encodeURIComponent,
    JSON,
    Number,
    String
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { recordConfluenceOutcome } = context.module.exports;

  recordConfluenceOutcome(['EMA Aligned'], 'WIN', 'user:alice');

  assert.deepEqual(context.confluenceFactorStats, {});
  assert.equal(store.size, 0);
});

test('recordConfluenceOutcome ignores unscoped outcomes', () => {
  const harness = [
    extractFunction('getAdaptiveRuntimeScopeKey'),
    extractFunction('getConfluenceStatsStorageKey'),
    extractFunction('recordConfluenceOutcome'),
    'module.exports = { recordConfluenceOutcome };'
  ].join('\n');
  const store = new Map();
  const context = {
    module: { exports: {} },
    LS_PREFIX: 'tg_',
    ADAPTIVE_RUNTIME_GUEST_SCOPE: '__guest__',
    adaptiveConfluenceEnabled: true,
    confluenceFactorStats: {},
    ITGuruAuth: { getUser: () => ({ username: 'bob' }) },
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, value)
    },
    encodeURIComponent,
    JSON,
    Number,
    String
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { recordConfluenceOutcome } = context.module.exports;

  recordConfluenceOutcome(['EMA Aligned'], 'WIN');

  assert.deepEqual(context.confluenceFactorStats, {});
  assert.equal(store.size, 0);
});

test('syncPersistentAdaptiveTradeHistory only uploads outcomes from the active adaptive scope', async () => {
  const harness = [
    extractFunction('shouldSyncAdaptiveTradeSignal'),
    extractFunction('ensureAdaptiveTradeResolutionTimestamp'),
    extractFunction('syncPersistentAdaptiveTradeHistory'),
    'module.exports = { syncPersistentAdaptiveTradeHistory };'
  ].join('\n');
  const uploads = [];
  const context = {
    module: { exports: {} },
    adaptiveIntelligenceClient: {
      isAuthenticated: () => true,
      recordTrade: async (payload) => { uploads.push(payload); }
    },
    getAdaptiveRuntimeScopeKey: () => 'user:bob',
    generateSignalId: (prefix) => `${prefix}-generated`,
    resolveStrategyDisplayLabel: (value) => value,
    qualifySignalForTelegram: async () => ({ allowed: true, decision: null }),
    getActiveSymbol: () => 'R_100',
    getCurrentGranularitySec: () => 60,
    getAdaptiveMtfStatus: () => 'CONFIRMED',
    buildAdaptiveTradePayloadFromSignal: (signal) => ({ signalId: signal.signalId, scope: signal.adaptiveScopeKey }),
    backtestMode: false,
    signalHistory: [
      { result: 'WIN', adaptiveScopeKey: 'user:alice', strategyType: 'breakout_retest' },
      { result: 'WIN', strategyType: 'po3' },
      { result: 'WIN', adaptiveScopeKey: 'user:bob', strategyType: 'mtf_top_down' }
    ],
    mtfTopDownHistory: [],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    gridScalperMAHistory: [],
    gridScalperV2History: [],
    fvgStratHistory: [],
    liveScalpHistory: [],
    candleInterpHistory: [],
    orderblockHistory: [],
    tiktokHistory: [],
    po3_4hHistory: [],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    orbHistory: [],
    crtTbsHistory: [],
    Date,
    String,
    Number,
    Math,
    Object,
    Array,
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { syncPersistentAdaptiveTradeHistory } = context.module.exports;

  syncPersistentAdaptiveTradeHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], { signalId: 'mtf_top_down-generated', scope: 'user:bob' });
  assert.equal(context.signalHistory[1].signalId, undefined);
});

test('processAdaptiveResolvedSignals stops when the auth scope changes mid-run', () => {
  const harness = `${extractFunction('processAdaptiveResolvedSignals')}\nmodule.exports = { processAdaptiveResolvedSignals };`;
  const context = {
    module: { exports: {} },
    adaptiveRuntime: { state: {} },
    ensureAdaptiveRuntimeScope: () => false,
    signalHistory: [{ result: 'WIN', signalId: 'sig-1' }],
    mtfTopDownHistory: [],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    gridScalperMAHistory: [],
    fvgStratHistory: [],
    liveScalpHistory: [],
    candleInterpHistory: [],
    orderblockHistory: [],
    tiktokHistory: [],
    po3_4hHistory: [],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    crtTbsHistory: [],
    stampSignalLifecycle: () => { throw new Error('should not stamp stale signals'); },
    restoreSignalLifecycle: () => { throw new Error('should not restore stale signals'); },
    Array
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { processAdaptiveResolvedSignals } = context.module.exports;

  assert.doesNotThrow(() => processAdaptiveResolvedSignals());
});

test('processAdaptiveResolvedSignals skips unscoped outcomes instead of restamping them to the current scope', () => {
  const harness = `${extractFunction('processAdaptiveResolvedSignals')}\nmodule.exports = { processAdaptiveResolvedSignals };`;
  const records = [];
  const context = {
    module: { exports: {} },
    adaptiveRuntime: {
      wasProcessed: () => false,
      recordOutcome: (...args) => records.push(args),
      markProcessed: () => {},
      ensureProfile: () => ({})
    },
    ensureAdaptiveRuntimeScope: () => true,
    getAdaptiveRuntimeScopeKey: () => 'user:bob',
    signalHistory: [{ result: 'WIN', strategyType: 'breakout_retest' }],
    mtfTopDownHistory: [],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    gridScalperMAHistory: [],
    fvgStratHistory: [],
    liveScalpHistory: [],
    candleInterpHistory: [],
    orderblockHistory: [],
    tiktokHistory: [],
    po3_4hHistory: [],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    crtTbsHistory: [],
    stampSignalLifecycle: () => { throw new Error('should not stamp unscoped signals'); },
    syncAdaptiveProfileToDb: () => { throw new Error('should not sync unscoped signals'); },
    persistAdaptiveRuntime: () => { throw new Error('should not persist unscoped signals'); },
    Array
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { processAdaptiveResolvedSignals } = context.module.exports;

  assert.doesNotThrow(() => processAdaptiveResolvedSignals());
  assert.equal(records.length, 0);
});

test('ensureAllKnownSignalIds backfills pending scopes without rewriting resolved legacy scopes', () => {
  const harness = [
    extractFunction('stampSignalLifecycle'),
    extractFunction('ensureAllKnownSignalIds'),
    'module.exports = { ensureAllKnownSignalIds };'
  ].join('\n');
  const legacyPo3 = { result: 'WIN', type: 'power_of_3' };
  const liveOrderblock = { result: 'PENDING', type: 'orderblock' };
  const scopedPendingOrb = { signalId: 'orb-existing', result: 'PENDING', type: 'orb' };
  const scopedCrt = { result: 'LOSS', type: 'crt_tbs', adaptiveScopeKey: 'user:alice' };
  const context = {
    module: { exports: {} },
    generateSignalId: (prefix) => `${prefix}-generated`,
    getAdaptiveRuntimeScopeKey: () => 'user:bob',
    getSignalValidityMs: () => 60000,
    getSignalDistanceLimitAtr: () => 1.5,
    getAtrReference: () => 2,
    getCurrentRegimeTag: () => 'TRENDING',
    signalHistory: [],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [legacyPo3],
    gridScalperMAHistory: [],
    fvgStratHistory: [],
    mtfTopDownHistory: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    tiktokHistory: [],
    orderblockHistory: [liveOrderblock],
    candleInterpHistory: [],
    po3_4hHistory: [],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    orbHistory: [scopedPendingOrb],
    crtTbsHistory: [scopedCrt],
    Number,
    Date
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { ensureAllKnownSignalIds } = context.module.exports;

  assert.equal(ensureAllKnownSignalIds(), true);
  assert.equal(legacyPo3.signalId, 'power_of_3-generated');
  assert.equal(legacyPo3.adaptiveScopeKey, undefined);
  assert.equal(liveOrderblock.signalId, 'orderblock-generated');
  assert.equal(liveOrderblock.adaptiveScopeKey, 'user:bob');
  assert.equal(scopedPendingOrb.signalId, 'orb-existing');
  assert.equal(scopedPendingOrb.adaptiveScopeKey, 'user:bob');
  assert.equal(scopedCrt.signalId, 'crt_tbs-generated');
  assert.equal(scopedCrt.adaptiveScopeKey, 'user:alice');
});

test('retryDeferredConfluenceOutcomes replays resolved signals after switching back to their adaptive scope', () => {
  const harness = `${extractFunction('retryDeferredConfluenceOutcomes')}\nmodule.exports = { retryDeferredConfluenceOutcomes };`;
  const breakoutSignal = {
    result: 'WIN',
    adaptiveScopeKey: 'user:alice',
    _confFactors: ['Breakout']
  };
  const orderblockSignal = {
    result: 'LOSS',
    adaptiveScopeKey: 'user:alice',
    _confFactors: ['Orderblock']
  };
  const bobSignal = {
    result: 'WIN',
    adaptiveScopeKey: 'user:bob',
    _confFactors: ['Bob']
  };
  const orbSignal = {
    result: 'WIN',
    adaptiveScopeKey: 'user:alice',
    _confFactors: ['ORB']
  };
  const calls = [];
  let scope = 'user:bob';
  const context = {
    module: { exports: {} },
    adaptiveConfluenceEnabled: true,
    getAdaptiveRuntimeScopeKey: () => scope,
    recordConfluenceOutcome: (factors, result, scopeKey) => {
      calls.push({ factors, result, scopeKey });
      return true;
    },
    signalHistory: [breakoutSignal],
    mtfTopDownHistory: [],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    gridScalperMAHistory: [],
    fvgStratHistory: [],
    liveScalpHistory: [],
    candleInterpHistory: [],
    orderblockHistory: [orderblockSignal, bobSignal],
    tiktokHistory: [],
    po3_4hHistory: [],
    orbHistory: [orbSignal],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    crtTbsHistory: [],
    Array
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { retryDeferredConfluenceOutcomes } = context.module.exports;

  assert.equal(retryDeferredConfluenceOutcomes(), true);
  assert.equal(breakoutSignal._confRecorded, undefined);
  assert.equal(orderblockSignal._confRecorded, undefined);
  assert.equal(bobSignal._confRecorded, true);

  scope = 'user:alice';
  assert.equal(retryDeferredConfluenceOutcomes(), true);
  assert.equal(breakoutSignal._confRecorded, true);
  assert.equal(orderblockSignal._confRecorded, true);
  assert.equal(orbSignal._confRecorded, true);
  assert.deepEqual(calls, [
    { factors: ['Bob'], result: 'WIN', scopeKey: 'user:bob' },
    { factors: ['Breakout'], result: 'WIN', scopeKey: 'user:alice' },
    { factors: ['Orderblock'], result: 'LOSS', scopeKey: 'user:alice' },
    { factors: ['ORB'], result: 'WIN', scopeKey: 'user:alice' }
  ]);
});

test('strategy processors stamp new signals before adaptive sync and learning gates use scope', () => {
  function runCase({ fnName, detectName, historyName, signal, extras = {} }) {
    const harness = `${extractFunction(fnName)}\nmodule.exports = { ${fnName} };`;
    let stampCalls = 0;
    const context = {
      module: { exports: {} },
      minConfluenceEnabled: false,
      computeConfluenceScore: () => 7,
      getActiveConfluenceFactors: () => ['Scoped Factor'],
      stampSignalLifecycle: (entry) => {
        stampCalls++;
        entry.signalId = `${fnName}-sig`;
        entry.adaptiveScopeKey = 'user:bob';
        return entry;
      },
      getActiveSymbol: () => 'R_100',
      getCurrentGranularitySec: () => 300,
      getAtrReference: () => 1.0,
      fmtPrice: (value) => String(value),
      fmt: (value) => String(value),
      addLog: () => {},
      playStrategyAlert: () => {},
      showToast: () => {},
      renderStrategyAlerts: () => {},
      notificationsEnabled: false,
      telegramStrategyAutoSend: false,
      autoTradeStrategyEnabled: false,
      _historicalProcessing: false,
      setTimeout: () => {},
      executeAutoTrade: () => {},
      po3History: [],
      crtTbsHistory: [],
      gridScalperMAHistory: [],
      gridScalperMAPendingSetup: null,
      gridScalperMALossReversalWatch: [],
      gridScalperMAEntryDelayMode: 'immediate',
      gridScalperMAEntryQualityFilterEnabled: true,
      gridScalperMAEntryQualityMinScore: 55,
      gridScalperMAVolatilityFilterEnabled: true,
      gridScalperMAStructureFilterEnabled: true,
      gridScalperMAPullbackFilterEnabled: true,
      shouldPauseAfterRecentLosses: () => ({ block: false }),
      checkConfluenceGate: () => ({ pass: true }),
      evaluateEntryTimingQuality: () => ({ pass: true }),
      evaluateGridScalperMATrendStrength: () => ({ pass: true, score: 50 }),
      evaluateGridScalperMAVolatility: () => ({ pass: true, atrRatio: 1.2 }),
      evaluateGridScalperMAStructure: () => ({ pass: true, structureOk: true }),
      evaluateGridScalperMAPullback: () => ({ pass: true, pullbackOk: true }),
      evaluateGridScalperMAEntryQuality: () => ({ 
        pass: true, 
        score: 80, 
        details: { timing: true, trend: true, volatility: true, structure: true, pullback: true },
        reason: null,
        timing: { pass: true },
        trend: { pass: true, score: 50 },
        volatility: { pass: true, atrRatio: 1.2 },
        structure: { pass: true, structureOk: true },
        pullback: { pass: true, pullbackOk: true }
      }),
      evaluateGridScalperMAEntryDelay: () => ({ pass: true }),
      buildGridScalperMASignal: (detected) => Object.assign({}, detected),
      GRID_SCALPER_MA_CONFIRM_MAX_WAIT: 50,
      GRID_SCALPER_MA_MAX_HISTORY: 100,
      lastGridScalperMAIdx: -999,
      gridScalperV2History: [],
      PO3_MAX_HISTORY: 5,
      CRT_TBS_MAX_HISTORY: 5,
      GRID_SCALPER_MA_MAX_HISTORY: 5,
      GRID_SCALPER_V2_MAX_HISTORY: 5,
      gridScalperAdaptiveEnabled: false,
      gridScalperAdaptiveModeValue: 'Off',
      normalizeGridScalperV2Settings: () => ({ emaSlowPeriod: 1, atrPeriod: 1 }),
      applyGridScalperV2SettingsToUI: () => {},
      gridV2_resetDailyState: () => {},
      updateGridScalperV2DashboardUI: () => {},
      candles: Array.from({ length: 40 }, (_, idx) => ({ epoch: idx + 1 })),
      gridScalperV2Enabled: true,
      gridScalperV2State: null,
      lastGridScalperV2Idx: 0,
      autoTradeGridScalperV2: false,
      autoTradeGridScalperMA: false,
      autoTradePo3: false,
      Object,
      Math
    };
    context[detectName] = () => Object.assign({}, signal);
    Object.assign(context, extras);
    vm.createContext(context);
    vm.runInContext(harness, context);
    context.module.exports[fnName]();

    assert.equal(stampCalls, 1, `${fnName} should stamp the inserted signal once`);
    assert.equal(context[historyName].length, 1, `${fnName} should insert one signal`);
    assert.equal(context[historyName][0].adaptiveScopeKey, 'user:bob', `${fnName} should persist the stamped scope`);
    assert.equal(context[historyName][0].signalId, `${fnName}-sig`, `${fnName} should persist the stamped signal ID`);
  }

  runCase({
    fnName: 'processPowerOf3',
    detectName: 'detectPowerOf3',
    historyName: 'po3History',
    signal: {
      dir: 'BULL',
      entry: 100,
      sl: 95,
      tp: 110,
      rr: 2,
      candleIdx: 3,
      oneHourOpen: 99,
      sweepPrice: 98,
      fvgHigh: 101,
      fvgLow: 97,
      symbol: 'R_100',
      result: 'PENDING',
      type: 'power_of_3'
    }
  });

  runCase({
    fnName: 'processCrtTbs',
    detectName: 'detectCrtTbsStrategy',
    historyName: 'crtTbsHistory',
    signal: {
      dir: 'BULL',
      entry: 100,
      sl: 95,
      tp: 110,
      rr: 2,
      candleIdx: 3,
      crtLow: 97,
      crtHigh: 103,
      bias: 'buy',
      symbol: 'R_100',
      result: 'PENDING',
      type: 'crt_tbs'
    }
  });

  runCase({
    fnName: 'processGridScalperMA',
    detectName: 'detectGridScalperMA',
    historyName: 'gridScalperMAHistory',
    signal: {
      dir: 'BULL',
      entry: 100,
      sl: 95,
      tp: 110,
      rr: 2,
      candleIdx: 3,
      symbol: 'R_100',
      result: 'PENDING',
      type: 'grid_scalper_ma',
      mode: 'bos'
    }
  });

  runCase({
    fnName: 'processGridScalperV2',
    detectName: 'detectGridScalperV2Strategy',
    historyName: 'gridScalperV2History',
    signal: {
      dir: 'BUY',
      entry: 100,
      stopLoss: 95,
      confidenceScore: 72,
      entryScore: 64,
      gridSpacing: 1,
      maxTrades: 3,
      regime: 'RANGING',
      atr: 1,
      adx: 20,
      targets: [{ price: 110 }],
      symbol: 'R_100',
      result: 'PENDING',
      status: 'ACTIVE'
    }
  });
});

test('monitorOrderblockOutcomes only marks confluence outcomes as recorded when the scope is accepted', () => {
  const harness = `${extractFunction('monitorOrderblockOutcomes')}\nmodule.exports = { monitorOrderblockOutcomes };`;
  const calls = [];
  const aliceSignal = {
    dir: 'BULL',
    tp: 110,
    sl: 95,
    candleIdx: 0,
    result: 'PENDING',
    adaptiveScopeKey: 'user:alice',
    _confFactors: ['A']
  };
  const bobSignal = {
    dir: 'BULL',
    tp: 110,
    sl: 95,
    candleIdx: 0,
    result: 'PENDING',
    adaptiveScopeKey: 'user:bob',
    _confFactors: ['B']
  };
  const context = {
    module: { exports: {} },
    orderblockEnabled: true,
    orderblockHistory: [aliceSignal, bobSignal],
    candles: [{ high: 100, low: 100 }, { high: 111, low: 99 }],
    addLog: () => {},
    _historicalProcessing: true,
    telegramStrategyOutcomeSend: false,
    adaptiveConfluenceEnabled: true,
    recordConfluenceOutcome: (_factors, _result, scopeKey) => {
      calls.push(scopeKey);
      return scopeKey === 'user:bob';
    },
    updateStatsUI: () => {}
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { monitorOrderblockOutcomes } = context.module.exports;

  monitorOrderblockOutcomes(1);

  assert.deepEqual(calls, ['user:alice', 'user:bob']);
  assert.equal(aliceSignal.result, 'WIN');
  assert.equal(aliceSignal._confRecorded, undefined);
  assert.equal(bobSignal.result, 'WIN');
  assert.equal(bobSignal._confRecorded, true);
});

test('hydrateAdaptiveRuntimeFromDb ignores stale async responses after auth scope changes', async () => {
  const harness = [
    extractFunction('hydrateAdaptiveRuntimeFromDb'),
    'module.exports = { hydrateAdaptiveRuntimeFromDb };'
  ].join('\n');
  let resolveProfiles;
  const pendingProfiles = new Promise((resolve) => { resolveProfiles = resolve; });
  let currentScope = 'user:alice';
  let persistCalls = 0;
  const context = {
    module: { exports: {} },
    adaptiveRuntimeDbHydrated: false,
    adaptiveRuntimeStorageScopeKey: 'user:alice',
    adaptiveRuntime: { state: { symbolProfiles: {} } },
    adaptiveIntelligenceClient: {
      isAuthenticated: () => true,
      getAdaptiveProfiles: async () => pendingProfiles
    },
    initAdaptiveIntelligenceClient: () => {},
    ensureAdaptiveRuntimeScope: () => true,
    getAdaptiveRuntimeScopeKey: () => currentScope,
    persistAdaptiveRuntime: () => { persistCalls++; },
    Date,
    Number,
    String,
    Array,
    Object,
    Set,
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { hydrateAdaptiveRuntimeFromDb } = context.module.exports;

  const hydration = hydrateAdaptiveRuntimeFromDb();
  currentScope = 'user:bob';
  context.adaptiveRuntimeStorageScopeKey = 'user:bob';
  context.adaptiveRuntime = { state: { symbolProfiles: {} } };
  resolveProfiles([{
    symbol: 'R_100',
    strategy_key: 'breakout_retest',
    timeframe_sec: 60,
    regime: 'TRANSITIONING',
    profile: { settings: { minProgressAtr: 0.1 }, stats: {}, history: {}, lastRecommendation: {} },
    confidence_score: 0.8,
    sample_size: 4,
    updated_at: new Date().toISOString()
  }]);
  await hydration;

  assert.deepEqual(context.adaptiveRuntime.state.symbolProfiles, {});
  assert.equal(persistCalls, 0);
});

test('initLoginGate initializes adaptive runtime immediately on login and re-checks scope after verify', async () => {
  const harness = `${extractFunction('initLoginGate')}\nmodule.exports = { initLoginGate };`;
  const callOrder = [];
  let loginHandler = null;
  let resolveVerify;
  const verifyPromise = new Promise((resolve) => { resolveVerify = resolve; });
  const context = {
    module: { exports: {} },
    ITGuruAuth: {
      initLoginGate: ({ onLogin }) => { loginHandler = onLogin; },
      verify: () => verifyPromise,
      isLoggedIn: () => false
    },
    localStorage: { removeItem: () => callOrder.push('remove_token') },
    initAdaptiveRuntime: () => callOrder.push('init_runtime'),
    ensureAdaptiveRuntimeScope: () => callOrder.push('ensure_scope'),
    applyStrategyAccess: () => callOrder.push('apply_access'),
    bootstrapAdaptiveIntelligence: () => callOrder.push('bootstrap'),
    fetchRiskConfig: () => callOrder.push('fetch_risk_config'),
    loadNotificationPreferences: () => Promise.resolve().then(() => callOrder.push('load_notifications')),
    renderNotificationPreferencesUI: () => callOrder.push('render_notifications'),
    UI: { loginOverlay: { style: {} } },
    document: { getElementById: () => null },
    location: { reload: () => {} },
    Promise
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { initLoginGate } = context.module.exports;

  initLoginGate();
  loginHandler();
  assert.deepEqual(callOrder, ['remove_token', 'init_runtime', 'fetch_risk_config']);

  resolveVerify();
  await verifyPromise;
  await Promise.resolve();
  const initIndex = callOrder.indexOf('init_runtime');
  const ensureIndex = callOrder.indexOf('ensure_scope');
  const applyIndex = callOrder.indexOf('apply_access');
  const bootstrapIndex = callOrder.indexOf('bootstrap');
  const loadIndex = callOrder.indexOf('load_notifications');
  const renderIndex = callOrder.indexOf('render_notifications');

  assert.ok(initIndex !== -1);
  assert.ok(ensureIndex > initIndex);
  assert.ok(applyIndex > ensureIndex);
  assert.ok(bootstrapIndex > applyIndex);
  assert.ok(loadIndex !== -1);
  assert.ok(renderIndex > loadIndex);
  assert.ok(callOrder.includes('fetch_risk_config'));
});

test('syncPersistentAdaptiveTradeHistory does not record rejected cached adaptive decisions', async () => {
  const harness = `${extractFunction('syncPersistentAdaptiveTradeHistory')}\nmodule.exports = { syncPersistentAdaptiveTradeHistory };`;
  let recorded = false;
  const signal = {
    signalId: 'sig-reject',
    symbol: 'stpRNG5',
    strategyType: 'mtf_top_down',
    timeframeSec: 300,
    result: 'WIN',
    adaptiveScopeKey: 'user:test',
    _adaptiveDecision: { telegram_action: 'REJECT' }
  };
  const context = {
    module: { exports: {} },
    adaptiveIntelligenceClient: { isAuthenticated: () => true, recordTrade: async () => { recorded = true; return { ok: true }; } },
    signalHistory: [],
    mtfTopDownHistory: [signal],
    liquiditySweepHistory: [],
    stopLossHuntHistory: [],
    failedPinBarHistory: [],
    fibScalpHistory: [],
    po3History: [],
    nyOpenRangeHistory: [],
    sessionRangeHistory: [],
    gridScalperMAHistory: [],
    gridScalperV2History: [],
    fvgStratHistory: [],
    liveScalpHistory: [],
    candleInterpHistory: [],
    orderblockHistory: [],
    tiktokHistory: [],
    po3_4hHistory: [],
    breakerBlockHistory: [],
    oteGoldenPocketHistory: [],
    orbHistory: [],
    crtTbsHistory: [],
    backtestMode: false,
    getAdaptiveRuntimeScopeKey: () => 'user:test',
    shouldSyncAdaptiveTradeSignal: () => true,
    ensureAdaptiveTradeResolutionTimestamp: () => {},
    qualifySignalForTelegram: async () => ({ allowed: true, decision: null }),
    resolveStrategyDisplayLabel: () => 'MTF Top-Down',
    buildAdaptiveTradePayloadFromSignal: () => ({ signal_id: 'sig-reject' }),
    getActiveSymbol: () => 'stpRNG5',
    getCurrentGranularitySec: () => 300,
    getAdaptiveMtfStatus: () => 'CONFIRMED',
    generateSignalId: () => 'sig-reject',
    console,
    Date,
    String,
    Array
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  context.module.exports.syncPersistentAdaptiveTradeHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(recorded, false);
});

test('processMtfTopDown skips MTF active lifecycle Telegram send when adaptive qualification disallows it', async () => {
  const fnSource = extractFunction('processMtfTopDown');
  const harness = `${fnSource}\nmodule.exports = { processMtfTopDown };`;
  let lifecycleSends = 0;
  const context = {
    module: { exports: {} },
    mtfTopDownEnabled: true,
    mtfDebugMode: false,
    candles: [{ close: 101 }],
    MTF_REQUIRED_BASE_CANDLES: 120,
    MTF_TOP_DOWN_MAX_HISTORY: 10,
    mtfTopDownHistory: [],
    mtfSetupState: null,
    mtfTerminalBreakoutEpoch: null,
    lastMtfTopDownIdx: -1,
    _historicalProcessing: false,
    telegramStrategyAutoSend: false,
    notificationsEnabled: false,
    autoTradeStrategyEnabled: false,
    autoTradeMtfTopDown: false,
    window: {},
    Notification: { permission: 'default' },
    getActiveSymbol: () => 'R_100',
    getCurrentGranularitySec: () => 60,
    markMtfPipelineStage: () => {},
    captureMtfHtfDiagnostics: () => {},
    getMtfSetupState: () => null,
    detectMtfConfirmation: () => null,
    detectMtfTopDown: () => ({
      symbol: 'R_100',
      signalId: 'sig-1',
      candleIdx: 7,
      dir: 'BULL',
      entry: 100,
      level: 100,
      sl: 99,
      tp: 102,
      rr: 2,
      mtfBias: 'BULL',
      patternType: 'pin_bar'
    }),
    stampSignalLifecycle: () => {},
    minConfluenceEnabled: false,
    computeConfluenceScore: () => 11,
    getActiveConfluenceFactors: () => ['factor'],
    resolveSignalFactorGroup: (value) => value,
    SIGNAL_FACTOR_DEFAULT_WEIGHTS: { factor: 5 },
    mergeSignalTriggerFactorDetails: () => [],
    buildNamedTriggerFactor: (factor, detail, group, weight, passed = true, extra = {}) => ({ factor, detail, group, weight, score: passed ? weight : 0, passed, persist: extra.persist !== false }),
    qualifySignalForTelegram: async () => ({ allowed: false, decision: { telegram_action: 'REJECT' } }),
    playStrategyAlert: () => {},
    addLog: () => {},
    fmtPrice: (value) => String(value),
    fmt: (value, dp) => Number(value).toFixed(dp),
    logSignalEngineDebug: () => {},
    showToast: () => {},
    throttledNotification: () => {},
    sendSignalLifecycleTelegram: () => { lifecycleSends++; },
    buildLifecyclePayloadFromSignal: () => ({}),
    renderStrategyAlerts: () => {},
    executeAutoTrade: () => {},
    Date,
    Object,
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { processMtfTopDown } = context.module.exports;
  processMtfTopDown();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lifecycleSends, 0);
});

test('adaptive trade payload tracks raw factor source and still synthesizes MTF confirmation groups when needed', () => {
  const phpCode = `
require ${JSON.stringify(path.resolve(__dirname, '../api/lib/AdaptiveIntelligenceService.php'))};
$payload = adaptiveNormalizeTradePayload(['symbol' => 'R_100', 'mtf_status' => 'CONFIRMED'], false);
echo json_encode([
  'has_raw_factor_details' => $payload['has_raw_factor_details'],
  'confluence_factors_present' => $payload['confluence_factors_present']
]);
`;
  const stdout = execFileSync('php', ['-r', phpCode], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.has_raw_factor_details, false);
  assert.ok(parsed.confluence_factors_present.includes('MTF Confirmation'));
});

test('fetchRiskConfig resets the settled gate before a post-login request so trades wait for it', async () => {
  const fnSource = extractFunction('fetchRiskConfig');
  const harness = `${fnSource}\nmodule.exports = { fetchRiskConfig };`;

  let resolveFetch;
  const deferred = new Promise((resolve) => { resolveFetch = resolve; });
  let loggedIn = false;

  const context = {
    module: { exports: {} },
    ITGuruAuth: { isLoggedIn: () => loggedIn },
    mt5BridgeHeaders: () => ({}),
    safeJson: async (resp) => resp.__body,
    addLog: () => {},
    fmt: (value, dp) => Number(value).toFixed(dp),
    AUTO_TRADE_DAILY_LOSS_CAP_PCT: 4,
    riskConfigInitialRequestSettled: false,
    fetch: () => deferred,
    Number,
    console
  };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { fetchRiskConfig } = context.module.exports;

  /* Simulate the initial boot-time fetch while logged out: it returns early
     but still settles the gate since there is nothing to wait for. */
  await fetchRiskConfig();
  assert.equal(context.riskConfigInitialRequestSettled, true);

  /* Now simulate an in-page login triggering a refresh. The gate must be
     reset to false as soon as the authenticated request starts, so any
     signal firing while it's in flight is blocked rather than racing the
     stale default cap. */
  loggedIn = true;
  const pending = fetchRiskConfig();
  assert.equal(context.riskConfigInitialRequestSettled, false);

  resolveFetch({ ok: true, __body: { ok: true, dailyLossLimitPct: 2 } });
  await pending;

  assert.equal(context.riskConfigInitialRequestSettled, true);
  assert.equal(context.AUTO_TRADE_DAILY_LOSS_CAP_PCT, 2);
});

test('pollMt5BridgeStatus distinguishes a non-OK HTTP status from an invalid 200 response', async () => {
  const fnSource = extractFunction('pollMt5BridgeStatus');
  const harness = `${fnSource}\nmodule.exports = { pollMt5BridgeStatus };`;

  const reasons = [];
  let nextResponse;
  const baseContext = {
    module: { exports: {} },
    autoTradeExecutionMode: 'mt5',
    mt5StatusPollingEnabled: true,
    mt5StatusApiUrl: 'https://example.test/order_status.php',
    ITGuruAuth: { isLoggedIn: () => true },
    mt5BridgeHeaders: () => ({}),
    safeJson: async (resp) => resp.__body,
    fetch: async () => nextResponse,
    mt5LastStatusSyncTs: 0,
    noteMt5StatusPollFailure: (reason) => { reasons.push(reason); },
    MT5_FINAL_STATUSES: new Set(),
    removeActiveTrade: () => {},
    resolveMt5HistoryResult: () => 'LOSS',
    autoTradeHistory: [],
    resolveAutoTradeHistoryEntry: () => {},
    logSignalEngineDebug: () => {},
    addLog: () => {},
    getActiveSymbol: () => 'R_100',
    encodeURIComponent,
    Number,
    Array,
    String,
    console
  };
  const context = { ...baseContext };
  vm.createContext(context);
  vm.runInContext(harness, context);
  const { pollMt5BridgeStatus } = context.module.exports;

  // Non-OK HTTP status: reason should surface the actual status code.
  nextResponse = { ok: false, status: 500, __body: { ok: false, error: 'boom' } };
  await pollMt5BridgeStatus();

  // HTTP 200 but body failed to parse as JSON (safeJson() returned null).
  nextResponse = { ok: true, status: 200, __body: null };
  await pollMt5BridgeStatus();

  // HTTP 200, valid JSON, but "orders" is missing/not an array.
  nextResponse = { ok: true, status: 200, __body: { ok: true } };
  await pollMt5BridgeStatus();

  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /^HTTP 500/);
  assert.match(reasons[1], /not valid JSON/);
  assert.doesNotMatch(reasons[1], /^HTTP 200$/);
  assert.match(reasons[2], /"orders" field is missing or not an array/);
  assert.doesNotMatch(reasons[2], /^HTTP 200$/);
});

test('mt5DecodeState refuses mutating writes on corrupt payloads and preserves a copy', () => {
  const phpCode = `
require ${JSON.stringify(path.resolve(__dirname, '../api/mt5/common.php'))};
$tmp = sys_get_temp_dir() . '/mt5_decode_test_' . bin2hex(random_bytes(6)) . '.json';
file_put_contents($tmp, '{not valid json');
$state = mt5DecodeState(file_get_contents($tmp), $tmp);
echo json_encode([
  'corrupt' => $state['__corrupt'] ?? false,
  'ordersIsArray' => is_array($state['orders']),
  'preservedCopyExists' => file_exists($tmp . '.corrupt'),
]);
unlink($tmp);
if (file_exists($tmp . '.corrupt')) unlink($tmp . '.corrupt');
`;
  const stdout = execFileSync('php', ['-r', phpCode], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.corrupt, true);
  assert.equal(parsed.ordersIsArray, true);
  assert.equal(parsed.preservedCopyExists, true);
});

test('mt5WithStateLock throws instead of overwriting a corrupt state file', () => {
  const phpCode = `
require ${JSON.stringify(path.resolve(__dirname, '../api/mt5/common.php'))};
$path = mt5StoragePath();
file_put_contents($path, '{still not valid json');
try {
  mt5WithStateLock(function (array &$state) { return true; });
  echo 'NO_EXCEPTION';
} catch (RuntimeException $e) {
  echo 'THREW:' . $e->getMessage();
}
echo '|RAW:' . file_get_contents($path);
unlink($path);
if (file_exists($path . '.corrupt')) unlink($path . '.corrupt');
`;
  const stdout = execFileSync('php', ['-r', phpCode], { encoding: 'utf8' });
  assert.match(stdout, /^THREW:/);
  // The original corrupt bytes must still be on disk: the file must NOT have
  // been truncated to an empty/initialized state.
  assert.match(stdout, /RAW:\{still not valid json$/);
});

test('mt5SummarizeNotDispatched caps the per-order sample and groups by reason', () => {
  const phpCode = `
require ${JSON.stringify(path.resolve(__dirname, '../api/mt5/common.php'))};
$skipped = [];
for ($i = 0; $i < 30; $i++) {
  $skipped[] = ['orderId' => (string) $i, 'reason' => $i % 2 === 0 ? 'reasonA' : 'reasonB'];
}
$summary = mt5SummarizeNotDispatched($skipped, 20);
echo json_encode([
  'sampleCount' => count($summary['sample']),
  'total' => $summary['total'],
  'truncated' => $summary['truncated'],
  'byReason' => $summary['byReason'],
]);
`;
  const stdout = execFileSync('php', ['-r', phpCode], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.sampleCount, 20);
  assert.equal(parsed.total, 30);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.byReason.reasonA, 15);
  assert.equal(parsed.byReason.reasonB, 15);
});

test('mt5ShouldLogPullEvent only logs on signature change or heartbeat expiry', () => {
  const phpCode = `
require ${JSON.stringify(path.resolve(__dirname, '../api/mt5/common.php'))};
$terminal = 'test-terminal-' . bin2hex(random_bytes(6));
$results = [];
$results[] = mt5ShouldLogPullEvent($terminal, 'sigA', 1000, 300);
$results[] = mt5ShouldLogPullEvent($terminal, 'sigA', 1001, 300);
$results[] = mt5ShouldLogPullEvent($terminal, 'sigB', 1002, 300);
$results[] = mt5ShouldLogPullEvent($terminal, 'sigB', 1303, 300);
echo json_encode($results);
`;
  const stdout = execFileSync('php', ['-r', phpCode], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, [true, false, true, true]);
});
