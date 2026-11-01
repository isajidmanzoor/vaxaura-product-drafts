import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../lib/server.mjs';

// A raw request (no URL clean-up by the client, so "../" really reaches the server).
function raw(port, method, path, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the hosting server: pages, headers, API, limits, no way out of public/', async (t) => {
  process.env.ADMIN_PASSWORD ||= 'test-only-password-123';
  const server = createAppServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();

  const page = await raw(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal((await raw(port, 'GET', '/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await raw(port, 'GET', '/brand/vaxaura-logo.webp')).headers['content-type'], 'image/webp');

  for (const p of ['/../package.json', '/%2e%2e/server.mjs', '/..%2f..%2fpackage.json', '/brand/../../server.mjs', '/api/../server.mjs', '/nope.html']) {
    assert.equal((await raw(port, 'GET', p)).status, 404, p);
  }
  assert.equal((await raw(port, 'GET', '/api/me')).status, 200);
  assert.equal((await raw(port, 'POST', '/api/draft', '{}')).status, 401);
  assert.equal((await raw(port, 'GET', '/api/no-such-route')).status, 404);
  assert.match((await raw(port, 'POST', '/api/login', '{"x":')).body, /not valid JSON/);
  assert.equal((await raw(port, 'POST', '/api/login', 'a'.repeat(7 * 1024 * 1024))).status, 413);
  assert.equal((await raw(port, 'POST', '/index.html')).status, 405);
});
