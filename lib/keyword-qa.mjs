// Keyword & URL QA and the keyword cannibalization report (read-only).
// - keywordQa: one product's URL (slug) and keywords: is the keyword a real Google search, is it in
//   the URL / title / meta / first sentence / main photo, is the URL clean, does another product
//   target it; plus better keywords and URL from Google that no other product uses.
// - cannibalReport: every group of products competing for the same search, which one keeps the
//   keyword, and free real-search keywords for the others.
// - keywordCheck: is a keyword free before it is used?
// Google autocomplete is passed in (`suggest`) so the logic can be tested without the network.

import { words, slugify, decode, stripHtml, seoAudit, shopFromProducts } from './woo.mjs';
import { keywordPool, cannibalization, splitKeywords, stem } from './keywords.mjs';

// Words the shop's products are described with, so suggestions may use them (gold heart pendant).
const DESCRIPTORS = 'black white gold golden silver rose pink red green blue purple brown grey gray beige maroon emerald ruby pearl crystal '
  + 'stone steel metal leather heart star moon butterfly flower leaf clover infinity cross square round oval drop bow bridal choker chain '
  + 'locket stud hoop matte matt glow bright tone two';

// A product link, slug or ID -> { id } or { slug }. Links must point at the shop itself.
export function parseProductRef(input, site) {
  const s = String(input || '').trim();
  if (/^#?\d+$/.test(s)) return { id: Number(s.replace('#', '')) };
  if (/^[a-z0-9][a-z0-9-]*$/i.test(s) && s.includes('-')) return { slug: s.toLowerCase() };
  let u = null;
  if (/[./]/.test(s)) { try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { /* not a link */ } }
  if (!u) throw Object.assign(new Error('Enter a product ID, a product link (vaxaura.com/product/...) or its URL slug.'), { status: 400 });
  const shopHost = new URL(site).hostname.replace(/^www\./, '');
  if (u.hostname.replace(/^www\./, '') !== shopHost) throw Object.assign(new Error(`That link is not on ${shopHost}.`), { status: 400 });
  const id = u.searchParams.get('p') || u.searchParams.get('post');
  if (id && /^\d+$/.test(id)) return { id: Number(id) };
  const parts = u.pathname.split('/').filter(Boolean);
  const slug = parts[0] === 'product' ? parts[1] : parts.at(-1);
  if (!slug) throw Object.assign(new Error('That link does not point at a product.'), { status: 400 });
  return { slug: decodeURIComponent(slug).toLowerCase() };
}

// URL checks that need no network. focus: the focus keyword (plain words).
export function urlChecks(slug, url, focus) {
  const out = [];
  const add = (label, status, info = '') => out.push({ group: 'URL', label, status, info });
  const parts = String(slug || '').split('-').filter(Boolean);
  const kwSlug = focus ? slugify(focus) : '';
  add('Focus keyword in the URL', !focus ? 'fail' : (`-${slug}-`).includes(`-${kwSlug}-`) ? 'pass' : 'fail', slug);
  add('URL 75 characters or less', url.length <= 75 ? 'pass' : 'fail', `${url.length} chars`);
  const seen = new Set(), repeated = new Set();
  for (const w of parts) { if (w.length > 2 && w !== 'vaxaura') { if (seen.has(w)) repeated.add(w); seen.add(w); } }
  add('No repeated words in the URL', repeated.size ? 'warn' : 'pass', repeated.size ? [...repeated].join(', ') : '');
  // vax-1001, vax1002, vav-2311, 2310 (internal codes say nothing to shoppers or Google)
  const code = parts.filter((w, i) => /^va[xv]\d+$/.test(w) || (/^va[xv]$/.test(w) && /^\d+$/.test(parts[i + 1] || '')) || /^\d{3,}$/.test(w));
  add('No product code in the URL', code.length ? 'warn' : 'pass', code.join('-'));
  const kwWords = new Set(kwSlug.split('-'));
  const extra = parts.filter((w) => !kwWords.has(w) && w !== 'vaxaura');
  add('URL is the keyword (+ “vaxaura”), nothing more', extra.length > 2 ? 'warn' : 'pass', extra.length ? `extra: ${extra.join(', ')}` : '');
  add('Lowercase letters, numbers and hyphens only', /^[a-z0-9-]+$/.test(slug) ? 'pass' : 'fail', '');
  return out;
}

// A Google search counts as real when autocomplete offers the phrase itself or longer searches
// that start with it.
export const isSearched = (kw, suggestions) => (suggestions || []).some((s) => { const w = words(s).join(' '); return w === kw || w.startsWith(kw + ' '); });

// Google often offers a full phrase only while it is being typed ("black couple watch" ->
// "black couple watch set"), so the phrase one word shorter is asked too. null: Google did not answer.
export async function searchState(kw, suggest) {
  const own = await suggest(kw);
  if (own == null) return null;
  if (isSearched(kw, own)) return true;
  const ws = kw.split(' ');
  if (ws.length < 2) return false;
  const shorter = await suggest(ws.slice(0, -1).join(' '));
  return !!shorter && isSearched(kw, shorter);
}

const count = (lists) => { const m = new Map(); for (const k of lists.flat()) { const x = String(k).toLowerCase().trim(); m.set(x, (m.get(x) || 0) + 1); } return m; };
const safe = (suggest) => (q) => Promise.resolve(suggest(q)).catch(() => null);

// The identification the keyword pool needs, rebuilt from a saved product.
function identFor(pr, cats = []) {
  const its = (pr.categories || []).map((c) => cats.find((x) => x.id === c.id) || c);
  const child = its.find((c) => c.parent) || its[0];
  const name = decode(pr.name);
  return {
    product: name, product_type: child ? decode(child.name) : name.split(/[–-]/).pop(),
    details: `${stripHtml(pr.short_description).slice(0, 400)} ${DESCRIPTORS}`, label_text: '', brand: '',
    key_terms: its.map((c) => decode(c.name)),
  };
}

// Free real-search keywords for a product: Google suggestions for its keywords and type.
async function alternatives(pr, cats, used, suggest, seeds) {
  const ident = identFor(pr, cats);
  const qs = [...new Set([...seeds, ident.product_type].map((s) => words(s).join(' ')).filter(Boolean))].slice(0, 4);
  const lists = (await Promise.all(qs.flatMap((q) => [suggest(q), suggest(`${q} price in pakistan`)]))).filter(Boolean);
  // Searches with the product's own words (heart, emerald, leopard) come before generic ones
  // ("pendants for men"), however often those are searched.
  const generic = new Set([...words(ident.product_type), ...(ident.key_terms || []).flatMap((t) => words(t)), 'vaxaura'].map(stem));
  const own = new Set(words(ident.product).map(stem).filter((w) => w.length > 2 && !generic.has(w)));
  const mine = (k) => k.kw.split(' ').some((w) => own.has(stem(w)));
  return keywordPool(count(lists), ident, used).sort((a, b) => mine(b) - mine(a) || b.score - a.score).slice(0, 6);
}

export async function keywordQa(pr, all, cats, { suggest, site }) {
  suggest = safe(suggest);
  const shop = shopFromProducts(all, pr.id);
  const meta = Object.fromEntries((pr.meta_data || []).map((m) => [m.key, m.value]));
  const kws = splitKeywords(meta.rank_math_focus_keyword);
  const [focus = '', ...secondary] = kws;
  const listing = {
    name: decode(pr.name), slug: pr.slug, description: pr.description, short_description: pr.short_description, embed_images: false,
    images: (pr.images || []).map((i) => ({ media_id: i.id, alt: i.alt, update_media: true })), reviews_allowed: pr.reviews_allowed,
    seo: { title: String(meta.rank_math_title || ''), description: String(meta.rank_math_description || ''), focus_keyword: String(meta.rank_math_focus_keyword || '') },
  };
  const audit = seoAudit(listing, { shop });
  const url = pr.status === 'publish' && pr.permalink ? pr.permalink : `${site}/product/${pr.slug}/`;
  const checks = urlChecks(pr.slug, url, focus);
  const add = (group, label, status, info = '') => checks.push({ group, label, status, info: String(info) });

  add('Keyword', 'Focus keyword set', focus ? 'pass' : 'fail', focus || 'none');
  const searched = await Promise.all([focus, ...secondary.slice(0, 3)].filter(Boolean).map((k) => searchState(k, suggest)));
  if (focus) {
    const fw = focus.split(' ');
    add('Keyword', 'Focus keyword 2–4 words, no price/Pakistan/buy', fw.length >= 2 && fw.length <= 4 && !/\b(price|prices|pakistan|buy|online|best|cheap|sale)\b/.test(focus) ? 'pass' : 'fail', focus);
    add('Keyword', 'Focus keyword is a real Google search', searched[0] == null ? 'warn' : searched[0] ? 'pass' : 'fail',
      searched[0] == null ? 'Google did not answer' : searched[0] ? '' : 'Google does not offer this search');
  }
  secondary.slice(0, 3).forEach((k, i) => {
    const st = searched[i + 1];
    add('Keyword', `Secondary keyword “${k}” is searched`, st == null ? 'warn' : st ? 'pass' : 'warn', st === false ? 'Google does not offer this search' : '');
  });
  const T = Object.fromEntries(audit.tests.map((t) => [t.id, t]));
  const place = [['kwTitle', 'In the SEO title'], ['kwTitleStart', 'At the start of the SEO title'], ['kwMeta', 'In the meta description'],
    ['kw10', 'In the first sentence of both descriptions'], ['kwContent', 'In the long description'], ['kwAlt', 'In the main photo’s alt text']];
  for (const [id, label] of place) if (T[id]) add('Placement', label, T[id].pass ? 'pass' : 'fail', id === 'kwTitle' ? listing.seo.title : '');
  if (T.density) add('Placement', 'Keyword density 1–2.5%', T.density.pass ? 'pass' : 'warn', T.density.info);

  for (const c of audit.conflicts) add('Cannibalization', `Clash with #${c.id} ${c.name}`, c.severity === 'high' ? 'fail' : 'warn', c.reason);
  if (focus && !audit.conflicts.length) add('Cannibalization', 'No other product targets these keywords', 'pass', '');

  const used = [...shop.flatMap((o) => o.keywords)];
  const suggestions = await alternatives(pr, cats, used, suggest, [focus, focus.split(' ').slice(-2).join(' ')]);
  const best = suggestions.find((s) => s.kw !== focus);
  const focusSearched = !!focus && searched[0] === true;
  const suggestedSlug = best && (!focusSearched || audit.conflicts.some((c) => c.severity === 'high')) ? slugify(best.kw) + '-vaxaura' : null;
  return {
    url, slug: pr.slug, focus, secondary, live: pr.status === 'publish', checks,
    summary: { pass: checks.filter((c) => c.status === 'pass').length, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length },
    suggestions, suggestedSlug,
  };
}

// The product that keeps a contested keyword: live before draft, then the better SEO score, then the older one.
export function pickKeeper(members) {
  return [...members].sort((a, b) => (b.status === 'publish') - (a.status === 'publish') || b.score - a.score || a.id - b.id)[0];
}

// Products that compete for the same searches, joined into groups (A–B and B–C make one group).
export function clashGroups(shop) {
  const parent = new Map(shop.map((p) => [p.id, p.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const links = [];
  for (const p of shop) {
    for (const c of cannibalization({ keywords: p.keywords }, shop.filter((o) => o.id !== p.id))) {
      links.push({ a: p.id, b: c.id, severity: c.severity, keyword: c.keyword, reason: c.reason });
      parent.set(find(p.id), find(c.id));
    }
  }
  const groups = new Map();
  for (const l of links) {
    const g = find(l.a);
    if (!groups.has(g)) groups.set(g, { ids: new Set(), links: [], severity: 'medium' });
    const x = groups.get(g);
    x.ids.add(l.a); x.ids.add(l.b);
    if (!x.links.some((y) => (y.a === l.b && y.b === l.a) || (y.a === l.a && y.b === l.b))) x.links.push(l);
    if (l.severity === 'high') x.severity = 'high';
  }
  return [...groups.values()].map((g) => ({
    severity: g.severity, ids: [...g.ids],
    // The searched phrase they fight over: the shortest keyword involved.
    keyword: g.links.map((l) => l.keyword).sort((a, b) => a.length - b.length)[0],
    links: g.links,
  })).sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) || b.ids.length - a.ids.length);
}

export async function cannibalReport(all, cats, { suggest }) {
  suggest = safe(suggest);
  const shop = shopFromProducts(all);
  const byId = new Map(all.map((p) => [p.id, p]));
  const used = shop.flatMap((o) => o.keywords);
  const groups = clashGroups(shop);
  for (const g of groups) {
    g.members = g.ids.map((id) => {
      const pr = byId.get(id), o = shop.find((x) => x.id === id);
      const meta = Object.fromEntries(pr.meta_data.map((m) => [m.key, m.value]));
      const score = seoAudit({
        name: decode(pr.name), slug: pr.slug, description: pr.description, short_description: pr.short_description, embed_images: false,
        images: pr.images.map((i) => ({ media_id: i.id, alt: i.alt, update_media: true })), reviews_allowed: pr.reviews_allowed,
        seo: { title: String(meta.rank_math_title || ''), description: String(meta.rank_math_description || ''), focus_keyword: String(meta.rank_math_focus_keyword || '') },
      }, { shop: shop.filter((x) => x.id !== id) }).score;
      return { id, name: o.name, status: o.status, url: o.url, slug: pr.slug, keywords: o.keywords, score };
    });
    const keep = pickKeeper(g.members);
    g.keep = keep.id;
    const taken = [...used];
    g.fixes = [];
    for (const m of g.members.filter((x) => x.id !== keep.id)) {
      // Only a secondary keyword clashes: dropping it is enough (focus keyword and URL stay).
      const [focus, ...secondary] = m.keywords;
      const own = cannibalization({ keywords: m.keywords }, shop.filter((o) => o.id !== m.id));
      const clashing = [...new Set(own.map((c) => c.keyword))];
      if (focus && own.length && clashing.every((k) => k !== focus && secondary.includes(k))) {
        g.fixes.push({
          id: m.id, name: m.name, live: m.status === 'publish', type: 'secondary', from: focus, to: focus, drop: clashing,
          secondary: secondary.filter((k) => !clashing.includes(k)), alternatives: [], slug: null,
        });
        continue;
      }
      const alts = await alternatives(byId.get(m.id), cats, taken, suggest, [m.keywords[0] || '', decode(byId.get(m.id).name)]);
      const pick = alts[0];
      if (pick) taken.push(pick.kw); // two products never get the same new keyword
      g.fixes.push({
        id: m.id, name: m.name, live: m.status === 'publish', type: 'focus', from: m.keywords[0] || '', to: pick?.kw || null, alternatives: alts.map((a) => a.kw),
        slug: pick ? slugify(pick.kw) + '-vaxaura' : null,
      });
    }
    delete g.ids;
  }
  const involved = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  return {
    at: new Date().toISOString(),
    totals: { products: shop.length, groups: groups.length, high: groups.filter((g) => g.severity === 'high').length, medium: groups.filter((g) => g.severity === 'medium').length, involved: involved.size, noKeyword: shop.filter((o) => !o.keywords.length).length },
    groups,
  };
}

export async function keywordCheck(keyword, all, { suggest }) {
  suggest = safe(suggest);
  const kw = words(keyword).join(' ');
  if (kw.split(' ').length < 1 || !kw) throw Object.assign(new Error('Type a keyword to check.'), { status: 400 });
  const shop = shopFromProducts(all);
  const conflicts = cannibalization({ keywords: [kw] }, shop);
  const [searched, own, priced] = await Promise.all([searchState(kw, suggest), suggest(kw), suggest(`${kw} price in pakistan`)]);
  const ident = { product: kw, product_type: kw, details: DESCRIPTORS, key_terms: [], label_text: '', brand: '' };
  const related = keywordPool(count([own || [], priced || []]), ident, shop.flatMap((o) => o.keywords)).filter((k) => k.kw !== kw).slice(0, 8);
  const high = conflicts.filter((c) => c.severity === 'high');
  const kwWords = kw.split(' ');
  const shape = kwWords.length >= 2 && kwWords.length <= 4 && !/\b(price|prices|pakistan|buy|online|best|cheap|sale)\b/.test(kw);
  return {
    keyword: kw, searched, shape, conflicts, related,
    verdict: high.length ? 'taken' : !shape ? 'shape' : searched === false ? 'unsearched' : conflicts.length ? 'overlap' : 'free',
  };
}
