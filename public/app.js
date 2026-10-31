import { drawBrand, placeFor, brandAssets } from './brand.js';

const $ = (s) => document.querySelector(s);
const SCREENS = ['login', 'photos', 'progress', 'review', 'done', 'qa'];
const STEP_ORDER = ['photos', 'progress', 'review', 'done'];

// items: photos in order; each keeps its Media Library upload (media) once uploaded, so reordering is free.
const state = { items: [], media: [], notes: '', sources: [], market: null, facts: '', product: null, ctx: null, hints: '', warnings: [], dirty: false, saved: null, photoKey: '', stats: null };

// Each screen is a browser history entry, so the phone's Back button moves between steps.
let view = null;
function show(id, { history: mode = 'push' } = {}) {
  if (mode !== 'none' && id !== view) {
    // The research screen is passed through, not returned to: the next screen takes its place.
    if (mode === 'push' && view && view !== 'login' && view !== 'progress' && id !== 'login') window.history.pushState({ view: id }, '');
    else window.history.replaceState({ view: id }, '');
  }
  view = id;
  if (id !== 'login') persist();
  if (id === 'photos') syncPhotoActions();
  if (id === 'review') syncSaved();
  for (const s of SCREENS) $('#' + s).hidden = s !== id;
  const stepper = $('#stepper');
  stepper.hidden = id === 'login' || id === 'qa';
  const at = STEP_ORDER.indexOf(id);
  stepper.querySelectorAll('li').forEach((li, i) => {
    li.classList.toggle('current', i === at);
    li.classList.toggle('complete', i < at);
    if (i === at) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  $('#' + id + ' h1')?.focus({ preventScroll: true });
}

async function call(path, body) {
  const res = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `The server answered HTTP ${res.status}. Please try again.` }));
  if (res.status === 401 && path !== 'login') {
    $('#logout').hidden = true; $('#open-qa').hidden = true;
    $('#login-error').textContent = 'Your session has ended. Please sign in again; your work on this page is kept.';
    show('login');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${res.status})`), { data, status: res.status });
  return data;
}

// ---------- start / sign in ----------
async function start() {
  const me = await call('me');
  const missing = Object.entries(me.setup).filter(([, v]) => !v).map(([k]) => k);
  $('#setup').hidden = !missing.length;
  $('#setup').textContent = missing.length
    ? `Setup incomplete: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set in Vercel (Project → Settings → Environment Variables), then redeploy.`
    : '';
  if (!me.loggedIn) return show('login');
  $('#logout').hidden = false; $('#open-qa').hidden = false;
  state.ctx = await call('context');
  // First visit of this page: bring back work kept from before. After a re-login mid-way: carry on.
  const kept = restored ? null : await restore().catch(() => null);
  restored = true;
  show(kept || (state.product ? 'review' : 'photos'), { history: 'replace' });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#login-form button');
  $('#login-error').textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try { await call('login', { password: $('#password').value }); $('#password').value = ''; await start(); }
  catch (err) { $('#login-error').textContent = err.status === 401 ? 'Incorrect password.' : err.message; }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
});
$('#logout').addEventListener('click', async () => {
  if (state.dirty && !confirm('Sign out? The listing you are editing has not been saved and will be removed from this device.')) return;
  state.dirty = false;
  restored = false; // nothing more is kept from this page
  await clearKept();
  await call('logout', {}).catch(() => {});
  location.reload();
});

// ---------- branding ----------
// Every photo gets the Vaxaura branding in the browser before it is uploaded, so the drafts in
// WordPress carry it. The logo goes to the calmest spot automatically; ▲ ▼ on a photo moves it.
const BRAND_KEY = 'vx-brand';
let brandOn = true;
try { brandOn = localStorage.getItem(BRAND_KEY) !== 'off'; } catch { /* storage blocked: default on */ }
const BRAND_STEP = 0.06;

// Draws a photo at most maxSide px, with the branding when it is on. Returns the canvas and the
// height (0–1) the logo block was placed at.
async function renderPhoto(file, maxSide, cy) {
  const bmp = await decode(file);
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  if (!brandOn) return { canvas, cy: null };
  const { logo } = await brandAssets();
  const at = cy ?? placeFor(canvas);
  drawBrand(canvas, logo, { cy: at });
  return { canvas, cy: at };
}

// Thumbnail that shows exactly what will be uploaded.
async function makePreview(it) {
  if (!it.file || it.media) return; // uploaded photos are final
  const ticket = (it.ticket = (it.ticket || 0) + 1);
  try {
    if (!brandOn) { setPreview(it, null); return; }
    const { canvas, cy } = await renderPhoto(it.file, 640, it.brandY ?? it.autoY ?? null);
    if (it.brandY == null) it.autoY = cy;
    const { blob } = await encode(canvas, true, 0.85);
    if (ticket !== it.ticket || !state.items.includes(it)) return; // superseded or removed meanwhile
    setPreview(it, URL.createObjectURL(blob));
  } catch (err) {
    // Unreadable photo (e.g. HEIC in Chrome): the upload step explains it; keep the original thumbnail.
    if (ticket === it.ticket) setPreview(it, null);
  }
}
function setPreview(it, url) {
  const old = it.preview;
  it.preview = url;
  const img = it.key && state.items.includes(it) && document.querySelector(`#thumbs img[data-key="${CSS.escape(it.key)}"]`);
  if (img) img.src = url || it.url;
  // Revoked only after the thumbnail points elsewhere, so no image shows a dead link.
  if (old) URL.revokeObjectURL(old);
}
function nudgeBrand(it, dir) {
  if (it.media) return;
  const from = it.brandY ?? it.autoY ?? 0.42;
  it.brandY = Math.max(0.12, Math.min(0.7, Math.round((from + dir * BRAND_STEP) * 100) / 100));
  persist();
  makePreview(it);
}
$('#brand-on').checked = brandOn;
$('#brand-on').addEventListener('change', (e) => {
  brandOn = e.target.checked;
  try { localStorage.setItem(BRAND_KEY, brandOn ? 'on' : 'off'); } catch { /* not kept */ }
  renderThumbs();
  state.items.forEach(makePreview);
});

// ---------- 1. photos ----------
function renderThumbs() {
  const ol = $('#thumbs');
  ol.innerHTML = '';
  state.items.forEach((it, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = it.preview || it.url; img.alt = `Photo ${i + 1}`;
    if (it.key) img.dataset.key = it.key;
    const badge = document.createElement('span');
    badge.className = 'badge' + (i === 0 ? ' main' : '');
    badge.textContent = i === 0 ? 'Main photo' : String(i + 1);
    const tools = document.createElement('div');
    tools.className = 'tools';
    const buttons = [
      ['up', `Move photo ${i + 1} earlier`, '←', i === 0],
      ['del', `Remove photo ${i + 1}`, '✕', false],
      ['down', `Move photo ${i + 1} later`, '→', i === state.items.length - 1],
    ];
    // Uploaded photos are final; photos still in the browser can have their branding moved.
    if (brandOn && it.file && !it.media) buttons.push(['brand-up', `Move the branding on photo ${i + 1} up`, '▲', (it.brandY ?? it.autoY ?? 1) <= 0.12],
      ['brand-down', `Move the branding on photo ${i + 1} down`, '▼', (it.brandY ?? it.autoY ?? 0) >= 0.7]);
    for (const [act, label, text, disabled] of buttons) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.disabled = disabled;
      b.setAttribute('aria-label', label); b.title = label;
      if (act.startsWith('brand')) b.className = 'brand-btn';
      b.addEventListener('click', () => {
        if (act === 'del') {
          const [gone] = state.items.splice(i, 1);
          forget(gone);
          gone.ticket = (gone.ticket || 0) + 1; // cancels a preview still being drawn
          queueMicrotask(() => { setPreview(gone, null); if (gone.url?.startsWith('blob:')) URL.revokeObjectURL(gone.url); });
        }
        if (act === 'up') [state.items[i - 1], state.items[i]] = [state.items[i], state.items[i - 1]];
        if (act === 'down') [state.items[i + 1], state.items[i]] = [state.items[i], state.items[i + 1]];
        if (act === 'brand-up') nudgeBrand(it, -1);
        if (act === 'brand-down') nudgeBrand(it, 1);
        renderThumbs();
      });
      tools.appendChild(b);
    }
    li.append(img, badge, tools);
    ol.appendChild(li);
  });
  const n = state.items.length;
  $('#analyze').disabled = !n;
  $('#photo-count').textContent = n && n < 4
    ? `${n} photo${n > 1 ? 's' : ''} added. 4 or more photos give the listing full Rank Math image points.` : '';
  syncPhotoActions();
  persist();
}

function addFiles(list) {
  const rejected = [];
  for (const file of list) {
    if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) {
      const key = keyFor();
      const it = { file, key, url: URL.createObjectURL(file) };
      state.items.push(it);
      files('readwrite', (s) => s.put(file, key)).catch(() => {}); // kept in case the page is left before uploading
      makePreview(it);
    } else rejected.push(file.name);
  }
  $('#link-error').textContent = rejected.length ? `Not a photo, skipped: ${rejected.join(', ')}` : '';
  renderThumbs();
}
for (const id of ['#file', '#camera']) $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// Ctrl+V / ⌘V on the Photos screen adds copied photos (screenshots, "Copy image" in a browser).
// A copied photo link is added like the link box; text pasted into a field stays normal typing.
document.addEventListener('paste', (e) => {
  if (view !== 'photos' || !e.clipboardData) return;
  const stamp = Date.now();
  const pics = [...e.clipboardData.items]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile()).filter(Boolean)
    // Clipboard images are all called "image.png": give each its own name.
    .map((f, k) => new File([f], `pasted-photo-${stamp}${k ? `-${k + 1}` : ''}${EXT[f.type] || '.png'}`, { type: f.type, lastModified: stamp }));
  if (pics.length) {
    e.preventDefault();
    addFiles(pics);
    drop.classList.add('over');
    setTimeout(() => drop.classList.remove('over'), 500);
    return;
  }
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const text = e.clipboardData.getData('text/plain').trim();
  if (!/^https?:\/\/\S+(\s+https?:\/\/\S+)*$/i.test(text) || $('#link-add').disabled) return;
  e.preventDefault();
  const input = $('#link');
  input.value = [input.value.trim(), text].filter(Boolean).join(' ');
  $('#link-form').requestSubmit();
});

// The server only fetches the photo and hands it back; it is then prepared here like a photo from the device.
async function fetchLinkPhoto(url) {
  const res = await fetch('/api/fetch-photo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, raw: true }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { await call('me').catch(() => {}); }
    throw new Error(data.error || `The photo could not be fetched (HTTP ${res.status}).`);
  }
  const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const name = res.headers.get('x-file-name') || 'linked-photo';
  return new File([await res.blob()], name, { type });
}

// Photo links (supplier site, Daraz...).
$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#link');
  const links = input.value.split(/\s+/).filter(Boolean);
  const bad = links.filter((u) => !/^https?:\/\/\S+$/i.test(u));
  if (!links.length || bad.length) {
    $('#link-error').textContent = links.length ? `Not a web link: ${bad[0].slice(0, 60)}` : 'Paste a photo link that starts with https://';
    return;
  }
  $('#link-error').textContent = '';
  const btn = $('#link-add');
  btn.disabled = true;
  const failed = [];
  for (const [k, url] of links.entries()) {
    btn.textContent = 'Adding…';
    btn.setAttribute('aria-label', `Adding photo ${k + 1} of ${links.length}`);
    // Always fetched and prepared here like a photo from the device, so it is WebP under 100 KB
    // (and branded when branding is on).
    try { addFiles([await fetchLinkPhoto(url)]); } catch (err) { failed.push({ url, msg: err.message }); }
  }
  btn.disabled = false; btn.textContent = 'Add'; btn.removeAttribute('aria-label');
  input.value = failed.map((f) => f.url).join(' ');
  $('#link-error').textContent = failed.map((f) => `${f.url.length > 60 ? f.url.slice(0, 57) + '…' : f.url}: ${f.msg}`).join('\n');
});

// Shrinks a photo to at most 1600 px so each upload stays well below Vercel's 4.5 MB body limit.
async function decode(file) {
  try { return await createImageBitmap(file); } catch { /* e.g. HEIC in Chrome: try the <img> decoder (Safari) */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(`"${file.name}" could not be opened by this browser. If it is an iPhone HEIC photo, share it as JPG (or set Camera → Formats → Most Compatible) and try again.`);
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
// Every photo is saved as WebP of at most 100 KB (fast pages; see-through parts stay see-through).
// The largest size and best quality that fit are used: first the quality is lowered a little, then
// the size, never below 600 px. The branding uses the same spot as the preview.
const PHOTO_LIMIT = 100 * 1000; // bytes: under 100 KB however the KB is counted
const FIT_STEPS = [[1600, 0.85], [1600, 0.78], [1400, 0.8], [1400, 0.74], [1200, 0.8], [1200, 0.74], [1200, 0.68], [1000, 0.78],
  [1000, 0.7], [1000, 0.62], [900, 0.66], [800, 0.66], [800, 0.56], [700, 0.56], [600, 0.5]];
async function shrink(it) {
  const { canvas } = await renderPhoto(it.file, 1600, it.brandY ?? it.autoY ?? null);
  let out, side = 0, scaled = canvas;
  for (const [max, q] of FIT_STEPS) {
    if (max !== side) { side = max; scaled = scaleTo(canvas, max); }
    out = await encode(scaled, true, q);
    if (out.blob.size <= PHOTO_LIMIT) break;
  }
  const buf = new Uint8Array(await out.blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: btoa(bin), mime: out.mime, stats: { before: it.file.size, after: out.blob.size, width: scaled.width, height: scaled.height } };
}
function scaleTo(canvas, max) {
  const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
  if (k === 1) return canvas;
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const kb = (bytes) => Math.round((bytes || 0) / 102.4) / 10;
// Browsers that cannot write WebP (older Safari) hand back a PNG instead: those get a JPG, with
// see-through parts on white rather than black.
async function encode(canvas, webp, quality) {
  if (webp) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
    if (blob?.type === 'image/webp') return { blob, mime: 'image/webp' };
  }
  let src = canvas;
  if (webp) {
    src = document.createElement('canvas');
    src.width = canvas.width; src.height = canvas.height;
    const ctx = src.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, src.width, src.height);
    ctx.drawImage(canvas, 0, 0);
  }
  const blob = await new Promise((r) => src.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('This browser could not prepare the photo. Please try again or use another browser.');
  return { blob, mime: 'image/jpeg' };
}

// ---------- 2. research + writing ----------
function step(text) {
  const li = document.createElement('li');
  li.textContent = text; li.className = 'run';
  $('#steps').appendChild(li);
  return { done: (t) => { li.className = 'done'; if (t) li.textContent = t; }, fail: (t) => { li.className = 'fail'; if (t) li.textContent = t; } };
}

let ticker;
function startTimer() {
  const t0 = Date.now();
  const tick = () => { const s = Math.floor((Date.now() - t0) / 1000); $('#elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  clearInterval(ticker); tick(); ticker = setInterval(tick, 1000);
  return () => clearInterval(ticker);
}

let running = false;
async function run() {
  if (running) return;
  if (state.product && !state.saved && state.dirty && !confirm('Write a new listing? The current listing and your edits will be replaced.')) return;
  running = true;
  show('progress');
  $('#steps').innerHTML = ''; $('#progress-error').textContent = ''; $('#progress-actions').hidden = true;
  state.hints = $('#hints').value.trim();
  const started = Date.now();
  const stop = startTimer();
  let s;
  // Analytics of this run (shown after saving and in QA & analytics).
  const stats = { started, ms: {}, photos: [], rounds: 0 };
  const lap = (k, t0) => { stats.ms[k] = (stats.ms[k] || 0) + Date.now() - t0; };
  try {
    // Categories or products added in WordPress meanwhile are picked up.
    state.ctx = await call('context').catch(() => state.ctx);
    const todo = state.items.filter((it) => !it.media);
    let t0 = Date.now();
    for (const [k, it] of todo.entries()) {
      s = step(`Uploading photo ${k + 1} of ${todo.length}`);
      const { stats: ps, ...photo } = await shrink(it);
      it.media = await call('upload', { name: it.file.name, ...photo });
      stats.photos.push(ps);
      // From now on the thumbnail is the uploaded (branded) photo itself.
      const original = it.url;
      if (it.media.thumb) it.url = it.media.thumb;
      setPreview(it, null);
      if (original !== it.url && original.startsWith('blob:')) URL.revokeObjectURL(original);
      forget(it); // uploaded: the Media Library copy is kept instead of the file
      s.done(`Photo ${k + 1} of ${todo.length} uploaded · ${kb(ps.after)} KB WebP`);
    }
    lap('upload', t0);
    if (todo.length) renderThumbs(); // Photos now shows the uploaded photos, without the move buttons
    persist(true);
    state.media = state.items.map((it) => it.media);
    const mediaIds = state.media.map((m) => m.id);

    s = step('Identifying the product and researching the Pakistani market');
    t0 = Date.now();
    const r = await call('research', { mediaIds, hints: state.hints });
    lap('research', t0);
    Object.assign(state, { notes: r.notes, sources: r.sources, market: r.market, facts: r.facts });
    const ex = r.market?.exact.length || 0, si = r.market?.similar.length || 0;
    const cat = r.market?.categories?.length ? '' : r.market?.newCategory ? ` · new category: ${r.market.newCategory}` : '';
    s.done(`Identified: ${r.identification?.product || 'product'}${r.identification?.brand ? ` (${r.identification.brand})` : ''} · Daraz: ${ex} same, ${si} similar of ${r.market?.total ?? 0} · ${r.market?.keywords?.length || 0} real search keywords${cat}`);

    s = step('Writing the SEO listing');
    t0 = Date.now();
    const ask = { mediaIds, hints: state.hints, notes: state.notes, market: state.market, facts: state.facts };
    let w = await call('write', ask);
    lap('write', t0);
    stats.firstScore = w.audit.score;
    s.done(`Listing written · SEO ${w.audit.score}/100`);
    // Up to 2 repair rounds while a test still fails; each round is its own request.
    for (let round = 1; round <= 2 && w.audit.fixable.length; round++) {
      const n = w.audit.fixable.length;
      s = step(`Improving ${n} SEO check${n > 1 ? 's' : ''} (round ${round})`);
      t0 = Date.now();
      try {
        const next = await call('write', { ...ask, previous: w.json });
        stats.rounds = round;
        s.done(`Round ${round} done · SEO ${next.audit.score}/100`);
        if (next.audit.score >= w.audit.score) w = next;
      } catch (err) {
        s.fail(`Round ${round} skipped: ${err.message}`); // keep the listing; the owner can fix the rest
        break;
      } finally { lap('repair', t0); }
    }
    Object.assign(stats, { score: w.audit.score, model: w.model, keyword: w.audit.kw, ms: { ...stats.ms, total: Date.now() - started } });
    state.stats = stats;
    state.product = w.product;
    state.saved = null;
    state.photoKey = photoKey();
    state.warnings = w.warnings || [];
    $('#restored').hidden = true;
    fillForm(w.product);
    renderAudit(w.audit, []);
    // Same check the Save button runs, so problems (e.g. a missing field) show straight away.
    refreshAudit();
    renderWarnings();
    $('#review-time').textContent = `Ready in ${Math.round((Date.now() - started) / 1000)} s.`;
    state.dirty = true;
    show('review');
  } catch (err) {
    s?.fail();
    $('#progress-error').textContent = err.message;
    $('#progress-actions').hidden = false;
  } finally {
    stop();
    running = false;
    persist(); // e.g. photos uploaded before an error
  }
}
$('#analyze').addEventListener('click', run);
$('#retry').addEventListener('click', run);
$('#back').addEventListener('click', () => show('photos'));
$('#review-back').addEventListener('click', () => show('photos'));
$('#to-review').addEventListener('click', () => show('review'));
$('#done-back').addEventListener('click', () => show('review'));

const photoKey = () => state.items.map((it) => it.media?.id ?? it.key).join(',');
// "Back to the listing" only while the photos are the ones the listing was written for.
function syncPhotoActions() {
  const can = !!state.product && photoKey() === state.photoKey;
  $('#to-review').hidden = !can;
  $('#analyze').textContent = state.product ? 'Research & write a new listing' : 'Research & write listing';
}

// After saving, the review is for reference: saving again would make a second draft.
function syncSaved() {
  const s = state.saved;
  $('#saved-banner').hidden = !s;
  $('#saved-banner').innerHTML = s
    ? `Saved as draft <strong>#${s.id}</strong>. Further changes are made in WordPress: <a href="${s.editUrl}" target="_blank" rel="noopener">open the draft</a>.` : '';
  $('#save').hidden = !!s;
  if (s) $('#save-anyway').hidden = true;
}

window.addEventListener('popstate', (e) => {
  let to = e.state?.view || 'photos';
  if (running) to = 'progress'; // research keeps going; stay on its screen
  else if (to === 'progress') to = state.product ? 'review' : 'photos';
  if ((to === 'review' || to === 'done') && !state.product) to = 'photos';
  if (to === 'review' && view === 'photos' && $('#to-review').hidden) to = 'photos'; // photos changed since
  if (to === 'done' && !state.saved) to = 'review';
  if (to === 'login' || view === 'login') to = view; // sign-in is not a step
  show(to, { history: to === (e.state?.view || 'photos') ? 'none' : 'replace' });
});

// 'Possible duplicate of #271 [publish] "Name"' -> a readable sentence.
const STATUS = { publish: 'live', draft: 'draft', pending: 'pending review', private: 'private' };
function duplicateText(w) {
  const m = String(w).match(/^Possible duplicate of #(\d+) \[(\w+)\] "(.*)"$/);
  return m ? `Possibly already in the shop: “${m[3]}” (#${m[1]}, ${STATUS[m[2]] || m[2]}).` : w;
}

// ---------- 3. review ----------
// namedItem, not elements[n]: elements['length'] is the field count, not the "length" input.
const F = (n) => $('#form').elements.namedItem(n);

function fillForm(p) {
  for (const k of ['name', 'slug', 'regular_price', 'sale_price', 'sku', 'stock_quantity', 'weight', 'short_description', 'description', 'owner_note']) F(k).value = p[k] ?? '';
  for (const k of ['length', 'width', 'height']) F(k).value = p.dimensions?.[k] ?? '';
  F('tags').value = (p.tags || []).join(', ');
  F('attributes').value = (p.attributes || []).map((a) => `${a.name}: ${a.options.join(', ')}`).join('\n');
  F('focus_keyword').value = p.seo.focus_keyword; F('seo_title').value = p.seo.title; F('seo_description').value = p.seo.description;

  F('sku').dataset.auto = p.sku_auto ?? p.sku ?? '';
  renderCats(p.categories || [], p.new_category || '', p.new_category_parent || '');
  renderKeywordIdeas();

  const alts = $('#alts');
  alts.innerHTML = '';
  p.images.forEach((img, i) => {
    const row = document.createElement('div');
    row.className = 'alt';
    const thumb = document.createElement('img');
    thumb.src = state.media[i].thumb; thumb.alt = '';
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = `alt-${i}`;
    label.textContent = `Photo ${i + 1}${i === 0 ? ' (main)' : ''} — alt text`;
    const input = document.createElement('input');
    input.id = `alt-${i}`; input.dataset.alt = String(i); input.value = img.alt;
    wrap.append(label, input);
    row.append(thumb, wrap);
    alts.appendChild(row);
  });

  renderMarket(state.market);
  $('#notes').textContent = state.notes;
  updateLive();
}

// Categories as in the shop ("Jewellery › Pendants"); placeholder and empty duplicate categories are
// left out unless the listing already uses them.
function renderCats(checked, newCat = F('new_category').value, newParent = F('new_category_parent').value) {
  const cats = $('#cats');
  cats.innerHTML = '';
  const list = state.ctx?.categories || [];
  for (const c of list.filter((x) => !x.hidden || checked.includes(x.slug))) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.value = c.slug; box.checked = checked.includes(c.slug);
    label.append(box, ` ${c.path || c.name}`);
    cats.appendChild(label);
  }
  const sel = F('new_category_parent');
  sel.innerHTML = '';
  sel.append(new Option('Top level', ''));
  for (const c of list.filter((x) => !x.parent && !x.hidden)) sel.append(new Option(c.name, c.slug));
  sel.value = list.some((c) => c.slug === newParent) ? newParent : '';
  F('new_category').value = newCat;
  syncCatHint();
}
// The SKU follows the category (next free number, e.g. VAX-CW002) as long as the owner has not typed
// their own; a new category gets the initials of its name (Hair Accessories -> VAX-HA01).
function suggestSku() {
  const ctx = state.ctx || {};
  const checked = [...document.querySelectorAll('#cats input:checked')].map((i) => i.value);
  const specific = checked.find((s) => ctx.categories?.find((c) => c.slug === s)?.parent) || checked[0];
  const typed = F('new_category').value.trim();
  const same = typed && ctx.categories?.find((c) => c.name.toLowerCase() === typed.toLowerCase());
  const slug = specific || same?.slug;
  if (slug) return ctx.nextSku?.[slug] || '';
  if (!typed) return '';
  const prefix = 'VAX-' + typed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3);
  const nums = (ctx.skus || []).filter((s) => s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length))).map((s) => s.slice(prefix.length));
  const width = Math.max(2, ...nums.map((n) => n.length));
  return prefix + String((nums.length ? Math.max(...nums.map(Number)) : 0) + 1).padStart(width, '0');
}
function syncSku() {
  const box = F('sku');
  if (box.value.trim() !== (box.dataset.auto || '')) return; // typed by the owner: left alone
  const next = suggestSku();
  if (!next || next === box.value) return;
  box.value = next; box.dataset.auto = next;
}
function syncCatHint() {
  syncSku();
  const none = !$('#cats input:checked');
  const typed = F('new_category').value.trim();
  const hint = $('#cat-hint');
  hint.hidden = !none && !typed;
  hint.textContent = typed ? `“${typed}” will be created as a new category when the draft is saved (an existing category with that name is reused).`
    : 'No category fits yet: tick one above or type a new category.';
}
$('#cats-refresh').addEventListener('click', async () => {
  const btn = $('#cats-refresh');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  try {
    state.ctx = await call('context');
    renderCats([...$('#cats').querySelectorAll('input:checked')].map((i) => i.value));
    refreshAudit();
  } catch (err) { $('#form-errors').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = '↻ Refresh categories from the shop'; }
});

// Real Google searches for this product: one click makes one the focus keyword (the secondary keywords stay).
function renderKeywordIdeas() {
  const pool = state.market?.keywords || [];
  $('#kw-ideas').hidden = !pool.length;
  const box = $('#kw-chips');
  box.innerHTML = '';
  const current = F('focus_keyword').value.split(',')[0].trim().toLowerCase();
  for (const k of pool) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kw-chip' + (k.kw === current ? ' on' : ''); b.textContent = k.kw;
    b.title = `Suggested by Google ${k.hits} time${k.hits > 1 ? 's' : ''}`;
    b.addEventListener('click', () => {
      const rest = F('focus_keyword').value.split(',').slice(1).map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== k.kw);
      F('focus_keyword').value = [k.kw, ...rest].join(', ');
      F('focus_keyword').dispatchEvent(new Event('input', { bubbles: true }));
      renderKeywordIdeas();
    });
    box.appendChild(b);
  }
}

// Other products competing for the same search (from the live audit).
function renderClashes(conflicts = []) {
  $('#clash').hidden = !conflicts.length;
  const ul = $('#clash-list');
  ul.innerHTML = '';
  for (const c of conflicts) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = `sev ${c.severity}`; badge.textContent = c.severity === 'high' ? 'Must fix' : 'Check';
    const a = document.createElement(c.url ? 'a' : 'span');
    if (c.url) { a.href = c.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.textContent = `#${c.id} ${c.name}`;
    li.append(badge, ' ', a, ` (${STATUS[c.status] || c.status}) — ${c.reason}`);
    ul.appendChild(li);
  }
}

// Market evidence: how the price was suggested and which Daraz listings it rests on.
const rs = (n) => `Rs ${Number(n).toLocaleString('en-PK')}`;
function renderMarket(m) {
  const box = $('#market');
  box.innerHTML = '';
  const add = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; box.appendChild(el); return el; };
  if (!m) { add('p', 'No market data for this listing.', 'muted'); $('#price-evidence').textContent = ''; return; }
  const p = m.pricing || {};
  if (p.sale) add('p', `Suggested: ${rs(p.regular)} → ${rs(p.sale)}`, 'price-line');
  const why = add('ul', '', 'why');
  for (const w of p.why || []) { const li = document.createElement('li'); li.textContent = w; why.appendChild(li); }
  add('p', `${m.total} Daraz listings checked${m.aiChecked ? ', the closest ones compared with your photo by AI' : ''}: ${m.exact.length} same product, ${m.similar.length} similar.`, 'small muted');
  for (const [label, list, cls] of [['Same product', m.exact, 'exact'], ['Similar', m.similar, 'similar']]) {
    if (!list.length) continue;
    add('h3', label);
    const ul = add('ul', '', 'sources');
    for (const it of list.slice(0, 6)) {
      const li = document.createElement('li');
      const badge = document.createElement('span');
      badge.className = `match ${cls}`; badge.textContent = rs(it.price);
      const a = document.createElement('a');
      a.href = it.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = it.name.length > 80 ? it.name.slice(0, 77) + '…' : it.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [it.original && it.original > it.price ? `was ${rs(it.original)}` : '', it.reviews ? `${it.reviews} reviews` : '', it.rating ? `${it.rating}★` : ''].filter(Boolean).join(' · ');
      li.append(badge, ' ', a, ' ', meta);
      ul.appendChild(li);
    }
  }
  const ex = p.exact, si = p.similar;
  $('#price-evidence').textContent = p.basis === 'notes' ? 'Prices taken from your notes.'
    : ex ? `Market for the same product: ${ex.min === ex.max ? rs(ex.min) : `${rs(ex.min)}–${rs(ex.max)}`} (${ex.n} listing${ex.n > 1 ? 's' : ''}).`
      : si ? `No exact match; similar items sell for ${si.min === si.max ? rs(si.min) : `${rs(si.min)}–${rs(si.max)}`}.` : 'No market prices found — please check the price.';
}

function readForm() {
  const n = (v) => String(v ?? '').trim();
  return {
    name: n(F('name').value), slug: n(F('slug').value),
    regular_price: n(F('regular_price').value).replace(/[^\d.]/g, ''), sale_price: n(F('sale_price').value).replace(/[^\d.]/g, ''),
    sku: n(F('sku').value), sku_auto: F('sku').dataset.auto || '', stock_quantity: n(F('stock_quantity').value) === '' ? '' : Number(n(F('stock_quantity').value)),
    weight: n(F('weight').value), dimensions: { length: n(F('length').value), width: n(F('width').value), height: n(F('height').value) },
    categories: [...$('#cats').querySelectorAll('input:checked')].map((i) => i.value),
    new_category: n(F('new_category').value), new_category_parent: n(F('new_category_parent').value),
    keyword_pool: (state.market?.keywords || []).map((k) => k.kw),
    tags: F('tags').value.split(',').map(n).filter(Boolean),
    attributes: F('attributes').value.split('\n').map((l) => l.split(':')).filter((x) => x.length > 1 && n(x[0]))
      .map(([k, ...v]) => ({ name: n(k), options: v.join(':').split(',').map(n).filter(Boolean) })),
    images: state.media.map((m, i) => ({ media_id: m.id, alt: n($(`[data-alt="${i}"]`)?.value) })),
    seo: { focus_keyword: n(F('focus_keyword').value), title: n(F('seo_title').value), description: n(F('seo_description').value) },
    short_description: F('short_description').value, description: F('description').value, owner_note: F('owner_note').value,
    facts: state.facts,
  };
}

// Character counters, Google preview and description preview.
function updateLive() {
  document.querySelectorAll('.count').forEach((c) => {
    const len = F(c.dataset.for).value.trim().length;
    const min = Number(c.dataset.min || 0), max = Number(c.dataset.max);
    c.textContent = `${len}/${max}`;
    c.classList.toggle('over', len > max || (min && len < min));
    c.classList.toggle('good', len <= max && len >= min && len > 0);
  });
  $('#serp-url').textContent = `vaxaura.com › product › ${F('slug').value.trim()}`;
  $('#serp-title').textContent = F('seo_title').value.trim() || F('name').value.trim();
  $('#serp-desc').textContent = F('seo_description').value.trim();
  const html = F('description').value.replace(/\{\{image:(\d+)\}\}/g, (m, k) => (state.media[k - 1] ? `<img src="${state.media[k - 1].thumb}" alt="">` : ''));
  // Our own AI output, shown only to the signed-in owner; scripts and inline handlers are stripped anyway.
  $('#preview').innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

// Plain-English advice for each check (the server's hints are written for the AI).
const FIX = {
  kwSet: () => 'Add a focus keyword.',
  kwTitle: () => 'Use the focus keyword in the SEO title.',
  kwTitleStart: () => 'Start the SEO title with the focus keyword.',
  power: () => 'Add a power word to the SEO title (e.g. Best, Perfect, Stunning, Luxury).',
  kwMeta: () => 'Use the focus keyword in the meta description.',
  kwUrl: () => 'Put the focus keyword in the URL slug.',
  urlLen: () => 'Shorten the URL slug.',
  kw10: () => 'Use the focus keyword in the first sentence of both descriptions.',
  kwContent: () => 'Use the focus keyword in the long description.',
  kwAlt: () => 'Start the main photo’s alt text with the focus keyword.',
  density: (t) => (parseFloat(t.info) > 2.5 ? 'Use the keywords less often.' : 'Use the focus and secondary keywords a few more times.'),
  length: () => 'Write a longer description.',
  paras: () => 'Split paragraphs longer than 120 words.',
  images: () => 'Place more photos in the long description ({{image:1}}, {{image:2}} …) — 4 images including the main photo.',
  kwNew: () => 'Another product already uses this focus keyword; choose a different one.',
  reviews: () => 'Enable reviews.',
  qLength: () => 'Write a fuller long description (at least 350 words).',
  qDensity: () => 'Use the keywords less often so the text reads naturally (at most 2.3%).',
  qKw: () => 'Make the focus keyword 2–4 words naming the product (no “price”, “Pakistan”, “buy” or “best”).',
  qClaims: (t) => `Remove or soften ${t.info} — neither your notes nor the label confirm it (add it to your notes if it is true).`,
  qKwReal: () => 'Nobody searches this exact phrase. Click a real Google search under the focus keyword, then “Fix with AI” to rewrite the title, URL and text around it.',
  qCannibal: (t) => `Another Vaxaura product targets this keyword (${t.info}), so the two pages would compete on Google. Choose another keyword or click “Fix with AI”.`,
};

function renderAudit(audit, errors) {
  const full = audit.score === 100;
  $('#score').textContent = audit.score;
  $('.score').classList.toggle('full', full);
  const tests = $('#tests');
  tests.innerHTML = '';
  for (const t of audit.tests.filter((x) => x.max > 0 || !x.pass)) {
    const li = document.createElement('li');
    li.className = t.pass ? '' : 'fail';
    li.textContent = `${t.name}${t.info && !['kwTitle', 'kwSet', 'schema'].includes(t.id) ? ` — ${t.info}` : ''}`;
    if (!t.pass) { const s = document.createElement('span'); s.className = 'fix'; s.textContent = (FIX[t.id] || (() => t.fix))(t); li.appendChild(s); }
    tests.appendChild(li);
  }
  $('#form-errors').textContent = errors.map((e) => e.replace(/^Not valid:\s*/, '')).join('\n');
  const failing = audit.tests.filter((x) => !x.pass).length;
  const chip = $('#score-chip');
  chip.textContent = failing ? `SEO ${audit.score}/100 · ${failing} to fix` : `SEO ${audit.score}/100 ✓`;
  chip.classList.toggle('full', full && !failing);
  $('#save-anyway').hidden = true;
  renderClashes(audit.conflicts);
  if (!fixing) {
    $('#fix-ai').hidden = !failing;
    $('#fix-ai').textContent = `Fix ${failing} check${failing > 1 ? 's' : ''} with AI`;
  }
}

// "Fix with AI": the AI rewrites the listing as it is now on this page until the failing checks
// pass (e.g. a new focus keyword, a keyword clash); prices, SKU, stock, categories, tags,
// attributes and the owner's note stay as they are.
let fixing = false;
$('#fix-ai').addEventListener('click', async () => {
  if (fixing || saving || !state.media.length) return;
  fixing = true;
  const btn = $('#fix-ai');
  btn.disabled = true; btn.textContent = 'Fixing with AI…';
  $('#fix-status').textContent = 'The AI is rewriting the listing; this can take a minute.';
  clearTimeout(timer);
  const before = readForm();
  try {
    const w = await call('write', {
      mediaIds: state.media.map((m) => m.id), hints: state.hints, notes: state.notes, market: state.market, facts: state.facts, current: before,
    });
    // Edits made while the AI was working would be lost: ask first.
    if (JSON.stringify(readForm()) !== JSON.stringify(before) && !confirm('You changed the listing while the AI was working. Replace it with the AI’s fixed version?')) {
      $('#fix-status').textContent = 'Kept your edits; the AI’s version was not used.';
      return;
    }
    state.product = w.product;
    fillForm(w.product);
    renderAudit(w.audit, []);
    state.dirty = true;
    persist();
    refreshAudit();
    $('#fix-status').textContent = `Done · SEO ${w.audit.score}/100${w.audit.fixable.length ? ` · ${w.audit.fixable.length} still to fix` : ''}.`;
  } catch (err) {
    $('#fix-status').textContent = '';
    $('#form-errors').textContent = err.message;
  } finally {
    fixing = false;
    btn.disabled = false;
    refreshAudit();
  }
});

// Live score: debounced, and an older answer never overwrites a newer one.
let timer, auditSeq = 0;
function refreshAudit() {
  const seq = ++auditSeq;
  call('audit', { product: readForm() })
    .then((r) => { if (seq === auditSeq) renderAudit(r.audit, r.errors); })
    .catch((e) => { if (seq === auditSeq) $('#form-errors').textContent = e.message; });
}
$('#form').addEventListener('input', (e) => {
  state.dirty = true;
  persist();
  updateLive();
  if (e.target.name === 'new_category') syncCatHint();
  if (e.target.name === 'focus_keyword') renderKeywordIdeas();
  clearTimeout(timer);
  timer = setTimeout(refreshAudit, 450);
});
$('#form').addEventListener('change', (e) => { if (e.target.type === 'checkbox') { state.dirty = true; syncCatHint(); persist(); clearTimeout(timer); refreshAudit(); } });
$('#form').addEventListener('submit', (e) => e.preventDefault());

let saving = false;
async function save(force) {
  if (saving || fixing) return;
  saving = true;
  clearTimeout(timer);
  const btn = $('#save'), alt = $('#save-anyway');
  btn.disabled = true; alt.disabled = true; btn.textContent = 'Saving…';
  $('#form-errors').textContent = '';
  try {
    const r = await call('draft', { product: { ...readForm(), force } });
    state.dirty = false;
    state.saved = { id: r.id, editUrl: r.editUrl, name: F('name').value.trim(), keyword: F('focus_keyword').value.split(',')[0].trim(), score: r.audit.score, checks: r.checks, warnings: r.warnings, stats: state.stats || null, qa: null };
    remember(state.saved);
    renderDone(state.saved);
    show('done');
    runQa(state.saved);
  } catch (err) {
    $('#form-errors').textContent = err.message;
    if (err.data?.audit) {
      renderAudit(err.data.audit, [err.message]);
      // Only SEO checks failed (the listing is otherwise valid): the owner may still save it.
      alt.textContent = `Save anyway at SEO ${err.data.audit.score}/100`;
      alt.hidden = false;
    }
  } finally {
    btn.disabled = false; alt.disabled = false; btn.textContent = 'Save as draft';
    saving = false;
  }
}
$('#save').addEventListener('click', () => save(false));
$('#save-anyway').addEventListener('click', () => save(true));

function renderWarnings() {
  $('#review-warnings').innerHTML = '';
  for (const t of state.warnings) { const li = document.createElement('li'); li.textContent = duplicateText(t); $('#review-warnings').appendChild(li); }
}

// ---------- 4. saved ----------
function renderDone(s) {
  $('#done-title').textContent = `#${s.id} · ${s.name} · SEO ${s.score}/100`;
  $('#done-link').href = s.editUrl;
  const checks = $('#done-checks');
  checks.innerHTML = '';
  for (const c of s.checks || []) {
    const li = document.createElement('li');
    li.className = c.pass ? '' : 'fail';
    li.textContent = `${c.label}${c.info ? ' — ' + c.info : ''}`;
    checks.appendChild(li);
  }
  const all = (s.checks || []).length, failed = (s.checks || []).filter((c) => !c.pass).length;
  $('#done-summary').textContent = failed ? `${failed} of ${all} checks need attention` : `All ${all} checks passed`;
  $('#done-details').open = failed > 0;
  const warn = $('#done-warnings');
  warn.innerHTML = '';
  for (const w of s.warnings || []) { const li = document.createElement('li'); li.textContent = duplicateText(w); warn.appendChild(li); }
  renderRunStats(s.stats);
  if (s.qa) { renderQa($('#qa-result'), s.qa); $('#qa-status').textContent = `Checked ${new Date(s.qa.at).toLocaleString()}.`; }
  else { $('#qa-result').innerHTML = ''; $('#qa-status').textContent = ''; }
}

// ---------- QA & analytics ----------
const QA_ICON = { pass: '✓', warn: '!', fail: '✗' };
const secs = (ms) => (ms ? `${Math.round(ms / 100) / 10} s` : '–');

// QA of the saved draft, straight after saving (read-only, from the shop itself).
let qaSeq = 0;
async function runQa(s) {
  const seq = ++qaSeq;
  $('#qa-status').textContent = 'Checking the saved draft in the shop…';
  $('#qa-result').innerHTML = '';
  $('#qa-again').disabled = true;
  try {
    const qa = await call('qa', { id: s.id });
    if (seq !== qaSeq || state.saved?.id !== s.id) return;
    s.qa = qa;
    remember(s);
    persist();
    renderQa($('#qa-result'), qa);
    $('#qa-status').textContent = `Checked ${new Date(qa.at).toLocaleString()}.`;
  } catch (err) {
    if (seq === qaSeq) $('#qa-status').textContent = `QA could not run: ${err.message}`;
  } finally { if (seq === qaSeq) $('#qa-again').disabled = false; }
}
$('#qa-again').addEventListener('click', () => state.saved && runQa(state.saved));

// Grouped checks: failures and warnings first and open, passes folded away.
function renderQa(box, qa) {
  box.innerHTML = '';
  const head = document.createElement('p');
  head.className = 'qa-sum';
  head.innerHTML = '';
  for (const [k, label] of [['pass', 'passed'], ['warn', 'to check'], ['fail', 'failed']]) {
    const b = document.createElement('span');
    b.className = `pill ${k}`; b.textContent = `${qa.summary[k]} ${label}`;
    head.append(b, ' ');
  }
  if (qa.permalink || qa.editUrl) {
    const a = document.createElement('a');
    a.href = qa.editUrl || qa.permalink; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = `#${qa.id} ${qa.name}`;
    head.append(a);
  }
  box.appendChild(head);
  const m = qa.metrics || {};
  const facts = document.createElement('p');
  facts.className = 'small muted';
  facts.textContent = [`SEO ${m.score}/100`, m.keyword ? `keyword “${m.keyword}”` : 'no focus keyword', `${m.words} words`,
    `${(m.photos || []).length} photos, ${m.totalKB ?? '?'} KB in total (${(m.photos || []).map((p) => `${p.kb ?? '?'} KB`).join(', ')})`].join(' · ');
  box.appendChild(facts);
  if (qa.keyword) box.appendChild(keywordPanel(qa.keyword, qa.id));
  const groups = [...new Set(qa.checks.map((c) => c.group))];
  for (const g of groups) {
    const list = qa.checks.filter((c) => c.group === g);
    const bad = list.filter((c) => c.status !== 'pass').length;
    const d = document.createElement('details');
    d.className = 'qa-group';
    d.open = bad > 0;
    const sum = document.createElement('summary');
    sum.textContent = `${g} — ${bad ? `${bad} to look at` : 'all good'}`;
    const ul = document.createElement('ul');
    ul.className = 'qa-checks';
    for (const c of list.sort((a, b) => ['fail', 'warn', 'pass'].indexOf(a.status) - ['fail', 'warn', 'pass'].indexOf(b.status))) {
      const li = document.createElement('li');
      li.className = c.status;
      const i = document.createElement('span');
      i.className = 'qa-icon'; i.textContent = QA_ICON[c.status]; i.setAttribute('aria-label', c.status);
      li.append(i, ` ${c.label}${c.info ? ` — ${c.info}` : ''}`);
      ul.appendChild(li);
    }
    d.append(sum, ul);
    box.appendChild(d);
  }
}

function renderRunStats(st) {
  const dl = $('#run-stats');
  dl.innerHTML = '';
  if (!st) { dl.textContent = 'No timing for this draft (it was written before this page was opened).'; return; }
  const before = st.photos.reduce((n, p) => n + (p.before || 0), 0), after = st.photos.reduce((n, p) => n + (p.after || 0), 0);
  const rows = [
    ['Total time', secs(st.ms.total)],
    ['Photo upload', `${secs(st.ms.upload)} · ${st.photos.length} photo${st.photos.length === 1 ? '' : 's'}`],
    ['Research', secs(st.ms.research)],
    ['Writing', `${secs(st.ms.write)}${st.rounds ? ` + ${st.rounds} repair round${st.rounds > 1 ? 's' : ''} (${secs(st.ms.repair)})` : ''}`],
    ['SEO score', `${st.firstScore ?? '–'} → ${st.score ?? '–'}/100`],
    ['Photo weight', st.photos.length ? `${kb(before)} KB → ${kb(after)} KB (${before ? Math.round((1 - after / before) * 100) : 0}% smaller; largest ${kb(Math.max(...st.photos.map((p) => p.after)))} KB)` : 'no new photos'],
    ['AI model', st.model || '–'],
  ];
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
}

// History of this tool's runs on this device (last 100), for the analytics screen.
const RUNS = 'vx-runs';
function runs() { try { return JSON.parse(localStorage.getItem(RUNS)) || []; } catch { return []; } }
function remember(s) {
  try {
    const list = runs().filter((r) => r.id !== s.id);
    const st = s.stats;
    list.unshift({
      id: s.id, name: s.name, at: Date.now(), score: s.score, ms: st?.ms?.total || null, rounds: st?.rounds ?? null,
      photos: st?.photos?.length ?? null, before: st ? st.photos.reduce((n, p) => n + (p.before || 0), 0) : null, after: st ? st.photos.reduce((n, p) => n + (p.after || 0), 0) : null,
      keyword: s.keyword || st?.keyword || '', qa: s.qa?.summary || null,
    });
    localStorage.setItem(RUNS, JSON.stringify(list.slice(0, 100)));
  } catch { /* storage blocked: no history */ }
}

let qaFrom = 'photos';
$('#open-qa').addEventListener('click', () => {
  if (view === 'qa' || running) return;
  qaFrom = view && view !== 'login' ? view : 'photos';
  renderHistory();
  show('qa');
});
$('#qa-back').addEventListener('click', () => show(qaFrom === 'qa' ? 'photos' : qaFrom));

// A product ID, a product link (vaxaura.com/product/…) or its slug; the server works out which product.
$('#qa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#qa-id').value.trim();
  if (!id) { $('#qa-one-status').textContent = 'Paste a product link (vaxaura.com/product/…) or type its ID (e.g. 536).'; return; }
  const btn = e.submitter || $('#qa-form button');
  btn.disabled = true;
  $('#qa-one-status').textContent = 'Checking the product and its keywords on Google…';
  $('#qa-one').innerHTML = '';
  try {
    const qa = await call('qa', { id });
    renderQa($('#qa-one'), qa);
    $('#qa-one-status').textContent = '';
  } catch (err) { $('#qa-one-status').textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---------- keyword & URL QA, cannibalization ----------
const REDIRECT_NOTE = 'This product is live: if you change its URL, add a 301 redirect from the old URL to the new one (Rank Math → Redirections) so Google and shared links keep working.';
function pills(sum) {
  const p = el('p', null, 'qa-sum');
  for (const [k, label] of [['pass', 'passed'], ['warn', 'to check'], ['fail', 'failed']]) p.append(el('span', `${sum[k]} ${label}`, `pill ${k}`), ' ');
  return p;
}
function checkList(list) {
  const ul = el('ul', null, 'qa-checks');
  for (const c of [...list].sort((a, b) => ['fail', 'warn', 'pass'].indexOf(a.status) - ['fail', 'warn', 'pass'].indexOf(b.status))) {
    const li = el('li', null, c.status);
    const i = el('span', QA_ICON[c.status], 'qa-icon');
    i.setAttribute('aria-label', c.status);
    li.append(i, ` ${c.label}${c.info ? ` — ${c.info}` : ''}`);
    ul.appendChild(li);
  }
  return ul;
}

// The keyword & URL panel of a product QA.
function keywordPanel(k, id) {
  const box = el('section', null, 'kwqa');
  box.appendChild(el('h3', 'Keyword & URL QA'));
  const u = el('p', null, 'kwqa-url');
  u.append(link(k.url, k.url.replace(/^https?:\/\//, '')));
  box.appendChild(u);
  const kw = el('p', null, 'small');
  kw.append(el('strong', 'Focus: '), el('span', k.focus || 'none', 'kw-tag' + (k.focus ? '' : ' bad')));
  if (k.secondary.length) { kw.append(' ', el('strong', 'Secondary: ')); for (const x of k.secondary) kw.append(el('span', x, 'kw-tag'), ' '); }
  box.appendChild(kw);
  box.appendChild(pills(k.summary));
  for (const g of ['URL', 'Keyword', 'Placement', 'Cannibalization']) {
    const list = k.checks.filter((c) => c.group === g);
    if (!list.length) continue;
    const bad = list.filter((c) => c.status !== 'pass').length;
    const d = el('details', null, 'qa-group');
    d.open = bad > 0;
    d.append(el('summary', `${g} — ${bad ? `${bad} to look at` : 'all good'}`), checkList(list));
    box.appendChild(d);
  }
  if (k.suggestions.length) {
    box.appendChild(el('p', `Real Google searches for this product that no other Vaxaura product uses (most searched first)${id ? '; click one to preview switching to it' : ''}:`, 'small muted'));
    const chips = el('div', null, 'kw-chips');
    for (const x of k.suggestions) {
      const current = x.kw === k.focus;
      const c = el(id && !current ? 'button' : 'span', x.kw, 'kw-chip' + (id && !current ? '' : ' static') + (current ? ' on' : ''));
      c.title = `Suggested by Google ${x.hits} time${x.hits > 1 ? 's' : ''}`;
      if (id && !current) { c.type = 'button'; c.addEventListener('click', () => openFix(id, x.kw)); }
      chips.appendChild(c);
    }
    box.appendChild(chips);
  }
  const better = k.suggestions.find((x) => x.kw !== k.focus);
  if (k.suggestedSlug && k.suggestedSlug !== k.slug && better) {
    const p = el('p', null, 'hint');
    p.append('Better: focus keyword ', el('strong', `“${better.kw}”`), ' and URL ', el('code', `/product/${k.suggestedSlug}/`), '.');
    if (k.live) p.append(' ', REDIRECT_NOTE);
    if (id) p.append(' ', fixButton(id, better.kw));
    box.appendChild(p);
  }
  return box;
}

$('#cannibal-run').addEventListener('click', async () => {
  const btn = $('#cannibal-run');
  btn.disabled = true;
  $('#cannibal-status').textContent = 'Comparing the keywords of every product and asking Google for free alternatives… (up to a minute)';
  $('#cannibal').innerHTML = '';
  try {
    renderCannibal(await call('qa', { cannibal: true }));
    $('#cannibal-status').textContent = '';
  } catch (err) { $('#cannibal-status').textContent = err.message; }
  finally { btn.disabled = false; }
});

function renderCannibal(r) {
  const box = $('#cannibal');
  box.innerHTML = '';
  const t = r.totals;
  const tiles = el('div', null, 'tiles');
  for (const [v, k, bad] of [[t.high, 'clashes to fix', t.high > 0], [t.medium, 'overlaps to check', false], [t.involved, `of ${t.products} products involved`, false], [t.noKeyword, 'products without a focus keyword', t.noKeyword > 0]]) {
    const d = el('div', null, 'tile' + (bad ? ' bad' : ''));
    d.append(el('strong', String(v)), el('span', k));
    tiles.appendChild(d);
  }
  box.appendChild(tiles);
  box.appendChild(el('p', `Checked ${new Date(r.at).toLocaleString()}. Nothing in the shop was changed.`, 'small muted'));
  if (!r.groups.length) { box.appendChild(el('p', '✓ No keyword cannibalization: every product targets its own searches.', 'ok-line')); return; }
  for (const g of r.groups) {
    const card = el('div', null, `clash-group ${g.severity}`);
    const h = el('h3');
    h.append(el('span', g.severity === 'high' ? 'Must fix' : 'Check', `sev ${g.severity}`), ` “${g.keyword}” — ${g.members.length} products`);
    card.appendChild(h);
    const ul = el('ul', null, 'clash-members');
    for (const m of g.members) {
      const li = el('li');
      li.append(m.url ? link(m.url, `#${m.id} ${m.name}`) : `#${m.id} ${m.name}`, el('small', ` · ${STATUS[m.status] || m.status} · SEO ${m.score} · ${m.keywords.join(', ') || 'no keyword'}`));
      li.append(' ', el('span', m.id === g.keep ? 'keeps the keyword' : 'change', m.id === g.keep ? 'pill pass' : 'pill warn'));
      ul.appendChild(li);
    }
    card.appendChild(ul);
    for (const l of g.links) card.appendChild(el('p', `#${l.a} ↔ #${l.b}: ${l.reason}`, 'small muted'));
    for (const f of g.fixes) {
      const p = el('p', null, 'hint');
      if (f.type === 'secondary') {
        p.append(`Fix #${f.id}: remove the secondary keyword${f.drop.length > 1 ? 's' : ''} `, el('strong', f.drop.map((k) => `“${k}”`).join(', ')),
          ` (another product’s focus keyword). The focus keyword “${f.from}” and the URL stay the same.`);
        p.append(' ', fixButton(f.id, f.to));
      } else if (f.to) {
        p.append(`Fix #${f.id}: change the focus keyword from “${f.from || 'none'}” to `, el('strong', `“${f.to}”`), ' and the URL to ', el('code', `/product/${f.slug}/`), '.');
        if (f.alternatives.length > 1) p.append(` Other free searches: ${f.alternatives.slice(1).join(', ')}.`);
        if (f.live) p.append(' ', REDIRECT_NOTE);
        p.append(' ', fixButton(f.id, f.to));
      } else p.append(`#${f.id}: Google offered no free search for this product; choose a more specific focus keyword (colour, shape, brand) by hand.`);
      card.appendChild(p);
    }
    box.appendChild(card);
  }
}

const VERDICT = {
  free: ['pass', 'Free to use: a real Google search and no other Vaxaura product targets it.'],
  overlap: ['warn', 'Usable, but it overlaps with another product’s keyword (see below).'],
  unsearched: ['warn', 'No other product uses it, but nobody searches this exact phrase on Google. Pick a real search below.'],
  shape: ['fail', 'Not a good focus keyword: use 2–4 words naming the product, without price, Pakistan, buy, online or best.'],
  taken: ['fail', 'Taken: another Vaxaura product already targets it. Using it would be keyword cannibalization.'],
};
let kwcSeq = 0;
async function checkKw(value) {
  const kw = String(value || '').trim();
  if (!kw) { $('#kwc-status').textContent = 'Type a keyword, e.g. couple watches.'; return; }
  const seq = ++kwcSeq;
  $('#kwc-input').value = kw;
  $('#kwc-status').textContent = `Checking “${kw}”…`;
  $('#kwc-result').innerHTML = '';
  try {
    const r = await call('qa', { keyword: kw });
    if (seq !== kwcSeq) return;
    $('#kwc-status').textContent = '';
    const box = $('#kwc-result');
    const [status, text] = VERDICT[r.verdict];
    const p = el('p', null, `kwc-verdict ${status}`);
    p.append(el('span', QA_ICON[status], 'qa-icon'), ` “${r.keyword}”: ${text}`);
    box.appendChild(p);
    if (r.searched != null) box.appendChild(el('p', r.searched ? '✓ People search this on Google in Pakistan.' : '✗ Google suggests no search that starts with it.', 'small'));
    if (r.conflicts.length) {
      const ul = el('ul', null, 'qa-checks');
      for (const c of r.conflicts) {
        const st = c.severity === 'high' ? 'fail' : 'warn';
        const li = el('li', null, st);
        li.append(el('span', QA_ICON[st], 'qa-icon'), ' ', c.url ? link(c.url, `#${c.id} ${c.name}`) : `#${c.id} ${c.name}`, ` — ${c.reason}`);
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    if (r.related.length) {
      box.appendChild(el('p', 'Related real searches no product uses yet (click to check):', 'small muted'));
      const chips = el('div', null, 'kw-chips');
      for (const x of r.related) {
        const b = el('button', x.kw, 'kw-chip');
        b.type = 'button';
        b.addEventListener('click', () => checkKw(x.kw));
        chips.appendChild(b);
      }
      box.appendChild(chips);
    }
  } catch (err) { if (seq === kwcSeq) $('#kwc-status').textContent = err.message; }
}
$('#kwc-form').addEventListener('submit', (e) => { e.preventDefault(); checkKw($('#kwc-input').value); });

// ---------- keyword fix for a product already in the shop ----------
// Preview (nothing changes) -> the owner may edit the new values -> Apply (after a confirm) -> Undo.
const fixState = { id: null, keyword: '', plan: null, edits: {}, busy: false };
const FIX_FIELDS = [['title', 'SEO title', 60], ['meta', 'Meta description', 160], ['slug', 'URL slug', 75], ['alt', 'Main photo alt text', 125], ['secondary', 'Secondary keywords (comma separated)', 0]];

function fixButton(id, keyword, label = 'Preview fix') {
  const b = el('button', label, 'secondary small-fix');
  b.type = 'button';
  b.addEventListener('click', () => openFix(id, keyword));
  return b;
}

async function openFix(id, keyword) {
  Object.assign(fixState, { id, keyword, plan: null, edits: {} });
  $('#fix-what').textContent = `Product #${id} · new focus keyword “${keyword}”`;
  $('#fix-body').innerHTML = '';
  $('#fix-msg').textContent = 'Preparing the preview… (nothing is changed yet)';
  $('#fix-undo').hidden = true; $('#fix-apply').hidden = false; $('#fix-recheck').hidden = false;
  $('#fix-apply').disabled = true; $('#fix-recheck').disabled = true;
  const dlg = $('#fix-dialog');
  if (!dlg.open) dlg.showModal();
  await previewFixNow();
}

function fixEdits() {
  const edits = {};
  for (const [k] of FIX_FIELDS) { const v = $(`#fix-${k}`)?.value; if (v != null && v.trim() !== String(fixState.plan?.after[k] ?? '').trim()) edits[k] = v; }
  const kw = $('#fix-keyword')?.value.trim();
  if (kw) fixState.keyword = kw;
  return edits;
}

async function previewFixNow(edits = {}) {
  if (fixState.busy) return;
  fixState.busy = true;
  $('#fix-apply').disabled = true; $('#fix-recheck').disabled = true;
  try {
    const plan = await call('fix', { action: 'preview', id: fixState.id, keyword: fixState.keyword, edits });
    fixState.plan = plan;
    fixState.edits = edits; // what Apply sends, so it saves exactly this preview
    renderFixPlan(plan);
    $('#fix-msg').textContent = 'Check the new values (you can change them), then apply. Nothing has been changed yet.';
    $('#fix-apply').disabled = false;
  } catch (err) { $('#fix-msg').textContent = err.message; }
  finally { fixState.busy = false; $('#fix-recheck').disabled = false; }
}

function renderFixPlan(p) {
  const box = $('#fix-body');
  box.innerHTML = '';
  $('#fix-what').textContent = `#${p.id} ${p.name} (${STATUS[p.status] || p.status}) · “${p.from || 'no keyword'}” → “${p.keyword}”`;
  const kwRow = el('div', null, 'fix-row');
  const kwLabel = el('label', 'New focus keyword'); kwLabel.htmlFor = 'fix-keyword';
  const kwIn = el('input'); kwIn.id = 'fix-keyword'; kwIn.value = p.keyword;
  kwRow.append(kwLabel, kwIn);
  box.appendChild(kwRow);
  for (const [k, label, max] of FIX_FIELDS) {
    const row = el('div', null, 'fix-row');
    const l = el('label', label); l.htmlFor = `fix-${k}`;
    const input = el(k === 'meta' ? 'textarea' : 'input');
    input.id = `fix-${k}`; input.value = p.after[k] ?? '';
    if (k === 'meta') input.rows = 3;
    const was = el('p', null, 'fix-was');
    const old = k === 'secondary' ? p.before.focus_keyword.split(',').slice(1).join(',').trim() : p.before[k];
    was.textContent = `Now: ${old || '(empty)'}`;
    if (max) {
      const c = el('span', '', 'count');
      const upd = () => { c.textContent = `${input.value.trim().length}/${max}`; c.classList.toggle('over', input.value.trim().length > max); };
      input.addEventListener('input', upd); upd();
      l.append(' ', c);
    }
    row.append(l, input, was);
    box.appendChild(row);
  }
  const facts = el('ul', null, 'fix-facts');
  const li = (t, cls) => facts.appendChild(el('li', t, cls));
  li(`Rank Math score: ${p.score.before} → ${p.score.after}/100`, p.score.after >= p.score.before ? 'pass' : 'warn');
  li(`“${p.from}” changed to “${p.keyword}” in the text: ${p.textChanges.description} time(s) in the long description, ${p.textChanges.short_description} in the short description (photos, links and formatting stay).`);
  if (p.after.slug !== p.before.slug) li(`URL: ${p.urlBefore.replace(/^https?:\/\//, '')} → ${p.urlAfter.replace(/^https?:\/\//, '')}${p.live ? ' — the old URL will redirect to the new one (301); this is checked after saving.' : ''}`, p.live ? 'warn' : '');
  for (const c of p.conflicts) li(`Still competes with #${c.id} ${c.name}: ${c.reason}`, c.severity === 'high' ? 'fail' : 'warn');
  if (p.failing.length) li(`Still to improve after the fix: ${p.failing.join('; ')}`, 'warn');
  box.appendChild(facts);
}

$('#fix-recheck').addEventListener('click', () => previewFixNow({ ...fixState.edits, ...fixEdits() }));
$('#fix-close').addEventListener('click', () => $('#fix-dialog').close());
$('#fix-apply').addEventListener('click', async () => {
  const p = fixState.plan;
  if (!p || fixState.busy) return;
  const edits = fixEdits();
  const changedKw = fixState.keyword !== p.keyword;
  if (changedKw || Object.keys(edits).length) {
    // The owner changed something: show the recalculated preview before saving it.
    await previewFixNow({ ...fixState.edits, ...edits });
    $('#fix-msg').textContent = 'Preview updated with your changes. Check it and click Apply again.';
    return;
  }
  const where = p.live ? `This changes the LIVE product #${p.id} on vaxaura.com` : `This changes draft #${p.id}`;
  if (!confirm(`${where}: focus keyword “${p.keyword}”, SEO title, meta description, URL and main photo alt, and “${p.from}” in the descriptions. The current values are kept for Undo. Apply?`)) return;
  fixState.busy = true;
  $('#fix-apply').disabled = true; $('#fix-recheck').disabled = true;
  $('#fix-msg').textContent = 'Saving and checking…';
  try {
    const r = await call('fix', { action: 'apply', id: p.id, keyword: p.keyword, edits: fixState.edits, modified: p.modified });
    renderFixResult(r, 'Applied.');
  } catch (err) { $('#fix-msg').textContent = err.message; $('#fix-apply').disabled = false; }
  finally { fixState.busy = false; $('#fix-recheck').disabled = false; }
});
$('#fix-undo').addEventListener('click', async () => {
  if (fixState.busy || !confirm(`Put back product #${fixState.id}’s keyword, SEO title, meta, URL, alt text and descriptions as they were before the fix?`)) return;
  fixState.busy = true;
  $('#fix-undo').disabled = true;
  $('#fix-msg').textContent = 'Restoring…';
  try { renderFixResult(await call('fix', { action: 'undo', id: fixState.id }), 'Restored the earlier version.'); }
  catch (err) { $('#fix-msg').textContent = err.message; }
  finally { fixState.busy = false; $('#fix-undo').disabled = false; }
});

function renderFixResult(r, done) {
  const box = $('#fix-body');
  box.innerHTML = '';
  box.appendChild(checkList(r.checks.map((c) => ({ ...c }))));
  for (const w of r.warnings || []) box.appendChild(el('p', w, 'small muted'));
  if (r.url) { const p = el('p', null, 'small'); p.append('Product: ', link(r.url, r.url.replace(/^https?:\/\//, ''))); box.appendChild(p); }
  const bad = r.checks.filter((c) => c.status !== 'pass').length;
  $('#fix-msg').textContent = `${done} ${bad ? `${bad} check(s) need a look.` : 'All checks passed.'} Run the product or clash check again to see the new state.`;
  $('#fix-apply').hidden = true; $('#fix-recheck').hidden = true;
  $('#fix-undo').hidden = !r.canUndo;
}


$('#qa-store-run').addEventListener('click', async () => {
  const btn = $('#qa-store-run');
  btn.disabled = true;
  $('#qa-store-status').textContent = 'Checking every product in the shop… (up to a minute)';
  $('#qa-store').innerHTML = '';
  try {
    renderStore(await call('qa', { store: true }));
    $('#qa-store-status').textContent = '';
  } catch (err) { $('#qa-store-status').textContent = err.message; }
  finally { btn.disabled = false; }
});

function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function link(href, text) { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }

function renderStore(r) {
  const box = $('#qa-store');
  box.innerHTML = '';
  const t = r.totals;
  const tiles = el('div', null, 'tiles');
  for (const [v, k, bad] of [
    [t.products, `products (${Object.entries(t.byStatus).map(([s, n]) => `${n} ${STATUS[s] || s}`).join(', ')})`],
    [`${t.avgScore}/100`, `average SEO · ${t.perfectScore} at 100`, t.avgScore < 90],
    [t.clashes, `keyword clashes · ${t.overlaps} overlaps`, t.clashes > 0],
    [t.heavyPhotos, `photos over 100 KB of ${t.photos} (${t.photoMB} MB)`, t.heavyPhotos > 0],
    [t.skuIssues, 'SKUs missing or not VAX-XX00', t.skuIssues > 0],
    [t.noKeyword, 'products without a focus keyword', t.noKeyword > 0],
  ]) {
    const d = el('div', null, 'tile' + (bad ? ' bad' : ''));
    d.append(el('strong', String(v)), el('span', k));
    tiles.appendChild(d);
  }
  box.appendChild(tiles);
  box.appendChild(el('p', `Report from ${new Date(r.at).toLocaleString()}.`, 'small muted'));

  if (r.clashes.length) {
    box.appendChild(el('h3', 'Keyword cannibalization'));
    const ul = el('ul', null, 'qa-checks');
    for (const c of r.clashes) {
      const li = el('li', null, c.severity === 'high' ? 'fail' : 'warn');
      li.append(el('span', QA_ICON[c.severity === 'high' ? 'fail' : 'warn'], 'qa-icon'), ` #${c.a.id} ${c.a.name} ↔ #${c.b.id} ${c.b.name}: ${c.reason}`);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    box.appendChild(el('p', 'Fix: give one of the two products a different focus keyword (open it in WordPress, or check it above for details).', 'small muted'));
  }
  if (r.junkCategories.length) {
    box.appendChild(el('h3', 'Placeholder or duplicate categories'));
    box.appendChild(el('p', `${r.junkCategories.map((c) => `${c.name} (${c.slug}, ${c.count} products)`).join(' · ')} — hidden in this tool; you can delete them in WordPress → Products → Categories.`, 'small'));
  }
  if (r.skuIssues.length) {
    box.appendChild(el('h3', 'SKUs to tidy'));
    box.appendChild(el('p', r.skuIssues.map((s) => `#${s.id} ${s.sku}`).join(' · '), 'small'));
  }
  box.appendChild(el('h3', 'Products (most issues first)'));
  const wrap = el('div', null, 'table-wrap');
  const table = el('table', null, 'qa-table');
  const hr = el('tr');
  for (const h of ['Product', 'Status', 'SEO', 'Keyword', 'Photos', 'Issues']) hr.appendChild(el('th', h));
  table.appendChild(el('thead')).appendChild(hr);
  const tb = el('tbody');
  for (const p of r.products) {
    const tr = el('tr');
    const name = el('td');
    name.append(p.url ? link(p.url, p.name) : p.name, el('small', ` #${p.id} · ${p.sku || 'no SKU'}`));
    tr.append(name, el('td', STATUS[p.status] || p.status), el('td', String(p.score), p.score === 100 ? 'ok' : p.score < 80 ? 'bad' : ''),
      el('td', p.keyword || '–'), el('td', `${p.photos} · ${p.totalKB ?? '?'} KB${p.heavyPhotos ? ` · ${p.heavyPhotos} over 100 KB` : ''}`, p.heavyPhotos ? 'bad' : ''));
    const issues = el('td');
    if (!p.issues.length) issues.textContent = '✓ none';
    else {
      const d = el('details');
      d.append(el('summary', `${p.fail} failed · ${p.warn} to check`));
      const ul = el('ul');
      for (const i of p.issues) ul.appendChild(el('li', `${QA_ICON[i.status]} ${i.label}${i.info ? ` — ${i.info}` : ''}`, i.status));
      d.appendChild(ul);
      issues.appendChild(d);
    }
    tr.appendChild(issues);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.appendChild(table);
  box.appendChild(wrap);
}

function renderHistory() {
  const box = $('#qa-history');
  box.innerHTML = '';
  const list = runs();
  if (!list.length) { box.appendChild(el('p', 'No drafts saved with this tool on this device yet.', 'small muted')); return; }
  const timed = list.filter((r) => r.ms);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const before = list.reduce((n, r) => n + (r.before || 0), 0), after = list.reduce((n, r) => n + (r.after || 0), 0);
  const tiles = el('div', null, 'tiles');
  for (const [v, k] of [
    [list.length, 'drafts saved'],
    [`${Math.round(avg(list.map((r) => r.score)))}/100`, 'average SEO at saving'],
    [timed.length ? secs(avg(timed.map((r) => r.ms))) : '–', 'average time per product'],
    [before ? `${Math.round((1 - after / before) * 100)}%` : '–', `photo weight saved (${kb(before)} → ${kb(after)} KB)`],
  ]) { const d = el('div', null, 'tile'); d.append(el('strong', String(v)), el('span', k)); tiles.appendChild(d); }
  box.appendChild(tiles);
  const ul = el('ul', null, 'history');
  for (const r of list.slice(0, 20)) {
    const li = el('li');
    const q = r.qa ? ` · QA ${r.qa.fail ? `${r.qa.fail} failed` : r.qa.warn ? `${r.qa.warn} to check` : 'all passed'}` : '';
    li.textContent = `${new Date(r.at).toLocaleDateString()} · #${r.id} ${r.name} · SEO ${r.score}${r.ms ? ` · ${secs(r.ms)}` : ''}${r.keyword ? ` · “${r.keyword}”` : ''}${q}`;
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

async function resetWork() {
  for (const it of state.items) { setPreview(it, null); if (it.url?.startsWith("blob:")) URL.revokeObjectURL(it.url); }
  Object.assign(state, { items: [], media: [], notes: '', sources: [], market: null, facts: '', product: null, warnings: [], dirty: false, saved: null, photoKey: '', stats: null });
  $('#hints').value = ''; $('#link').value = ''; $('#link-error').textContent = '';
  $('#restored').hidden = true;
  await clearKept();
  renderThumbs();
  show('photos');
}
$('#another').addEventListener('click', resetWork);
$('#start-over').addEventListener('click', () => {
  if (state.dirty && !confirm('Start over? The listing you are editing has not been saved and will be removed.')) return;
  resetWork();
});

// ---------- keep the work when the page is left, reloaded or closed ----------
// Listing, notes and uploaded photos go to localStorage; photos not uploaded yet are kept as files
// in IndexedDB. Cleared by "Add another product", "Start over" and Sign out; kept for 7 days.
const KEEP = 'vx-work-v1', KEEP_DAYS = 7;
// leftDuringRun: the browser cancels the running requests while the page unloads, which ends
// run() before 'pagehide' fires; remember that the run was cut short, not finished.
let restored = false, keepTimer, leftDuringRun = false;
const keyFor = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

function files(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('vx-work', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('files', mode);
        const req = fn(tx.objectStore('files'));
        tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
        tx.onerror = tx.onabort = () => { open.result.close(); reject(tx.error); };
      } catch (err) { open.result.close(); reject(err); }
    };
  });
}
function forget(it) {
  const key = it?.key;
  if (!key) return;
  delete it.key;
  files('readwrite', (s) => s.delete(key)).catch(() => {});
}
async function clearKept() {
  clearTimeout(keepTimer);
  try { localStorage.removeItem(KEEP); } catch { /* blocked */ }
  await files('readwrite', (s) => s.clear()).catch(() => {});
}

function persist(now) {
  clearTimeout(keepTimer);
  if (!now) { keepTimer = setTimeout(() => persist(true), 300); return; }
  if (!restored) return; // never overwrite kept work before it was read back
  try {
    if (!state.items.length && !state.product && !$('#hints').value.trim()) { localStorage.removeItem(KEEP); return; }
    localStorage.setItem(KEEP, JSON.stringify({
      at: Date.now(), view, interrupted: running || leftDuringRun,
      hints: $('#hints').value,
      items: state.items.map((it) => (it.media ? { media: it.media } : { key: it.key, brandY: it.brandY ?? null })),
      media: state.media, notes: state.notes, sources: state.sources, market: state.market, facts: state.facts,
      warnings: state.warnings, saved: state.saved, photoKey: state.photoKey, dirty: state.dirty, stats: state.stats,
      product: state.product ? readForm() : null, reviewTime: $('#review-time').textContent,
    }));
  } catch { /* storage full or blocked: the page still works, it just is not kept */ }
}

// Returns the screen to open, or null when nothing was kept.
async function restore() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEEP)); } catch { /* unreadable: start fresh */ }
  if (!d || typeof d !== 'object' || !(Date.now() - d.at < KEEP_DAYS * 864e5)) { await clearKept(); return null; }
  const items = [];
  let lost = 0;
  for (const it of d.items || []) {
    if (it.media) { items.push({ media: it.media, url: it.media.thumb }); continue; }
    const file = await files('readonly', (s) => s.get(it.key)).catch(() => null);
    if (file) items.push({ file, key: it.key, url: URL.createObjectURL(file), brandY: typeof it.brandY === 'number' ? it.brandY : null }); else lost++;
  }
  // Drop files no longer in the list (e.g. removed while the page was closing).
  const inUse = new Set(items.map((it) => it.key).filter(Boolean));
  await files('readwrite', (s) => {
    const all = s.getAllKeys();
    all.onsuccess = () => all.result.forEach((k) => inUse.has(k) || s.delete(k));
  }).catch(() => {});
  Object.assign(state, {
    items, media: d.media || [], notes: d.notes || '', sources: d.sources || [], market: d.market || null, facts: d.facts || '',
    warnings: d.warnings || [], saved: d.saved || null, photoKey: d.photoKey || '', dirty: !!d.dirty, product: d.product || null, stats: d.stats || null,
  });
  $('#hints').value = d.hints || '';
  renderThumbs();
  state.items.forEach(makePreview);
  if (state.product) {
    fillForm(state.product);
    renderWarnings();
    $('#review-time').textContent = d.reviewTime || '';
    refreshAudit();
  }
  if (state.saved) renderDone(state.saved);
  let to = d.interrupted ? 'photos' : d.view;
  if (!['photos', 'review', 'done'].includes(to)) to = state.product ? 'review' : 'photos';
  if (to !== 'photos' && !state.product) to = 'photos';
  if (to === 'done' && !state.saved) to = 'review';
  $('#restored-text').textContent = [
    d.interrupted ? 'The page was left while the listing was being written, so that run stopped. Your photos and notes are kept: run it again when ready.'
      : state.saved ? `Your last product (draft #${state.saved.id}) is shown again.` : 'Your unsaved work was restored.',
    lost ? `${lost} photo${lost > 1 ? 's' : ''} that had not been uploaded could not be restored; please add ${lost > 1 ? 'them' : 'it'} again.` : '',
  ].filter(Boolean).join(' ');
  $('#restored').hidden = false;
  return to;
}

$('#hints').addEventListener('input', () => persist());
// Mobile browsers may close a background tab without warning: save on every hide.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(true); });
window.addEventListener('pagehide', () => persist(true));
window.addEventListener('beforeunload', (e) => {
  if (running) leftDuringRun = true;
  persist(true);
  // Everything else is kept; only a running research would be lost.
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

start().catch((e) => { show('login'); $('#login-error').textContent = e.message; });
