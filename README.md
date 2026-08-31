# etf-portfolio

ETF Portfolio Report — an interactive Cloudflare Pages site. Edit the
Symbol and Shares columns directly in the browser, and everything else
(price, value, sector/country weights, holdings, pie charts) updates
automatically. A new empty row appears whenever you fill in the last one.

## How it's built

- `index.html` + `app.js` — the frontend (editable table, aggregation,
  Chart.js pie charts). Plain JS, no build step, no framework.
- `functions/api/etf.js` — a **Cloudflare Pages Function**. This runs
  server-side on Cloudflare's edge, not in the browser, so it can call
  stockanalysis.com / Yahoo Finance / frankfurter.app directly without
  hitting browser CORS restrictions.

No API keys or secrets are needed — everything it calls is a free,
unauthenticated endpoint.

## Deploy to Cloudflare Pages

**Cloudflare's dashboard "Upload assets" (drag-and-drop) does NOT support
the `functions/` folder — this is a documented Cloudflare limitation, not
a mistake in this project.** Use one of these two methods instead:

**Option A — Wrangler CLI (recommended)**

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy .
```

The first run will ask you to create a new Pages project (pick a name).
Because you run this from inside the repo root, Wrangler automatically
detects and uploads the `functions/` folder along with the static files
— this is the key difference from the dashboard's drag-and-drop, which
silently ignores `functions/`.

**Option B — GitHub (used for this repo)**

In the Cloudflare dashboard choose **Workers & Pages → Create → Pages →
Connect to Git**, and point it at this repo (`tobiasberr/etf-portfolio`).
Leave the build command empty and the output directory as `/` (root) —
there's nothing to build. Git-integrated deployments support Functions,
and every push to the connected branch redeploys automatically.

## Using it

- Type a row's ETF as `exchange/TICKER`, e.g. `lon/EXUS`, `etr/SXR8`,
  `bit/FLXE`, `fra/ICGA` (same exchange codes as stockanalysis.com URLs).
- Enter the number of shares.
- A new blank row appears automatically once the last row has both a valid
  symbol and is no longer empty.
- Click the ✕ button to remove a row.
- Edit the Cash figure directly in its row.
- Your portfolio (rows + cash) is saved in the browser's local storage, so
  it's still there next time you open the page on the same device/browser
  — it is **not** synced anywhere or visible to anyone else.

## Known limitations

- Each ETF only ever has stockanalysis.com's **published top 25 holdings**
  available for free — for a broad fund that can be a small fraction of
  its actual composition. The Top Holdings pie chart makes this explicit
  with a "Not in published Top 25" slice.
- If stockanalysis.com doesn't publish a sector/country breakdown for a
  specific listing, the Function tries other listings of the same ticker
  (e.g. a US listing) as a fallback — this is noted under "Data Notes" for
  that ETF when it happens.
- Price comes from Yahoo Finance's public (but unofficial) chart endpoint,
  converted to EUR via frankfurter.app (ECB rates). If Yahoo blocks a
  request, that row's price/value shows as unavailable rather than
  breaking the page.
- gurufocus.com links for individual stock holdings use the plain
  `/stock/{SYMBOL}/summary` URL pattern, which works well for US-listed
  names but may not resolve correctly for every non-US holding.
