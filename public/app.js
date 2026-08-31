// ETF Portfolio Report — frontend
// Talks to the Cloudflare Pages Function at /api/etf?exchange=..&symbol=..
// State (rows + cash) persists in localStorage so a refresh doesn't lose it.

const STORAGE_KEY = "etf-portfolio-v1";
const PIE_MAX_SLICES = 10;

const DEFAULT_ROWS = [
  { exchange: "lon", symbol: "EXUS", shares: 100 },
  { exchange: "bit", symbol: "FLXE", shares: 100 },
  { exchange: "lon", symbol: "HEMA", shares: 100 },
  { exchange: "etr", symbol: "SXR8", shares: 100 },
  { exchange: "etr", symbol: "USUE", shares: 100 },
  { exchange: "lon", symbol: "MWEQ", shares: 100 },
  { exchange: "lon", symbol: "XDEW", shares: 100 },
  { exchange: "lon", symbol: "ACWI", shares: 100 },
  { exchange: "fra", symbol: "ICGA", shares: 100 },
  { exchange: "lon", symbol: "IWVL", shares: 100 },
];

let rows = [];
let cashEur = 0;
const cache = new Map();     // "exchange/symbol" -> {status:'loading'|'done'|'error', data, error}
const charts = {};           // canvas id -> Chart.js instance

// ---------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------

function loadInitialState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      rows = Array.isArray(parsed.rows) ? parsed.rows : DEFAULT_ROWS.slice();
      cashEur = typeof parsed.cashEur === "number" ? parsed.cashEur : 0;
      return;
    }
  } catch (e) {
    // fall through to defaults
  }
  rows = DEFAULT_ROWS.map((r) => ({ ...r }));
  cashEur = 0;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows, cashEur }));
  } catch (e) {
    // localStorage unavailable — state just won't persist across reloads
  }
}

function ensureTrailingEmptyRow() {
  const last = rows[rows.length - 1];
  if (!last || (last.exchange && last.symbol)) {
    rows.push({ exchange: "", symbol: "", shares: "" });
  }
}

function cacheKey(exchange, symbol) {
  return `${exchange}/${symbol}`.toLowerCase();
}

// ---------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------

async function ensureData(exchange, symbol) {
  const key = cacheKey(exchange, symbol);
  const existing = cache.get(key);
  if (existing && existing.status !== "error") return existing;

  const entry = { status: "loading", data: null, error: null };
  cache.set(key, entry);
  renderAll();

  try {
    const res = await fetch(`/api/etf?exchange=${encodeURIComponent(exchange)}&symbol=${encodeURIComponent(symbol)}`);
    const body = await res.json();
    if (!res.ok || body.error) {
      entry.status = "error";
      entry.error = body.error || `HTTP ${res.status}`;
    } else {
      entry.status = "done";
      entry.data = body;
    }
  } catch (e) {
    entry.status = "error";
    entry.error = String(e && e.message ? e.message : e);
  }
  renderAll();
  return entry;
}

// ---------------------------------------------------------------------
// Row editing (called from inline event handlers in the rendered table)
// ---------------------------------------------------------------------

// oninput just updates the in-memory model as the user types — it does
// NOT re-render, so the field the user is actively editing is never
// touched mid-keystroke. The matching onchange applies the edit on blur
// (saves state, kicks off any data fetch, re-renders everything);
// commitOnEnter makes Enter do the same immediately, rather than
// relying on Enter to trigger a blur that then triggers onchange —
// that indirection isn't reliably fired by every browser for every
// input type, e.g. type="number" fields.

function onSymbolInput(idx, value) {
  rows[idx].rawSymbolInput = value;
  const parts = value.trim().split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    rows[idx].exchange = parts[0].toLowerCase();
    rows[idx].symbol = parts[1].toUpperCase();
  } else {
    rows[idx].exchange = "";
    rows[idx].symbol = "";
  }
}

function onSharesInput(idx, value) {
  const num = parseFloat(value);
  rows[idx].shares = Number.isFinite(num) ? num : "";
}

function onCashInput(value) {
  const num = parseFloat(value);
  cashEur = Number.isFinite(num) ? num : 0;
}

function commitOnEnter(event, commitFn) {
  if (event.key !== "Enter") return;
  commitFn();
  event.target.blur();
}

function commitRow(idx) {
  const row = rows[idx];
  ensureTrailingEmptyRow();
  saveState();
  if (row.exchange && row.symbol) {
    // If exchange/symbol is already cached, ensureData() resolves
    // immediately without rendering (it only renders around an actual
    // fetch) — so always renderAll() here too, to pick up e.g. a
    // changed Shares value against already-cached price data.
    ensureData(row.exchange, row.symbol);
  }
  renderAll();
}

function commitCash() {
  saveState();
  renderAll();
}

function removeRow(idx) {
  rows.splice(idx, 1);
  ensureTrailingEmptyRow();
  saveState();
  renderAll();
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

function computeAggregate() {
  const activeRows = rows.filter((r) => r.exchange && r.symbol);
  const rowInfos = activeRows.map((row) => {
    const entry = cache.get(cacheKey(row.exchange, row.symbol)) || null;
    const data = entry && entry.status === "done" ? entry.data : null;
    const shares = typeof row.shares === "number" ? row.shares : 0;
    const valueEur = data && data.priceEur != null ? data.priceEur * shares : null;
    return { row, entry, data, shares, valueEur };
  });

  const totalValue = rowInfos.reduce((s, ri) => s + (ri.valueEur || 0), 0);
  const totalWithCash = totalValue + (cashEur || 0);

  const sectors = {};
  const countries = {};
  const holdingsMap = {};
  if (totalValue > 0) {
    for (const ri of rowInfos) {
      if (!ri.valueEur || !ri.data) continue;
      const w = ri.valueEur / totalValue;
      for (const [name, p] of Object.entries(ri.data.sectors || {})) {
        sectors[name] = (sectors[name] || 0) + p * w;
      }
      for (const [name, p] of Object.entries(ri.data.countries || {})) {
        countries[name] = (countries[name] || 0) + p * w;
      }
      for (const h of ri.data.holdings || []) {
        // Dedup key falls back to name for symbol-less holdings (cash
        // lines etc.), so two different ones don't collide — but the
        // stored symbol stays the real (possibly empty) one, not the
        // key, so rendering can tell a real symbol from a name fallback.
        const key = h.symbol || h.name;
        if (!holdingsMap[key]) holdingsMap[key] = { symbol: h.symbol, name: h.name, weightPct: 0 };
        holdingsMap[key].weightPct += h.weightPct * w;
      }
    }
  }

  const sectorList = Object.entries(sectors).sort((a, b) => b[1] - a[1]);
  const countryList = Object.entries(countries).sort((a, b) => b[1] - a[1]);
  const holdingsList = Object.values(holdingsMap).sort((a, b) => b.weightPct - a.weightPct);

  return { rowInfos, totalValue, totalWithCash, sectorList, countryList, holdingsList };
}

// ---------------------------------------------------------------------
// Rendering — overview table
// ---------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtEur(n) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderOverviewTable(agg) {
  const headers = ["", "Full Name", "Symbol", "Shares", "Price/Share", "Value (EUR)",
    "Expense Ratio", "Total Holdings", "Top 10 Holdings Percentage", "Assets", "P/E Ratio"];
  const rightCols = new Set([3, 4, 5, 6, 7, 8, 9, 10]);

  let html = '<table class="tbl"><thead><tr>';
  headers.forEach((h, i) => { html += `<th${rightCols.has(i) ? ' class="num"' : ""}>${h}</th>`; });
  html += "</tr></thead><tbody>";

  rows.forEach((row, idx) => {
    const isEmptyRow = !row.exchange && !row.symbol;
    const symbolValue = row.exchange && row.symbol ? `${row.exchange}/${row.symbol}` : (row.rawSymbolInput || "");
    const entry = row.exchange && row.symbol ? cache.get(cacheKey(row.exchange, row.symbol)) : null;
    const data = entry && entry.status === "done" ? entry.data : null;
    const shares = typeof row.shares === "number" ? row.shares : "";
    const valueEur = data && data.priceEur != null && typeof shares === "number" ? data.priceEur * shares : null;

    let fullNameCell = "";
    let priceStr = "";
    let expRatio = "", totalHold = "", top10 = "", assets = "", pe = "";

    if (entry && entry.status === "loading") {
      fullNameCell = '<span class="loading">loading…</span>';
    } else if (entry && entry.status === "error") {
      fullNameCell = `<span class="loading">error: ${escapeHtml(entry.error)}</span>`;
    } else if (data) {
      fullNameCell = `<a href="${data.sourceUrl}" target="_blank">${escapeHtml(data.fullName)}</a>`;
      priceStr = data.price != null ? `${data.price.toFixed(2)} ${data.currency}` : "n/a";
      expRatio = data.expenseRatio;
      totalHold = data.totalHoldings;
      top10 = data.top10Pct;
      assets = data.assets;
      pe = data.peRatio;
    }

    html += "<tr>";
    html += isEmptyRow ? "<td></td>" : `<td><button class="row-remove" onclick="removeRow(${idx})" title="Remove row">✕</button></td>`;
    html += `<td>${fullNameCell}</td>`;
    html += `<td><input type="text" value="${escapeHtml(symbolValue)}" placeholder="lon/EXUS" oninput="onSymbolInput(${idx}, this.value)" onchange="commitRow(${idx})" onkeydown="commitOnEnter(event, () => commitRow(${idx}))"></td>`;
    html += `<td class="num"><input class="shares" type="number" value="${shares}" placeholder="shares" oninput="onSharesInput(${idx}, this.value)" onchange="commitRow(${idx})" onkeydown="commitOnEnter(event, () => commitRow(${idx}))"></td>`;
    html += `<td class="num">${priceStr}</td>`;
    html += `<td class="num">${valueEur != null ? fmtEur(valueEur) : ""}</td>`;
    html += `<td class="num">${expRatio}</td>`;
    html += `<td class="num">${totalHold}</td>`;
    html += `<td class="num">${top10}</td>`;
    html += `<td class="num">${assets}</td>`;
    html += `<td class="num">${pe}</td>`;
    html += "</tr>";
  });

  // Cash row
  html += "<tr>";
  html += "<td></td><td>Cash</td><td></td><td></td><td></td>";
  html += `<td class="num"><input class="shares" type="number" value="${cashEur}" oninput="onCashInput(this.value)" onchange="commitCash()" onkeydown="commitOnEnter(event, commitCash)"></td>`;
  html += "<td></td><td></td><td></td><td></td><td></td>";
  html += "</tr>";

  // Total row
  html += `<tr><td></td><td><b>Total</b></td><td></td><td></td><td></td>`;
  html += `<td class="num"><b>${fmtEur(agg.totalWithCash)}</b></td>`;
  html += "<td></td><td></td><td></td><td></td><td></td></tr>";

  html += "</tbody></table>";
  document.getElementById("overview-table").innerHTML = html;
}

// ---------------------------------------------------------------------
// Rendering — simple weight tables (sector / country)
// ---------------------------------------------------------------------

function renderWeightTable(containerId, headers, rows2d, rightCols) {
  let html = '<table class="tbl"><thead><tr>';
  headers.forEach((h, i) => { html += `<th${rightCols.has(i) ? ' class="num"' : ""}>${h}</th>`; });
  html += "</tr></thead><tbody>";
  rows2d.forEach((r) => {
    html += "<tr>" + r.map((c, i) => `<td${rightCols.has(i) ? ' class="num"' : ""}>${c}</td>`).join("") + "</tr>";
  });
  html += "</tbody></table>";
  document.getElementById(containerId).innerHTML = html;
}

function renderHoldingsTable(agg) {
  const rows2d = agg.holdingsList.map((h) => [
    h.symbol
      ? `<a href="https://www.gurufocus.com/stock/${encodeURIComponent(h.symbol)}/summary" target="_blank">${escapeHtml(h.symbol)}</a>`
      : "—", // cash/other lines (no ticker) — no gurufocus link to point at
    escapeHtml(h.name),
    `${h.weightPct.toFixed(2)}%`,
  ]);
  renderWeightTable("holdings-table", ["Symbol", "Name", "Weight %"], rows2d, new Set([2]));
}

// ---------------------------------------------------------------------
// Rendering — pie charts
// ---------------------------------------------------------------------

function renderPieChart(containerId, canvasId, title, items, opts) {
  opts = opts || {};
  const legendPosition = opts.legendPosition || "right";
  const widthPx = opts.widthPx || 480; // a number (px) or a CSS width string like "100%"
  const heightPx = opts.heightPx || 320;
  const legendLabelFn = opts.legendLabelFn || null; // (label, value, extra) => legend text

  // items may be [label, value] or [label, value, extra] (extra is passed
  // through to legendLabelFn, e.g. a holding's full name alongside its symbol).
  let list = items.filter(([, v]) => v).map(([k, v, extra]) => [String(k), Number(v), extra]);
  list.sort((a, b) => b[1] - a[1]);
  if (list.length > PIE_MAX_SLICES) {
    const head = list.slice(0, PIE_MAX_SLICES);
    const other = list.slice(PIE_MAX_SLICES).reduce((s, [, v]) => s + v, 0);
    list = head.concat([["Other", other, null]]);
  }

  const container = document.getElementById(containerId);
  if (!list.length) {
    container.innerHTML = "";
    return;
  }
  const maxWidth = typeof widthPx === "number" ? `${widthPx}px` : widthPx;
  container.innerHTML = `<div class="chart-wrap" style="max-width:${maxWidth}"><canvas id="${canvasId}" height="${heightPx}"></canvas></div>`;

  if (charts[canvasId]) charts[canvasId].destroy();
  const ctx = document.getElementById(canvasId);

  const legendLabels = { boxWidth: 14, font: { size: 11 } };
  if (legendLabelFn) {
    legendLabels.generateLabels = (chart) => {
      // Extend Chart.js's own generateLabels so color swatches etc. stay correct.
      const base = Chart.overrides.pie.plugins.legend.labels.generateLabels(chart);
      base.forEach((item) => {
        const entry = list[item.index];
        if (entry) item.text = legendLabelFn(entry[0], entry[1], entry[2]);
      });
      return base;
    };
  }

  charts[canvasId] = new Chart(ctx, {
    type: "pie",
    data: {
      labels: list.map(([k]) => k),
      datasets: [{ data: list.map(([, v]) => Math.round(v * 100) / 100) }],
    },
    options: {
      plugins: {
        title: { display: !!title, text: title || "" },
        legend: { position: legendPosition, labels: legendLabels },
      },
    },
  });
}

function renderOverviewChart(agg) {
  const items = agg.rowInfos.filter((ri) => ri.valueEur).map((ri) => [ri.data.fullName, ri.valueEur]);
  if (cashEur) items.push(["Cash", cashEur]);
  const total = agg.totalWithCash;
  renderPieChart("chart-overview", "chartOverviewCanvas", "Portfolio Allocation by Value (EUR)", items, {
    legendPosition: "bottom", widthPx: 760, heightPx: 420,
    legendLabelFn: (label, value) => `${label}: ${total ? ((value / total) * 100).toFixed(2) : "0.00"}%`,
  });
}

function renderSectorChart(agg) {
  // No chart title — the "Aggregated Sector Weights" <h3> above it already says this.
  renderPieChart("chart-sector", "chartSectorCanvas", "", agg.sectorList, {
    widthPx: 640, heightPx: 400,
    legendLabelFn: (label, value) => `${label}: ${value.toFixed(2)}%`,
  });
}

function renderCountryChart(agg) {
  // No chart title — the "Aggregated Country Weights" <h3> above it already says this.
  renderPieChart("chart-country", "chartCountryCanvas", "", agg.countryList, {
    widthPx: 640, heightPx: 400,
    legendLabelFn: (label, value) => `${label}: ${value.toFixed(2)}%`,
  });
}

function renderHoldingsChart(agg) {
  const knownPct = agg.holdingsList.reduce((s, h) => s + h.weightPct, 0);
  const gap = Math.max(0, 100 - knownPct);
  // Cash/other lines have no symbol — use the name as the slice's label
  // instead (so it isn't blank), and pass null as the legend's "extra"
  // name so the legend doesn't show the name twice.
  const items = agg.holdingsList.map((h) => [h.symbol || h.name, h.weightPct, h.symbol ? h.name : null]);
  if (gap > 0.01) items.push(["Not in published Top 25 (per ETF)", gap, null]);
  // No chart title — the "Aggregated Top Holdings" <h3> above it already says this.
  renderPieChart("chart-holdings", "chartHoldingsCanvas", "", items, {
    widthPx: "100%", heightPx: 480,
    legendLabelFn: (label, weight, name) =>
      name ? `${label} · ${name} · ${weight.toFixed(2)}%` : `${label}: ${weight.toFixed(2)}%`,
  });
}

// ---------------------------------------------------------------------
// Rendering — data notes
// ---------------------------------------------------------------------

function renderNotes(agg) {
  const blocks = [];
  for (const ri of agg.rowInfos) {
    let notes = [];
    if (ri.data && ri.data.notes) notes = ri.data.notes;
    else if (ri.entry && ri.entry.status === "error") notes = [ri.entry.error];
    if (!notes.length) continue;
    const name = ri.data ? ri.data.fullName : `${ri.row.exchange.toUpperCase()}:${ri.row.symbol}`;
    blocks.push(
      `<div class="notes-block"><h4>${escapeHtml(name)} (${ri.row.exchange.toUpperCase()}:${ri.row.symbol})</h4>` +
      `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>`
    );
  }
  const container = document.getElementById("notes-section");
  container.innerHTML = blocks.length ? "<h2>Data Notes</h2>" + blocks.join("") : "";
}

// ---------------------------------------------------------------------
// Top-level render + init
// ---------------------------------------------------------------------

function renderAll() {
  const agg = computeAggregate();
  renderOverviewTable(agg);
  renderOverviewChart(agg);
  renderWeightTable("sector-table", ["Sector", "Weight %"],
    agg.sectorList.map(([k, v]) => [escapeHtml(k), `${v.toFixed(2)}%`]), new Set([1]));
  renderWeightTable("country-table", ["Country", "Weight %"],
    agg.countryList.map(([k, v]) => [escapeHtml(k), `${v.toFixed(2)}%`]), new Set([1]));
  renderSectorChart(agg);
  renderCountryChart(agg);
  renderHoldingsTable(agg);
  renderHoldingsChart(agg);
  renderNotes(agg);
}

window.addEventListener("DOMContentLoaded", () => {
  loadInitialState();
  ensureTrailingEmptyRow();
  renderAll();
  rows.forEach((r) => {
    if (r.exchange && r.symbol) ensureData(r.exchange, r.symbol);
  });
});
