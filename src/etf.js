// ETF data fetching — shared logic used by the Worker's /api/etf route.
//
// Runs server-side on Cloudflare's edge, so it can freely call
// stockanalysis.com / query1.finance.yahoo.com / api.frankfurter.app
// without the browser CORS restrictions a client-side fetch would hit.
//
// This is a JavaScript port of the equivalent Python script's logic
// (devalue-decoding stockanalysis.com's internal __data.json payload),
// with field names already confirmed against real test data:
//   holdings: {no, s, n, as}   sectors: {n, w}   countries: {country, weight}
//   stats:    {count, top10, aum, peRatio, assetClass, category, categoryLabel}
//   expense ratio: only on the overview page (not /holdings/)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// Maps a stockanalysis.com exchange code (as used in /quote/<exchange>/<symbol>/)
// to the suffix Yahoo Finance expects on its own ticker for that listing.
// "" means Yahoo uses the bare ticker (US exchanges). This intentionally
// covers all the major currencies an international ETF/stock portfolio
// is likely to hold, not just the four European exchanges we started with.
const YAHOO_SUFFIX = {
  // Americas
  nyse: "", nasdaq: "", amex: "", nyseamerican: "", otc: "",
  tsx: "TO", tsxv: "V", cse: "CN", neo: "NE", // Canada (CAD)
  bvmf: "SA", // Brazil (BRL)
  bcba: "BA", // Argentina (ARS)
  bmv: "MX", // Mexico (MXN)
  // UK & Ireland
  lon: "L", ise: "IR",
  // Eurozone
  etr: "DE", fra: "F", ber: "BE", stu: "SG", mun: "MU", dus: "DU", // Germany
  bit: "MI", // Italy
  par: "PA", // France
  ams: "AS", // Netherlands
  bru: "BR", // Belgium
  lis: "LS", // Portugal
  mce: "MC", bme: "MC", // Spain
  vie: "VI", // Austria
  hel: "HE", // Finland
  // Other Europe
  swx: "SW", vtx: "SW", // Switzerland (CHF)
  sto: "ST", // Sweden (SEK)
  cph: "CO", // Denmark (DKK)
  osl: "OL", // Norway (NOK)
  wse: "WA", // Poland (PLN)
  // Asia-Pacific
  asx: "AX", // Australia (AUD)
  nzx: "NZ", // New Zealand (NZD)
  hkg: "HK", // Hong Kong (HKD)
  tyo: "T", tse: "T", // Japan (JPY)
  sgx: "SI", // Singapore (SGD)
  nse: "NS", bse: "BO", // India (INR)
  krx: "KS", kosdaq: "KQ", // South Korea (KRW)
  twse: "TW", tpex: "TWO", // Taiwan (TWD)
  // Middle East / Africa
  tlv: "TA", // Israel (ILS)
  jse: "JO", // South Africa (ZAR)
};

// Some listings quote in a fractional subunit (e.g. British pence) rather
// than the currency's major unit — normalize those to match frankfurter.app.
const SUBUNIT_CURRENCY = {
  GBp: "GBP", GBX: "GBP", // UK pence -> pounds
  ZAc: "ZAR", ZAC: "ZAR", // South African cents -> rand
  ILA: "ILS", // Israeli agorot -> shekel
};

// ---------------------------------------------------------------------
// devalue "unflatten" — see /mnt/skills note in the Python version for
// background. SvelteKit's __data.json encodes page props as a flat array
// where objects/arrays reference other array indices instead of nesting
// directly. This resolves it back into normal nested JS objects/arrays.
// ---------------------------------------------------------------------

const SPECIAL_TAGS = new Set([
  "Date", "Set", "Map", "RegExp", "Symbol", "BigInt",
  "null", "undefined", "NaN", "Infinity", "-Infinity", "-0",
]);

function unflattenDevalue(arr) {
  const memo = new Map();
  function resolve(i) {
    if (memo.has(i)) return memo.get(i);
    const val = arr[i];
    if (Array.isArray(val)) {
      if (val.length && typeof val[0] === "string" && SPECIAL_TAGS.has(val[0])) {
        const tag = val[0];
        let out;
        if (tag === "Date") out = val.length > 1 ? val[1] : null;
        else if (tag === "Set") out = val[1].map(resolve);
        else if (tag === "Map") out = Object.fromEntries(val[1].map(([k, v]) => [String(resolve(k)), resolve(v)]));
        else if (tag === "null" || tag === "undefined") out = null;
        else if (tag === "NaN") out = NaN;
        else if (tag === "Infinity") out = Infinity;
        else if (tag === "-Infinity") out = -Infinity;
        else if (tag === "-0") out = -0;
        else out = val.length > 1 ? val[1] : null;
        memo.set(i, out);
        return out;
      }
      const out = new Array(val.length).fill(null);
      memo.set(i, out);
      val.forEach((ref, idx) => { out[idx] = resolve(ref); });
      return out;
    } else if (val && typeof val === "object") {
      const out = {};
      memo.set(i, out);
      for (const k of Object.keys(val)) out[k] = resolve(val[k]);
      return out;
    } else {
      memo.set(i, val);
      return val;
    }
  }
  return resolve(0);
}

async function fetchPageNodes(path) {
  const url = `https://stockanalysis.com${path}__data.json?x-sveltekit-trailing-slash=1`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  if (!r.ok) {
    const err = new Error(`fetch ${path}__data.json failed: HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const payload = await r.json();
  const nodes = [];
  for (const node of payload.nodes || []) {
    if (node && node.type === "data" && node.data) {
      try {
        nodes.push(unflattenDevalue(node.data));
      } catch (e) {
        // skip nodes that don't decode cleanly
      }
    }
  }
  return nodes;
}

function findHoldingsData(nodes) {
  for (const obj of nodes) {
    if (obj && typeof obj === "object" && ("holdings" in obj || "sectors" in obj)) return obj;
  }
  return null;
}

function flattenStats(container) {
  const stats = {};
  if (!container) return stats;
  if (Array.isArray(container)) {
    for (const item of container) {
      if (item && typeof item === "object") {
        const label = item.label ?? item.name ?? item.title ?? item.id;
        const value = "value" in item ? item.value : item.v;
        if (label != null && value != null) stats[String(label)] = value;
      }
    }
  } else if (typeof container === "object") {
    for (const [k, v] of Object.entries(container)) {
      if (typeof v === "string" || typeof v === "number") stats[k] = v;
      else if (v && typeof v === "object" && "value" in v) stats[k] = v.value;
    }
  }
  return stats;
}

function findStat(stats, ...keywords) {
  for (const [k, v] of Object.entries(stats)) {
    const kl = k.toLowerCase();
    if (keywords.some((kw) => kl.includes(kw))) return v;
  }
  return null;
}

function numOrNull(v) {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

// Like numOrNull, but also accepts a plain numeric string (e.g. "25.68")
// — needed for the overview page's stats, which (unlike the holdings
// page's infoBox/infoTable) come through already formatted as display
// strings rather than raw numbers. NOT safe for a string carrying a
// unit/suffix (e.g. "28.52M") — parseFloat would silently drop the
// suffix and return 28.52 instead; use that string as-is instead.
function numOrNullLoose(v) {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[,%]/g, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "n/a") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatLargeNumber(n) {
  n = Number(n);
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  if (n >= 1e9) return `${sign}${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${sign}${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${sign}${(n / 1e3).toFixed(2)}K`;
  return `${sign}${n.toFixed(2)}`;
}

function cleanSymbol(raw) {
  raw = String(raw || "").replace(/^\$/, "");
  // "!krx/005930", "!ams/ASML" etc. — an exchange-prefixed symbol format
  // confirmed on real holdings data, distinct from the "$TICKER" (US) and
  // "EXCH:TICKER" forms already handled below.
  raw = raw.replace(/^![^/]*\//, "");
  return raw.includes(":") ? raw.split(":").pop().trim() : raw.trim();
}

function pct(v) {
  if (v == null) return 0;
  if (typeof v === "string") {
    const cleaned = v.replace("%", "").replace(/,/g, "").trim();
    return cleaned ? parseFloat(cleaned) : 0;
  }
  return Number(v);
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

// Returns { name, debug } — debug is a human-readable reason whenever
// name is null, so a failure here is diagnosable from the UI instead of
// silently falling back to the bare ticker.
async function fetchTitleName(path) {
  try {
    const r = await fetch(`https://stockanalysis.com${path}`, { headers: { "User-Agent": UA } });
    if (!r.ok) return { name: null, debug: `HTTP ${r.status}` };
    const html = await r.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) return { name: null, debug: "no <title> tag found" };
    const title = decodeHtmlEntities(m[1].trim());

    // Current format: "<Name> (<EXCH>:<TICKER>) Stock Price & Overview"
    const withSuffix = title.match(/^(.*?)\s*\([^)]+\)\s*Stock Price/i);
    if (withSuffix && withSuffix[1].trim()) return { name: withSuffix[1].trim(), debug: null };

    // Older format seen previously: "<something> - <Name>"
    if (title.includes(" - ")) {
      const name = title.split(" - ").slice(1).join(" - ").trim();
      if (name) return { name, debug: null };
    }

    return { name: null, debug: `title matched no known pattern: "${title}"` };
  } catch (e) {
    return { name: null, debug: `fetch threw: ${e.message}` };
  }
}

async function searchSymbol(symbol) {
  try {
    const r = await fetch(`https://stockanalysis.com/api/search?q=${encodeURIComponent(symbol)}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return j.data || [];
  } catch (e) {
    return [];
  }
}

async function candidatePathsForSymbol(symbol, excludePath) {
  const paths = [];
  const results = await searchSymbol(symbol);
  for (const item of results) {
    const t = item.t, s = item.s || "";
    let path = null;
    if (t === "e" && s.toUpperCase() === symbol.toUpperCase()) {
      path = `/etf/${s.toLowerCase()}/holdings/`;
    } else if (t === "ey" && s.includes("/")) {
      const [exch, tick] = s.split("/");
      if (tick.toUpperCase() === symbol.toUpperCase()) path = `/quote/${exch.toLowerCase()}/${tick}/holdings/`;
    }
    if (path && path !== excludePath && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

// Fallback country-allocation source for when stockanalysis.com has none
// (neither the primary listing nor a cross-listing of the same index) —
// e.g. bit/HEMA. Confirmed against a real captured request/response
// (DevTools Network tab, live browser session) for IE000KCS7J59:
//
//   1. Search page for the ISIN: /en/search.html?query=<name>&search=ALL
//   2. Fetch the profile page (/en/etf-profile.html?isin=<ISIN>) — this is
//      an Apache Wicket app; the country table only fully loads via a
//      stateful AJAX "load more" behavior, not in the initial page HTML.
//      We need this fetch anyway for its Set-Cookie headers (JSESSIONID +
//      the AWSALB load-balancer affinity cookie — Wicket page state lives
//      server-side, keyed to a specific backend instance) and to read the
//      *current* AJAX behavior URL out of the page's own inline JS (its
//      numeric prefix may not be stable across sessions).
//   3. Call that AJAX URL with the cookies from step 2 attached. The
//      response is XML with the real data inside a <component> element's
//      CDATA section: a <table data-testid="etf-holdings_countries_table">
//      whose rows carry data-testid="tl_etf-holdings_countries_value_name"
//      / "..._percentage" — confirmed real attribute names. This table is
//      the *complete* list (its percentages summed to exactly 100% in the
//      captured sample, including an "Other" catch-all row), not just the
//      newly-added rows, so parsing this one response is enough.
async function fetchCountryFromJustETF(fullName, notes) {
  try {
    const searchUrl = `https://www.justetf.com/en/search.html?query=${encodeURIComponent(fullName)}&search=ALL`;
    const r = await fetch(searchUrl, { headers: { "User-Agent": UA, Accept: "text/html" } });
    if (!r.ok) {
      notes.push(`[debug] justETF search failed for "${fullName}": HTTP ${r.status}`);
      return {};
    }
    const searchHtml = await r.text();
    const isinMatch = searchHtml.match(/isin=([A-Z0-9]{12})/i);
    if (!isinMatch) {
      notes.push(`[debug] justETF search for "${fullName}" found no ISIN link (response ${searchHtml.length} chars)`);
      return {};
    }
    const isin = isinMatch[1].toUpperCase();

    const profileUrl = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
    const pr = await fetch(profileUrl, { headers: { "User-Agent": UA, Accept: "text/html" } });
    if (!pr.ok) {
      notes.push(`[debug] justETF profile fetch failed for ISIN ${isin}: HTTP ${pr.status}`);
      return {};
    }
    const profileHtml = await pr.text();

    // In case some listing's page already renders the full table (unlike
    // the sample case), check for it directly before bothering with the
    // AJAX round-trip.
    let countries = parseJustETFCountriesTable(profileHtml);
    if (Object.keys(countries).length) {
      notes.push(`country weights sourced from justETF (ISIN ${isin}, initial page) — stockanalysis.com had none for this listing`);
      return countries;
    }

    const cookieHeader = buildCookieHeader(pr);
    const ajaxMatch = profileHtml.match(/"u":"(\/en\/etf-profile\.html\?[^"]*holdingsSection-countries-loadMoreCountries[^"]*)"/);
    if (!ajaxMatch) {
      notes.push(`[debug] justETF profile (ISIN ${isin}) had no country table and no loadMoreCountries AJAX behavior found in its HTML`);
      return {};
    }
    const ajaxPath = ajaxMatch[1].replace(/&amp;/g, "&");
    const ajaxUrl = `https://www.justetf.com${ajaxPath}&_wicket=1&_=${Date.now()}`;

    const ar = await fetch(ajaxUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "application/xml, text/xml, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Wicket-Ajax": "true",
        "Wicket-Ajax-BaseURL": `en/etf-profile.html?isin=${isin}`,
        Referer: profileUrl,
        Cookie: cookieHeader,
      },
    });
    if (!ar.ok) {
      notes.push(`[debug] justETF loadMoreCountries AJAX failed for ISIN ${isin}: HTTP ${ar.status}`);
      return {};
    }
    const ajaxXml = await ar.text();
    countries = parseJustETFCountriesTable(ajaxXml);
    if (Object.keys(countries).length) {
      notes.push(`country weights sourced from justETF (ISIN ${isin}, expanded list) — stockanalysis.com had none for this listing`);
      return countries;
    }
    notes.push(`[debug] justETF loadMoreCountries AJAX for ISIN ${isin} returned ${ajaxXml.length} chars but no country rows matched`);
    return {};
  } catch (e) {
    notes.push(`[debug] justETF fetch threw: ${e.message}`);
    return {};
  }
}

// Combines every Set-Cookie header from a Response into one Cookie header
// value, so a follow-up request can present the same session/affinity
// cookies (getSetCookie() is the modern multi-value accessor; the plain
// get() fallback is a best-effort single-value version for runtimes
// without it).
function buildCookieHeader(response) {
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

// Confirmed real markup (captured live): rows carry these exact
// data-testid attributes regardless of surrounding table/CDATA wrapping.
function parseJustETFCountriesTable(html) {
  const countries = {};
  const rowRe = /data-testid="tl_etf-holdings_countries_value_name">\s*([^<]+?)\s*<\/td>[\s\S]*?data-testid="tl_etf-holdings_countries_value_percentage">\s*([\d.,]+)\s*%/g;
  let m;
  while ((m = rowRe.exec(html)) && Object.keys(countries).length < 60) {
    const name = m[1].trim();
    const value = parseFloat(m[2].replace(",", "."));
    if (name && Number.isFinite(value) && value > 0 && value <= 100) countries[name] = value;
  }
  return countries;
}

async function fetchPrice(exchange, symbol) {
  const suffix = YAHOO_SUFFIX[exchange];
  if (suffix == null) {
    return { price: null, currency: null, error: `no Yahoo Finance exchange mapping for "${exchange}"` };
  }
  const yahooSymbol = suffix ? `${symbol}.${suffix}` : symbol;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) {
      return { price: null, currency: null, error: `Yahoo chart lookup for ${yahooSymbol} failed: HTTP ${r.status}` };
    }
    const j = await r.json();
    if (j.chart && j.chart.error) {
      const desc = j.chart.error.description || JSON.stringify(j.chart.error);
      return { price: null, currency: null, error: `Yahoo chart lookup for ${yahooSymbol}: ${desc}` };
    }
    const result = j.chart && j.chart.result && j.chart.result[0];
    const meta = result && result.meta;
    if (!meta || meta.regularMarketPrice == null) {
      return { price: null, currency: null, error: `Yahoo returned no price for ${yahooSymbol} — ticker may not exist under that suffix` };
    }
    let price = meta.regularMarketPrice;
    let currency = meta.currency;
    const majorUnit = SUBUNIT_CURRENCY[currency];
    if (majorUnit) {
      price = price / 100;
      currency = majorUnit;
    }
    return { price, currency, error: null };
  } catch (e) {
    return { price: null, currency: null, error: `Yahoo chart fetch for ${yahooSymbol} threw: ${e.message}` };
  }
}

async function fxRateToEur(currency) {
  if (currency === "EUR") return 1.0;
  const r = await fetch(`https://api.frankfurter.app/latest?from=${currency}&to=EUR`);
  if (!r.ok) throw new Error(`FX lookup failed for ${currency}: HTTP ${r.status}`);
  const j = await r.json();
  return j.rates.EUR;
}

export async function loadEtf(exchange, symbol) {
  const notes = [];
  const holdingsPath = `/quote/${exchange}/${symbol}/holdings/`;
  const overviewPath = `/quote/${exchange}/${symbol}/`;

  let data = null;
  let holdings = [];
  let sectors = {};
  let countries = {};
  let totalHoldings = "n/a";
  let top10Pct = "n/a";
  let assets = "n/a";
  let peRatio = "n/a";
  let expenseRatio = "n/a";
  let holdingsPageMissing = false;

  try {
    const nodes = await fetchPageNodes(holdingsPath);
    data = findHoldingsData(nodes);
    if (!data) notes.push("holdings page data payload did not contain holdings/sectors — ticker may not exist on stockanalysis.com");
  } catch (e) {
    if (e.status === 404) {
      holdingsPageMissing = true;
      notes.push("no holdings page for this listing on stockanalysis.com — showing overview data only (no holdings/sector/country breakdown)");
    } else {
      notes.push(`internal data-JSON fetch failed: ${e.message}`);
    }
  }

  // Broader than the literal-404 flag above: stockanalysis.com's
  // __data.json endpoint can also return 200 with a payload that just
  // has no holdings/sectors — a "soft" not-found (confirmed on
  // fra/XDG7, where the JSON is 200 but the rendered HTML page 404s).
  // Either way, `data` staying null means there's nothing usable on the
  // holdings page, so treat both the same for the rest of this function.
  const noHoldingsData = holdingsPageMissing || !data;

  const sourceUrl = `https://stockanalysis.com${noHoldingsData ? overviewPath : holdingsPath}`;

  let fullName = null;
  const fullNameDebug = [];
  if (!noHoldingsData) {
    const r1 = await fetchTitleName(holdingsPath);
    fullName = r1.name;
    if (r1.debug) fullNameDebug.push(`holdings page: ${r1.debug}`);
  }
  if (!fullName) {
    const r2 = await fetchTitleName(overviewPath);
    fullName = r2.name;
    if (r2.debug) fullNameDebug.push(`overview page: ${r2.debug}`);
  }
  if (!fullName) {
    fullName = `${exchange.toUpperCase()}:${symbol}`;
    if (fullNameDebug.length) notes.push(`full name lookup failed — ${fullNameDebug.join("; ")}`);
  }

  if (data) {
    for (const h of (data.holdings || []).slice(0, 25)) {
      // Cash/other lines (e.g. "Capital Cash Ctrl", "Usd Capital Cash")
      // simply have no "s" key at all (confirmed against real data) —
      // cleanSymbol(undefined) already resolves to "", but guard against
      // a literal "n/a" string too in case some listing sends that instead.
      const rawSymbol = cleanSymbol(h.s);
      const symbol = rawSymbol && rawSymbol.toLowerCase() !== "n/a" ? rawSymbol : "";
      holdings.push({
        rank: String(h.no ?? ""),
        symbol,
        name: h.n || "",
        weightPct: pct(h.as),
      });
    }
    sectors = Object.fromEntries((data.sectors || []).filter((s) => s.n).map((s) => [s.n, pct(s.w)]));
    countries = Object.fromEntries((data.countries || []).filter((c) => c.country).map((c) => [c.country, pct(c.weight)]));

    totalHoldings = data.count != null ? String(data.count) : (holdings.length ? String(holdings.length) : "n/a");

    const stats = { ...flattenStats(data.infoBox), ...flattenStats(data.infoTable) };
    const top10Val = numOrNull(stats.top10);
    if (top10Val != null) {
      top10Pct = `${top10Val.toFixed(2)}%`;
    } else if (holdings.length) {
      const top10 = holdings.map((h) => h.weightPct).sort((a, b) => b - a).slice(0, 10);
      top10Pct = `${top10.reduce((a, b) => a + b, 0).toFixed(2)}%`;
    }

    const aum = numOrNull(stats.aum);
    const pe = numOrNull(stats.peRatio);
    if (aum != null) assets = formatLargeNumber(aum);
    if (pe != null) peRatio = pe.toFixed(2);
    if (aum == null || pe == null) {
      notes.push(`could not find assets / P-E on holdings page; infoBox/infoTable stats: ${JSON.stringify(stats)}`);
    }
  }

  // Skip all of this — including the cross-listing search fallback below,
  // which wouldn't find anything relevant either — when there's simply no
  // holdings page for this listing (already noted above).
  if (!noHoldingsData) {
    if (!holdings.length) {
      notes.push("no holdings data available");
    }

    if (!Object.keys(sectors).length || !Object.keys(countries).length) {
      const missing = [];
      if (!Object.keys(sectors).length) missing.push("sector");
      if (!Object.keys(countries).length) missing.push("country");
      notes.push(`${missing.join("/")} breakdown unavailable from primary listing`);

      const altPaths = await candidatePathsForSymbol(symbol, holdingsPath);
      for (const altPath of altPaths) {
        if (Object.keys(sectors).length && Object.keys(countries).length) break;
        try {
          const altNodes = await fetchPageNodes(altPath);
          const altData = findHoldingsData(altNodes);
          if (!altData) continue;
          if (!Object.keys(sectors).length) {
            const altSectors = Object.fromEntries((altData.sectors || []).filter((s) => s.n).map((s) => [s.n, pct(s.w)]));
            if (Object.keys(altSectors).length) {
              sectors = altSectors;
              notes.push(`sector weights backfilled from ${altPath} (different listing of the same index)`);
            }
          }
          if (!Object.keys(countries).length) {
            const altCountries = Object.fromEntries((altData.countries || []).filter((c) => c.country).map((c) => [c.country, pct(c.weight)]));
            if (Object.keys(altCountries).length) {
              countries = altCountries;
              notes.push(`country weights backfilled from ${altPath} (different listing of the same index)`);
            }
          }
        } catch (e) {
          notes.push(`cross-listing fetch failed (${altPath}): ${e.message}`);
        }
      }
      // stockanalysis.com (primary + cross-listing) has nothing for
      // country specifically on some listings (e.g. bit/HEMA) — try
      // justETF as a last resort before giving up on it.
      if (!Object.keys(countries).length) {
        const justEtfCountries = await fetchCountryFromJustETF(fullName, notes);
        if (Object.keys(justEtfCountries).length) countries = justEtfCountries;
      }

      const stillMissing = [];
      if (!Object.keys(sectors).length) stillMissing.push("sector");
      if (!Object.keys(countries).length) stillMissing.push("country");
      if (stillMissing.length) notes.push(`${stillMissing.join("/")} weights still unavailable`);
    }
  }

  // Expense ratio: overview page only (confirmed not present on /holdings/).
  // Also grab whatever AUM/P-E/top10 stats are on this page, as a fallback
  // for assets/peRatio/top10Pct/totalHoldings whenever the holdings page
  // didn't have them (including when it's missing entirely). Price itself
  // comes from Yahoo Finance only — see fetchPrice() below.
  let ovStats = {};
  try {
    const ovNodes = await fetchPageNodes(overviewPath);
    for (const obj of ovNodes) {
      if (obj && typeof obj === "object") {
        ovStats = { ...ovStats, ...flattenStats(obj) };
        for (const key of ["infoBox", "infoTable", "trust", "quote", "stats"]) {
          if (key in obj) ovStats = { ...ovStats, ...flattenStats(obj[key]) };
        }
      }
    }

    const exp = findStat(ovStats, "expense");
    if (exp != null) {
      expenseRatio = typeof exp === "number" ? `${exp}%` : String(exp);
    } else {
      notes.push("expense ratio not found on overview page");
    }

    // Unlike the holdings page's infoBox/infoTable (raw numbers), the
    // overview page's stats come through already formatted for display
    // (e.g. aum: "28.52M", peRatio: "25.68") — use aum as-is rather than
    // re-running it through formatLargeNumber (which expects a raw
    // number and would mangle the "M"/"B" suffix already applied), and
    // parse the rest with numOrNullLoose since they're numeric strings.
    if (assets === "n/a" && ovStats.aum != null && ovStats.aum !== "n/a") {
      assets = String(ovStats.aum);
    }
    if (peRatio === "n/a") {
      const pe = numOrNullLoose(ovStats.peRatio);
      if (pe != null) peRatio = pe.toFixed(2);
    }
    if (top10Pct === "n/a") {
      const top10Val = numOrNullLoose(ovStats.top10);
      if (top10Val != null) top10Pct = `${top10Val.toFixed(2)}%`;
    }
    if (totalHoldings === "n/a" && ovStats.count != null) {
      totalHoldings = String(ovStats.count);
    }
  } catch (e) {
    notes.push(`overview page fetch failed: ${e.message}`);
  }

  // Price comes from Yahoo Finance only (via YAHOO_SUFFIX above) — it
  // always pairs its own price with its own currency, so it can't have
  // the mismatch risk a stockanalysis.com-derived price/currency pairing
  // would (confirmed there: lon/EXUS reads "Currency is GBP · Price in
  // USD" on stockanalysis.com's own page — a price in a currency
  // different from the exchange's local trading currency).
  const { price, currency, error: priceError } = await fetchPrice(exchange, symbol);

  let priceEur = null;
  if (price != null && currency) {
    try {
      const rate = await fxRateToEur(currency);
      priceEur = price * rate;
    } catch (e) {
      notes.push(`FX conversion failed for ${currency}: ${e.message}`);
    }
  } else {
    notes.push(priceError || "price unavailable");
  }

  return {
    exchange, symbol, fullName, sourceUrl,
    price, currency, priceEur,
    expenseRatio, assets, peRatio, totalHoldings, top10Pct,
    holdings, sectors, countries, notes,
  };
}
