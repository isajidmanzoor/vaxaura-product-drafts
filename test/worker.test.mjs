import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { ROUTES } from '../worker.mjs';

const ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'Content-Type': 'text/html' } }) };
const call = (path, init = {}) => worker.fetch(new Request(`https://drafts.example${path}`, init), { ASSETS });

test('the Cloudflare Worker serves every API route', () => {
  const files = fs.readdirSync(new URL('../api/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  assert.deepEqual(Object.keys(ROUTES).sort(), files.sort());
});

test('the Cloudflare Worker: pages, headers, setup check, login, limits', async () => {
  const saved = { ...process.env };
  try {
    for (const k of ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'VAXAURA_WP_USER', 'VAXAURA_WP_APP_PASSWORD']) delete process.env[k];
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'asset /');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.equal((await call('/', { method: 'POST' })).status, 405);

    // Without the secrets only /api/me answers.
    const me = await call('/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).setup, { ADMIN_PASSWORD: false, GEMINI_API_KEY: false, VAXAURA_WP_USER: false, VAXAURA_WP_APP_PASSWORD: false });
    const off = await call('/api/login', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(off.status, 503);
    assert.match((await off.json()).error, /not set up yet: set ADMIN_PASSWORD/);

    Object.assign(process.env, { ADMIN_PASSWORD: 'short', GEMINI_API_KEY: 'x', VAXAURA_WP_USER: 'x', VAXAURA_WP_APP_PASSWORD: 'x' });
    assert.match((await (await call('/api/context')).json()).error, /at least 10 characters/);

    process.env.ADMIN_PASSWORD = 'test-only-password-123';
    const post = (path, body, headers = {}) => call(path, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal((await post('/api/login', '{"password":"test-only-password-123"}')).headers.get('set-cookie')?.startsWith('vx_session='), true);
    assert.equal((await call('/api/context')).status, 401);
    assert.equal((await post('/api/draft', '{}')).status, 401);
    assert.match(await (await post('/api/login', '{"x":')).text(), /not valid JSON/);
    assert.equal((await post('/api/login', 'a'.repeat(7 * 1024 * 1024))).status, 413);
    assert.equal((await call('/api/no-such-route')).status, 404);
    assert.equal((await call('/api/__proto__')).status, 404);
    assert.equal((await call('/api/me', { method: 'POST' })).status, 405);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
