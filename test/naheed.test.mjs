import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaheed, naheedPlan, parseDaraz, searchLinks } from '../lib/ai.mjs';

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

test('Naheed gets the most specific query and the two broadest', () => {
  const plan = ['stanley quencher h2.0 tumbler mint green', 'stanley water bottle tumbler mint green', 'stanley quencher tumbler', 'stanley mint green tumbler', 'stanley tumbler'];
  assert.deepEqual(naheedPlan(plan), ['stanley quencher h2.0 tumbler mint green', 'stanley tumbler', 'stanley mint green tumbler']);
  assert.deepEqual(naheedPlan(['face wash']), ['face wash']);
  assert.deepEqual(naheedPlan(['a b', 'c d']), ['a b', 'c d']);
  assert.deepEqual(naheedPlan([]), []);
});

test('Daraz listings link to the exact variant that was priced, only on daraz.pk', () => {
  const items = parseDaraz({ mods: { listItems: [
    { itemId: '1958312692', skuId: '14019169992', itemUrl: '//www.daraz.pk/products/100-279695-i1958312692.html?search=1', name: 'Loreal Glycolic Bright Cleanser', price: '954', adFlag: '0', image: '//img.drz.lazcdn.com/a.jpg' },
    { itemId: '2', skuId: '3', itemUrl: '//www.daraz.pk/products/x-i2-s3.html', name: 'Already a variant link', price: '100', adFlag: '1' },
    { itemId: '4', itemUrl: '//ads.example.com/click?x', name: 'Ad elsewhere', price: '100' },
  ] } });
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://www.daraz.pk/products/100-279695-i1958312692-s14019169992.html');
  assert.equal(items[0].sponsored, false);
  assert.equal(items[0].image, 'https://img.drz.lazcdn.com/a.jpg');
  assert.equal(items[1].url, 'https://www.daraz.pk/products/x-i2-s3.html');
  assert.equal(items[1].sponsored, true);
});

test('search links open the same searches on Daraz and Naheed', () => {
  assert.deepEqual(searchLinks([{ q: 'loreal face wash', found: 40 }], [{ q: "l'oreal cleanser", found: 3 }]), [
    { store: 'Daraz', q: 'loreal face wash', found: 40, url: 'https://www.daraz.pk/catalog/?q=loreal%20face%20wash' },
    { store: 'Naheed', q: "l'oreal cleanser", found: 3, url: "https://www.naheed.pk/catalogsearch/result/?q=l'oreal%20cleanser" },
  ]);
});
