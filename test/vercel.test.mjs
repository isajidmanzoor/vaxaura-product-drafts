import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Vercel's Hobby plan deploys at most 12 serverless functions; a 13th file in api/ made the
// deployment fail (36901d1). New actions go into an existing route instead.
test('at most 12 API functions (Vercel Hobby limit)', () => {
  const fns = fs.readdirSync(new URL('../api/', import.meta.url)).filter((f) => /\.(m?js|ts)$/.test(f));
  assert.ok(fns.length <= 12, `${fns.length} functions: ${fns.join(', ')}`);
});
