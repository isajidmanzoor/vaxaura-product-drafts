# Vaxaura Product Drafts

Upload product photos → the app researches the Pakistani market and writes a full SEO listing →
you review it → it is saved on vaxaura.com as a **WooCommerce draft**. It never publishes; you
publish from wp-admin yourself (publishing is also what starts the social bot's videos).

The interface is in English and works on phones (two-column photo grid, compact step bar) and
desktops (review form with a sticky score card), in light and dark mode.

## What it does

1. **Photos**: from the phone/computer, pasted with Ctrl+V, or from photo links (supplier site,
   Daraz, any public image; the server downloads them and refuses internal addresses). The browser
   adds the Vaxaura branding and saves every photo as WebP under 100 KB (largest size and quality
   that fit, at most 1600 px). They go to the WordPress Media Library; the first is the featured image.
   vaxaura.com saves every upload again at its own quality (a 95 KB photo became 106–193 KB), so the
   size the shop really stored is checked after each upload; when it is over 100 KB the photo is made
   with fewer pixels and uploaded again (at most 3 tries). How much the shop enlarges photos is
   remembered on the device, so later photos usually need one upload. The too-large copies stay in
   the Media Library unused and their IDs are listed after the run.
2. **Research**: Gemini (`gemini-3.6-flash`) identifies the product from the photos and proposes
   search phrases; the server then reads what people in Pakistan type into Google (Google
   autocomplete, `gl=pk`) and the matching Daraz.pk and Naheed.pk listings (price, reviews, rating,
   link; Naheed through its search box's own feed, 8 products per query, strong for cosmetics and brands).
   The Google searches are cleaned into **keyword candidates** (`lib/keywords.mjs`): real searches
   for this kind of product, without "price/Pakistan/daraz/naheed", other brands or keywords another
   Vaxaura product already targets. Each candidate is marked **free** or **overlap** (a shorter or
   longer form is another product's focus keyword), and the searches **taken** by another product
   are listed with that product. Every candidate is **checked with Google** the way the QA checks a
   saved product (Google offers the phrase itself, or longer searches starting with it): most come
   straight out of Google's answers, and a candidate that only appeared inside a longer search
   ("price of jhumka gold earrings" → "jhumka gold earrings") is asked separately (at most 3 per run,
   for the host's request limit). A phrase Google does not offer is shown crossed out and is never
   used, so the writer and the QA judge keywords the same way. Each candidate also carries a
   **demand** tier (▲▲▲ high, ▲▲ medium, ▲ low): Google ranks its suggestions by how much they are
   searched, so a phrase's place in the answers and the number of longer searches that extend it
   give its demand against the best candidate (relative; Google gives no monthly volumes for free).
   The research screen shows all of this - identification, keyword standing, demand and
   cannibalization, Daraz/Naheed listings and the price suggestion - as soon as the research is back,
   while the listing is still being written; the review page shows it again.
   The focus keyword must be one of the candidates (the most specific one with high or medium demand,
   a free one unless nothing free fits); the secondary keywords come from the candidates too. With
   **Search Console** connected (free, below) every candidate also carries how often vaxaura.com was
   really shown on Google for it in the last 90 days, and the writer prefers a candidate with
   impressions between equals. Categories
   are chosen only when they fit; otherwise a new category is suggested (created when the draft is saved).
3. **Listing** (`gemini-3.8-flash` first for better copy, falls back to 3.6 Flash / 3.5 Flash-Lite; JSON output): title, slug, short and long description with FAQ,
   categories, tags, suggested price, stock, weight/size, attributes, alt text per photo, Rank Math
   SEO title/description/focus keyword, and an owner note (what to confirm + competitor prices).
4. **SEO check**: the same 16 tests Rank Math runs on a product, with the same points
   (`lib/woo.mjs` → `seoAudit`, verified against Rank Math's own editor: `test/audit.test.mjs`).
   The AI rewrites until the score is 100/100. The score updates live while you edit.
   Four Vaxaura checks go beyond Rank Math (no points, but they trigger a rewrite): the long
   description has 200+ words (Rank Math's own bar - the copy is kept short, human and specific on
   purpose, 220-320 words), the keyword density is at most 2.3% (Rank Math alone passed a
   243-word description at 2.47%), the focus keyword is 2-4 words naming the product (no
   "price in pakistan" in the keyword or slug), and the URL slug is not already another
   product's (the shop's slugs are compared live; a clash is made unique with "-vaxaura" or
   "-2" before Save, and Save itself refuses a duplicate too). SEO titles stay within 60 characters and keep the
   brand's spelling (ST, L'Oréal). If checks still fail, "Save anyway at SEO N/100" saves anyway.
   A secondary keyword that is not one of the real searches only warns (no points, nothing blocked).
   Possible duplicates of existing products are shown before you save: two names are the same item
   when the words they share carry most of both names' weight, a word weighing more the rarer it is in
   the shop (six different Ticarto couple watch sets are not one product six times; "Gold Bow Heart
   Pendant" and "Gold Bow Heart Pendant Necklace" still are).
   **Keyword cannibalization**: the keywords are compared with every product in the shop; a clash
   (the same search would show two Vaxaura pages) must be fixed, an overlap is shown as a warning.
   "Fix with AI" rewrites the listing on the review page around the chosen keyword while keeping
   prices, SKU, stock, categories, tags and the note.
5. **Draft**: creates the product as a draft, puts 3 photos inside the description, writes the Rank
   Math fields, and checks every field (including that shoppers cannot see it).
6. **QA & analytics** (`lib/qa.mjs`, read-only): right after saving, the draft is checked end to end
   in the shop (status, content, categories, SKU, price, photo size/format/alt text, Rank Math score,
   real-search keyword, cannibalization), with the run's timings and photo savings. The "QA &
   analytics" screen checks any product by ID, grades the whole shop (average SEO, keyword clashes,
   photos over 100 KB, SKUs to tidy, placeholder categories) and lists this device's runs (with their
   timings) and, from the shop itself, every product the tool saved on any device (each draft carries
   the meta `vaxaura_drafted_at` and `vaxaura_draft_score`; "Check" runs its QA).
   - **Keyword & URL QA** (`lib/keyword-qa.mjs`), part of every product check (paste the product link,
     e.g. vaxaura.com/product/couple-watches-black-metal-vaxaura/, or its ID): is the focus keyword a real
     Google search (Google's echo of an unsearched phrase does not count), is it in the URL, SEO title,
     meta description, first sentences and main photo alt, is the URL clean (no repeated words or
     product codes), does another product target it; plus free real-search keywords and a better URL
     (with a 301-redirect reminder for live products).
   - **Keyword cannibalization** section: every group of products competing for the same search,
     which one keeps the keyword (live first, then SEO score, then the older one) and a different free
     real-search keyword and URL for each of the others; and a checker that says whether a keyword
     is free before it is used.
   - **Fix for products already in the shop** (`lib/fix.mjs`): "Preview fix" (in the cannibalization
     section, or a keyword chip in the keyword & URL QA) shows the new focus keyword, SEO title, meta
     description, URL and main photo alt next to the current ones, the Rank Math score before and
     after, and how often the old keyword is replaced in the descriptions (text only: photos, links
     and formatting stay). Every value can be edited, including the product name and both
     descriptions (HTML), and there is a link to open the product in WordPress. "Apply to the shop" saves it only after a
     confirmation, keeps the previous values on the product for **Undo**, refuses if the product was
     changed in WordPress after the preview, and checks that a live product's old URL redirects
     (301) to the new one (WordPress does this itself for a changed slug).
   - **Fix photos** (`lib/maintenance.mjs`; product check and shop report): photos over 100 KB or
     not WebP are made into WebP under 100 KB in the browser (Vaxaura branding optional), uploaded,
     and replace the old ones in the gallery and inside the description; alt texts stay, the old
     files stay in the Media Library, and Undo puts them back.
   - **Fix SKUs** (shop report): missing or untidy SKUs get the shop format; an untidy one keeps its
     number when it is free (vax - JP04 -> VAX-JP04), a missing one gets the next free number for
     its category. Each can be edited; duplicates (also with trashed products) are refused, and the
     old SKU is kept for Undo.

The SKU is always the next free number for the category (VAX-JP07, VAX-CW002, …), never invented; a
new category gets the initials of its name (Hair Accessories → VAX-HA01). It follows the category on
the review page until you type your own.

Note: vaxaura.com's theme removes Rank Math's "Content AI used" test on products
(filter `rank_math/researches/tests` in the vaxaura theme's `functions.php`). Without it the maximum is 95.

## Search Console (free, optional)

Google Search Console is the one free source of real numbers: how often vaxaura.com was shown on
Google for a search, how often it was clicked, and at which position. Connected, the tool shows on
every keyword chip how often the shop was really shown for it (`imp`), each product check gets a
**Search Console** group (impressions of its focus keyword, where the page ranks for it, the
searches the page is already shown for), the writer prefers candidates with impressions, and "QA &
analytics → Search Console" lists the searches with proven demand that no product targets yet.
Read-only: the account can only read the reports.

1. https://console.cloud.google.com → create a project (any name) → **APIs & Services → Library** →
   enable **Google Search Console API**.
2. **IAM & Admin → Service Accounts → Create service account** (any name) → open it → **Keys → Add
   key → Create new key → JSON**. A `.json` file downloads; it holds `client_email` and `private_key`.
3. https://search.google.com/search-console → the vaxaura.com property → **Settings → Users and
   permissions → Add user** → the `client_email` from the file, permission **Full** (or Restricted).
4. Cloudflare: the Worker → **Settings → Variables and Secrets** → add the secret
   `GSC_SERVICE_ACCOUNT` = the whole content of the `.json` file (paste it as one value). Optional
   `GSC_SITE` = the property as Search Console names it (`sc-domain:vaxaura.com` or
   `https://vaxaura.com/`); without it the tool tries both. Render/Vercel: the same variables.

With it, every check of a live product also asks Google's **URL Inspection API** (free, 2,000 a
day) whether the page is in Google's index, when it was last crawled, whether robots.txt allows it
and which URL Google treats as the canonical - a page that is not indexed cannot rank at all - and
reads the page's last 28 days against the 28 before (impressions falling, and impressions without
clicks, which means the SEO title and meta description are not earning the click).

The **shop report** gets two more columns with it: each product's impressions, clicks and average
position of the last 28 days (one query for the whole shop) and whether Google has the page in its
index (asked ten products per request after the table is on screen, so a big shop stays within the
host's limits), plus a tile with how many products Google showed at all and how many are not indexed.

The report also asks the Sitemaps API which sitemaps Google has for the site, when it last read
them and how many URLs are indexed; when none is submitted it says so and names the one to submit
(vaxaura.com/sitemap_index.xml). On the first live run 19 of 38 live products were "unknown to
Google" for exactly that reason.

Every check of a live product also reads Rank Math's `product-sitemap.xml` (no Search Console
needed): a product missing from it is hard for Google to find at all.

Google publishes the data about two days late; the tool reads the last 90 days and remembers each
answer for ten minutes. Google also hides rare searches from the query lists, so a new site shows
only a few searches at first. Without the secret everything else works as before and the checks say
"Search Console not connected".

**Internal links.** Every new listing ends with a "See also" line: the product's category page
(as the shop names it, e.g. vaxaura.com/Collections/jewellery/pendants/) and the two related live
products of that category whose names share the most words. Internal links help Google find and
rank both pages; the line is on the review page, so it can be edited, and the product QA flags
products that have no internal link at all.

## Cost

Free. Gemini API free tier (aistudio.google.com key, no card). Search Console API: free. Checked 2026-10-30: `gemini-2.5-*` is
closed to new keys and Google Search grounding has no free quota on the 3.x models, which is why the
research uses Google autocomplete + Daraz and Naheed search instead. On the free tier Google may use the prompts
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

## Hosting on Render

The tool also runs as one Node server (`node server.mjs`, `lib/server.mjs`), e.g. on Render's
free plan, with the same security headers as on Vercel. `render.yaml` describes the service.

1. render.com → sign up with GitHub → **New → Blueprint** → choose this repository.
2. Fill in the four secrets: `ADMIN_PASSWORD` (at least 10 characters), `GEMINI_API_KEY`,
   `VAXAURA_WP_USER`, `VAXAURA_WP_APP_PASSWORD`. The server does not start without them.
3. **Apply**. The tool runs at `https://<service-name>.onrender.com`; every push to `main` deploys.

The free plan sleeps after 15 minutes without visits; the first page then takes about a minute.
A call may run up to 5.5 minutes (research and writing wait on the AI).

## Hosting on Cloudflare Workers

Free, no card. `worker.mjs` runs the same `api/*.js` routes, `public/` is served as static assets,
and `wrangler.jsonc` is the configuration (with the same security headers).

1. dash.cloudflare.com → sign up → **Workers & Pages → Create → Import a repository** → GitHub →
   `isajidmanzoor/vaxaura-product-drafts`. Keep the defaults (deploy command `npx wrangler deploy`).
2. After the first deploy: the Worker → **Settings → Variables and Secrets** → add the four secrets
   (type **Secret**): `ADMIN_PASSWORD` (at least 10 characters), `GEMINI_API_KEY`, `VAXAURA_WP_USER`,
   `VAXAURA_WP_APP_PASSWORD`. Until they are set, every API call answers "The tool is not set up yet".
3. The tool runs at `https://drafts.vaxaura.workers.dev`; every push to `main` deploys.

Free plan limits: 100,000 requests a day, 10 ms of server CPU per request (waiting for the AI,
WordPress, Google, Daraz or Naheed does not count) and 50 outside requests per request (research fetches at
most 10 store thumbnails and 3 Naheed searches for that reason). There is no time limit while the browser waits.

## Big shops

Measured with `node cli/load-test.mjs 1000` (a fake WordPress with 1,000 products answering in
200 ms, Node 24; your numbers differ with the host and WordPress, the shape does not):

| What | WordPress requests | Data | Time |
|---|---|---|---|
| Store context (loaded at the start of every run) | 13 | 1.6 MB | ~2.5 s |
| Live SEO audit: first time / every keystroke after | 10 / 0 | 1.6 MB / 0 | ~2.3 s / instant |
| QA of one product | 5 | tiny | ~2 s |
| Shop report, each page of 100 products | 15–26 | 0.8–2.4 MB | 1.5–4 s |
| Shop report, the whole shop at once (Node host) | ~160 | ~10 MB | ~15 s |
| Cannibalization report | ~20, plus Google for 5 products (8 each) | depends on the clashes | ~6 s |

What keeps it affordable: the shop-wide lists ask WordPress only for the fields they use
(`_fields`: 1,000 products are 1.6 MB instead of 7 MB), the shop's keywords are tokenised once and
kept with the list so the live audit costs nothing per keystroke, the shop report is graded in pages
of 100 that the browser adds up, the cannibalization report asks Google for alternatives for 5
products per run (the others on demand, "Find a free keyword"), and the AI prompts carry only the
prices of the listing's category and the keywords near its candidates (about 1,700 tokens instead
of 24,000 with 1,000 products).

Hosts: on Cloudflare's free plan a request may make 50 outside requests and use 10 ms of CPU
(parsing WordPress's JSON counts; waiting does not). Up to roughly 300–400 products everything
fits. Beyond that the store context alone (1.6 MB of JSON at 1,000 products) can hit the CPU limit,
and research, writing and the reports fail with a Cloudflare error: for a shop that size use the
Node host (Render, above) or Cloudflare's paid plan (30 s of CPU per request). The code is the same.

## Local

```bash
npm test                  # SEO audit tests (no network)
node cli/dev-server.mjs   # http://localhost:3000 (this computer only), login password: vaxaura-local
```

The dev server reads the same variables from the environment or from
`~/.vaxaura/credentials.env` (`KEY=value` lines).

## Files

- `public/` – the page (no build step)
- `api/*.js` – Vercel functions: `login`, `logout`, `me`, `context`, `upload`, `fetch-photo`, `research`, `write`, `audit`, `draft`, `qa`, `fix` (keyword, photo and SKU fixes)
- `lib/woo.mjs` – WordPress/WooCommerce/Rank Math client, SEO audit, draft creation and checks
- `lib/ai.mjs` – Gemini research, listing and SEO repair loop
- `lib/keywords.mjs` – keyword candidates from Google searches, keyword cannibalization
- `lib/qa.mjs` – QA of a product and the shop-wide report
- `lib/keyword-qa.mjs` – keyword & URL QA, cannibalization groups and fixes, keyword checker
- `lib/console.mjs` – Google Search Console (service account): impressions, clicks and positions per search
- `lib/fix.mjs` – keyword fix for products already in the shop: preview, apply, undo
- `lib/maintenance.mjs` – photo and SKU fixes for products already in the shop
- `lib/http.mjs` – login cookie, route wrapper, security headers, required settings
- `lib/server.mjs`, `server.mjs` – the tool as one Node server (Render, this computer)
- `worker.mjs`, `wrangler.jsonc` – the tool on Cloudflare Workers
