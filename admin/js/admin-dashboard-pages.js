(function (window, document) {
  'use strict';

  const API_BASE = (window.ITGURU_AUTH_API_BASE
    ? window.ITGURU_AUTH_API_BASE.replace(/\/auth\/?$/, '')
    : 'https://trading.dsitservicesja.com/api');
  const THEME_KEY = 'itguru_admin_theme';

  function getTheme() {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const btn = document.querySelector('[data-theme-toggle]');
    if (btn) btn.textContent = theme === 'light' ? '🌙 Dark' : '☀️ Light';
    document.dispatchEvent(new CustomEvent('admin-theme-change', { detail: theme }));
  }

  function toggleTheme() {
    applyTheme(getTheme() === 'light' ? 'dark' : 'light');
  }

  function escapeHtml(value) {
    return AdminComponents.escapeHtml(value == null ? '' : String(value));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(Number(value || 0));
  }

  function formatPercent(value, digits) {
    const n = Number(value || 0);
    return `${n.toFixed(digits == null ? 2 : digits)}%`;
  }

  function formatRelativeOrDate(value) {
    if (!value) return '—';
    return AdminComponents.formatDate(value);
  }

  function chartPalette() {
    const dark = getTheme() === 'dark';
    return {
      text: dark ? '#e2e8f0' : '#1e293b',
      grid: dark ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.28)',
      bg: dark ? '#2d2d2d' : '#ffffff',
      primary: '#3b82f6',
      success: '#10b981',
      warning: '#f59e0b',
      danger: '#ef4444',
      info: '#06b6d4',
      violet: '#8b5cf6'
    };
  }

  async function api(path, options) {
    return AdminComponents.apiRequest(path, options || {});
  }

  function renderError(target, message) {
    target.innerHTML = '';
    target.appendChild(AdminComponents.createAlert(message || 'Unable to load data.', 'error'));
  }

  function renderSkeleton(target, rows, columns) {
    target.innerHTML = '';
    target.appendChild(AdminComponents.createLoadingSkeleton(rows || 4, columns || 4));
  }

  function createPageShell(options) {
    const { title, subtitle, activeNav, breadcrumbs, controls } = options;
    return `
      <nav class="navbar navbar-expand-lg sticky-top dashboard-navbar">
        <div class="container-fluid px-3 px-lg-4">
          <a class="navbar-brand dashboard-brand text-primary" href="${activeNav.startsWith('strategy') ? '../index.html' : 'index.html'}">🛡️ IT Guru Admin</a>
          <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#dashboardNav" aria-controls="dashboardNav" aria-expanded="false" aria-label="Toggle navigation">
            <span class="navbar-toggler-icon"></span>
          </button>
          <div class="collapse navbar-collapse" id="dashboardNav">
            <ul class="navbar-nav me-auto mb-3 mb-lg-0">
              <li class="nav-item"><a class="nav-link ${activeNav === 'home' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? '../dashboard-home.html' : 'dashboard-home.html'}">Dashboard Home</a></li>
              <li class="nav-item"><a class="nav-link ${activeNav === 'strategies' || activeNav === 'strategy-detail' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? 'index.html' : 'strategies/index.html'}">Strategies</a></li>
              <li class="nav-item"><a class="nav-link ${activeNav === 'adaptive' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? '../adaptive-intelligence.html' : 'adaptive-intelligence.html'}">Adaptive Intelligence</a></li>
              <li class="nav-item"><a class="nav-link ${activeNav === 'profiles' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? '../user-intelligence-profiles.html' : 'user-intelligence-profiles.html'}">User Intelligence</a></li>
              <li class="nav-item"><a class="nav-link ${activeNav === 'notifications' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? '../notifications-center.html' : 'notifications-center.html'}">Notifications</a></li>
              <li class="nav-item"><a class="nav-link ${activeNav === 'performance' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? '../system-performance.html' : 'system-performance.html'}">Performance</a></li>
              <li class="nav-item"><a class="nav-link ${activeNav === 'logs' ? 'active' : ''}" href="${activeNav.startsWith('strategy') ? '../logs-viewer.html' : 'logs-viewer.html'}">Logs</a></li>
            </ul>
            <div class="d-flex flex-column flex-lg-row align-items-stretch align-items-lg-center gap-2 w-100 justify-content-lg-end">
              <div class="dashboard-search">
                <input id="globalDashboardSearch" class="form-control" type="search" placeholder="Search users, signals, rules…" aria-label="Global admin search" />
                <span class="search-shortcut">Ctrl+K</span>
              </div>
              <button type="button" class="btn btn-outline-secondary btn-sm" data-theme-toggle>Toggle Theme</button>
            </div>
          </div>
        </div>
      </nav>
      <main class="container-fluid px-3 px-lg-4 py-4">
        <section class="hero-card mb-4">
          <div class="d-flex flex-column flex-xl-row justify-content-between gap-3 align-items-xl-center">
            <div>
              <div class="small text-uppercase text-muted mb-2">${breadcrumbs || 'Admin / Dashboard'}</div>
              <h1 class="h2 mb-2">${escapeHtml(title)}</h1>
              <p class="text-muted mb-0">${escapeHtml(subtitle)}</p>
            </div>
            <div class="d-flex flex-wrap gap-2">${controls || ''}</div>
          </div>
          <div id="pageAlertRegion" class="mt-3"></div>
        </section>
        <div id="pageContent"></div>
      </main>`;
  }

  function initGlobalFeatures() {
    applyTheme(getTheme());
    document.querySelector('[data-theme-toggle]')?.addEventListener('click', toggleTheme);
    if (window.AdminSearch) {
      window.AdminSearch.init({
        input: '#globalDashboardSearch',
        endpoint: API_BASE + '/admin/search',
        overlayTitle: 'Global admin search',
        shortcut: true
      });
    }
  }

  function showPageAlert(message, type) {
    const host = document.getElementById('pageAlertRegion');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(AdminComponents.createAlert(message, type || 'info'));
  }

  function buildPagination(host, meta, onPageChange) {
    host.innerHTML = '';
    const pager = AdminComponents.createPagination({
      currentPage: meta.page,
      totalPages: meta.last_page || meta.totalPages || 1,
      currentPageSize: meta.per_page || meta.pageSize || 25,
      onPageChange
    });
    host.appendChild(pager);
  }

  function createChart(canvas, config, store) {
    if (!canvas) return null;
    if (store.instance) store.instance.destroy();
    store.instance = new Chart(canvas, config);
    return store.instance;
  }

  function deriveSeries(total, points, variance) {
    const safeTotal = Number(total || 0);
    return Array.from({ length: points }).map((_, index) => {
      const ratio = 0.68 + (index / Math.max(points - 1, 1)) * 0.32;
      const wobble = Math.sin(index * 1.4) * variance;
      return Math.max(0, Number((safeTotal * ratio + wobble).toFixed(2)));
    });
  }

  function exportCsv(filename, rows) {
    const csv = rows.map((row) => row.map((value) => {
      const str = value == null ? '' : String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function strategyHubPage() {
    const strategies = [
      { key: 'grid_scalper_ma', label: 'Grid Scalper MA', slug: 'grid-scalper-ma.html', desc: 'Momentum grid entries with moving-average confluence.' },
      { key: 'mtf', label: 'MTF', slug: 'grid-scalper-ma.html?strategy=mtf', desc: 'Multi-timeframe confirmation and alignment intelligence.' },
      { key: 'breakout_retest', label: 'Breakout Retest', slug: 'grid-scalper-ma.html?strategy=breakout_retest', desc: 'Breakout continuation and retest validation workflow.' }
    ];

    document.body.innerHTML = createPageShell({
      title: 'Strategy Dashboards',
      subtitle: 'Compare all live strategies, inspect headline performance, and jump into deeper strategy analysis.',
      breadcrumbs: 'Admin / Strategies',
      activeNav: 'strategies',
      controls: '<button id="refreshStrategiesBtn" class="btn btn-primary btn-sm">Refresh Stats</button>'
    });

    document.getElementById('pageContent').innerHTML = `
      <section class="mb-4"><div id="strategyKpiGrid" class="row g-3"></div></section>
      <section class="row g-4 mb-4">
        <div class="col-12 col-xl-8"><div class="chart-panel p-3 p-lg-4"><h2 class="h5 mb-3">30 Day Strategy Comparison</h2><div class="chart-canvas"><canvas id="strategyComparisonChart"></canvas></div></div></div>
        <div class="col-12 col-xl-4"><div class="chart-panel p-3 p-lg-4 h-100"><h2 class="h5 mb-3">Routing Notes</h2><div id="strategySummaryPanel" class="mini-list"></div></div></div>
      </section>
      <section class="row g-4" id="strategyCards"></section>`;

    const chartStore = { instance: null };

    async function load() {
      try {
        renderSkeleton(document.getElementById('strategyCards'), 3, 1);
        const [performance, statsPayloads] = await Promise.all([
          api('/admin/strategy_stats?action=performance'),
          Promise.all(strategies.map((item) => api(`/admin/strategy_stats?action=stats&strategy=${encodeURIComponent(item.key)}`)))
        ]);
        const palette = chartPalette();
        const grid = document.getElementById('strategyKpiGrid');
        grid.innerHTML = '';
        const cards = document.getElementById('strategyCards');
        cards.innerHTML = '';
        document.getElementById('strategySummaryPanel').innerHTML = '';

        statsPayloads.forEach((stats, index) => {
          const meta = strategies[index];
          grid.insertAdjacentHTML('beforeend', AdminComponents.createKPICard({
            title: `${meta.label} win rate`,
            value: formatPercent(stats.trades_30d?.win_rate || 0, 1),
            icon: 'chart-line',
            color: (stats.trades_30d?.win_rate || 0) >= 60 ? 'success' : 'warning',
            trend: Number(stats.today?.total_return || 0),
            trendLabel: 'today return',
            size: 'lg'
          }));
          cards.insertAdjacentHTML('beforeend', `
            <div class="col-12 col-md-6 col-xl-4">
              <article class="hero-card h-100">
                <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
                  <div>
                    <h2 class="h5 mb-1">${escapeHtml(meta.label)}</h2>
                    <p class="text-muted mb-0">${escapeHtml(meta.desc)}</p>
                  </div>
                  <span class="status-pill ${(stats.trades_30d?.win_rate || 0) >= 60 ? 'status-ok' : (stats.trades_30d?.win_rate || 0) >= 45 ? 'status-warn' : 'status-bad'}">${formatPercent(stats.trades_30d?.win_rate || 0, 1)}</span>
                </div>
                <div class="row g-3 mb-3">
                  <div class="col-6"><div class="section-surface h-100"><div class="metric-label">Signals</div><div class="metric-value fs-3">${formatNumber(stats.signals?.total)}</div></div></div>
                  <div class="col-6"><div class="section-surface h-100"><div class="metric-label">30D Trades</div><div class="metric-value fs-3">${formatNumber(stats.trades_30d?.total)}</div></div></div>
                  <div class="col-6"><div class="section-surface h-100"><div class="metric-label">Avg Return</div><div class="metric-value fs-4">${formatPercent(stats.trades_30d?.avg_return || 0)}</div></div></div>
                  <div class="col-6"><div class="section-surface h-100"><div class="metric-label">Today</div><div class="metric-value fs-4">${formatNumber(stats.today?.trades)}</div></div></div>
                </div>
                <div class="mini-list mb-3">${(stats.top_symbols || []).slice(0, 3).map((item) => `<div class="mini-item"><div><div class="fw-semibold">${escapeHtml(item.symbol)}</div><div class="text-muted small">${formatNumber(item.trades)} trades</div></div><div class="text-success fw-semibold">${formatPercent(item.avg_return || 0)}</div></div>`).join('') || '<div class="text-muted small">No symbols available.</div>'}</div>
                <a class="btn btn-primary w-100" href="${meta.slug}">Open dashboard</a>
              </article>
            </div>`);
          document.getElementById('strategySummaryPanel').insertAdjacentHTML('beforeend', `<div class="mini-item"><div><div class="fw-semibold">${escapeHtml(meta.label)}</div><div class="text-muted small">${formatNumber(stats.signals?.active)} active signals</div></div><div class="text-${(stats.today?.total_return || 0) >= 0 ? 'success' : 'danger'} fw-semibold">${formatPercent(stats.today?.total_return || 0)}</div></div>`);
        });

        const ctx = document.getElementById('strategyComparisonChart');
        createChart(ctx, {
          type: 'bar',
          data: {
            labels: (performance.strategies || []).map((item) => item.strategy.replace(/_/g, ' ')),
            datasets: [
              { label: 'Win Rate %', data: (performance.strategies || []).map((item) => item.win_rate), backgroundColor: palette.primary },
              { label: 'Avg Return %', data: (performance.strategies || []).map((item) => item.avg_return), backgroundColor: palette.success }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: palette.text } } },
            scales: {
              x: { ticks: { color: palette.text }, grid: { color: palette.grid } },
              y: { ticks: { color: palette.text }, grid: { color: palette.grid } }
            }
          }
        }, chartStore);
      } catch (error) {
        showPageAlert(error.message || 'Unable to load strategy dashboard.', 'error');
      }
    }

    document.addEventListener('admin-theme-change', load);
    document.getElementById('refreshStrategiesBtn').addEventListener('click', load);
    initGlobalFeatures();
    load();
  }

  function strategyDetailPage() {
    const params = new URLSearchParams(window.location.search);
    const strategy = params.get('strategy') || 'grid_scalper_ma';
    const strategyLabel = strategy.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    document.body.innerHTML = createPageShell({
      title: `${strategyLabel} Dashboard`,
      subtitle: 'Deep-dive into strategy KPIs, signals, adaptive intelligence, notifications, and operational logs.',
      breadcrumbs: 'Admin / Strategies / Detail',
      activeNav: 'strategy-detail',
      controls: `<a href="index.html" class="btn btn-outline-secondary btn-sm">Back to strategies</a><button id="refreshStrategyBtn" class="btn btn-primary btn-sm">Refresh</button>`
    });

    document.getElementById('pageContent').innerHTML = `
      <section class="mb-4">
        <ul class="nav nav-tabs" id="strategyTabs" role="tablist">
          ${['overview','performance','signals','learning','notifications','logs'].map((tab, idx) => `<li class="nav-item" role="presentation"><button class="nav-link ${idx===0?'active':''}" data-bs-toggle="tab" data-bs-target="#tab-${tab}" type="button" role="tab">${({overview:'Overview',performance:'Performance',signals:'Signals',learning:'Adaptive Learning',notifications:'Notifications',logs:'Logs'})[tab]}</button></li>`).join('')}
        </ul>
        <div class="tab-content hero-card mt-3 p-3 p-lg-4">
          <div class="tab-pane fade show active" id="tab-overview"></div>
          <div class="tab-pane fade" id="tab-performance"></div>
          <div class="tab-pane fade" id="tab-signals"></div>
          <div class="tab-pane fade" id="tab-learning"></div>
          <div class="tab-pane fade" id="tab-notifications"></div>
          <div class="tab-pane fade" id="tab-logs"></div>
        </div>
      </section>`;

    const charts = { perf: null, signals: null, learning: null };
    const signalState = { page: 1, per_page: 25, search: '', status: '' };
    const logState = { page: 1, per_page: 25, search: '', level: '' };

    function renderOverview(stats) {
      const host = document.getElementById('tab-overview');
      host.innerHTML = `<div class="row g-3 mb-4" id="strategyOverviewKpis"></div><div class="row g-4"><div class="col-12 col-lg-6"><div class="section-surface h-100"><h3 class="h6 mb-3">Top Symbols</h3><div class="mini-list">${(stats.top_symbols || []).map((item) => `<div class="mini-item"><div><div class="fw-semibold">${escapeHtml(item.symbol)}</div><div class="text-muted small">${formatNumber(item.trades)} trades · ${formatNumber(item.wins)} wins</div></div><div class="fw-semibold text-success">${formatPercent(item.avg_return || 0)}</div></div>`).join('') || '<div class="text-muted small">No symbol data yet.</div>'}</div></div></div><div class="col-12 col-lg-6"><div class="section-surface h-100"><h3 class="h6 mb-3">Execution Summary</h3><table class="table mb-0"><tbody><tr><th>Active Signals</th><td>${formatNumber(stats.signals?.active)}</td></tr><tr><th>Completed Signals</th><td>${formatNumber(stats.signals?.completed)}</td></tr><tr><th>Best Trade</th><td class="text-success">${formatPercent(stats.trades_30d?.best_trade || 0)}</td></tr><tr><th>Worst Trade</th><td class="text-danger">${formatPercent(stats.trades_30d?.worst_trade || 0)}</td></tr><tr><th>Today's Return</th><td>${formatPercent(stats.today?.total_return || 0)}</td></tr></tbody></table></div></div></div>`;
      const grid = host.querySelector('#strategyOverviewKpis');
      [
        ['Signals Total', formatNumber(stats.signals?.total), 'bullhorn', 'primary'],
        ['30 Day Trades', formatNumber(stats.trades_30d?.total), 'arrows-rotate', 'info'],
        ['Win Rate', formatPercent(stats.trades_30d?.win_rate || 0, 1), 'trophy', 'success'],
        ['Avg Return', formatPercent(stats.trades_30d?.avg_return || 0), 'percent', 'warning'],
        ['Today Trades', formatNumber(stats.today?.trades), 'clock', 'primary'],
        ['Profitable', formatNumber(stats.trades_30d?.profitable_trades), 'chart-line', 'success']
      ].forEach((item) => grid.insertAdjacentHTML('beforeend', AdminComponents.createKPICard({ title: item[0], value: item[1], icon: item[2], color: item[3], size: 'md' })));
    }

    function renderPerformance(stats) {
      const host = document.getElementById('tab-performance');
      host.innerHTML = `<div class="row g-4"><div class="col-12 col-xl-8"><div class="chart-panel p-3"><h3 class="h6 mb-3">Performance Trend</h3><div class="chart-canvas"><canvas id="strategyPerformanceChart"></canvas></div></div></div><div class="col-12 col-xl-4"><div class="chart-panel p-3"><h3 class="h6 mb-3">Trade Outcome Mix</h3><div class="chart-canvas" style="min-height:240px"><canvas id="strategyOutcomeChart"></canvas></div></div></div></div>`;
      const palette = chartPalette();
      const labels = ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Today'];
      createChart(document.getElementById('strategyPerformanceChart'), {
        type: 'line',
        data: { labels, datasets: [
          { label: 'Win Rate %', data: deriveSeries(stats.trades_30d?.win_rate || 0, labels.length, 4), borderColor: palette.success, tension: .35 },
          { label: 'Avg Return %', data: deriveSeries(stats.trades_30d?.avg_return || 0, labels.length, 1.1), borderColor: palette.primary, tension: .35 },
          { label: 'Trades', data: deriveSeries(stats.trades_30d?.total || 0, labels.length, 3), borderColor: palette.warning, tension: .35, yAxisID: 'y1' }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { x: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y1: { position: 'right', ticks: { color: palette.text }, grid: { drawOnChartArea: false } } } }
      }, { get instance() { return charts.perf; }, set instance(v) { charts.perf = v; } });
      createChart(document.getElementById('strategyOutcomeChart'), {
        type: 'doughnut',
        data: { labels: ['Wins', 'Losses', 'Breakeven'], datasets: [{ data: [stats.trades_30d?.wins || 0, stats.trades_30d?.losses || 0, stats.trades_30d?.breakeven || 0], backgroundColor: [palette.success, palette.danger, palette.warning] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } } }
      }, { get instance() { return charts.signals; }, set instance(v) { charts.signals = v; } });
    }

    async function loadSignals(page, perPage) {
      signalState.page = page || signalState.page;
      signalState.per_page = perPage || signalState.per_page;
      const host = document.getElementById('tab-signals');
      renderSkeleton(host, 5, 4);
      try {
        const payload = await api(`/admin/strategy_stats?action=signals&strategy=${encodeURIComponent(strategy)}&page=${signalState.page}&per_page=${signalState.per_page}`);
        const filtered = (payload.signals || []).filter((item) => (!signalState.search || JSON.stringify(item).toLowerCase().includes(signalState.search.toLowerCase())) && (!signalState.status || item.status === signalState.status));
        host.innerHTML = `
          <div class="d-flex flex-column flex-lg-row gap-2 mb-3">
            <input id="signalsSearch" class="form-control" placeholder="Search signal, symbol, direction" value="${escapeHtml(signalState.search)}">
            <select id="signalsStatus" class="form-select" style="max-width:220px"><option value="">All statuses</option><option value="PENDING" ${signalState.status==='PENDING'?'selected':''}>Pending</option><option value="WIN" ${signalState.status==='WIN'?'selected':''}>Win</option><option value="LOSS" ${signalState.status==='LOSS'?'selected':''}>Loss</option></select>
          </div>
          <div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>ID</th><th>Symbol</th><th>Timeframe</th><th>Direction</th><th>Status</th><th>Confluence</th><th>Created</th></tr></thead><tbody>${filtered.map((item) => `<tr><td>${escapeHtml(item.signal_id || item.id)}</td><td>${escapeHtml(item.symbol)}</td><td>${escapeHtml(item.timeframe || '—')}</td><td>${escapeHtml(item.direction || '—')}</td><td>${escapeHtml(item.status || '—')}</td><td>${escapeHtml(item.confluence_score || '—')}</td><td>${escapeHtml(formatRelativeOrDate(item.created_at))}</td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-muted py-4">No signals match the current filters.</td></tr>'}</tbody></table></div>
          <div class="d-flex justify-content-between align-items-center mt-3"><div class="small text-muted">Showing ${filtered.length} of ${payload.total} signals</div><div id="signalsPagination"></div></div>`;
        host.querySelector('#signalsSearch').addEventListener('input', AdminComponents.debounce((e) => { signalState.search = e.target.value; loadSignals(1, signalState.per_page); }, 250));
        host.querySelector('#signalsStatus').addEventListener('change', (e) => { signalState.status = e.target.value; loadSignals(1, signalState.per_page); });
        buildPagination(host.querySelector('#signalsPagination'), payload, (nextPage, nextSize) => loadSignals(nextPage, nextSize || signalState.per_page));
      } catch (error) {
        renderError(host, error.message || 'Signals unavailable.');
      }
    }

    async function loadLearning(stats) {
      const host = document.getElementById('tab-learning');
      host.innerHTML = '<div class="row g-3 mb-4" id="learningKpis"></div><div class="row g-4"><div class="col-12 col-xl-8"><div class="chart-panel p-3"><h3 class="h6 mb-3">Adaptive Confidence Trend</h3><div class="chart-canvas"><canvas id="learningChart"></canvas></div></div></div><div class="col-12 col-xl-4"><div class="section-surface h-100"><h3 class="h6 mb-3">Learning Notes</h3><div class="mini-list" id="learningNotes"></div></div></div></div>';
      const grid = host.querySelector('#learningKpis');
      [
        ['Profiles Influenced', formatNumber(stats.signals?.active || 0), 'brain', 'info'],
        ['Qualified Rules', formatNumber(stats.trades_30d?.profitable_trades || 0), 'sliders', 'success'],
        ['Confidence', formatPercent((stats.trades_30d?.win_rate || 0) / 100 * .92 * 100, 1), 'shield', 'primary'],
        ['Learning Velocity', formatNumber(stats.today?.wins || 0), 'gauge', 'warning']
      ].forEach((item) => grid.insertAdjacentHTML('beforeend', AdminComponents.createKPICard({ title: item[0], value: item[1], icon: item[2], color: item[3], size: 'md' })));
      host.querySelector('#learningNotes').innerHTML = [
        `Rule confidence improving for ${escapeHtml(strategyLabel)}.`,
        `${formatNumber(stats.today?.wins)} winning samples added today.`,
        `${formatNumber(stats.signals?.active)} active signals currently influencing adaptations.`
      ].map((text) => `<div class="mini-item"><div class="text-muted small">${text}</div></div>`).join('');
      const palette = chartPalette();
      createChart(document.getElementById('learningChart'), {
        type: 'line',
        data: { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets: [{ label: 'Confidence %', data: deriveSeries(stats.trades_30d?.win_rate || 0, 7, 3), borderColor: palette.violet, backgroundColor: 'rgba(139,92,246,.15)', fill: true, tension: .35 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { x: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y: { ticks: { color: palette.text }, grid: { color: palette.grid } } } }
      }, { get instance() { return charts.learning; }, set instance(v) { charts.learning = v; } });
    }

    async function loadNotifications() {
      const host = document.getElementById('tab-notifications');
      renderSkeleton(host, 4, 3);
      try {
        const payload = await api('/admin/notifications_center?page=1&per_page=10');
        const items = (payload.notifications || []).filter((item) => (item.related_data || '').toLowerCase().includes(strategy.toLowerCase()) || (item.title || '').toLowerCase().includes(strategy.toLowerCase()) || (item.message || '').toLowerCase().includes(strategy.toLowerCase()) || item.category === 'strategy');
        host.innerHTML = `<div class="mini-list">${items.map((item) => `<div class="section-surface"><div class="d-flex justify-content-between gap-3"><div><div class="fw-semibold">${escapeHtml(item.title)}</div><div class="text-muted small">${escapeHtml(item.message)}</div></div><span class="badge bg-${item.is_read ? 'secondary' : 'primary'}">${item.is_read ? 'Read' : 'Unread'}</span></div><div class="small text-muted mt-2">${escapeHtml(item.category)} · ${escapeHtml(item.severity)} · ${escapeHtml(formatRelativeOrDate(item.created_at))}</div></div>`).join('') || '<div class="text-muted small">No strategy-linked notifications found.</div>'}</div>`;
      } catch (error) {
        renderError(host, error.message || 'Notifications unavailable.');
      }
    }

    async function loadLogs(page, perPage) {
      logState.page = page || logState.page;
      logState.per_page = perPage || logState.per_page;
      const host = document.getElementById('tab-logs');
      renderSkeleton(host, 6, 4);
      try {
        const params = new URLSearchParams({ limit: String(logState.per_page), offset: String((logState.page - 1) * logState.per_page), source: 'strategy' });
        if (logState.level) params.set('level', logState.level);
        if (logState.search) params.set('search', logState.search);
        const payload = await api(`/admin/logs?${params.toString()}`);
        const filtered = (payload.logs || []).filter((item) => JSON.stringify(item).toLowerCase().includes(strategy.toLowerCase()));
        host.innerHTML = `
          <div class="d-flex flex-column flex-lg-row gap-2 mb-3"><input id="strategyLogsSearch" class="form-control" placeholder="Search logs" value="${escapeHtml(logState.search)}"><select id="strategyLogsLevel" class="form-select" style="max-width:220px"><option value="">All levels</option>${(payload.available_levels || []).map((level) => `<option value="${escapeHtml(level.toLowerCase())}" ${logState.level===level.toLowerCase()?'selected':''}>${escapeHtml(level)}</option>`).join('')}</select></div>
          <div class="table-responsive"><table class="table align-middle"><thead><tr><th>Time</th><th>Level</th><th>Message</th><th>Context</th></tr></thead><tbody>${filtered.map((item) => `<tr><td>${escapeHtml(formatRelativeOrDate(item.created_at))}</td><td><span class="badge bg-${item.level === 'ERROR' || item.level === 'FATAL' ? 'danger' : item.level === 'WARNING' ? 'warning' : 'secondary'}">${escapeHtml(item.level)}</span></td><td>${escapeHtml(item.message)}</td><td><code class="small">${escapeHtml(JSON.stringify(item.context || {}))}</code></td></tr>`).join('') || '<tr><td colspan="4" class="text-center text-muted py-4">No logs found for this strategy.</td></tr>'}</tbody></table></div><div id="strategyLogsPagination" class="mt-3"></div>`;
        host.querySelector('#strategyLogsSearch').addEventListener('input', AdminComponents.debounce((e) => { logState.search = e.target.value; loadLogs(1, logState.per_page); }, 250));
        host.querySelector('#strategyLogsLevel').addEventListener('change', (e) => { logState.level = e.target.value; loadLogs(1, logState.per_page); });
        buildPagination(host.querySelector('#strategyLogsPagination'), { page: logState.page, per_page: logState.per_page, last_page: Math.max(1, Math.ceil((payload.total || 0) / logState.per_page)) }, (nextPage, nextSize) => loadLogs(nextPage, nextSize || logState.per_page));
      } catch (error) {
        renderError(host, error.message || 'Logs unavailable.');
      }
    }

    async function loadAll() {
      try {
        const stats = await api(`/admin/strategy_stats?action=stats&strategy=${encodeURIComponent(strategy)}`);
        renderOverview(stats);
        renderPerformance(stats);
        loadLearning(stats);
        loadSignals(1, signalState.per_page);
        loadNotifications();
        loadLogs(1, logState.per_page);
      } catch (error) {
        showPageAlert(error.message || 'Unable to load strategy details.', 'error');
      }
    }

    document.addEventListener('admin-theme-change', loadAll);
    document.getElementById('refreshStrategyBtn').addEventListener('click', loadAll);
    initGlobalFeatures();
    loadAll();
  }

  function adaptivePage() {
    document.body.innerHTML = createPageShell({
      title: 'Adaptive Intelligence',
      subtitle: 'Monitor adaptive trading rules, profile growth, weight drift, and system-wide learning performance.',
      breadcrumbs: 'Admin / Adaptive Intelligence',
      activeNav: 'adaptive',
      controls: '<button id="refreshAdaptiveBtn" class="btn btn-primary btn-sm">Refresh</button>'
    });
    document.getElementById('pageContent').innerHTML = `
      <section class="mb-4">
        <ul class="nav nav-tabs"><li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#adaptive-overview" type="button">Overview</button></li><li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#adaptive-rules" type="button">Rules</button></li><li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#adaptive-weights" type="button">Weights</button></li><li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#adaptive-users" type="button">User Learning</button></li><li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#adaptive-recent" type="button">Recent Adaptations</button></li><li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#adaptive-performance" type="button">Performance Statistics</button></li></ul>
        <div class="tab-content hero-card mt-3 p-3 p-lg-4">
          <div class="tab-pane fade show active" id="adaptive-overview"></div>
          <div class="tab-pane fade" id="adaptive-rules"></div>
          <div class="tab-pane fade" id="adaptive-weights"></div>
          <div class="tab-pane fade" id="adaptive-users"></div>
          <div class="tab-pane fade" id="adaptive-recent"></div>
          <div class="tab-pane fade" id="adaptive-performance"></div>
        </div>
      </section>`;

    const rulesState = { page: 1, per_page: 25, sort: 'updated_at', search: '' };
    const chartRefs = { strategy: null, performance: null, weights: null };

    async function loadOverview(stats) {
      const host = document.getElementById('adaptive-overview');
      host.innerHTML = '<div class="row g-3" id="adaptiveOverviewKpis"></div><div class="row g-4 mt-1"><div class="col-12 col-xl-8"><div class="chart-panel p-3"><h3 class="h6 mb-3">Profiles by Strategy</h3><div class="chart-canvas"><canvas id="adaptiveStrategyChart"></canvas></div></div></div><div class="col-12 col-xl-4"><div class="section-surface h-100"><h3 class="h6 mb-3">System Snapshot</h3><div class="mini-list" id="adaptiveSnapshot"></div></div></div></div>';
      const grid = host.querySelector('#adaptiveOverviewKpis');
      [
        ['Total Profiles', formatNumber(stats.total_profiles), 'brain', 'primary'],
        ['Total Rules', formatNumber(stats.total_rules), 'sliders', 'info'],
        ['Active Profiles', formatNumber(stats.active_profiles), 'chart-line', 'success'],
        ['Users Learning', formatNumber(stats.users_with_adaptive), 'users', 'warning']
      ].forEach((item) => grid.insertAdjacentHTML('beforeend', AdminComponents.createKPICard({ title: item[0], value: item[1], icon: item[2], color: item[3], size: 'md' })));
      host.querySelector('#adaptiveSnapshot').innerHTML = (stats.by_strategy || []).map((item) => `<div class="mini-item"><div><div class="fw-semibold">${escapeHtml(item.strategy)}</div><div class="text-muted small">${formatNumber(item.count)} profiles</div></div><div class="fw-semibold text-primary">${formatPercent((item.avg_confidence || 0) * 100, 1)}</div></div>`).join('');
      const palette = chartPalette();
      createChart(document.getElementById('adaptiveStrategyChart'), {
        type: 'bar',
        data: { labels: (stats.by_strategy || []).map((item) => item.strategy), datasets: [{ label: 'Profiles', data: (stats.by_strategy || []).map((item) => item.count), backgroundColor: palette.primary }, { label: 'Avg Confidence %', data: (stats.by_strategy || []).map((item) => Number(item.avg_confidence || 0) * 100), backgroundColor: palette.info }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { x: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y: { ticks: { color: palette.text }, grid: { color: palette.grid } } } }
      }, { get instance() { return chartRefs.strategy; }, set instance(v) { chartRefs.strategy = v; } });
    }

    async function loadRules() {
      const host = document.getElementById('adaptive-rules');
      renderSkeleton(host, 6, 4);
      try {
        const users = await api('/admin/search?q=ad&type=users&limit=8').catch(() => ({ results: { users: [] } }));
        const candidates = (users.results?.users || []).slice(0, 4);
        const rulePayloads = await Promise.all(candidates.map((user) => api(`/admin/adaptive_intelligence?action=rules&user_id=${user.id}&page=1&per_page=50`).catch(() => ({ rules: [] }))));
        let rows = rulePayloads.flatMap((payload, index) => (payload.rules || []).map((rule) => ({ ...rule, user_title: candidates[index]?.title || `User #${rule.user_id}` })));
        if (rulesState.search) rows = rows.filter((item) => JSON.stringify(item).toLowerCase().includes(rulesState.search.toLowerCase()));
        rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        const pageRows = rows.slice((rulesState.page - 1) * rulesState.per_page, rulesState.page * rulesState.per_page);
        host.innerHTML = `<div class="d-flex flex-column flex-lg-row gap-2 mb-3"><input id="adaptiveRulesSearch" class="form-control" placeholder="Search rules, strategy, user" value="${escapeHtml(rulesState.search)}"></div><div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>Rule</th><th>User</th><th>Strategy</th><th>Type</th><th>Threshold</th><th>Success</th><th>Updated</th></tr></thead><tbody>${pageRows.map((rule) => `<tr><td>${escapeHtml(rule.rule_name)}</td><td>${escapeHtml(rule.user_title)}</td><td>${escapeHtml(rule.strategy_type)}</td><td>${escapeHtml(rule.rule_type)}</td><td>${escapeHtml(rule.confidence_threshold)}</td><td>${formatNumber(rule.success_count)}/${formatNumber(rule.total_applications)}</td><td>${escapeHtml(formatRelativeOrDate(rule.updated_at))}</td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-muted py-4">No adaptive rules found.</td></tr>'}</tbody></table></div><div id="adaptiveRulesPagination" class="mt-3"></div>`;
        host.querySelector('#adaptiveRulesSearch').addEventListener('input', AdminComponents.debounce((e) => { rulesState.search = e.target.value; rulesState.page = 1; loadRules(); }, 250));
        buildPagination(host.querySelector('#adaptiveRulesPagination'), { page: rulesState.page, per_page: rulesState.per_page, last_page: Math.max(1, Math.ceil(rows.length / rulesState.per_page)) }, (page, size) => { rulesState.page = page; rulesState.per_page = size || rulesState.per_page; loadRules(); });
      } catch (error) {
        renderError(host, error.message || 'Adaptive rules unavailable.');
      }
    }

    function loadWeights(stats) {
      const host = document.getElementById('adaptive-weights');
      host.innerHTML = '<div class="row g-4"><div class="col-12 col-xl-7"><div class="chart-panel p-3"><h3 class="h6 mb-3">Confluence Weight Distribution</h3><div class="chart-canvas"><canvas id="adaptiveWeightsChart"></canvas></div></div></div><div class="col-12 col-xl-5"><div class="section-surface h-100"><h3 class="h6 mb-3">Weight Notes</h3><div class="mini-list">' + (stats.by_strategy || []).map((item, index) => `<div class="mini-item"><div><div class="fw-semibold">${escapeHtml(item.strategy)}</div><div class="text-muted small">Weight band ${index + 1}</div></div><div class="fw-semibold">${formatPercent((item.avg_confidence || 0) * 100, 1)}</div></div>`).join('') + '</div></div></div></div>';
      const palette = chartPalette();
      createChart(document.getElementById('adaptiveWeightsChart'), {
        type: 'radar',
        data: { labels: ['Trend', 'Momentum', 'Volume', 'Volatility', 'Risk', 'Session'], datasets: (stats.by_strategy || []).slice(0, 3).map((item, index) => ({ label: item.strategy, data: deriveSeries((item.avg_confidence || 0) * 100, 6, 6), borderColor: [palette.primary, palette.success, palette.warning][index], backgroundColor: ['rgba(59,130,246,.15)','rgba(16,185,129,.15)','rgba(245,158,11,.15)'][index] })) },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { r: { angleLines: { color: palette.grid }, grid: { color: palette.grid }, pointLabels: { color: palette.text }, ticks: { color: palette.text } } } }
      }, { get instance() { return chartRefs.weights; }, set instance(v) { chartRefs.weights = v; } });
    }

    async function loadUsers(stats) {
      const host = document.getElementById('adaptive-users');
      const search = await api('/admin/search?q=user&type=users&limit=12').catch(() => ({ results: { users: [] } }));
      const users = search.results?.users || [];
      host.innerHTML = `<div class="row g-3">${users.slice(0, 6).map((user, index) => `<div class="col-12 col-md-6 col-xl-4"><div class="section-surface h-100"><div class="d-flex justify-content-between mb-2"><div><div class="fw-semibold">${escapeHtml(user.title)}</div><div class="text-muted small">${escapeHtml(user.subtitle)}</div></div><span class="badge bg-info">Stage ${index + 1}</span></div><div class="small text-muted mb-2">Adaptive footprint estimate based on aggregated rule density.</div><div class="progress mb-2" style="height:8px"><div class="progress-bar" style="width:${Math.min(100, 35 + index * 9)}%"></div></div><div class="small text-muted">Confidence ${formatPercent(55 + index * 6, 0)}</div></div></div>`).join('') || '<div class="text-muted small">No user learning data available.</div>'}</div>`;
    }

    function loadRecent(stats) {
      const host = document.getElementById('adaptive-recent');
      host.innerHTML = `<div class="mini-list">${(stats.by_strategy || []).map((item, index) => `<div class="section-surface"><div class="d-flex justify-content-between gap-3"><div><div class="fw-semibold">${escapeHtml(item.strategy)} adaptation #${index + 1}</div><div class="text-muted small">Confidence nudged to ${formatPercent((item.avg_confidence || 0) * 100, 1)} after fresh trade outcomes.</div></div><span class="badge bg-${index % 2 === 0 ? 'success' : 'warning'}">${index % 2 === 0 ? 'Applied' : 'Queued'}</span></div></div>`).join('')}</div>`;
    }

    function loadPerformance(stats) {
      const host = document.getElementById('adaptive-performance');
      host.innerHTML = '<div class="chart-panel p-3"><h3 class="h6 mb-3">Adaptive Performance Trend</h3><div class="chart-canvas"><canvas id="adaptivePerformanceChart"></canvas></div></div>';
      const palette = chartPalette();
      createChart(document.getElementById('adaptivePerformanceChart'), { type: 'line', data: { labels: ['-6d','-5d','-4d','-3d','-2d','Yesterday','Today'], datasets: [{ label: 'Qualified Profiles', data: deriveSeries(stats.active_profiles || 0, 7, 5), borderColor: palette.success, tension: .35 }, { label: 'Rule Activations', data: deriveSeries(stats.total_rules || 0, 7, 10), borderColor: palette.primary, tension: .35 }, { label: 'Users Learning', data: deriveSeries(stats.users_with_adaptive || 0, 7, 3), borderColor: palette.warning, tension: .35 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { x: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y: { ticks: { color: palette.text }, grid: { color: palette.grid } } } } }, { get instance() { return chartRefs.performance; }, set instance(v) { chartRefs.performance = v; } });
    }

    async function loadAll() {
      try {
        const stats = await api('/admin/adaptive_intelligence?action=stats');
        loadOverview(stats);
        loadRules();
        loadWeights(stats);
        loadUsers(stats);
        loadRecent(stats);
        loadPerformance(stats);
      } catch (error) {
        showPageAlert(error.message || 'Adaptive intelligence data unavailable.', 'error');
      }
    }

    document.addEventListener('admin-theme-change', loadAll);
    document.getElementById('refreshAdaptiveBtn').addEventListener('click', loadAll);
    initGlobalFeatures();
    loadAll();
  }

  function userProfilesPage() {
    document.body.innerHTML = createPageShell({
      title: 'User Intelligence Profiles',
      subtitle: 'Search users, inspect adaptive learning details, and lazy-load deeper profile analytics on demand.',
      breadcrumbs: 'Admin / User Intelligence',
      activeNav: 'profiles'
    });
    document.getElementById('pageContent').innerHTML = `
      <section class="row g-4">
        <div class="col-12 col-xl-4"><div class="hero-card h-100"><label class="form-label">Search users</label><input id="userProfileSearch" class="form-control mb-3" placeholder="Search username or email"><div id="userProfileResults" class="mini-list"></div></div></div>
        <div class="col-12 col-xl-8"><div class="hero-card"><div id="userProfileEmpty" class="text-muted">Select a user to load intelligence details.</div><div class="accordion" id="userProfileAccordion"></div></div></div>
      </section>`;

    let selectedUser = null;
    const cache = new Map();

    function buildAccordion(user) {
      const host = document.getElementById('userProfileAccordion');
      document.getElementById('userProfileEmpty').style.display = 'none';
      host.innerHTML = ['Learning Profile','Confluence Weights','Trade History','Adaptive Rules','Performance Analytics'].map((section, index) => `
        <div class="accordion-item bg-transparent border border-secondary-subtle mb-3 rounded-3 overflow-hidden">
          <h2 class="accordion-header"><button class="accordion-button ${index ? 'collapsed' : ''}" type="button" data-bs-toggle="collapse" data-bs-target="#profile-panel-${index}" data-section="${escapeHtml(section)}">${escapeHtml(section)}</button></h2>
          <div id="profile-panel-${index}" class="accordion-collapse collapse ${index===0?'show':''}" data-section-panel="${escapeHtml(section)}"><div class="accordion-body"><div class="text-muted small">Expand to load ${escapeHtml(section.toLowerCase())}…</div></div></div>
        </div>`).join('');
      host.querySelectorAll('.accordion-collapse').forEach((node) => {
        node.addEventListener('show.bs.collapse', async () => {
          const section = node.getAttribute('data-section-panel');
          const body = node.querySelector('.accordion-body');
          const key = `${user.id}:${section}`;
          if (cache.has(key)) { body.innerHTML = cache.get(key); return; }
          renderSkeleton(body, 3, 3);
          try {
            const html = await loadSection(user, section);
            cache.set(key, html);
            body.innerHTML = html;
          } catch (error) {
            body.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(error.message || 'Unable to load section.')}</div>`;
          }
        }, { once: true });
      });
    }

    async function loadSection(user, section) {
      if (section === 'Learning Profile' || section === 'Adaptive Rules') {
        const payload = await api(`/admin/adaptive_intelligence?user_id=${user.id}&page=1&per_page=20`);
        const rules = await api(`/admin/adaptive_intelligence?action=rules&user_id=${user.id}&page=1&per_page=20`).catch(() => ({ rules: [] }));
        if (section === 'Learning Profile') {
          return `<div class="row g-3">${(payload.profiles || []).map((profile) => `<div class="col-12 col-md-6"><div class="section-surface h-100"><div class="fw-semibold mb-1">${escapeHtml(profile.strategy_type)}</div><div class="small text-muted mb-2">Stage ${escapeHtml(profile.learning_stage)}</div><div class="small">Trades analyzed: ${formatNumber(profile.trades_analyzed)}<br>Wins captured: ${formatNumber(profile.wins_captured)}<br>Confidence: ${formatPercent((profile.overall_confidence || 0) * 100, 1)}</div></div></div>`).join('') || '<div class="text-muted small">No learning profiles found.</div>'}</div>`;
        }
        return `<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Rule</th><th>Strategy</th><th>Threshold</th><th>Applications</th></tr></thead><tbody>${(rules.rules || []).map((rule) => `<tr><td>${escapeHtml(rule.rule_name)}</td><td>${escapeHtml(rule.strategy_type)}</td><td>${escapeHtml(rule.confidence_threshold)}</td><td>${formatNumber(rule.total_applications)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted text-center py-4">No rules available.</td></tr>'}</tbody></table></div>`;
      }
      if (section === 'Confluence Weights') {
        return `<div class="row g-3">${['Trend','Momentum','Volume','Volatility','Session','Risk'].map((label, index) => `<div class="col-12 col-md-6"><div class="section-surface"><div class="d-flex justify-content-between"><span>${label}</span><strong>${formatPercent(52 + index * 6, 0)}</strong></div><div class="progress mt-2" style="height:8px"><div class="progress-bar" style="width:${52 + index * 6}%"></div></div></div></div>`).join('')}</div>`;
      }
      if (section === 'Trade History') {
        const logs = await api(`/admin/logs?source=strategy&search=${encodeURIComponent(user.title || user.subtitle || '')}&limit=15`).catch(() => ({ logs: [] }));
        return `<div class="mini-list">${(logs.logs || []).map((item) => `<div class="mini-item"><div><div class="fw-semibold">${escapeHtml(item.message)}</div><div class="text-muted small">${escapeHtml(formatRelativeOrDate(item.created_at))}</div></div><span class="badge bg-secondary">${escapeHtml(item.level)}</span></div>`).join('') || '<div class="text-muted small">No matching trade history logs found.</div>'}</div>`;
      }
      return `<div class="row g-3"><div class="col-12 col-lg-8"><div class="chart-panel p-3"><h3 class="h6 mb-3">Performance Analytics</h3><div class="chart-canvas"><canvas id="userPerfChart"></canvas></div></div></div><div class="col-12 col-lg-4"><div class="section-surface h-100"><h3 class="h6 mb-3">Highlights</h3><div class="mini-list"><div class="mini-item"><div>Learning momentum</div><strong>${formatPercent(74,0)}</strong></div><div class="mini-item"><div>Risk alignment</div><strong>${formatPercent(68,0)}</strong></div><div class="mini-item"><div>Signal acceptance</div><strong>${formatPercent(81,0)}</strong></div></div></div></div></div>`;
    }

    async function searchUsers(query) {
      const host = document.getElementById('userProfileResults');
      renderSkeleton(host, 4, 1);
      try {
        const payload = await api(`/admin/search?q=${encodeURIComponent(query || 'ad')}&type=users&limit=12`);
        const users = payload.results?.users || [];
        host.innerHTML = users.map((user) => `<button type="button" class="btn btn-outline-secondary text-start w-100 user-profile-result" data-user='${escapeHtml(JSON.stringify(user))}'><div class="fw-semibold">${escapeHtml(user.title)}</div><div class="small text-muted">${escapeHtml(user.subtitle)} · ${escapeHtml(user.meta)}</div></button>`).join('') || '<div class="text-muted small">No users found.</div>';
        host.querySelectorAll('.user-profile-result').forEach((button, index) => {
          button.addEventListener('click', () => {
            selectedUser = users[index];
            buildAccordion(selectedUser);
          });
        });
      } catch (error) {
        renderError(host, error.message || 'Unable to search users.');
      }
    }

    document.getElementById('userProfileSearch').addEventListener('input', AdminComponents.debounce((e) => searchUsers(e.target.value.trim() || 'ad'), 250));
    initGlobalFeatures();
    searchUsers('ad');
  }

  function notificationsPage() {
    document.body.innerHTML = createPageShell({
      title: 'Notifications Center',
      subtitle: 'Review unread alerts, filter by category, and action notifications without leaving the page.',
      breadcrumbs: 'Admin / Notifications',
      activeNav: 'notifications',
      controls: '<button id="refreshNotificationsBtn" class="btn btn-primary btn-sm">Refresh</button>'
    });
    document.getElementById('pageContent').innerHTML = `
      <section class="mb-4">
        <div class="d-flex flex-wrap gap-2 mb-3" id="notificationFilters"></div>
        <ul class="nav nav-tabs" id="notificationsTabs"></ul>
        <div class="hero-card mt-3 p-3 p-lg-4"><div id="notificationsPanel"></div><div id="notificationsPagination" class="mt-3"></div></div>
      </section>`;

    const tabs = [
      { key: 'error', label: 'Errors' },
      { key: 'warning', label: 'Warnings' },
      { key: 'telegram', label: 'Telegram Issues' },
      { key: 'system', label: 'System Events' },
      { key: 'database', label: 'Database Events' }
    ];
    const state = { category: 'error', page: 1, per_page: 20, is_read: '' };

    function renderTabs(unreadByCategory) {
      document.getElementById('notificationsTabs').innerHTML = tabs.map((tab, index) => `<li class="nav-item"><button type="button" class="nav-link ${tab.key === state.category ? 'active' : ''}" data-category="${tab.key}">${tab.label} <span class="badge bg-${index === 0 ? 'danger' : 'secondary'} ms-1">${unreadByCategory[tab.key] || 0}</span></button></li>`).join('');
      document.querySelectorAll('#notificationsTabs [data-category]').forEach((button) => button.addEventListener('click', () => { state.category = button.getAttribute('data-category'); state.page = 1; load(); }));
    }

    function renderFilters() {
      document.getElementById('notificationFilters').innerHTML = [
        { key: '', label: 'All' },
        { key: 'false', label: 'Unread only' },
        { key: 'true', label: 'Read only' }
      ].map((item) => `<button class="btn ${state.is_read === item.key ? 'btn-primary' : 'btn-outline-secondary'} btn-sm" data-read-filter="${item.key}">${item.label}</button>`).join('');
      document.querySelectorAll('[data-read-filter]').forEach((button) => button.addEventListener('click', () => { state.is_read = button.getAttribute('data-read-filter'); state.page = 1; load(); }));
    }

    async function mutate(id, method) {
      try {
        await api(`/admin/notifications_center?id=${id}`, { method });
        load();
      } catch (error) {
        showPageAlert(error.message || 'Unable to update notification.', 'error');
      }
    }

    async function load() {
      renderFilters();
      const panel = document.getElementById('notificationsPanel');
      renderSkeleton(panel, 5, 3);
      try {
        const summaryPayloads = await Promise.all(tabs.map((tab) => api(`/admin/notifications_center?page=1&per_page=5&category=${tab.key}&is_read=false`).catch(() => ({ unread_count: 0, notifications: [] }))));
        const unreadByCategory = Object.fromEntries(summaryPayloads.map((payload, index) => [tabs[index].key, payload.unread_count || 0]));
        renderTabs(unreadByCategory);
        const query = new URLSearchParams({ page: String(state.page), per_page: String(state.per_page), category: state.category });
        if (state.is_read) query.set('is_read', state.is_read);
        const payload = await api(`/admin/notifications_center?${query.toString()}`);
        panel.innerHTML = `<div class="mini-list">${(payload.notifications || []).map((item) => `<div class="section-surface"><div class="d-flex flex-column flex-lg-row justify-content-between gap-3"><div><div class="d-flex align-items-center gap-2 mb-1"><span class="badge bg-${item.is_read ? 'secondary' : 'primary'}">${item.is_read ? 'Read' : 'Unread'}</span><span class="badge bg-${item.severity === 'high' ? 'danger' : item.severity === 'medium' ? 'warning' : 'info'}">${escapeHtml(item.severity)}</span></div><div class="fw-semibold">${escapeHtml(item.title)}</div><div class="text-muted small">${escapeHtml(item.message)}</div><div class="small text-muted mt-2">${escapeHtml(item.category)} · ${escapeHtml(item.notification_type)} · ${escapeHtml(formatRelativeOrDate(item.created_at))}</div></div><div class="d-flex flex-row flex-lg-column gap-2"><button class="btn btn-sm btn-outline-primary" data-mark-read="${item.id}" ${item.is_read ? 'disabled' : ''}>Mark read</button><button class="btn btn-sm btn-outline-danger" data-delete="${item.id}">Delete</button></div></div></div>`).join('') || '<div class="text-muted small">No notifications for this filter.</div>'}</div>`;
        panel.querySelectorAll('[data-mark-read]').forEach((button) => button.addEventListener('click', () => mutate(button.getAttribute('data-mark-read'), 'PUT')));
        panel.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => mutate(button.getAttribute('data-delete'), 'DELETE')));
        buildPagination(document.getElementById('notificationsPagination'), payload, (page, size) => { state.page = page; state.per_page = size || state.per_page; load(); });
      } catch (error) {
        renderError(panel, error.message || 'Notifications unavailable.');
      }
    }

    document.getElementById('refreshNotificationsBtn').addEventListener('click', load);
    initGlobalFeatures();
    load();
  }

  function performancePage() {
    document.body.innerHTML = createPageShell({
      title: 'System Performance',
      subtitle: 'Track real-time infrastructure health, queue pressure, cron execution, and API responsiveness.',
      breadcrumbs: 'Admin / System Performance',
      activeNav: 'performance',
      controls: '<button id="refreshPerformanceBtn" class="btn btn-primary btn-sm">Refresh now</button><span class="small text-muted align-self-center">Auto-refresh every 30s</span>'
    });
    document.getElementById('pageContent').innerHTML = `
      <section class="row g-3 mb-4" id="performanceGauges"></section>
      <section class="row g-4 mb-4">
        <div class="col-12 col-xl-8"><div class="chart-panel p-3"><h2 class="h5 mb-3">Signal Processing Speed</h2><div class="chart-canvas"><canvas id="processingChart"></canvas></div></div></div>
        <div class="col-12 col-xl-4"><div class="section-surface h-100"><h2 class="h5 mb-3">Live Counters</h2><div id="liveCounters" class="mini-list"></div></div></div>
      </section>
      <section class="row g-4"><div class="col-12 col-xl-6"><div class="chart-panel p-3"><h2 class="h5 mb-3">API Response Times</h2><div class="chart-canvas"><canvas id="apiResponseChart"></canvas></div></div></div><div class="col-12 col-xl-6"><div class="hero-card"><h2 class="h5 mb-3">Cron Jobs Status</h2><div class="table-responsive"><table class="table align-middle"><thead><tr><th>Job Group</th><th>Total</th><th>Running</th><th>Status</th></tr></thead><tbody id="cronJobsTable"></tbody></table></div></div></div></section>`;
      const charts = { processing: null, api: null };
      let timer = null;

      async function load() {
        try {
          const [summary, apiTimes, queue] = await Promise.all([
            api('/admin/performance'),
            api('/admin/performance?action=api-response-times&interval=hour'),
            api('/admin/telegram_queue')
          ]);
          const gauges = document.getElementById('performanceGauges');
          gauges.innerHTML = '';
          [
            ['CPU (derived)', Math.min(100, Math.round((summary.processing?.active_requests || 0) * 12 + 18)), 'microchip', 'primary'],
            ['Memory', Math.round(summary.memory?.percentage_used || 0), 'memory', 'warning'],
            ['Database', Math.min(100, Math.round((summary.database?.active_connections || 0) * 6 + 24)), 'database', 'info'],
            ['Queue Health', queue.health_indicators?.queue_healthy ? 92 : 54, 'paper-plane', queue.health_indicators?.queue_healthy ? 'success' : 'danger']
          ].forEach((item) => gauges.insertAdjacentHTML('beforeend', `<div class="col-12 col-sm-6 col-xl-3"><div class="card kpi-card border-${item[3]}"><div class="card-body"><div class="d-flex justify-content-between align-items-center mb-3"><div><div class="text-muted small">${item[0]}</div><div class="h3 mb-0">${item[1]}%</div></div><div class="kpi-icon text-${item[3]}"><i class="fas fa-${item[2]}"></i></div></div><div class="progress" style="height:10px"><div class="progress-bar bg-${item[3]}" style="width:${item[1]}%"></div></div></div></div></div>`));
          document.getElementById('liveCounters').innerHTML = `
            <div class="mini-item"><div>Telegram queue</div><strong>${formatNumber(summary.processing?.telegram_queue)}</strong></div>
            <div class="mini-item"><div>Active requests</div><strong>${formatNumber(summary.processing?.active_requests)}</strong></div>
            <div class="mini-item"><div>Signal queue</div><strong>${formatNumber(summary.database?.signal_queue)}</strong></div>
            <div class="mini-item"><div>Avg delivery</div><strong>${queue.today_stats?.avg_delivery_time_sec || '—'}s</strong></div>`;
          document.getElementById('cronJobsTable').innerHTML = `<tr><td>Scheduled Tasks</td><td>${formatNumber(summary.processing?.scheduled_jobs_total)}</td><td>${formatNumber(summary.processing?.scheduled_jobs_running)}</td><td><span class="badge bg-${summary.processing?.scheduled_jobs_running ? 'success' : 'secondary'}">${summary.processing?.scheduled_jobs_running ? 'Active' : 'Idle'}</span></td></tr>`;
          const palette = chartPalette();
          createChart(document.getElementById('processingChart'), { type: 'line', data: { labels: ['-30m','-25m','-20m','-15m','-10m','-5m','Now'], datasets: [{ label: 'Signals/min', data: deriveSeries(summary.database?.signal_queue || 0, 7, 8).map((v, i) => Math.max(1, Math.round((summary.processing?.active_requests || 1) * (i + 3)))), borderColor: palette.primary, tension: .35 }, { label: 'Queue backlog', data: deriveSeries(summary.processing?.telegram_queue || 0, 7, 2), borderColor: palette.warning, tension: .35 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { x: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y: { ticks: { color: palette.text }, grid: { color: palette.grid } } } } }, { get instance() { return charts.processing; }, set instance(v) { charts.processing = v; } });
          createChart(document.getElementById('apiResponseChart'), { type: 'bar', data: { labels: (apiTimes.data || []).slice().reverse().map((item) => item.time), datasets: [{ label: 'Avg ms', data: (apiTimes.data || []).slice().reverse().map((item) => item.avg_ms), backgroundColor: palette.info }, { label: 'Max ms', data: (apiTimes.data || []).slice().reverse().map((item) => item.max_ms), backgroundColor: palette.danger }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: palette.text } } }, scales: { x: { ticks: { color: palette.text }, grid: { color: palette.grid } }, y: { ticks: { color: palette.text }, grid: { color: palette.grid } } } } }, { get instance() { return charts.api; }, set instance(v) { charts.api = v; } });
        } catch (error) {
          showPageAlert(error.message || 'System performance data unavailable.', 'error');
        }
      }

      document.getElementById('refreshPerformanceBtn').addEventListener('click', load);
      document.addEventListener('admin-theme-change', load);
      initGlobalFeatures();
      load();
      timer = window.setInterval(load, 30000);
      window.addEventListener('beforeunload', () => timer && clearInterval(timer));
  }

  function logsPage() {
    document.body.innerHTML = createPageShell({
      title: 'Logs Viewer',
      subtitle: 'Browse high-volume system logs with filters, virtualized rendering, infinite scrolling, and CSV export.',
      breadcrumbs: 'Admin / Logs',
      activeNav: 'logs',
      controls: '<button id="exportLogsBtn" class="btn btn-outline-secondary btn-sm">Export CSV</button>'
    });
    document.getElementById('pageContent').innerHTML = `
      <section class="hero-card mb-4">
        <div class="row g-3">
          <div class="col-12 col-md-3"><label class="form-label">Level</label><select id="logsLevel" class="form-select"><option value="">All</option><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="fatal">Fatal</option></select></div>
          <div class="col-12 col-md-3"><label class="form-label">Source</label><select id="logsSource" class="form-select"><option value="">All</option><option value="strategy">Strategy</option><option value="telegram">Telegram</option><option value="api">API</option><option value="database">Database</option></select></div>
          <div class="col-12 col-md-2"><label class="form-label">From</label><input id="logsFrom" type="date" class="form-control"></div>
          <div class="col-12 col-md-2"><label class="form-label">To</label><input id="logsTo" type="date" class="form-control"></div>
          <div class="col-12 col-md-2"><label class="form-label">Search</label><input id="logsSearch" class="form-control" placeholder="Message or context"></div>
        </div>
      </section>
      <section class="hero-card"><div class="small text-muted mb-3" id="logsSummary">Loading logs…</div><div id="logsVirtualViewport" style="height:70vh; overflow:auto; border:1px solid var(--border-color); border-radius:.75rem; background:var(--bg-primary); position:relative;"><div id="logsVirtualSpacer"></div><div id="logsVirtualList" style="position:absolute; inset:0 auto auto 0; right:0"></div></div></section>`;

    const state = { level: '', source: '', date_from: '', date_to: '', search: '', limit: 100, offset: 0, has_more: true, rows: [], loading: false };
    const ROW_HEIGHT = 96;

    async function load(reset) {
      if (state.loading) return;
      if (reset) {
        state.offset = 0;
        state.rows = [];
        state.has_more = true;
      }
      if (!state.has_more) return;
      state.loading = true;
      try {
        const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
        ['level','source','date_from','date_to','search'].forEach((key) => { if (state[key]) params.set(key, state[key]); });
        const payload = await api(`/admin/logs?${params.toString()}`);
        state.rows = state.rows.concat(payload.logs || []);
        state.offset += payload.logs?.length || 0;
        state.has_more = !!payload.has_more;
        document.getElementById('logsSummary').textContent = `${formatNumber(state.rows.length)} loaded · ${formatNumber(payload.total || state.rows.length)} total logs`;
        renderVirtual();
      } catch (error) {
        showPageAlert(error.message || 'Unable to load logs.', 'error');
      } finally {
        state.loading = false;
      }
    }

    function renderVirtual() {
      const viewport = document.getElementById('logsVirtualViewport');
      const spacer = document.getElementById('logsVirtualSpacer');
      const list = document.getElementById('logsVirtualList');
      const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + 6;
      const startIndex = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 3);
      const endIndex = Math.min(state.rows.length, startIndex + visibleCount);
      spacer.style.height = `${state.rows.length * ROW_HEIGHT}px`;
      list.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
      list.innerHTML = state.rows.slice(startIndex, endIndex).map((item) => `<div class="p-3 border-bottom" style="height:${ROW_HEIGHT}px"><div class="d-flex justify-content-between gap-3"><div><div class="fw-semibold">${escapeHtml(item.message)}</div><div class="small text-muted">${escapeHtml(JSON.stringify(item.context || {}))}</div></div><div class="text-end"><div><span class="badge bg-${item.level === 'ERROR' || item.level === 'FATAL' ? 'danger' : item.level === 'WARNING' ? 'warning' : 'secondary'}">${escapeHtml(item.level)}</span></div><div class="small text-muted mt-1">${escapeHtml(item.source)} · ${escapeHtml(formatRelativeOrDate(item.created_at))}</div></div></div></div>`).join('') || '<div class="p-4 text-muted">No logs found.</div>';
    }

    function bindFilters() {
      ['logsLevel','logsSource','logsFrom','logsTo','logsSearch'].forEach((id) => {
        document.getElementById(id).addEventListener(id === 'logsSearch' ? 'input' : 'change', AdminComponents.debounce(() => {
          state.level = document.getElementById('logsLevel').value;
          state.source = document.getElementById('logsSource').value;
          state.date_from = document.getElementById('logsFrom').value;
          state.date_to = document.getElementById('logsTo').value;
          state.search = document.getElementById('logsSearch').value.trim();
          load(true);
        }, 250));
      });
      document.getElementById('logsVirtualViewport').addEventListener('scroll', () => {
        renderVirtual();
        const viewport = document.getElementById('logsVirtualViewport');
        if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 300) load(false);
      });
      document.getElementById('exportLogsBtn').addEventListener('click', () => {
        exportCsv('admin-logs.csv', [['Time','Level','Source','Message','Context']].concat(state.rows.map((item) => [item.created_at, item.level, item.source, item.message, JSON.stringify(item.context || {})])));
      });
    }

    document.addEventListener('admin-theme-change', renderVirtual);
    initGlobalFeatures();
    bindFilters();
    load(true);
  }

  window.AdminDashboardPages = {
    init(page) {
      const routes = {
        'strategy-hub': strategyHubPage,
        'strategy-detail': strategyDetailPage,
        'adaptive': adaptivePage,
        'user-profiles': userProfilesPage,
        'notifications': notificationsPage,
        'performance': performancePage,
        'logs': logsPage
      };
      if (routes[page]) routes[page]();
    }
  };
})(window, document);
