/**
 * OppositeTradeTracker.js
 * ───────────────────────
 * Strategy-agnostic tracker for stop-loss trades. For every trade closed at
 * STOP_LOSS it:
 *   1. simulates a virtual opposite trade (same entry, SL distance, TP distance, lot size),
 *   2. keeps following the original direction to see whether the original TP is
 *      reached after the SL ("early entry" detection),
 *   3. reports results to /api/trades/opposite_tracking where the trade is
 *      classified (EARLY_ENTRY / WRONG_DIRECTION / HIGH_VOLATILITY_STOP /
 *      VALID_LOSS / MISSED_REVERSAL).
 * It also fetches signal-improvement advice derived from the historical data.
 */
(function (root) {
  'use strict';

  const WINDOW_CANDLES = 100; /* monitoring window after the SL close */

  function pipSizeFor(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (/^FRX[A-Z]{6}$/.test(s) || /^[A-Z]{6}$/.test(s)) return s.endsWith('JPY') ? 0.01 : 0.0001;
    return 1;
  }

  class OppositeTradeTracker {
    constructor(options = {}) {
      this.windowCandles = options.windowCandles || WINDOW_CANDLES;
      this.watches = new Map();
      this.advice = {};
      this.onSend = options.onSend || null; /* (payload) => Promise, overridable for tests */
    }

    _getAuthToken() {
      if (typeof ITGuruAuth !== 'undefined' && ITGuruAuth && typeof ITGuruAuth.getToken === 'function') {
        return ITGuruAuth.getToken() || '';
      }
      try { return sessionStorage.getItem('itguru_auth_token') || ''; } catch (e) { return ''; }
    }

    /**
     * Start tracking a trade that closed at stop loss.
     * @param {Object} trade  { tradeId|signalId, signalId, type|strategy, symbol, dir, entry, sl, tp, epoch, lotSize }
     * @param {number} closeEpoch  seconds, when the SL was hit
     * @param {Array}  [pastCandles]  candles used to replay entry→close for the opposite trade
     */
    register(trade, closeEpoch, pastCandles) {
      if (!trade || !(trade.dir === 'BULL' || trade.dir === 'BEAR')) return null;
      const entry = Number(trade.entry), sl = Number(trade.sl), tp = Number(trade.tp);
      if (![entry, sl, tp].every(Number.isFinite)) return null;
      const slDist = Math.abs(entry - sl), tpDist = Math.abs(tp - entry);
      if (!(slDist > 0) || !(tpDist > 0)) return null;
      const id = String(trade.tradeId || trade.signalId || '');
      if (!id || this.watches.has(id)) return null;

      const w = {
        trade_id: id,
        signal_id: trade.signalId || null,
        strategy: String(trade.type || trade.strategy || trade.strategyName || 'unknown'),
        symbol: trade.symbol || '',
        direction: trade.dir,
        entry, sl, tp, slDist, tpDist,
        lot_size: Number.isFinite(Number(trade.lotSize)) ? Number(trade.lotSize) : (Number.isFinite(Number(trade.lot)) ? Number(trade.lot) : null),
        close_reason: 'STOP_LOSS',
        close_epoch: Number(closeEpoch),
        entry_epoch: Number.isFinite(Number(trade.epoch)) ? Number(trade.epoch) : Number(closeEpoch),
        /* virtual opposite trade */
        opp: {
          dir: trade.dir === 'BULL' ? 'BEAR' : 'BULL',
          sl: trade.dir === 'BULL' ? entry + slDist : entry - slDist,
          tp: trade.dir === 'BULL' ? entry - tpDist : entry + tpDist,
          hitTp: false, hitSl: false, mfe: 0, mae: 0, timeToTp: null, timeToSl: null, done: false
        },
        /* original direction after SL */
        orig: { reachedTp: false, minutesAfterSl: null, beyondTp: 0, recovery: 0 },
        candlesAfter: 0,
        done: false
      };
      this.watches.set(id, w);

      if (Array.isArray(pastCandles)) {
        for (const c of pastCandles) {
          if (c && Number(c.epoch) >= w.entry_epoch && Number(c.epoch) <= w.close_epoch) this._feedOpposite(w, c);
        }
      }
      this._send(w, 'TRACKING');
      return w;
    }

    _feedOpposite(w, c) {
      const o = w.opp;
      if (o.done) return;
      const bull = o.dir === 'BULL';
      const fav = bull ? c.high - w.entry : w.entry - c.low;
      const adv = bull ? w.entry - c.low : c.high - w.entry;
      const slHit = bull ? c.low <= o.sl : c.high >= o.sl;
      const tpHit = bull ? c.high >= o.tp : c.low <= o.tp;
      const mins = Math.max(0, (Number(c.epoch) - w.entry_epoch) / 60);
      o.mfe = Math.max(o.mfe, Math.max(0, fav));
      o.mae = Math.max(o.mae, Math.max(0, adv));
      /* pessimistic when both levels are inside one candle: the SL counts first */
      if (slHit) { o.hitSl = true; o.timeToSl = mins; o.done = true; }
      else if (tpHit) { o.hitTp = true; o.timeToTp = mins; o.done = true; }
    }

    /** Feed each new closed/updated candle. Candle: { epoch, high, low }. */
    onCandle(c) {
      if (!c || !Number.isFinite(Number(c.high)) || !Number.isFinite(Number(c.low))) return;
      for (const w of Array.from(this.watches.values())) {
        if (w.done || !(Number(c.epoch) > w.close_epoch)) continue;
        w.candlesAfter++;
        this._feedOpposite(w, c);
        const bull = w.direction === 'BULL';
        const recovery = bull ? c.high - w.sl : w.sl - c.low;
        w.orig.recovery = Math.max(w.orig.recovery, Math.max(0, recovery));
        const tpHit = bull ? c.high >= w.tp : c.low <= w.tp;
        if (tpHit && !w.orig.reachedTp) {
          w.orig.reachedTp = true;
          w.orig.minutesAfterSl = Math.max(0, (Number(c.epoch) - w.close_epoch) / 60);
        }
        if (w.orig.reachedTp) {
          const beyond = bull ? c.high - w.tp : w.tp - c.low;
          w.orig.beyondTp = Math.max(w.orig.beyondTp, Math.max(0, beyond));
        }
        if (w.candlesAfter >= this.windowCandles) this._complete(w);
      }
    }

    _complete(w) {
      w.done = true;
      this._send(w, 'COMPLETE').then(() => this.watches.delete(w.trade_id), () => {});
    }

    buildPayload(w, status) {
      const range = Math.abs(w.tp - w.sl);
      const pip = pipSizeFor(w.symbol);
      const closeIso = new Date(w.close_epoch * 1000).toISOString();
      return {
        trade_id: w.trade_id, signal_id: w.signal_id, strategy: w.strategy, symbol: w.symbol,
        direction: w.direction, entry: w.entry, sl: w.sl, tp: w.tp, lot_size: w.lot_size,
        close_reason: w.close_reason, close_time: closeIso, status,
        opposite_hit_tp: w.opp.hitTp, opposite_hit_sl: w.opp.hitSl,
        opposite_mfe: w.opp.mfe, opposite_mae: w.opp.mae,
        opposite_time_to_tp_min: w.opp.timeToTp, opposite_time_to_sl_min: w.opp.timeToSl,
        eventual_original_tp: w.orig.reachedTp, minutes_after_sl: w.orig.minutesAfterSl,
        pips_beyond_tp: w.orig.reachedTp ? w.orig.beyondTp / pip : null,
        reversal_ratio: range > 0 ? Math.min(1, w.orig.recovery / range) : null
      };
    }

    async _send(w, status) {
      const payload = this.buildPayload(w, status);
      try {
        if (this.onSend) return await this.onSend(payload);
        if (typeof fetch !== 'function') return null;
        const r = await fetch('/api/trades/opposite_tracking', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + this._getAuthToken(), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return r.ok ? r.json() : null;
      } catch (e) { return null; }
    }

    /** Load signal-improvement advice for strategies from the server. */
    async refreshAdvice() {
      try {
        const r = await fetch('/api/trades/opposite_tracking', {
          headers: { 'Authorization': 'Bearer ' + this._getAuthToken() }
        });
        if (!r.ok) return this.advice;
        const data = await r.json();
        if (data && data.advice) this.advice = data.advice;
      } catch (e) { /* advice is optional */ }
      return this.advice;
    }

    getAdvice(strategy) {
      const a = this.advice[strategy];
      return a && a.filters ? a.filters : null;
    }
  }

  root.OppositeTradeTracker = OppositeTradeTracker;
  if (typeof window !== 'undefined' && !root.oppositeTradeTracker) root.oppositeTradeTracker = new OppositeTradeTracker();
  if (typeof module !== 'undefined' && module.exports) module.exports = { OppositeTradeTracker, pipSizeFor };
})(typeof window !== 'undefined' ? window : globalThis);
