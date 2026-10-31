import { route } from '../lib/http.mjs';
import { qaProduct, storeReport, shopCannibalization, checkKeyword } from '../lib/qa.mjs';

// QA (read-only): { id } checks one product (ID, product link or slug) end to end with its keyword &
// URL QA; { store: true } grades the whole shop; { cannibal: true } lists every keyword clash with
// its fix; { keyword } says whether a keyword is free to use.
export default route('POST', async (req) => {
  const { id, store, cannibal, keyword } = req.body || {};
  if (store) return storeReport();
  if (cannibal) return shopCannibalization();
  if (keyword != null) return checkKeyword(keyword);
  if (id == null || String(id).trim() === '') throw Object.assign(new Error('Enter a product ID or link.'), { status: 400 });
  return qaProduct(id);
});
