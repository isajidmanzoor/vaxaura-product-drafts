// Fixes for products already in the shop, beyond keywords:
// - photos: heavy or non-WebP photos are replaced by WebP versions under 100 KB that the browser
//   made (the same way as new photos); gallery and the photos inside the description switch to
//   them, alt texts are kept, the old files stay in the Media Library, and Undo puts them back.
// - SKUs: missing or untidy SKUs get the shop's format (vax - JP04 -> VAX-JP04, keeping the number
//   when it is free; otherwise the next free number for the product's category), never a duplicate.
// Nothing is written without the owner's confirmation in the browser; old values are kept for Undo.

import { api, getAll, decode, imgTag, nextSku, skuPrefix, SKU_RE } from './woo.mjs';
import { mediaInfo, PHOTO_MAX_KB, SKU_FORMAT } from './qa.mjs';

const PHOTO_BACKUP = 'vaxaura_photo_backup';
const SKU_BACKUP = 'vaxaura_sku_backup';
const LIMIT = PHOTO_MAX_KB * 1024;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function product(id) {
  if (!/^\d+$/.test(String(id))) throw fail('No product ID was sent.');
  const { data } = await api('GET', `/wc/v3/products/${id}`, { query: { context: 'edit' } }).catch((e) => {
    throw e.status === 404 ? fail(`No product #${id} in the shop.`, 404) : e;
  });
  return data;
}
const readList = (pr, key) => {
  const raw = pr.meta_data.find((m) => m.key === key)?.value;
  try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; } catch { return []; }
};

// ---------- photos ----------
export async function photoPlan({ id }) {
  const pr = await product(id);
  const media = await mediaInfo(pr.images.map((i) => i.id));
  const photos = pr.images.map((i) => {
    const m = media.get(i.id) || {};
    const heavy = m.bytes ? m.bytes > LIMIT : false;
    const notWebp = m.mime ? m.mime !== 'image/webp' : false;
    return {
      id: i.id, alt: i.alt || '', url: m.url || i.src, thumb: m.thumb || i.src, mime: m.mime || '', kb: m.bytes ? Math.round(m.bytes / 102.4) / 10 : null,
      needs: heavy || notWebp, reason: [heavy && `over ${PHOTO_MAX_KB} KB`, notWebp && 'not WebP'].filter(Boolean).join(', '),
    };
  });
  return {
    id: pr.id, name: decode(pr.name), status: pr.status, live: pr.status === 'publish', modified: pr.date_modified_gmt || null, photos,
    inDescription: (pr.description.match(/<img\b/gi) || []).length, canUndo: readList(pr, PHOTO_BACKUP).length > 0,
  };
}

// The file name of an upload without size suffix and extension ("name-1024x1024.jpg" -> "name").
const baseOf = (url) => String(url || '').split('?')[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/-\d+x\d+$/, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every <img> of an old photo (by its wp-image-ID class or its file name, any size) becomes the new
// photo; the alt written in the description is kept. Returns { html, n }.
export function swapImages(html, swaps) {
  let n = 0;
  const out = String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const s = swaps.find((x) => new RegExp(`\\bwp-image-${x.oldId}\\b`).test(tag)
      || (x.oldBase && new RegExp(`/${esc(x.oldBase)}(?:-\\d+x\\d+)?\\.(?:jpe?g|png|webp|gif)\\b`, 'i').test(tag)));
    if (!s) return tag;
    n++;
    const alt = tag.match(/\balt="([^"]*)"/i)?.[1];
    const unq = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    return imgTag(s.newMedia, alt != null ? unq(alt) : s.alt);
  });
  return { html: out, n };
}

// replace: [{ oldId, newId }] — new photos the browser uploaded (WebP or JPG, at most 100 KB).
export async function applyPhotos({ id, replace, modified }) {
  const pr = await product(id);
  if (modified && pr.date_modified_gmt && modified !== pr.date_modified_gmt) throw fail('This product was changed in WordPress after the preview. Open it again.', 409);
  const list = Array.isArray(replace) ? replace.filter((r) => r && /^\d+$/.test(String(r.oldId)) && /^\d+$/.test(String(r.newId))) : [];
  if (!list.length) throw fail('No photos to replace were sent.');
  const own = new Map(pr.images.map((i) => [i.id, i]));
  for (const r of list) if (!own.has(Number(r.oldId))) throw fail(`Photo #${r.oldId} is not one of this product's photos.`);
  if (new Set(list.map((r) => String(r.newId))).size !== list.length) throw fail('The same new photo was sent twice.');
  const swaps = [];
  for (const r of list) {
    const { data: m } = await api('GET', `/wp/v2/media/${r.newId}`, { query: { context: 'edit' } }).catch(() => ({ data: null }));
    if (!m) throw fail(`New photo #${r.newId} was not found in the Media Library.`);
    if (!['image/webp', 'image/jpeg'].includes(m.mime_type)) throw fail(`New photo #${r.newId} is ${m.mime_type}, not WebP.`);
    let bytes = Number(m.media_details?.filesize) || 0;
    if (!bytes) bytes = Number((await fetch(m.source_url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null))?.headers.get('content-length')) || 0;
    if (bytes > LIMIT) throw fail(`New photo #${r.newId} is ${Math.round(bytes / 1024)} KB, over ${PHOTO_MAX_KB} KB.`);
    const old = own.get(Number(r.oldId));
    swaps.push({ oldId: old.id, oldBase: baseOf(old.src), newMedia: m, alt: old.alt || '' });
  }
  const d = swapImages(pr.description, swaps), s = swapImages(pr.short_description, swaps);
  const backups = [{ at: new Date().toISOString(), images: pr.images.map((i) => i.id), description: pr.description, short_description: pr.short_description }, ...readList(pr, PHOTO_BACKUP)].slice(0, 3);
  for (const sw of swaps) if (sw.alt) await api('POST', `/wp/v2/media/${sw.newMedia.id}`, { body: { alt_text: sw.alt, title: sw.alt } });
  const byOld = new Map(swaps.map((x) => [x.oldId, x.newMedia.id]));
  const images = pr.images.map((i) => ({ id: byOld.get(i.id) || i.id }));
  await api('PUT', `/wc/v3/products/${pr.id}`, { body: { images, description: d.html, short_description: s.html, meta_data: [{ key: PHOTO_BACKUP, value: JSON.stringify(backups) }] } });
  return verifyPhotos(pr.id, images.map((i) => i.id), swaps, d.n + s.n);
}

async function verifyPhotos(id, expected, swaps, swapped, restored = false) {
  const { data: pr } = await api('GET', `/wc/v3/products/${id}`, { query: { context: 'edit' } });
  const media = await mediaInfo(pr.images.map((i) => i.id));
  const checks = [];
  const ok = (label, pass, info = '') => checks.push({ label, status: pass ? 'pass' : 'fail', info: String(info) });
  ok(restored ? 'Gallery has the earlier photos, same order' : 'Gallery uses the new photos, same order', JSON.stringify(pr.images.map((i) => i.id)) === JSON.stringify(expected), pr.images.map((i) => `#${i.id}`).join(', '));
  const sizes = pr.images.map((i) => media.get(i.id)?.bytes || 0);
  // After Undo the old (heavier) photos are back on purpose: their sizes are shown, not judged.
  if (restored) ok('Photo sizes (as before the fix)', true, sizes.map((b) => `${Math.round(b / 102.4) / 10} KB`).join(', '));
  else ok(`Every photo ${PHOTO_MAX_KB} KB or less`, sizes.every((b) => b && b <= LIMIT), sizes.map((b) => `${Math.round(b / 102.4) / 10} KB`).join(', '));
  ok('Every photo has alt text', pr.images.every((i) => String(i.alt || '').trim()), '');
  if (swaps.length) {
    const left = swaps.filter((x) => new RegExp(`\\bwp-image-${x.oldId}\\b`).test(pr.description + pr.short_description)).map((x) => `#${x.oldId}`);
    ok('Photos inside the description switched too', !left.length, left.length ? `still: ${left.join(', ')}` : `${swapped} replaced`);
  }
  return { id: pr.id, name: decode(pr.name), checks, url: pr.permalink, canUndo: readList(pr, PHOTO_BACKUP).length > 0 };
}

export async function undoPhotos({ id }) {
  const pr = await product(id);
  const [last, ...rest] = readList(pr, PHOTO_BACKUP);
  if (!last) throw fail('There is no earlier set of photos to restore for this product.');
  const images = last.images.map((i) => ({ id: i }));
  await api('PUT', `/wc/v3/products/${pr.id}`, { body: { images, description: last.description, short_description: last.short_description, meta_data: [{ key: PHOTO_BACKUP, value: JSON.stringify(rest) }] } });
  return verifyPhotos(pr.id, last.images, [], 0, true);
}

// ---------- SKUs ----------
// "vax – JP04", "vax- jp03", "Vax-JP02" -> "VAX-JP04" ...; null when it cannot be tidied.
export function tidySku(sku) {
  const s = String(sku || '').toUpperCase().replace(/[\s–—]+/g, '').replace(/^VAX-?/, 'VAX-');
  return SKU_FORMAT.test(s) ? s : null;
}

// products: WooCommerce products (any status); cats: categories; trashedSkus: SKUs of trashed products.
export function skuProposals(products, cats, trashedSkus = []) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[\s–—]+/g, '').replace(/^VAX-?/, 'VAX-');
  const ok = new Map();
  for (const p of products) if (SKU_FORMAT.test(String(p.sku || ''))) ok.set(String(p.sku).toUpperCase(), p.id);
  const taken = new Set([...ok.keys(), ...trashedSkus.map(norm)]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out = [];
  for (const p of products) {
    const current = String(p.sku || '');
    if (SKU_FORMAT.test(current)) continue;
    let proposed = tidySku(current), reason = 'same number, tidy format';
    if (!proposed || taken.has(proposed)) {
      const its = p.categories.map((c) => byId.get(c.id) || c);
      const cat = its.find((c) => c.parent) || its[0];
      const prefix = cat ? skuPrefix(cat.slug) : 'VAX-P';
      proposed = nextSku(prefix, [...taken]);
      reason = current ? (tidySku(current) ? 'tidy form is taken: next free number' : 'next free number for the category') : 'no SKU: next free number for the category';
    }
    taken.add(proposed);
    out.push({ id: p.id, name: decode(p.name), status: p.status, current, proposed, reason });
  }
  return out;
}

export async function skuPlan() {
  const [all, trashed, cats] = await Promise.all([getAll('/wc/v3/products', { status: 'any' }), getAll('/wc/v3/products', { status: 'trash' }), getAll('/wc/v3/products/categories')]);
  return { items: skuProposals(all, cats, trashed.map((p) => p.sku).filter(Boolean)) };
}

// items: [{ id, sku }] as confirmed (and possibly edited) by the owner.
export async function applySkus({ items }) {
  const list = Array.isArray(items) ? items.filter((i) => i && /^\d+$/.test(String(i.id)) && typeof i.sku === 'string') : [];
  if (!list.length) throw fail('No SKUs were sent.');
  const [all, trashed] = await Promise.all([getAll('/wc/v3/products', { status: 'any' }), getAll('/wc/v3/products', { status: 'trash' })]);
  const key = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
  const results = [];
  const batch = new Map();
  for (const it of list) {
    const sku = it.sku.trim().toUpperCase();
    const prod = all.find((p) => p.id === Number(it.id));
    const res = { id: Number(it.id), name: prod ? decode(prod.name) : `#${it.id}`, sku, status: 'fail', info: '' };
    results.push(res);
    if (!prod) { res.info = 'product not found'; continue; }
    if (!SKU_RE.test(sku)) { res.info = 'only letters, numbers and hyphens, 2–30 characters'; continue; }
    const other = [...all, ...trashed].find((p) => p.id !== prod.id && key(p.sku) === sku);
    if (other) { res.info = `already used by #${other.id}${other.status === 'trash' ? ' (in the Trash)' : ''}`; continue; }
    if (batch.has(sku)) { res.info = `also given to #${batch.get(sku)} in this batch`; continue; }
    batch.set(sku, prod.id);
    if (key(prod.sku) === sku) { res.status = 'pass'; res.info = 'unchanged'; continue; }
    const backups = [String(prod.sku || ''), ...readList(prod, SKU_BACKUP)].slice(0, 3);
    try {
      await api('PUT', `/wc/v3/products/${prod.id}`, { body: { sku, meta_data: [{ key: SKU_BACKUP, value: JSON.stringify(backups) }] } });
      const { data: after } = await api('GET', `/wc/v3/products/${prod.id}`);
      res.status = after.sku === sku ? 'pass' : 'fail';
      res.info = after.sku === sku ? `was “${prod.sku || 'none'}”` : `saved as “${after.sku}”`;
      res.canUndo = true;
    } catch (e) { res.info = e.message; }
  }
  return { results };
}

export async function undoSku({ id }) {
  const pr = await product(id);
  const [last, ...rest] = readList(pr, SKU_BACKUP);
  if (last == null) throw fail('There is no earlier SKU to restore for this product.');
  await api('PUT', `/wc/v3/products/${pr.id}`, { body: { sku: last, meta_data: [{ key: SKU_BACKUP, value: JSON.stringify(rest) }] } });
  const { data: after } = await api('GET', `/wc/v3/products/${pr.id}`);
  return { id: pr.id, name: decode(pr.name), sku: after.sku, status: after.sku === last ? 'pass' : 'fail', canUndo: rest.length > 0 };
}
