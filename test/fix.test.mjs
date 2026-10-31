import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceInText, planFix } from '../lib/fix.mjs';
import { configure } from '../lib/woo.mjs';

configure({ VAXAURA_SITE: 'https://vaxaura.com', VAXAURA_WP_USER: 'u', VAXAURA_WP_APP_PASSWORD: 'stub' });

test('the keyword is replaced in the text only, keeping its case', () => {
  const html = '<h3>Why You’ll Love This Couple Watches Black Metal</h3><p><strong>couple watches black metal</strong> for him and her.</p>'
    + '<img src="https://vaxaura.com/couple-watches-black-metal.webp" alt="couple watches black metal by Vaxaura"><p>COUPLE WATCHES BLACK METAL</p>';
  const { html: out, n } = replaceInText(html, 'couple watches black metal', 'black couple watch set');
  assert.equal(n, 3);
  assert.match(out, /Love This Black Couple Watch Set<\/h3>/);
  assert.match(out, /<strong>black couple watch set<\/strong>/);
  assert.match(out, /BLACK COUPLE WATCH SET/);
  assert.match(out, /src="https:\/\/vaxaura\.com\/couple-watches-black-metal\.webp" alt="couple watches black metal by Vaxaura"/); // tags untouched
  assert.equal(replaceInText('<p>heart pendants and a heart pendant</p>', 'heart pendant', 'gold heart pendant').html, '<p>heart pendants and a gold heart pendant</p>');
  assert.equal(replaceInText('<p>x</p>', '', 'y').n, 0);
});

const product = (o = {}) => ({
  id: 536, name: 'Leopard Couple Watches Black Metal – Skeleton Dial Watch Set', slug: 'couple-watches-black-metal-vaxaura', status: 'publish',
  permalink: 'https://vaxaura.com/product/couple-watches-black-metal-vaxaura/', date_modified_gmt: '2026-10-31T10:00:00', reviews_allowed: true,
  short_description: '<p>Discover <strong>couple watches black metal by Vaxaura</strong>.</p>',
  description: '<p><strong>couple watches black metal</strong> ' + 'nice words for the watch set here. '.repeat(60) + '</p><img src="a.webp" alt="x">',
  images: [{ id: 11, alt: 'Couple watches black metal by Vaxaura' }, { id: 12, alt: 'Side view' }],
  meta_data: [{ key: 'rank_math_focus_keyword', value: 'couple watches black metal, couple watches, leopard watch' },
    { key: 'rank_math_title', value: 'Couple Watches Black Metal Stunning Set | Vaxaura' }, { key: 'rank_math_description', value: 'Buy couple watches black metal in Pakistan with Cash on Delivery.' }],
  ...o,
});
const other = { id: 900, name: 'Couple Watch Draft', slug: 'couple-watches-vaxaura', status: 'draft', meta_data: [{ key: 'rank_math_focus_keyword', value: 'couple watches' }] };

test('fix plan: new keyword everywhere, clashing secondary dropped, URL free, score shown', () => {
  const p = planFix(product(), [product(), other], { keyword: 'Black Couple Watch Set' });
  assert.equal(p.keyword, 'black couple watch set');
  assert.equal(p.from, 'couple watches black metal');
  assert.equal(p.after.title, 'Black Couple Watch Set Stunning Set | Vaxaura');
  assert.equal(p.after.meta, 'Buy black couple watch set in Pakistan with Cash on Delivery.');
  assert.equal(p.after.alt, 'Black Couple Watch Set by Vaxaura');
  assert.equal(p.after.slug, 'black-couple-watch-set-vaxaura');
  assert.equal(p.after.focus_keyword, 'black couple watch set, leopard watch'); // "couple watches" is #900's focus
  assert.deepEqual(p.textChanges, { description: 1, short_description: 1 });
  assert.equal(p.live, true);
  assert.equal(p.urlAfter, 'https://vaxaura.com/product/black-couple-watch-set-vaxaura/');
  assert.ok(!p.conflicts.some((c) => c.severity === 'high'));
  assert.equal(p.full.description.includes('<strong>black couple watch set</strong>'), true);
});

test('fix plan: keyword missing from the old fields is put in front; long titles fit 60 characters', () => {
  const pr = product({ meta_data: [{ key: 'rank_math_focus_keyword', value: '' }, { key: 'rank_math_title', value: 'Leopard Skeleton Dial Watch Pair for Him and Her in Black | Vaxaura' }, { key: 'rank_math_description', value: '' }] });
  const p = planFix(pr, [pr], { keyword: 'couple watches' });
  assert.ok(p.after.title.startsWith('Couple Watches – Leopard'));
  assert.ok(p.after.title.length <= 60, p.after.title);
  assert.equal(p.after.meta, 'Couple Watches by Vaxaura.');
  assert.deepEqual(p.textChanges, { description: 0, short_description: 0 });
});

test('fix plan: the owner’s own values win; taken slugs and bad keywords are refused', () => {
  const p = planFix(product(), [product(), other], { keyword: 'black couple watch set', edits: { title: 'My Title', slug: 'My Watch Set', secondary: 'leopard watch, black couple watch set' } });
  assert.equal(p.after.title, 'My Title');
  assert.equal(p.after.slug, 'my-watch-set');
  assert.equal(p.after.focus_keyword, 'black couple watch set, leopard watch');
  assert.throws(() => planFix(product(), [product(), other], { keyword: 'black couple watch set', edits: { slug: 'couple-watches-vaxaura' } }), /already used/);
  assert.throws(() => planFix(product(), [product()], { keyword: 'watch' }), /2–4 words/);
  assert.throws(() => planFix(product(), [product()], { keyword: 'couple watches black metal' }), /already the focus keyword/);
  // the generated slug steps aside when another product has it
  const taken = { ...other, slug: 'black-couple-watch-set-vaxaura' };
  assert.equal(planFix(product(), [product(), taken], { keyword: 'black couple watch set' }).after.slug, 'black-couple-watch-set-vaxaura-2');
});

test('old and new keyword side by side become one', () => {
  assert.equal(replaceInText('couple watches black metal, couple watches Stunning | Vaxaura', 'couple watches black metal', 'couple watches').html, 'couple watches Stunning | Vaxaura');
  assert.equal(replaceInText('<p>Couple Watches Black Metal – Couple Watches set</p>', 'couple watches black metal', 'couple watches').html, '<p>Couple Watches set</p>');
  assert.equal(replaceInText('<p>couple watches and couple watches</p>', 'x y', 'couple watches').html, '<p>couple watches and couple watches</p>'); // only after a replacement
});

test('only a secondary keyword clashes: it is dropped, URL and titles stay', () => {
  const p510 = product({ id: 510, slug: 'white-enamel-pendant-vaxaura', meta_data: [{ key: 'rank_math_focus_keyword', value: 'white enamel pendant, gold pearl necklace, heart charm' },
    { key: 'rank_math_title', value: 'White Enamel Pendant Stunning | Vaxaura' }, { key: 'rank_math_description', value: 'white enamel pendant' }] });
  const p498 = { id: 498, name: 'Gold Pearl Necklace', slug: 'gold-pearl-necklace-vaxaura', status: 'publish', meta_data: [{ key: 'rank_math_focus_keyword', value: 'gold pearl necklace' }] };
  const p = planFix(p510, [p510, p498], { keyword: 'white enamel pendant' });
  assert.equal(p.after.focus_keyword, 'white enamel pendant, heart charm');
  assert.equal(p.after.slug, 'white-enamel-pendant-vaxaura');
  assert.equal(p.after.title, 'White Enamel Pendant Stunning | Vaxaura');
  assert.deepEqual(p.textChanges, { description: 0, short_description: 0 });
  assert.ok(!p.conflicts.some((c) => c.severity === 'high'));
});

test('a secondary keyword shared with another product’s secondary stays', () => {
  const p510 = product({ id: 510, slug: 'white-enamel-pendant-vaxaura', meta_data: [{ key: 'rank_math_focus_keyword', value: 'white enamel pendant, pearl pendant necklace, gold pearl necklace' },
    { key: 'rank_math_title', value: 'White Enamel Pendant | Vaxaura' }, { key: 'rank_math_description', value: 'white enamel pendant' }] });
  const p498 = { id: 498, name: 'Gold Pearl Necklace', slug: 'gold-pearl', status: 'publish', meta_data: [{ key: 'rank_math_focus_keyword', value: 'gold pearl necklace' }] };
  const p514 = { id: 514, name: 'Mint Pearl Necklace', slug: 'mint', status: 'publish', meta_data: [{ key: 'rank_math_focus_keyword', value: 'mint green necklace, pearl pendant necklace' }] };
  assert.equal(planFix(p510, [p510, p498, p514], { keyword: 'white enamel pendant' }).after.focus_keyword, 'white enamel pendant, pearl pendant necklace');
});
