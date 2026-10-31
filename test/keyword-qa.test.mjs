import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductRef, urlChecks, isSearched, pickKeeper, clashGroups, keywordQa, cannibalReport, keywordCheck } from '../lib/keyword-qa.mjs';

const SITE = 'https://vaxaura.com';

test('product link, slug or ID', () => {
  assert.deepEqual(parseProductRef('536', SITE), { id: 536 });
  assert.deepEqual(parseProductRef('#536', SITE), { id: 536 });
  assert.deepEqual(parseProductRef('vaxaura.com/product/couple-watches-black-metal-vaxaura/', SITE), { slug: 'couple-watches-black-metal-vaxaura' });
  assert.deepEqual(parseProductRef('https://www.vaxaura.com/product/ruby-choker-set/?utm=x', SITE), { slug: 'ruby-choker-set' });
  assert.deepEqual(parseProductRef('https://vaxaura.com/?post_type=product&p=1011', SITE), { id: 1011 });
  assert.deepEqual(parseProductRef('https://vaxaura.com/wp-admin/post.php?post=530&action=edit', SITE), { id: 530 });
  assert.deepEqual(parseProductRef('gold-clover-pendant', SITE), { slug: 'gold-clover-pendant' });
  assert.throws(() => parseProductRef('https://daraz.pk/products/x', SITE), /not on vaxaura\.com/);
  assert.throws(() => parseProductRef('hello', SITE), /product ID/);
});

const byLabel = (list) => Object.fromEntries(list.map((c) => [c.label, c]));

test('URL checks', () => {
  let c = byLabel(urlChecks('couple-watches-black-metal-vaxaura', `${SITE}/product/couple-watches-black-metal-vaxaura/`, 'couple watches black metal'));
  assert.equal(c['Focus keyword in the URL'].status, 'pass');
  assert.equal(c['No repeated words in the URL'].status, 'pass');
  c = byLabel(urlChecks('couple-watches-black-metal-vaxaura', `${SITE}/product/couple-watches-black-metal-vaxaura/`, 'black couple watch set'));
  assert.equal(c['Focus keyword in the URL'].status, 'fail');
  c = byLabel(urlChecks('triple-black-heart-pendant-heart-pendant', `${SITE}/product/triple-black-heart-pendant-heart-pendant/`, 'black heart pendant'));
  assert.equal(c['No repeated words in the URL'].status, 'warn');
  assert.match(c['No repeated words in the URL'].info, /heart, pendant/);
  for (const slug of ['gold-bow-heart-pendant-vax-1001', 'crystal-butterfly-stud-earrings-vax1002', 'pink-stanley-water-bottle-tumbler-vav-2311']) {
    assert.equal(byLabel(urlChecks(slug, `${SITE}/product/${slug}/`, 'x y'))['No product code in the URL'].status, 'warn', slug);
  }
  assert.equal(byLabel(urlChecks('gold-heart-pendant-vaxaura', `${SITE}/product/gold-heart-pendant-vaxaura/`, 'gold heart pendant'))['No product code in the URL'].status, 'pass');
  c = byLabel(urlChecks('vaxaura-infinity-cross-ring-two-tone-crossover-statement-ring', `${SITE}/product/vaxaura-infinity-cross-ring-two-tone-crossover-statement-ring/`, 'cross ring'));
  assert.equal(c['URL 75 characters or less'].status, 'fail');
  assert.equal(c['URL is the keyword (+ “vaxaura”), nothing more'].status, 'warn');
  assert.equal(byLabel(urlChecks('x', `${SITE}/product/x/`, ''))['Focus keyword in the URL'].status, 'fail');
});

test('a keyword is searched when Google offers it or longer searches starting with it', () => {
  assert.equal(isSearched('couple watches', ['couple watches', 'couple watches price']), true);
  assert.equal(isSearched('couple watches', ['couple watches in pakistan']), true);
  assert.equal(isSearched('couple watches black metal', []), false);
  assert.equal(isSearched('heart pendant', ['heart pendants for girls']), false);
});

test('who keeps a contested keyword: live, then SEO, then older', () => {
  assert.equal(pickKeeper([{ id: 9, status: 'draft', score: 100 }, { id: 5, status: 'publish', score: 70 }]).id, 5);
  assert.equal(pickKeeper([{ id: 9, status: 'publish', score: 95 }, { id: 5, status: 'publish', score: 70 }]).id, 9);
  assert.equal(pickKeeper([{ id: 9, status: 'publish', score: 80 }, { id: 5, status: 'publish', score: 80 }]).id, 5);
});

const shop = [
  { id: 374, name: 'Emerald Heart Pendant', status: 'publish', keywords: ['heart pendant'] },
  { id: 271, name: 'Triple Black Heart Pendant', status: 'publish', keywords: ['black heart pendant'] },
  { id: 253, name: 'Gold Bow Heart Pendant', status: 'publish', keywords: ['heart pendant'] },
  { id: 536, name: 'Leopard Couple Watches', status: 'publish', keywords: ['couple watches black metal', 'couple watches'] },
  { id: 900, name: 'Couple Watch Draft', status: 'draft', keywords: ['couple watches'] },
  { id: 34, name: 'Gold Face Vase', status: 'publish', keywords: ['gold face vase'] },
];

test('clash groups join products that compete for the same searches', () => {
  const g = clashGroups(shop);
  assert.equal(g.length, 2);
  const hearts = g.find((x) => x.ids.includes(374));
  assert.deepEqual(hearts.ids.sort(), [253, 271, 374]);
  assert.equal(hearts.severity, 'high');
  assert.equal(hearts.keyword, 'heart pendant');
  const watches = g.find((x) => x.ids.includes(536));
  assert.deepEqual(watches.ids.sort(), [536, 900]);
  assert.equal(watches.keyword, 'couple watches');
  assert.ok(!g.some((x) => x.ids.includes(34)));
});

// Saved products as WooCommerce returns them.
const product = (id, name, slug, kw, status = 'publish', catId = 49) => ({
  id, name, slug, status, permalink: `${SITE}/product/${slug}/`, categories: [{ id: catId }], reviews_allowed: true,
  short_description: `<p>${name} by Vaxaura</p>`, description: `<p><strong>${kw.split(',')[0]}</strong> ${'text '.repeat(200)}</p>`,
  images: [{ id: 1, alt: `${kw.split(',')[0]} by Vaxaura` }],
  meta_data: [{ key: 'rank_math_focus_keyword', value: kw }, { key: 'rank_math_title', value: `${kw.split(',')[0]} Stunning | Vaxaura` }, { key: 'rank_math_description', value: kw.split(',')[0] }],
});
const cats = [{ id: 49, parent: 50, name: 'Pendants' }, { id: 50, parent: 0, name: 'Jewellery' }, { id: 141, parent: 0, name: 'Couple Watches' }];
const GOOGLE = {
  'couple watches black metal': [],
  'couple watches': ['couple watches', 'couple watches price in pakistan', 'couple watches rolex', 'black couple watch set'],
  'black metal': ['black metal band'],
  'couple watches price in pakistan': ['couple watches price in pakistan'],
  'heart pendant': ['heart pendant', 'gold heart pendant', 'heart pendant price in pakistan', 'heart pendant for girls'],
  'emerald heart pendant': ['emerald heart pendant', 'green heart pendant'],
  'pendants': ['pendants for girls', 'gold heart pendant', 'green heart pendant'],
};
const suggest = async (q) => GOOGLE[q] || [];

test('keyword & URL QA of the couple watches link', async () => {
  const watch = product(536, 'Leopard Couple Watches Black Metal – Skeleton Dial Watch Set', 'couple-watches-black-metal-vaxaura', 'couple watches black metal, couple watches', 'publish', 141);
  const all = [watch, product(900, 'Couple Watch Draft', 'couple-watch-draft', 'couple watches', 'draft', 141)];
  const k = await keywordQa(watch, all, cats, { suggest, site: SITE });
  const c = byLabel(k.checks);
  assert.equal(k.url, `${SITE}/product/couple-watches-black-metal-vaxaura/`);
  assert.equal(k.focus, 'couple watches black metal');
  assert.equal(c['Focus keyword is a real Google search'].status, 'fail');
  assert.equal(c['Secondary keyword “couple watches” is searched'].status, 'pass');
  assert.equal(c['Focus keyword in the URL'].status, 'pass');
  assert.equal(c['Clash with #900 Couple Watch Draft'].status, 'fail'); // my secondary "couple watches" is their focus keyword
  assert.ok(k.suggestions.length > 0);
  assert.ok(!k.suggestions.some((s) => s.kw === 'couple watches'), 'keywords another product uses are not suggested');
  assert.ok(!k.suggestions.some((s) => /rolex|price/.test(s.kw)));
  assert.equal(k.suggestedSlug, 'black-couple-watch-set-vaxaura');
  assert.equal(k.live, true);
});

test('cannibalization report: groups, keeper and a different free keyword for each other product', async () => {
  const all = [
    product(374, 'Emerald Heart Pendant – Heart Pendant', 'emerald-heart-pendant-heart-pendant', 'heart pendant'),
    product(253, 'Gold Bow Heart Pendant', 'gold-bow-heart-pendant-vax-1001', 'heart pendant'),
    product(271, 'Triple Black Heart Pendant', 'triple-black-heart-pendant-heart-pendant', 'black heart pendant', 'draft'),
  ];
  const r = await cannibalReport(all, cats, { suggest });
  assert.equal(r.totals.groups, 1);
  const g = r.groups[0];
  assert.equal(g.severity, 'high');
  assert.equal(g.keep, 253); // live, same SEO score as 374, older id
  const fixes = Object.fromEntries(g.fixes.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(fixes).map(Number).sort(), [271, 374]);
  const tos = g.fixes.map((f) => f.to).filter(Boolean);
  assert.equal(new Set(tos).size, tos.length, 'never the same new keyword twice');
  for (const t of tos) assert.ok(!['heart pendant', 'black heart pendant'].includes(t));
  assert.equal(fixes[374].live, true);
  assert.match(fixes[374].slug || '', /-vaxaura$/);
});

test('keyword check: taken, overlap, unsearched, shape, free', async () => {
  const all = [product(374, 'Emerald Heart Pendant', 'emerald-heart-pendant', 'heart pendant')];
  assert.equal((await keywordCheck('Heart Pendant', all, { suggest })).verdict, 'taken');
  assert.equal((await keywordCheck('gold heart pendant', all, { suggest: async () => ['gold heart pendant'] })).verdict, 'overlap');
  assert.equal((await keywordCheck('couple watches black metal', all, { suggest })).verdict, 'unsearched');
  assert.equal((await keywordCheck('watch price in pakistan', all, { suggest })).verdict, 'shape');
  const free = await keywordCheck('couple watches', all, { suggest });
  assert.equal(free.verdict, 'free');
  assert.equal(free.searched, true);
  assert.ok(free.related.some((x) => x.kw === 'black couple watch set'));
  // Google down: no crash, the keyword is judged on the shop alone
  assert.equal((await keywordCheck('couple watches', all, { suggest: async () => { throw new Error('offline'); } })).searched, null);
});

test('Google echoing an unsearched phrase back is not a search (real answers, 2026-10-31)', async () => {
  const { realSuggestions } = await import('../lib/ai.mjs');
  const echo = ['couple watches black metal', ['couple watches black metal'], [], { 'google:suggestsubtypes': [[22, 30]] }];
  assert.deepEqual(realSuggestions('couple watches black metal', echo), []);
  const real = ['couple watches', ['couple watches', 'couple watches in pakistan'], [], { 'google:suggestsubtypes': [[512, 433, 131], [512]] }];
  assert.deepEqual(realSuggestions('couple watches', real), ['couple watches', 'couple watches in pakistan']);
  const black = ['black couple watches', ['black couple watches', 'black couple watches titan'], [], { 'google:suggestsubtypes': [[512], [22, 30]] }];
  assert.deepEqual(realSuggestions('Black  Couple Watches', black), ['black couple watches', 'black couple watches titan']);
  assert.deepEqual(realSuggestions('x', null), []);
});

test('a phrase Google offers while it is typed counts as searched', async () => {
  const { searchState } = await import('../lib/keyword-qa.mjs');
  const g = { 'black couple watch set': [], 'black couple watch': ['black couple watch', 'black couple watch set'], 'made up thing': [], 'made up': ['made up words'] };
  const s = async (q) => g[q] || [];
  assert.equal(await searchState('black couple watch set', s), true);
  assert.equal(await searchState('made up thing', s), false);
  assert.equal(await searchState('x', async () => null), null);
});

test('alternatives with the product’s own words come before generic searches', async () => {
  const pr = product(374, 'Emerald Heart Pendant – Heart Pendant', 'emerald-heart-pendant-heart-pendant', 'heart pendant');
  const other = product(253, 'Gold Bow Heart Pendant', 'gold-bow', 'heart pendant');
  const g = { pendants: ['pendants for men', 'pendants for men', 'pendants for women', 'gold heart pendant'], 'pendants price in pakistan': ['pendants for men'] };
  const r = await cannibalReport([pr, other], cats, { suggest: async (q) => g[q] || [] });
  const fix = r.groups[0].fixes[0];
  assert.equal(fix.to, 'gold heart pendant');
});

test('a clash through a secondary keyword is fixed by removing it, not by a new focus keyword', async () => {
  const a = product(498, 'Gold Pearl Necklace', 'gold-pearl-necklace-vaxaura', 'gold pearl necklace');
  const b = product(510, 'White Enamel Pendant', 'white-enamel-pendant-vaxaura', 'white enamel pendant, gold pearl necklace', 'publish');
  const r = await cannibalReport([a, b], cats, { suggest: async () => [] });
  const fix = r.groups[0].fixes[0];
  assert.equal(r.groups[0].keep, 498);
  assert.equal(fix.type, 'secondary');
  assert.deepEqual(fix.drop, ['gold pearl necklace']);
  assert.equal(fix.to, 'white enamel pendant');
});
