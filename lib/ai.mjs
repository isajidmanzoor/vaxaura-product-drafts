// AI side: Google Gemini API (free tier) over REST, plus free public market data.
// 1) research: Gemini identifies the product from the photos and proposes search phrases; the server
//    then pulls what Pakistanis type into Google (Google Suggest, gl=pk) and competitor listings with
//    prices and "sold" counts from Daraz.pk search.
// 2) write: turns photos + research into a full product listing as strict JSON.
// 3) repair: fixes the listing until the Rank Math audit passes.

import { seoAudit, slugify, words, SKU_PREFIX, mediaUrlForAi, possibleDuplicates } from './woo.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
// Free-tier models, checked 2026-10-30: gemini-2.5-* is closed to new keys and Google Search grounding
// has no free quota on the 3.x models, so research uses Google Suggest + Daraz instead. 3.8 Flash
// writes slightly better but is often busy (503) or takes minutes; 3.6 Flash answers in ~15 s, so it goes first.
const VISION_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
const WRITE_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

export class AiError extends Error {}

// The free tier is often busy (503) or slow: each model gets at most PER_MODEL_MS, busy models are
// skipped, and the list is tried again while the request's deadline (under Vercel's 300 s) allows.
const PER_MODEL_MS = 100000;

async function generate(models, body, deadline) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiError('GEMINI_API_KEY is not set.');
  let lastErr = new AiError('No time left for the AI call');
  const noThinkingConfig = new Set();
  for (let pass = 0; pass < 3; pass++) {
    for (const model of models) {
      const left = deadline - Date.now() - 5000;
      if (left < 15000) throw lastErr;
      // Low thinking keeps answers fast; dropped for a model that rejects the setting.
      const cfg = { ...body.generationConfig, ...(noThinkingConfig.has(model) ? {} : { thinkingConfig: { thinkingLevel: 'low' } }) };
      let res;
      try {
        res = await fetch(`${API}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ ...body, generationConfig: cfg }),
          signal: AbortSignal.timeout(Math.min(PER_MODEL_MS, left)),
        });
      } catch (e) {
        lastErr = new AiError(`${model}: ${e.name === 'TimeoutError' ? 'no answer in time (Gemini free tier is busy)' : e.message}`);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
        if (text) return { model, text };
        lastErr = new AiError(`${model}: empty answer (${cand?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
        continue;
      }
      const msg = data.error?.message || res.statusText;
      if (res.status === 400 && /thinking/i.test(msg) && !noThinkingConfig.has(model)) {
        noThinkingConfig.add(model);
        lastErr = new AiError(`${model}: ${msg}`);
        continue;
      }
      lastErr = new AiError(res.status === 429
        ? 'Gemini free limit reached. Wait a minute (or until tomorrow for the daily limit) and try again.'
        : res.status === 503 ? 'Gemini free tier is busy right now. Try again in a few minutes.'
          : `${model}: HTTP ${res.status} ${msg}`);
      // 400 = our request is wrong; another model will not help.
      if (res.status === 400 && !/model|not found|not supported/i.test(msg)) throw lastErr;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastErr;
}

async function imageParts(mediaIds) {
  const parts = [];
  for (const id of mediaIds) {
    const url = await mediaUrlForAi(id);
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new AiError(`Could not read photo #${id} (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    parts.push({ inline_data: { mime_type: r.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: buf.toString('base64') } });
  }
  return parts;
}

function storeSummary(ctx) {
  const cats = ctx.categories.map((c) => `${c.slug}${c.parent ? ` (child of ${c.parent})` : ''}: ${c.name}`).join('\n');
  const prices = ctx.products.filter((p) => p.status === 'publish').map((p) => `${p.name} [${p.categories.join(',')}]: Rs ${p.regular_price} / sale Rs ${p.sale_price || '-'}`).join('\n');
  return `STORE: Vaxaura (vaxaura.com), Pakistan. Jewellery, cosmetics and decor. Prices in Rs (PKR). Cash on Delivery all over Pakistan. WhatsApp orders: +92 325 5023982.\n\nCATEGORIES (slug: name):\n${cats}\n\nCURRENT VAXAURA PRICES:\n${prices}`;
}

// ---------- 1) research ----------
const ID_SCHEMA = {
  type: 'OBJECT',
  properties: {
    product: { type: 'STRING', description: 'what it is, one line (e.g. "gold-tone heart pendant necklace with green stones")' },
    details: { type: 'STRING', description: 'shape/motif, colours, finish, stones, material if visible, brand and label text (cosmetics: brand, line, size, key ingredients), size cues' },
    confidence: { type: 'STRING', description: 'high, medium or low, with a reason' },
    must_confirm: { type: 'ARRAY', items: { type: 'STRING' } },
    categories: { type: 'ARRAY', items: { type: 'STRING' }, description: 'best matching category slugs from the list, child and parent' },
    search_seeds: { type: 'ARRAY', items: { type: 'STRING' }, description: '3-5 short phrases (2-3 words, lowercase) a Pakistani shopper would start typing into Google for this item' },
    daraz_queries: { type: 'ARRAY', items: { type: 'STRING' }, description: '2 queries to find the same or very similar item on Daraz.pk (brand + product for branded items)' },
  },
  required: ['product', 'details', 'confidence', 'must_confirm', 'categories', 'search_seeds', 'daraz_queries'],
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// What people in Pakistan type after a seed phrase (Google's public autocomplete, Pakistan, English).
async function googleSuggest(seed) {
  const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&gl=pk&hl=en&q=${encodeURIComponent(seed)}`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const j = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('latin1'));
  return Array.isArray(j[1]) ? j[1] : [];
}

// Daraz.pk search results (best match order): name, price, sold count, rating, link.
async function darazSearch(q) {
  const r = await fetch(`https://www.daraz.pk/catalog/?ajax=true&page=1&q=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Daraz HTTP ${r.status}`);
  const items = (await r.json()).mods?.listItems || [];
  return items.slice(0, 12).map((i) => ({
    name: String(i.name || '').trim(),
    price: Number(String(i.price || '').replace(/[^\d.]/g, '')) || null,
    sold: i.itemSoldCntShow || '',
    rating: i.ratingScore ? Number(i.ratingScore).toFixed(1) : '',
    url: 'https:' + String(i.itemUrl || '').split('?')[0],
  })).filter((i) => i.name && i.price);
}

export async function research({ mediaIds, hints, ctx, deadline = Date.now() + 270000 }) {
  const imgs = await imageParts(mediaIds);
  const idPrompt = `Look carefully at the ${mediaIds.length} product photo(s) for a Pakistani online store and identify the product.

${storeSummary(ctx)}

OWNER'S NOTES: ${hints || '(none)'}

Never assume real gold/silver, genuine stones or a brand that is not printed on the product.`;
  const id = await generate(VISION_MODELS, {
    contents: [{ role: 'user', parts: [...imgs, { text: idPrompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: ID_SCHEMA },
  }, deadline - 40000); // leaves time for the Google Suggest and Daraz lookups
  let ident;
  try { ident = JSON.parse(id.text); } catch { throw new AiError(`${id.model} returned invalid JSON`); }

  const seeds = [...new Set((ident.search_seeds || []).map((s) => s.toLowerCase().trim()).filter(Boolean))].slice(0, 5);
  const suggest = await Promise.all(seeds.flatMap((s) => [googleSuggest(s), googleSuggest(`${s} price in pakistan`)]).map((p) => p.catch(() => [])));
  const keywords = [...new Set(suggest.flat().map((k) => k.toLowerCase().trim()))].slice(0, 40);

  const daraz = [];
  const darazErrors = [];
  for (const q of (ident.daraz_queries || []).slice(0, 2)) {
    try { daraz.push({ q, items: await darazSearch(q) }); } catch (e) { darazErrors.push(`${q}: ${e.message}`); }
  }
  const all = daraz.flatMap((d) => d.items);
  const prices = all.map((i) => i.price).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  const notes = [
    `IDENTIFICATION (${id.model}): ${ident.product}`,
    `DETAILS: ${ident.details}`,
    `CONFIDENCE: ${ident.confidence}`,
    `MUST CONFIRM: ${(ident.must_confirm || []).join('; ') || '-'}`,
    `CATEGORY: ${(ident.categories || []).join(', ')}`,
    '',
    `GOOGLE SEARCHES IN PAKISTAN (Google autocomplete, gl=pk, for: ${seeds.join(' | ')}):`,
    keywords.join(' | ') || '(none returned)',
    '',
    ...daraz.flatMap((d) => [`DARAZ.PK SEARCH "${d.q}" (best match first; price Rs | sold | rating | name | link):`,
      ...d.items.map((i) => `Rs ${i.price} | ${i.sold || '-'} | ${i.rating || '-'} | ${i.name.slice(0, 90)} | ${i.url}`), '']),
    prices.length ? `DARAZ PRICE RANGE: Rs ${prices[0]} - Rs ${prices.at(-1)}, median Rs ${median} (${prices.length} listings; similar but not always identical items).` : `DARAZ: no results${darazErrors.length ? ` (${darazErrors.join('; ')})` : ''}.`,
  ].join('\n');
  const sources = [
    ...daraz.flatMap((d) => d.items.slice(0, 5)).map((i) => ({ title: `Daraz: Rs ${i.price} · ${i.sold || ''} · ${i.name.slice(0, 60)}`, url: i.url })),
  ];
  return { model: id.model, notes, sources, identification: ident, keywords };
}

// ---------- 2) write ----------
const S = (type, extra = {}) => ({ type, ...extra });
const SCHEMA = S('OBJECT', {
  properties: {
    focus_keyword: S('STRING', { description: 'focus keyword: 2-4 plain lowercase words, no accents, apostrophes or hyphens' }),
    secondary_keywords: S('ARRAY', { items: S('STRING') }),
    name: S('STRING'),
    slug: S('STRING'),
    short_description: S('STRING'),
    description: S('STRING'),
    categories: S('ARRAY', { items: S('STRING') }),
    tags: S('ARRAY', { items: S('STRING') }),
    regular_price: S('INTEGER'),
    sale_price: S('INTEGER'),
    stock_quantity: S('INTEGER'),
    weight_kg: S('STRING'),
    dimensions_cm: S('OBJECT', { properties: { length: S('STRING'), width: S('STRING'), height: S('STRING') } }),
    attributes: S('ARRAY', { items: S('OBJECT', { properties: { name: S('STRING'), value: S('STRING') }, required: ['name', 'value'] }) }),
    image_alts: S('ARRAY', { items: S('STRING') }),
    seo_title: S('STRING'),
    seo_description: S('STRING'),
    owner_note: S('STRING'),
  },
  required: ['focus_keyword', 'secondary_keywords', 'name', 'slug', 'short_description', 'description', 'categories', 'tags',
    'regular_price', 'sale_price', 'stock_quantity', 'attributes', 'image_alts', 'seo_title', 'seo_description', 'owner_note'],
});

function rules(n, ctx) {
  const used = ctx.products.map((p) => p.focus_keyword.split(',')[0].trim()).filter(Boolean);
  return `Write the complete WooCommerce product listing for Vaxaura as JSON. Every rule below is a Rank Math SEO test; the listing must pass all of them (100/100):

1. focus_keyword: 2-4 plain lowercase words exactly as Pakistanis search - prefer a phrase from the GOOGLE SEARCHES IN PAKISTAN list that fits this exact item (e.g. "gold heart pendant", "glycolic bright face wash"). No accents, apostrophes or hyphens. Must NOT be one of these already used: ${JSON.stringify(used)}. secondary_keywords: 2 other plain phrases.
2. seo_title (max 60 chars): STARTS with the exact focus keyword, contains one power word (Best, Perfect, Stunning, Glowing, Luxury, Beautiful, Exclusive; note "Elegant" and "Premium" are NOT power words) and ends with "| Vaxaura" if it fits.
3. seo_description (130-155 chars): contains the exact focus keyword, "Pakistan" and "Cash on Delivery".
4. slug: the focus keyword words joined by hyphens, optionally + "-vaxaura"; max 45 chars.
5. name: "<Descriptive Name> – <Short Type>", 45-75 chars, contains the focus keyword (brand names may keep accents here).
6. short_description (HTML): one <p> whose FIRST sentence contains the exact focus keyword and "<strong>... by Vaxaura</strong>", then a <ul> with 5 <li> feature bullets.
7. description (HTML, 380-550 words): the FIRST sentence contains the exact focus keyword inside <strong>. Sections with <h3>: product name; "Why You'll Love This <focus keyword in Title Case>" (bold sub-points); "Product Details" (<ul>: type, shape/colours/finish or brand/size/ingredients, style, occasion, sold by Vaxaura); "Styling Tips" (jewellery/decor) or "How to Use" (cosmetics); "Care"; a line about Cash on Delivery all over Pakistan and WhatsApp orders at +92 325 5023982; "Frequently Asked Questions" with 5-6 Q&As written around real search phrases. Paragraphs under 60 words. ${n >= 2 ? `Put the placeholders ${Array.from({ length: Math.min(3, n - 1) }, (_, i) => `{{image:${i + 2}}}`).join(', ')} on their own lines between sections (they become photos).` : ''}
8. Keyword density: over description + short description together, the focus keyword and the secondary keywords (exact phrases) must appear about once every 60-80 words in total (1.2-2.0%), naturally - FAQ questions are a good place. Never more than 2.2%.
9. image_alts: exactly ${n} strings, one per photo in order. The FIRST starts with the exact focus keyword and ends with "by Vaxaura"; the others describe the view (front, side, close-up, worn, label, packaging), each unique.
10. categories: slugs from the store list (child + parent, e.g. ["pendants","jewellery"]). tags: 6-10 in Title Case (reuse these existing tags when they fit: ${JSON.stringify(ctx.tags)}), add keyword and trend tags.
11. regular_price and sale_price in Rs (sale < regular, sale ends in 99, 49 or 90): base them on Vaxaura's current prices for similar items and the Daraz listings for the same or similar item (Daraz has many cheap unbranded copies; Vaxaura is a boutique with photos, packaging and COD, so it may sit above the Daraz median but should stay believable). stock_quantity: the owner's number if given, else 10. weight_kg / dimensions_cm only if you can reasonably infer them, else empty strings. attributes: 2-4 (e.g. Material, Colour, Finish, Size, Brand) with values you can see.
12. No unverifiable claims: never say real gold, sterling silver, genuine stones/diamonds/emeralds, hypoallergenic, waterproof or original/authentic brand unless the owner's notes say so ("gold-tone", "crystal-style stones" are fine).
13. owner_note (English, plain text): "SUGGESTED price only:" + regular/sale + the Daraz price range and 2-3 closest Daraz listings (price, sold count, link) + what the owner must confirm (material, stones, size, stock, price) + anything uncertain.`;
}

function toProduct(j, mediaIds, ctx) {
  const kws = [j.focus_keyword, ...(j.secondary_keywords || [])].map((k) => words(k).join(' ')).filter(Boolean);
  const cats = (j.categories || []).filter((s) => ctx.categories.some((c) => c.slug === s));
  // SKU comes from the store, never from the model: next free number for the most specific category.
  const skuCat = cats.find((c) => SKU_PREFIX[c] && ctx.categories.find((x) => x.slug === c)?.parent) || cats.find((c) => SKU_PREFIX[c]);
  const alts = mediaIds.map((_, i) => j.image_alts?.[i] || `${j.name} by Vaxaura – photo ${i + 1}`);
  return {
    name: j.name, slug: slugify(j.slug || j.focus_keyword),
    short_description: j.short_description, description: j.description,
    categories: cats, tags: j.tags || [],
    regular_price: String(j.regular_price || ''), sale_price: j.sale_price ? String(j.sale_price) : '',
    sku: skuCat ? ctx.nextSku[skuCat] : 'VAX-' + Date.now().toString().slice(-5),
    stock_quantity: Number.isInteger(j.stock_quantity) ? j.stock_quantity : 10,
    weight: j.weight_kg || '', dimensions: j.dimensions_cm || {},
    attributes: (j.attributes || []).map((a) => ({ name: a.name, options: [a.value] })),
    images: mediaIds.map((id, i) => ({ media_id: id, alt: alts[i], update_media: true })),
    seo: { title: titleCase(j.seo_title), description: j.seo_description, focus_keyword: kws.join(', ') },
    owner_note: j.owner_note,
  };
}

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
  return p;
}

// One AI call per request (the free tier can take minutes): the first call writes the listing; when
// the browser sends `previous` (the last JSON) back, the call repairs the failing Rank Math tests.
export async function write({ mediaIds, hints, notes, ctx, previous, deadline = Date.now() + 270000 }) {
  const usedFocus = ctx.products.map((x) => words(x.focus_keyword.split(',')[0]).join(' ')).filter(Boolean);
  const imgs = await imageParts(mediaIds);
  const base = `${storeSummary(ctx)}\n\nOWNER'S NOTES: ${hints || '(none)'}\n\nRESEARCH:\n${notes}\n\n${rules(mediaIds.length, ctx)}`;
  let ask = base;
  if (previous) {
    const prevAudit = autoFixed(previous, mediaIds, ctx, usedFocus).audit;
    ask = `${base}\n\nYOUR PREVIOUS JSON:\n${JSON.stringify(previous)}\n\nIt fails these Rank Math tests - return the full corrected JSON, changing only what is needed:\n${prevAudit.fixable.map((x) => `- ${x.name}${x.info ? ` (now: ${x.info})` : ''}: ${x.fix}`).join('\n')}`;
  }
  const out = await generate(WRITE_MODELS, {
    contents: [{ role: 'user', parts: [...imgs, { text: ask }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA },
  }, deadline);
  let json;
  try { json = JSON.parse(out.text); } catch { throw new AiError(`${out.model} returned invalid JSON`); }
  const fixed = autoFixed(json, mediaIds, ctx, usedFocus);
  return { model: out.model, json, ...fixed, warnings: possibleDuplicates(fixed.product.name, ctx.products) };
}

function autoFixed(json, mediaIds, ctx, usedFocus) {
  let product = toProduct(json, mediaIds, ctx);
  product = autoFix(product, seoAudit(product, { usedFocus }));
  return { product, audit: seoAudit(product, { usedFocus }) };
}
