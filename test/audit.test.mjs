// The fixture is draft #447 as written on 2026-10-30; Rank Math's own editor scored it 100/100
// (after the Content AI filter) and counted 524 words with a keyword density of 2.29%.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seoAudit, slugify, nextSku } from '../lib/woo.mjs';

// facts: what the owner's notes and the label text confirm (the fixture's FAQ calls it "original").
const fixture = () => ({ ...JSON.parse(fs.readFileSync(new URL('./rankmath-100.json', import.meta.url), 'utf8')), facts: 'Original L\'Oréal Paris product. Label: dermatologically tested' });
const byId = (a) => Object.fromEntries(a.tests.map((t) => [t.id, t]));

test('matches Rank Math on a real draft', () => {
  const a = seoAudit(fixture());
  assert.equal(a.score, 100);
  assert.deepEqual(a.fixable.map((x) => x.id), []);
  assert.equal(byId(a).length.info, '524 words');
  assert.equal(byId(a).density.info, '2.29%');
});

test('"original" without the owner confirming it is sent back to the AI', () => {
  const a = seoAudit({ ...fixture(), facts: '' });
  assert.equal(a.score, 100); // no Rank Math points involved
  assert.deepEqual(a.fixable.map((x) => x.id), ['qClaims']);
});

test('fails when the focus keyword only appears with an accent', () => {
  const p = fixture();
  p.seo.focus_keyword = 'loreal glycolic bright face wash';
  const t = byId(seoAudit(p));
  assert.equal(t.kwContent.pass, false);
  assert.equal(t.kwTitle.pass, false);
});

test('a used focus keyword fails', () => {
  const t = byId(seoAudit(fixture(), { usedFocus: ['glycolic bright face wash'] }));
  assert.equal(t.kwNew.pass, false);
});

test('needs 4 images for full image points', () => {
  const p = fixture();
  p.images = p.images.slice(0, 2);
  p.description = p.description.replace(/\{\{image:[34]\}\}/g, '');
  assert.equal(byId(seoAudit(p)).images.pts, 2);
});

test('helpers', () => {
  assert.equal(slugify("L'Oréal Glycolic-Bright & Co"), 'l-oreal-glycolic-bright-and-co');
  assert.equal(nextSku('VAX-JP', ['VAX-JP06', 'VAX - JP04', 'VAX-JP05']), 'VAX-JP07');
  assert.equal(nextSku('VAX-JR', []), 'VAX-JR01');
});

test('a made-up secondary keyword warns but blocks nothing; a made-up focus keyword blocks', () => {
  const p = fixture();
  const pool = ['glycolic bright face wash', 'loreal face wash', 'glycolic face wash', 'face wash for glow'];
  p.seo.focus_keyword = 'glycolic bright face wash, loreal face wash, made up thing';
  const a = seoAudit(p, { keywordPool: pool });
  const t = byId(a);
  assert.equal(t.qKwSecondary.pass, false);
  assert.equal(t.qKwSecondary.warn, true);
  assert.equal(t.qKwSecondary.info, 'made up thing');
  assert.ok(!a.fixable.some((x) => x.id === 'qKwSecondary'), 'a warning never sends the AI back or refuses the save');
  p.seo.focus_keyword = 'glycolic bright face wash, loreal face wash';
  assert.equal(byId(seoAudit(p, { keywordPool: pool })).qKwSecondary.pass, true);
  // Without enough real searches to choose from, secondary keywords are not judged.
  p.seo.focus_keyword = 'glycolic bright face wash, made up thing';
  assert.equal(byId(seoAudit(p, { keywordPool: ['glycolic bright face wash'] })).qKwSecondary.pass, true);
  p.seo.focus_keyword = 'made up thing';
  assert.ok(seoAudit(p, { keywordPool: pool }).fixable.some((x) => x.id === 'qKwReal'));
});
