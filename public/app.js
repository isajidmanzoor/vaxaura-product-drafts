import { drawBrand, placeFor, brandAssets } from './brand.js';

const $ = (s) => document.querySelector(s);
const SCREENS = ['login', 'photos', 'progress', 'review', 'done'];
const STEP_ORDER = ['photos', 'progress', 'review', 'done'];

// items: photos in order; each keeps its Media Library upload (media) once uploaded, so reordering is free.
const state = { items: [], media: [], notes: '', sources: [], market: null, facts: '', product: null, ctx: null, hints: '', warnings: [], dirty: false, saved: null, photoKey: '' };

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
  stepper.hidden = id === 'login';
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
    $('#logout').hidden = true;
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
  $('#logout').hidden = false;
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
    const { blob } = await encode(canvas, wantsWebp(it.file), 0.85);
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

// With branding on, the server only fetches the photo and hands it back, so it is branded here
// like a photo from the device; with branding off it goes straight into the Media Library.
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
    try {
      if (brandOn) addFiles([await fetchLinkPhoto(url)]);
      else {
        const media = await call('fetch-photo', { url });
        state.items.push({ media, url: media.thumb });
        renderThumbs();
      }
    } catch (err) { failed.push({ url, msg: err.message }); }
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
// The branding uses the same spot as the preview (the stored or moved height). PNG and WebP
// photos are saved as WebP (much smaller than PNG, see-through parts stay see-through); JPG stays JPG.
async function shrink(it) {
  const { canvas } = await renderPhoto(it.file, 1600, it.brandY ?? it.autoY ?? null);
  const { blob, mime } = await encode(canvas, wantsWebp(it.file), 0.88);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: btoa(bin), mime };
}
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
function wantsWebp(file) {
  return /^image\/(png|webp)$/.test(file.type) || (!file.type && /\.(png|webp)$/i.test(file.name));
}
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
  try {
    const todo = state.items.filter((it) => !it.media);
    for (const [k, it] of todo.entries()) {
      s = step(`Uploading photo ${k + 1} of ${todo.length}`);
      it.media = await call('upload', { name: it.file.name, ...(await shrink(it)) });
      // From now on the thumbnail is the uploaded (branded) photo itself.
      const original = it.url;
      if (it.media.thumb) it.url = it.media.thumb;
      setPreview(it, null);
      if (original !== it.url && original.startsWith('blob:')) URL.revokeObjectURL(original);
      forget(it); // uploaded: the Media Library copy is kept instead of the file
      s.done(`Photo ${k + 1} of ${todo.length} uploaded`);
    }
    if (todo.length) renderThumbs(); // Photos now shows the uploaded photos, without the move buttons
    persist(true);
    state.media = state.items.map((it) => it.media);
    const mediaIds = state.media.map((m) => m.id);

    s = step('Identifying the product and researching the Pakistani market');
    const r = await call('research', { mediaIds, hints: state.hints });
    Object.assign(state, { notes: r.notes, sources: r.sources, market: r.market, facts: r.facts });
    const ex = r.market?.exact.length || 0, si = r.market?.similar.length || 0;
    s.done(`Identified: ${r.identification?.product || 'product'}${r.identification?.brand ? ` (${r.identification.brand})` : ''} · Daraz: ${ex} same, ${si} similar of ${r.market?.total ?? 0}`);

    s = step('Writing the SEO listing');
    const ask = { mediaIds, hints: state.hints, notes: state.notes, market: state.market, facts: state.facts };
    let w = await call('write', ask);
    s.done(`Listing written · SEO ${w.audit.score}/100`);
    // Up to 2 repair rounds while a test still fails; each round is its own request.
    for (let round = 1; round <= 2 && w.audit.fixable.length; round++) {
      const n = w.audit.fixable.length;
      s = step(`Improving ${n} SEO check${n > 1 ? 's' : ''} (round ${round})`);
      try {
        const next = await call('write', { ...ask, previous: w.json });
        s.done(`Round ${round} done · SEO ${next.audit.score}/100`);
        if (next.audit.score >= w.audit.score) w = next;
      } catch (err) {
        s.fail(`Round ${round} skipped: ${err.message}`); // keep the listing; the owner can fix the rest
        break;
      }
    }
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

  const cats = $('#cats');
  cats.innerHTML = '';
  for (const c of state.ctx.categories) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.value = c.slug; box.checked = p.categories.includes(c.slug);
    label.append(box, ` ${c.name}`);
    cats.appendChild(label);
  }

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
    sku: n(F('sku').value), stock_quantity: n(F('stock_quantity').value) === '' ? '' : Number(n(F('stock_quantity').value)),
    weight: n(F('weight').value), dimensions: { length: n(F('length').value), width: n(F('width').value), height: n(F('height').value) },
    categories: [...$('#cats').querySelectorAll('input:checked')].map((i) => i.value),
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
}

// Live score: debounced, and an older answer never overwrites a newer one.
let timer, auditSeq = 0;
function refreshAudit() {
  const seq = ++auditSeq;
  call('audit', { product: readForm() })
    .then((r) => { if (seq === auditSeq) renderAudit(r.audit, r.errors); })
    .catch((e) => { if (seq === auditSeq) $('#form-errors').textContent = e.message; });
}
$('#form').addEventListener('input', () => {
  state.dirty = true;
  persist();
  updateLive();
  clearTimeout(timer);
  timer = setTimeout(refreshAudit, 450);
});
$('#form').addEventListener('change', (e) => { if (e.target.type === 'checkbox') { state.dirty = true; persist(); clearTimeout(timer); refreshAudit(); } });
$('#form').addEventListener('submit', (e) => e.preventDefault());

let saving = false;
async function save(force) {
  if (saving) return;
  saving = true;
  clearTimeout(timer);
  const btn = $('#save'), alt = $('#save-anyway');
  btn.disabled = true; alt.disabled = true; btn.textContent = 'Saving…';
  $('#form-errors').textContent = '';
  try {
    const r = await call('draft', { product: { ...readForm(), force } });
    state.dirty = false;
    state.saved = { id: r.id, editUrl: r.editUrl, name: F('name').value.trim(), score: r.audit.score, checks: r.checks, warnings: r.warnings };
    renderDone(state.saved);
    show('done');
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
}

async function resetWork() {
  for (const it of state.items) { setPreview(it, null); if (it.url?.startsWith("blob:")) URL.revokeObjectURL(it.url); }
  Object.assign(state, { items: [], media: [], notes: '', sources: [], market: null, facts: '', product: null, warnings: [], dirty: false, saved: null, photoKey: '' });
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
      warnings: state.warnings, saved: state.saved, photoKey: state.photoKey, dirty: state.dirty,
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
    warnings: d.warnings || [], saved: d.saved || null, photoKey: d.photoKey || '', dirty: !!d.dirty, product: d.product || null,
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
