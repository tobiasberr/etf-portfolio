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
let overviewSort = { column: null, dir: "asc" }; // column: one of OVERVIEW_SORT_KEYS below, or null
let dragSourceIdx = null; // rows[] index currently being dragged, or null

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
// Manual row reordering (drag & drop) — only active while the overview
// table isn't sorted by a column (overviewSort.column === null), since
// otherwise the dragged visual position wouldn't match rows[] order.
// ---------------------------------------------------------------------

function onRowDragStart(event, idx) {
  dragSourceIdx = idx;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(idx)); // required by some browsers to allow the drag
}

function onRowDragOver(event) {
  event.preventDefault(); // required to allow a drop
  event.dataTransfer.dropEffect = "move";
}

function onRowDrop(event, targetIdx) {
  event.preventDefault();
  if (dragSourceIdx == null || dragSourceIdx === targetIdx) {
    dragSourceIdx = null;
    return;
  }
  const [moved] = rows.splice(dragSourceIdx, 1);
  const insertAt = dragSourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
  rows.splice(insertAt, 0, moved);
  dragSourceIdx = null;
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

// Parses a displayed cell string back into a comparable number, for the
// sortable overview-table columns — handles a trailing "%" (weight/expense
// ratio/top10), a plain number (total holdings/P-E), and a "28.52M"/
// "1.30B"-style magnitude suffix (assets). Returns null for "", "n/a", or
// anything else unparseable, so it always sorts to the end regardless of
// direction rather than being treated as zero.
function numericSortKey(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str || str.toLowerCase() === "n/a") return null;
  const m = str.match(/^(-?[\d,]*\.?\d+)\s*([kmbt])?%?$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || "").toLowerCase()];
  return mult ? n * mult : n;
}

// Sortable overview-table columns: header index -> [sort key, field on the
// row record holding that column's displayed string].
const OVERVIEW_SORT_COLUMNS = {
  6: ["weight", "weight"],
  7: ["expenseRatio", "expRatio"],
  8: ["totalHoldings", "totalHold"],
  9: ["top10", "top10"],
  10: ["assets", "assets"],
  11: ["peRatio", "pe"],
};

function setOverviewSort(column) {
  // asc -> desc -> off (back to manual/drag order) -> asc -> ...
  if (overviewSort.column === column) {
    overviewSort = overviewSort.dir === "asc" ? { column, dir: "desc" } : { column: null, dir: "asc" };
  } else {
    overviewSort = { column, dir: "asc" };
  }
  renderAll();
}

function renderOverviewTable(agg) {
  const headers = ["", "Full Name", "Symbol", "Shares", "Price/Share", "Value (EUR)", "Weight %",
    "Expense Ratio", "Total Holdings", "Top 10 Holdings Percentage", "Assets", "P/E Ratio"];
  const rightCols = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const total = agg.totalWithCash;
  const weightStr = (v) => (v != null && total ? `${((v / total) * 100).toFixed(2)}%` : "");

  let html = '<table class="tbl"><thead><tr>';
  headers.forEach((h, i) => {
    const sortEntry = OVERVIEW_SORT_COLUMNS[i];
    if (!sortEntry) {
      html += `<th${rightCols.has(i) ? ' class="num"' : ""}>${h}</th>`;
      return;
    }
    const [key] = sortEntry;
    const active = overviewSort.column === key;
    const icon = active ? (overviewSort.dir === "asc" ? "▲" : "▼") : "⇅";
    html += `<th class="num sortable${active ? " sort-active" : ""}" onclick="setOverviewSort('${key}')">${h} <span class="sort-icon">${icon}</span></th>`;
  });
  html += "</tr></thead><tbody>";

  // Build a display record per row first (in rows[] order) — sorting
  // reorders the RENDERED rows, not the underlying rows[] array itself,
  // so each record keeps its original idx for the row's input handlers.
  const records = rows.map((row, idx) => {
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

    return {
      idx, isEmptyRow, symbolValue, shares, valueEur, priceStr, fullNameCell,
      weight: weightStr(valueEur), expRatio, totalHold, top10, assets, pe,
    };
  });

  // The trailing empty "add a row" entry always renders last, unsorted.
  const dataRecords = records.filter((r) => !r.isEmptyRow);
  const emptyRecords = records.filter((r) => r.isEmptyRow);

  if (overviewSort.column) {
    const sortEntry = Object.values(OVERVIEW_SORT_COLUMNS).find(([key]) => key === overviewSort.column);
    const field = sortEntry[1];
    const dir = overviewSort.dir === "asc" ? 1 : -1;
    dataRecords.sort((a, b) => {
      const av = numericSortKey(a[field]);
      const bv = numericSortKey(b[field]);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;  // n/a (unparseable) always sorts last, either direction
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  // Drag-to-reorder only makes sense in the table's natural (unsorted)
  // order — while a column sort is active, dragging a visually-sorted
  // row wouldn't map cleanly onto its rows[] position.
  const draggableRows = !overviewSort.column;

  dataRecords.concat(emptyRecords).forEach((r) => {
    const { idx } = r;
    const rowIsDraggable = draggableRows && !r.isEmptyRow;
    // draggable="true" goes on the grip handle, not the <tr> — that way
    // dragging only starts from the handle, and normal interaction with
    // the row's own inputs (selecting text, etc.) isn't hijacked by it.
    // The row itself just listens for dragover/drop, so it still works
    // as the drop target regardless of where the drag began.
    html += rowIsDraggable ? `<tr ondragover="onRowDragOver(event)" ondrop="onRowDrop(event, ${idx})">` : "<tr>";
    if (r.isEmptyRow) {
      html += "<td></td>";
    } else {
      const handle = rowIsDraggable
        ? `<span class="drag-handle" draggable="true" ondragstart="onRowDragStart(event, ${idx})" title="Drag to reorder">⠿</span>`
        : "";
      html += `<td>${handle}<button class="row-remove" onclick="removeRow(${idx})" title="Remove row">✕</button></td>`;
    }
    html += `<td>${r.fullNameCell}</td>`;
    html += `<td><input type="text" value="${escapeHtml(r.symbolValue)}" placeholder="lon/EXUS" oninput="onSymbolInput(${idx}, this.value)" onchange="commitRow(${idx})" onkeydown="commitOnEnter(event, () => commitRow(${idx}))"></td>`;
    html += `<td class="num"><input class="shares" type="number" value="${r.shares}" placeholder="shares" oninput="onSharesInput(${idx}, this.value)" onchange="commitRow(${idx})" onkeydown="commitOnEnter(event, () => commitRow(${idx}))"></td>`;
    html += `<td class="num">${r.priceStr}</td>`;
    html += `<td class="num">${r.valueEur != null ? fmtEur(r.valueEur) : ""}</td>`;
    html += `<td class="num">${r.weight}</td>`;
    html += `<td class="num">${r.expRatio}</td>`;
    html += `<td class="num">${r.totalHold}</td>`;
    html += `<td class="num">${r.top10}</td>`;
    html += `<td class="num">${r.assets}</td>`;
    html += `<td class="num">${r.pe}</td>`;
    html += "</tr>";
  });

  // Cash row
  html += "<tr>";
  html += "<td></td><td>Cash</td><td></td><td></td><td></td>";
  html += `<td class="num"><input class="shares" type="number" value="${cashEur}" oninput="onCashInput(this.value)" onchange="commitCash()" onkeydown="commitOnEnter(event, commitCash)"></td>`;
  html += `<td class="num">${weightStr(cashEur)}</td>`;
  html += "<td></td><td></td><td></td><td></td><td></td>";
  html += "</tr>";

  // Total row
  html += `<tr><td></td><td><b>Total</b></td><td></td><td></td><td></td>`;
  html += `<td class="num"><b>${fmtEur(agg.totalWithCash)}</b></td>`;
  html += `<td class="num"><b>${weightStr(total)}</b></td>`;
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
  const tooltipLabelFn = opts.tooltipLabelFn || null; // (label, value, extra) => tooltip text

  // items are [label, value], [label, value, extra] (passed through to
  // legendLabelFn/tooltipLabelFn, e.g. a holding's name alongside its
  // symbol), or [label, value, extra, pinned] — a pinned item always
  // gets its own slice, bypassing the top-N/"Other" cutoff below (used
  // for cash/other holdings, which could otherwise be small enough to
  // vanish into "Other" like any other minor holding would).
  const all = items.filter(([, v]) => v).map(([k, v, extra, pinned]) => [String(k), Number(v), extra, !!pinned]);
  const pinnedList = all.filter((e) => e[3]);
  const rest = all.filter((e) => !e[3]);
  rest.sort((a, b) => b[1] - a[1]);
  const restBudget = Math.max(0, PIE_MAX_SLICES - pinnedList.length);
  let list;
  if (rest.length > restBudget) {
    const head = rest.slice(0, restBudget);
    const other = rest.slice(restBudget).reduce((s, [, v]) => s + v, 0);
    list = pinnedList.concat(head, other > 0 ? [["Other", other, null, false]] : []);
  } else {
    list = pinnedList.concat(rest);
  }
  list.sort((a, b) => b[1] - a[1]);

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

  const tooltip = {};
  if (tooltipLabelFn) {
    tooltip.callbacks = {
      label: (context) => {
        const entry = list[context.dataIndex];
        return entry ? tooltipLabelFn(entry[0], entry[1], entry[2]) : context.label;
      },
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
        tooltip,
      },
    },
  });
}

function renderOverviewChart(agg) {
  const items = agg.rowInfos.filter((ri) => ri.valueEur).map((ri) => [ri.data.fullName, ri.valueEur]);
  if (cashEur) items.push(["Cash", cashEur]);
  const total = agg.totalWithCash;
  const weightLabel = (label, value) => `${label}: ${total ? ((value / total) * 100).toFixed(2) : "0.00"}%`;
  // No chart title. Legend and hover tooltip both show weight % instead
  // of the raw EUR value the slices are actually sized by. Legend on the
  // right (not bottom). 60vw wide (3x the previous 20vw), like the
  // other three pie charts.
  renderPieChart("chart-overview", "chartOverviewCanvas", "", items, {
    legendPosition: "right", widthPx: "60vw", heightPx: 900,
    legendLabelFn: weightLabel,
    tooltipLabelFn: weightLabel,
  });
}

function renderSectorChart(agg) {
  // No chart title — the "Aggregated Sector Weights" <h3> above it already says this.
  const weightLabel = (label, value) => `${label}: ${value.toFixed(2)}%`;
  renderPieChart("chart-sector", "chartSectorCanvas", "", agg.sectorList, {
    widthPx: "60vw", heightPx: 780,
    legendLabelFn: weightLabel,
    tooltipLabelFn: weightLabel,
  });
}

function renderCountryChart(agg) {
  // No chart title — the "Aggregated Country Weights" <h3> above it already says this.
  const weightLabel = (label, value) => `${label}: ${value.toFixed(2)}%`;
  renderPieChart("chart-country", "chartCountryCanvas", "", agg.countryList, {
    widthPx: "60vw", heightPx: 780,
    legendLabelFn: weightLabel,
    tooltipLabelFn: weightLabel,
  });
}

function renderHoldingsChart(agg) {
  const knownPct = agg.holdingsList.reduce((s, h) => s + h.weightPct, 0);
  const gap = Math.max(0, 100 - knownPct);
  // Cash/other lines have no symbol — use the name as the slice's label
  // instead (so it isn't blank), pass null as the legend's "extra" name
  // so the legend doesn't show the name twice, and pin them so they
  // always get their own slice rather than risking getting folded into
  // "Other" like any other small holding would.
  const items = agg.holdingsList.map((h) => [h.symbol || h.name, h.weightPct, h.symbol ? h.name : null, !h.symbol]);
  if (gap > 0.01) items.push(["Not in published Top 25 (per ETF)", gap, null, false]);
  const holdingLabel = (label, weight, name) =>
    name ? `${label} · ${name} · ${weight.toFixed(2)}%` : `${label}: ${weight.toFixed(2)}%`;
  // No chart title — the "Aggregated Top Holdings" <h3> above it already says this.
  renderPieChart("chart-holdings", "chartHoldingsCanvas", "", items, {
    widthPx: "60vw", heightPx: 900,
    legendLabelFn: holdingLabel,
    tooltipLabelFn: holdingLabel,
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
