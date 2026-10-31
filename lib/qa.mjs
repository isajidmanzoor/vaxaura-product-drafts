// QA: checks a saved product end to end, the way a careful shop owner would before publishing
// (draft safety, content, categories, SKU, price, photos, Rank Math SEO, real search keyword,
// keyword cannibalization), and a store-wide report with the same checks for analytics.
// Read-only: nothing here changes the shop.

import { api, getAll, decode, words, stripHtml, seoAudit, possibleDuplicates, hiddenCategory, siteUrl, shopFromProducts } from './woo.mjs';
import { googleSuggest } from './ai.mjs';
import { parseProductRef, keywordQa, cannibalReport, keywordCheck } from './keyword-qa.mjs';

export const PHOTO_MAX_KB = 100;
export const SKU_FORMAT = /^VAX-[A-Z]{1,4}\d{2,4}$/;

// Media details for many photos in a few requests (WordPress lists up to 100 per page).
export async function mediaInfo(ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    const { data } = await api('GET', '/wp/v2/media', { query: { include: part.join(','), per_page: 100, context: 'edit' } });
    for (const m of data) {
      const d = m.media_details || {};
      out.set(m.id, { id: m.id, mime: m.mime_type, bytes: Number(d.filesize) || null, width: d.width || null, height: d.height || null, url: m.source_url, thumb: d.sizes?.medium?.source_url || m.source_url });
    }
  }
  // Older uploads may lack the stored file size: ask the web server.
  await Promise.all([...out.values()].filter((m) => !m.bytes && m.url).map(async (m) => {
    const r = await fetch(m.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null);
    m.bytes = Number(r?.headers.get('content-length')) || null;
  }));
  return out;
}

const kb = (b) => (b ? Math.round(b / 102.4) / 10 : null);

// The product as the SEO audit expects it (description already holds the photos as <img>).
function asListing(pr) {
  const meta = Object.fromEntries(pr.meta_data.map((m) => [m.key, m.value]));
  return {
    name: decode(pr.name), slug: pr.slug, description: pr.description, short_description: pr.short_description, embed_images: false,
    images: pr.images.map((i) => ({ media_id: i.id, alt: i.alt, update_media: true })), reviews_allowed: pr.reviews_allowed,
    seo: { title: String(meta.rank_math_title || ''), description: String(meta.rank_math_description || ''), focus_keyword: String(meta.rank_math_focus_keyword || '') },
    facts: String(meta.vaxaura_review_note || ''),
  };
}

// All checks for one product. ctx: { all, cats, media } (loaded once for the store report).
// Returns { checks: [{ group, label, status: pass|warn|fail, info }], metrics, audit }.
export function grade(pr, { all, cats, media }) {
  const checks = [];
  const add = (group, label, status, info = '') => checks.push({ group, label, status, info: String(info) });
  const ok = (cond) => (cond ? 'pass' : 'fail');
  const p = asListing(pr);
  const shop = shopFromProducts(all, pr.id);
  const audit = seoAudit(p, { shop });
  const descWords = words(stripHtml(pr.description)).length;

  // Draft safety
  add('Status', 'Status', pr.status === 'draft' || pr.status === 'publish' ? 'pass' : 'warn', pr.status);

  // Content
  add('Content', 'Product name 20–80 characters', decode(pr.name).length >= 20 && decode(pr.name).length <= 80 ? 'pass' : 'warn', `${decode(pr.name).length} chars`);
  add('Content', 'Short description', ok(stripHtml(pr.short_description).length > 40), `${stripHtml(pr.short_description).length} chars`);
  add('Content', 'Long description 350+ words', descWords >= 350 ? 'pass' : descWords >= 200 ? 'warn' : 'fail', `${descWords} words`);
  add('Content', 'Tags (3 or more)', pr.tags.length >= 3 ? 'pass' : pr.tags.length ? 'warn' : 'fail', pr.tags.map((t) => decode(t.name)).join(', '));

  // Categories
  const byId = new Map(cats.map((c) => [c.id, c]));
  const its = pr.categories.map((c) => byId.get(c.id)).filter(Boolean);
  add('Categories', 'In a category', ok(its.length > 0), its.map((c) => decode(c.name)).join(', ') || 'none');
  const junk = its.filter((c) => hiddenCategory(c, cats));
  add('Categories', 'No placeholder or duplicate category', junk.length ? 'fail' : 'pass', junk.map((c) => decode(c.name)).join(', '));
  const missingParent = its.filter((c) => c.parent && !its.some((x) => x.id === c.parent)).map((c) => decode(byId.get(c.parent)?.name || c.parent));
  add('Categories', 'Parent category included', missingParent.length ? 'warn' : 'pass', missingParent.length ? `add ${missingParent.join(', ')}` : '');

  // SKU and price
  const sku = String(pr.sku || '');
  add('SKU & price', 'SKU format VAX-XX00', sku ? (SKU_FORMAT.test(sku) ? 'pass' : 'warn') : 'fail', sku || 'missing');
  const dupSku = sku && all.filter((o) => o.id !== pr.id && String(o.sku || '').toUpperCase().replace(/\s+/g, '') === sku.toUpperCase().replace(/\s+/g, ''));
  if (sku) add('SKU & price', 'SKU unique', dupSku.length ? 'fail' : 'pass', dupSku.length ? `also on #${dupSku[0].id}` : '');
  const reg = Number(pr.regular_price), sale = pr.sale_price ? Number(pr.sale_price) : null;
  add('SKU & price', 'Regular price', ok(reg > 0), reg ? `Rs ${reg}` : 'missing');
  if (sale != null) {
    const off = reg ? Math.round((1 - sale / reg) * 100) : 0;
    add('SKU & price', 'Sale price below regular, discount 70% or less', sale > 0 && sale < reg ? (off <= 70 ? 'pass' : 'warn') : 'fail', `Rs ${sale} (${off}% off)`);
  }
  add('SKU & price', 'In stock', pr.stock_status === 'instock' ? 'pass' : 'warn', pr.manage_stock ? `${pr.stock_quantity} in stock` : pr.stock_status);

  // Photos
  const photos = pr.images.map((i) => ({ id: i.id, alt: i.alt, ...(media.get(i.id) || {}) }));
  add('Photos', '4 or more photos', photos.length >= 4 ? 'pass' : photos.length ? 'warn' : 'fail', `${photos.length}`);
  const heavy = photos.filter((m) => m.bytes && m.bytes > PHOTO_MAX_KB * 1024);
  const unknown = photos.filter((m) => !m.bytes);
  add('Photos', `Every photo ${PHOTO_MAX_KB} KB or less`, heavy.length ? 'fail' : unknown.length ? 'warn' : 'pass',
    heavy.length ? heavy.map((m) => `#${m.id} ${kb(m.bytes)} KB`).join(', ') : photos.map((m) => `${kb(m.bytes) ?? '?'} KB`).join(', '));
  const oldFormat = photos.filter((m) => m.mime && m.mime !== 'image/webp');
  add('Photos', 'WebP format', oldFormat.length ? 'warn' : 'pass', oldFormat.map((m) => `#${m.id} ${m.mime}`).join(', '));
  const noAlt = photos.filter((m) => !String(m.alt || '').trim());
  add('Photos', 'Alt text on every photo', noAlt.length ? 'fail' : 'pass', noAlt.length ? `${noAlt.length} missing` : '');
  const alts = photos.map((m) => String(m.alt || '').trim().toLowerCase()).filter(Boolean);
  add('Photos', 'Alt texts all different', new Set(alts).size === alts.length ? 'pass' : 'warn', '');
  const inDesc = (pr.description.match(/<img\b/gi) || []).length;
  add('Photos', 'Photos inside the description', inDesc >= Math.min(3, photos.length) ? 'pass' : 'warn', `${inDesc}`);

  // SEO
  add('SEO', 'Rank Math score', audit.score === 100 ? 'pass' : audit.score >= 80 ? 'warn' : 'fail', `${audit.score}/100`);
  for (const t of audit.tests.filter((x) => !x.pass && !['qKwReal', 'qCannibal'].includes(x.id))) add('SEO', t.name, t.id.startsWith('q') ? 'warn' : 'fail', t.info);

  // Keywords and cannibalization
  add('Keywords', 'Focus keyword set', ok(!!audit.kw), audit.kw || 'none');
  for (const c of audit.conflicts) add('Keywords', `Keyword clash with #${c.id} ${c.name}`, c.severity === 'high' ? 'fail' : 'warn', c.reason);
  if (audit.kw && !audit.conflicts.length) add('Keywords', 'No keyword clash with other products', 'pass', '');
  const dup = possibleDuplicates(pr.name, all.filter((o) => o.id !== pr.id));
  if (dup.length) add('Keywords', 'Possibly the same product twice', 'warn', dup.join('; '));

  const totalBytes = photos.reduce((n, m) => n + (m.bytes || 0), 0);
  return {
    checks, audit,
    metrics: { words: descWords, keyword: audit.kw, score: audit.score, photos: photos.map((m) => ({ id: m.id, kb: kb(m.bytes), mime: m.mime, width: m.width, height: m.height })), totalKB: kb(totalBytes) },
  };
}

const summary = (checks) => ({
  pass: checks.filter((c) => c.status === 'pass').length,
  warn: checks.filter((c) => c.status === 'warn').length,
  fail: checks.filter((c) => c.status === 'fail').length,
});

// A product ID, a product link (vaxaura.com/product/slug/, ?p=ID) or a slug -> the product ID.
async function resolveProduct(ref) {
  const r = parseProductRef(ref, siteUrl());
  if (r.id) return r.id;
  const { data } = await api('GET', '/wc/v3/products', { query: { slug: r.slug, status: 'any' } });
  if (!data.length) throw Object.assign(new Error(`No product with the link “${r.slug}” in the shop.`), { status: 404 });
  return data[0].id;
}

// QA of one product (a draft just saved, or any product by ID or link), with the keyword & URL QA.
export async function qaProduct(ref) {
  const id = await resolveProduct(ref);
  const [{ data: pr }, all, cats] = await Promise.all([
    api('GET', `/wc/v3/products/${id}`, { query: { context: 'edit' } }).catch((e) => {
      throw e.status === 404 || e.code === 'woocommerce_rest_product_invalid_id' ? Object.assign(new Error(`No product #${id} in the shop.`), { status: 404 }) : e;
    }),
    getAll('/wc/v3/products', { status: 'any' }),
    getAll('/wc/v3/products/categories'),
  ]);
  const media = await mediaInfo(pr.images.map((i) => i.id));
  const g = grade(pr, { all, cats, media });
  const keyword = await keywordQa(pr, all, cats, { suggest: googleSuggest, site: siteUrl() });
  if (pr.status !== 'publish') {
    const pub = await fetch(`${siteUrl()}/?p=${pr.id}`, { redirect: 'manual', signal: AbortSignal.timeout(30000) }).catch(() => null);
    g.checks.unshift({ group: 'Status', label: 'Not visible to shoppers', status: pub && pub.status !== 200 ? 'pass' : 'fail', info: `logged-out request -> HTTP ${pub?.status ?? 'no answer'}` });
  }
  return {
    id: pr.id, name: decode(pr.name), status: pr.status, permalink: pr.permalink,
    editUrl: `${siteUrl()}/wp-admin/post.php?post=${pr.id}&action=edit`,
    checks: g.checks, summary: summary(g.checks), metrics: g.metrics, keyword, at: new Date().toISOString(),
  };
}

// The cannibalization section: every clash group in the shop with the fix for each product.
export async function shopCannibalization() {
  const [all, cats] = await Promise.all([getAll('/wc/v3/products', { status: 'any' }), getAll('/wc/v3/products/categories')]);
  return cannibalReport(all, cats, { suggest: googleSuggest });
}

// Is this keyword free to use? (other products, Google, related free keywords)
export async function checkKeyword(keyword) {
  return keywordCheck(keyword, await getAll('/wc/v3/products', { status: 'any' }), { suggest: googleSuggest });
}

// Store-wide analytics: every product graded the same way, plus keyword clashes, SKU and photo weight.
export async function storeReport() {
  const [all, cats] = await Promise.all([getAll('/wc/v3/products', { status: 'any' }), getAll('/wc/v3/products/categories')]);
  const media = await mediaInfo(all.flatMap((p) => p.images.map((i) => i.id)));
  const rows = all.map((pr) => {
    const g = grade(pr, { all, cats, media });
    const s = summary(g.checks);
    return {
      id: pr.id, name: decode(pr.name), status: pr.status, sku: pr.sku || '', url: pr.permalink, score: g.metrics.score, keyword: g.metrics.keyword,
      photos: g.metrics.photos.length, heavyPhotos: g.metrics.photos.filter((m) => m.kb > PHOTO_MAX_KB).length, totalKB: g.metrics.totalKB, words: g.metrics.words,
      ...s, issues: g.checks.filter((c) => c.status !== 'pass').map((c) => ({ label: c.label, status: c.status, info: c.info })),
      conflicts: g.audit.conflicts,
    };
  });
  // Each clash once (A–B, not also B–A).
  const seen = new Set();
  const clashes = rows.flatMap((r) => r.conflicts.map((c) => ({ a: { id: r.id, name: r.name, keyword: r.keyword }, b: { id: c.id, name: c.name }, severity: c.severity, reason: c.reason })))
    .filter((c) => { const k = [c.a.id, c.b.id].sort().join('-') + c.severity; if (seen.has(k)) return false; seen.add(k); return true; });
  const byStatus = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  const scores = rows.map((r) => r.score);
  const photoKB = rows.reduce((n, r) => n + (r.totalKB || 0), 0);
  const skuIssues = rows.filter((r) => !SKU_FORMAT.test(r.sku)).map((r) => ({ id: r.id, name: r.name, sku: r.sku || '(none)' }));
  return {
    at: new Date().toISOString(),
    totals: {
      products: rows.length, byStatus, avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      perfectScore: scores.filter((s) => s === 100).length, noKeyword: rows.filter((r) => !r.keyword).length,
      photos: rows.reduce((n, r) => n + r.photos, 0), heavyPhotos: rows.reduce((n, r) => n + r.heavyPhotos, 0), photoMB: Math.round(photoKB / 102.4) / 10,
      clashes: clashes.filter((c) => c.severity === 'high').length, overlaps: clashes.filter((c) => c.severity === 'medium').length, skuIssues: skuIssues.length,
    },
    clashes, skuIssues,
    junkCategories: cats.filter((c) => hiddenCategory(c, cats)).map((c) => ({ id: c.id, name: decode(c.name), slug: c.slug, count: c.count })),
    products: rows.sort((a, b) => b.fail - a.fail || a.score - b.score).map(({ conflicts, ...r }) => r),
  };
}
