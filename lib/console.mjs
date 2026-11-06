// Google Search Console (free): what vaxaura.com already shows for on Google - real impressions,
// clicks and positions per search over the last 90 days. It is the one free source of real numbers:
// Google autocomplete says what people type, Search Console says how often the shop was shown for
// it and where it ranked.
// Setup (README → Search Console): a Google service account added to the Search Console property
// as a user, its key file's JSON in the GSC_SERVICE_ACCOUNT secret. Without it every function here
// answers "not set up" and the tool works as before. Read-only: the scope cannot change anything.

import { words } from './woo.mjs';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://www.googleapis.com/webmasters/v3/sites';
export const DAYS = 90;
// Google publishes Search Console data about two days late.
const LAG_DAYS = 2;
const ROW_LIMIT = 5000;
const CACHE_TTL = 10 * 60 * 1000;

export const isConfigured = (env = process.env) => !!String(env.GSC_SERVICE_ACCOUNT || '').trim();

// What the owner sees when the data is not there yet.
export const HOW = 'Free: a Google service account added to the Search Console property, its key JSON in the GSC_SERVICE_ACCOUNT secret (README → Search Console).';

export function account(env = process.env) {
  let j;
  try { j = JSON.parse(String(env.GSC_SERVICE_ACCOUNT || '')); } catch { throw new Error('GSC_SERVICE_ACCOUNT is not the JSON of a Google service-account key file.'); }
  if (!j?.client_email || !j?.private_key) throw new Error('GSC_SERVICE_ACCOUNT lacks client_email or private_key.');
  return { client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri || 'https://oauth2.googleapis.com/token' };
}

// The Search Console properties to try, most likely first: a domain property ("sc-domain:vaxaura.com"),
// then the URL-prefix one ("https://vaxaura.com/"). GSC_SITE pins one.
export function siteCandidates(env = process.env) {
  if (String(env.GSC_SITE || '').trim()) return [env.GSC_SITE.trim()];
  const site = String(env.VAXAURA_SITE || 'https://vaxaura.com').replace(/\/+$/, '');
  const host = new URL(site).hostname.replace(/^www\./, '');
  return [`sc-domain:${host}`, `${site}/`];
}

const b64url = (x) => Buffer.from(x).toString('base64url');
export function pemToDer(pem) {
  const body = String(pem || '').replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

// A signed JWT the token endpoint swaps for an access token (RS256 with the key file's private key;
// Web Crypto, which Node and Cloudflare Workers both have).
export async function signJwt(acct, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: acct.client_email, scope: SCOPE, aud: acct.token_uri, iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(acct.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

let TOKEN = null; // { value, exp } - an access token lasts an hour
export const forgetToken = () => { TOKEN = null; };
async function accessToken(acct, fetchFn) {
  if (TOKEN && TOKEN.exp > Date.now() + 60000) return TOKEN.value;
  const r = await fetchFn(acct.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signJwt(acct) }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Search Console sign-in failed (HTTP ${r.status}): ${j.error_description || j.error || 'no access token'}`);
  TOKEN = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return TOKEN.value;
}

const day = (d) => d.toISOString().slice(0, 10);
export function dateRange(now = Date.now(), days = DAYS) {
  const end = new Date(now - LAG_DAYS * 86400000);
  const start = new Date(end.getTime() - days * 86400000);
  return { startDate: day(start), endDate: day(end) };
}

// One Search Analytics query. filters: [{ dimension: 'page', operator: 'equals', expression }].
// The first property that answers is remembered for the rest of the run.
let SITE = null;
const CACHE = new Map();
export const forgetConsole = () => { CACHE.clear(); SITE = null; TOKEN = null; };
export async function searchRows({ dimensions = ['query'], filters = [], rowLimit = ROW_LIMIT, days = DAYS } = {}, { env = process.env, fetchFn = fetch, now = Date.now() } = {}) {
  const key = JSON.stringify([dimensions, filters, rowLimit, days]);
  const hit = CACHE.get(key);
  if (hit && now - hit.at < CACHE_TTL) return hit.value;
  const acct = account(env);
  const token = await accessToken(acct, fetchFn);
  const body = { ...dateRange(now, days), dimensions, rowLimit, dataState: 'final', ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}) };
  const sites = SITE ? [SITE] : siteCandidates(env);
  let last = null;
  for (const site of sites) {
    const r = await fetchFn(`${API}/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      SITE = site;
      const value = (j.rows || []).map((row) => ({ keys: row.keys || [], clicks: Number(row.clicks) || 0, impressions: Number(row.impressions) || 0, ctr: Number(row.ctr) || 0, position: Number(row.position) || 0 }));
      CACHE.set(key, { at: now, value });
      return value;
    }
    last = new Error(`Search Console ${site}: HTTP ${r.status} ${j.error?.message || ''}`.trim());
    // 403/404: this property is not one the service account may read; try the other form.
    if (r.status !== 403 && r.status !== 404) throw last;
  }
  throw last || new Error('Search Console: no property answered.');
}

// ---------- pure helpers (tested without the network) ----------
export const norm = (q) => words(q).join(' ');

// Site-wide rows (dimension query) -> the stats of the given keywords, by plain words.
export function statsByKeyword(rows, keywords) {
  const want = new Map(keywords.map((k) => [norm(k), k]));
  const out = {};
  for (const r of rows) {
    const q = norm(r.keys[0] || '');
    const k = want.get(q);
    if (!k) continue;
    const s = out[k] || { impressions: 0, clicks: 0, position: 0, n: 0 };
    s.impressions += r.impressions; s.clicks += r.clicks; s.position += r.position * r.impressions; s.n += r.impressions;
    out[k] = s;
  }
  for (const s of Object.values(out)) { s.position = s.n ? Math.round((s.position / s.n) * 10) / 10 : null; delete s.n; }
  return out;
}

// Searches the shop is already shown for that no product targets: free keywords with proven demand.
// used: every keyword the shop's products target. Product-page searches only (2-4 words, no
// price/pakistan/buy...), the most shown first.
const NOISE = /\b(price|prices|pakistan|pk|buy|online|best|cheap|sale|discount|daraz|naheed|olx|near me|shop|store|wholesale|rate|vaxaura)\b/;
export function freeQueries(rows, used, { limit = 30, minImpressions = 5 } = {}) {
  const taken = new Set(used.map(norm));
  const out = [];
  for (const r of rows) {
    const q = norm(r.keys[0] || '');
    const n = q.split(' ').length;
    if (!q || taken.has(q) || n < 2 || n > 4 || NOISE.test(q) || r.impressions < minImpressions) continue;
    out.push({ kw: q, impressions: r.impressions, clicks: r.clicks, position: Math.round(r.position * 10) / 10 });
  }
  return out.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks).slice(0, limit);
}

// The searches one product page is shown for (rows with dimensions query, filtered to the page).
export function pageQueries(rows, { limit = 8 } = {}) {
  return rows.map((r) => ({ kw: norm(r.keys[0] || ''), impressions: r.impressions, clicks: r.clicks, position: Math.round(r.position * 10) / 10 }))
    .filter((r) => r.kw).sort((a, b) => b.impressions - a.impressions).slice(0, limit);
}

// ---------- what the routes call ----------
export const state = (env = process.env) => ({ setup: isConfigured(env), days: DAYS, how: isConfigured(env) ? '' : HOW });

// Stats for the keyword candidates of a listing (one cached site-wide query).
export async function keywordStats(keywords, deps) {
  if (!isConfigured(deps?.env)) return { ...state(deps?.env), stats: {} };
  const rows = await searchRows({ dimensions: ['query'] }, deps);
  return { ...state(deps?.env), site: SITE, stats: statsByKeyword(rows, keywords) };
}

// The searches a product page is shown for.
export async function pageStats(url, deps) {
  if (!isConfigured(deps?.env)) return null;
  const rows = await searchRows({ dimensions: ['query'], filters: [{ dimension: 'page', operator: 'equals', expression: url }], rowLimit: 500 }, deps);
  return pageQueries(rows);
}

// Free searches with proven demand for the QA screen.
export async function opportunities(used, deps) {
  if (!isConfigured(deps?.env)) return { ...state(deps?.env), queries: [] };
  const rows = await searchRows({ dimensions: ['query'] }, deps);
  return { ...state(deps?.env), site: SITE, total: rows.length, queries: freeQueries(rows, used) };
}
