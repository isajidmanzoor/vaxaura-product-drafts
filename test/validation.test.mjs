import test from 'node:test';
import assert from 'node:assert/strict';
import { UNSAFE_HTML, SKU_RE, validate, normalizeListing, seoAudit } from '../lib/woo.mjs';
import { looksLike } from '../api/upload.js';

test('unsafe HTML: scripts, handlers and javascript: links only', () => {
  for (const s of ['<script>x</script>', '< SCRIPT src=x>', '<img src=x onerror=alert(1)>', '<p onclick="x">', '<a href="javascript:alert(1)">x</a>', "<a href=' javascript:x'>"]) assert.ok(UNSAFE_HTML.test(s), s);
  for (const s of ['Size one = 2 pieces', '<p>javascript: the language</p>', '<iframe src="https://www.youtube.com/embed/x"></iframe>', '<p class="lone">a</p>', '<a href="https://vaxaura.com">shop</a>']) assert.ok(!UNSAFE_HTML.test(s), s);
});

test('SKU format', () => {
  for (const s of ['VAX-JP07', 'VAX-CW002', 'VAX2310']) assert.ok(SKU_RE.test(s), s);
  for (const s of ['vax jp 99', 'VAX–JP04', 'A', '-VAX', 'VAX-JP07!', 'x'.repeat(31)]) assert.ok(!SKU_RE.test(s), s);
});

test('photo files must really be the type they claim', () => {
  assert.equal(looksLike('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), true);
  assert.equal(looksLike('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
  assert.equal(looksLike('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), true);
  assert.equal(looksLike('image/webp', Buffer.from('hello, not a photo')), false);
  assert.equal(looksLike('image/jpeg', Buffer.from('<svg onload=alert(1)>')), false);
  assert.equal(looksLike('image/gif', Buffer.from('GIF89a........')), false);
});

const ok = () => ({
  name: 'Gold Heart Pendant – Necklace', regular_price: '2999', sale_price: '1999', sku: 'VAX-JP99', stock_quantity: 5, categories: ['pendants'],
  short_description: '<p>x</p>', description: '<p>y</p>', images: [{ media_id: 1, alt: 'a' }],
  seo: { title: 'Gold Heart Pendant', description: 'x'.repeat(130), focus_keyword: 'gold heart pendant' },
});

test('draft validation: stock, SKU, unsafe HTML, name length', () => {
  assert.deepEqual(validate(ok()), []);
  assert.deepEqual(validate({ ...ok(), stock_quantity: '' }), []);
  assert.match(validate({ ...ok(), stock_quantity: -3 }).join(' '), /Stock quantity/);
  assert.match(validate({ ...ok(), stock_quantity: 2.5 }).join(' '), /Stock quantity/);
  assert.match(validate({ ...ok(), sku: 'vax jp 99!' }).join(' '), /SKU may only/);
  assert.match(validate({ ...ok(), description: '<p>y</p><script>x</script>' }).join(' '), /Long description contains a script/);
  assert.match(validate({ ...ok(), short_description: '<img src=x onerror=alert(1)>' }).join(' '), /Short description contains/);
  assert.deepEqual(validate({ ...ok(), description: '<p>y</p><iframe src="https://www.youtube.com/embed/x"></iframe>' }), []);
  assert.match(validate({ ...ok(), name: 'x'.repeat(121) }).join(' '), /too long/);
});

test('a broken or hand-made listing gives errors, never a crash', () => {
  const broken = { name: 5, seo: 'x', images: 'no', description: null, categories: 'pendants', tags: {}, attributes: 7, stock_quantity: null };
  assert.ok(validate(broken).length > 0);
  const p = normalizeListing(broken);
  assert.equal(p.name, '5');
  assert.deepEqual(p.images, []);
  assert.doesNotThrow(() => seoAudit(p));
  assert.doesNotThrow(() => validate(undefined));
});
