import { route, clearCookie } from '../lib/http.mjs';

export default route('POST', async (req, res) => {
  res.setHeader('Set-Cookie', clearCookie());
}, { auth: false });
