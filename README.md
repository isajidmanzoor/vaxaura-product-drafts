# Vaxaura Product Drafts

Upload product photos → the app researches the Pakistani market and writes a full SEO listing →
you review it → it is saved on vaxaura.com as a **WooCommerce draft**. It never publishes; you
publish from wp-admin yourself (publishing is also what starts the social bot's videos).

The interface is in English and works on phones (two-column photo grid, compact step bar) and
desktops (review form with a sticky score card), in light and dark mode.

## What it does

1. **Photos**: from the phone/computer (the browser shrinks each to max 1600 px JPEG) or by pasting
   photo links (supplier site, Daraz, any public image; the server downloads them and refuses
   internal addresses). They go to the WordPress Media Library; the first is the featured image.
2. **Research**: Gemini (`gemini-3.6-flash`) identifies the product from the photos and proposes
   search phrases; the server then reads what people in Pakistan type into Google (Google
   autocomplete, `gl=pk`) and the matching Daraz.pk listings (price, sold count, rating, link).
3. **Listing** (`gemini-3.6-flash`, falls back to 3.8 / 3.5 Flash-Lite; JSON output): title, slug, short and long description with FAQ,
   categories, tags, suggested price, stock, weight/size, attributes, alt text per photo, Rank Math
   SEO title/description/focus keyword, and an owner note (what to confirm + competitor prices).
4. **SEO check**: the same 16 tests Rank Math runs on a product, with the same points
   (`lib/woo.mjs` → `seoAudit`, verified against Rank Math's own editor: `test/audit.test.mjs`).
   The AI rewrites until the score is 100/100. The score updates live while you edit.
   Three Vaxaura checks go beyond Rank Math (no points, but they trigger a rewrite): the long
   description has 350+ words, the keyword density is at most 2.3% (Rank Math alone passed a
   243-word description at 2.47%), and the focus keyword is 2-4 words naming the product (no
   "price in pakistan" in the keyword or slug). SEO titles stay within 60 characters and keep the
   brand's spelling (ST, L'Oréal). If checks still fail, "Save anyway at SEO N/100" saves anyway.
   Possible duplicates of existing products are shown before you save.
5. **Draft**: creates the product as a draft, puts 3 photos inside the description, writes the Rank
   Math fields, and checks every field (including that shoppers cannot see it).

The SKU is always the next free number for the category (VAX-JP07, VAX-CF03, …), never invented.

Note: vaxaura.com's theme removes Rank Math's "Content AI used" test on products
(filter `rank_math/researches/tests` in the vaxaura theme's `functions.php`). Without it the maximum is 95.

## Cost

Free. Gemini API free tier (aistudio.google.com key, no card). Checked 2026-10-30: `gemini-2.5-*` is
closed to new keys and Google Search grounding has no free quota on the 3.x models, which is why the
research uses Google autocomplete + Daraz search instead. On the free tier Google may use the prompts
and photos to improve its products. Vercel Hobby is free.

The free tier is sometimes busy (503) or slow: a listing usually takes 1-2 minutes, sometimes 4. Each
API request makes one AI call with a deadline under Vercel's 300 s limit, busy models are skipped, and
SEO repair rounds run as separate requests. If Gemini is busy, the page shows a retry button.

Photos are uploaded to the Media Library before the AI runs, so an abandoned run leaves unattached
photos there (Media → filter "Unattached").

## Setup (once)

1. **Gemini key**: https://aistudio.google.com/apikey → Create API key.
2. **WordPress application password**: wp-admin → Users → Profile → Application Passwords →
   name "Vaxaura Product Drafts web" → Add New → copy it (shown once).
3. **Vercel**: https://vercel.com/new → import `isajidmanzoor/vaxaura-product-drafts` (Framework:
   Other, no build command) → Environment Variables:

   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a long password you choose (login for this app) |
   | `GEMINI_API_KEY` | from step 1 |
   | `VAXAURA_WP_USER` | your wp-admin username |
   | `VAXAURA_WP_APP_PASSWORD` | from step 2 |
   | `VAXAURA_SITE` | optional, default `https://vaxaura.com` |

   → Deploy. Every push to `main` redeploys production.

Changing `ADMIN_PASSWORD` or the WordPress application password logs everyone out.
To stop the app at once: revoke the application password in wp-admin.

## Local

```bash
npm test                  # SEO audit tests (no network)
node cli/dev-server.mjs   # http://localhost:3000, login password: vaxaura-local
```

The dev server reads the same variables from the environment or from
`~/.vaxaura/credentials.env` (`KEY=value` lines).

## Files

- `public/` – the page (no build step)
- `api/*.js` – Vercel functions: `login`, `logout`, `me`, `context`, `upload`, `fetch-photo`, `research`, `write`, `audit`, `draft`
- `lib/woo.mjs` – WordPress/WooCommerce/Rank Math client, SEO audit, draft creation and checks
- `lib/ai.mjs` – Gemini research, listing and SEO repair loop
- `lib/http.mjs` – login cookie and route wrapper
