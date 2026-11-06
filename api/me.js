import { route, isLoggedIn } from '../lib/http.mjs';
import { isConfigured as consoleConfigured } from '../lib/console.mjs';

export default route('GET', async (req) => ({
  loggedIn: isLoggedIn(req),
  setup: {
    ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    VAXAURA_WP_USER: !!process.env.VAXAURA_WP_USER,
    VAXAURA_WP_APP_PASSWORD: !!process.env.VAXAURA_WP_APP_PASSWORD,
  },
  // Optional, free: Search Console gives real impressions and ranks (README → Search Console).
  optional: { GSC_SERVICE_ACCOUNT: consoleConfigured() },
}), { auth: false });
