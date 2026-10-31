import { route } from '../lib/http.mjs';
import { qaProduct, storeReport } from '../lib/qa.mjs';

// QA (read-only): { id } checks one product end to end; { store: true } grades the whole shop.
export default route('POST', async (req) => {
  const { id, store } = req.body || {};
  if (store) return storeReport();
  if (id == null || id === '') throw Object.assign(new Error('Enter a product ID.'), { status: 400 });
  return qaProduct(id);
});
