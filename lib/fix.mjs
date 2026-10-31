// Applies a keyword fix (cannibalization or a better real-search keyword) to a product already in
// the shop. By default only the SEO parts change: focus keyword, SEO title, meta description, URL
// slug, main photo alt, and the old focus keyword inside the descriptions' text (never inside tags,
// so photos, links and formatting stay); the owner may also edit the name and descriptions. Nothing is written without the owner's confirmation in the browser;
// the old values are kept on the product (vaxaura_seo_backup) for Undo. WordPress itself redirects
// a live product's old URL to the new one (301, "_wp_old_slug"); that is checked after saving.

import { api, getAll, decode, words, slugify, seoAudit, shopFromProducts, siteUrl, UNSAFE_HTML } from './woo.mjs';
import { splitKeywords } from './keywords.mjs';
import { titleCase, fitTitle } from './ai.mjs';

const BACKUP = 'vaxaura_seo_backup';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "couple watches black metal" -> the same words in the copy, whatever their case and spacing.
function phraseRe(phrase) {
  const ws = words(phrase);
  return ws.length ? new RegExp(`(?<![\\p{L}\\p{N}])${ws.map(esc).join('[\\s\\u00a0]+')}(?![\\p{L}\\p{N}])`, 'giu') : null;
}
// The replacement follows the case of what it replaces (Title Case in headings, lower case in text).
function sameCase(found, to) {
  if (found === found.toUpperCase() && /\p{Lu}/u.test(found)) return to.toUpperCase();
  if (/^\p{Lu}/u.test(found)) return found.split(/\s+/).every((w) => /^\p{Lu}/u.test(w)) ? titleCase(to) : to[0].toUpperCase() + to.slice(1);
  return to;
}

// "Couple Watches, couple watches Stunning" (the old and the new keyword were side by side) -> once.
function collapse(text, kw) {
  const ws = words(kw);
  if (!ws.length) return text;
  const p = ws.map(esc).join('[\\s\\u00a0]+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${p})(?:[\\s\\u00a0]*[,–|-][\\s\\u00a0]*|[\\s\\u00a0]+)${p}(?![\\p{L}\\p{N}])`, 'giu');
  let prev;
  do { prev = text; text = text.replace(re, '$1'); } while (text !== prev);
  return text;
}

// Replaces a phrase in the text of HTML only (not inside <tags> or attributes). Returns { html, n }.
export function replaceInText(html, from, to) {
  const re = phraseRe(from);
  if (!re || !to) return { html: String(html || ''), n: 0 };
  let n = 0;
  const out = String(html || '').split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) return part;
    const before = n;
    const next = part.replace(re, (m) => { n++; return sameCase(m, to); });
    return n > before ? collapse(next, to) : next;
  }).join('');
  return { html: out, n };
}
const replaceText = (text, from, to) => replaceInText(String(text || '').replace(/</g, '\u0000'), from, to).html.replace(/\u0000/g, '<');
const hasPhrase = (text, phrase) => { const re = phraseRe(phrase); return !!re && re.test(String(text || '')); };

// The product as the SEO audit expects it.
function listing(pr, f) {
  return {
    name: f.name, slug: f.slug, description: f.description, short_description: f.short_description, embed_images: false,
    images: pr.images.map((i, k) => ({ media_id: i.id, alt: k === 0 ? f.alt : i.alt, update_media: true })), reviews_allowed: pr.reviews_allowed,
    seo: { title: f.title, description: f.meta, focus_keyword: f.focus_keyword },
  };
}
function fieldsOf(pr) {
  const meta = Object.fromEntries(pr.meta_data.map((m) => [m.key, m.value]));
  return {
    name: decode(pr.name), slug: pr.slug, title: String(meta.rank_math_title || ''), meta: String(meta.rank_math_description || ''), focus_keyword: String(meta.rank_math_focus_keyword || ''),
    alt: pr.images[0]?.alt || '', description: pr.description, short_description: pr.short_description,
  };
}

// The change for `keyword`; `edits` are the owner's own values from the preview (title, meta,
// slug, alt, secondary). all: every product in the shop (for slugs and keyword clashes).
export function planFix(pr, all, { keyword, edits = {} }) {
  // Only text values count as edits (a broken request must not crash the preview).
  edits = Object.fromEntries(Object.entries(edits && typeof edits === 'object' ? edits : {}).filter(([, v]) => typeof v === 'string'));
  const kw = words(typeof keyword === 'string' ? keyword : '').join(' ');
  if (kw.split(' ').length < 2 || kw.split(' ').length > 4) throw Object.assign(new Error('The new focus keyword must be 2–4 words.'), { status: 400 });
  const before = fieldsOf(pr);
  const [oldFocus = '', ...oldSecondary] = splitKeywords(before.focus_keyword);
  const shop = shopFromProducts(all, pr.id);
  // A clash is another product's focus keyword (a secondary keyword two products share is not one).
  const taken = new Set(shop.map((o) => o.keywords[0]).filter(Boolean));

  // Secondary keywords: the owner's, else the old ones minus clashes, the new focus and the old focus.
  const secondary = edits.secondary != null ? splitKeywords(edits.secondary).filter((k) => k !== kw)
    : oldSecondary.filter((k) => k !== kw && k !== oldFocus && !taken.has(k));
  // Same focus keyword: only the secondary keywords change (a clash there); URL, titles and alt stay.
  const sameFocus = oldFocus === kw;
  if (sameFocus && !Object.keys(edits).length && secondary.join(',') === oldSecondary.join(',')) {
    throw Object.assign(new Error(`“${kw}” is already the focus keyword of this product.`), { status: 400 });
  }
  const cap = titleCase(kw);

  let { html: description, n: nDesc } = replaceInText(before.description, oldFocus, kw);
  let { html: short_description, n: nShort } = replaceInText(before.short_description, oldFocus, kw);
  if (oldFocus === kw) { nDesc = 0; nShort = 0; description = before.description; short_description = before.short_description; }

  // SEO title: the old keyword swapped for the new one, else the new one in front; at most 60
  // characters ("| Vaxaura" goes first, then whole words from the end).
  let title = hasPhrase(before.title, oldFocus) ? replaceText(before.title, oldFocus, cap) : '';
  if (!title || !hasPhrase(title, kw)) title = `${cap} – ${before.title.trim() || decode(pr.name)}`;
  title = fitTitle(title);
  if (title.length > 60) title = title.slice(0, 61).replace(/\s+\S*$/, '').replace(/\s*[–|-]\s*$/, '');

  let meta = hasPhrase(before.meta, oldFocus) ? replaceText(before.meta, oldFocus, kw) : '';
  if (!meta || !hasPhrase(meta, kw)) meta = `${cap} by Vaxaura. ${before.meta}`.trim();
  if (meta.length > 160) meta = meta.slice(0, 157).replace(/\s+\S*$/, '') + '…';

  let alt = hasPhrase(before.alt, oldFocus) ? replaceText(before.alt, oldFocus, cap) : '';
  if (!alt || !hasPhrase(alt, kw)) alt = `${cap} by Vaxaura${before.alt ? ` – ${before.alt}` : ''}`;
  alt = alt.slice(0, 125);

  const s = slugify(kw);
  let slug = (s + '-vaxaura').length <= 45 ? s + '-vaxaura' : s;
  const usedSlugs = new Set(all.filter((o) => o.id !== pr.id).map((o) => o.slug));
  for (let k = 2; usedSlugs.has(slug); k++) slug = `${s}-vaxaura-${k}`;

  if (sameFocus) { slug = before.slug; title = before.title; meta = before.meta; alt = before.alt; }
  // The owner may also edit the product name and both descriptions in the preview.
  const own = (k) => (typeof edits[k] === 'string' && edits[k].trim() ? edits[k] : null);
  const after = {
    name: own('name')?.trim() || before.name,
    slug: edits.slug ? slugify(edits.slug) : slug, title: edits.title?.trim() || title, meta: edits.meta?.trim() || meta, alt: edits.alt?.trim() || alt,
    focus_keyword: [kw, ...secondary].join(', '), description: own('description') ?? description, short_description: own('short_description') ?? short_description,
  };
  if (after.name.length > 120) throw Object.assign(new Error('The product name is too long (120 characters at most).'), { status: 400 });
  // Only what the owner typed is checked: a product's own content (e.g. a video embed) never blocks a fix.
  if (UNSAFE_HTML.test([edits.description, edits.short_description, edits.name].filter(Boolean).join(' '))) throw Object.assign(new Error('The descriptions may not contain <script>, event handlers (on…=) or javascript: links.'), { status: 400 });
  if (after.slug !== pr.slug && usedSlugs.has(after.slug)) throw Object.assign(new Error(`The URL slug “${after.slug}” is already used by another product.`), { status: 409 });
  const auditBefore = seoAudit(listing(pr, before), { shop });
  const auditAfter = seoAudit(listing(pr, after), { shop });
  return {
    id: pr.id, name: decode(pr.name), status: pr.status, live: pr.status === 'publish', modified: pr.date_modified_gmt || null,
    keyword: kw, from: oldFocus,
    before: { name: before.name, slug: before.slug, title: before.title, meta: before.meta, alt: before.alt, focus_keyword: before.focus_keyword },
    after: {
      name: after.name, slug: after.slug, title: after.title, meta: after.meta, alt: after.alt, focus_keyword: after.focus_keyword, secondary: secondary.join(', '),
      description: after.description, short_description: after.short_description,
    },
    descriptionsEdited: after.description !== before.description || after.short_description !== before.short_description,
    editUrl: `${siteUrl()}/wp-admin/post.php?post=${pr.id}&action=edit`,
    textChanges: { description: nDesc, short_description: nShort },
    urlBefore: pr.status === 'publish' && pr.permalink ? pr.permalink : `${siteUrl()}/product/${before.slug}/`,
    urlAfter: `${siteUrl()}/product/${after.slug}/`,
    score: { before: auditBefore.score, after: auditAfter.score },
    failing: auditAfter.fixable.map((t) => t.name),
    conflicts: auditAfter.conflicts,
    full: after,
  };
}

async function load(id) {
  if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('No product ID was sent.'), { status: 400 });
  const [{ data: pr }, all] = await Promise.all([
    api('GET', `/wc/v3/products/${id}`, { query: { context: 'edit' } }),
    getAll('/wc/v3/products', { status: 'any' }),
  ]);
  return { pr, all };
}

export async function previewFix({ id, keyword, edits }) {
  const { pr, all } = await load(id);
  const { full, ...plan } = planFix(pr, all, { keyword, edits });
  return plan;
}

function readBackups(pr) {
  const raw = pr.meta_data.find((m) => m.key === BACKUP)?.value;
  try { const list = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(list) ? list : []; } catch { return []; }
}

// Writes the SEO fields, the descriptions and the main photo alt, then reads the product back.
async function write(pr, f, backups) {
  const meta = [
    { key: 'rank_math_title', value: f.title }, { key: 'rank_math_description', value: f.meta }, { key: 'rank_math_focus_keyword', value: f.focus_keyword },
    { key: BACKUP, value: JSON.stringify(backups) },
  ];
  await api('PUT', `/wc/v3/products/${pr.id}`, { body: { name: f.name, slug: f.slug, description: f.description, short_description: f.short_description, meta_data: meta } });
  if (pr.images[0] && f.alt !== pr.images[0].alt) await api('POST', `/wp/v2/media/${pr.images[0].id}`, { body: { alt_text: f.alt } });
  const warnings = [];
  await api('POST', '/rankmath/v1/updateMeta', {
    body: { objectType: 'post', objectID: pr.id, meta: { rank_math_title: f.title, rank_math_description: f.meta, rank_math_focus_keyword: f.focus_keyword } },
  }).catch((e) => warnings.push(`Rank Math API update skipped (${e.message}); saved through WooCommerce.`));
  return warnings;
}

// After saving: the fields as the shop now has them, and (live product, new URL) the old URL's redirect.
async function verify(id, f, oldUrl) {
  const { data: pr } = await api('GET', `/wc/v3/products/${id}`, { query: { context: 'edit' } });
  const m = Object.fromEntries(pr.meta_data.map((x) => [x.key, x.value]));
  const checks = [];
  const ok = (label, pass, info = '') => checks.push({ label, status: pass ? 'pass' : 'fail', info });
  ok('Product name saved', decode(pr.name) === f.name, decode(pr.name));
  ok('Focus keyword saved', m.rank_math_focus_keyword === f.focus_keyword, m.rank_math_focus_keyword);
  ok('SEO title saved', m.rank_math_title === f.title, m.rank_math_title);
  ok('Meta description saved', m.rank_math_description === f.meta, '');
  ok('URL saved', pr.slug === f.slug, pr.slug);
  ok('Main photo alt saved', !pr.images[0] || pr.images[0].alt === f.alt, pr.images[0]?.alt || '');
  if (oldUrl && pr.status === 'publish' && pr.slug !== new URL(oldUrl).pathname.split('/').filter(Boolean).pop()) {
    const r = await fetch(oldUrl, { redirect: 'manual', signal: AbortSignal.timeout(30000) }).catch(() => null);
    const to = r?.headers.get('location') || '';
    const good = r && [301, 308].includes(r.status) && to.includes(`/${pr.slug}`);
    checks.push({ label: 'Old URL redirects to the new one (301)', status: good ? 'pass' : r && [302, 307].includes(r.status) && to.includes(`/${pr.slug}`) ? 'warn' : 'fail',
      info: r ? `${r.status}${to ? ` → ${to}` : ''}` : 'no answer' });
  }
  return { checks, url: pr.permalink, status: pr.status };
}

export async function applyFix({ id, keyword, edits, modified }) {
  const { pr, all } = await load(id);
  if (modified && pr.date_modified_gmt && modified !== pr.date_modified_gmt) {
    throw Object.assign(new Error('This product was changed in WordPress after the preview. Open the preview again.'), { status: 409 });
  }
  const plan = planFix(pr, all, { keyword, edits });
  const b = fieldsOf(pr);
  const backups = [{ at: new Date().toISOString(), keyword: plan.keyword, ...b, imageId: pr.images[0]?.id || null }, ...readBackups(pr)].slice(0, 3);
  const warnings = await write(pr, plan.full, backups);
  const v = await verify(pr.id, plan.full, plan.live ? plan.urlBefore : null);
  return { id: pr.id, name: decode(pr.name), keyword: plan.keyword, score: plan.score, warnings, ...v, canUndo: true };
}

// Puts back the values saved before the last fix (WordPress redirects the newer URL back too).
export async function undoFix({ id }) {
  const { pr } = await load(id);
  const [last, ...rest] = readBackups(pr);
  if (!last) throw Object.assign(new Error('There is no earlier version of this product’s SEO fields to restore.'), { status: 400 });
  const f = { name: last.name || decode(pr.name), slug: last.slug, title: last.title, meta: last.meta, focus_keyword: last.focus_keyword, alt: last.alt, description: last.description, short_description: last.short_description };
  const warnings = await write(pr, f, rest);
  const v = await verify(pr.id, f, null);
  return { id: pr.id, name: decode(pr.name), restored: last.at, warnings, ...v, canUndo: rest.length > 0 };
}
