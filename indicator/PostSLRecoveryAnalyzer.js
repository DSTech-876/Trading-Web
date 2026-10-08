/**
 * PostSLRecoveryAnalyzer.js
 * ─────────────────────────
 * Strategy-agnostic analysis of every trade that closes at STOP_LOSS using
 * three parallel scenarios:
 *   A - ORIGINAL TRADE CONTINUES: does the original TP get reached after SL?
 *   B - OPPOSITE TRADE AFTER SL: same lot/TP/SL distances, opposite direction.
 *   C - RE-ENTRY AFTER CONFIRMATION: re-enter original direction once a
 *       configurable confirmation appears.
 * Each loss is classified (EARLY_ENTRY, WRONG_DIRECTION,
 * EARLY_ENTRY_REENTRY_SUCCESS, HIGH_VOLATILITY_STOP, VALID_LOSS,
 * MISSED_REVERSAL) and aggregated per strategy, with optimisation
 * recommendations, alerts and a dashboard renderer.
 */
(function (root) {
  'use strict';

  const WINDOW_CANDLES = 100;
  const HISTORY_CANDLES = 30;
  const MAX_RECORDS = 500;
  const THRESHOLD = 60; /* % above which a recommendation / alert triggers */
  /* How to resolve a candle that touches both SL and TP:
     sl_first (pessimistic), tp_first (optimistic), candle_shape (bullish candle
     assumed low-first, bearish high-first) */
  const SAME_CANDLE_RULES = ['sl_first', 'tp_first', 'candle_shape'];
  const STORAGE_KEY = 'itguru_post_sl_recovery_v1';
  const CONFIRM_MODES = ['candle_close', 'break_prev_extreme', 'trend', 'momentum', 'ma_alignment'];
  const CLASSES = ['EARLY_ENTRY', 'WRONG_DIRECTION', 'EARLY_ENTRY_REENTRY_SUCCESS',
    'HIGH_VOLATILITY_STOP', 'VALID_LOSS', 'MISSED_REVERSAL'];

  function sma(arr, n) {
    if (arr.length < n) return null;
    let s = 0;
    for (let i = arr.length - n; i < arr.length; i++) s += arr[i].close;
    return s / n;
  }

  /** Returns true when candle c (last of buf) confirms `dir` under the given mode. */
  function isConfirmed(mode, dir, buf) {
    const c = buf[buf.length - 1], p = buf[buf.length - 2];
    if (!c || !p) return false;
    const bull = dir === 'BULL';
    const dirCandle = bull ? c.close > c.open : c.close < c.open;
    switch (mode) {
      case 'break_prev_extreme':
        return bull ? c.close > p.high : c.close < p.low;
      case 'trend': {
        const p2 = buf[buf.length - 3];
        if (!p2) return false;
        return bull ? (c.close > p.close && p.close > p2.close) : (c.close < p.close && p.close < p2.close);
      }
      case 'momentum': {
        const range = c.high - c.low, body = Math.abs(c.close - c.open);
        return dirCandle && range > 0 && body / range >= 0.6;
      }
      case 'ma_alignment': {
        const fast = sma(buf, 5), slow = sma(buf, 10);
        if (fast === null || slow === null) return false;
        return bull ? (c.close > fast && fast > slow) : (c.close < fast && fast < slow);
      }
      case 'candle_close':
      default:
        return dirCandle;
    }
  }

  /** Pure classification of a completed record. */
  function classify(r) {
    const a = r.scenarioA, b = r.scenarioB, c = r.scenarioC;
    const range = Math.abs(r.tp - r.sl);
    if (a.eventual_tp_reached && b.tp_hit) return 'HIGH_VOLATILITY_STOP';
    if (c.tp_hit && !c.sl_hit) return 'EARLY_ENTRY_REENTRY_SUCCESS';
    if (a.eventual_tp_reached) return 'EARLY_ENTRY';
    if (b.tp_hit) return 'WRONG_DIRECTION';
    if (range > 0 && a.max_recovery >= 0.5 * range) return 'MISSED_REVERSAL';
    return 'VALID_LOSS';
  }

  function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }

  class PostSLRecoveryAnalyzer {
    constructor(options = {}) {
      this.windowCandles = options.windowCandles || WINDOW_CANDLES;
      this.confirmMode = CONFIRM_MODES.indexOf(options.confirmMode) >= 0 ? options.confirmMode : 'candle_close';
      this.threshold = Number.isFinite(options.threshold) ? options.threshold : THRESHOLD;
      this.sameCandleRule = SAME_CANDLE_RULES.indexOf(options.sameCandleRule) >= 0 ? options.sameCandleRule : 'sl_first';
      this.persist = options.persist !== false;
      this.serverSync = options.serverSync !== undefined ? !!options.serverSync : this.persist;
      this.onChange = options.onChange || null;
      this.watches = new Map();
      this.records = [];
      this._load();
    }

    setSameCandleRule(rule) {
      if (SAME_CANDLE_RULES.indexOf(rule) >= 0) this.sameCandleRule = rule;
    }

    setWindowCandles(n) {
      n = Math.floor(Number(n));
      if (n >= 1 && n <= 5000) this.windowCandles = n;
    }

    /** Register a historical loss and replay already-known candles after its SL. */
    backfill(trade, closeEpoch, allCandles, symbol) {
      const w = this.register(trade, closeEpoch, allCandles);
      if (!w || !Array.isArray(allCandles)) return w;
      for (const c of allCandles) {
        if (w.done || !c || !(Number(c.epoch) > Number(closeEpoch))) continue;
        this.onCandle(c, symbol);
      }
      return w;
    }

    setConfirmMode(mode) {
      if (CONFIRM_MODES.indexOf(mode) >= 0) this.confirmMode = mode;
    }

    _load() {
      if (!this.persist) return;
      try {
        const raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) this.records = arr.slice(-MAX_RECORDS);
      } catch (e) { /* ignore corrupt storage */ }
    }

    _save() {
      if (!this.persist) return;
      try { root.localStorage && root.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records.slice(-MAX_RECORDS))); }
      catch (e) { /* storage unavailable */ }
    }

    /**
     * @param {Object} trade { tradeId|signalId, type|strategy, symbol, dir:'BULL'|'BEAR', entry, sl, tp, lotSize }
     * @param {number} closeEpoch seconds at which SL was hit
     * @param {Array} [pastCandles] recent candles (used for MA/trend context only)
     */
    register(trade, closeEpoch, pastCandles) {
      if (!trade || !(trade.dir === 'BULL' || trade.dir === 'BEAR')) return null;
      const entry = Number(trade.entry), sl = Number(trade.sl), tp = Number(trade.tp);
      if (![entry, sl, tp].every(Number.isFinite) || !Number.isFinite(Number(closeEpoch))) return null;
      const slDist = Math.abs(entry - sl), tpDist = Math.abs(tp - entry);
      if (!(slDist > 0) || !(tpDist > 0)) return null;
      const id = String(trade.tradeId || trade.signalId || '');
      if (!id || this.watches.has(id) || this.records.some(r => r.trade_id === id)) return null;

      const bull = trade.dir === 'BULL';
      const oppDir = bull ? 'BEAR' : 'BULL';
      /* Scenario B enters at the SL level (where the original trade closed) */
      const oppEntry = sl;
      const w = {
        trade_id: id,
        signal_id: trade.signalId || null,
        strategy: String(trade.type || trade.strategy || trade.strategyName || 'unknown'),
        symbol: trade.symbol || '',
        direction: trade.dir,
        entry, sl, tp, slDist, tpDist,
        lot_size: Number.isFinite(Number(trade.lotSize)) ? Number(trade.lotSize)
          : (Number.isFinite(Number(trade.lot)) ? Number(trade.lot) : null),
        sl_hit_time: Number(closeEpoch),
        confirm_mode: this.confirmMode,
        buf: Array.isArray(pastCandles)
          ? pastCandles.filter(c => c && Number(c.epoch) <= Number(closeEpoch)).slice(-HISTORY_CANDLES) : [],
        candlesAfter: 0,
        scenarioA: { eventual_tp_reached: false, minutes_to_tp_after_sl: null, max_favorable_move: 0,
          max_recovery: 0, distance_beyond_tp: 0 },
        scenarioB: { dir: oppDir, entry_time: Number(closeEpoch), entry_price: oppEntry,
          sl: bull ? oppEntry + slDist : oppEntry - slDist,
          tp: bull ? oppEntry - tpDist : oppEntry + tpDist,
          tp_hit: false, sl_hit: false, profit_potential: 0, time_to_tp: null, done: false },
        scenarioC: { confirmed: false, confirmation_time: null, confirmation_price: null,
          sl: null, tp: null, tp_hit: false, sl_hit: false, profit_potential: 0, time_to_tp: null, done: false },
        done: false
      };
      this.watches.set(id, w);
      return w;
    }

    onCandle(c, symbol) {
      if (!c || !Number.isFinite(Number(c.high)) || !Number.isFinite(Number(c.low))) return;
      const sym = symbol || c.symbol || null;
      for (const w of Array.from(this.watches.values())) {
        if (w.done || !(Number(c.epoch) > w.sl_hit_time)) continue;
        if (sym && w.symbol && w.symbol !== sym) continue;
        w.candlesAfter++;
        this._feedA(w, c);
        this._feedB(w, c);
        this._feedC(w, c);
        w.buf.push(c);
        if (w.buf.length > HISTORY_CANDLES) w.buf.shift();
        if (w.candlesAfter >= this.windowCandles) this._complete(w);
      }
    }

    _feedA(w, c) {
      const a = w.scenarioA, bull = w.direction === 'BULL';
      const fav = bull ? c.high - w.sl : w.sl - c.low;
      a.max_recovery = Math.max(a.max_recovery, fav);
      a.max_favorable_move = a.max_recovery;
      const hit = bull ? c.high >= w.tp : c.low <= w.tp;
      if (hit && !a.eventual_tp_reached) {
        a.eventual_tp_reached = true;
        a.minutes_to_tp_after_sl = Math.max(0, (Number(c.epoch) - w.sl_hit_time) / 60);
      }
      if (a.eventual_tp_reached) {
        a.distance_beyond_tp = Math.max(a.distance_beyond_tp, Math.max(0, bull ? c.high - w.tp : w.tp - c.low));
      }
    }

    /** Shared simulated-trade stepper; SL counts first when both are inside one candle. */
    _step(s, dir, entryPrice, entryTime, c) {
      const bull = dir === 'BULL';
      const fav = bull ? c.high - entryPrice : entryPrice - c.low;
      s.profit_potential = Math.max(s.profit_potential, Math.max(0, fav));
      const slHit = bull ? c.low <= s.sl : c.high >= s.sl;
      const tpHit = bull ? c.high >= s.tp : c.low <= s.tp;
      let slFirst = true;
      if (slHit && tpHit) {
        if (this.sameCandleRule === 'tp_first') slFirst = false;
        else if (this.sameCandleRule === 'candle_shape') {
          const candleBull = Number(c.close) >= Number(c.open);
          slFirst = bull ? candleBull : !candleBull;
        }
      }
      if (slHit && slFirst) { s.sl_hit = true; s.done = true; }
      else if (tpHit) {
        s.tp_hit = true; s.done = true;
        s.time_to_tp = Math.max(0, (Number(c.epoch) - entryTime) / 60);
      }
    }

    _feedB(w, c) {
      const b = w.scenarioB;
      if (!b.done) this._step(b, b.dir, b.entry_price, b.entry_time, c);
    }

    _feedC(w, c) {
      const s = w.scenarioC;
      if (s.done) return;
      if (s.confirmed) { this._step(s, w.direction, s.confirmation_price, s.confirmation_time, c); return; }
      const buf = w.buf.concat([c]);
      if (isConfirmed(w.confirm_mode, w.direction, buf)) {
        const bull = w.direction === 'BULL';
        s.confirmed = true;
        s.confirmation_time = Number(c.epoch);
        s.confirmation_price = Number(c.close);
        s.sl = bull ? s.confirmation_price - w.slDist : s.confirmation_price + w.slDist;
        s.tp = bull ? s.confirmation_price + w.tpDist : s.confirmation_price - w.tpDist;
      }
    }

    _complete(w) {
      w.done = true;
      this.watches.delete(w.trade_id);
      const rec = {
        trade_id: w.trade_id, signal_id: w.signal_id, strategy: w.strategy, symbol: w.symbol,
        direction: w.direction, entry: w.entry, sl: w.sl, tp: w.tp, lot_size: w.lot_size,
        sl_hit_time: w.sl_hit_time, confirm_mode: w.confirm_mode,
        scenarioA: w.scenarioA, scenarioB: w.scenarioB, scenarioC: w.scenarioC
      };
      rec.classification = classify(rec);
      this.records.push(rec);
      if (this.records.length > MAX_RECORDS) this.records.shift();
      this._save();
      this._sync(rec);
      if (typeof this.onChange === 'function') { try { this.onChange(rec); } catch (e) { /* ignore */ } }
      return rec;
    }

    _getAuthToken() {
      if (typeof ITGuruAuth !== 'undefined' && ITGuruAuth && typeof ITGuruAuth.getToken === 'function') {
        return ITGuruAuth.getToken() || '';
      }
      try { return sessionStorage.getItem('itguru_auth_token') || ''; } catch (e) { return ''; }
    }

    /** Persist a completed record server-side (best effort; local copy is kept regardless). */
    async _sync(rec) {
      if (!this.serverSync || typeof fetch !== 'function') return null;
      const token = this._getAuthToken();
      if (!token) return null;
      try {
        const r = await fetch('/api/trades/post_sl_recovery', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(rec)
        });
        return r.ok ? r.json() : null;
      } catch (e) { return null; }
    }

    /** Fetch server-side per-strategy stats (all devices / sessions). */
    async fetchServerStats() {
      if (typeof fetch !== 'function') return [];
      try {
        const r = await fetch('/api/trades/post_sl_recovery', {
          headers: { 'Authorization': 'Bearer ' + this._getAuthToken() }
        });
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data.stats) ? data.stats : [];
      } catch (e) { return []; }
    }

    /** Force-complete all in-flight watches (e.g. for tests or shutdown). */
    flush() { Array.from(this.watches.values()).forEach(w => this._complete(w)); }

    /** Per-strategy aggregates. */
    getStats() {
      const by = {};
      for (const r of this.records) {
        const s = by[r.strategy] || (by[r.strategy] = {
          strategy: r.strategy, losses: 0, a: 0, b: 0, c: 0, recMin: [], recDist: [], classes: {}
        });
        s.losses++;
        if (r.scenarioA.eventual_tp_reached) {
          s.a++;
          s.recMin.push(r.scenarioA.minutes_to_tp_after_sl);
          s.recDist.push(r.scenarioA.max_favorable_move);
        }
        if (r.scenarioB.tp_hit) s.b++;
        if (r.scenarioC.tp_hit) s.c++;
        s.classes[r.classification] = (s.classes[r.classification] || 0) + 1;
      }
      const avg = arr => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
      return Object.values(by).map(s => ({
        strategy: s.strategy,
        total_losses: s.losses,
        scenario_a_pct: pct(s.a, s.losses),
        scenario_b_pct: pct(s.b, s.losses),
        scenario_c_pct: pct(s.c, s.losses),
        avg_recovery_minutes: avg(s.recMin),
        avg_recovery_distance: avg(s.recDist),
        classifications: s.classes
      })).sort((x, y) => y.total_losses - x.total_losses);
    }

    getRecommendations() {
      const out = {};
      for (const s of this.getStats()) {
        const rec = [];
        if (s.scenario_a_pct > this.threshold) rec.push('Delay entry', 'Candle close confirmation', 'Retest confirmation', 'Wider stop');
        if (s.scenario_b_pct > this.threshold) rec.push('Reverse entry logic', 'Stronger trend filter', 'Avoid counter-trend setups');
        if (s.scenario_c_pct > this.threshold) rec.push('Introduce re-entry logic', 'Add confirmation-based entry model');
        if (rec.length) out[s.strategy] = rec;
      }
      return out;
    }

    getAlerts() {
      const alerts = [];
      for (const s of this.getStats()) {
        if (s.scenario_a_pct > this.threshold) alerts.push(`${s.strategy} losses reached original TP after SL ${Math.round(s.scenario_a_pct)}% of the time. Entry timing likely too aggressive.`);
        if (s.scenario_b_pct > this.threshold) alerts.push(`${s.strategy} opposite trades succeeded ${Math.round(s.scenario_b_pct)}% of the time. Directional bias may be incorrect.`);
        if (s.scenario_c_pct > this.threshold) alerts.push(`${s.strategy} re-entry trades succeeded ${Math.round(s.scenario_c_pct)}% of the time. Confirmation-based entry recommended.`);
      }
      return alerts;
    }

    /** Full analytics report. */
    getReport() {
      return { stats: this.getStats(), recommendations: this.getRecommendations(),
        alerts: this.getAlerts(), records: this.records.slice() };
    }

    /** Render "📊 Trade Recovery Analytics" into a DOM element. */
    renderDashboard(el) {
      if (!el) return;
      const esc = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      const stats = this.getStats();
      const f = (v, d) => (v === null || v === undefined) ? '–' : Number(v).toFixed(d);
      let html = '<p class="param-group-title">📊 Trade Recovery Analytics</p>';
      if (!stats.length) {
        html += '<p class="hint">No stop-loss trades analysed yet.</p>';
      } else {
        html += '<table style="width:100%;font-size:0.75em;border-collapse:collapse;"><thead><tr>'
          + '<th>Strategy</th><th>Losses</th><th title="Original TP reached after SL">Scen. A %</th>'
          + '<th title="Opposite trade wins">Scen. B %</th><th title="Re-entry wins">Scen. C %</th>'
          + '<th>Avg Recovery (min)</th><th>Avg Recovery Dist</th></tr></thead><tbody>';
        for (const s of stats) {
          html += `<tr><td>${esc(s.strategy)}</td><td>${s.total_losses}</td><td>${s.scenario_a_pct}%</td>`
            + `<td>${s.scenario_b_pct}%</td><td>${s.scenario_c_pct}%</td>`
            + `<td>${f(s.avg_recovery_minutes, 1)}</td><td>${f(s.avg_recovery_distance, 4)}</td></tr>`;
        }
        html += '</tbody></table>';
        const recs = this.getRecommendations();
        for (const k of Object.keys(recs)) html += `<p class="hint"><b>${esc(k)}</b>: ${esc(recs[k].join(', '))}</p>`;
        for (const a of this.getAlerts()) html += `<p class="hint">⚠ ${esc(a)}</p>`;
      }
      el.innerHTML = html;
    }
  }

  PostSLRecoveryAnalyzer.CONFIRM_MODES = CONFIRM_MODES;
  PostSLRecoveryAnalyzer.CLASSES = CLASSES;
  root.PostSLRecoveryAnalyzer = PostSLRecoveryAnalyzer;
  if (typeof window !== 'undefined' && !root.postSLRecoveryAnalyzer) root.postSLRecoveryAnalyzer = new PostSLRecoveryAnalyzer();
  if (typeof module !== 'undefined' && module.exports) module.exports = { PostSLRecoveryAnalyzer, SAME_CANDLE_RULES, classify, isConfirmed, CONFIRM_MODES };
})(typeof window !== 'undefined' ? window : globalThis);
