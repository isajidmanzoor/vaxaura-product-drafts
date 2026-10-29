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
