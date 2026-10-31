// Keyword research and cannibalization.
// The focus keyword is chosen from what Pakistanis really type into Google (autocomplete), cleaned
// of shopping words; and a new listing is checked against the keywords the shop's own products
// already target, so two Vaxaura pages never compete for the same search.

import { words } from './woo.mjs';

// Shopping words people add to a search; they belong in the title and text, not in the focus keyword.
const NOISE = /\b(price in pakistan|in pakistan|price list|prices?|pakistan|pk|buy|online|best|cheap|sale|discount|daraz|olx|near me|shop|store|wholesale|for sale|with price|rate)\b/g;
// Searches that are not for a product page (brand lists, pictures, how-to ...).
const NOT_PRODUCT = /\b(brands?|designs?|images?|pics?|pictures?|photos?|ideas?|meaning|videos?|tiktok|drawing|png|logo|wallpaper|quotes?|captions?|emoji|song|lyrics|movie|how|what|why|which|vs|reviews?|repair|tutorial|diy|real or fake)\b/;
// Plain shopper words a keyword may contain besides what the photo shows.
const GENERIC = new Set(['for', 'and', 'with', 'of', 'the', 'a', 'women', 'woman', 'men', 'man', 'girls', 'girl', 'boys', 'boy', 'ladies', 'lady', 'gents', 'kids',
  'set', 'pair', 'new', 'latest', 'stylish', 'fancy', 'simple', 'unique', 'gift', 'gifts', 'luxury', 'small', 'mini', 'big', 'large', 'daily', 'wear',
  'party', 'bridal', 'wedding', 'casual', 'formal', 'couple', 'couples', 'him', 'her', 'his', 'female', 'male', 'unisex', 'trendy', 'cute', 'elegant', 'classic', 'modern']);
const TYPE_FILLER = new Set(['set', 'pair', 'for', 'and', 'with', 'of', 'the', 'women', 'men', 'girls', 'ladies', 'kit']);

// watches -> watch, necklaces -> necklace, earrings -> earring, glasses -> glass
export function stem(w) {
  if (w.length <= 3) return w;
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const stems = (s) => words(s).map(stem);

// suggestions: Map or [[phrase, timesSuggested], ...] from Google autocomplete.
// ident: the photo identification (product, product_type, key_terms, details, label_text, brand).
// used: focus keywords other products already have (never offered again).
// Returns [{ kw, hits, score }] best first: real searches for this kind of product, made only of
// words the photo/label backs up or plain shopper words (so no other brand's name).
export function keywordPool(suggestions, ident = {}, used = []) {
  const type = stems(ident.product_type || '').filter((w) => !TYPE_FILLER.has(w));
  const roots = new Set(type.length ? type : stems(ident.product || ''));
  const known = new Set(stems([ident.product, ident.product_type, ident.details, ident.label_text, ident.brand, ...(ident.key_terms || [])].join(' ')));
  const special = new Set(stems([ident.brand, ...(ident.key_terms || [])].join(' ')));
  const taken = new Set(used.map((u) => words(u).join(' ')));
  const pool = new Map();
  for (const [raw, n] of suggestions instanceof Map ? suggestions : new Map(suggestions)) {
    const text = String(raw).toLowerCase();
    if (NOT_PRODUCT.test(text)) continue;
    const ws = words(text.replace(NOISE, ' '));
    const kw = ws.join(' ');
    if (ws.length < 2 || ws.length > 4 || taken.has(kw)) continue;
    const st = ws.map(stem);
    if (!st.some((w) => roots.has(w))) continue; // not this kind of product
    if (!st.every((w, i) => known.has(w) || GENERIC.has(ws[i]) || GENERIC.has(w))) continue; // e.g. another brand
    const hit = pool.get(kw) || { kw, hits: 0, score: 0 };
    hit.hits += n || 1;
    hit.score = hit.hits + 0.75 * st.filter((w) => special.has(w)).length + (ws.length >= 3 ? 0.25 : 0);
    pool.set(kw, hit);
  }
  return [...pool.values()].sort((a, b) => b.score - a.score || a.kw.length - b.kw.length).slice(0, 12);
}

const has = (hay, needle) => (' ' + hay + ' ').includes(' ' + needle + ' ');
const RANK = { high: 0, medium: 1 };

// mine: { keywords: [focus, ...secondary] }. shop: [{ id, name, status, url, keywords: [focus, ...secondary] }].
// high   = the same search would show two Vaxaura pages (must change);
// medium = the keywords overlap (one contains the other); worth a look, not blocking.
export function cannibalization(mine, shop) {
  const kws = (mine.keywords || []).map((k) => words(k).join(' ')).filter(Boolean);
  const [kw, ...secondary] = kws;
  if (!kw) return [];
  const out = [];
  for (const o of shop || []) {
    const theirs = (o.keywords || []).map((k) => words(k).join(' ')).filter(Boolean);
    const [focus] = theirs;
    const add = (severity, reason, keyword) => out.push({ id: o.id, name: o.name, status: o.status, url: o.url || '', severity, reason, keyword });
    if (focus && focus === kw) add('high', `uses the same focus keyword “${kw}”`, kw);
    else if (theirs.includes(kw)) add('high', `targets your focus keyword “${kw}” as a secondary keyword`, kw);
    else if (focus && secondary.includes(focus)) add('high', `its focus keyword “${focus}” is one of your secondary keywords`, focus);
    // The contested search is the shorter phrase, contained in the other ("heart pendant").
    else if (focus && (has(kw, focus) || has(focus, kw))) add('medium', `keywords overlap: yours “${kw}”, theirs “${focus}”`, has(kw, focus) ? focus : kw);
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// Product keywords as Rank Math stores them ("focus, secondary, secondary").
export const splitKeywords = (s) => String(s || '').split(',').map((k) => words(k).join(' ')).filter(Boolean);
