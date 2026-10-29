// WordPress / WooCommerce / Rank Math side of the product-draft tool.
// Saves products as DRAFTS only; nothing here can publish.

import POWER_WORDS from './power-words.mjs';

export const SKU_PREFIX = { pendants: 'VAX-JP', earings: 'VAX-JE', rings: 'VAX-JR', 'jewelry-box': 'VAX-JB', 'face-wash': 'VAX-CF', foundation: 'VAX-CFO', cosmetics: 'VAX-C', tumblers: 'VAX-T', 'decor-pieces': 'VAX-D' };

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

export async function getAll(route, query = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const { data, headers } = await api('GET', route, { query: { per_page: 100, page, ...query } });
    out.push(...data);
    if (page >= Number(headers.get('x-wp-totalpages') || 1)) return out;
  }
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const decode = (s) => String(s || '').replace(/&#8211;/g, '–').replace(/&#038;|&amp;/g, '&').replace(/&#8217;/g, '’');
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// ---------- store context (for the AI and the SKU) ----------
export function nextSku(prefix, skus) {
  const nums = skus.map((s) => s.replace(/^VAX-?/, 'VAX-')).filter((s) => s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length))).map((s) => Number(s.slice(prefix.length)));
  return prefix + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0');
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
  return {
    categories: cats.map((c) => ({ slug: c.slug, name: decode(c.name), parent: c.parent ? byId[c.parent]?.slug : null, count: c.count })),
    tags: tags.map((t) => decode(t.name)),
    products: products.map((p) => ({
      id: p.id, status: p.status, sku: p.sku, name: decode(p.name), regular_price: p.regular_price, sale_price: p.sale_price,
      categories: p.categories.map((c) => c.slug),
      focus_keyword: String(p.meta_data.find((m) => m.key === 'rank_math_focus_keyword')?.value || ''),
    })),
    nextSku: Object.fromEntries(Object.entries(SKU_PREFIX).map(([cat, prefix]) => [cat, nextSku(prefix, skus)])),
  };
}

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

export function seoAudit(p, { usedFocus = [] } = {}) {
  const kws = String(p.seo?.focus_keyword || '').split(',').map((k) => words(k).join(' ')).filter(Boolean);
  const kw = kws[0] || '';
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
  const max = t.reduce((n, x) => n + x.max, 0);
  const got = t.reduce((n, x) => n + Math.max(0, x.pts), 0);
  return { tests: t.map((x) => ({ ...x, pass: x.pts >= x.max && x.pts >= 0 })), kw, score: Math.round((got / max) * 100), fixable: t.filter((x) => x.pts < x.max || x.pts < 0) };
}

export async function usedFocusKeywords(excludeId) {
  const all = await getAll('/wc/v3/products', { status: 'any' });
  return all.filter((x) => String(x.id) !== String(excludeId)).flatMap((x) => {
    const m = x.meta_data.find((d) => d.key === 'rank_math_focus_keyword');
    return m ? [words(String(m.value).split(',')[0]).join(' ')] : [];
  });
}

// ---------- validation ----------
export function validate(p) {
  const errs = [];
  const req = (k) => { if (!p[k] || (typeof p[k] === 'string' && !p[k].trim())) errs.push(`"${k}" is required`); };
  ['name', 'short_description', 'description', 'regular_price', 'sku'].forEach(req);
  if (!Array.isArray(p.categories) || !p.categories.length) errs.push('pick at least one category');
  if (!Array.isArray(p.images) || !p.images.length) errs.push('at least one photo is required');
  for (const [i, img] of (p.images || []).entries()) {
    if (!Number.isInteger(Number(img.media_id))) errs.push(`photo ${i + 1} was not uploaded`);
    if (!img.alt || !img.alt.trim()) errs.push(`photo ${i + 1} needs alt text`);
  }
  for (const m of String(p.description || '').matchAll(IMG_PLACEHOLDER)) {
    if (!(Number(m[1]) >= 1 && Number(m[1]) <= (p.images || []).length)) errs.push(`description uses {{image:${m[1]}}} but there are ${(p.images || []).length} photos`);
  }
  const reg = Number(p.regular_price), sale = p.sale_price ? Number(p.sale_price) : null;
  if (!(reg > 0)) errs.push('regular price must be a number > 0');
  if (sale !== null && !(sale > 0 && sale < reg)) errs.push('sale price must be > 0 and lower than the regular price');
  if (!p.seo?.title || !p.seo?.description || !p.seo?.focus_keyword) errs.push('SEO title, meta description and focus keyword are required');
  if (p.seo?.title && p.seo.title.length > 65) errs.push(`SEO title is ${p.seo.title.length} chars (keep it <= 60)`);
  if (p.seo?.description && (p.seo.description.length > 160 || p.seo.description.length < 120)) errs.push(`meta description is ${p.seo.description.length} chars (keep it 120-160)`);
  return errs;
}

// ---------- media ----------
export async function uploadMedia(buf, filename, mime) {
  const { data } = await api('POST', '/wp/v2/media', {
    raw: true, body: buf,
    headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${filename}"` },
  });
  return { id: data.id, url: data.source_url, thumb: data.media_details?.sizes?.medium?.source_url || data.source_url };
}

// A smaller rendition of an uploaded photo (for the AI), falling back to the original.
export async function mediaUrlForAi(id) {
  const { data } = await api('GET', `/wp/v2/media/${id}`);
  const s = data.media_details?.sizes || {};
  return (s.large || s.medium_large || s.full || { source_url: data.source_url }).source_url;
}

function imgTag(media, alt) {
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
  const errs = validate(p);
  if (errs.length) throw Object.assign(new Error('Not valid: ' + errs.join('; ')), { status: 400 });
  p.images = p.images.map((i) => ({ ...i, update_media: true }));
  const audit = seoAudit(p, { usedFocus: await usedFocusKeywords() });
  if (audit.fixable.length && !p.force) {
    throw Object.assign(new Error(`SEO ${audit.score}/100: fix ${audit.fixable.map((x) => x.name).join(', ')}`), { status: 400, audit });
  }
  const warnings = [];
  const [cats, tags] = await Promise.all([getAll('/wc/v3/products/categories'), getAll('/wc/v3/products/tags')]);
  const catIds = p.categories.map((s) => {
    const c = cats.find((x) => x.slug === s || decode(x.name).toLowerCase() === String(s).toLowerCase());
    if (!c) throw Object.assign(new Error(`Category "${s}" does not exist.`), { status: 400 });
    return { id: c.id };
  });
  const dupSku = [];
  for (const status of ['any', 'trash']) dupSku.push(...(await api('GET', '/wc/v3/products', { query: { sku: p.sku, status } })).data);
  if (dupSku.length) throw Object.assign(new Error(`SKU ${p.sku} is already used by #${dupSku[0].id} (${decode(dupSku[0].name)}${dupSku[0].status === 'trash' ? ', in the Trash' : ''}). Change the SKU.`), { status: 409 });
  const slug = p.slug ? slugify(p.slug) : slugify(p.name);
  const dupSlug = (await api('GET', '/wc/v3/products', { query: { slug, status: 'any' } })).data;
  if (dupSlug.length) throw Object.assign(new Error(`The URL slug "${slug}" is taken by #${dupSlug[0].id}; change the slug.`), { status: 409 });
  warnings.push(...possibleDuplicates(p.name, await getAll('/wc/v3/products', { status: 'any' })));

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
