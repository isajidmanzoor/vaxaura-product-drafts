import { route } from '../lib/http.mjs';
import { storeContext } from '../lib/woo.mjs';

export default route('GET', async () => {
  const ctx = await storeContext();
  return { categories: ctx.categories, tags: ctx.tags, nextSku: ctx.nextSku, skus: ctx.skus };
});
