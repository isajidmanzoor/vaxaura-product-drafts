import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaheed } from '../lib/ai.mjs';

// Shape of naheed.pk/searchautocomplete/ajax/suggest/?q=loreal%20foundation as answered on 2026-11-01.
const SAMPLE = {
  totalItems: 13, query: 'loreal foundation',
  indexes: [
    { identifier: 'magento_catalog_category', items: [{ name: 'Health &amp; Beauty', url: 'https://www.naheed.pk/health-beauty' }] },
    { identifier: 'magento_search_query', items: [{ query_text: 'loreal foundation', num_results: '13' }] },
    {
      identifier: 'magento_catalog_product',
      items: [
        { id: '73611', sku: 'IC-1237551', name: 'L&#039;Oreal Paris Infallible 24Hrs Fresh Wear Powder Foundation, Full Matte Coverage, Waterproof, 120, Vanilla, 9g', url: 'https://www.naheed.pk/l-oreal-paris-infallible-24hrs-fresh-wear-powder-foundation-full-matte-coverage-waterproof-120-vanilla-9g', imageUrl: 'https://media.naheed.pk/catalog/product/cache/x/1/2/1237551-1.jpg', price: 'Rs. 5,499', stockStatus: 2, rating: '80.0000', reviews: '1' },
        { id: '142371', name: 'AJF Jewelry Box For Rings Earrings &amp; Necklaces', url: 'https://www.naheed.pk/ajf-box?utm_source=website', imageUrl: '', price: 'Rs. 1,550', rating: 0, reviews: 0 },
        { id: '1', name: 'No price', url: 'https://www.naheed.pk/x', price: '' },
        { id: '2', name: 'Elsewhere', url: 'https://evil.example/x', price: 'Rs. 10' },
      ],
    },
  ],
};

test('Naheed.pk search feed: products with prices, ratings and clean links', () => {
  const items = parseNaheed(SAMPLE);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'naheed-73611',
    name: "L'Oreal Paris Infallible 24Hrs Fresh Wear Powder Foundation, Full Matte Coverage, Waterproof, 120, Vanilla, 9g",
    price: 5499, original: null, reviews: 1, rating: 4, brand: '', sponsored: false,
    image: 'https://media.naheed.pk/catalog/product/cache/x/1/2/1237551-1.jpg',
    url: 'https://www.naheed.pk/l-oreal-paris-infallible-24hrs-fresh-wear-powder-foundation-full-matte-coverage-waterproof-120-vanilla-9g',
    store: 'Naheed',
  });
  assert.equal(items[1].name, 'AJF Jewelry Box For Rings Earrings & Necklaces');
  assert.equal(items[1].url, 'https://www.naheed.pk/ajf-box');
  assert.equal(items[1].rating, null);
  assert.deepEqual(parseNaheed({ totalItems: 0, indexes: [] }), []);
  assert.deepEqual(parseNaheed(null), []);
});
