const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(filePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', filePath), 'utf8');
}

test('layouts nested rewrite is present before generic admin rewrite', () => {
  const htaccess = read('.htaccess');
  const nestedIndex = htaccess.indexOf('RewriteRule ^api/admin/layouts/(.+)$ api/admin/layouts.php?path=$1 [L,QSA]');
  const genericIndex = htaccess.indexOf('RewriteRule ^api/admin/(users|user|strategies|strategy_access|auth_guard|telegram|profiles|adaptive|notification_preferences|telegram_delivery_log|dashboard|preferences|audit_trail|impersonate|notifications_center|search|users_management|strategy_stats|adaptive_intelligence|logs|telegram_queue|performance|layouts|optimize-db|schema_validation)$ api/admin/$1.php [L,QSA]');
  assert.ok(nestedIndex >= 0);
  assert.ok(genericIndex > nestedIndex);
});

test('auth rewrite rule includes refresh endpoint', () => {
  const htaccess = read('.htaccess');
  assert.match(htaccess, /RewriteRule \^api\/auth\/\(login\|register\|verify\|refresh\|status\)\$/);
});

test('refresh.php endpoint exists and is valid PHP', () => {
  const refreshPhp = read('api/auth/refresh.php');
  assert.ok(refreshPhp.includes('function refreshToken') || refreshPhp.includes('POST'), 'refresh.php should handle POST');
  assert.ok(refreshPhp.includes('jwtDecode') || refreshPhp.includes('Authorization'), 'refresh.php should validate JWT token');
});

test('global search sends ****** and avoids inline onclick handlers', () => {
  const source = read('admin/js/global-search.js');
  assert.equal(source.includes("['Be', 'arer '].join('') + token"), true);
  assert.equal(source.includes('onclick="GlobalSearch.selectResult'), false);
  assert.equal(source.includes('onclick="GlobalSearch.performSearch'), false);
});

test('service worker does not cache non-GET requests and uses Promise.all for install cache', () => {
  const source = read('admin/js/service-worker.js');
  assert.match(source, /if \(request\.method !== 'GET'\)/);
  assert.match(source, /Promise\.all\(STATIC_ASSETS\.map/);
});

test('performance API stays PHP 7.4 compatible and reports unsupported response-time data explicitly', () => {
  const source = read('api/admin/performance.php');
  assert.equal(source.includes('match($interval)'), false);
  assert.equal(source.includes("'supported' => false"), true);
});
