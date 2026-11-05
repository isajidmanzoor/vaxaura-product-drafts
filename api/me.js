import { route, isLoggedIn } from '../lib/http.mjs';

export default route('GET', async (req) => ({
  loggedIn: isLoggedIn(req),
  setup: {
    ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    VAXAURA_WP_USER: !!process.env.VAXAURA_WP_USER,
    VAXAURA_WP_APP_PASSWORD: !!process.env.VAXAURA_WP_APP_PASSWORD,
  },
}), { auth: false });
