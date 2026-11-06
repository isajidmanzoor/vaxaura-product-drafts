import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pemToDer, signJwt, searchRows, statsByKeyword, freeQueries, pageQueries, dateRange, siteCandidates, account, forgetConsole, keywordStats, opportunities, state, isConfigured } from '../lib/console.mjs';

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
