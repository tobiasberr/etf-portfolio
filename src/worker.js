// Worker entry point — GET /api/etf?exchange=lon&symbol=EXUS is handled
// here (server-side, so it can call stockanalysis.com / Yahoo Finance /
// frankfurter.app without browser CORS restrictions); every other request
// falls through to the static assets in ./public (bound as env.ASSETS).

import { loadEtf } from "./etf.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/etf") {
      return handleEtfRequest(request);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleEtfRequest(request) {
  const url = new URL(request.url);
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
