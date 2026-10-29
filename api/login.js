import { route, passwordMatches, sessionCookie } from '../lib/http.mjs';

export default route('POST', async (req, res) => {
  if (!passwordMatches(req.body?.password)) {
    await new Promise((r) => setTimeout(r, 1500)); // slows down password guessing
    throw Object.assign(new Error('Incorrect password.'), { status: 401 });
  }
  res.setHeader('Set-Cookie', sessionCookie());
}, { auth: false });
