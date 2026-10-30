// AI side: Google Gemini API (free tier) over REST, plus free public market data.
// 1) research: Gemini identifies the product from the photos and proposes search phrases; the server
//    then pulls what Pakistanis type into Google (Google Suggest, gl=pk) and competitor listings with
//    prices and "sold" counts from Daraz.pk search.
// 2) write: turns photos + research into a full product listing as strict JSON.
// 3) repair: fixes the listing until the Rank Math audit passes.

import { seoAudit, slugify, words, SKU_PREFIX, mediaUrlForAi, possibleDuplicates } from './woo.mjs';
import { queryPlan, scoreListing, classify, parseHints, suggestPrice } from './market.mjs';

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
  let lastErr = new AiError('The free AI service is busy right now. Please try again in a few minutes.');
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
        lastErr = new AiError(e.name === 'TimeoutError' ? 'The free AI service is busy right now. Please try again in a few minutes.' : 'Could not reach the AI service. Please try again.');
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
        if (text) return { model, text };
        lastErr = new AiError(`The AI returned an empty answer (${cand?.finishReason || data.promptFeedback?.blockReason || 'unknown'}). Please try again.`);
        continue;
      }
      const msg = data.error?.message || res.statusText;
      if (res.status === 400 && /thinking/i.test(msg) && !noThinkingConfig.has(model)) {
        noThinkingConfig.add(model);
        lastErr = new AiError(`${model}: ${msg}`);
        continue;
      }
      lastErr = new AiError(res.status === 429
        ? 'The free AI limit has been reached. Wait a minute (or until tomorrow if the daily limit is used up) and try again.'
        : res.status === 503 ? 'The free AI service is busy right now. Please try again in a few minutes.'
          : `The AI service returned an error (HTTP ${res.status}): ${msg}`);
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
    if (!r.ok) throw new AiError(`Could not read photo #${id} from the Media Library (HTTP ${r.status}).`);
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
    brand: { type: 'STRING', description: 'brand printed on the product or packaging, exactly as written; empty string if no brand is visible' },
    product_type: { type: 'STRING', description: 'the generic product type in 1-2 words as shops name it (e.g. "pendant", "earrings", "ring", "foundation", "face wash", "vase")' },
    key_terms: { type: 'ARRAY', items: { type: 'STRING' }, description: '2-4 words or short phrases that tell THIS item apart (product line/model, motif, shape, colour), e.g. ["matt fusion"], ["triple", "black heart"]' },
    label_text: { type: 'STRING', description: 'all text that is printed on the product/label/packaging, verbatim (empty if none)' },
    details: { type: 'STRING', description: 'shape/motif, colours, finish, stones, material if visible, size cues; for cosmetics: line, size (ml/g), SPF, key ingredients' },
    confidence: { type: 'STRING', description: 'high, medium or low, with a reason' },
    must_confirm: { type: 'ARRAY', items: { type: 'STRING' } },
    categories: { type: 'ARRAY', items: { type: 'STRING' }, description: 'best matching category slugs from the list, child and parent' },
    search_seeds: { type: 'ARRAY', items: { type: 'STRING' }, description: '3-5 short phrases (2-3 words, lowercase) a Pakistani shopper would start typing into Google for this item' },
    daraz_queries: { type: 'ARRAY', items: { type: 'STRING' }, description: '2 queries to find the same item on Daraz.pk: brand + line + type for branded items, motif + type for unbranded ones' },
  },
  required: ['product', 'brand', 'product_type', 'key_terms', 'label_text', 'details', 'confidence', 'must_confirm', 'categories', 'search_seeds', 'daraz_queries'],
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

// Daraz.pk search results (best match order).
async function darazSearch(q) {
  const r = await fetch(`https://www.daraz.pk/catalog/?ajax=true&page=1&q=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Daraz HTTP ${r.status}`);
  const items = (await r.json()).mods?.listItems || [];
  return items.map((i) => ({
    id: String(i.itemId || i.nid || i.itemUrl),
    name: String(i.name || '').trim(),
    price: Number(String(i.price || '').replace(/[^\d.]/g, '')) || null,
    original: Number(String(i.originalPrice || '').replace(/[^\d.]/g, '')) || null,
    reviews: Number(i.review) || 0,
    rating: i.ratingScore ? Number(Number(i.ratingScore).toFixed(1)) : null,
    brand: i.brandName && i.brandName !== 'No Brand' ? i.brandName : '',
    sponsored: !!(i.isSponsored || i.adFlag),
    image: i.image ? String(i.image).replace(/^\/\//, 'https://') : '',
    url: 'https:' + String(i.itemUrl || '').split('?')[0],
  })).filter((i) => i.name && i.price);
}

// Runs the search plan from specific to broad until there are enough distinct listings.
async function darazCollect(queries, want = 60) {
  const seen = new Map(), used = [], errors = [];
  for (const q of queries) {
    try {
      const items = await darazSearch(q);
      used.push({ q, found: items.length });
      for (const it of items) if (!seen.has(it.id)) seen.set(it.id, { ...it, query: q });
    } catch (e) { errors.push(`${q}: ${e.message}`); }
    if (seen.size >= want) break;
  }
  return { items: [...seen.values()], used, errors };
}

async function fetchThumb(url) {
  try {
    const r = await fetch(url.replace(/(\.(jpe?g|png|webp))$/i, '$1_200x200q80.jpg'), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!/^image\//.test(type)) return null;
    return { inline_data: { mime_type: type, data: Buffer.from(await r.arrayBuffer()).toString('base64') } };
  } catch { return null; }
}

const MATCH_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { n: { type: 'INTEGER' }, match: { type: 'STRING', enum: ['exact', 'similar', 'different'] } }, required: ['n', 'match'] },
};

// The AI compares the candidates' titles (and thumbnails, when Daraz serves them) with our photo.
// Titles alone are weak for unbranded jewellery ("Heart Pendant Necklace for Girls").
async function aiMatch(candidates, ident, ourPhoto, deadline) {
  if (!candidates.length || deadline - Date.now() < 30000) return null;
  const thumbs = await Promise.all(candidates.map((c) => (c.image ? fetchThumb(c.image) : null)));
  const parts = [ourPhoto, { text: `OUR PRODUCT (photo above): ${ident.product}. Brand: ${ident.brand || 'none visible'}. Label text: ${ident.label_text || '-'}.\n\nFor each Daraz listing below decide: "exact" = the same product (same brand and product line/model; for unbranded items the same design), "similar" = same kind of item and close enough to compare prices (another seller's look-alike, similar design, other size/shade of the same line), "different" = another product (other brand, other type, accessory, bundle). Judge by the title and, when given, the listing photo.` }];
  candidates.forEach((c, i) => {
    parts.push({ text: `#${i + 1}: ${c.name} — Rs ${c.price}${c.brand ? ` — brand: ${c.brand}` : ''}` });
    if (thumbs[i]) parts.push(thumbs[i]);
  });
  try {
    const out = await generate(VISION_MODELS, {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: MATCH_SCHEMA },
    }, Math.min(deadline, Date.now() + 90000));
    const list = JSON.parse(out.text);
    return new Map(list.filter((x) => x.n >= 1 && x.n <= candidates.length).map((x) => [x.n - 1, x.match]));
  } catch { return null; } // the rule-based labels stay
}

export async function research({ mediaIds, hints, ctx, deadline = Date.now() + 270000 }) {
  const imgs = await imageParts(mediaIds);
  const idPrompt = `Look carefully at the ${mediaIds.length} product photo(s) for a Pakistani online store and identify the product.

${storeSummary(ctx)}

OWNER'S NOTES: ${hints || '(none)'}

Read every word printed on the product, label or box into label_text. Never assume real gold/silver, genuine stones or a brand that is not printed on the product or given in the owner's notes.`;
  const id = await generate(VISION_MODELS, {
    contents: [{ role: 'user', parts: [...imgs, { text: idPrompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: ID_SCHEMA },
  }, deadline - 120000); // leaves time for Google, Daraz and the match check
  let ident;
  try { ident = JSON.parse(id.text); } catch { throw new AiError('The AI returned an unreadable answer. Please try again.'); }
  ident.brand = String(ident.brand || '').trim();
  ident.categories = withParents(ident.categories || [], ctx);

  const seeds = [...new Set((ident.search_seeds || []).map((s) => s.toLowerCase().trim()).filter(Boolean))].slice(0, 5);
  const [suggest, daraz] = await Promise.all([
    Promise.all(seeds.flatMap((s) => [googleSuggest(s), googleSuggest(`${s} price in pakistan`)]).map((p) => p.catch(() => []))),
    darazCollect(queryPlan(ident, (ident.daraz_queries || []).slice(0, 2))),
  ]);
  // Phrases suggested for several seeds are the most searched; list those first.
  const count = new Map();
  for (const k of suggest.flat().map((x) => x.toLowerCase().trim())) count.set(k, (count.get(k) || 0) + 1);
  const keywords = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 40);

  // Rule-based labels for every listing, then the AI checks the best 16 candidates against our photo.
  const scored = daraz.items.map((it) => ({ ...it, ...scoreListing(it.name, ident), match: classify(it.name, ident) }))
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

  const line = (i) => `Rs ${i.price}${i.original ? ` (was ${i.original})` : ''} | ${i.reviews} reviews${i.rating ? `, ${i.rating}★` : ''} | ${i.name.slice(0, 90)} | ${i.url}`;
  const notes = [
    `IDENTIFICATION (${id.model}): ${ident.product}`,
    `BRAND: ${ident.brand || 'none visible'}   TYPE: ${ident.product_type}   KEY TERMS: ${(ident.key_terms || []).join(', ')}`,
    `LABEL TEXT: ${ident.label_text || '-'}`,
    `DETAILS: ${ident.details}`,
    `CONFIDENCE: ${ident.confidence}`,
    `MUST CONFIRM: ${(ident.must_confirm || []).join('; ') || '-'}`,
    `CATEGORY: ${ident.categories.join(', ')}`,
    '',
    `GOOGLE SEARCHES IN PAKISTAN (Google autocomplete, gl=pk; most suggested first; seeds: ${seeds.join(' | ')}):`,
    keywords.join(' | ') || '(none returned)',
    '',
    `DARAZ.PK: ${daraz.items.length} listings from ${daraz.used.map((u) => `"${u.q}" (${u.found})`).join(', ') || 'no search'}${daraz.errors.length ? `; errors: ${daraz.errors.join('; ')}` : ''}.`,
    `SAME PRODUCT (${exact.length}):`, ...exact.slice(0, 8).map(line),
    `SIMILAR (${similar.length}):`, ...similar.slice(0, 8).map(line),
    '',
    `PRICE SUGGESTION: regular Rs ${pricing.regular ?? '-'}, sale Rs ${pricing.sale ?? '-'}. ${pricing.why.join(' ')}`,
  ].join('\n');
  const sources = [...exact.slice(0, 6), ...similar.slice(0, 4)].map((i) => ({
    title: `${i.match === 'exact' ? 'Same product' : 'Similar'} · Rs ${i.price}${i.reviews ? ` · ${i.reviews} reviews` : ''} · ${i.name.slice(0, 70)}`, url: i.url,
  }));
  const market = {
    queries: daraz.used, total: daraz.items.length, aiChecked: !!ai,
    exact: exact.slice(0, 10).map(pick), similar: similar.slice(0, 10).map(pick),
    pricing: { regular: pricing.regular, sale: pricing.sale, why: pricing.why, basis: pricing.basis, exact: pricing.exact || null, similar: pricing.similar || null, shop: pricing.shop || null },
    hints: hintFacts,
  };
  return { model: id.model, notes, sources, identification: ident, keywords, market, facts: `${hints || ''}\n${ident.label_text || ''}` };
}

const pick = (i) => ({ name: i.name, price: i.price, original: i.original, reviews: i.reviews, rating: i.rating, url: i.url, match: i.match, by: i.checkedBy || 'rules' });

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

1. focus_keyword: 2-4 plain lowercase words naming the product itself, exactly as Pakistanis search it - prefer a phrase from the GOOGLE SEARCHES IN PAKISTAN list that fits this exact item (e.g. "gold heart pendant", "glycolic bright face wash", "st london foundation"). Never put price, Pakistan, buy, online, best or sale in the focus keyword or the secondary keywords (use those words in the SEO title and text instead). No accents, apostrophes or hyphens. Must NOT be one of these already used: ${JSON.stringify(used)}. secondary_keywords: 2 other plain phrases.
2. seo_title (max 60 chars): STARTS with the exact focus keyword, contains one power word (Best, Perfect, Stunning, Glowing, Luxury, Beautiful, Exclusive; note "Elegant" and "Premium" are NOT power words) and ends with "| Vaxaura" if it fits.
3. seo_description (130-155 chars): contains the exact focus keyword, "Pakistan" and "Cash on Delivery".
4. slug: the focus keyword words joined by hyphens, optionally + "-vaxaura"; max 45 chars.
5. name: "<Descriptive Name> – <Short Type>", 45-75 chars, contains the focus keyword (brand names may keep accents here).
6. short_description (HTML): one <p> whose FIRST sentence contains the exact focus keyword and "<strong>... by Vaxaura</strong>", then a <ul> with 5 <li> feature bullets.
7. description (HTML, 400-550 words - it is counted and sent back if under 350): the FIRST sentence contains the exact focus keyword inside <strong>. Sections with <h3>: product name; "Why You'll Love This <focus keyword in Title Case>" (bold sub-points); "Product Details" (<ul>: type, shape/colours/finish or brand/size/ingredients, style, occasion, sold by Vaxaura); "Styling Tips" (jewellery/decor) or "How to Use" (cosmetics); "Care"; a line about Cash on Delivery all over Pakistan and WhatsApp orders at +92 325 5023982; "Frequently Asked Questions" with 5-6 Q&As written around real search phrases. Paragraphs under 60 words. Put exactly these placeholders on their own lines between sections (they become photos): ${placeholderList(n).join(', ')}. Never use any other {{image:N}}.
8. Keyword density: over description + short description together, the focus keyword and the secondary keywords (exact phrases) must appear about once every 60-80 words in total (1.2-2.0%), naturally - FAQ questions are a good place. Never more than 2.2%.
9. image_alts: exactly ${n} strings, one per photo in order. The FIRST starts with the exact focus keyword and ends with "by Vaxaura"; the others describe the view (front, side, close-up, worn, label, packaging), each unique.
10. categories: slugs from the store list (child + parent, e.g. ["pendants","jewellery"]). tags: 6-10 in Title Case (reuse these existing tags when they fit: ${JSON.stringify(ctx.tags)}), add keyword and trend tags.
11. regular_price and sale_price: use the PRICE SUGGESTION from the research exactly (it is computed from the matching Daraz listings, Vaxaura's own prices and the owner's notes). stock_quantity: the owner's number if given, else 10. weight_kg / dimensions_cm only if you can reasonably infer them, else empty strings. attributes: 2-4 (e.g. Material, Colour, Finish, Size, Brand) with values you can see.
12. No unverifiable claims: never say real gold, karat, sterling/925 silver, genuine, real stones/diamonds/emeralds, hypoallergenic, waterproof/tarnish-proof, original/authentic, dermatologist approved or guaranteed unless the owner's notes or the LABEL TEXT say exactly that ("gold-tone", "crystal-style stones" are fine). Facts printed on the label (size, SPF, ingredients) may be stated.
13. owner_note (English, plain text): what the owner must confirm (material, stones, size, stock, authenticity) and anything uncertain about the identification. The price evidence is added automatically, do not repeat it.`;
}

// extra: { market, facts } from the research step (echoed by the browser).
function toProduct(j, mediaIds, ctx, extra = {}) {
  const kws = [j.focus_keyword, ...(j.secondary_keywords || [])].map((k) => words(k).join(' ')).filter(Boolean);
  const cats = withParents(j.categories || [], ctx);
  const pricing = extra.market?.pricing || {};
  const hintStock = extra.market?.hints?.stock;
  // SKU comes from the store, never from the model: next free number for the most specific category.
  const skuCat = cats.find((c) => SKU_PREFIX[c] && ctx.categories.find((x) => x.slug === c)?.parent) || cats.find((c) => SKU_PREFIX[c]);
  const alts = mediaIds.map((_, i) => capFirst(j.image_alts?.[i] || `${j.name} by Vaxaura – photo ${i + 1}`));
  // The model sometimes invents {{image:N}} for a photo that does not exist; drop those.
  const description = String(j.description || '').replace(/\{\{image:(\d+)\}\}/g, (m, k) => (Number(k) >= 1 && Number(k) <= mediaIds.length ? m : ''));
  return {
    name: j.name, slug: slugify(j.slug || j.focus_keyword),
    short_description: j.short_description, description,
    categories: cats, tags: (j.tags || []).map(titleCase),
    // Prices come from the market evidence, not from the model; the model's numbers are only a fallback.
    regular_price: String(pricing.regular || j.regular_price || ''), sale_price: String(pricing.regular ? pricing.sale || '' : j.sale_price || ''),
    sku: skuCat ? ctx.nextSku[skuCat] : 'VAX-' + Date.now().toString().slice(-5),
    stock_quantity: Number.isInteger(hintStock) ? hintStock : Number.isInteger(j.stock_quantity) ? j.stock_quantity : 10,
    weight: j.weight_kg || '', dimensions: j.dimensions_cm || {},
    attributes: (j.attributes || []).map((a) => ({ name: a.name, options: [a.value] })),
    images: mediaIds.map((id, i) => ({ media_id: id, alt: alts[i], update_media: true })),
    seo: { title: fitTitle(keepBrandCase(titleCase(j.seo_title), j.name)), description: j.seo_description, focus_keyword: kws.join(', ') },
    owner_note: ownerNote(j.owner_note, extra.market),
    facts: extra.facts || '',
  };
}

// The price part of the owner's note is written from the evidence, so it cannot be invented.
function ownerNote(aiNote, market) {
  if (!market?.pricing) return aiNote || '';
  const p = market.pricing;
  const list = (xs) => xs.slice(0, 3).map((i) => `  - Rs ${i.price}${i.reviews ? `, ${i.reviews} reviews` : ''}: ${i.name.slice(0, 80)} — ${i.url}`);
  return [
    `SUGGESTED PRICE (check before publishing): regular Rs ${p.regular ?? '-'}, sale Rs ${p.sale ?? '-'}.`,
    ...p.why.map((w) => `- ${w}`),
    ...(market.exact?.length ? ['Same product on Daraz:', ...list(market.exact)] : ['No listing of the same product was found on Daraz.']),
    ...(market.similar?.length ? ['Similar on Daraz:', ...list(market.similar)] : []),
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
  return p;
}

// One AI call per request (the free tier can take minutes): the first call writes the listing; when
// the browser sends `previous` (the last JSON) back, the call repairs the failing Rank Math tests.
export async function write({ mediaIds, hints, notes, ctx, previous, market, facts, deadline = Date.now() + 270000 }) {
  const extra = { market, facts };
  const usedFocus = ctx.products.map((x) => words(x.focus_keyword.split(',')[0]).join(' ')).filter(Boolean);
  const imgs = await imageParts(mediaIds);
  const base = `${storeSummary(ctx)}\n\nOWNER'S NOTES: ${hints || '(none)'}\n\nRESEARCH:\n${notes}\n\n${rules(mediaIds.length, ctx)}`;
  let ask = base;
  if (previous) {
    const prevAudit = autoFixed(previous, mediaIds, ctx, usedFocus, extra).audit;
    ask = `${base}\n\nYOUR PREVIOUS JSON:\n${JSON.stringify(previous)}\n\nIt fails these Rank Math tests - return the full corrected JSON, changing only what is needed:\n${prevAudit.fixable.map((x) => `- ${x.name}${x.info ? ` (now: ${x.info})` : ''}: ${x.fix}`).join('\n')}`;
  }
  const out = await generate(WRITE_MODELS, {
    contents: [{ role: 'user', parts: [...imgs, { text: ask }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA },
  }, deadline);
  let json;
  try { json = JSON.parse(out.text); } catch { throw new AiError('The AI returned an unreadable answer. Please try again.'); }
  const fixed = autoFixed(json, mediaIds, ctx, usedFocus, extra);
  return { model: out.model, json, ...fixed, warnings: possibleDuplicates(fixed.product.name, ctx.products) };
}

function autoFixed(json, mediaIds, ctx, usedFocus, extra) {
  let product = toProduct(json, mediaIds, ctx, extra);
  product = autoFix(product, seoAudit(product, { usedFocus }));
  return { product, audit: seoAudit(product, { usedFocus }) };
}
