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
