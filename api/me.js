import { route, isLoggedIn } from '../lib/http.mjs';

export default route('GET', async (req) => ({
  loggedIn: isLoggedIn(req),
  setup: {
    ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    VAXAURA_WP_USER: !!process.env.VAXAURA_WP_USER,
    VAXAURA_WP_APP_PASSWORD: !!process.env.VAXAURA_WP_APP_PASSWORD,
  },
}), { auth: false });
