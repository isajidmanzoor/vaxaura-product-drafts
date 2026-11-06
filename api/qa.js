import { route } from '../lib/http.mjs';
import { qaProduct, storeReport, shopCannibalization, checkKeyword, toolRuns, consoleKeywords, consoleOpportunities } from '../lib/qa.mjs';

// QA (read-only): { id } checks one product (ID, product link or slug) end to end with its keyword &
// URL QA; { store: true } grades the whole shop; { cannibal: true } lists every keyword clash with
// its fix; { keyword } says whether a keyword is free to use; { runs: true } lists the products this
// tool drafted, from the shop (any device); { console: { keywords } } gives Search Console's real
// impressions for keyword candidates, { console: true } the searches with proven demand no product targets.
export default route('POST', async (req) => {
  const { id, store, cannibal, keyword, page, per, runs, console: gsc } = req.body || {};
  // store: the whole shop in one answer, or with `page` one page of 100 products (the browser adds them up).
  if (store) return storeReport({ page: Number.isInteger(page) && page >= 0 ? page : undefined, per: Number.isInteger(per) && per >= 10 && per <= 100 ? per : 100 });
  if (cannibal) return shopCannibalization();
  if (runs) return toolRuns();
  if (gsc) return typeof gsc === 'object' && Array.isArray(gsc.keywords) ? consoleKeywords(gsc.keywords) : consoleOpportunities();
  if (keyword != null) return checkKeyword(keyword);
  if (id == null || String(id).trim() === '') throw Object.assign(new Error('Enter a product ID or link.'), { status: 400 });
  return qaProduct(id);
});
