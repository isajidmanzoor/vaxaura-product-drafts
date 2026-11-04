// AI side: Claude Haiku 5.5 (Anthropic API), plus free public market data.
// 1) research: Claude identifies the product from the photos and proposes search phrases; the server
//    then pulls what Pakistanis type into Google (Google Suggest, gl=pk) and competitor listings with
//    prices and "sold" counts from Daraz.pk and Naheed.pk search.
// 2) write: turns photos + research into a full product listing as strict JSON.
// 3) repair: fixes the listing until the Rank Math audit passes.

import Anthropic from '@anthropic-ai/sdk';
import { seoAudit, slugify, words, skuPrefix, nextSku, mediaUrlForAi, possibleDuplicates } from './woo.mjs';
import { keywordPool, splitKeywords } from './keywords.mjs';
import { queryPlan, scoreListing, classify, parseHints, suggestPrice, stripShopBrand, WATERMARK_NOTE } from './market.mjs';

// The cheapest Claude model: $0.10 / $0.50 per million input / output tokens (prompts up to 100K tokens).
const MODEL = 'claude-haiku-5-5';

export class AiError extends Error {}

// One AI call per API request, answered as JSON that matches `schema`. The SDK retries a busy (429/5xx)
// answer by itself; the whole call is stopped at the request's deadline (under Vercel's 300 s).
// effort: 'low' keeps simple steps fast and cheap, 'medium' gives the listing more thought.
async function generate({ content, schema, effort }, deadline) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiError('ANTHROPIC_API_KEY is not set.');
  const left = deadline - Date.now() - 5000;
  if (left < 15000) throw new AiError('The AI ran out of time. Please try again.');
  let res;
  try {
    res = await new Anthropic({ apiKey }).messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }, { signal: AbortSignal.timeout(left) });
  } catch (e) {
    throw new AiError(aiErrorMessage(e));
  }
  if (res.stop_reason === 'refusal') throw new AiError(`The AI declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''}.`);
  if (res.stop_reason === 'max_tokens') throw new AiError('The AI answer was cut off. Please try again.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new AiError(`The AI returned an empty answer (${res.stop_reason}). Please try again.`);
  return { model: res.model, text };
}

function aiErrorMessage(e) {
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError) return 'The AI took too long. Please try again.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service. Please try again.';
  if (e instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY is not valid. Check it in Cloudflare (Settings -> Variables and Secrets).';
  if (e instanceof Anthropic.RateLimitError) return 'The AI limit has been reached. Wait a minute and try again.';
  if (e instanceof Anthropic.InternalServerError) return 'The AI service is busy right now. Please try again in a few minutes.';
  // e.g. 400 "Your credit balance is too low": the message tells the owner what to do.
  if (e instanceof Anthropic.APIError) return `The AI service returned an error (HTTP ${e.status}): ${e.error?.error?.message || e.message}`;
  return 'The AI request failed. Please try again.';
}

// Claude reads JPEG, PNG, GIF and WebP photos.
const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp)$/;
const image = (type, buf) => ({ type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } });
const say = (text) => ({ type: 'text', text });

async function imageParts(mediaIds) {
  const parts = [];
  for (const id of mediaIds) {
    const url = await mediaUrlForAi(id);
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new AiError(`Could not read photo #${id} from the Media Library (HTTP ${r.status}).`);
    const type = r.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    if (!IMAGE_TYPES.test(type)) throw new AiError(`Photo #${id} is ${type}; the AI reads JPG, PNG, GIF or WebP.`);
    parts.push(image(type, Buffer.from(await r.arrayBuffer())));
  }
  return parts;
}

function storeSummary(ctx) {
  const cats = ctx.categories.filter((c) => !c.hidden).map((c) => `${c.slug}${c.parent ? ` (child of ${c.parent})` : ''}: ${c.path || c.name}`).join('\n');
  const prices = ctx.products.filter((p) => p.status === 'publish').map((p) => `${p.name} [${p.categories.join(',')}]: Rs ${p.regular_price} / sale Rs ${p.sale_price || '-'}`).join('\n');
  return `STORE: Vaxaura (vaxaura.com), Pakistan. Jewellery, cosmetics and decor. Prices in Rs (PKR). Cash on Delivery all over Pakistan. WhatsApp orders: +92 325 5023982.\n\nCATEGORIES (slug: name):\n${cats}\n\nCURRENT VAXAURA PRICES:\n${prices}`;
}

// ---------- 1) research ----------
const ID_SCHEMA = {
  type: 'object',
  properties: {
    product: { type: 'string', description: 'what it is, one line (e.g. "gold-tone heart pendant necklace with green stones")' },
    brand: { type: 'string', description: 'brand printed on the product or packaging, exactly as written; empty string if no brand is visible' },
    product_type: { type: 'string', description: 'the generic product type in 1-2 words as shops name it (e.g. "pendant", "earrings", "ring", "foundation", "face wash", "vase")' },
    key_terms: { type: 'array', items: { type: 'string' }, description: '2-4 words or short phrases that tell THIS item apart (product line/model, motif, shape, colour), e.g. ["matt fusion"], ["triple", "black heart"]' },
    label_text: { type: 'string', description: 'all text that is printed on the product/label/packaging, verbatim (empty if none)' },
    details: { type: 'string', description: 'shape/motif, colours, finish, stones, material if visible, size cues; for cosmetics: line, size (ml/g), SPF, key ingredients' },
    confidence: { type: 'string', description: 'high, medium or low, with a reason' },
    must_confirm: { type: 'array', items: { type: 'string' } },
    categories: { type: 'array', items: { type: 'string' }, description: 'category slugs from the list that truly fit this product (child and parent); an empty array when none fits - never an unrelated category' },
    new_category: { type: 'string', description: 'only when no listed category fits: a short shop category name in Title Case for this product (e.g. "Watches", "Hair Accessories"); otherwise an empty string' },
    search_seeds: { type: 'array', items: { type: 'string' }, description: '3-5 short phrases (2-3 words, lowercase) a Pakistani shopper would start typing into Google for this item' },
    daraz_queries: { type: 'array', items: { type: 'string' }, description: '2 queries to find the same item on Daraz.pk: brand + line + type for branded items, motif + type for unbranded ones' },
  },
  required: ['product', 'brand', 'product_type', 'key_terms', 'label_text', 'details', 'confidence', 'must_confirm', 'categories', 'new_category', 'search_seeds', 'daraz_queries'],
  additionalProperties: false,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// What people in Pakistan type after a seed phrase (Google's public autocomplete, Pakistan, English).
export async function googleSuggest(seed) {
  const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&gl=pk&hl=en&q=${encodeURIComponent(seed)}`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  return realSuggestions(seed, JSON.parse(Buffer.from(await r.arrayBuffer()).toString('latin1')));
}

// When nobody searches a phrase, Google just echoes it back as the first "suggestion" (marked
// without the 512 type that real completions carry): "couple watches black metal" -> itself only.
// That echo is not evidence of a search, so it is dropped.
export function realSuggestions(seed, j) {
  const list = Array.isArray(j?.[1]) ? j[1] : [];
  const types = j?.[3]?.['google:suggestsubtypes'];
  const q = String(seed).toLowerCase().trim().replace(/\s+/g, ' ');
  return list.filter((s, i) => !(i === 0 && String(s).toLowerCase().trim() === q && Array.isArray(types?.[0]) && !types[0].includes(512)));
}

// Daraz.pk search results (best match order).
async function darazSearch(q) {
  const r = await fetch(`https://www.daraz.pk/catalog/?ajax=true&page=1&q=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Daraz HTTP ${r.status}`);
  return parseDaraz(await r.json());
}

export function parseDaraz(j) {
  return (j?.mods?.listItems || []).map((i) => {
    const page = 'https:' + String(i.itemUrl || '').split('?')[0];
    return {
      id: String(i.itemId || i.nid || i.itemUrl),
      name: String(i.name || '').trim(),
      price: Number(String(i.price || '').replace(/[^\d.]/g, '')) || null,
      original: Number(String(i.originalPrice || '').replace(/[^\d.]/g, '')) || null,
      reviews: Number(i.review) || 0,
      rating: i.ratingScore ? Number(Number(i.ratingScore).toFixed(1)) : null,
      brand: i.brandName && i.brandName !== 'No Brand' ? i.brandName : '',
      // Daraz sends adFlag as the string "0" or "1".
      sponsored: i.isSponsored === true || String(i.adFlag) === '1',
      image: i.image ? String(i.image).replace(/^\/\//, 'https://') : '',
      // "-s<skuId>" opens the variant (size, shade) whose price was listed, not the default one.
      url: i.skuId && /\.html$/.test(page) && !/-s\d+\.html$/.test(page) ? page.replace(/\.html$/, `-s${i.skuId}.html`) : page,
      store: 'Daraz',
    };
  }).filter((i) => i.name && i.price && /^https:\/\/www\.daraz\.pk\//.test(i.url));
}

// Naheed.pk (big Pakistani store, strong in cosmetics and branded goods): its search box's own JSON,
// at most 8 products per query. Common words ("face wash") redirect the full search page to a
// category, but this feed still answers with products.
async function naheedSearch(q) {
  const r = await fetch(`https://www.naheed.pk/searchautocomplete/ajax/suggest/?q=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Naheed HTTP ${r.status}`);
  return parseNaheed(await r.json());
}

const entities = (s) => String(s || '').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function parseNaheed(j) {
  const items = (j?.indexes || []).find((x) => x.identifier === 'magento_catalog_product')?.items || [];
  return items.map((i) => ({
    id: `naheed-${i.id || i.sku || i.url}`,
    name: entities(i.name).replace(/\s+/g, ' ').trim(),
    // "Rs. 5,499": the dot after "Rs" is not a decimal point.
    price: Number(String(i.price || '').replace(/^\D+/, '').replace(/[^\d.]/g, '')) || null,
    original: null,
    reviews: Number(i.reviews) || 0,
    // Naheed rates in percent (80 = 4 stars).
    rating: Number(i.rating) > 0 ? Number((Number(i.rating) / 20).toFixed(1)) : null,
    brand: '',
    sponsored: false,
    image: String(i.imageUrl || ''),
    url: String(i.url || '').split('?')[0],
    store: 'Naheed',
  })).filter((i) => i.name && i.price && /^https:\/\/www\.naheed\.pk\//.test(i.url));
}

// Naheed only finds products whose name has every word of the query, so the long queries Daraz
// likes ("stanley quencher h2.0 tumbler mint green") find nothing there. It gets the most specific
// query (for an exact match) and then the two broadest; 3 at most, which keeps research under the
// 50 outside requests a call may make on Cloudflare's free plan.
export const naheedPlan = (plan) => [...new Set([plan[0], plan.at(-1), plan.at(-2)].filter(Boolean))];

// Runs the search plan from specific to broad until there are enough distinct listings.
async function collect(search, queries, want) {
  const seen = new Map(), used = [], errors = [];
  for (const q of queries) {
    try {
      const items = await search(q);
      used.push({ q, found: items.length });
      for (const it of items) if (!seen.has(it.id)) seen.set(it.id, { ...it, query: q });
    } catch (e) { errors.push(`${q}: ${e.message}`); }
    if (seen.size >= want) break;
  }
  return { items: [...seen.values()], used, errors };
}

async function fetchThumb(c) {
  try {
    // Daraz serves a small copy when asked; Naheed's search images are already thumbnails.
    const url = c.store === 'Daraz' ? c.image.replace(/(\.(jpe?g|png|webp))$/i, '$1_200x200q80.jpg') : c.image;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!IMAGE_TYPES.test(type)) return null;
    return image(type, Buffer.from(await r.arrayBuffer()));
  } catch { return null; }
}

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: { type: 'object', properties: { n: { type: 'integer' }, match: { type: 'string', enum: ['exact', 'similar', 'different'] } }, required: ['n', 'match'], additionalProperties: false },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

// The AI compares the candidates' titles (and thumbnails, when the store serves them) with our photo.
// Titles alone are weak for unbranded jewellery ("Heart Pendant Necklace for Girls").
// Thumbnails only for the best THUMBS: Cloudflare's free plan allows 50 outside requests per call,
// and research also reads the shop, the photos, Google, Daraz and Naheed (and retries a busy AI).
const THUMBS = 10;
async function aiMatch(candidates, ident, ourPhoto, deadline) {
  if (!candidates.length || deadline - Date.now() < 30000) return null;
  const thumbs = await Promise.all(candidates.map((c, i) => (c.image && i < THUMBS ? fetchThumb(c) : null)));
  const parts = [ourPhoto, say(`OUR PRODUCT (photo above): ${ident.product}. Brand: ${ident.brand || 'none visible'}. Label text: ${ident.label_text || '-'}.\n\nFor each listing below (from Daraz.pk or Naheed.pk) decide: "exact" = the same product (same brand and product line/model; for unbranded items the same design), "similar" = same kind of item and close enough to compare prices (another seller's look-alike, similar design, other size/shade of the same line), "different" = another product (other brand, other type, accessory, bundle). Judge by the title and, when given, the listing photo. Answer in "matches" with one entry per listing number n.`)];
  candidates.forEach((c, i) => {
    parts.push(say(`#${i + 1} (${c.store}): ${c.name} — Rs ${c.price}${c.brand ? ` — brand: ${c.brand}` : ''}`));
    if (thumbs[i]) parts.push(thumbs[i]);
  });
  try {
    const out = await generate({ content: parts, schema: MATCH_SCHEMA, effort: 'low' }, Math.min(deadline, Date.now() + 90000));
    const list = JSON.parse(out.text).matches;
    return new Map(list.filter((x) => x.n >= 1 && x.n <= candidates.length).map((x) => [x.n - 1, x.match]));
  } catch { return null; } // the rule-based labels stay
}

export async function research({ mediaIds, hints, ctx, deadline = Date.now() + 270000 }) {
  const imgs = await imageParts(mediaIds);
  const idPrompt = `Look carefully at the ${mediaIds.length} product photo(s) for a Pakistani online store and identify the product.

${storeSummary(ctx)}

OWNER'S NOTES: ${hints || '(none)'}

${WATERMARK_NOTE}

Read every word printed on the product, label or box into label_text. Never assume real gold/silver, genuine stones or a brand that is not printed on the product or given in the owner's notes.

CATEGORIES: pick only categories this product really belongs to (a watch is never Cosmetics or Foundation; a necklace goes in Necklaces/Pendants under Jewellery). When no listed category fits, return an empty categories array and name the right new category in new_category.`;
  const id = await generate({ content: [...imgs, say(idPrompt)], schema: ID_SCHEMA, effort: 'low' },
    deadline - 120000); // leaves time for Google, Daraz, Naheed and the match check
  let ident;
  try { ident = JSON.parse(id.text); } catch { throw new AiError('The AI returned an unreadable answer. Please try again.'); }
  ident = stripShopBrand(ident);
  ident.brand = String(ident.brand || '').trim();
  ident.categories = withParents(ident.categories || [], ctx);
  ident.new_category = ident.categories.length ? '' : String(ident.new_category || '').trim().slice(0, 40);

  // The plain product type ("couple watch") is searched too: its suggestions are the head terms.
  const seeds = [...new Set([...(ident.search_seeds || []), ident.product_type].map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))].slice(0, 6);
  const plan = queryPlan(ident, (ident.daraz_queries || []).slice(0, 2));
  const [suggest, daraz, naheed] = await Promise.all([
    Promise.all(seeds.flatMap((s) => [googleSuggest(s), googleSuggest(`${s} price in pakistan`)]).map((p) => p.catch(() => []))),
    collect(darazSearch, plan, 60),
    collect(naheedSearch, naheedPlan(plan), 8),
  ]);
  // Phrases suggested for several seeds are the most searched; list those first.
  const count = new Map();
  for (const k of suggest.flat().map((x) => x.toLowerCase().trim())) count.set(k, (count.get(k) || 0) + 1);
  const keywords = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 40);
  // Focus-keyword choices: real searches for this product, minus keywords the shop already targets.
  const pool = keywordPool(count, ident, shopFromCtx(ctx).flatMap((o) => o.keywords));

  // Rule-based labels for every listing, then the AI checks the best 16 candidates against our photo.
  const scored = [...daraz.items, ...naheed.items].map((it) => ({ ...it, ...scoreListing(it.name, ident), match: classify(it.name, ident) }))
    .sort((a, b) => b.score - a.score);
  const candidates = scored.filter((x) => x.match !== 'different' || x.score >= 0.45).slice(0, 16);
  const ai = await aiMatch(candidates, ident, imgs[0], deadline - 40000);
  if (ai) {
    candidates.forEach((c, i) => {
      if (!ai.has(i)) return;
      let m = ai.get(i);
      if (m === 'exact' && ident.brand && c.brandOk === false) m = 'similar'; // brand not in the title: not provably the same
      c.match = m; c.checkedBy = 'ai';
    });
  }
  // When the AI compared the listings with our photo, only what it confirmed counts; rule-only labels
  // further down the list are too loose for prices.
  const judged = ai ? candidates.filter((c) => c.checkedBy === 'ai') : scored;
  const exact = judged.filter((x) => x.match === 'exact');
  const similar = judged.filter((x) => x.match === 'similar');
  const shopCat = ident.categories.find((c) => ctx.categories.find((x) => x.slug === c)?.parent) || ident.categories[0];
  const shop = ctx.products.filter((p) => p.status === 'publish' && p.categories.includes(shopCat));
  const hintFacts = parseHints(hints);
  const pricing = suggestPrice({ exact, similar, shop, hints: hintFacts, branded: !!ident.brand });

  const line = (i) => `${i.store} | Rs ${i.price}${i.original ? ` (was ${i.original})` : ''} | ${i.reviews} reviews${i.rating ? `, ${i.rating}★` : ''} | ${i.name.slice(0, 90)} | ${i.url}`;
  const notes = [
    `IDENTIFICATION (${id.model}): ${ident.product}`,
    `BRAND: ${ident.brand || 'none visible'}   TYPE: ${ident.product_type}   KEY TERMS: ${(ident.key_terms || []).join(', ')}`,
    `LABEL TEXT: ${ident.label_text || '-'}`,
    `DETAILS: ${ident.details}`,
    `CONFIDENCE: ${ident.confidence}`,
    `MUST CONFIRM: ${(ident.must_confirm || []).join('; ') || '-'}`,
    `CATEGORY: ${ident.categories.join(', ') || `none of the shop's categories fits; NEW CATEGORY: ${ident.new_category || '(to be chosen by the owner)'}`}`,
    '',
    `GOOGLE SEARCHES IN PAKISTAN (Google autocomplete, gl=pk; most suggested first; seeds: ${seeds.join(' | ')}):`,
    keywords.join(' | ') || '(none returned)',
    '',
    `KEYWORD CANDIDATES (real searches for this product, cleaned, not used by another Vaxaura product; best first):`,
    pool.map((k) => k.kw).join(' | ') || '(none: choose the plainest phrase shoppers would type)',
    '',
    ...[['DARAZ.PK', daraz], ['NAHEED.PK', naheed]].map(([name, r]) => `${name}: ${r.items.length} listings from ${r.used.map((u) => `"${u.q}" (${u.found})`).join(', ') || 'no search'}${r.errors.length ? `; errors: ${r.errors.join('; ')}` : ''}.`),
    `SAME PRODUCT (${exact.length}):`, ...exact.slice(0, 8).map(line),
    `SIMILAR (${similar.length}):`, ...similar.slice(0, 8).map(line),
    '',
    `PRICE SUGGESTION: regular Rs ${pricing.regular ?? '-'}, sale Rs ${pricing.sale ?? '-'}. ${pricing.why.join(' ')}`,
  ].join('\n');
  const sources = [...exact.slice(0, 6), ...similar.slice(0, 4)].map((i) => ({
    title: `${i.match === 'exact' ? 'Same product' : 'Similar'} · ${i.store} · Rs ${i.price}${i.reviews ? ` · ${i.reviews} reviews` : ''} · ${i.name.slice(0, 70)}`, url: i.url,
  }));
  const market = {
    queries: daraz.used, total: daraz.items.length + naheed.items.length, aiChecked: !!ai,
    stores: { Daraz: daraz.items.length, Naheed: naheed.items.length }, naheedQueries: naheed.used,
    searches: searchLinks(daraz.used, naheed.used),
    exact: exact.slice(0, 10).map(pick), similar: similar.slice(0, 10).map(pick),
    pricing: { regular: pricing.regular, sale: pricing.sale, why: pricing.why, basis: pricing.basis, exact: pricing.exact || null, similar: pricing.similar || null, shop: pricing.shop || null },
    hints: hintFacts,
    keywords: pool, categories: ident.categories, newCategory: ident.new_category,
  };
  return { model: id.model, notes, sources, identification: ident, keywords, market, facts: `${hints || ''}\n${ident.label_text || ''}` };
}

// thumb: a small copy for the evidence cards (Daraz makes one on request; Naheed's are small already).
const thumb = (i) => (!i.image ? '' : i.store === 'Daraz' ? i.image.replace(/(\.(jpe?g|png|webp))$/i, '$1_120x120q80.jpg') : i.image);
const pick = (i) => ({ name: i.name, price: i.price, original: i.original, reviews: i.reviews, rating: i.rating, url: i.url, store: i.store, thumb: thumb(i), ad: !!i.sponsored, match: i.match, by: i.checkedBy || 'rules' });
// Links that open the same searches on the stores, for the owner to look further.
export const searchLinks = (daraz, naheed) => [
  ...daraz.map((u) => ({ store: 'Daraz', q: u.q, found: u.found, url: `https://www.daraz.pk/catalog/?q=${encodeURIComponent(u.q)}` })),
  ...naheed.map((u) => ({ store: 'Naheed', q: u.q, found: u.found, url: `https://www.naheed.pk/catalogsearch/result/?q=${encodeURIComponent(u.q)}` })),
];

// Child categories need their parent too (pendants -> jewellery), as on the live products.
export function withParents(slugs, ctx) {
  const out = [];
  for (const s of slugs) {
    const c = ctx.categories.find((x) => x.slug === s);
    if (!c) continue;
    if (!out.includes(s)) out.push(s);
    if (c.parent && !out.includes(c.parent)) out.push(c.parent);
  }
  return out;
}

// ---------- 2) write ----------
// Structured output needs every object closed to extra keys.
const S = (type, extra = {}) => ({ type, ...extra, ...(type === 'object' ? { additionalProperties: false } : {}) });
const SCHEMA = S('object', {
  properties: {
    focus_keyword: S('string', { description: 'focus keyword: 2-4 plain lowercase words, no accents, apostrophes or hyphens' }),
    secondary_keywords: S('array', { items: S('string') }),
    name: S('string'),
    slug: S('string'),
    short_description: S('string'),
    description: S('string'),
    categories: S('array', { items: S('string') }),
    tags: S('array', { items: S('string') }),
    regular_price: S('integer'),
    sale_price: S('integer'),
    stock_quantity: S('integer'),
    weight_kg: S('string'),
    dimensions_cm: S('object', { properties: { length: S('string'), width: S('string'), height: S('string') } }),
    attributes: S('array', { items: S('object', { properties: { name: S('string'), value: S('string') }, required: ['name', 'value'] }) }),
    image_alts: S('array', { items: S('string') }),
    seo_title: S('string'),
    seo_description: S('string'),
    owner_note: S('string'),
  },
  required: ['focus_keyword', 'secondary_keywords', 'name', 'slug', 'short_description', 'description', 'categories', 'tags',
    'regular_price', 'sale_price', 'stock_quantity', 'attributes', 'image_alts', 'seo_title', 'seo_description', 'owner_note'],
});

function rules(n, ctx, market) {
  // Every keyword another product targets (focus and secondary): using one is keyword cannibalization.
  const used = [...new Set(shopFromCtx(ctx).flatMap((o) => o.keywords))];
  const pool = (market?.keywords || []).map((k) => k.kw);
  const pick = pool.length
    ? `MUST be exactly one of the KEYWORD CANDIDATES (real Google searches in Pakistan): ${JSON.stringify(pool)} - choose the most specific one that truly describes this exact item (an earlier one is searched more)`
    : 'exactly as Pakistanis search it - prefer a phrase from the GOOGLE SEARCHES IN PAKISTAN list that fits this exact item';
  return `Write the complete WooCommerce product listing for Vaxaura as JSON. Every rule below is a Rank Math SEO test; the listing must pass all of them (100/100):

1. focus_keyword: 2-4 plain lowercase words naming the product itself, ${pick} (e.g. "gold heart pendant", "glycolic bright face wash", "st london foundation"). Never put price, Pakistan, buy, online, best or sale in the focus keyword or the secondary keywords (use those words in the SEO title and text instead). No accents, apostrophes or hyphens. secondary_keywords: 2 other plain phrases${pool.length > 1 ? ', taken from the other KEYWORD CANDIDATES where they fit' : ''}. Neither the focus keyword nor a secondary keyword may be one another Vaxaura product already targets (keyword cannibalization): ${JSON.stringify(used)}.
2. seo_title (max 60 chars): STARTS with the exact focus keyword, contains one power word (Best, Perfect, Stunning, Glowing, Luxury, Beautiful, Exclusive; note "Elegant" and "Premium" are NOT power words) and ends with "| Vaxaura" if it fits.
3. seo_description (130-155 chars): contains the exact focus keyword, "Pakistan" and "Cash on Delivery".
4. slug: the focus keyword words joined by hyphens, optionally + "-vaxaura"; max 45 chars.
5. name: "<Descriptive Name> – <Short Type>", 45-75 chars, contains the focus keyword (brand names may keep accents here).
6. short_description (HTML): one <p> whose FIRST sentence contains the exact focus keyword and "<strong>... by Vaxaura</strong>", then a <ul> with 5 <li> feature bullets.
7. description (HTML, 400-550 words - it is counted and sent back if under 350): the FIRST sentence contains the exact focus keyword inside <strong>. Sections with <h3>: product name; "Why You'll Love This <focus keyword in Title Case>" (bold sub-points); "Product Details" (<ul>: type, shape/colours/finish or brand/size/ingredients, style, occasion, sold by Vaxaura); "Styling Tips" (jewellery/decor) or "How to Use" (cosmetics); "Care"; a line about Cash on Delivery all over Pakistan and WhatsApp orders at +92 325 5023982; "Frequently Asked Questions" with 5-6 Q&As written around real search phrases. Paragraphs under 60 words. Put exactly these placeholders on their own lines between sections (they become photos): ${placeholderList(n).join(', ')}. Never use any other {{image:N}}.
8. Keyword density: over description + short description together, the focus keyword and the secondary keywords (exact phrases) must appear about once every 60-80 words in total (1.2-2.0%), naturally - FAQ questions are a good place. Never more than 2.2%.
9. image_alts: exactly ${n} strings, one per photo in order. The FIRST starts with the exact focus keyword and ends with "by Vaxaura"; the others describe the view (front, side, close-up, worn, label, packaging), each unique.
10. categories: the CATEGORY slugs from the research (child + parent, e.g. ["pendants","jewellery"]); when the research says NEW CATEGORY, return []. tags: 6-10 in Title Case (reuse these existing tags when they fit: ${JSON.stringify(ctx.tags)}), add keyword and trend tags.
11. regular_price and sale_price: use the PRICE SUGGESTION from the research exactly (it is computed from the matching Daraz and Naheed listings, Vaxaura's own prices and the owner's notes). stock_quantity: the owner's number if given, else 10. weight_kg / dimensions_cm only if you can reasonably infer them, else empty strings. attributes: 2-4 (e.g. Material, Colour, Finish, Size, Brand) with values you can see.
12. No unverifiable claims: never say real gold, karat, sterling/925 silver, genuine, real stones/diamonds/emeralds, hypoallergenic, waterproof/tarnish-proof, original/authentic, dermatologist approved or guaranteed unless the owner's notes or the LABEL TEXT say exactly that ("gold-tone", "crystal-style stones" are fine). Facts printed on the label (size, SPF, ingredients) may be stated.
13. owner_note (English, plain text): what the owner must confirm (material, stones, size, stock, authenticity) and anything uncertain about the identification. The price evidence is added automatically, do not repeat it.`;
}

// extra: { market, facts } from the research step (echoed by the browser).
function toProduct(j, mediaIds, ctx, extra = {}) {
  const kws = [...new Set([j.focus_keyword, ...(j.secondary_keywords || [])].map((k) => words(k).join(' ')).filter(Boolean))];
  // The research's categories win when the writer drops them; with none, the suggested new one is used.
  let cats = withParents(j.categories || [], ctx);
  if (!cats.length) cats = withParents(extra.market?.categories || [], ctx);
  const newCategory = cats.length ? '' : String(extra.market?.newCategory || '').trim();
  const pricing = extra.market?.pricing || {};
  const hintStock = extra.market?.hints?.stock;
  // SKU comes from the store, never from the model: next free number for the most specific category
  // (child before parent), or for the new category.
  const skuCat = cats.find((c) => ctx.categories.find((x) => x.slug === c)?.parent) || cats[0];
  const sku = skuCat && ctx.nextSku?.[skuCat] ? ctx.nextSku[skuCat]
    : newCategory ? nextSku(skuPrefix(slugify(newCategory)), ctx.skus || []) : 'VAX-' + Date.now().toString().slice(-5);
  const alts = mediaIds.map((_, i) => capFirst(j.image_alts?.[i] || `${j.name} by Vaxaura – photo ${i + 1}`));
  // The model sometimes invents {{image:N}} for a photo that does not exist; drop those.
  const description = String(j.description || '').replace(/\{\{image:(\d+)\}\}/g, (m, k) => (Number(k) >= 1 && Number(k) <= mediaIds.length ? m : ''));
  return {
    name: j.name, slug: slugify(j.slug || j.focus_keyword),
    short_description: j.short_description, description,
    categories: cats, new_category: newCategory, tags: (j.tags || []).map(titleCase),
    // Prices come from the market evidence, not from the model; the model's numbers are only a fallback.
    regular_price: String(pricing.regular || j.regular_price || ''), sale_price: String(pricing.regular ? pricing.sale || '' : j.sale_price || ''),
    sku,
    stock_quantity: Number.isInteger(hintStock) ? hintStock : Number.isInteger(j.stock_quantity) ? j.stock_quantity : 10,
    weight: j.weight_kg || '', dimensions: j.dimensions_cm || {},
    attributes: (j.attributes || []).map((a) => ({ name: a.name, options: [a.value] })),
    images: mediaIds.map((id, i) => ({ media_id: id, alt: alts[i], update_media: true })),
    seo: { title: fitTitle(keepBrandCase(titleCase(j.seo_title), j.name)), description: j.seo_description, focus_keyword: kws.join(', ') },
    owner_note: ownerNote(j.owner_note, extra.market),
    facts: extra.facts || '',
    keyword_pool: (extra.market?.keywords || []).map((k) => k.kw),
  };
}

// The shop's products with the keywords they target ("focus, secondary, ...").
export const shopFromCtx = (ctx) => (ctx.products || []).map((p) => ({ id: p.id, name: p.name, status: p.status, url: p.url, keywords: splitKeywords(p.focus_keyword) }));

// The price part of the owner's note is written from the evidence, so it cannot be invented.
function ownerNote(aiNote, market) {
  if (!market?.pricing) return aiNote || '';
  const p = market.pricing;
  const list = (xs) => xs.slice(0, 3).map((i) => `  - ${i.store || 'Daraz'}, Rs ${i.price}${i.reviews ? `, ${i.reviews} reviews` : ''}: ${i.name.slice(0, 80)} — ${i.url}`);
  return [
    `SUGGESTED PRICE (check before publishing): regular Rs ${p.regular ?? '-'}, sale Rs ${p.sale ?? '-'}.`,
    ...p.why.map((w) => `- ${w}`),
    ...(market.exact?.length ? ['Same product online:', ...list(market.exact)] : ['No listing of the same product was found on Daraz or Naheed.']),
    ...(market.similar?.length ? ['Similar online:', ...list(market.similar)] : []),
    '',
    'TO CONFIRM:',
    aiNote || '-',
  ].join('\n');
}

// Title Case turns "st london" into "St London"; words the product name spells differently
// (ST, L'Oréal, SPF, 100ml) keep the product name's spelling.
export function keepBrandCase(title, name) {
  const spelled = new Map((String(name || '').match(/\p{L}[\p{L}\p{N}'’]*/gu) || []).map((w) => [w.toLowerCase(), w]));
  return String(title || '').replace(/\p{L}[\p{L}\p{N}'’]*/gu, (w) => {
    const s = spelled.get(w.toLowerCase());
    return s && s !== s.toLowerCase() ? s : w;
  });
}

// Google cuts titles after about 60 characters; the brand suffix is the first thing to go.
export function fitTitle(t) {
  const s = String(t || '').trim();
  return s.length > 60 ? s.replace(/\s*[|–-]\s*Vaxaura\s*$/i, '').trim() : s;
}

// Photos placed in the description: Rank Math wants 4 images including the featured one, so with fewer
// than 4 photos the featured photo (1) is placed in the description as well.
export function placeholderList(n) {
  const ids = n >= 4 ? [2, 3, 4] : Array.from({ length: n }, (_, i) => i + 1);
  return ids.map((k) => `{{image:${k}}}`);
}

const capFirst = (s) => String(s).replace(/^\s*\p{Ll}/u, (c) => c.toUpperCase());

// The model sometimes copies the lowercase focus keyword into the SEO title ("black heart pendant
// Stunning ..."); Rank Math matching ignores case, shoppers do not.
const SMALL = new Set(['a', 'an', 'and', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
export function titleCase(s) {
  return String(s || '').replace(/\p{L}[\p{L}\p{N}'’]*/gu, (w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w : w[0].toUpperCase() + w.slice(1)));
}

// Safe mechanical fixes the model sometimes misses (no rewriting of the copy).
function autoFix(p, audit) {
  const kw = audit.kw;
  const failed = new Set(audit.fixable.map((x) => x.id));
  if (kw && (failed.has('kwUrl') || failed.has('urlLen'))) {
    const s = slugify(kw);
    p.slug = (s + '-vaxaura').length <= 45 ? s + '-vaxaura' : s;
  }
  if (kw && failed.has('kwAlt')) {
    const cap = kw.replace(/\b\w/g, (c) => c.toUpperCase());
    p.images[0].alt = `${cap} by Vaxaura – ${p.images[0].alt}`.slice(0, 120);
  }
  // A secondary keyword that another product targets is simply dropped (the focus keyword stays).
  const clash = new Set(audit.conflicts.filter((c) => c.severity === 'high' && c.keyword !== kw).map((c) => c.keyword));
  if (clash.size) p.seo.focus_keyword = splitKeywords(p.seo.focus_keyword).filter((k) => !clash.has(k)).join(', ');
  return p;
}

// The review form's listing in the model's JSON shape, so the AI can repair what the owner sees.
function fromProduct(p) {
  const [focus, ...secondary] = splitKeywords(p.seo?.focus_keyword);
  return {
    focus_keyword: focus || '', secondary_keywords: secondary, name: p.name, slug: p.slug,
    short_description: p.short_description, description: p.description, categories: p.categories || [], tags: p.tags || [],
    regular_price: Number(p.regular_price) || 0, sale_price: Number(p.sale_price) || 0, stock_quantity: Number(p.stock_quantity) || 0,
    attributes: (p.attributes || []).map((a) => ({ name: a.name, value: (a.options || []).join(', ') })),
    image_alts: (p.images || []).map((i) => i.alt), seo_title: p.seo?.title || '', seo_description: p.seo?.description || '', owner_note: '',
  };
}

// One AI call per request: the first call writes the listing; when
// the browser sends `previous` (the last JSON) back, the call repairs the failing Rank Math tests.
// `current` is the listing as edited on the review page ("Fix with AI"): only the copy and keywords
// change; prices, SKU, stock, categories, tags, attributes and the owner's note stay as the owner set them.
export async function write({ mediaIds, hints, notes, ctx, previous, current, market, facts, deadline = Date.now() + 270000 }) {
  const extra = { market, facts };
  const shop = shopFromCtx(ctx);
  const imgs = await imageParts(mediaIds);
  const base = `${WATERMARK_NOTE}\n\n${storeSummary(ctx)}\n\nOWNER'S NOTES: ${hints || '(none)'}\n\nRESEARCH:\n${notes}\n\n${rules(mediaIds.length, ctx, market)}`;
  let ask = base;
  if (current) previous = fromProduct(current);
  if (previous) {
    const prevAudit = current ? seoAudit({ ...current, keyword_pool: (market?.keywords || []).map((k) => k.kw) }, { shop }) : autoFixed(previous, mediaIds, ctx, shop, extra).audit;
    ask = `${base}\n\nYOUR PREVIOUS JSON:\n${JSON.stringify(previous)}\n\nIt fails these Rank Math tests - return the full corrected JSON, changing only what is needed:\n${prevAudit.fixable.map((x) => `- ${x.name}${x.info ? ` (now: ${x.info})` : ''}: ${x.fix}`).join('\n')}`;
  }
  const out = await generate({ content: [...imgs, say(ask)], schema: SCHEMA, effort: 'medium' }, deadline);
  let json;
  try { json = JSON.parse(out.text); } catch { throw new AiError('The AI returned an unreadable answer. Please try again.'); }
  const fixed = autoFixed(json, mediaIds, ctx, shop, extra, current);
  return { model: out.model, json, ...fixed, warnings: possibleDuplicates(fixed.product.name, ctx.products) };
}

const KEEP_FROM_OWNER = ['regular_price', 'sale_price', 'sku', 'sku_auto', 'stock_quantity', 'weight', 'dimensions', 'categories', 'new_category', 'new_category_parent', 'tags', 'attributes', 'owner_note'];
function autoFixed(json, mediaIds, ctx, shop, extra, current) {
  let product = toProduct(json, mediaIds, ctx, extra);
  if (current) for (const k of KEEP_FROM_OWNER) if (k in current) product[k] = current[k];
  product = autoFix(product, seoAudit(product, { shop }));
  return { product, audit: seoAudit(product, { shop }) };
}
