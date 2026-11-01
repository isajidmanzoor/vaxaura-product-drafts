// WordPress / WooCommerce / Rank Math side of the product-draft tool.
// Saves products as DRAFTS only; nothing here can publish.

import POWER_WORDS from './power-words.mjs';
import { unsupportedClaims } from './market.mjs';
import { cannibalization } from './keywords.mjs';

export const SKU_PREFIX = { pendants: 'VAX-JP', earrings: 'VAX-JE', rings: 'VAX-JR', 'jewelry-box': 'VAX-JB', necklaces: 'VAX-N', 'face-wash': 'VAX-CF', foundation: 'VAX-CFO', cosmetics: 'VAX-C', tumblers: 'VAX-T', stanley: 'VAX-T', 'decor-pieces': 'VAX-D', 'couple-watches': 'VAX-CW' };
// Any other category (or one created later) gets the initials of its name, as the shop does by
// hand (Couple Watches -> VAX-CW).
export const skuPrefix = (slug) => SKU_PREFIX[slug] || 'VAX-' + (String(slug).split('-').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3) || 'P');
// Not offered to the AI or in the category list (still shown when a product already uses them).
export const hiddenCategory = (c, all) => c.slug === 'uncategorized' || /^qa-?test/.test(c.slug)
  || (!c.count && all.some((o) => o !== c && o.count && decode(o.name).toLowerCase() === decode(c.name).toLowerCase()));

let CFG = null;

// Reads VAXAURA_SITE / VAXAURA_WP_USER / VAXAURA_WP_APP_PASSWORD from the given env object.
export function configure(env = process.env) {
  const site = (env.VAXAURA_SITE || 'https://vaxaura.com').replace(/\/+$/, '');
  const user = env.VAXAURA_WP_USER || '';
  const pass = String(env.VAXAURA_WP_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) throw new Error('VAXAURA_WP_USER and VAXAURA_WP_APP_PASSWORD are not set.');
  CFG = { site, auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
  return CFG;
}

export const siteUrl = () => CFG.site;

export async function api(method, route, { body, headers = {}, raw = false, query } = {}) {
  if (!CFG) configure();
  if (method !== 'GET') LISTS.clear(); // anything written makes the remembered lists stale
  const url = new URL(CFG.site + '/wp-json' + route);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: CFG.auth, Accept: 'application/json', ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? (raw ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(raw ? 120000 : 45000),
      });
    } catch (e) {
      // GETs are retried; other methods only when the connection never opened (DNS/refused), since a
      // POST that timed out may already have created something.
      const neverSent = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(e.cause?.code);
      if ((method === 'GET' || neverSent) && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
      throw new Error(`${method} ${route}: ${e.message}`);
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      if (method === 'GET' && res.status >= 500 && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
      const msg = typeof data === 'object' && data ? `${data.code || ''} ${data.message || ''}` : String(data).slice(0, 300);
      const err = new Error(`${method} ${route} -> HTTP ${res.status}: ${msg.trim()}`);
      err.status = res.status; err.code = data?.code;
      throw err;
    }
    return { data, headers: res.headers };
  }
}

// Whole lists (products, categories, tags) are remembered for a minute: a warm function answers
// many calls in a row (live SEO check, research, write), and each list costs several WordPress
// requests and function time on Vercel's plan. Any write through api() forgets them at once.
const LISTS = new Map();
const LIST_TTL = 60 * 1000;
export const forgetLists = () => LISTS.clear();
export async function getAll(route, query = {}) {
  const key = route + '?' + JSON.stringify(query);
  const hit = LISTS.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL) return structuredClone(hit.value);
  const value = await fetchAll(route, query);
  LISTS.set(key, { at: Date.now(), value });
  return structuredClone(value);
}
async function fetchAll(route, query) {
  const out = [];
  for (let page = 1; ; page++) {
    const { data, headers } = await api('GET', route, { query: { per_page: 100, page, ...query } });
    out.push(...data);
    if (page >= Number(headers.get('x-wp-totalpages') || 1)) return out;
  }
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const decode = (s) => String(s || '').replace(/&#8211;/g, '–').replace(/&#038;|&amp;/g, '&').replace(/&#8217;/g, '’');
export const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// ---------- store context (for the AI and the SKU) ----------
// Keeps the number width the shop already uses for that prefix (VAX-JP07, VAX-CW002).
export function nextSku(prefix, skus) {
  const nums = skus.map((s) => s.replace(/^VAX-?/, 'VAX-')).filter((s) => s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length))).map((s) => s.slice(prefix.length));
  const width = Math.max(2, ...nums.map((n) => n.length));
  return prefix + String((nums.length ? Math.max(...nums.map(Number)) : 0) + 1).padStart(width, '0');
}

export async function storeContext() {
  const [cats, tags, products, trashed] = await Promise.all([
    getAll('/wc/v3/products/categories'),
    getAll('/wc/v3/products/tags'),
    getAll('/wc/v3/products', { status: 'any' }),
    getAll('/wc/v3/products', { status: 'trash' }),
  ]);
  const byId = Object.fromEntries(cats.map((c) => [c.id, c]));
  // WooCommerce keeps the SKUs of trashed products reserved, so they count when picking the next one.
  const skus = [...products, ...trashed].map((p) => (p.sku || '').toUpperCase().replace(/\s+/g, ''));
  const path = (c) => (c.parent && byId[c.parent] ? `${decode(byId[c.parent].name)} › ` : '') + decode(c.name);
  return {
    categories: cats.map((c) => ({ slug: c.slug, name: decode(c.name), path: path(c), parent: c.parent ? byId[c.parent]?.slug : null, count: c.count, hidden: hiddenCategory(c, cats) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    tags: tags.map((t) => decode(t.name)),
    products: products.map((p) => ({
      id: p.id, status: p.status, sku: p.sku, name: decode(p.name), slug: p.slug, url: p.permalink, regular_price: p.regular_price, sale_price: p.sale_price,
      categories: p.categories.map((c) => c.slug),
      focus_keyword: String(p.meta_data.find((m) => m.key === 'rank_math_focus_keyword')?.value || ''),
    })),
    skus,
    nextSku: Object.fromEntries(cats.map((c) => [c.slug, nextSku(skuPrefix(c.slug), skus)])),
  };
}

// The shop's products with the keywords they target, for the cannibalization check.
export function shopFromProducts(all, excludeId) {
  return all.filter((x) => String(x.id) !== String(excludeId)).map((x) => ({
    id: x.id, name: decode(x.name), status: x.status, url: x.permalink,
    keywords: String(x.meta_data.find((d) => d.key === 'rank_math_focus_keyword')?.value || '').split(',').map((k) => words(k).join(' ')).filter(Boolean),
  }));
}
export const shopKeywords = async (excludeId) => shopFromProducts(await getAll('/wc/v3/products', { status: 'any' }), excludeId);

// ---------- Rank Math SEO audit ----------
// Mirrors the 16 tests Rank Math (PRO, WooCommerce module) runs on a product on vaxaura.com, with the
// same points and counting (checked against the editor on a real draft). Rank Math's 17th test,
// "Content AI used", is removed on products by a filter in the vaxaura theme's functions.php.
export const words = (html) => (decode(String(html || '')).toLowerCase().replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
  .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []);
const phrase = (s) => ' ' + words(s).join(' ') + ' ';
const countPhrase = (hay, kw) => hay.split(' ' + kw + ' ').length - 1;
export const IMG_PLACEHOLDER = /\{\{image:(\d+)\}\}/g;

// Only placeholders that point at an existing photo count ({{image:4}} with 3 photos is dropped).
function plannedContentImages(p) {
  const placeholders = [...String(p.description).matchAll(IMG_PLACEHOLDER)].filter((m) => Number(m[1]) >= 1 && Number(m[1]) <= p.images.length).length;
  const inline = (String(p.description).match(/<img\b/gi) || []).length;
  return placeholders || p.embed_images === false ? placeholders + inline : inline + Math.min(3, p.images.length);
}

// shop: the other products with their keywords (shopKeywords); keywordPool: the real Google searches
// for this product (p.keyword_pool when the browser sends the listing back).
export function seoAudit(p, { usedFocus, shop = [], keywordPool = p.keyword_pool } = {}) {
  const kws = String(p.seo?.focus_keyword || '').split(',').map((k) => words(k).join(' ')).filter(Boolean);
  const kw = kws[0] || '';
  usedFocus ??= shop.map((o) => o.keywords?.[0]).filter(Boolean);
  const title = String(p.seo?.title || p.name || '');
  const desc = String(p.seo?.description || '');
  const slug = p.slug ? slugify(p.slug) : slugify(p.name);
  const url = `https://vaxaura.com/product/${slug}/`;
  // On products Rank Math analyses the long plus the short description (458 + 66 words were counted
  // as 524 in the editor); the first-10% test is checked against the start of both.
  const content = String(p.description || '').replace(IMG_PLACEHOLDER, '') + ' ' + String(p.short_description || '');
  const cw = words(content);
  const ctext = ' ' + cw.join(' ') + ' ';
  const head = (html) => ' ' + words(html).slice(0, Math.max(10, Math.floor(cw.length * 0.1))).join(' ') + ' ';
  const titleWords = words(title).join(' ');
  const density = cw.length ? (kws.reduce((n, k) => n + countPhrase(ctext, k), 0) / cw.length) * 100 : 0;
  // Rank Math gives full points from 1% to 2.5% (same counting: 2.29% and 1.79% matched its editor).
  const densityPts = density < 0.5 || density > 2.5 ? 0 : density <= 0.75 ? 2 : density <= 1 ? 3 : 6;
  const lenPts = cw.length >= 200 ? 8 : cw.length >= 150 ? 5 : cw.length >= 120 ? 4 : cw.length >= 100 ? 3 : cw.length >= 80 ? 2 : 0;
  const imgs = plannedContentImages(p) + (p.images.length ? 1 : 0); // + featured image
  const imgPts = Math.min(6, ({ 0: 0, 1: 1, 2: 2, 3: 4 })[imgs] ?? 6);
  const paras = String(p.description).split(/<\/p>|<\/li>|<br\s*\/?>\s*<br\s*\/?>|\n\s*\n/i).map((x) => words(x).length);
  const powerHits = words(title).filter((w) => POWER_WORDS.some((pw) => w === pw || (w.startsWith(pw) && w.length - pw.length <= 4)));
  const featuredAlt = phrase(p.images[0]?.alt || '');
  const t = [];
  const add = (id, name, max, pts, info, fix) => t.push({ id, name, max, pts, info, fix });
  add('kwSet', 'Focus keyword set', 0, kw ? 0 : -1, kw || '(none)', 'set seo.focus_keyword (the first one is the focus keyword)');
  add('kwTitle', 'Keyword in SEO title', 38, phrase(title).includes(` ${kw} `) ? 38 : 0, title, 'put the exact focus keyword in seo.title');
  add('kwTitleStart', 'Keyword at start of SEO title', 3, kw && titleWords.indexOf(kw) >= 0 && titleWords.indexOf(kw) < Math.floor(titleWords.length / 2) ? 3 : 0, '', 'start seo.title with the focus keyword');
  add('power', 'Power word in SEO title', 1, powerHits.length ? 1 : 0, powerHits.join(', '), 'add a power word to seo.title (Best, Perfect, Stunning, Glowing, Luxury, Authentic)');
  add('kwMeta', 'Keyword in meta description', 2, phrase(desc).includes(` ${kw} `) ? 2 : 0, `${desc.length} chars`, 'use the exact focus keyword in seo.description');
  add('kwUrl', 'Keyword in URL', 5, kw && slug.includes(slugify(kw)) ? 5 : 0, slug, 'the slug must contain the focus keyword words in order');
  add('urlLen', 'URL length <= 75', 4, url.length <= 75 ? 4 : 0, `${url.length} chars`, 'shorten the slug');
  add('kw10', 'Keyword in first 10% of content', 3, kw && head(p.description).includes(` ${kw} `) && head(p.short_description).includes(` ${kw} `) ? 3 : 0, '', 'use the exact focus keyword in the first sentence of BOTH description and short_description');
  add('kwContent', 'Keyword in content', 3, kw && ctext.includes(` ${kw} `) ? 3 : 0, '', 'use the exact focus keyword in description');
  add('kwAlt', 'Keyword in image alt', 2, kw && featuredAlt.includes(` ${kw} `) && (!p.images[0]?.media_id || p.images[0]?.update_media) ? 2 : 0, '', 'start the first image alt with the focus keyword');
  add('density', 'Keyword density 1-2.5% (all keywords)', 6, densityPts, `${density.toFixed(2)}%`, density > 2.5 ? 'use the keywords less often (aim 1.2-2%)' : 'use the focus and secondary keywords more often (aim 1.2-2%)');
  add('length', 'Content length >= 200 words', 8, lenPts, `${cw.length} words`, 'write a longer description');
  add('paras', 'Short paragraphs (<= 120 words)', 3, paras.every((n) => n <= 120) ? 3 : 0, `longest ${Math.max(0, ...paras)} words`, 'split long paragraphs');
  add('images', 'Images in content (4+ incl. featured)', 6, imgPts, `${imgs} image(s)`, p.images.length >= 3
    ? `place 3 photos in the description: {{image:N}} with N from 1 to ${p.images.length} only (photo 1 may be repeated there)`
    : 'add more photos (4 or more in total)');
  add('kwNew', 'Focus keyword not used before', 0, kw && !usedFocus.includes(kw) ? 0 : -1, '', 'pick a focus keyword no other product uses');
  add('schema', 'Product schema', 2, 2, 'site setting', '');
  add('reviews', 'Reviews enabled', 2, p.reviews_allowed === false ? 0 : 2, '', 'leave reviews enabled');
  // Vaxaura's own quality bar (no Rank Math points): Rank Math passes a 240-word description at 2.47%
  // density, which reads thin and stuffed. These send the AI back for one more round.
  const descWords = words(String(p.description || '').replace(IMG_PLACEHOLDER, '')).length;
  add('qLength', 'Long description 350+ words (Vaxaura)', 0, descWords >= 350 ? 0 : -1, `${descWords} words`, 'write a fuller long description (380-550 words): more detail, styling/usage, care and FAQ');
  add('qDensity', 'Keywords not stuffed, <= 2.3% (Vaxaura)', 0, density <= 2.3 ? 0 : -1, `${density.toFixed(2)}%`, 'use the keywords a little less often; write naturally (aim 1.5-2%)');
  // The focus keyword names the product; "price in pakistan" etc. belong in the title and copy
  // (it made slugs like st-london-foundation-price-in-pakistan-vaxaura).
  const kwWords = kw.split(' ').filter(Boolean);
  const kwOk = kwWords.length >= 2 && kwWords.length <= 4 && !/\b(price|prices|pakistan|buy|online|best|cheap|sale|discount)\b/.test(kw);
  add('qKw', 'Focus keyword is the product name, 2-4 words (Vaxaura)', 0, !kw || kwOk ? 0 : -1, kw, 'make the focus keyword 2-4 words naming the product itself (no price, Pakistan, buy, online, best); put those words in the title and description instead, and rebuild the slug from it');
  // Claims the photos cannot prove (real gold, 925, genuine, waterproof, original...) unless the
  // owner's notes or the label text (p.facts) say so.
  const claims = unsupportedClaims([p.name, p.short_description, p.description, p.seo?.title, p.seo?.description].join(' '), p.facts);
  add('qClaims', 'Only claims we can back up (Vaxaura)', 0, claims.length ? -1 : 0, claims.map((c) => `"${c.phrase}"`).join(', '), `remove or soften these claims, which neither the owner's notes nor the label confirm: ${claims.map((c) => c.phrase).join(', ')} (e.g. say gold-tone, crystal-style stones)`);
  // The focus keyword must be something people really search for (Google autocomplete in Pakistan),
  // not a phrase made up from the photo ("couple watches black metal").
  const pool = (Array.isArray(keywordPool) ? keywordPool : []).map((x) => words(typeof x === 'string' ? x : x?.kw).join(' ')).filter(Boolean);
  add('qKwReal', 'Focus keyword is a real Google search (Vaxaura)', 0, !kw || !pool.length || pool.includes(kw) ? 0 : -1, kw,
    `use one of these real Google searches as the focus keyword: ${pool.slice(0, 8).join(', ')}; rebuild the SEO title, meta description, slug, first sentences and the first photo alt around it`);
  // Keyword cannibalization: two Vaxaura pages for the same search split each other's ranking.
  const conflicts = cannibalization({ keywords: kws }, shop);
  const blocking = conflicts.filter((c) => c.severity === 'high');
  add('qCannibal', 'No keyword clash with other products (Vaxaura)', 0, blocking.length ? -1 : 0, blocking.map((c) => `#${c.id} ${c.name}`).join('; '),
    `choose focus and secondary keywords no other Vaxaura product targets; these clash: ${blocking.map((c) => `"${c.keyword}" (product #${c.id} ${c.reason})`).join('; ')}`);
  const max = t.reduce((n, x) => n + x.max, 0);
  const got = t.reduce((n, x) => n + Math.max(0, x.pts), 0);
  return { tests: t.map((x) => ({ ...x, pass: x.pts >= x.max && x.pts >= 0 })), kw, score: Math.round((got / max) * 100), fixable: t.filter((x) => x.pts < x.max || x.pts < 0), conflicts };
}

// ---------- validation ----------
// HTML the listing may never carry (it is shown on the shop): scripts, inline event handlers on a
// tag (onerror=…) and javascript: links. Plain text ("size one = 2") and video embeds (iframe) are fine.
export const UNSAFE_HTML = /<\s*script\b|<[^>]*\son[a-z]+\s*=|<[^>]*\b(?:href|src)\s*=\s*["']?\s*javascript\s*:/i;
export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,29}$/;

// The listing as the browser sent it, with every field in the type the checks expect (a hand-made
// or broken request must give errors, never a crash).
export function normalizeListing(p) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'number' ? String(v) : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const seo = p && typeof p.seo === 'object' && p.seo ? p.seo : {};
  const out = {
    ...p,
    name: str(p?.name), slug: str(p?.slug), sku: str(p?.sku), regular_price: str(p?.regular_price), sale_price: str(p?.sale_price),
    short_description: str(p?.short_description), description: str(p?.description), owner_note: str(p?.owner_note), facts: str(p?.facts),
    new_category: str(p?.new_category), new_category_parent: str(p?.new_category_parent),
    categories: arr(p?.categories).filter((c) => typeof c === 'string'), tags: arr(p?.tags).filter((t) => typeof t === 'string'),
    attributes: arr(p?.attributes).filter((a) => a && typeof a.name === 'string' && Array.isArray(a.options)),
    images: arr(p?.images).filter((i) => i && typeof i === 'object').map((i) => ({ ...i, alt: str(i.alt) })),
    seo: { title: str(seo.title), description: str(seo.description), focus_keyword: str(seo.focus_keyword) },
    keyword_pool: arr(p?.keyword_pool).filter((k) => typeof k === 'string'),
  };
  if (p?.stock_quantity === '' || p?.stock_quantity == null) out.stock_quantity = '';
  return out;
}

export function validate(p) {
  p = normalizeListing(p);
  const errs = [];
  const LABEL = { name: 'Product name', short_description: 'Short description', description: 'Long description', regular_price: 'Regular price', sku: 'SKU' };
  const req = (k) => { if (!p[k] || (typeof p[k] === 'string' && !p[k].trim())) errs.push(`${LABEL[k]} is required.`); };
  ['name', 'short_description', 'description', 'regular_price', 'sku'].forEach(req);
  if ((!Array.isArray(p.categories) || !p.categories.length) && !String(p.new_category || '').trim()) errs.push('Choose at least one category (or type a new one).');
  if (String(p.new_category || '').trim().length > 40) errs.push('The new category name is too long (40 characters at most).');
  if (!Array.isArray(p.images) || !p.images.length) errs.push('Add at least one photo.');
  for (const [i, img] of (p.images || []).entries()) {
    if (!Number.isInteger(Number(img.media_id))) errs.push(`Photo ${i + 1} has not been uploaded.`);
    if (!img.alt || !img.alt.trim()) errs.push(`Photo ${i + 1} needs alt text.`);
  }
  for (const m of String(p.description || '').matchAll(IMG_PLACEHOLDER)) {
    if (!(Number(m[1]) >= 1 && Number(m[1]) <= (p.images || []).length)) errs.push(`The long description refers to {{image:${m[1]}}}, but there are only ${(p.images || []).length} photos.`);
  }
  const reg = Number(p.regular_price), sale = p.sale_price ? Number(p.sale_price) : null;
  if (!(reg > 0)) errs.push('Regular price must be a number above 0.');
  if (sale !== null && !(sale > 0 && sale < reg)) errs.push('Sale price must be above 0 and lower than the regular price.');
  if (!p.seo?.title || !p.seo?.description || !p.seo?.focus_keyword) errs.push('SEO title, meta description and focus keyword are required.');
  if (p.seo?.title && p.seo.title.length > 65) errs.push(`SEO title is ${p.seo.title.length} characters; keep it to 60.`);
  if (p.seo?.description && (p.seo.description.length > 160 || p.seo.description.length < 120)) errs.push(`Meta description is ${p.seo.description.length} characters; keep it between 120 and 160.`);
  if (p.sku && !SKU_RE.test(p.sku.trim())) errs.push('SKU may only use letters, numbers and hyphens (e.g. VAX-JP07), 2–30 characters.');
  if (p.stock_quantity !== '' && !(Number.isInteger(Number(p.stock_quantity)) && Number(p.stock_quantity) >= 0)) errs.push('Stock quantity must be a whole number, 0 or more (or empty).');
  if (p.name.length > 120) errs.push('Product name is too long (120 characters at most).');
  for (const [k, label] of [['name', 'Product name'], ['short_description', 'Short description'], ['description', 'Long description'], ['owner_note', 'Owner note']]) {
    if (UNSAFE_HTML.test(p[k])) errs.push(`${label} contains a script, an event handler (on…=) or a javascript: link; remove it.`);
  }
  return errs;
}

// ---------- media ----------
export async function uploadMedia(buf, filename, mime) {
  const { data } = await api('POST', '/wp/v2/media', {
    raw: true, body: buf,
    headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${filename}"` },
  });
  // The shop may save the file again (vaxaura.com re-encodes uploads): report what it really stored.
  let bytes = Number(data.media_details?.filesize) || null;
  if (!bytes && data.source_url) bytes = Number((await fetch(data.source_url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null))?.headers.get('content-length')) || null;
  return { id: data.id, url: data.source_url, thumb: data.media_details?.sizes?.medium?.source_url || data.source_url, bytes, width: data.media_details?.width || null, mime: data.mime_type || mime };
}

// A smaller rendition of an uploaded photo (for the AI), falling back to the original.
export async function mediaUrlForAi(id) {
  const { data } = await api('GET', `/wp/v2/media/${id}`);
  const s = data.media_details?.sizes || {};
  return (s.large || s.medium_large || s.full || { source_url: data.source_url }).source_url;
}

export function imgTag(media, alt) {
  const s = media.media_details?.sizes?.large || media.media_details?.sizes?.medium_large || { source_url: media.source_url, width: media.media_details?.width, height: media.media_details?.height };
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<img class="aligncenter size-large wp-image-${media.id}" src="${s.source_url}" alt="${esc(alt)}"${s.width ? ` width="${s.width}" height="${s.height}"` : ''} />`;
}

// Puts the photos inside the description (Rank Math wants 4+ images incl. the featured one).
// {{image:N}} places photo N; without placeholders up to 3 go after the first paragraph.
function embedImages(description, media, images) {
  if (description.search(IMG_PLACEHOLDER) >= 0) return description.replace(IMG_PLACEHOLDER, (m, n) => imgTag(media[n - 1], images[n - 1].alt));
  const order = [...media.keys()].slice(1).concat(0).slice(0, 3);
  const block = order.map((i) => `<p>${imgTag(media[i], images[i].alt)}</p>`).join('\n');
  const at = description.indexOf('</p>');
  return at < 0 ? description + '\n' + block : description.slice(0, at + 4) + '\n' + block + description.slice(at + 4);
}

async function ensureTags(names, existing) {
  const ids = [];
  for (const raw of names || []) {
    // Title Case like the existing tags ("Daily Face Wash"), keeping words already capitalised.
    const name = String(raw).trim().replace(/(^|[\s-])([a-z])/g, (m, s, c) => s + c.toUpperCase()); if (!name) continue;
    const slug = slugify(name);
    let t = existing.find((x) => x.slug === slug || decode(x.name).toLowerCase() === name.toLowerCase());
    if (!t) {
      try { t = (await api('POST', '/wc/v3/products/tags', { body: { name, slug } })).data; existing.push(t); }
      catch (e) { if (e.code === 'term_exists') t = (await api('GET', '/wc/v3/products/tags', { query: { slug } })).data[0]; else throw e; }
    }
    if (t) ids.push({ id: t.id });
  }
  return ids;
}

// Products whose names share most significant words with `name` (the same item listed twice).
export function possibleDuplicates(name, products) {
  const nameWords = (s) => new Set(slugify(decode(s)).split('-').filter((w) => w.length > 2 && !['and', 'the', 'for', 'with', 'vaxaura'].includes(w)));
  const mine = nameWords(name);
  return products.filter((other) => {
    const theirs = nameWords(other.name);
    const common = [...mine].filter((w) => theirs.has(w)).length;
    return common >= 3 && common / Math.min(mine.size, theirs.size) >= 0.5;
  }).map((o) => `Possible duplicate of #${o.id} [${o.status}] "${decode(o.name)}"`);
}

// ---------- create the draft ----------
// p.images = [{ media_id, alt }] of photos uploaded by this tool (their alt text is set here).
export async function createDraft(p) {
  p = normalizeListing(p);
  const errs = validate(p);
  if (errs.length) throw Object.assign(new Error(errs.join('\n')), { status: 400 });
  p.images = p.images.map((i) => ({ ...i, update_media: true }));
  const audit = seoAudit(p, { shop: await shopKeywords() });
  if (audit.fixable.length && !p.force) {
    throw Object.assign(new Error(`SEO score is ${audit.score}/100. Still to fix: ${audit.fixable.map((x) => x.name).join('; ')}.`), { status: 400, audit });
  }
  const warnings = [];
  const [cats, tags] = await Promise.all([getAll('/wc/v3/products/categories'), getAll('/wc/v3/products/tags')]);
  const findCat = (s) => cats.find((x) => x.slug === s || decode(x.name).toLowerCase() === String(s).trim().toLowerCase());
  const catIds = (p.categories || []).map((s) => {
    const c = findCat(s);
    if (!c) throw Object.assign(new Error(`The category "${s}" does not exist in the shop.`), { status: 400 });
    return { id: c.id };
  });
  const newCat = String(p.new_category || '').trim();
  const newParent = p.new_category_parent ? findCat(p.new_category_parent) : null;
  if (p.new_category_parent && !newParent) throw Object.assign(new Error(`The parent category "${p.new_category_parent}" does not exist in the shop.`), { status: 400 });
  const dupSku = [];
  for (const status of ['any', 'trash']) dupSku.push(...(await api('GET', '/wc/v3/products', { query: { sku: p.sku, status } })).data);
  if (dupSku.length) throw Object.assign(new Error(`SKU ${p.sku} is already used by “${decode(dupSku[0].name)}” (#${dupSku[0].id}${dupSku[0].status === 'trash' ? ', in the Trash' : ''}). Please choose another SKU.`), { status: 409 });
  const slug = p.slug ? slugify(p.slug) : slugify(p.name);
  const dupSlug = (await api('GET', '/wc/v3/products', { query: { slug, status: 'any' } })).data;
  if (dupSlug.length) throw Object.assign(new Error(`The URL slug “${slug}” is already used by “${decode(dupSlug[0].name)}” (#${dupSlug[0].id}). Please change the slug.`), { status: 409 });
  warnings.push(...possibleDuplicates(p.name, await getAll('/wc/v3/products', { status: 'any' })));
  for (const c of audit.conflicts.filter((x) => x.severity === 'medium')) warnings.push(`Keyword overlap with #${c.id} “${c.name}”: ${c.reason}.`);

  // A category typed on the review page is created only now, after every other check passed
  // (an existing category with that name is reused). An empty category stays hidden in the shop.
  if (newCat) {
    let c = findCat(newCat);
    if (!c) {
      c = (await api('POST', '/wc/v3/products/categories', { body: { name: newCat, ...(newParent ? { parent: newParent.id } : {}) } })).data;
      warnings.push(`New category created: “${decode(c.name)}”.`);
    }
    for (const id of [c.id, c.parent || newParent?.id]) if (id && !catIds.some((x) => x.id === id)) catIds.push({ id });
  }

  const media = [];
  for (const img of p.images) {
    media.push((await api('POST', `/wp/v2/media/${img.media_id}`, { body: { alt_text: img.alt, title: img.alt } })).data);
  }
  const meta = [
    { key: 'rank_math_title', value: p.seo.title },
    { key: 'rank_math_description', value: p.seo.description },
    { key: 'rank_math_focus_keyword', value: p.seo.focus_keyword },
  ];
  if (p.owner_note) meta.push({ key: 'vaxaura_review_note', value: p.owner_note });
  const payload = {
    name: p.name, slug, status: 'draft', type: 'simple', catalog_visibility: 'visible', reviews_allowed: true,
    short_description: p.short_description, description: embedImages(p.description, media, p.images),
    regular_price: String(p.regular_price), sale_price: p.sale_price ? String(p.sale_price) : '',
    sku: p.sku, categories: catIds, tags: await ensureTags(p.tags, tags),
    manage_stock: p.stock_quantity != null && p.stock_quantity !== '', stock_quantity: p.stock_quantity === '' ? null : p.stock_quantity ?? null,
    stock_status: 'instock',
    weight: p.weight ? String(p.weight) : '',
    dimensions: Object.fromEntries(Object.entries(p.dimensions || {}).map(([k, v]) => [k, v ? String(v) : ''])),
    attributes: (p.attributes || []).filter((a) => a.name && a.options?.length).map((a, i) => ({ name: a.name, options: a.options, visible: true, variation: false, position: i })),
    images: media.map((m) => ({ id: m.id })),
    meta_data: meta,
  };
  const product = (await api('POST', '/wc/v3/products', { body: payload })).data;
  if (product.status !== 'draft') await api('PUT', `/wc/v3/products/${product.id}`, { body: { status: 'draft' } });
  // Rank Math may ignore its meta when written through WooCommerce; write it through its own API too.
  await api('POST', '/rankmath/v1/updateMeta', {
    body: { objectType: 'post', objectID: product.id, meta: { rank_math_title: p.seo.title, rank_math_description: p.seo.description, rank_math_focus_keyword: p.seo.focus_keyword } },
  }).catch((e) => warnings.push(`Rank Math API update skipped (${e.message}); meta saved through WooCommerce.`));
  return {
    id: product.id,
    editUrl: `${CFG.site}/wp-admin/post.php?post=${product.id}&action=edit`,
    audit, warnings,
    checks: await verifyDraft(product.id, p),
  };
}

// ---------- verify ----------
export async function verifyDraft(id, expected) {
  const { data: pr } = await api('GET', `/wc/v3/products/${id}`, { query: { context: 'edit' } });
  const meta = Object.fromEntries(pr.meta_data.map((m) => [m.key, m.value]));
  const checks = [];
  const ok = (label, pass, info = '') => checks.push({ label, pass: !!pass, info });
  ok('Status is Draft', pr.status === 'draft', pr.status);
  ok('Title', !!pr.name, decode(pr.name));
  ok('Short description', stripHtml(pr.short_description).length > 40, `${stripHtml(pr.short_description).length} chars`);
  ok('Long description', stripHtml(pr.description).length > 300, `${stripHtml(pr.description).split(' ').length} words`);
  ok('Categories', pr.categories.length > 0, pr.categories.map((c) => decode(c.name)).join(', '));
  ok('Tags', pr.tags.length > 0, pr.tags.map((t) => decode(t.name)).join(', '));
  ok('Regular price', Number(pr.regular_price) > 0, `Rs ${pr.regular_price}`);
  ok('Sale price', !pr.sale_price || Number(pr.sale_price) < Number(pr.regular_price), pr.sale_price ? `Rs ${pr.sale_price}` : 'none');
  ok('SKU', !!pr.sku, pr.sku);
  ok('Stock', pr.stock_status === 'instock', pr.manage_stock ? `${pr.stock_quantity} in stock` : pr.stock_status);
  ok('Photos (first = featured)', pr.images.length > 0, `${pr.images.length}`);
  ok('Every photo has alt text', pr.images.every((i) => i.alt && i.alt.trim()), '');
  ok('Photos inside the description', (pr.description.match(/<img\b/gi) || []).length >= Math.min(3, pr.images.length), `${(pr.description.match(/<img\b/gi) || []).length}`);
  ok('Rank Math SEO title', !!meta.rank_math_title, meta.rank_math_title || '');
  ok('Rank Math meta description', !!meta.rank_math_description, '');
  ok('Rank Math focus keyword', !!meta.rank_math_focus_keyword, meta.rank_math_focus_keyword || '');
  if (expected) ok('Prices as entered', String(expected.regular_price) === pr.regular_price && String(expected.sale_price || '') === pr.sale_price, '');
  const pub = await fetch(`${CFG.site}/?p=${id}`, { redirect: 'manual', signal: AbortSignal.timeout(30000) }).catch(() => null);
  ok('Not visible to shoppers', !!pub && pub.status !== 200, `logged-out request -> HTTP ${pub?.status ?? 'no answer'}`);
  return checks;
}
