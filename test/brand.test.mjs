import test from 'node:test';
import assert from 'node:assert/strict';
import { calmestY } from '../public/brand.js';
import { stripShopBrand } from '../lib/market.mjs';

// A w×h grayscale "photo": flat background with noisy detail (the product) in the given rows.
function photo(w, h, busyFrom, busyTo) {
  const g = new Uint8ClampedArray(w * h).fill(120);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let y = Math.round(busyFrom * h); y < Math.round(busyTo * h); y++) {
    for (let x = Math.round(w * 0.2); x < Math.round(w * 0.8); x++) g[y * w + x] = Math.round(rand() * 255);
  }
  return g;
}

test('a plain photo gets the logo a little above the middle', () => {
  assert.equal(calmestY(photo(96, 96, 0, 0), 96, 96), 0.42);
});

test('the logo moves off the product to the calm part of the photo', () => {
  // Product in the middle (like a pendant): the logo goes above it.
  const y = calmestY(photo(96, 96, 0.38, 0.7), 96, 96);
  assert.ok(y <= 0.28, `expected above the product, got ${y}`);
  // Product high up (like a necklace with the neck below): the logo goes below it.
  const y2 = calmestY(photo(96, 96, 0.15, 0.4), 96, 96);
  assert.ok(y2 >= 0.5, `expected below the product, got ${y2}`);
});

test('works for portrait and landscape photos and stays in range', () => {
  for (const [w, h] of [[96, 140], [96, 54]]) {
    const y = calmestY(photo(w, h, 0.4, 0.6), w, h);
    assert.ok(y >= 0.2 && y <= 0.62, `${w}x${h}: ${y}`);
  }
});

test('the shop watermark is never taken as the product brand or a search term', () => {
  const ident = stripShopBrand({
    brand: 'VAXAURA', label_text: 'VAXAURA www.vaxaura.com EMINENT CITRUS GLOW',
    key_terms: ['vaxaura', 'citrus glow'], search_seeds: ['vaxaura face wash', 'citrus glow face wash'], daraz_queries: ['www.vaxaura.com'],
  });
  assert.equal(ident.brand, '');
  assert.equal(ident.label_text, 'EMINENT CITRUS GLOW');
  assert.deepEqual(ident.key_terms, ['citrus glow']);
  assert.deepEqual(ident.search_seeds, ['face wash', 'citrus glow face wash']);
  assert.deepEqual(ident.daraz_queries, []);
  // A real brand stays untouched.
  assert.equal(stripShopBrand({ brand: "L'Oréal", label_text: 'GLYCOLIC BRIGHT' }).brand, "L'Oréal");
});
