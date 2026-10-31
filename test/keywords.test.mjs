import test from 'node:test';
import assert from 'node:assert/strict';
import { keywordPool, cannibalization, stem } from '../lib/keywords.mjs';
import { seoAudit, nextSku, skuPrefix, hiddenCategory } from '../lib/woo.mjs';
import { grade, SKU_FORMAT } from '../lib/qa.mjs';

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

const SHOP = [
  { id: 536, name: 'Leopard Couple Watches', status: 'publish', keywords: ['couple watches', 'black couple watch set'] },
  { id: 374, name: 'Emerald Heart Pendant', status: 'publish', keywords: ['heart pendant', 'green heart necklace'] },
  { id: 271, name: 'Triple Black Heart Pendant', status: 'publish', keywords: ['black heart pendant'] },
];

test('cannibalization: same focus, their secondary, my secondary, overlap', () => {
  const sev = (kws) => cannibalization({ keywords: kws }, SHOP).map((c) => `${c.id}:${c.severity}`);
  assert.deepEqual(sev(['couple watches']), ['536:high']);
  assert.deepEqual(sev(['black couple watch set']), ['536:high']); // their secondary keyword
  assert.deepEqual(sev(['silver watch', 'heart pendant']), ['374:high']); // my secondary is their focus
  assert.deepEqual(sev(['gold heart pendant']), ['374:medium']); // "heart pendant" inside mine
  assert.deepEqual(sev(['butterfly earrings']), []);
  assert.deepEqual(cannibalization({ keywords: [] }, SHOP), []);
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
  assert.equal(by['Long description 350+ words'].status, 'pass');
  assert.equal(g.metrics.photos.length, 4);
});
