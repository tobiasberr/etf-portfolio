// Cloudflare Pages Function — GET /api/etf?exchange=lon&symbol=EXUS
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

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const exchange = (url.searchParams.get("exchange") || "").toLowerCase().trim();
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase().trim();

  if (!exchange || !symbol) {
    return jsonResponse({ error: "exchange and symbol query params are required" }, 400);
  }

  try {
    const result = await loadEtf(exchange, symbol);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=1800", // 30 min edge cache — this data doesn't change intraday
    },
  });
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const YAHOO_SUFFIX = { lon: "L", bit: "MI", etr: "DE", fra: "F" };

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
  if (!r.ok) throw new Error(`fetch ${path}__data.json failed: HTTP ${r.status}`);
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

async function fetchFullNameFromTitle(exchange, symbol) {
  try {
    const r = await fetch(`https://stockanalysis.com/quote/${exchange}/${symbol}/holdings/`, {
      headers: { "User-Agent": UA },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (m) {
      const title = m[1].trim();
      if (title.includes(" - ")) return title.split(" - ").slice(1).join(" - ").trim();
    }
    return null;
  } catch (e) {
    return null;
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

async function fetchPrice(exchange, symbol) {
  const suffix = YAHOO_SUFFIX[exchange];
  if (!suffix) return { price: null, currency: null };
  const yahooSymbol = `${symbol}.${suffix}`;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) return { price: null, currency: null };
    const j = await r.json();
    const meta = j.chart.result[0].meta;
    let price = meta.regularMarketPrice;
    let currency = meta.currency;
    if (currency === "GBp" || currency === "GBX") {
      price = price / 100;
      currency = "GBP";
    }
    return { price, currency };
  } catch (e) {
    return { price: null, currency: null };
  }
}

async function fxRateToEur(currency) {
  if (currency === "EUR") return 1.0;
  const r = await fetch(`https://api.frankfurter.app/latest?from=${currency}&to=EUR`);
  if (!r.ok) throw new Error(`FX lookup failed for ${currency}: HTTP ${r.status}`);
  const j = await r.json();
  return j.rates.EUR;
}

async function loadEtf(exchange, symbol) {
  const notes = [];
  const holdingsPath = `/quote/${exchange}/${symbol}/holdings/`;
  const sourceUrl = `https://stockanalysis.com${holdingsPath}`;

  let data = null;
  let holdings = [];
  let sectors = {};
  let countries = {};
  let totalHoldings = "n/a";
  let top10Pct = "n/a";
  let assets = "n/a";
  let peRatio = "n/a";
  let expenseRatio = "n/a";

  try {
    const nodes = await fetchPageNodes(holdingsPath);
    data = findHoldingsData(nodes);
    if (!data) notes.push("holdings page data payload did not contain holdings/sectors — ticker may not exist on stockanalysis.com");
  } catch (e) {
    notes.push(`internal data-JSON fetch failed: ${e.message}`);
  }

  let fullName = await fetchFullNameFromTitle(exchange, symbol);
  if (!fullName) fullName = `${exchange.toUpperCase()}:${symbol}`;

  if (data) {
    for (const h of (data.holdings || []).slice(0, 25)) {
      holdings.push({
        rank: String(h.no ?? ""),
        symbol: cleanSymbol(h.s),
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
    const stillMissing = [];
    if (!Object.keys(sectors).length) stillMissing.push("sector");
    if (!Object.keys(countries).length) stillMissing.push("country");
    if (stillMissing.length) notes.push(`${stillMissing.join("/")} weights still unavailable`);
  }

  // Expense ratio: overview page only (confirmed not present on /holdings/).
  try {
    const overviewPath = `/quote/${exchange}/${symbol}/`;
    const ovNodes = await fetchPageNodes(overviewPath);
    let ovStats = {};
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
  } catch (e) {
    notes.push(`overview page fetch failed: ${e.message}`);
  }

  const { price, currency } = await fetchPrice(exchange, symbol);
  let priceEur = null;
  if (price != null && currency) {
    try {
      const rate = await fxRateToEur(currency);
      priceEur = price * rate;
    } catch (e) {
      notes.push(`FX conversion failed for ${currency}: ${e.message}`);
    }
  } else {
    notes.push("price unavailable");
  }

  return {
    exchange, symbol, fullName, sourceUrl,
    price, currency, priceEur,
    expenseRatio, assets, peRatio, totalHoldings, top10Pct,
    holdings, sectors, countries, notes,
  };
}
