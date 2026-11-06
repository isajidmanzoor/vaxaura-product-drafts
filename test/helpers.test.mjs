import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivate } from '../api/fetch-photo.js';
import { titleCase } from '../lib/ai.mjs';
import { possibleDuplicates, relatedProducts, withSeeAlso, stripSeeAlso } from '../lib/woo.mjs';

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

// Names from vaxaura.com on 2026-11-06: six couple watch sets, different dials and brands.
test('duplicate warning ignores the words half the shop shares, still catches the same item', () => {
  const shop = [
    { id: 591, status: 'publish', name: 'Ticarto Gold Couple Watch Set – Matching Gold Wristwatches' },
    { id: 587, status: 'publish', name: 'Tissot PRX Couple Watch Set – Silver Dial Wristwatch' },
    { id: 583, status: 'publish', name: 'White Butterfly Pendant – Gold Chain Butterfly Necklace' },
    { id: 579, status: 'publish', name: 'Ticarto Blue Dial Silver Couple Watch Set – Matching Wristwatches' },
    { id: 574, status: 'publish', name: 'Ticarto Two Tone Couple Watch – Gold &amp; Silver Pair' },
    { id: 570, status: 'publish', name: 'Black Stone Jhumka Earrings – Traditional Jewelry | Gold Jhumka Earrings' },
    { id: 563, status: 'publish', name: 'Ticarto Couple Watch Silver Black Dial Set – Couple Watches' },
    { id: 536, status: 'publish', name: 'Leopard Couple Watches Black Metal – Skeleton Dial Watch Set' },
    { id: 253, status: 'publish', name: 'Gold Bow Heart Pendant' },
  ];
  assert.deepEqual(possibleDuplicates('Ticarto Couple Watch Set – Gold Dial Wristwatch', shop), []);
  // The same watch set listed again under a longer name.
  assert.equal(possibleDuplicates('Ticarto Gold Couple Watch Set Matching Gold Wristwatches for Him and Her', shop).length, 1);
  assert.match(possibleDuplicates('Gold Bow Heart Pendant Necklace – Vaxaura Jewellery', shop)[0], /#253/);
  // Three shared words that are only a small part of the other name (the butterfly necklace) are not enough.
  assert.deepEqual(possibleDuplicates('Gold Pendant Chain', shop), []);
});

test('"See also": the category page and the two closest live products of the category, never doubled', () => {
  const ctx = {
    categories: [
      { slug: 'watches', name: 'Watches', parent: null, url: 'https://vaxaura.com/Collections/watches/' },
      { slug: 'couple-watches', name: 'Couple Watches', parent: 'watches', url: 'https://vaxaura.com/Collections/watches/couple-watches/' },
    ],
    products: [
      { id: 591, status: 'publish', name: 'Ticarto Gold Couple Watch Set – Matching Gold Wristwatches', url: 'https://vaxaura.com/product/gold-couple-watch-set-vaxaura/', categories: ['couple-watches', 'watches'] },
      { id: 587, status: 'publish', name: 'Tissot PRX Couple Watch Set – Silver Dial Wristwatch', url: 'https://vaxaura.com/product/tissot-prx-couple-watch-vaxaura/', categories: ['couple-watches', 'watches'] },
      { id: 583, status: 'publish', name: 'White Butterfly Pendant – Gold Chain Butterfly Necklace', url: 'https://vaxaura.com/product/white-butterfly-pendant-vaxaura/', categories: ['pendants', 'jewellery'] },
      { id: 600, status: 'draft', name: 'Ticarto Couple Watch Draft', url: '', categories: ['couple-watches'] },
      { id: 563, status: 'publish', name: 'Ticarto Couple Watch Silver Black Dial Set – Couple Watches', url: 'https://vaxaura.com/product/ticarto-couple-watch/', categories: ['couple-watches', 'watches'] },
    ],
  };
  const name = 'Ticarto Couple Watch Set – Gold Dial Wristwatch';
  const related = relatedProducts(name, ['couple-watches', 'watches'], ctx.products);
  // 591, 587 and 563 each share five words with the name; among equals the newest come first. Drafts and other categories never.
  assert.deepEqual(related.map((r) => r.id), [591, 587]);
  const html = withSeeAlso('<p><strong>ticarto couple watch set</strong> in gold.</p>\n', { name, categories: ['couple-watches', 'watches'], ctx });
  assert.match(html, /<p class="vx-see-also">See also: <a href="https:\/\/vaxaura\.com\/Collections\/watches\/couple-watches\/">Couple Watches<\/a>, <a href="https:\/\/vaxaura\.com\/product\/gold-couple-watch-set-vaxaura\/">Ticarto Gold Couple Watch Set – Matching Gold Wristwatches<\/a>, <a href="https:\/\/vaxaura\.com\/product\/tissot-prx-couple-watch-vaxaura\/">[^<]+<\/a>\.<\/p>$/);
  assert.equal(withSeeAlso(html, { name, categories: ['couple-watches', 'watches'], ctx }), html, 'applied twice: still one line');
  assert.equal(stripSeeAlso(html), '<p><strong>ticarto couple watch set</strong> in gold.</p>');
  // Nothing to link: the description stays as it is.
  assert.equal(withSeeAlso('<p>x</p>', { name, categories: ['rings'], ctx: { categories: [], products: [] } }), '<p>x</p>');
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
