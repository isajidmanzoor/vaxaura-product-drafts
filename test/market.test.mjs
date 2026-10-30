// Titles are real Daraz.pk search results seen on 2026-10-30.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, queryPlan, stats, parseHints, charm, suggestPrice, unsupportedClaims } from '../lib/market.mjs';

const stLondon = { brand: 'ST London', product_type: 'foundation', key_terms: ['matt fusion'] };

test('other brands and look-alikes are not counted as the same product', () => {
  assert.equal(classify('ST London Matt Fusion Foundation SPF 20 - 30ml', stLondon), 'exact');
  assert.equal(classify('M2N LONDON BB Waterproof SPF30 Essence Foundation 60ml', stLondon), 'different');
  assert.equal(classify('Sweet Touch London ST Imperfections Eraser Foundation SPF 15', stLondon), 'different');
  assert.equal(classify('Rose Longstay Matte Foundation SPF 15 | Long Lasting Full Coverage', stLondon), 'different');
  assert.equal(classify('ST London Wet & Dry Compact Powder', stLondon), 'different');
});

test('unbranded jewellery: same design is exact, other hearts are similar or different', () => {
  const pendant = { brand: '', product_type: 'pendant', key_terms: ['triple', 'black heart'] };
  assert.equal(classify('Triple Black Heart Pendant Necklace Gold Plated Chain', pendant), 'exact');
  assert.equal(classify('Black Heart Pendant Necklace for Girls', pendant), 'similar');
  assert.equal(classify('Butterfly Heart Necklace Open Locket I Love You Pendant', pendant), 'different');
  // "black" and "heart" are not next to each other: the rules say different; the AI photo check
  // decides look-alikes like this one.
  assert.equal(classify('Heart Shape Obsidian Stone Black Crystal Pendant Natural', pendant), 'different');
  assert.equal(classify('Red / Black plated My Love Dual Broken Heart Pendant', pendant), 'different');
});

test('branded cosmetics with spelling variants', () => {
  const loreal = { brand: "L'Oréal", product_type: 'face wash', key_terms: ['glycolic bright'] };
  assert.equal(classify('Carrefour Loreal Paris Glycolic Bright Glowing Daily Face Wash 100ml', loreal), 'exact');
  assert.equal(classify('Gluta White Face Wash - Vitamin C & Glycolic Acid', loreal), 'different');
  // Same product, named "Cleanser Foam" instead of "face wash".
  assert.equal(classify("L'Oréal Paris Glycolic-Bright Glowing Daily Cleanser Foam with Glycolic Acid", loreal), 'exact');
  // Brands must match as written: these are other sellers' brands.
  assert.equal(classify('STs London Silk Effect Foundation', stLondon), 'different');
});

test('search plan goes from specific to broad', () => {
  const q = queryPlan({ brand: '', product_type: 'pendant', key_terms: ['triple', 'black heart'] }, ['triple black heart pendant necklace']);
  assert.equal(q[0], 'triple black heart pendant necklace');
  assert.ok(q.includes('triple black heart pendant'));
  assert.ok(q.length >= 2 && q.length <= 5);
});

test('price statistics drop outliers', () => {
  const s = stats([999, 1049, 1099, 1150, 1199, 12000]);
  assert.equal(s.dropped, 1);
  assert.equal(s.max, 1199);
  assert.equal(stats([]), null);
});

test('owner notes are read for cost, prices and stock', () => {
  assert.deepEqual(parseHints('stainless steel, 20 pieces in stock, cost price Rs 600'), { cost: 600, sale: null, regular: null, stock: 20 });
  assert.deepEqual(parseHints('Price Rs 1,500 and sale price 1,199'), { cost: null, sale: 1199, regular: 1500, stock: null });
  assert.equal(parseHints('').cost, null);
});

test('charm prices end in 49 or 99', () => {
  assert.equal(charm(1099), 1099);
  assert.equal(charm(1250), 1249);
  assert.equal(charm(933), 949);
  assert.equal(charm(2190), 2199);
});

test('price suggestion: exact matches lead, cost margin is kept, notes win', () => {
  const exact = [{ price: 2199 }, { price: 2499 }, { price: 2600 }];
  const a = suggestPrice({ exact, hints: {} });
  assert.equal(a.basis, 'exact');
  assert.equal(a.sale, 2499);
  assert.ok(a.regular > a.sale);
  const b = suggestPrice({ similar: [{ price: 300 }, { price: 400 }, { price: 500 }], shop: [{ sale_price: '1099' }, { sale_price: '1199' }], hints: { cost: 1000 } });
  assert.ok(b.sale >= 1300, `margin kept: ${b.sale}`);
  const c = suggestPrice({ exact, hints: { sale: 1999, regular: 2500 } });
  assert.deepEqual([c.sale, c.regular, c.basis], [1999, 2500, 'notes']);
  assert.equal(suggestPrice({}).sale, null);
});

test('claims the photos cannot prove are flagged unless notes or label say so', () => {
  assert.deepEqual(unsupportedClaims('<p>Made of <b>real gold</b>, 100% original and hypoallergenic.</p>', '').map((c) => c.label),
    ['real gold/silver', 'hypoallergenic', 'original / authentic']);
  assert.deepEqual(unsupportedClaims('Original ST London foundation, waterproof formula', 'original st london, label: waterproof'), []);
  assert.deepEqual(unsupportedClaims('Gold-tone heart pendant with crystal-style stones', ''), []);
});

test('a key term that only repeats the type is not used in searches', () => {
  const q = queryPlan({ brand: 'EMINENT', product_type: 'face wash', key_terms: ['citrus glow', 'vitamin c', 'facewash'] });
  assert.ok(q.every((x) => !/facewash face wash/.test(x)), q.join(' | '));
  assert.ok(q.includes('eminent face wash'), q.join(' | '));
});

test('reasons read well for a single listing', () => {
  const a = suggestPrice({ similar: [{ price: 1000 }], shop: [{ sale_price: '1199' }, { sale_price: '1199' }], hints: {} });
  assert.match(a.why[0], /1 listing, Rs 1000\./);
});
