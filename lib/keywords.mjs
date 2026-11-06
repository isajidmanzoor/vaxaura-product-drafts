// Keyword research and cannibalization.
// The focus keyword is chosen from what Pakistanis really type into Google (autocomplete), cleaned
// of shopping words; and a new listing is checked against the keywords the shop's own products
// already target, so two Vaxaura pages never compete for the same search.

import { words } from './woo.mjs';

// Shopping words people add to a search; they belong in the title and text, not in the focus keyword.
const NOISE = /\b(price in pakistan|in pakistan|price list|prices?|pakistan|pk|buy|online|best|cheap|sale|discount|daraz|naheed|olx|near me|shop|store|wholesale|for sale|with price|rate)\b/g;
// Searches that are not for a product page (brand lists, pictures, how-to ...).
const NOT_PRODUCT = /\b(brands?|designs?|images?|pics?|pictures?|photos?|ideas?|meaning|videos?|tiktok|drawing|png|logo|wallpaper|quotes?|captions?|emoji|song|lyrics|movie|how|what|why|which|vs|reviews?|repair|tutorial|diy|real or fake)\b/;
// Plain shopper words a keyword may contain besides what the photo shows.
const GENERIC = new Set(['for', 'and', 'with', 'of', 'the', 'a', 'women', 'woman', 'men', 'man', 'girls', 'girl', 'boys', 'boy', 'ladies', 'lady', 'gents', 'kids',
  'set', 'pair', 'new', 'latest', 'stylish', 'fancy', 'simple', 'unique', 'gift', 'gifts', 'luxury', 'small', 'mini', 'big', 'large', 'daily', 'wear',
  'party', 'bridal', 'wedding', 'casual', 'formal', 'couple', 'couples', 'him', 'her', 'his', 'female', 'male', 'unisex', 'trendy', 'cute', 'elegant', 'classic', 'modern']);
const TYPE_FILLER = new Set(['set', 'pair', 'for', 'and', 'with', 'of', 'the', 'women', 'men', 'girls', 'ladies', 'kit']);
// A search that starts or ends with a joining word once the shopping words are removed ("price of
// jhumka gold earrings" -> "of jhumka gold earrings") is the plain phrase without it.
const EDGE = new Set(['of', 'for', 'and', 'with', 'the', 'a', 'an', 'in', 'to', 'on', 'at', 'by']);

// watches -> watch, necklaces -> necklace, earrings -> earring, glasses -> glass
export function stem(w) {
  if (w.length <= 3) return w;
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const stems = (s) => words(s).map(stem);

// A Google search counts as real when autocomplete offers the phrase itself or longer searches
// that start with it. (The research, the audit and the QA all judge a keyword this one way.)
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

// Google orders autocomplete by how much each phrase is searched, so where a phrase sits in an answer
// is a demand signal. lists: one array of suggestions per query asked. Returns Map phrase -> { hits
// (answers that carried it), weight (1 for the first place, 1/2 for the second ...) }.
export function suggestionStats(lists) {
  const m = new Map();
  for (const list of lists || []) {
    (list || []).forEach((raw, i) => {
      const k = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
      if (!k) return;
      const s = m.get(k) || { hits: 0, weight: 0 };
      s.hits += 1; s.weight += 1 / (1 + i);
      m.set(k, s);
    });
  }
  return m;
}

const norm = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
// Demand tiers: relative to the best candidate of this product (not a monthly volume - Google gives none for free).
export const demandTier = (demand) => (demand >= 60 ? 'high' : demand >= 30 ? 'medium' : 'low');

// suggestions: Map or [[phrase, timesSuggested], ...] from Google autocomplete, or the Map from
// suggestionStats (which also knows the places the phrases had).
// ident: the photo identification (product, product_type, key_terms, details, label_text, brand).
// used: focus keywords other products already have (never offered again).
// Returns [{ kw, hits, score, demand, tier, searched }] best first: real searches for this kind of
// product, made only of words the photo/label backs up or plain shopper words (so no other brand's
// name). searched: true when Google offered the phrase itself (or longer searches starting with it);
// null when the phrase only came out of a longer search once the shopping words were removed
// ("price of jhumka gold earrings" -> "jhumka gold earrings") and still has to be verified.
// demand: 0-100 against the best candidate, from the places the phrase had in Google's answers and
// how many longer searches extend it (the long tail of a searched phrase); tier: high/medium/low.
export function keywordPool(suggestions, ident = {}, used = []) {
  const type = stems(ident.product_type || '').filter((w) => !TYPE_FILLER.has(w));
  const roots = new Set(type.length ? type : stems(ident.product || ''));
  const known = new Set(stems([ident.product, ident.product_type, ident.details, ident.label_text, ident.brand, ...(ident.key_terms || [])].join(' ')));
  const special = new Set(stems([ident.brand, ...(ident.key_terms || [])].join(' ')));
  const taken = new Set(used.map((u) => words(u).join(' ')));
  const entries = [...(suggestions instanceof Map ? suggestions : new Map(suggestions))]
    .map(([raw, v]) => [norm(raw), typeof v === 'object' && v ? { hits: v.hits || 1, weight: v.weight ?? v.hits ?? 1 } : { hits: v || 1, weight: v || 1 }]);
  // Every search Google really offered, in plain words: the real-search check and the long tail.
  const offered = entries.map(([text]) => words(text).join(' '));
  const pool = new Map();
  for (const [text, v] of entries) {
    if (NOT_PRODUCT.test(text)) continue;
    const ws = words(text.replace(NOISE, ' '));
    while (ws.length && EDGE.has(ws[0])) ws.shift();
    while (ws.length && EDGE.has(ws.at(-1))) ws.pop();
    const kw = ws.join(' ');
    if (ws.length < 2 || ws.length > 4 || taken.has(kw)) continue;
    const st = ws.map(stem);
    if (!st.some((w) => roots.has(w))) continue; // not this kind of product
    if (!st.every((w, i) => known.has(w) || GENERIC.has(ws[i]) || GENERIC.has(w))) continue; // e.g. another brand
    const hit = pool.get(kw) || { kw, hits: 0, weight: 0, special: st.filter((w) => special.has(w)).length, long: ws.length >= 3 };
    hit.hits += v.hits;
    hit.weight += v.weight;
    pool.set(kw, hit);
  }
  for (const k of pool.values()) {
    k.searched = isSearched(k.kw, offered) ? true : null;
    k.tail = offered.filter((s) => s !== k.kw && s.startsWith(k.kw + ' ')).length;
    k.raw = k.weight + 0.5 * k.tail;
  }
  const top = Math.max(0, ...[...pool.values()].map((k) => k.raw)) || 1;
  const out = [...pool.values()].map((k) => ({
    kw: k.kw, hits: k.hits,
    score: k.raw + 0.75 * k.special + (k.long ? 0.25 : 0),
    demand: Math.round((k.raw / top) * 100), tier: demandTier(Math.round((k.raw / top) * 100)),
    searched: k.searched,
  }));
  return out.sort((a, b) => b.score - a.score || a.kw.length - b.kw.length).slice(0, 12);
}

// Candidates that came out of a longer search ("price of jhumka gold earrings" -> "jhumka gold
// earrings") are asked from Google one by one, the way the QA asks later, so the writer never gets a
// keyword the QA then rejects. max: a call may make only so many outside requests on Cloudflare's
// free plan, so only the best unverified candidates are asked (each costs 1-2 requests).
// Verified searches come first; a phrase Google does not offer goes last (shown, never chosen).
const VERIFIED_RANK = { true: 0, null: 1, undefined: 1, false: 2 };
export async function verifyPool(pool, suggest, { max = 3 } = {}) {
  const ask = (q) => Promise.resolve().then(() => suggest(q)).catch(() => null);
  const todo = pool.filter((k) => k.searched == null).slice(0, max);
  const states = await Promise.all(todo.map((k) => searchState(k.kw, ask)));
  todo.forEach((k, i) => { k.searched = states[i]; });
  return pool.sort((a, b) => VERIFIED_RANK[a.searched] - VERIFIED_RANK[b.searched] || b.score - a.score);
}

const has = (hay, needle) => (' ' + hay + ' ').includes(' ' + needle + ' ');
const RANK = { high: 0, medium: 1 };

// mine: { keywords: [focus, ...secondary] }. shop: [{ id, name, status, url, keywords: [focus, ...secondary] }].
// high   = the same search would show two Vaxaura pages (must change);
// medium = the keywords overlap (one contains the other); worth a look, not blocking.
// A shop product's keywords in plain words, computed once per object: the shop report and the
// cannibalization report compare every product with every other, and re-tokenising the keywords
// on each pass was most of their CPU time with a big shop.
const NORMALIZED = new WeakMap();
function theirKeywords(o) {
  let t = NORMALIZED.get(o);
  if (!t) { t = (o.keywords || []).map((k) => words(k).join(' ')).filter(Boolean); NORMALIZED.set(o, t); }
  return t;
}

// excludeId: the product itself when `shop` still contains it.
export function cannibalization(mine, shop, excludeId) {
  const kws = (mine.keywords || []).map((k) => words(k).join(' ')).filter(Boolean);
  const [kw, ...secondary] = kws;
  if (!kw) return [];
  const out = [];
  for (const o of shop || []) {
    if (excludeId != null && o.id === excludeId) continue;
    const theirs = theirKeywords(o);
    const [focus] = theirs;
    // kind says which side the fix is on: same / their-secondary / overlap = change a focus keyword
    // (mine or theirs); my-secondary = drop that secondary keyword from mine.
    const add = (severity, reason, keyword, kind) => out.push({ id: o.id, name: o.name, status: o.status, url: o.url || '', severity, reason, keyword, kind });
    if (focus && focus === kw) add('high', `uses the same focus keyword “${kw}”`, kw, 'same');
    else if (theirs.includes(kw)) add('high', `targets your focus keyword “${kw}” as a secondary keyword`, kw, 'their-secondary');
    else if (focus && secondary.includes(focus)) add('high', `its focus keyword “${focus}” is one of your secondary keywords`, focus, 'my-secondary');
    // The contested search is the shorter phrase, contained in the other ("heart pendant").
    else if (focus && (has(kw, focus) || has(focus, kw))) add('medium', `keywords overlap: yours “${kw}”, theirs “${focus}”`, has(kw, focus) ? focus : kw, 'overlap');
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// The keyword pool with each candidate's standing against the shop (free, or overlap: a shorter or
// longer form is another product's focus keyword), plus the real searches left out because another
// Vaxaura product already targets them (taken) - so the owner sees the cannibalization on the
// research screen, not only after the listing is written.
// shop: [{ id, name, status, url, keywords: [focus, ...secondary] }] (shopFromCtx / shopFromProducts).
export function keywordReport(suggestions, ident = {}, shop = []) {
  const used = [...new Set(shop.flatMap((o) => o.keywords || []))];
  const pool = keywordPool(suggestions, ident, used).map((k) => {
    const conflicts = cannibalization({ keywords: [k.kw] }, shop);
    return { ...k, status: conflicts.length ? 'overlap' : 'free', conflicts };
  });
  const normKw = (k) => words(k).join(' ');
  const usedSet = new Set(used.map(normKw));
  const taken = keywordPool(suggestions, ident, []).filter((k) => usedSet.has(k.kw)).map((k) => ({
    kw: k.kw, hits: k.hits, demand: k.demand, tier: k.tier,
    by: shop.filter((o) => (o.keywords || []).map(normKw).includes(k.kw))
      .map((o) => ({ id: o.id, name: o.name, status: o.status, url: o.url || '', focus: normKw(o.keywords[0] || '') === k.kw })),
  }));
  return { pool, taken };
}

// Product keywords as Rank Math stores them ("focus, secondary, secondary").
export const splitKeywords = (s) => String(s || '').split(',').map((k) => words(k).join(' ')).filter(Boolean);
