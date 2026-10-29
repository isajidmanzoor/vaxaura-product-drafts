import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivate } from '../api/fetch-photo.js';
import { titleCase } from '../lib/ai.mjs';
import { possibleDuplicates } from '../lib/woo.mjs';

test('photo links may not reach internal addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivate(ip), true, ip);
  }
  for (const ip of ['179.61.189.170', '8.8.8.8', '172.32.0.1', '2a02:4780:16:6ab7::1']) assert.equal(isPrivate(ip), false, ip);
});

test('SEO title becomes Title Case, accents and small words kept', () => {
  assert.equal(titleCase('black heart pendant Stunning Gold Heart Necklace | Vaxaura'), 'Black Heart Pendant Stunning Gold Heart Necklace | Vaxaura');
  assert.equal(titleCase("glycolic bright face wash – best L'Oréal cleanser for skin"), "Glycolic Bright Face Wash – Best L'Oréal Cleanser for Skin");
});

test('duplicate warning', () => {
  const products = [{ id: 271, status: 'publish', name: 'Triple Black Heart Pendant &#8211; Heart Pendant' }, { id: 34, status: 'publish', name: 'Modern Gold Face Decorative Vase' }];
  assert.deepEqual(possibleDuplicates('Triple Heart Necklace – Black Heart Pendant', products).length, 1);
  assert.deepEqual(possibleDuplicates('Crystal Butterfly Stud Earrings', products), []);
});

test('placeholders: 4+ photos use 2-4, fewer photos also place the featured one', async () => {
  const { placeholderList } = await import('../lib/ai.mjs');
  assert.deepEqual(placeholderList(5), ['{{image:2}}', '{{image:3}}', '{{image:4}}']);
  assert.deepEqual(placeholderList(3), ['{{image:1}}', '{{image:2}}', '{{image:3}}']);
  assert.deepEqual(placeholderList(1), ['{{image:1}}']);
});

test('a placeholder for a missing photo does not count as an image', async () => {
  const { seoAudit } = await import('../lib/woo.mjs');
  const fs = await import('node:fs');
  const p = JSON.parse(fs.readFileSync(new URL('./rankmath-100.json', import.meta.url), 'utf8'));
  p.images = p.images.slice(0, 3);
  p.description = p.description.replace('{{image:2}}', '{{image:1}}').replace('{{image:3}}', '{{image:2}}').replace('{{image:4}}', '{{image:4}}');
  const t = Object.fromEntries(seoAudit(p).tests.map((x) => [x.id, x]));
  assert.equal(t.images.info, '3 image(s)'); // 2 valid placeholders + featured; {{image:4}} ignored
});

test('SEO title over 60 characters drops the brand suffix', async () => {
  const { fitTitle } = await import('../lib/ai.mjs');
  assert.equal(fitTitle('Black Heart Pendant – Stunning Triple Heart Necklace | Vaxaura'), 'Black Heart Pendant – Stunning Triple Heart Necklace');
  assert.equal(fitTitle('Gold Heart Pendant – Perfect Gift | Vaxaura'), 'Gold Heart Pendant – Perfect Gift | Vaxaura');
});

test('server errors are shown in plain English', async () => {
  const { route } = await import('../lib/http.mjs');
  const run = async (err, opts = { auth: false }) => {
    const out = {};
    const res = { headersSent: false, setHeader() {}, status(c) { out.status = c; return this; }, json(b) { out.body = b; } };
    await route('GET', () => { throw err; }, opts)({ method: 'GET', headers: {} }, res);
    return out;
  };
  const quiet = console.error; console.error = () => {};
  try {
    const net = await run(new Error('GET /wc/v3/products: fetch failed'));
    assert.equal(net.status, 502);
    assert.match(net.body.error, /Could not reach vaxaura\.com/);
    const wp = await run(new Error('POST /wc/v3/products -> HTTP 400: woocommerce_rest_product_not_created The product with SKU (X) is already present'));
    assert.equal(wp.status, 400);
    assert.equal(wp.body.error, 'WordPress could not complete the request: The product with SKU (X) is already present');
    const plain = await run(Object.assign(new Error('Incorrect password.'), { status: 401 }));
    assert.deepEqual([plain.status, plain.body.error], [401, 'Incorrect password.']);
    const locked = await run(new Error('x'), { auth: true });
    assert.deepEqual([locked.status, locked.body.error], [401, 'Please sign in.']);
  } finally { console.error = quiet; }
});

test('brand spelling from the product name survives Title Case', async () => {
  const { keepBrandCase, titleCase } = await import('../lib/ai.mjs');
  assert.equal(keepBrandCase(titleCase('best st london foundation price in pakistan'), 'ST London Matt Fusion Foundation SPF 20'), 'Best ST London Foundation Price in Pakistan');
  assert.equal(keepBrandCase('Loreal Glycolic Face Wash – Best Glow', "L'Oréal Glycolic Bright Face Wash 100ml"), 'Loreal Glycolic Face Wash – Best Glow');
});

test('focus keyword must name the product in 2-4 words', async () => {
  const { seoAudit } = await import('../lib/woo.mjs');
  const fs = await import('node:fs');
  const p = JSON.parse(fs.readFileSync(new URL('./rankmath-100.json', import.meta.url), 'utf8'));
  const q = (kw) => { p.seo.focus_keyword = kw; return seoAudit(p).tests.find((t) => t.id === 'qKw').pass; };
  assert.equal(q('glycolic bright face wash'), true);
  assert.equal(q('st london foundation price in pakistan'), false);
  assert.equal(q('face wash'), true);
  assert.equal(q('wash'), false);
  assert.equal(q('best face wash'), false);
});
