const assert = require('assert');
const path = require('path');
const { PostSLRecoveryAnalyzer } = require(path.join(__dirname, '..', 'indicator', 'PostSLRecoveryAnalyzer.js'));

const mk = (epoch, o, h, l, c) => ({ epoch, open: o, high: h, low: l, close: c });
const trade = { tradeId: 't1', type: 'Breakout', symbol: 'X', dir: 'BULL', entry: 100, sl: 98, tp: 104, lotSize: 1 };

/* BUY loses at 98, then price rallies through original TP: EARLY_ENTRY / re-entry success */
let a = new PostSLRecoveryAnalyzer({ persist: false, windowCandles: 5 });
a.register(trade, 1000, []);
[mk(1060, 98, 98.5, 97.9, 98.4), mk(1120, 98.4, 100, 98.3, 99.8),
 mk(1180, 99.8, 101, 99.7, 100.9), mk(1240, 100.9, 105, 100.8, 104.9),
 mk(1300, 104.9, 106, 104, 105)].forEach(c => a.onCandle(c, 'X'));
let r = a.records[0];
assert(r.scenarioA.eventual_tp_reached && r.scenarioA.minutes_to_tp_after_sl === 4);
assert(r.scenarioA.distance_beyond_tp === 2);
assert.strictEqual(r.classification, 'EARLY_ENTRY_REENTRY_SUCCESS');
assert(r.scenarioB.sl_hit && !r.scenarioB.tp_hit);
assert.strictEqual(a.getStats()[0].scenario_a_pct, 100);

/* BUY loses, price keeps falling: WRONG_DIRECTION */
a = new PostSLRecoveryAnalyzer({ persist: false, windowCandles: 2 });
a.register(trade, 1000, []);
[mk(1060, 98, 98, 95, 95.5), mk(1120, 95.5, 95.6, 93.9, 94)].forEach(c => a.onCandle(c, 'X'));
assert.strictEqual(a.records[0].classification, 'WRONG_DIRECTION');
assert(a.getAlerts().some(s => /opposite trades succeeded 100%/.test(s)));

/* Flat after SL: VALID_LOSS */
a = new PostSLRecoveryAnalyzer({ persist: false, windowCandles: 1 });
a.register(trade, 1000, []);
a.onCandle(mk(1060, 98, 98.2, 97.8, 98), 'X');
assert.strictEqual(a.records[0].classification, 'VALID_LOSS');
console.log('post-SL recovery tests passed');

/* same-candle rule + backfill */
const both = mk(1060, 98.5, 105, 97.5, 104.5);
let b = new PostSLRecoveryAnalyzer({ persist: false, windowCandles: 1 });
b.backfill(trade, 1000, [mk(900, 100, 100, 99, 99), both], 'X');
assert.strictEqual(b.records[0].scenarioA.eventual_tp_reached, true);
b = new PostSLRecoveryAnalyzer({ persist: false, windowCandles: 1, sameCandleRule: 'tp_first' });
b.backfill(trade, 1000, [both], 'X');
assert.strictEqual(b.records[0].scenarioB.sl_hit, true);
console.log('rules ok');
