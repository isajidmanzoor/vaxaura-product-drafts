import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pemToDer, signJwt, searchRows, statsByKeyword, freeQueries, pageQueries, dateRange, siteCandidates, account, forgetConsole, keywordStats, opportunities, state, isConfigured, indexSummary, inspectUrl, trendRanges, trend, ctrSignal, pageTrend, pageTotals, inspectMany, sitemapUrls, inSitemap, forgetSitemap, pageKey } from '../lib/console.mjs';

// A throw-away RSA key stands in for the service account's key file.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const acct = { client_email: 'drafts@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.example/token' };
const env = { GSC_SERVICE_ACCOUNT: JSON.stringify(acct), VAXAURA_SITE: 'https://vaxaura.com' };

test('the key file is read and the properties to try are the domain one, then the URL prefix', () => {
  assert.equal(account(env).client_email, acct.client_email);
  assert.equal(account(env).token_uri, acct.token_uri);
  assert.equal(account({ GSC_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a', private_key: 'b' }) }).token_uri, 'https://oauth2.googleapis.com/token');
  assert.throws(() => account({ GSC_SERVICE_ACCOUNT: 'not json' }), /JSON/);
  assert.throws(() => account({ GSC_SERVICE_ACCOUNT: '{"client_email":"a"}' }), /private_key/);
  assert.deepEqual(siteCandidates(env), ['sc-domain:vaxaura.com', 'https://vaxaura.com/']);
  assert.deepEqual(siteCandidates({ ...env, GSC_SITE: 'https://www.vaxaura.com/' }), ['https://www.vaxaura.com/']);
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured(env), true);
  assert.equal(state({}).setup, false);
  assert.match(state({}).how, /GSC_SERVICE_ACCOUNT/);
});

test('the JWT is signed with the key file and carries the read-only scope', async () => {
  assert.ok(pemToDer(acct.private_key).length > 1000);
  const jwt = await signJwt(acct, 1_700_000_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.iss, acct.client_email);
  assert.equal(claims.aud, acct.token_uri);
  assert.match(claims.scope, /webmasters\.readonly$/);
  assert.deepEqual([claims.iat, claims.exp], [1_700_000_000, 1_700_003_600]);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), true);
});

test('the date range ends two days ago (Google publishes late) and spans 90 days', () => {
  const r = dateRange(Date.UTC(2026, 10, 6, 12), 90);
  assert.deepEqual(r, { startDate: '2026-08-06', endDate: '2026-11-04' });
});

// A fake Google: a token endpoint and a Search Analytics endpoint that refuses the domain property.
function fakeGoogle(rows) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init?.body, auth: init?.headers?.Authorization });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (url === acct.token_uri) return json(200, { access_token: 'tok-1', expires_in: 3600 });
    if (url.includes(encodeURIComponent('sc-domain:vaxaura.com'))) return json(403, { error: { message: 'User does not have sufficient permission for site' } });
    if (url.includes(encodeURIComponent('https://vaxaura.com/'))) return json(200, { rows });
    return json(404, {});
  };
  return { calls, fetchFn };
}
const ROWS = [
  { keys: ['couple watches'], clicks: 12, impressions: 900, ctr: 0.013, position: 8.2 },
  { keys: ['Couple Watches Price in Pakistan'], clicks: 3, impressions: 400, ctr: 0.0075, position: 14.1 },
  { keys: ['gold heart pendant'], clicks: 1, impressions: 120, ctr: 0.008, position: 22 },
  { keys: ['watch set for girls'], clicks: 0, impressions: 60, ctr: 0, position: 31.5 },
  { keys: ['vaxaura'], clicks: 40, impressions: 100, ctr: 0.4, position: 1 },
  { keys: ['watch'], clicks: 0, impressions: 3000, ctr: 0, position: 55 },
  { keys: ['pearl necklace'], clicks: 0, impressions: 2, ctr: 0, position: 40 },
];

test('search rows: signs in once, falls back from the domain property to the URL prefix, remembers the answer', async () => {
  forgetConsole();
  const { calls, fetchFn } = fakeGoogle(ROWS);
  const now = Date.UTC(2026, 10, 6);
  const rows = await searchRows({ dimensions: ['query'] }, { env, fetchFn, now });
  assert.equal(rows.length, ROWS.length);
  assert.deepEqual(rows[0], { keys: ['couple watches'], clicks: 12, impressions: 900, ctr: 0.013, position: 8.2 });
  assert.deepEqual(calls.map((c) => c.url), [acct.token_uri, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent('sc-domain:vaxaura.com')}/searchAnalytics/query`, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent('https://vaxaura.com/')}/searchAnalytics/query`]);
  assert.match(calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  assert.equal(calls[2].auth, 'Bearer tok-1');
  const body = JSON.parse(calls[2].body);
  assert.deepEqual([body.startDate, body.endDate, body.dimensions, body.rowLimit], ['2026-08-06', '2026-11-04', ['query'], 5000]);
  assert.equal(body.dimensionFilterGroups, undefined);
  // The same question again: no request at all (ten minutes); a page filter is a new question on the known property.
  await searchRows({ dimensions: ['query'] }, { env, fetchFn, now: now + 1000 });
  assert.equal(calls.length, 3);
  await searchRows({ dimensions: ['query'], filters: [{ dimension: 'page', operator: 'equals', expression: 'https://vaxaura.com/product/x/' }], rowLimit: 500 }, { env, fetchFn, now: now + 2000 });
  assert.equal(calls.length, 4);
  assert.match(calls[3].url, /https%3A%2F%2Fvaxaura\.com%2F\//);
  assert.deepEqual(JSON.parse(calls[3].body).dimensionFilterGroups, [{ filters: [{ dimension: 'page', operator: 'equals', expression: 'https://vaxaura.com/product/x/' }] }]);
  forgetConsole();
});

test('a refused sign-in or a property that never answers is a plain error', async () => {
  forgetConsole();
  const refuse = async (url) => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }) });
  await assert.rejects(searchRows({}, { env, fetchFn: refuse }), /sign-in failed \(HTTP 400\): Invalid JWT Signature/);
  forgetConsole();
  const noSite = async (url) => (url === acct.token_uri ? { ok: true, status: 200, json: async () => ({ access_token: 't' }) } : { ok: false, status: 403, json: async () => ({ error: { message: 'nope' } }) });
  await assert.rejects(searchRows({}, { env, fetchFn: noSite }), /HTTP 403 nope/);
  forgetConsole();
});

test('keyword stats add up the spellings of one search; impressions weight the position', () => {
  const rows = [...ROWS, { keys: ['couple watches '], clicks: 2, impressions: 100, ctr: 0.02, position: 4 }];
  const s = statsByKeyword(rows, ['Couple Watches', 'gold heart pendant', 'nothing here']);
  assert.deepEqual(s['Couple Watches'], { impressions: 1000, clicks: 14, position: 7.8 }); // (8.2*900 + 4*100) / 1000
  assert.deepEqual(s['gold heart pendant'], { impressions: 120, clicks: 1, position: 22 });
  assert.equal(s['nothing here'], undefined);
});

test('free searches with proven demand: not targeted, product-shaped, enough impressions, most shown first', () => {
  const free = freeQueries(ROWS, ['Couple Watches']);
  assert.deepEqual(free.map((q) => q.kw), ['gold heart pendant', 'watch set for girls']); // no price/pakistan, no brand, no 1-word, no 2-impression search
  assert.deepEqual(free[0], { kw: 'gold heart pendant', impressions: 120, clicks: 1, position: 22 });
  assert.deepEqual(pageQueries(ROWS.slice(0, 2)).map((q) => q.kw), ['couple watches', 'couple watches price in pakistan']);
});

test('trend ranges: the last 28 days and the 28 before, two days behind today', () => {
  const r = trendRanges(Date.UTC(2026, 10, 6, 12));
  assert.deepEqual(r.now, { startDate: '2026-10-08', endDate: '2026-11-04' });
  assert.deepEqual(r.before, { startDate: '2026-09-10', endDate: '2026-10-07' });
});

test('click rate and trend are judged from the page totals', () => {
  assert.equal(ctrSignal({ impressions: 10, clicks: 0 }), null); // too few to judge
  assert.deepEqual(ctrSignal({ impressions: 100, clicks: 0 }), { ctr: 0, low: true });
  assert.deepEqual(ctrSignal({ impressions: 200, clicks: 10 }), { ctr: 5, low: false });
  assert.deepEqual(trend({ impressions: 50, clicks: 1, position: 9 }, { impressions: 100, clicks: 2, position: 12 }).change, -50);
  assert.equal(trend({ impressions: 5, clicks: 0, position: null }, { impressions: 0, clicks: 0, position: null }).change, null);
});

test('URL inspection: Google’s verdict, crawl date and canonical, read and remembered', async () => {
  forgetConsole();
  const url = 'https://vaxaura.com/product/gold-heart-pendant-vaxaura/';
  const calls = [];
  const fetchFn = async (u, init) => {
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (u === acct.token_uri) { calls.push({ url: u, body: null }); return json(200, { access_token: 't', expires_in: 3600 }); }
    const body = JSON.parse(init.body);
    calls.push({ url: u, body });
    if (body.siteUrl === 'sc-domain:vaxaura.com') return json(403, { error: { message: 'no' } });
    return json(200, { inspectionResult: { inspectionResultLink: 'https://search.google.com/x', indexStatusResult: {
      verdict: 'PASS', coverageState: 'Submitted and indexed', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: '2026-11-03T10:11:12Z', pageFetchState: 'SUCCESSFUL', googleCanonical: url, userCanonical: url } } });
  };
  const r = await inspectUrl(url, { env, fetchFn, now: Date.UTC(2026, 10, 6) });
  assert.equal(r.indexed, true);
  assert.equal(r.coverage, 'Submitted and indexed');
  assert.equal(r.robots, 'ALLOWED');
  assert.equal(r.lastCrawl, '2026-11-03T10:11:12Z');
  assert.equal(r.googleCanonical, url);
  assert.equal(r.link, 'https://search.google.com/x');
  const inspect = calls.filter((c) => c.url.includes('urlInspection'));
  assert.equal(inspect.length, 2); // the domain property refused, the URL prefix answered
  assert.deepEqual(inspect[1].body, { inspectionUrl: url, siteUrl: 'https://vaxaura.com/', languageCode: 'en-US' });
  await inspectUrl(url, { env, fetchFn, now: Date.UTC(2026, 10, 6) + 1000 });
  assert.equal(calls.length, 3, 'remembered: no new request');
  // An unindexed page.
  assert.deepEqual(indexSummary({ inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' } } }).indexed, false);
  assert.equal(indexSummary({}).verdict, 'VERDICT_UNSPECIFIED');
  forgetConsole();
});

test('page trend: two totals queries for the page, last 28 days and the 28 before', async () => {
  forgetConsole();
  const url = 'https://vaxaura.com/product/x/';
  const calls = [];
  const fetchFn = async (u, init) => {
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (u === acct.token_uri) return json(200, { access_token: 't', expires_in: 3600 });
    const body = JSON.parse(init.body);
    calls.push(body);
    if (u.includes(encodeURIComponent('sc-domain:vaxaura.com'))) return json(403, { error: { message: 'no' } });
    return json(200, { rows: [body.startDate === '2026-10-08' ? { clicks: 1, impressions: 40, ctr: 0.025, position: 9.4 } : { clicks: 3, impressions: 80, ctr: 0.0375, position: 12.2 }] });
  };
  const t = await pageTrend(url, { env, fetchFn, now: Date.UTC(2026, 10, 6, 12) });
  assert.deepEqual(t.now, { impressions: 40, clicks: 1, position: 9.4 });
  assert.deepEqual(t.before, { impressions: 80, clicks: 3, position: 12.2 });
  assert.equal(t.change, -50);
  assert.equal(t.days, 28);
  // Three analytics requests: the domain property refused the first range, then the URL prefix answered both.
  const ok = calls.filter((b) => b.dimensions.length === 0);
  assert.equal(ok.length, 3);
  assert.ok(ok.every((b) => b.dimensionFilterGroups[0].filters[0].expression === url && b.rowLimit === 1));
  assert.deepEqual([...new Set(ok.map((b) => `${b.startDate}..${b.endDate}`))].sort(), ['2026-09-10..2026-10-07', '2026-10-08..2026-11-04']);
  forgetConsole();
});

test('page totals: every page of the shop in one query, keyed without the trailing slash', async () => {
  forgetConsole();
  let bodies = [];
  const fetchFn = async (u, init) => {
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (u === acct.token_uri) return json(200, { access_token: 't', expires_in: 3600 });
    const body = JSON.parse(init.body); bodies.push(body);
    if (u.includes(encodeURIComponent('sc-domain:vaxaura.com'))) return json(403, { error: { message: 'no' } });
    return json(200, { rows: [{ keys: ['https://vaxaura.com/product/gold-heart-pendant-vaxaura/'], clicks: 4, impressions: 90, ctr: 0.04, position: 11.3 }, { keys: ['https://vaxaura.com/'], clicks: 40, impressions: 100, ctr: 0.4, position: 1.2 }] });
  };
  const t = await pageTotals({ env, fetchFn, now: Date.UTC(2026, 10, 6, 12) });
  assert.equal(t.days, 28);
  assert.deepEqual(t.range, { startDate: '2026-10-08', endDate: '2026-11-04' });
  assert.deepEqual(t.pages.get(pageKey('https://vaxaura.com/product/gold-heart-pendant-vaxaura')), { impressions: 90, clicks: 4, position: 11.3 });
  assert.ok(bodies.every((b) => b.dimensions[0] === 'page'));
  assert.equal(await pageTotals({ env: {}, fetchFn }), null);
  forgetConsole();
});

test('index status in chunks: at most ten URLs per call, errors kept per URL', async () => {
  forgetConsole();
  const fetchFn = async (u, init) => {
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (u === acct.token_uri) return json(200, { access_token: 't', expires_in: 3600 });
    const body = JSON.parse(init.body);
    if (body.siteUrl === 'sc-domain:vaxaura.com') return json(403, { error: { message: 'no' } });
    if (body.inspectionUrl.endsWith('/bad/')) return json(500, { error: { message: 'boom' } });
    return json(200, { inspectionResult: { indexStatusResult: { verdict: body.inspectionUrl.includes('old') ? 'PASS' : 'NEUTRAL', coverageState: body.inspectionUrl.includes('old') ? 'Submitted and indexed' : 'Discovered - currently not indexed' } } });
  };
  const urls = [...Array.from({ length: 12 }, (_, i) => `https://vaxaura.com/product/old-${i}/`), 'https://vaxaura.com/product/bad/'];
  const r = await inspectMany(urls, { env, fetchFn, now: Date.UTC(2026, 10, 6) });
  assert.equal(Object.keys(r.results).length, 10, 'ten per call');
  assert.equal(r.results['https://vaxaura.com/product/old-0/'].indexed, true);
  const r2 = await inspectMany(['https://vaxaura.com/product/new-1/', 'https://vaxaura.com/product/bad/'], { env, fetchFn, now: Date.UTC(2026, 10, 6) });
  assert.equal(r2.results['https://vaxaura.com/product/new-1/'].indexed, false);
  assert.match(r2.results['https://vaxaura.com/product/bad/'].error, /HTTP 500/);
  assert.deepEqual((await inspectMany(urls, { env: {}, fetchFn })).results, {});
  forgetConsole();
});

test('the product sitemap says whether a product can be found at all (no Search Console needed)', async () => {
  forgetSitemap();
  let calls = 0;
  const fetchFn = async (u) => { calls++; assert.equal(u, 'https://vaxaura.com/product-sitemap.xml'); return { ok: true, status: 200, text: async () => '<?xml version="1.0"?><urlset><url><loc>https://vaxaura.com/shop/</loc></url><url><loc> https://vaxaura.com/product/tulip-earrings-vaxaura/ </loc></url></urlset>' }; };
  const urls = await sitemapUrls('https://vaxaura.com/', { fetchFn });
  assert.equal(urls.size, 2);
  assert.deepEqual(await inSitemap('https://vaxaura.com/product/tulip-earrings-vaxaura/', 'https://vaxaura.com', { fetchFn }), { listed: true, total: 2 });
  assert.deepEqual(await inSitemap('https://vaxaura.com/product/missing/', 'https://vaxaura.com', { fetchFn }), { listed: false, total: 2 });
  assert.equal(calls, 1, 'read once, remembered');
  forgetSitemap();
  await assert.rejects(sitemapUrls('https://vaxaura.com', { fetchFn: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
  forgetSitemap();
});

test('without the secret the routes answer "not set up" and never call Google', async () => {
  forgetConsole();
  let called = 0;
  const fetchFn = async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; };
  const k = await keywordStats(['couple watches'], { env: {}, fetchFn });
  assert.deepEqual([k.setup, k.stats], [false, {}]);
  assert.match(k.how, /GSC_SERVICE_ACCOUNT/);
  const o = await opportunities(['couple watches'], { env: {}, fetchFn });
  assert.deepEqual([o.setup, o.queries], [false, []]);
  assert.equal(called, 0);
  // With it: the stats of the candidates and the free searches, from one remembered answer.
  const g = fakeGoogle(ROWS);
  const k2 = await keywordStats(['couple watches', 'watch set for girls'], { env, fetchFn: g.fetchFn, now: Date.UTC(2026, 10, 6) });
  assert.equal(k2.setup, true);
  assert.equal(k2.site, 'https://vaxaura.com/');
  assert.equal(k2.stats['couple watches'].impressions, 900);
  assert.equal(k2.stats['watch set for girls'].position, 31.5);
  const o2 = await opportunities(['couple watches'], { env, fetchFn: g.fetchFn, now: Date.UTC(2026, 10, 6) });
  assert.deepEqual(o2.queries.map((q) => q.kw), ['gold heart pendant', 'watch set for girls']);
  assert.equal(o2.total, ROWS.length);
  assert.equal(g.calls.length, 3, 'one sign-in and one query per property, nothing more');
  forgetConsole();
});
