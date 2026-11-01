import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, getAll, api, forgetLists } from '../lib/woo.mjs';

configure({ VAXAURA_SITE: 'https://shop.test', VAXAURA_WP_USER: 'u', VAXAURA_WP_APP_PASSWORD: 'stub' });

test('shop lists are remembered for a minute and forgotten after any write', async (t) => {
  let calls = 0, name = 'first';
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'GET') { calls++; return new Response(JSON.stringify([{ id: 1, name }]), { headers: { 'x-wp-totalpages': '1' } }); }
    name = 'second';
    return new Response('{}');
  });
  forgetLists();
  const a = await getAll('/wc/v3/products', { status: 'any' });
  const b = await getAll('/wc/v3/products', { status: 'any' });
  assert.equal(calls, 1);
  assert.equal(b[0].name, 'first');
  b[0].name = 'changed by a caller';
  assert.equal((await getAll('/wc/v3/products', { status: 'any' }))[0].name, 'first'); // callers get copies
  await getAll('/wc/v3/products', { status: 'trash' });
  assert.equal(calls, 2); // another list is its own entry
  await api('PUT', '/wc/v3/products/1', { body: { name: 'second' } });
  assert.equal((await getAll('/wc/v3/products', { status: 'any' }))[0].name, 'second');
  assert.equal(calls, 3);
  const now = Date.now;
  t.mock.method(Date, 'now', () => now() + 61 * 1000);
  await getAll('/wc/v3/products', { status: 'any' });
  assert.equal(calls, 4); // older than a minute: asked again
  assert.equal(a.length, 1);
});
