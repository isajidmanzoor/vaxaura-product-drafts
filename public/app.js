const $ = (s) => document.querySelector(s);
const show = (id) => ['login', 'photos', 'progress', 'review', 'done'].forEach((s) => { $('#' + s).hidden = s !== id; });

// items: photos in order; each keeps its Media Library upload (media) once uploaded, so reordering is free.
const state = { items: [], media: [], notes: '', sources: [], product: null, ctx: null, hints: '', warnings: [] };

async function call(path, body) {
  const res = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 401 && path !== 'login') { show('login'); $('#logout').hidden = true; }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

// ---------- start / login ----------
async function start() {
  const me = await call('me');
  const missing = Object.entries(me.setup).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    $('#setup').hidden = false;
    $('#setup').textContent = `Vercel me ye environment variables set nahi hain: ${missing.join(', ')}. Project → Settings → Environment Variables me add karke Redeploy karein.`;
  }
  if (!me.loggedIn) return show('login');
  $('#logout').hidden = false;
  state.ctx = await call('context');
  show('photos');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try { await call('login', { password: $('#password').value }); $('#password').value = ''; await start(); }
  catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await call('logout', {}); location.reload(); });

// ---------- photos ----------
function renderThumbs() {
  const ol = $('#thumbs');
  ol.innerHTML = '';
  state.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<img alt=""><span class="num ${i === 0 ? 'feat' : ''}">${i === 0 ? '1 · featured' : i + 1}</span>
      <div class="tools"><button type="button" data-a="up" aria-label="Pehle">←</button><button type="button" data-a="del" aria-label="Hatao">×</button><button type="button" data-a="down" aria-label="Baad me">→</button></div>`;
    li.querySelector('img').src = it.url;
    li.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'del') state.items.splice(i, 1);
      if (a === 'up' && i > 0) [state.items[i - 1], state.items[i]] = [state.items[i], state.items[i - 1]];
      if (a === 'down' && i < state.items.length - 1) [state.items[i + 1], state.items[i]] = [state.items[i], state.items[i + 1]];
      renderThumbs();
    }));
    ol.appendChild(li);
  });
  $('#analyze').disabled = !state.items.length;
  $('#photo-count').textContent = state.items.length && state.items.length < 4
    ? `${state.items.length} photo — Rank Math ke poore points ke liye 4 photos behtar hain.` : '';
}
function addFiles(list) {
  for (const file of list) if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) state.items.push({ file, url: URL.createObjectURL(file) });
  renderThumbs();
}
$('#file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// Photo links (supplier site, Daraz, WhatsApp web...): the server downloads them into the Media Library.
$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#link');
  const links = input.value.split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
  if (!links.length) { $('#link-error').textContent = 'https:// se shuru hone wala photo link paste karein'; return; }
  $('#link-error').textContent = '';
  const btn = $('#link-add');
  btn.disabled = true;
  for (const url of links) {
    btn.textContent = `Laa raha hun… (${links.indexOf(url) + 1}/${links.length})`;
    try {
      const media = await call('fetch-photo', { url });
      state.items.push({ media, url: media.thumb });
      renderThumbs();
    } catch (err) { $('#link-error').textContent = `${url.slice(0, 60)}…: ${err.message}`; }
  }
  btn.disabled = false; btn.textContent = 'Add';
  input.value = '';
});

// Shrinks a photo to at most 1600 px (JPEG) so each upload stays far below Vercel's 4.5 MB body limit.
async function shrink(file) {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error(`${file.name}: is photo ko browser nahi khol saka (HEIC ho to JPG me badlein)`); });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- pipeline ----------
const steps = [];
function step(text) {
  const li = document.createElement('li');
  li.textContent = text; li.className = 'run';
  $('#steps').appendChild(li); steps.push(li);
  return { done: (t) => { li.className = 'done'; if (t) li.textContent = t; }, fail: () => { li.className = 'fail'; } };
}

async function run() {
  show('progress');
  $('#steps').innerHTML = ''; $('#progress-error').textContent = ''; $('#retry').hidden = true;
  state.hints = $('#hints').value.trim();
  const started = Date.now();
  let s;
  try {
    const todo = state.items.filter((it) => !it.media);
    for (const [k, it] of todo.entries()) {
      s = step(`Photo ${k + 1}/${todo.length} upload ho rahi hai`);
      it.media = await call('upload', { name: it.file.name, mime: 'image/jpeg', data: await shrink(it.file) });
      s.done(`Photo ${k + 1}/${todo.length} uploaded`);
    }
    state.media = state.items.map((it) => it.media);
    const mediaIds = state.media.map((m) => m.id);
    s = step('Photos pehchan + Google (Pakistan) aur Daraz research');
    const r = await call('research', { mediaIds, hints: state.hints });
    Object.assign(state, { notes: r.notes, sources: r.sources });
    s.done(`Research ho gayi: ${r.identification?.product || ''} (${r.sources.length} Daraz listings)`);
    s = step('SEO listing likhi ja rahi hai (free AI: aam tor par 1 minute)');
    const ask = { mediaIds, hints: state.hints, notes: state.notes };
    let w = await call('write', ask);
    s.done(`Listing tayyar — SEO ${w.audit.score}/100`);
    // Up to 2 repair rounds while a Rank Math test still fails; each round is its own request.
    for (let round = 1; round <= 2 && w.audit.fixable.length; round++) {
      s = step(`SEO ${w.audit.score}/100 — AI ${w.audit.fixable.length} test(s) theek kar raha hai (round ${round})`);
      try {
        const next = await call('write', { ...ask, previous: w.json });
        s.done(`Round ${round}: SEO ${next.audit.score}/100`);
        if (next.audit.score >= w.audit.score) w = next;
      } catch (err) {
        s.fail(); // keep the listing we have; the owner can fix the rest in the form
        break;
      }
    }
    state.product = w.product;
    state.warnings = w.warnings || [];
    fillForm(w.product);
    renderAudit(w.audit, []);
    $('#review-warnings').innerHTML = '';
    for (const t of state.warnings) { const li = document.createElement('li'); li.textContent = t; $('#review-warnings').appendChild(li); }
    $('#review-time').textContent = `${Math.round((Date.now() - started) / 1000)} second me tayyar (${w.model}).`;
    show('review');
    window.scrollTo(0, 0);
  } catch (err) {
    s?.fail();
    $('#progress-error').textContent = err.message;
    $('#retry').hidden = false;
  }
}
$('#analyze').addEventListener('click', run);
$('#retry').addEventListener('click', run);

// ---------- review form ----------
// namedItem, not elements[n]: elements['length'] is the field count, not the "length" input.
const F = (n) => $('#form').elements.namedItem(n);
function fillForm(p) {
  for (const k of ['name', 'slug', 'regular_price', 'sale_price', 'sku', 'stock_quantity', 'weight', 'short_description', 'description', 'owner_note']) F(k).value = p[k] ?? '';
  for (const k of ['length', 'width', 'height']) F(k).value = p.dimensions?.[k] ?? '';
  F('tags').value = (p.tags || []).join(', ');
  F('attributes').value = (p.attributes || []).map((a) => `${a.name}: ${a.options.join(', ')}`).join('\n');
  F('focus_keyword').value = p.seo.focus_keyword; F('seo_title').value = p.seo.title; F('seo_description').value = p.seo.description;
  $('#cats').innerHTML = state.ctx.categories.map((c) => `<label><input type="checkbox" value="${c.slug}" ${p.categories.includes(c.slug) ? 'checked' : ''}> ${c.name}</label>`).join('');
  $('#alts').innerHTML = '';
  p.images.forEach((img, i) => {
    const d = document.createElement('div');
    d.className = 'alt';
    d.innerHTML = `<img alt=""><label>Photo ${i + 1}${i === 0 ? ' (featured)' : ''} alt text <input data-alt="${i}"></label>`;
    d.querySelector('img').src = state.media[i].thumb;
    d.querySelector('input').value = img.alt;
    $('#alts').appendChild(d);
  });
  $('#sources').innerHTML = state.sources.map((s) => `<a href="${encodeURI(s.url)}" target="_blank" rel="noopener noreferrer"></a>`).join('');
  [...$('#sources').children].forEach((a, i) => { a.textContent = state.sources[i].title || state.sources[i].url; });
  $('#notes').textContent = state.notes;
  counts(); preview();
}

function readForm() {
  const n = (v) => String(v).trim();
  return {
    name: n(F('name').value), slug: n(F('slug').value),
    regular_price: n(F('regular_price').value), sale_price: n(F('sale_price').value),
    sku: n(F('sku').value), stock_quantity: F('stock_quantity').value === '' ? '' : Number(F('stock_quantity').value),
    weight: n(F('weight').value), dimensions: { length: n(F('length').value), width: n(F('width').value), height: n(F('height').value) },
    categories: [...$('#cats').querySelectorAll('input:checked')].map((i) => i.value),
    tags: F('tags').value.split(',').map(n).filter(Boolean),
    attributes: F('attributes').value.split('\n').map((l) => l.split(':')).filter((x) => x.length > 1 && n(x[0]))
      .map(([k, ...v]) => ({ name: n(k), options: v.join(':').split(',').map(n).filter(Boolean) })),
    images: state.media.map((m, i) => ({ media_id: m.id, alt: n($(`[data-alt="${i}"]`).value) })),
    seo: { focus_keyword: n(F('focus_keyword').value), title: n(F('seo_title').value), description: n(F('seo_description').value) },
    short_description: F('short_description').value, description: F('description').value, owner_note: F('owner_note').value,
  };
}

function counts() {
  document.querySelectorAll('.count').forEach((c) => { c.textContent = `${F(c.dataset.for).value.length} chars`; });
}
function preview() {
  const html = F('description').value.replace(/\{\{image:(\d+)\}\}/g, (m, k) => state.media[k - 1] ? `<img src="${state.media[k - 1].thumb}" alt="">` : m);
  // The listing is our own AI output, shown only to the logged-in owner; scripts are stripped anyway.
  $('#preview').innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+=("[^"]*"|'[^']*')/gi, '');
}

function renderAudit(audit, errors) {
  $('#score').textContent = audit.score;
  $('.score').classList.toggle('full', audit.score === 100);
  $('#tests').innerHTML = '';
  for (const t of audit.tests.filter((x) => x.max > 0 || !x.pass)) {
    const li = document.createElement('li');
    li.className = t.pass ? '' : 'fail';
    li.textContent = `${t.name}${t.info && t.id !== 'kwTitle' ? ` — ${t.info}` : ''}`;
    if (!t.pass) { const s = document.createElement('span'); s.className = 'fix'; s.textContent = t.fix; li.appendChild(s); }
    $('#tests').appendChild(li);
  }
  $('#form-errors').textContent = errors.join('\n');
}

let timer;
$('#form').addEventListener('input', () => {
  counts(); preview();
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { const r = await call('audit', { product: readForm() }); renderAudit(r.audit, r.errors); } catch (e) { $('#form-errors').textContent = e.message; }
  }, 500);
});

$('#save').addEventListener('click', async () => {
  const btn = $('#save');
  btn.disabled = true; btn.textContent = 'Save ho raha hai…';
  $('#form-errors').textContent = '';
  try {
    const r = await call('draft', { product: readForm() });
    $('#done-title').textContent = `#${r.id} · ${F('name').value} · SEO ${r.audit.score}/100`;
    $('#done-link').href = r.editUrl;
    $('#done-checks').innerHTML = '';
    for (const c of r.checks) {
      const li = document.createElement('li');
      li.className = c.pass ? '' : 'fail';
      li.textContent = `${c.label}${c.info ? ' — ' + c.info : ''}`;
      $('#done-checks').appendChild(li);
    }
    $('#done-warnings').innerHTML = '';
    for (const w of r.warnings) { const li = document.createElement('li'); li.textContent = w; $('#done-warnings').appendChild(li); }
    show('done');
    window.scrollTo(0, 0);
  } catch (err) {
    $('#form-errors').textContent = err.message;
    if (err.data?.audit) renderAudit(err.data.audit, []);
  } finally {
    btn.disabled = false; btn.textContent = 'Draft me save karo';
  }
});

$('#another').addEventListener('click', () => {
  Object.assign(state, { items: [], media: [], notes: '', sources: [], product: null, warnings: [] });
  $('#hints').value = '';
  renderThumbs();
  show('photos');
});

start().catch((e) => { show('login'); $('#login-error').textContent = e.message; });
