import test from 'node:test';
import assert from 'node:assert/strict';
import { swapImages, tidySku, skuProposals } from '../lib/maintenance.mjs';

const newMedia = (id) => ({ id, source_url: `https://vaxaura.com/wp-content/uploads/2026/11/new-${id}.webp`, media_details: { width: 1600, height: 1600, sizes: { large: { source_url: `https://vaxaura.com/wp-content/uploads/2026/11/new-${id}-1024x1024.webp`, width: 1024, height: 1024 } } } });

test('photos inside the description switch to the new ones, alt kept', () => {
  // As on vaxaura.com (#510).
  const html = '<p>Intro</p>\n<p><img class="aligncenter size-large wp-image-507" src="https://vaxaura.com/wp-content/uploads/2026/10/vaxaura-enamel-pearl-leaf-pendant-by-vaxaura3-1024x1024.jpg" alt="White enamel pendant &quot;by&quot; Vaxaura" width="1024" height="1024" /></p>'
    + '<p><img class="aligncenter size-large wp-image-508" src="https://vaxaura.com/wp-content/uploads/2026/10/vaxaura-enamel-pearl-leaf-pendant-by-vaxaura4-1-1024x1024.jpg" alt="Close up" width="1024" height="1024" /></p>'
    + '<p><img src="https://vaxaura.com/wp-content/uploads/2026/10/vaxaura-enamel-pearl-leaf-pendant-by-vaxaura3-300x300.jpg" alt="no class, smaller size"></p>'
    + '<p><img class="wp-image-5070" src="https://vaxaura.com/other.jpg" alt="another photo"></p>';
  const swaps = [{ oldId: 507, oldBase: 'vaxaura-enamel-pearl-leaf-pendant-by-vaxaura3', newMedia: newMedia(901), alt: 'x' }];
  const { html: out, n } = swapImages(html, swaps);
  assert.equal(n, 2);
  assert.match(out, /wp-image-901" src="https:\/\/vaxaura\.com\/wp-content\/uploads\/2026\/11\/new-901-1024x1024\.webp" alt="White enamel pendant &quot;by&quot; Vaxaura"/);
  assert.match(out, /alt="no class, smaller size"/);
  assert.match(out, /wp-image-508/); // not swapped
  assert.match(out, /wp-image-5070/); // a different photo whose ID starts the same
  assert.doesNotMatch(out, /vaxaura3-1024x1024\.jpg|vaxaura3-300x300\.jpg/);
  assert.equal(swapImages('<p>text</p>', swaps).n, 0);
});

test('untidy SKUs keep their number in the shop format', () => {
  assert.equal(tidySku('vax – JP04'), 'VAX-JP04');
  assert.equal(tidySku('vax- jp03'), 'VAX-JP03');
  assert.equal(tidySku('Vax-JP02'), 'VAX-JP02');
  assert.equal(tidySku('VAX-JP07'), 'VAX-JP07');
  assert.equal(tidySku('VAX2310'), null); // no letters for the category
  assert.equal(tidySku(''), null);
});

const cats = [{ id: 49, parent: 50, slug: 'pendants', name: 'Pendants' }, { id: 50, parent: 0, slug: 'jewellery', name: 'Jewellery' }, { id: 33, parent: 0, slug: 'tumblers', name: 'Tumblers' }, { id: 78, parent: 33, slug: 'stanley', name: 'Stanley' }, { id: 25, parent: 50, slug: 'rings', name: 'Rings' }];
const p = (id, sku, catIds) => ({ id, name: `Product ${id}`, status: 'publish', sku, categories: catIds.map((c) => ({ id: c })) });

test('SKU proposals: tidy when free, next number otherwise, never a duplicate', () => {
  const products = [
    p(271, 'vax – JP04', [49, 50]), p(363, 'vax- jp03', [49, 50]), p(276, 'Vax-JP02', [49, 50]), p(272, 'Vax-JP01', [49, 50]),
    p(374, 'VAX-JP06', [49, 50]), p(999, 'vax jp06', [49, 50]), // tidy form taken by #374
    p(122, 'VAX2310', [33, 78]), p(128, '', [33, 78]), p(127, '', [33, 78]),
    p(94, '', [25, 50]), p(93, '', [25, 50]), p(5, '', []),
  ];
  const r = Object.fromEntries(skuProposals(products, cats, ['VAX-JR01']).map((x) => [x.id, x.proposed]));
  assert.equal(r[271], 'VAX-JP04');
  assert.equal(r[363], 'VAX-JP03');
  assert.equal(r[276], 'VAX-JP02');
  assert.equal(r[272], 'VAX-JP01');
  assert.equal(r[374], undefined); // already fine
  assert.equal(r[999], 'VAX-JP07'); // VAX-JP06 is #374's
  assert.deepEqual([r[122], r[128], r[127]], ['VAX-T01', 'VAX-T02', 'VAX-T03']); // Stanley shares the tumbler numbers
  assert.deepEqual([r[94], r[93]], ['VAX-JR02', 'VAX-JR03']); // VAX-JR01 is on a trashed product
  assert.equal(r[5], 'VAX-P01');
  const all = Object.values(r);
  assert.equal(new Set(all).size, all.length);
});
