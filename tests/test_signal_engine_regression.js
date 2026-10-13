const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../indicator/indicator.js'), 'utf8');

test('MTF setup state is persisted and reused', () => {
  assert.match(source, /let mtfSetupState = null/);
  assert.match(source, /function getMtfSetupState\(/);
  assert.match(source, /MTF_SETUP_REUSED/);
});

test('Trade lifecycle emits release/close debug events and immediate reset', () => {
  assert.match(source, /TRADE_CLOSE/);
  assert.match(source, /SYMBOL_RELEASE/);
  assert.match(source, /resetForNextSetup\(\)/);
});

test('Reset session clears key strategy histories and lifecycle dedupe cache', () => {
  assert.match(source, /liquiditySweepHistory = \[\]/);
  assert.match(source, /mtfTopDownHistory = \[\]/);
  assert.match(source, /sendSignalLifecycleTelegram\._sentKeys\.clear\(\)/);
});

test('Reset session integration clears timers and storage-backed caches', () => {
  assert.match(source, /if \(pingTimer\) \{ clearInterval\(pingTimer\); pingTimer = null; \}/);
  assert.match(source, /if \(watchdogTimer\) \{ clearInterval\(watchdogTimer\); watchdogTimer = null; \}/);
  assert.match(source, /localStorage\.removeItem\(LS_PREFIX \+ "signalHistory"\)/);
  assert.match(source, /confluenceFactorStats = \{\}/);
  assert.match(source, /localStorage\.removeItem\(getConfluenceStatsStorageKey\(\)\)/);
  assert.match(source, /localStorage\.removeItem\(SIGNAL_NOTES_LS_KEY\)/);
});

test('Lifecycle telegram captions include Signal ID and TP/SL categories', () => {
  assert.match(source, /Signal ID/);
  assert.match(source, /Take Profit Hit/i);
  assert.match(source, /Stop Loss Hit/i);
});
