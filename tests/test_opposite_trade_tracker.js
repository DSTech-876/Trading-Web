const assert = require('assert');
const path = require('path');
const { OppositeTradeTracker } = require(path.join(__dirname, '..', 'indicator', 'OppositeTradeTracker.js'));

const sent = [];
const t = new OppositeTradeTracker({ windowCandles: 3, onSend: async (p) => { sent.push(p); return {}; } });
const trade = { tradeId: 'T1', type: 'grid_scalper_ma', symbol: 'R_25', dir: 'BULL', entry: 100, sl: 99, tp: 102, epoch: 0 };
t.register(trade, 120, [
  { epoch: 60, high: 100.2, low: 99.5 },
  { epoch: 120, high: 99.8, low: 98.9 }
]);
t.onCandle({ epoch: 180, high: 101, low: 99.5 });
t.onCandle({ epoch: 240, high: 102.5, low: 100.5 });
t.onCandle({ epoch: 300, high: 102, low: 101 });
const last = sent[sent.length - 1];
assert.strictEqual(sent[0].status, 'TRACKING');
assert.strictEqual(last.status, 'COMPLETE');
assert.strictEqual(last.eventual_original_tp, true);
assert.strictEqual(last.minutes_after_sl, 2);
assert.strictEqual(last.opposite_hit_tp, false);
assert.strictEqual(last.opposite_hit_sl, true); /* opposite SL at 101 was reached by 101 high */
assert.ok(Math.abs(last.pips_beyond_tp - 0.5) < 1e-9);
assert.strictEqual(t.register(trade, 120), null); /* no duplicate tracking */
console.log('opposite tracker ok');
