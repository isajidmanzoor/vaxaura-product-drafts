// Load test: how the tool behaves with a big shop, without touching vaxaura.com.
//   node cli/load-test.mjs [products=1000] [latencyMs=200]
// Starts a fake WordPress (this same file with --fake-wp, in a child process so its CPU is not
// counted) that serves N generated products the way WooCommerce does (100 per page, realistic
// JSON size, ~latencyMs per request like a real host), points the libraries at it, and times the
// operations that grow with the shop: the store context every run loads, the live SEO audit, QA of
// one product, the shop report, the cannibalization report and the size of the AI prompts.
// Each line shows WordPress requests, bytes and this process's CPU, next to Cloudflare's free-plan
// limits (50 subrequests and 10 ms CPU per request) and what a Node host (Render) would see.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CATS = [['jewellery', null, 'Jewellery'], ['pendants', 'jewellery', 'Pendants'], ['earrings', 'jewellery', 'Earrings'], ['rings', 'jewellery', 'Rings'],
  ['necklaces', 'jewellery', 'Necklaces'], ['cosmetics', null, 'Cosmetics'], ['face-wash', 'cosmetics', 'Face Wash'], ['foundation', 'cosmetics', 'Foundation'],
  ['decor-pieces', null, 'Decor Pieces'], ['couple-watches', null, 'Couple Watches'], ['tumblers', null, 'Tumblers'], ['jewelry-box', 'jewellery', 'Jewelry Box']];
const TYPE = { pendants: 'pendant', earrings: 'earrings', rings: 'ring', necklaces: 'necklace', 'face-wash': 'face wash', foundation: 'foundation', 'decor-pieces': 'vase', 'couple-watches': 'couple watch', tumblers: 'tumbler', 'jewelry-box': 'jewelry box' };
const ADJ = ['gold', 'silver', 'black', 'rose gold', 'crystal', 'pearl', 'emerald', 'matte', 'white', 'green'];
const MOTIF = ['heart', 'star', 'butterfly', 'leaf', 'moon', 'flower', 'infinity', 'clover', 'drop', 'bow'];
const WORDS = 'this listing describes the item in plain words for a shopper in pakistan with cash on delivery all over the country and whatsapp orders the finish the colour the stones and the size are named here so the reader knows exactly what arrives'.split(' ');
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function makeProducts(n) {
  const leaf = CATS.filter((c) => c[1] || !CATS.some((o) => o[1] === c[0]));
  const text = (words, kw) => { const out = []; for (let i = 0; i < words; i++) out.push(i % 70 === 0 ? kw : WORDS[(i * 7) % WORDS.length]); return out.join(' '); };
  const products = [];
  for (let i = 1; i <= n; i++) {
    const c = leaf[i % leaf.length];
    const [slug, parent, cname] = c;
    const adj = ADJ[i % ADJ.length], motif = MOTIF[(i * 3) % MOTIF.length], type = TYPE[slug] || 'item';
    // 5% of products target a keyword another product already has (real cannibalization).
    const kw = i % 20 === 0 ? `${ADJ[(i / 20) % ADJ.length]} ${MOTIF[0]} ${TYPE.pendants}` : `${adj} ${motif} ${type}`;
    const uniq = i % 20 === 0 ? '' : ` ${i}`;
    const name = `${cap(adj)} ${cap(motif)} ${cap(type)}${uniq} – ${cap(type)}`;
    const pslug = `${kw.replace(/ /g, '-')}${uniq.trim() ? '-' + i : ''}-vaxaura`;
    const status = i % 10 === 0 ? 'draft' : 'publish';
    const images = [1, 2, 3, 4].map((k) => ({ id: i * 10 + k, src: `__SITE__/uploads/${i * 10 + k}.webp`, alt: k === 1 ? `${kw} by Vaxaura` : `${name} view ${k}` }));
    const desc = `<h3>${name}</h3><p><strong>${kw}</strong> ${text(120, kw)}</p><h3>Why You'll Love This</h3><p>${text(110, kw)}</p>${images.slice(1).map((im) => `<img class="aligncenter" src="${im.src}" alt="${im.alt}" />`).join('')}<h3>Product Details</h3><ul><li>${text(30, kw)}</li><li>${text(30, kw)}</li></ul><h3>Care</h3><p>${text(80, kw)}</p><h3>Frequently Asked Questions</h3><p><strong>Is it the same as the picture?</strong> ${text(40, kw)}</p><p><strong>Is cash on delivery available?</strong> ${text(40, kw)}</p>`;
    const cats = parent ? [{ id: 100 + CATS.findIndex((x) => x[0] === slug), name: cname, slug }, { id: 100 + CATS.findIndex((x) => x[0] === parent), name: cap(parent), slug: parent }] : [{ id: 100 + CATS.findIndex((x) => x[0] === slug), name: cname, slug }];
    products.push({
      id: i, name, slug: pslug, permalink: `__SITE__/product/${pslug}/`, date_created: '2026-01-01T00:00:00', date_modified: '2026-06-01T00:00:00', type: 'simple', status,
      featured: false, catalog_visibility: 'visible', description: desc, short_description: `<p>${kw} by Vaxaura. ${text(45, kw)}</p><ul><li>${text(8, kw)}</li><li>${text(8, kw)}</li><li>${text(8, kw)}</li></ul>`,
      sku: `VAX-${slug.split('-').map((w) => w[0]).join('').toUpperCase()}${String(i).padStart(3, '0')}`, price: '1499', regular_price: '2100', sale_price: '1499', on_sale: true, purchasable: true, total_sales: i % 7,
      tax_status: 'taxable', manage_stock: true, stock_quantity: 10, stock_status: 'instock', backorders: 'no', sold_individually: false, weight: '', dimensions: { length: '', width: '', height: '' },
      shipping_required: true, reviews_allowed: true, average_rating: '0.00', rating_count: 0, categories: cats,
      tags: [{ id: 300 + (i % 40), name: `Tag ${i % 40}`, slug: `tag-${i % 40}` }, { id: 300 + ((i * 3) % 40), name: `Tag ${(i * 3) % 40}`, slug: `tag-${(i * 3) % 40}` }],
      images, attributes: [{ id: 0, name: 'Colour', options: [cap(adj)], visible: true, variation: false }],
      meta_data: [
        { id: i * 20 + 1, key: 'rank_math_focus_keyword', value: `${kw}, ${adj} ${type}${uniq}, ${motif} ${type} for women` },
        { id: i * 20 + 2, key: 'rank_math_title', value: `${cap(kw)} Stunning | Vaxaura` }, { id: i * 20 + 3, key: 'rank_math_description', value: `${kw} in Pakistan with Cash on Delivery. ${text(14, kw)}` },
        { id: i * 20 + 4, key: 'rank_math_seo_score', value: '95' }, { id: i * 20 + 5, key: 'rank_math_robots', value: ['index'] }, { id: i * 20 + 6, key: 'rank_math_analytic_object_id', value: String(i) },
        { id: i * 20 + 7, key: '_wc_review_count', value: '0' }, { id: i * 20 + 8, key: '_wc_rating_count', value: [] }, { id: i * 20 + 9, key: '_wc_average_rating', value: '0' },
        { id: i * 20 + 10, key: 'vaxaura_review_note', value: text(60, kw) }, { id: i * 20 + 11, key: '_product_image_gallery', value: images.slice(1).map((im) => im.id).join(',') },
        { id: i * 20 + 12, key: 'rank_math_internal_links_processed', value: '1' }, { id: i * 20 + 13, key: '_thumbnail_id', value: String(images[0].id) },
      ],
      _links: { self: [{ href: `__SITE__/wp-json/wc/v3/products/${i}` }], collection: [{ href: '__SITE__/wp-json/wc/v3/products' }] },
    });
  }
  return products;
}

// ---------- the fake WordPress (child process) ----------
function fakeWordPress(n, latency, port) {
  const products = makeProducts(n);
  const trashed = makeProducts(Math.max(1, Math.round(n / 50))).map((p) => ({ ...p, id: 900000 + p.id, status: 'trash', sku: p.sku + 'T', slug: p.slug + '-t' }));
  const cats = CATS.map(([slug, parent, name], i) => ({ id: 100 + i, name, slug, parent: parent ? 100 + CATS.findIndex((x) => x[0] === parent) : 0, count: products.filter((p) => p.categories.some((c) => c.slug === slug)).length }));
  const tags = Array.from({ length: 40 }, (_, i) => ({ id: 300 + i, name: `Tag ${i}`, slug: `tag-${i}`, count: 3 }));
  const media = new Map();
  for (const p of [...products, ...trashed]) for (const [k, im] of p.images.entries()) {
    media.set(im.id, { id: im.id, mime_type: 'image/webp', source_url: im.src, alt_text: im.alt, title: { rendered: im.alt },
      media_details: { width: 1200, height: 1200, ...(k === 3 && p.id % 10 === 0 ? {} : { filesize: 60000 + (im.id % 50000) }), sizes: { medium: { source_url: im.src }, large: { source_url: im.src } } } });
  }
  let stats = { requests: 0, bytes: 0, byRoute: {} };
  const site = `http://127.0.0.1:${port}`;
  const fix = (s) => s.replace(/__SITE__/g, site);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, site);
    const route = url.pathname.replace(/\d+/g, ':id');
    if (url.pathname === '/__stats') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(stats)); }
    if (url.pathname === '/__reset') { stats = { requests: 0, bytes: 0, byRoute: {} }; return res.end('ok'); }
    stats.requests++; stats.byRoute[route] = (stats.byRoute[route] || 0) + 1;
    const send = (status, body, headers = {}) => setTimeout(() => {
      const text = typeof body === 'string' ? body : fix(JSON.stringify(body));
      stats.bytes += Buffer.byteLength(text);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
      res.end(req.method === 'HEAD' ? undefined : text);
    }, latency);
    const q = Object.fromEntries(url.searchParams);
    const paged = (list) => {
      const per = Number(q.per_page || 10), page = Number(q.page || 1);
      return send(200, list.slice((page - 1) * per, page * per), { 'X-WP-Total': String(list.length), 'X-WP-TotalPages': String(Math.max(1, Math.ceil(list.length / per))) });
    };
    const fields = (list) => (q._fields ? list.map((o) => Object.fromEntries(q._fields.split(',').map((f) => [f, o[f]]).filter(([, v]) => v !== undefined))) : list);
    if (url.pathname === '/wp-json/wc/v3/products') {
      let list = q.status === 'trash' ? trashed : q.status === 'any' || !q.status ? products : products.filter((p) => p.status === q.status);
      if (q.slug) list = list.filter((p) => p.slug === q.slug);
      if (q.sku) list = list.filter((p) => p.sku.toUpperCase() === String(q.sku).toUpperCase());
      if (q.include) { const ids = new Set(q.include.split(',').map(Number)); list = list.filter((p) => ids.has(p.id)); }
      return paged(fields(list));
    }
    let m = url.pathname.match(/^\/wp-json\/wc\/v3\/products\/(\d+)$/);
    if (m) { const p = [...products, ...trashed].find((x) => x.id === Number(m[1])); return p ? send(200, p) : send(404, { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' }); }
    if (url.pathname === '/wp-json/wc/v3/products/categories') return paged(cats);
    if (url.pathname === '/wp-json/wc/v3/products/tags') return paged(q.slug ? tags.filter((t) => t.slug === q.slug) : tags);
    if (url.pathname === '/wp-json/wp/v2/media') { const ids = (q.include || '').split(',').map(Number); return paged(ids.map((id) => media.get(id)).filter(Boolean)); }
    m = url.pathname.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/);
    if (m) return media.has(Number(m[1])) ? send(200, media.get(Number(m[1]))) : send(404, { code: 'rest_post_invalid_id', message: 'Invalid post ID.' });
    if (url.pathname.startsWith('/uploads/')) { const id = Number(url.pathname.match(/(\d+)\.webp$/)?.[1]); return setTimeout(() => { stats.bytes += 0; res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': String(60000 + (id % 50000)) }); res.end(); }, latency); }
    if (url.pathname === '/' && q.p) { const p = products.find((x) => x.id === Number(q.p)); return send(p && p.status === 'publish' ? 200 : 404, '<html></html>', { 'Content-Type': 'text/html' }); }
    send(404, { code: 'rest_no_route', message: 'No route.' });
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`ready ${port}\n`));
}

// ---------- the measurements (this process) ----------
async function main() {
  const n = Number(process.argv[2] || 1000), latency = Number(process.argv[3] || 200);
  const port = 3900 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fake-wp', String(n), String(latency), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).startsWith('ready')) resolve(); }); child.on('exit', (c) => reject(new Error(`fake WordPress exited ${c}`))); });
  const site = `http://127.0.0.1:${port}`;
  Object.assign(process.env, { VAXAURA_SITE: site, VAXAURA_WP_USER: 'load', VAXAURA_WP_APP_PASSWORD: 'load-test', ADMIN_PASSWORD: 'load-test-only-1', GEMINI_API_KEY: 'none' });
  const woo = await import('../lib/woo.mjs');
  const qa = await import('../lib/qa.mjs');
  const kq = await import('../lib/keyword-qa.mjs');
  const ai = await import('../lib/ai.mjs');
  woo.configure(process.env);
  const stats = async () => (await fetch(`${site}/__stats`)).json();
  const reset = () => fetch(`${site}/__reset`);
  const rows = [];
  async function measure(label, fn, { cloudflare = true } = {}) {
    await reset();
    const cpu0 = process.cpuUsage(), t0 = performance.now();
    let note = '';
    try { const r = await fn(); if (typeof r === 'string') note = r; } catch (e) { note = `ERROR ${e.message.slice(0, 60)}`; }
    const ms = performance.now() - t0, cpu = process.cpuUsage(cpu0), s = await stats();
    const cpuMs = (cpu.user + cpu.system) / 1000;
    rows.push({ label, ms: Math.round(ms), requests: s.requests, mb: s.bytes / 1048576, cpuMs, note, cloudflare });
  }
  const log = (...a) => console.log(...a);
  log(`\nLoad test: ${n} products (+${Math.max(1, Math.round(n / 50))} in the trash), fake WordPress at ${latency} ms per request, Node ${process.version}\n`);

  let ctx;
  await measure('Store context, cold (every run, research & write)', async () => { woo.forgetLists(); ctx = await woo.storeContext(); return `${ctx.products.length} products`; });
  await measure('Store context, warm (within the 60 s list cache)', async () => { ctx = await woo.storeContext(); });
  const listing = { name: 'Gold Heart Pendant – Necklace', slug: 'gold-heart-pendant-vaxaura', short_description: '<p>gold heart pendant by Vaxaura</p>', description: '<p><strong>gold heart pendant</strong> ' + 'word '.repeat(400) + '</p>', images: [{ media_id: 1, alt: 'gold heart pendant by Vaxaura', update_media: true }], seo: { title: 'Gold Heart Pendant Stunning | Vaxaura', description: 'x'.repeat(130), focus_keyword: 'gold heart pendant, heart necklace' } };
  await measure('Live SEO audit (api/audit), cold', async () => { woo.forgetLists(); const a = woo.seoAudit(listing, { shop: await woo.shopKeywords() }); return `score ${a.score}, ${a.conflicts.length} clashes`; });
  await measure('Live SEO audit (api/audit), warm - every keystroke', async () => { woo.seoAudit(listing, { shop: await woo.shopKeywords() }); });
  await measure('QA one product (api/qa {id}), incl. Google keyword checks', async () => { const r = await qa.qaProduct(String(Math.max(1, Math.round(n / 2)))); return `${r.summary.pass} pass / ${r.summary.warn} warn / ${r.summary.fail} fail`; });
  await measure('Shop report, whole shop in one request (Node host)', async () => { woo.forgetLists(); const r = await qa.storeReport(); return `${r.totals.products} products, avg SEO ${r.totals.avgScore}`; });
  await measure('Shop report, first page of 100 (what the browser asks, cold)', async () => { woo.forgetLists(); const r = await qa.storeReport({ page: 0 }); return `${r.totals.products} of ${r.total}, ${r.pages} pages, ${r.clashes.length} clashes`; });
  await measure('Shop report, a later page of 100 (lists cached)', async () => { const r = await qa.storeReport({ page: 1 }); return `${r.totals.products} products`; });
  let suggestCalls = 0;
  await measure('Cannibalization report (api/qa {cannibal}), Google stubbed', async () => { woo.forgetLists(); const all = await woo.getAll('/wc/v3/products', { status: 'any', _fields: woo.LIGHT_FIELDS }); const cats = await woo.getAll('/wc/v3/products/categories'); const r = await kq.cannibalReport(all, cats, { suggest: async () => { suggestCalls++; return []; }, full: woo.fullProducts, maxAlternatives: 5 }); return `${r.groups.length} clash groups, ${r.totals.involved} products, Google asked ${suggestCalls} times`; });

  // The AI prompts: what every research and write request carries about the shop.
  const shop = ai.shopFromCtx(ctx);
  const cat = ctx.products.find((p) => p.status === 'publish')?.categories || [];
  const inCat = ctx.products.filter((p) => p.status === 'publish' && p.categories.some((c) => cat.includes(c))).slice(0, 40);
  const prices = inCat.map((p) => `${p.name} [${p.categories.join(',')}]: Rs ${p.regular_price} / sale Rs ${p.sale_price || '-'}`).join('\n');
  const allUsed = [...new Set(shop.flatMap((o) => o.keywords))];
  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB (~${Math.round(Buffer.byteLength(s) / 4)} tokens)`;
  log('AI prompt parts that depend on the shop (sent on every research and write request):');
  log(`  prices in the listing's category (at most 40 products): ${kb(prices)}`);
  log(`  keywords other products target, near the candidates (at most 150 of ${allUsed.length}): ${kb(JSON.stringify(allUsed.slice(0, 150)))}`);
  log(`  existing tags: ${kb(JSON.stringify(ctx.tags))}\n`);

  const pad = (s, w) => String(s).padEnd(w);
  log(pad('operation', 58), pad('time', 9), pad('WP req', 7), pad('MB', 7), pad('CPU ms', 8), 'notes');
  for (const r of rows) {
    const flags = [];
    if (r.requests > 50) flags.push('OVER 50 subrequests (Cloudflare free)');
    if (r.cpuMs > 10) flags.push(`over 10 ms CPU (Cloudflare free) - Node host OK`);
    log(pad(r.label, 58), pad(`${(r.ms / 1000).toFixed(1)} s`, 9), pad(r.requests, 7), pad(r.mb.toFixed(2), 7), pad(r.cpuMs.toFixed(0), 8), [r.note, ...flags].filter(Boolean).join(' · '));
  }
  log('\nCloudflare free plan: 50 outside requests and 10 ms CPU per request (waiting on WordPress does not count). A Node host (Render) has no such caps; only the time matters there.');
  child.kill();
}

if (process.argv[2] === '--fake-wp') fakeWordPress(Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]));
else main().catch((e) => { console.error(e); process.exit(1); });
