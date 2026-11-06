import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivate, photoType, mayBePhoto, isPage, pagePhotos, PAGE_PHOTOS } from '../api/fetch-photo.js';

test('a product page gives its photos: og:image first, Daraz resized copies folded, logos left out', () => {
  const html = `<!doctype html><html><head><title>Garnier Face Wash | Daraz.pk</title>
    <meta property="og:image" content="https://laz-img-sg.alicdn.com/p/39243b91b8cc1fc204d6fdee175787b9.jpg">
    <link rel="icon" href="https://img.drz.lazcdn.com/static/pk/favicon.png"></head><body>
    <img src="https://img.drz.lazcdn.com/g/tps/images/ims-web/logo-daraz.png">
    <script>window.__data={"images":[{"url":"https:\\/\\/img.drz.lazcdn.com\\/static\\/pk\\/p\\/017ec8b93cab70837ad51a1acc542031.jpg_120x120q80.jpg"},
      {"url":"https:\\/\\/img.drz.lazcdn.com\\/static\\/pk\\/p\\/017ec8b93cab70837ad51a1acc542031.jpg_720x720q80.jpg"},
      {"url":"https:\\/\\/img.drz.lazcdn.com\\/static\\/pk\\/p\\/47744ac0f53d4415d306b65dffde34af.jpg_720x720q80.jpg"}]}</script>
    <img src="//cdn.example.com/photos/side.webp?v=2"> <img src="/media/back.png"> <img src="https://x.com/sprite.png">
    </body></html>`;
  assert.deepEqual(pagePhotos(html, 'https://www.daraz.pk/products/x.html'), [
    'https://laz-img-sg.alicdn.com/p/39243b91b8cc1fc204d6fdee175787b9.jpg',
    'https://img.drz.lazcdn.com/static/pk/p/017ec8b93cab70837ad51a1acc542031.jpg',
    'https://img.drz.lazcdn.com/static/pk/p/47744ac0f53d4415d306b65dffde34af.jpg',
    'https://cdn.example.com/photos/side.webp?v=2',
    'https://www.daraz.pk/media/back.png',
  ]);
  const many = Array.from({ length: 10 }, (_, i) => `<img src="https://s.com/p${i}.jpg">`).join('');
  assert.equal(pagePhotos(many, 'https://s.com/').length, PAGE_PHOTOS);
  assert.deepEqual(pagePhotos('<html><body>no photos</body></html>', 'https://s.com/'), []);
  assert.equal(isPage('text/html; charset=utf-8'), true);
  assert.equal(isPage('image/jpg'), false);
});
import { titleCase } from '../lib/ai.mjs';
import { possibleDuplicates, relatedProducts, withSeeAlso, stripSeeAlso } from '../lib/woo.mjs';

test('photo links may not reach internal addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivate(ip), true, ip);
  }
  for (const ip of ['179.61.189.170', '8.8.8.8', '172.32.0.1', '2a02:4780:16:6ab7::1']) assert.equal(isPrivate(ip), false, ip);
});

test('a photo link is judged by its bytes: Daraz’s "image/jpg" and octet-stream photos are accepted, pages are not', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
  const html = Buffer.from('<!doctype html><html></html>');
  assert.equal(photoType('image/jpg', jpeg), 'image/jpeg'); // Daraz, 2026-11-06
  assert.equal(photoType('image/jpeg; charset=binary', jpeg), 'image/jpeg');
  assert.equal(photoType('application/octet-stream', png), 'image/png');
  assert.equal(photoType('', webp), 'image/webp');
  assert.equal(photoType('image/jpeg', html), null); // labelled a photo, is a page
  assert.equal(photoType('image/jpg', html), null);
  assert.equal(mayBePhoto('image/jpg'), true);
  assert.equal(mayBePhoto('application/octet-stream'), true);
  assert.equal(mayBePhoto(''), true);
  assert.equal(mayBePhoto('text/html; charset=utf-8'), false);
});

test('a big brand name on a low-priced item gets a brand check in the owner note (live run: Rs 2,349 "Emporio Armani")', async () => {
  const { brandCheck } = await import('../lib/ai.mjs');
  assert.match(brandCheck('Emporio Armani', 3300), /BRAND CHECK: "Emporio Armani" is printed on the item and the price is Rs 3300/);
  assert.match(brandCheck('Tissot', 7499), /Tissot-style/);
  assert.equal(brandCheck('Emporio Armani', 45000), ''); // a price a genuine one could have
  assert.equal(brandCheck('Ticarto', 2349), ''); // not a brand whose genuine price is far higher
  assert.equal(brandCheck('', 500), '');
  assert.equal(brandCheck("L'Oréal", 1200), ''); // cosmetics brands sell at these prices for real
});

test('SEO title becomes Title Case, accents, small words and units kept', () => {
  assert.equal(titleCase('black heart pendant Stunning Gold Heart Necklace | Vaxaura'), 'Black Heart Pendant Stunning Gold Heart Necklace | Vaxaura');
  assert.equal(titleCase("glycolic bright face wash – best L'Oréal cleanser for skin"), "Glycolic Bright Face Wash – Best L'Oréal Cleanser for Skin");
  assert.equal(titleCase('garnier face wash 100ml | best bright complete glow 50g 24k'), 'Garnier Face Wash 100ml | Best Bright Complete Glow 50g 24k'); // live run: "100Ml"
});

test('a secondary keyword inside the focus keyword (or around it) is dropped: it counts every mention twice', async () => {
  const { dropNestedSecondaries } = await import('../lib/ai.mjs');
  assert.deepEqual(dropNestedSecondaries(['garnier face wash 100ml', 'bright complete face wash', 'face wash']), ['garnier face wash 100ml', 'bright complete face wash']);
  assert.deepEqual(dropNestedSecondaries(['face wash', 'garnier face wash 100ml', 'vitamin c face wash']), ['face wash']);
  assert.deepEqual(dropNestedSecondaries(['tulip earrings', 'enamel flower earrings', 'tulip pearl stud earrings']), ['tulip earrings', 'enamel flower earrings', 'tulip pearl stud earrings']);
  assert.deepEqual(dropNestedSecondaries([]), []);
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
  // The most specific category wins over a parent-only match (live run #623: a pendant crept in through "jewellery").
  const jewellery = [
    { id: 510, status: 'publish', name: 'Vintage White Olive Leaf Pearl Pendant – Gold Enamel Pendant', url: 'https://vaxaura.com/product/white-enamel-pendant/', categories: ['pendants', 'jewellery'] },
    { id: 570, status: 'publish', name: 'Black Stone Jhumka Earrings – Traditional Jewelry', url: 'https://vaxaura.com/product/black-stone-jhumka-earrings/', categories: ['earrings', 'jewellery'] },
    { id: 613, status: 'publish', name: 'Peacock Jhumka Earrings – Antique Gold Peacock Jhumka Earrings with Pearl Drops', url: 'https://vaxaura.com/product/antique-gold-peacock-jhumka/', categories: ['earrings', 'jewellery'] },
  ];
  assert.deepEqual(relatedProducts('Enamel Tulip Earrings with Faux Pearl – Floral Studs', ['jewellery', 'earrings'], jewellery, { primary: 'earrings' }).map((r) => r.id), [613, 570]);
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
