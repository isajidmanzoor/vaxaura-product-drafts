import test from 'node:test';
import assert from 'node:assert/strict';
import { keywordPool, keywordReport, cannibalization, stem } from '../lib/keywords.mjs';
import { seoAudit, nextSku, skuPrefix, hiddenCategory } from '../lib/woo.mjs';
import { grade, SKU_FORMAT, shopClashes } from '../lib/qa.mjs';

// Google autocomplete (gl=pk) for the Leopard couple watches, 2026-10-31.
const WATCH_SUGGESTIONS = [
  'couple watches', 'couple watches in pakistan', 'couple watches brands', 'couple watches price in pakistan', 'couple watches brands in pakistan',
  'couple watches daraz', 'couple watches rolex', 'couple watches set', 'couple watches casio', 'couple watches price', 'couple watch price in pakistan',
  'couple watch set', 'couple watch design', 'black couple watches', 'black couple watches titan', 'black couple watch set', 'black couple watch fossil',
  'leopard watch', 'leopard watch price in pakistan', 'leopard watch women', 'leopard watch cartier',
];
const WATCH = {
  product: 'pair of black metal couple watches with square skeleton dials', product_type: 'couple watch set', brand: 'Leopard',
  key_terms: ['skeleton dial', 'square', 'black metal'], details: 'black metal link bracelet, crystal hour markers', label_text: 'LEOPARD',
};
const counts = (list) => { const m = new Map(); for (const k of list) m.set(k, (m.get(k) || 0) + 1); return m; };

test('stems plural product words', () => {
  assert.equal(stem('watches'), 'watch');
  assert.equal(stem('necklaces'), 'necklace');
  assert.equal(stem('earrings'), 'earring');
  assert.equal(stem('glass'), 'glass');
});

test('keyword pool: real searches, cleaned, no other brands or non-product searches', () => {
  const pool = keywordPool(counts(WATCH_SUGGESTIONS), WATCH).map((k) => k.kw);
  assert.ok(pool.includes('couple watches'), pool.join(' | '));
  assert.ok(pool.includes('black couple watch set'));
  assert.ok(pool.includes('leopard watch'));
  assert.equal(pool[0], 'couple watches'); // suggested most often
  for (const bad of ['couple watches rolex', 'couple watches casio', 'black couple watches titan', 'leopard watch cartier', 'couple watches brands', 'couple watch design', 'couple watches daraz', 'couple watches black metal']) {
    assert.ok(!pool.includes(bad), bad);
  }
  for (const kw of pool) assert.ok(!/price|pakistan|daraz/.test(kw), kw);
});

test('keyword pool leaves out keywords the shop already targets', () => {
  const pool = keywordPool(counts(WATCH_SUGGESTIONS), WATCH, ['couple watches', 'leopard watch']).map((k) => k.kw);
  assert.ok(!pool.includes('couple watches'));
  assert.ok(!pool.includes('leopard watch'));
  assert.ok(pool.includes('couple watch set'));
});

test('keyword pool is empty for unrelated suggestions', () => {
  assert.deepEqual(keywordPool(counts(['face wash for men', 'gold pendant']), WATCH), []);
});

test('keyword pool drops a joining word left at the edge of a search', () => {
  const JHUMKA = { product: 'gold-tone jhumka earrings with black stones', product_type: 'jhumka earrings', key_terms: ['black stone'], details: 'gold tone, black stones' };
  const pool = keywordPool(counts(['price of jhumka gold earrings', 'jhumka gold earrings', 'jhumka earrings for women', 'black stone jhumka with price']), JHUMKA);
  const kws = pool.map((k) => k.kw);
  assert.ok(kws.includes('jhumka gold earrings'), kws.join(' | '));
  assert.equal(pool.find((k) => k.kw === 'jhumka gold earrings').hits, 2); // "of jhumka gold earrings" merged into it
  assert.ok(kws.includes('black stone jhumka'));
  assert.ok(kws.includes('jhumka earrings for women')); // a joining word in the middle stays
  assert.ok(kws.every((k) => !/^(of|for|with) | (of|for|with)$/.test(k)), kws.join(' | '));
});

test('keyword report: free, overlapping and taken searches against the shop', () => {
  const shop = [
    { id: 536, name: 'Leopard Couple Watches', status: 'publish', url: 'https://vaxaura.com/product/couple-watches/', keywords: ['couple watches'] },
    { id: 600, name: 'Couple Watch Set', status: 'draft', url: '', keywords: ['couple watch set'] },
  ];
  const r = keywordReport(counts(WATCH_SUGGESTIONS), WATCH, shop);
  const by = Object.fromEntries(r.pool.map((k) => [k.kw, k]));
  // Taken searches are not offered, but reported with the product that uses them.
  assert.ok(!by['couple watches'] && !by['couple watch set']);
  assert.deepEqual(r.taken.map((t) => t.kw).sort(), ['couple watch set', 'couple watches']);
  assert.deepEqual(r.taken.find((t) => t.kw === 'couple watches').by.map((b) => `${b.id}:${b.focus}`), ['536:true']);
  // Free, or overlapping with a product whose focus keyword is a shorter form.
  assert.equal(by['leopard watch'].status, 'free');
  assert.deepEqual(by['leopard watch'].conflicts, []);
  assert.equal(by['black couple watches'].status, 'overlap');
  assert.equal(by['black couple watches'].conflicts[0].id, 536);
  assert.equal(by['black couple watch set'].conflicts[0].id, 600);
  // Without a shop everything is free and nothing is taken.
  const alone = keywordReport(counts(WATCH_SUGGESTIONS), WATCH, []);
  assert.ok(alone.pool.every((k) => k.status === 'free'));
  assert.deepEqual(alone.taken, []);
});

const SHOP = [
  { id: 536, name: 'Leopard Couple Watches', status: 'publish', keywords: ['couple watches', 'black couple watch set'] },
  { id: 374, name: 'Emerald Heart Pendant', status: 'publish', keywords: ['heart pendant', 'green heart necklace'] },
  { id: 271, name: 'Triple Black Heart Pendant', status: 'publish', keywords: ['black heart pendant'] },
];

test('shop-wide clashes: each pair once, must-fix first, the product itself never counted', () => {
  const shop = [...SHOP, { id: 900, name: 'Another Couple Watch', status: 'draft', keywords: ['couple watches'] }];
  const c = shopClashes(shop);
  const pairs = c.map((x) => `${[x.a.id, x.b.id].sort().join('-')}:${x.severity}`);
  assert.deepEqual(pairs, [...new Set(pairs)], 'no pair twice');
  assert.ok(pairs.includes('536-900:high'));
  assert.ok(pairs.includes('271-374:medium')); // "black heart pendant" contains "heart pendant"
  assert.ok(!pairs.some((p) => /^(\d+)-\1:/.test(p)));
  assert.equal(c[0].severity, 'high');
  // Excluding the product itself from a shop that contains it.
  assert.deepEqual(cannibalization({ keywords: ['couple watches'] }, shop, 536).map((x) => x.id), [900]);
});

test('cannibalization: same focus, their secondary, my secondary, overlap', () => {
  const sev = (kws) => cannibalization({ keywords: kws }, SHOP).map((c) => `${c.id}:${c.severity}`);
  assert.deepEqual(sev(['couple watches']), ['536:high']);
  assert.deepEqual(sev(['black couple watch set']), ['536:high']); // their secondary keyword
  assert.deepEqual(sev(['silver watch', 'heart pendant']), ['374:high']); // my secondary is their focus
  assert.deepEqual(sev(['gold heart pendant']), ['374:medium']); // "heart pendant" inside mine
  assert.deepEqual(sev(['butterfly earrings']), []);
  assert.deepEqual(cannibalization({ keywords: [] }, SHOP), []);
  // kind names the fix: change a focus keyword, or drop my clashing secondary keyword.
  const kind = (kws) => cannibalization({ keywords: kws }, SHOP).map((c) => c.kind);
  assert.deepEqual(kind(['couple watches']), ['same']);
  assert.deepEqual(kind(['black couple watch set']), ['their-secondary']);
  assert.deepEqual(kind(['silver watch', 'heart pendant']), ['my-secondary']);
  assert.deepEqual(kind(['gold heart pendant']), ['overlap']);
});

const listing = (kw) => ({
  name: 'Gold Heart Pendant – Necklace', slug: kw.replace(/ /g, '-'), short_description: `<p>${kw}</p>`, description: `<p><strong>${kw}</strong> text</p>`,
  images: [{ media_id: 1, alt: `${kw} by Vaxaura`, update_media: true }], seo: { title: kw, description: kw, focus_keyword: kw },
});

test('SEO audit: real-search and cannibalization checks', () => {
  const t = (p, opts) => Object.fromEntries(seoAudit(p, opts).tests.map((x) => [x.id, x]));
  let a = t(listing('couple watches black metal'), { keywordPool: ['couple watches', 'black couple watch set'] });
  assert.equal(a.qKwReal.pass, false);
  a = t(listing('black couple watch set'), { keywordPool: ['couple watches', 'black couple watch set'] });
  assert.equal(a.qKwReal.pass, true);
  a = t(listing('anything here'), {}); // no Google data: not checked
  assert.equal(a.qKwReal.pass, true);
  a = t({ ...listing('couple watches'), keyword_pool: ['couple watches'] }, { shop: SHOP });
  assert.equal(a.qCannibal.pass, false);
  assert.equal(a.kwNew.pass, false);
  a = t(listing('gold heart pendant'), { shop: SHOP }); // overlap only: a warning, not a failure
  assert.equal(a.qCannibal.pass, true);
  assert.equal(seoAudit(listing('gold heart pendant'), { shop: SHOP }).conflicts[0].severity, 'medium');
});

test('SKU prefixes follow the shop (fixed earrings, initials for new categories) and keep the width', () => {
  assert.equal(skuPrefix('earrings'), 'VAX-JE');
  assert.equal(skuPrefix('couple-watches'), 'VAX-CW');
  assert.equal(skuPrefix('hair-accessories'), 'VAX-HA');
  assert.equal(skuPrefix('watches'), 'VAX-W');
  assert.equal(nextSku('VAX-CW', ['VAX-CW001']), 'VAX-CW002');
  assert.equal(nextSku('VAX-N', ['VAX-N001', 'VAX-JP10']), 'VAX-N002');
  assert.equal(nextSku('VAX-JP', ['VAX-JP09', 'VAX-JP10']), 'VAX-JP11');
  assert.equal(nextSku('VAX-W', []), 'VAX-W01');
  assert.ok(SKU_FORMAT.test('VAX-CW002') && SKU_FORMAT.test('VAX-JP11') && !SKU_FORMAT.test('vax- jp03') && !SKU_FORMAT.test(''));
});

test('placeholder and empty duplicate categories are hidden', () => {
  const cats = [
    { slug: 'foundation', name: 'Foundation', count: 1 }, { slug: 'foundation-cosmetics', name: 'Foundation', count: 0 },
    { slug: 'uncategorized', name: 'Uncategorized', count: 0 }, { slug: 'qa-test-sub', name: 'QA Test Sub', count: 0 },
    { slug: 'jewelry-collection', name: 'Jewelry Collection', count: 0 }, { slug: 'couple-watches', name: 'Couple Watches', count: 1 },
  ];
  assert.deepEqual(cats.filter((c) => hiddenCategory(c, cats)).map((c) => c.slug), ['foundation-cosmetics', 'uncategorized', 'qa-test-sub']);
});

test('QA grading of a product', () => {
  const pr = {
    id: 900, name: 'Leopard Couple Watches Black Metal – Watch Set', slug: 'couple-watches-vaxaura', status: 'draft', sku: 'VAX-CW002',
    regular_price: '10999', sale_price: '7500', stock_status: 'instock', manage_stock: true, stock_quantity: 5, reviews_allowed: true,
    short_description: '<p>Couple watches by Vaxaura with a square skeleton dial for him and her.</p>',
    description: '<p><strong>couple watches</strong> ' + 'word '.repeat(380) + '</p><img src="a"><img src="b"><img src="c">',
    tags: [{ name: 'Couple Watches' }, { name: 'Gift' }, { name: 'Watch Set' }], categories: [{ id: 141 }],
    images: [{ id: 1, alt: 'Couple watches by Vaxaura' }, { id: 2, alt: 'Side' }, { id: 3, alt: 'Close up' }, { id: 4, alt: 'Box' }],
    meta_data: [{ key: 'rank_math_focus_keyword', value: 'couple watches' }, { key: 'rank_math_title', value: 'Couple Watches Stunning Set | Vaxaura' }, { key: 'rank_math_description', value: 'couple watches' }],
  };
  const other = { ...pr, id: 536, sku: 'VAX-CW001', images: [], meta_data: [{ key: 'rank_math_focus_keyword', value: 'couple watches' }] };
  const media = new Map([[1, { id: 1, mime: 'image/webp', bytes: 60000 }], [2, { id: 2, mime: 'image/webp', bytes: 99000 }], [3, { id: 3, mime: 'image/jpeg', bytes: 180000 }], [4, { id: 4, mime: 'image/webp', bytes: 50000 }]]);
  const cats = [{ id: 141, slug: 'couple-watches', name: 'Couple Watches', count: 1, parent: 0 }];
  const g = grade(pr, { all: [pr, other], cats, media });
  const by = Object.fromEntries(g.checks.map((c) => [c.label, c]));
  assert.equal(by['Every photo 100 KB or less'].status, 'fail');
  assert.match(by['Every photo 100 KB or less'].info, /#3 175\.8 KB/);
  assert.equal(by['WebP format'].status, 'warn');
  assert.equal(by['SKU format VAX-XX00'].status, 'pass');
  assert.equal(by['SKU unique'].status, 'pass');
  assert.equal(by['Keyword clash with #536 Leopard Couple Watches Black Metal – Watch Set'].status, 'fail');
  assert.equal(by['In a category'].status, 'pass');
  assert.equal(by['Long description 200+ words'].status, 'pass');
  assert.equal(g.metrics.photos.length, 4);
  // Internal links: none in this description; a "See also" line with a shop link passes.
  assert.equal(by['Links to the category or related products'].status, 'warn');
  const linked = { ...pr, description: pr.description + '<p class="vx-see-also">See also: <a href="https://vaxaura.com/Collections/watches/">Watches</a>, <a href="https://www.daraz.pk/x">Daraz</a>.</p>' };
  const l = Object.fromEntries(grade(linked, { all: [pr, other], cats, media }).checks.map((c) => [c.label, c]));
  assert.equal(l['Links to the category or related products'].status, 'pass');
  assert.equal(l['Links to the category or related products'].info, '1 internal link'); // the Daraz link does not count
});

// ---------- verified searches and demand ----------
const { suggestionStats, verifyPool } = await import('../lib/keywords.mjs');

test('a candidate is verified when Google offered it, unknown when it only came out of a longer search', () => {
  const JHUMKA = { product: 'gold-tone jhumka earrings with black stones', product_type: 'jhumka earrings', key_terms: ['black stone'], details: 'gold tone, black stones' };
  const pool = keywordPool(counts(['price of jhumka gold earrings', 'jhumka earrings for women', 'jhumka earrings for women gold']), JHUMKA);
  const by = Object.fromEntries(pool.map((k) => [k.kw, k]));
  assert.equal(by['jhumka earrings for women'].searched, true); // offered as is
  assert.equal(by['jhumka gold earrings'].searched, null); // only inside "price of ..."
  for (const k of pool) assert.ok(['high', 'medium', 'low'].includes(k.tier) && k.demand >= 0 && k.demand <= 100, k.kw);
});

test('demand follows Google’s ranking: first places and a long tail beat a phrase low in one answer', () => {
  const lists = [
    ['couple watches', 'couple watches price in pakistan', 'couple watches set', 'couple watch design', 'leopard watch'],
    ['couple watches', 'couple watches in pakistan', 'black couple watch set'],
  ];
  const pool = keywordPool(suggestionStats(lists), WATCH);
  const by = Object.fromEntries(pool.map((k) => [k.kw, k]));
  assert.equal(pool[0].kw, 'couple watches');
  assert.equal(by['couple watches'].demand, 100);
  assert.equal(by['couple watches'].tier, 'high');
  assert.ok(by['leopard watch'].demand < by['couple watches'].demand);
  assert.equal(by['leopard watch'].tier, 'low');
  // A plain Map of counts (no places known) still works: every phrase weighs its count.
  assert.equal(keywordPool(counts(lists.flat()), WATCH)[0].kw, 'couple watches');
});

test('verifyPool asks Google only about unverified candidates, drops none, puts rejected ones last', async () => {
  const JHUMKA = { product: 'gold-tone jhumka earrings', product_type: 'jhumka earrings', key_terms: [], details: 'gold tone' };
  const pool = keywordPool(counts(['price of jhumka gold earrings', 'jhumka earrings for women', 'best jhumka earrings gold']), JHUMKA);
  const asked = [];
  const google = { 'jhumka gold earrings': ['jhumka gold earrings design'], 'jhumka earrings gold': [], 'jhumka earrings': ['jhumka earrings for women'] };
  const out = await verifyPool(pool, async (q) => { asked.push(q); return google[q] || []; });
  assert.ok(!asked.includes('jhumka earrings for women'), 'already verified: not asked again');
  const by = Object.fromEntries(out.map((k) => [k.kw, k]));
  assert.equal(by['jhumka gold earrings'].searched, true); // Google offers a longer search starting with it
  assert.equal(by['jhumka earrings gold'].searched, false); // neither it nor its shorter form leads to it
  assert.equal(out.at(-1).kw, 'jhumka earrings gold');
  assert.equal(out.length, pool.length);
  // Google down: the candidate stays unknown, nothing throws.
  const again = await verifyPool(keywordPool(counts(['price of jhumka gold earrings']), JHUMKA), async () => { throw new Error('offline'); });
  assert.equal(again[0].searched, null);
});

test('verifyPool asks at most `max` candidates (the host limits outside requests per call)', async () => {
  const JHUMKA = { product: 'jhumka earrings', product_type: 'jhumka earrings', key_terms: [], details: 'gold silver black red' };
  const pool = keywordPool(counts(['price of gold jhumka earrings', 'price of silver jhumka earrings', 'price of black jhumka earrings', 'price of red jhumka earrings']), JHUMKA);
  assert.equal(pool.filter((k) => k.searched == null).length, 4);
  await verifyPool(pool, async (q) => [q], { max: 2 });
  assert.equal(pool.filter((k) => k.searched === true).length, 2);
  assert.equal(pool.filter((k) => k.searched == null).length, 2);
});

test('the products this tool drafted are listed from the shop, newest first', async () => {
  const { runsFromProducts } = await import('../lib/qa.mjs');
  const light = [
    { id: 1, name: 'Hand-made product', status: 'publish', slug: 'a', permalink: 'https://vaxaura.com/product/a/', meta_data: [{ key: 'rank_math_focus_keyword', value: 'x' }] },
    { id: 2, name: 'Old tool draft &#8211; Pendant', status: 'draft', slug: 'b', permalink: '', date_created_gmt: '2026-10-01T10:00:00', meta_data: [{ key: 'vaxaura_review_note', value: 'note' }, { key: 'rank_math_focus_keyword', value: 'gold pendant, chain' }] },
    { id: 3, name: 'New tool draft', status: 'publish', slug: 'c', permalink: 'https://vaxaura.com/product/c/', meta_data: [{ key: 'vaxaura_drafted_at', value: '2026-11-05T09:00:00.000Z' }, { key: 'vaxaura_draft_score', value: '100' }, { key: 'rank_math_focus_keyword', value: 'couple watch set' }] },
  ];
  const runs = runsFromProducts(light, 'https://vaxaura.com');
  assert.deepEqual(runs.map((r) => r.id), [3, 2]);
  assert.equal(runs[0].score, 100);
  assert.equal(runs[0].keyword, 'couple watch set');
  assert.equal(runs[0].editUrl, 'https://vaxaura.com/wp-admin/post.php?post=3&action=edit');
  assert.equal(runs[1].name, 'Old tool draft – Pendant');
  assert.equal(runs[1].at, '2026-10-01T10:00:00');
  assert.equal(runs[1].score, null);
});
