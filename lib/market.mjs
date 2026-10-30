// Market evidence and pricing: which Daraz listings are really this product, what they cost, and a
// price suggestion the owner can trace. Pure functions (no network) so they can be tested.
//
// Why: Daraz search mixes in other brands and look-alikes (searching "st london matt fusion
// foundation" returned mostly M2N London BB creams), so a price range over all results misleads.

const STOP = new Set(['the', 'and', 'for', 'with', 'of', 'in', 'a', 'an', 'by', 'to', 'on', 'new', 'best', 'pakistan', 'price',
  'women', 'woman', 'girls', 'girl', 'men', 'ladies', 'online', 'original', 'quality', 'stylish', 'fashion', 'beautiful', 'premium']);

export const tokens = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

// Plural/singular and common spelling variants should still match ("earrings" ~ "earring", "matt" ~ "matte").
const norm = (w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '').replace(/e$/, '');

// A term matches when its words appear next to each other, in order ("black heart" does not match
// "Red / Black plated ... Broken Heart"). Brands are matched without plural folding, so
// "STs London" or "Sweet Touch London ST" are not "ST London".
function phrase(seq, term, fold) {
  const parts = tokens(term).map(fold ? norm : (w) => w);
  if (!parts.length) return false;
  const s = fold ? seq.map(norm) : seq;
  for (let i = 0; i + parts.length <= s.length; i++) if (parts.every((p, k) => s[i + k] === p)) return true;
  return false;
}

// Shops name the same type differently ("Cleanser Foam" for a face wash, "Locket" for a pendant).
const TYPE_SYNONYMS = {
  'face wash': ['facewash', 'cleanser', 'facial foam', 'cleansing foam', 'face cleanser'],
  pendant: ['necklace', 'locket', 'chain'],
  necklace: ['pendant', 'locket', 'chain'],
  earrings: ['studs', 'stud', 'tops', 'earring', 'jhumka', 'hoops'],
  ring: ['band'],
  foundation: ['bb cream', 'cc cream'],
  vase: ['flower pot', 'planter'],
  tumbler: ['bottle', 'cup', 'mug'],
  'jewelry box': ['jewellery box', 'jewelry organizer', 'jewellery organiser'],
};
const typeNames = (type) => [type, ...(TYPE_SYNONYMS[String(type).toLowerCase().trim()] || [])];

// Score 0..1 for how well a listing title matches the identified product.
// ident: { brand, product_type, key_terms[] }
export function scoreListing(title, ident) {
  const seq = tokens(title);
  const brand = String(ident.brand || '').trim();
  const type = String(ident.product_type || '').trim();
  const terms = (ident.key_terms || []).map(String).filter((t) => tokens(t).length);
  const brandOk = brand ? phrase(seq, brand, false) : null;
  const typeOk = type ? typeNames(type).some((t) => phrase(seq, t, true)) : true;
  const termHits = terms.filter((t) => phrase(seq, t, true)).length;
  const coverage = terms.length ? termHits / terms.length : 0;
  let score = 0.35 * (typeOk ? 1 : 0) + 0.45 * coverage;
  if (brand) score += brandOk ? 0.2 : -0.4; // another brand is a different product
  else score += 0.2 * coverage;
  return { score: Math.max(0, Math.min(1, score)), brandOk, typeOk, coverage };
}

// Rule-based class; the AI check in research() may refine it.
export function classify(title, ident) {
  const s = scoreListing(title, ident);
  if (s.typeOk && s.brandOk !== false && s.coverage >= 0.8 && (s.brandOk || !ident.brand)) return 'exact';
  if (s.typeOk && s.brandOk !== false && s.coverage >= 0.4) return 'similar';
  // Same brand and type, other line or shade (e.g. another ST London foundation): fair to compare prices.
  if (s.typeOk && s.brandOk === true) return 'similar';
  return 'different';
}

// Search plan: the most specific query first, then shorter ones (Daraz returns 0 items for
// "triple black heart pendant" but 2,697 for "black heart pendant").
// Daraz sellers write "loreal", not "l'oréal": queries drop accents and apostrophes.
const ascii = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');

export function queryPlan(ident, aiQueries = []) {
  const brand = ascii(ident.brand).trim();
  const type = ascii(ident.product_type).trim();
  const terms = (ident.key_terms || []).map(ascii);
  const qs = [
    ...aiQueries.map(ascii),
    [brand, ...terms, type].filter(Boolean).join(' '),
    [brand, ...terms.slice(0, 2), type].filter(Boolean).join(' '),
    // Many sellers leave the brand out ("Glycolic Bright Glowing Daily Face Wash").
    brand ? [...terms, type].filter(Boolean).join(' ') : '',
    // Each distinguishing term on its own with the type ("black heart pendant", "triple pendant").
    ...terms.slice().reverse().map((t) => [brand, t, type].filter(Boolean).join(' ')),
    [brand, type].filter(Boolean).join(' '),
  ].map((q) => q.toLowerCase().replace(/\s+/g, ' ').trim()).filter((q) => q.split(' ').length >= 2);
  return [...new Set(qs)].slice(0, 6);
}

export function stats(prices) {
  const p = prices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!p.length) return null;
  const q = (f) => { const i = (p.length - 1) * f; const lo = Math.floor(i); return Math.round(p[lo] + (p[Math.ceil(i)] - p[lo]) * (i - lo)); };
  // Drop extreme outliers (accessories, bundles, typos) before the summary.
  const [q1, q3] = [q(0.25), q(0.75)];
  const fence = (q3 - q1) * 1.5;
  const kept = p.length >= 5 ? p.filter((x) => x >= q1 - fence && x <= q3 + fence) : p;
  const k = (f) => { const i = (kept.length - 1) * f; const lo = Math.floor(i); return Math.round(kept[lo] + (kept[Math.ceil(i)] - kept[lo]) * (i - lo)); };
  return { n: kept.length, min: kept[0], p25: k(0.25), median: k(0.5), p75: k(0.75), max: kept.at(-1), dropped: p.length - kept.length };
}

// Owner's notes: "cost Rs 600", "cost price 600", "sale price 999", "price Rs 1500", "20 pieces".
export function parseHints(hints) {
  const h = String(hints || '').toLowerCase().replace(/,(?=\d{3})/g, '');
  const num = (re) => { const m = h.match(re); return m ? Number(m[1]) : null; };
  return {
    cost: num(/\bcost(?:\s*price)?\s*(?:is|:|=)?\s*(?:rs\.?|pkr)?\s*(\d{2,6})/),
    sale: num(/\bsale(?:\s*price)?\s*(?:is|:|=)?\s*(?:rs\.?|pkr)?\s*(\d{2,6})/),
    regular: num(/\b(?:regular|retail|mrp)(?:\s*price)?\s*(?:is|:|=)?\s*(?:rs\.?|pkr)?\s*(\d{2,6})/)
      ?? num(/(?<!sale |cost )\bprice\s*(?:is|:|=)?\s*(?:rs\.?|pkr)?\s*(\d{2,6})/),
    stock: num(/(\d{1,5})\s*(?:pcs|pieces|pairs|units|items|in stock)/),
  };
}

// Prices end in 49 or 99 like the rest of the shop (999, 1199, 1249).
export const charm = (x) => {
  if (x < 150) return Math.max(99, Math.round(x / 10) * 10 - 1);
  const h = Math.floor(x / 100) * 100;
  const opts = [h - 1, h + 49, h + 99].filter((v) => v > 0);
  return opts.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
};
// The smallest 49/99 price at or above x (used for the cost floor, so rounding never eats the margin).
export const charmUp = (x) => {
  for (let h = Math.floor(x / 100) * 100; ; h += 100) {
    for (const v of [h - 1, h + 49, h + 99]) if (v >= x) return v;
  }
};
const roundUp100 = (x) => Math.ceil(x / 100) * 100;

// Suggested regular and sale price with the reasons, from:
// exact matches (same product: follow the market), similar items, Vaxaura's own prices in the
// category, and the owner's cost (at least a 30% margin) or explicit prices.
export function suggestPrice({ exact = [], similar = [], shop = [], hints = {}, branded = false }) {
  const why = [];
  if (hints.sale || hints.regular) {
    const sale = hints.sale || (hints.regular ? charm(hints.regular * 0.75) : null);
    const regular = hints.regular || roundUp100(sale * 1.4);
    why.push('Prices given in your notes were used.');
    return { regular, sale: sale < regular ? sale : null, why, basis: 'notes' };
  }
  const ex = stats(exact.map((i) => i.price));
  const si = stats(similar.map((i) => i.price));
  const sh = stats(shop.map((p) => Number(p.sale_price || p.regular_price)));
  let sale = null;
  if (ex && ex.n >= 2) {
    sale = charm(ex.median);
    why.push(`Same product on Daraz: ${ex.n} listings, Rs ${ex.min}–${ex.max} (median Rs ${ex.median}); priced at the market median.`);
  } else if (ex && ex.n === 1) {
    sale = charm(ex.median);
    why.push(`Only one listing of the same product on Daraz (Rs ${ex.median}); check more sellers before relying on it.`);
  } else if (branded && sh) {
    // Other brands or lines are no guide to a brand's own price.
    sale = charm(sh.median);
    why.push(`This brand's product was not found on Daraz, so the price follows Vaxaura's prices in this category (median sale Rs ${sh.median}). Please check the brand's retail price (MRP).`);
    if (si) why.push(`For reference, similar items on Daraz: Rs ${si.min}–${si.max}.`);
  } else if (si && sh) {
    // Look-alikes on Daraz are often unbranded and cheap; Vaxaura sells as a boutique, so stay near
    // the shop's own prices but not wildly above what the market pays for similar items.
    const ceiling = Math.max(si.p75 * (branded ? 1.3 : 2.5), si.median);
    sale = charm(Math.min(Math.max(sh.median, si.median), ceiling));
    why.push(`No exact match on Daraz. Similar items: ${si.n} listings, Rs ${si.min}–${si.max} (median Rs ${si.median}). Vaxaura's prices in this category: median sale Rs ${sh.median}.`);
  } else if (sh) {
    sale = charm(sh.median);
    why.push(`No usable Daraz prices; based on Vaxaura's prices in this category (median sale Rs ${sh.median}).`);
  } else if (si) {
    sale = charm(si.p75);
    why.push(`Based on similar Daraz items (upper quartile Rs ${si.p75}).`);
  }
  if (!sale) return { regular: null, sale: null, why: ['Not enough data to suggest a price — please enter it yourself.'], basis: 'none' };
  if (hints.cost) {
    const floor = charmUp(hints.cost * 1.3);
    if (sale < floor) { why.push(`Raised to keep at least a 30% margin over your cost (Rs ${hints.cost}).`); sale = floor; }
    else why.push(`Margin over your cost (Rs ${hints.cost}): ${Math.round((sale / hints.cost - 1) * 100)}%.`);
  }
  const regular = roundUp100(sale * 1.4);
  why.push(`Regular price shown crossed out: Rs ${regular} (about 30% off).`);
  return { regular, sale, why, basis: ex ? 'exact' : si ? 'similar' : 'shop', exact: ex, similar: si, shop: sh };
}

// ---------- fact guard ----------
// Claims the photos cannot prove. Allowed only when the owner's notes or the label text say so.
const CLAIMS = [
  [/\b(real|pure|solid)\s+(gold|silver)\b/i, 'real gold/silver'],
  [/\b(18|21|22|24)\s?(k|kt|karat|carat)\b/i, 'gold karat'],
  [/\bsterling\b|\b925\b/i, 'sterling silver'],
  [/\bgenuine\b/i, 'genuine'],
  [/\b(real|natural|genuine)\s+(diamond|emerald|ruby|sapphire|pearl|stone)s?\b/i, 'real gemstone'],
  [/\bhypo-?allergenic\b/i, 'hypoallergenic'],
  [/\b(water|sweat|tarnish)-?\s?proof\b/i, 'waterproof / tarnish-proof'],
  [/\b(100%\s*)?(original|authentic)\b/i, 'original / authentic'],
  [/\bdermatologist(ally)?[-\s]?(approved|recommended)\b/i, 'dermatologist approved'],
  [/\bguaranteed?\b/i, 'guarantee'],
];

export function unsupportedClaims(text, allowedText) {
  const plain = String(text || '').replace(/<[^>]*>/g, ' ');
  const allowed = String(allowedText || '').toLowerCase();
  const out = [];
  for (const [re, label] of CLAIMS) {
    const m = plain.match(re);
    if (!m) continue;
    // Allowed when the owner or the label used the same key word ("original", "waterproof", "925").
    const key = m[0].toLowerCase().replace(/100%\s*/, '').split(/[\s-]+/).find((w) => w.length > 2 && !['real', 'pure', 'solid', 'natural'].includes(w)) || m[0].toLowerCase();
    if (!allowed.includes(key.replace('proof', '')) && !allowed.includes(m[0].toLowerCase())) out.push({ label, phrase: m[0] });
  }
  return out;
}
