# etf-portfolio

ETF Portfolio Report — an interactive Cloudflare Pages site. Edit the
Symbol and Shares columns directly in the browser, and everything else
(price, value, sector/country weights, holdings, pie charts) updates
automatically. A new empty row appears whenever you fill in the last one.

## How it's built

This is a **Cloudflare Worker with static assets** (the modern
replacement for Cloudflare Pages + Pages Functions):

- `public/index.html` + `public/app.js` — the frontend (editable table,
  aggregation, Chart.js pie charts). Plain JS, no build step, no
  framework. Served as static assets.
- `src/worker.js` — the Worker entry point. Routes `GET /api/etf` to the
  ETF-fetching logic below; everything else falls through to the static
  assets in `public/`.
- `src/etf.js` — runs server-side on Cloudflare's edge, not in the
  browser, so it can call stockanalysis.com / Yahoo Finance /
  frankfurter.app directly without hitting browser CORS restrictions.
- `wrangler.toml` — declares the Worker entry point (`main`) and the
  static assets directory (`[assets] directory = "./public"`).

No API keys or secrets are needed — everything it calls is a free,
unauthenticated endpoint.

## Deploy to Cloudflare

**Option A — Wrangler CLI**

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

The first run will ask you to create a new Worker (pick a name, or keep
the one in `wrangler.toml`).

**Option B — GitHub (used for this repo)**

In the Cloudflare dashboard choose **Compute (Workers) → Create → Import
a repository**, and point it at this repo (`tobiasberr/etf-portfolio`).
Leave the deploy command as the default (`npx wrangler deploy`) — the
`wrangler.toml` in this repo tells it what to build and where the static
assets live. Every push to the connected branch redeploys automatically.

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
