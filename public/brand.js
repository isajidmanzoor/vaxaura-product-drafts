// Vaxaura branding for product photos (the style approved on 2026-10-31): a faint logo with
// "VAXAURA" under it in the calmest part of the photo, and www.vaxaura.com along the bottom edge.
// Nothing here touches the page when imported, so the placement maths can be tested in Node.

// Where the logo block goes: horizontally centred, at the height where the photo shows the least
// detail, so it never sits on the product. Prefers a little above the middle when areas are
// equally calm. `gray` is a small grayscale copy (w×h numbers, 0–255) of the photo.
export function calmestY(gray, w, h, { boxW = 0.32, boxH = 0.2, prefer = 0.42, from = 0.2, to = 0.62, weight = 1.2 } = {}) {
  const edge = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      edge[i] = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + w] - gray[i - w]);
    }
  }
  // Summed-area table: the detail inside any box in constant time.
  const W1 = w + 1;
  const sat = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += edge[y * w + x]; sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + row; }
  }
  const box = (x0, y0, x1, y1) => sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
  const average = box(0, 0, w, h) / (w * h) || 1;
  const bw = Math.max(2, Math.round(w * boxW)), bh = Math.max(2, Math.round(h * boxH));
  const x0 = Math.round((w - bw) / 2);
  let best = prefer, bestCost = Infinity;
  for (let k = Math.round(from * 100); k <= Math.round(to * 100); k++) {
    const f = k / 100;
    const y0 = Math.max(0, Math.min(h - bh, Math.round(f * h - bh / 2)));
    const busy = box(x0, y0, x0 + bw, y0 + bh) / (bw * bh) / average; // 1 = as detailed as the photo on average
    const cost = busy + weight * Math.abs(f - prefer);
    if (cost < bestCost) { bestCost = cost; best = f; }
  }
  return best;
}

// Text with even letter spacing, centred on x (drawn letter by letter so every browser matches).
function spacedText(ctx, text, cx, cy, { font, spacing, alpha, glow }) {
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((s, v) => s + v, 0) + spacing * (widths.length - 1);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = `rgba(0,0,0,${glow})`;
  ctx.shadowBlur = Math.max(2, parseFloat(font.match(/(\d+(?:\.\d+)?)px/)?.[1] || 20) * 0.3);
  let x = cx - total / 2;
  [...text].forEach((ch, i) => { ctx.fillText(ch, x, cy); x += widths[i] + spacing; });
  ctx.restore();
  return total;
}

const WORD = 'VAXAURA';
const SITE = 'WWW.VAXAURA.COM';
const SERIF = (s) => `500 ${s}px Cinzel, "Times New Roman", serif`;
const SANS = (s) => `500 ${s}px Montserrat, Arial, sans-serif`;

// Draws the branding onto a canvas that already holds the photo.
export function drawBrand(canvas, logo, { cy } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, U = Math.min(W, H);
  const lw = U * 0.17;
  const lh = lw * (logo.naturalHeight || logo.height) / (logo.naturalWidth || logo.width);
  const ws = Math.round(U * 0.036);
  const blockH = lh + ws * 1.7;
  const center = (cy ?? placeFor(canvas)) * H;
  const top = Math.max(H * 0.04, Math.min(H * 0.8 - blockH, center - blockH / 2));

  ctx.save();
  ctx.globalAlpha = 0.38;
  ctx.drawImage(logo, (W - lw) / 2, top, lw, lh);
  ctx.restore();
  spacedText(ctx, WORD, W / 2, top + lh + ws * 0.85, { font: SERIF(ws), spacing: ws * 0.32, alpha: 0.5, glow: 0.25 });

  // Website along the bottom over a light shade that fades upwards (readable on busy cloth).
  let ss = Math.round(U * 0.024);
  ctx.font = SANS(ss);
  const natural = [...SITE].reduce((s, ch) => s + ctx.measureText(ch).width, 0) + ss * 0.5 * (SITE.length - 1);
  if (natural > W * 0.9) ss = Math.max(10, Math.floor(ss * (W * 0.9) / natural));
  const band = ss * 4.2;
  const g = ctx.createLinearGradient(0, H - band, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, H - band, W, band);
  ctx.restore();
  spacedText(ctx, SITE, W / 2, H - ss * 2.1, { font: SANS(ss), spacing: ss * 0.5, alpha: 0.75, glow: 0.45 });
}

// A 96-px-wide grayscale copy of the canvas, for calmestY.
export function placeFor(canvas) {
  const w = 96, h = Math.max(8, Math.round(96 * canvas.height / canvas.width));
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
  return calmestY(gray, w, h);
}

let ready = null;
// Loads the logo (same origin, so the canvas can still be exported) and the two fonts.
export function brandAssets() {
  ready ||= (async () => {
    // fetch + createImageBitmap rather than <img>.decode(), which can stay pending for good (a
    // tab in the background) and would then hold up every photo. A failed load is retried later.
    let logo;
    try {
      const res = await fetch('/brand/vaxaura-logo.webp', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logo = await createImageBitmap(await res.blob());
    } catch {
      throw new Error('The Vaxaura logo could not be loaded for the branding. Check the connection and try again.');
    }
    // Fonts are a nicety: after 3 s the fallbacks (Times / Arial) are used instead.
    await Promise.race([
      Promise.all([document.fonts.load(SERIF(40)), document.fonts.load(SANS(40))]),
      new Promise((r) => setTimeout(r, 3000)),
    ]).catch(() => {});
    return { logo };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}
