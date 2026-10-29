const $ = (s) => document.querySelector(s);
const SCREENS = ['login', 'photos', 'progress', 'review', 'done'];
const STEP_ORDER = ['photos', 'progress', 'review', 'done'];

// items: photos in order; each keeps its Media Library upload (media) once uploaded, so reordering is free.
const state = { items: [], media: [], notes: '', sources: [], product: null, ctx: null, hints: '', warnings: [], dirty: false };

function show(id) {
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
  // After a re-login mid-way, go back to where the owner was.
  show(state.product ? 'review' : 'photos');
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
  if (state.dirty && !confirm('Sign out? The listing you are editing has not been saved.')) return;
  state.dirty = false;
  await call('logout', {}).catch(() => {});
  location.reload();
});

// ---------- 1. photos ----------
function renderThumbs() {
  const ol = $('#thumbs');
  ol.innerHTML = '';
  state.items.forEach((it, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = it.url; img.alt = `Photo ${i + 1}`;
    const badge = document.createElement('span');
    badge.className = 'badge' + (i === 0 ? ' main' : '');
    badge.textContent = i === 0 ? 'Main photo' : String(i + 1);
    const tools = document.createElement('div');
    tools.className = 'tools';
    for (const [act, label, text, disabled] of [
      ['up', `Move photo ${i + 1} earlier`, '←', i === 0],
      ['del', `Remove photo ${i + 1}`, '✕', false],
      ['down', `Move photo ${i + 1} later`, '→', i === state.items.length - 1],
    ]) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.disabled = disabled;
      b.setAttribute('aria-label', label); b.title = label;
      b.addEventListener('click', () => {
        if (act === 'del') state.items.splice(i, 1);
        if (act === 'up') [state.items[i - 1], state.items[i]] = [state.items[i], state.items[i - 1]];
        if (act === 'down') [state.items[i + 1], state.items[i]] = [state.items[i], state.items[i + 1]];
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
}

function addFiles(list) {
  const rejected = [];
  for (const file of list) {
    if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) state.items.push({ file, url: URL.createObjectURL(file) });
    else rejected.push(file.name);
  }
  $('#link-error').textContent = rejected.length ? `Not a photo, skipped: ${rejected.join(', ')}` : '';
  renderThumbs();
}
for (const id of ['#file', '#camera']) $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// Photo links (supplier site, Daraz...): the server downloads them into the Media Library.
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
      const media = await call('fetch-photo', { url });
      state.items.push({ media, url: media.thumb });
      renderThumbs();
    } catch (err) { failed.push({ url, msg: err.message }); }
  }
  btn.disabled = false; btn.textContent = 'Add'; btn.removeAttribute('aria-label');
  input.value = failed.map((f) => f.url).join(' ');
  $('#link-error').textContent = failed.map((f) => `${f.url.length > 60 ? f.url.slice(0, 57) + '…' : f.url}: ${f.msg}`).join('\n');
});

// Shrinks a photo to at most 1600 px (JPEG) so each upload stays well below Vercel's 4.5 MB body limit.
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
async function shrink(file) {
  const bmp = await decode(file);
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
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
      it.media = await call('upload', { name: it.file.name, mime: 'image/jpeg', data: await shrink(it.file) });
      s.done(`Photo ${k + 1} of ${todo.length} uploaded`);
    }
    state.media = state.items.map((it) => it.media);
    const mediaIds = state.media.map((m) => m.id);

    s = step('Identifying the product and researching the Pakistani market');
    const r = await call('research', { mediaIds, hints: state.hints });
    Object.assign(state, { notes: r.notes, sources: r.sources });
    const k = r.sources.length;
    s.done(`Identified: ${r.identification?.product || 'product'} · ${k ? `${k} Daraz listing${k === 1 ? '' : 's'} compared` : 'no Daraz match found'}`);

    s = step('Writing the SEO listing');
    const ask = { mediaIds, hints: state.hints, notes: state.notes };
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
    state.warnings = w.warnings || [];
    fillForm(w.product);
    renderAudit(w.audit, []);
    // Same check the Save button runs, so problems (e.g. a missing field) show straight away.
    refreshAudit();
    $('#review-warnings').innerHTML = '';
    for (const t of state.warnings) { const li = document.createElement('li'); li.textContent = duplicateText(t); $('#review-warnings').appendChild(li); }
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
  }
}
$('#analyze').addEventListener('click', run);
$('#retry').addEventListener('click', run);
$('#back').addEventListener('click', () => show('photos'));

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

  const list = $('#sources');
  list.innerHTML = '';
  for (const src of state.sources) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = src.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = src.title.replace(/^Daraz:\s*/, 'Daraz · ').replace(/·\s*·/g, '·');
    li.appendChild(a);
    list.appendChild(li);
  }
  if (!state.sources.length) list.innerHTML = '<li class="muted">No Daraz listings were found for this item.</li>';
  $('#notes').textContent = state.notes;
  updateLive();
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
  updateLive();
  clearTimeout(timer);
  timer = setTimeout(refreshAudit, 450);
});
$('#form').addEventListener('change', (e) => { if (e.target.type === 'checkbox') { clearTimeout(timer); refreshAudit(); } });
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
    const name = F('name').value.trim();
    $('#done-title').textContent = `#${r.id} · ${name} · SEO ${r.audit.score}/100`;
    $('#done-link').href = r.editUrl;
    const checks = $('#done-checks');
    checks.innerHTML = '';
    for (const c of r.checks) {
      const li = document.createElement('li');
      li.className = c.pass ? '' : 'fail';
      li.textContent = `${c.label}${c.info ? ' — ' + c.info : ''}`;
      checks.appendChild(li);
    }
    const failed = r.checks.filter((c) => !c.pass).length;
    $('#done-summary').textContent = failed ? `${failed} of ${r.checks.length} checks need attention` : `All ${r.checks.length} checks passed`;
    $('#done-details').open = failed > 0;
    const warn = $('#done-warnings');
    warn.innerHTML = '';
    for (const w of r.warnings) { const li = document.createElement('li'); li.textContent = duplicateText(w); warn.appendChild(li); }
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

// ---------- 4. saved ----------
$('#another').addEventListener('click', () => {
  for (const it of state.items) if (it.file) URL.revokeObjectURL(it.url);
  Object.assign(state, { items: [], media: [], notes: '', sources: [], product: null, warnings: [], dirty: false });
  $('#hints').value = ''; $('#link').value = ''; $('#link-error').textContent = '';
  renderThumbs();
  show('photos');
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

start().catch((e) => { show('login'); $('#login-error').textContent = e.message; });
