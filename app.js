// =====================
// Utilities
// =====================
const $ = (id) => document.getElementById(id);

function fmtPKR(n){
  const v = Number(n || 0);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}PKR ${abs.toLocaleString("en-US")}`;
}

function safeNum(x){
  if (x === null || x === undefined) return 0;
  const s = String(x).replace(/[, ]+/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Simple CSV parser (commas + quotes)
function parseCSV(text){
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"'){ cur += '"'; i++; continue; }
    if (ch === '"'){ inQuotes = !inQuotes; continue; }

    if (ch === "," && !inQuotes){ row.push(cur); cur = ""; continue; }

    if ((ch === "\n" || ch === "\r") && !inQuotes){
      if (cur.length || row.length){
        row.push(cur);
        rows.push(row);
      }
      cur = "";
      row = [];
      continue;
    }

    cur += ch;
  }

  if (cur.length || row.length){
    row.push(cur);
    rows.push(row);
  }

  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

function rowsToObjects(rows){
  if (!rows.length) return { headers: [], data: [] };
  const headers = rows[0].map(h => String(h || "").trim());
  const data = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = r[idx] ?? "");
    return obj;
  });
  return { headers, data };
}

function stableKeyFromHeaders(headers){
  return headers.map(h => h.toLowerCase().trim()).join("|");
}

// =====================
// Mapping model
// =====================
const REQUIRED_FIELDS = [
  { key:"side", label:"Local vs International (side)" },
  { key:"bucket", label:"Sold / Refunded / Adjustments (bucket)" },
  { key:"realized_sale", label:"Total Realized Sale amount" },
  { key:"platform_fee", label:"Gross Platform Fee amount" },
  { key:"pra_tax", label:"PRA Tax amount" },
  { key:"sales_tax", label:"Sales Tax amount" },
  { key:"income_tax", label:"Income Tax amount" }
];

const OPTIONAL_FIELDS = [
  { key:"adjustment_amount", label:"Adjustment amount (if separate)" },
  { key:"adjustment_label", label:"Adjustment label/type (optional)" }
];

const STORAGE_KEY = "daybook_laam_mapping_v1";

function loadMappings(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}
function saveMappings(m){ localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); }

// =====================
// State
// =====================
const state = {
  files: {
    marketplace: null,
    octane: null,
    item_adjustments: null,
    vendor_deductions: null
  },
  parsed: {
    marketplace: null,
    octane: null,
    item_adjustments: null,
    vendor_deductions: null
  },
  mappingDraft: {},
  pendingMapping: null,
  lastSummary: null
};

// =====================
// UI wiring
// =====================
$("btnGenerate").addEventListener("click", onGenerate);
$("btnReset").addEventListener("click", onReset);
$("btnCopy").addEventListener("click", onCopy);
$("btnDownloadJson").addEventListener("click", onDownloadJson);

$("btnSaveMapping").addEventListener("click", onSaveMapping);
$("btnCancelMapping").addEventListener("click", () => hideMapping());

function setStatus(msg){ $("status").textContent = msg; }

function bindFileInput(inputId, fileKey){
  $(inputId).addEventListener("change", async (e) => {
    const f = e.target.files?.[0] || null;
    state.files[fileKey] = f;

    if (f){
      setStatus(`Selected: ${f.name}`);
      state.parsed[fileKey] = await readAndParseFile(f);
    } else {
      state.parsed[fileKey] = null;
    }
  });
}

bindFileInput("fileMarketplace", "marketplace");
bindFileInput("fileOctane", "octane");
bindFileInput("fileItemAdj", "item_adjustments");
bindFileInput("fileVendorDed", "vendor_deductions");

async function readAndParseFile(file){
  const text = await file.text();
  const rows = parseCSV(text);
  return rowsToObjects(rows);
}

// =====================
// Auto-detect mapping (conservative)
// =====================
function guessColumn(headers, candidates){
  const hLower = headers.map(h => h.toLowerCase());
  for (const c of candidates){
    const idx = hLower.findIndex(h => h.includes(c));
    if (idx >= 0) return headers[idx];
  }
  return null;
}

function autoSuggestMapping(fileType, headers){
  // NOTE: update candidates when you see real Laam headers.
  const m = {};

  m.side = guessColumn(headers, [
    "local/international", "side", "region", "market", "is_international",
    "international", "intl", "country", "currency"
  ]);

  m.bucket = guessColumn(headers, [
    "bucket", "type", "nature", "transaction_type", "section",
    "sold/refund", "refund", "adjust"
  ]);

  m.realized_sale = guessColumn(headers, [
    "total realized sale", "realized sale", "realized", "sale", "total_sale"
  ]);

  m.platform_fee = guessColumn(headers, [
    "gross platform fee", "platform fee", "service fee", "commission", "fee"
  ]);

  m.pra_tax = guessColumn(headers, ["pra tax", "pra"]);
  m.sales_tax = guessColumn(headers, ["sales tax", "gst", "s.tax"]);
  m.income_tax = guessColumn(headers, ["income tax", "withholding", "wht"]);

  // Optional
  m.adjustment_amount = guessColumn(headers, ["adjustment", "deduction", "post delivery", "missed payment"]);
  m.adjustment_label = guessColumn(headers, ["adjustment type", "reason", "label", "description"]);

  return m;
}

function normalizeSide(v){
  const s = String(v || "").toLowerCase();
  if (s.includes("intl") || s.includes("international") || s === "1" || s === "true") return "international";
  return "local";
}

function normalizeBucket(v){
  const s = String(v || "").toLowerCase();
  if (s.includes("refund")) return "refunded";
  if (s.includes("adjust")) return "adjustment";
  if (s.includes("sold") || s.includes("sale") || s.includes("realized")) return "sold";
  // fallback: sold
  return "sold";
}

// =====================
// Totals engine
// =====================
function initBucketTotals(){
  return {
    sold: { realized_sale:0, platform_fee:0, pra_tax:0, sales_tax:0, income_tax:0, adjustment_amount:0 },
    refunded: { realized_sale:0, platform_fee:0, pra_tax:0, sales_tax:0, income_tax:0, adjustment_amount:0 },
    adjustment: { realized_sale:0, platform_fee:0, pra_tax:0, sales_tax:0, income_tax:0, adjustment_amount:0 }
  };
}

function emptyLedgerTotals(){
  return { local: initBucketTotals(), international: initBucketTotals() };
}

// Subtotal logic used to mimic Laam layout:
// SUBTOTAL(A) = Sale - Fee - Taxes (+ adjustments if any)
// SUBTOTAL(B) = Refund impacts (depends on ledger sign conventions)
// SUBTOTAL(D) = Adjustments net
function calcSubTotal(bucket){
  return (
    (bucket.realized_sale || 0)
    - (bucket.platform_fee || 0)
    - (bucket.pra_tax || 0)
    - (bucket.sales_tax || 0)
    - (bucket.income_tax || 0)
    + (bucket.adjustment_amount || 0)
  );
}

function sumBy(fileType){
  const parsed = state.parsed[fileType];
  const map = state.mappingDraft[fileType];
  if (!parsed || !map) return emptyLedgerTotals();

  const totals = emptyLedgerTotals();

  for (const row of parsed.data){
    const side = normalizeSide(row[map.side]);
    const bucketName = normalizeBucket(row[map.bucket]);

    const realized = safeNum(row[map.realized_sale]);
    const fee = safeNum(row[map.platform_fee]);
    const pra = safeNum(row[map.pra_tax]);
    const st = safeNum(row[map.sales_tax]);
    const it = safeNum(row[map.income_tax]);

    totals[side][bucketName].realized_sale += realized;
    totals[side][bucketName].platform_fee += fee;
    totals[side][bucketName].pra_tax += pra;
    totals[side][bucketName].sales_tax += st;
    totals[side][bucketName].income_tax += it;

    // Optional adjustments
    if (map.adjustment_amount && bucketName === "adjustment"){
      totals[side][bucketName].adjustment_amount += safeNum(row[map.adjustment_amount]);
    }
  }

  return totals;
}

function combineSides(a, b){
  const out = initBucketTotals();
  for (const bucketName of ["sold","refunded","adjustment"]){
    const A = a?.[bucketName] || {};
    const B = b?.[bucketName] || {};
    out[bucketName].realized_sale = (A.realized_sale||0) + (B.realized_sale||0);
    out[bucketName].platform_fee = (A.platform_fee||0) + (B.platform_fee||0);
    out[bucketName].pra_tax = (A.pra_tax||0) + (B.pra_tax||0);
    out[bucketName].sales_tax = (A.sales_tax||0) + (B.sales_tax||0);
    out[bucketName].income_tax = (A.income_tax||0) + (B.income_tax||0);
    out[bucketName].adjustment_amount = (A.adjustment_amount||0) + (B.adjustment_amount||0);
  }
  return out;
}

function buildSummary(){
  const marketplace = state.parsed.marketplace ? sumBy("marketplace") : emptyLedgerTotals();
  const octane = state.parsed.octane ? sumBy("octane") : emptyLedgerTotals();

  const consolidated = {
    local: combineSides(marketplace.local, octane.local),
    international: combineSides(marketplace.international, octane.international)
  };

  return { marketplace, octane, consolidated };
}

// =====================
// Mapping flow
// =====================
async function ensureMapping(fileType, allowAuto=false){
  const parsed = state.parsed[fileType];
  if (!parsed) return true; // no file => no mapping needed

  const headers = parsed.headers;
  const headersKey = stableKeyFromHeaders(headers);

  const mappings = loadMappings();
  const storeKey = `${fileType}::${headersKey}`;

  if (mappings[storeKey]){
    state.mappingDraft[fileType] = mappings[storeKey];
    return true;
  }

  if (allowAuto){
    const suggested = autoSuggestMapping(fileType, headers);
    const hasAllRequired = REQUIRED_FIELDS.every(f => suggested[f.key]);
    if (hasAllRequired){
      mappings[storeKey] = suggested;
      saveMappings(mappings);
      state.mappingDraft[fileType] = suggested;
      return true;
    }
  }

  showMapping(fileType, headersKey, headers, parsed.data.slice(0, 10));
  return false;
}

function showMapping(fileType, headersKey, headers, sampleData){
  state.pendingMapping = { fileType, headersKey, headers, sampleData };

  $("mappingPanel").classList.remove("hidden");
  $("results").classList.add("hidden");

  const suggested = autoSuggestMapping(fileType, headers);

  const wrap = $("mappingForms");
  wrap.innerHTML = "";

  const box = document.createElement("div");
  box.className = "mapBox";

  const title = document.createElement("h3");
  title.textContent = `Mapping for: ${fileType.toUpperCase()}`;
  box.appendChild(title);

  const form = document.createElement("div");
  form.className = "grid";
  form.style.gridTemplateColumns = "1fr";

  const allFields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

  allFields.forEach(f => {
    const row = document.createElement("div");
    row.className = "field";

    const label = document.createElement("label");
    label.textContent = f.label + (REQUIRED_FIELDS.some(r => r.key === f.key) ? " *" : "");
    row.appendChild(label);

    const sel = document.createElement("select");
    sel.dataset.mapKey = f.key;

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "— Not in file —";
    sel.appendChild(opt0);

    headers.forEach(h => {
      const o = document.createElement("option");
      o.value = h;
      o.textContent = h;
      sel.appendChild(o);
    });

    if (suggested[f.key]) sel.value = suggested[f.key];

    row.appendChild(sel);
    form.appendChild(row);
  });

  box.appendChild(form);
  wrap.appendChild(box);

  renderPreview(headers, sampleData);
  setStatus(`Mapping required for ${fileType}. Select columns and save.`);
}

function renderPreview(headers, rows){
  const wrap = $("previewWrap");
  wrap.innerHTML = "";

  const tbl = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  headers.slice(0, 10).forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });

  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach(r => {
    const tr = document.createElement("tr");
    headers.slice(0, 10).forEach(h => {
      const td = document.createElement("td");
      td.textContent = String(r[h] ?? "");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}

function hideMapping(){
  $("mappingPanel").classList.add("hidden");
}

function onSaveMapping(){
  const pm = state.pendingMapping;
  if (!pm) return;

  const selects = $("mappingForms").querySelectorAll("select[data-map-key]");
  const m = {};
  selects.forEach(s => { m[s.dataset.mapKey] = s.value || null; });

  const missing = REQUIRED_FIELDS.filter(f => !m[f.key]).map(f => f.label);
  if (missing.length){
    setStatus(`Missing required mapping: ${missing.join(", ")}`);
    return;
  }

  const mappings = loadMappings();
  const storeKey = `${pm.fileType}::${pm.headersKey}`;
  mappings[storeKey] = m;
  saveMappings(mappings);

  state.mappingDraft[pm.fileType] = m;
  state.pendingMapping = null;
  hideMapping();

  setStatus("Mapping saved. Click Generate Summary again.");
}

// =====================
// Generate
// =====================
async function onGenerate(){
  const mode = $("mode").value;

  if (!state.parsed.marketplace && !state.parsed.octane){
    setStatus("Upload at least one ledger file (Marketplace or Octane).");
    return;
  }

  // Forced mapping mode
  if (mode === "map"){
    if (state.parsed.marketplace){
      const ok = await ensureMapping("marketplace", false);
      if (!ok) return;
    }
    if (state.parsed.octane){
      const ok = await ensureMapping("octane", false);
      if (!ok) return;
    }
  } else {
    // Auto mode: try auto-detect else map
    if (state.parsed.marketplace){
      const ok = await ensureMapping("marketplace", true);
      if (!ok) return;
    }
    if (state.parsed.octane){
      const ok = await ensureMapping("octane", true);
      if (!ok) return;
    }
  }

  const summary = buildSummary();
  state.lastSummary = summary;

  renderAllSummaries(summary);

  $("btnCopy").disabled = false;
  $("btnDownloadJson").disabled = false;

  setStatus("Summary generated.");
}

// =====================
// Rendering (Laam-style blocks)
// =====================
function renderAllSummaries(summary){
  $("results").classList.remove("hidden");
  $("mappingPanel").classList.add("hidden");

  // Marketplace section visibility
  if (state.parsed.marketplace){
    $("sectionMarketplace").classList.remove("hidden");
    renderSection("marketplace", summary.marketplace);
  } else {
    $("sectionMarketplace").classList.add("hidden");
  }

  // Octane section visibility
  if (state.parsed.octane){
    $("sectionOctane").classList.remove("hidden");
    renderSection("octane", summary.octane);
  } else {
    $("sectionOctane").classList.add("hidden");
  }

  // Consolidated always visible if any file exists
  renderSection("consolidated", summary.consolidated);

  // Details
  $("detailsTable").innerHTML = renderDetailsTable(summary);
}

function renderSection(sectionName, totals){
  // Metrics
  const metricsEl =
    sectionName === "marketplace" ? $("marketplaceMetrics") :
    sectionName === "octane" ? $("octaneMetrics") :
    $("consolidatedMetrics");

  // Blocks
  const localEl =
    sectionName === "marketplace" ? $("marketplaceLocal") :
    sectionName === "octane" ? $("octaneLocal") :
    $("consolidatedLocal");

  const intlEl =
    sectionName === "marketplace" ? $("marketplaceIntl") :
    sectionName === "octane" ? $("octaneIntl") :
    $("consolidatedIntl");

  const localNet = calcNetPayable(totals.local);
  const intlNet = calcNetPayable(totals.international);

  const totalPlatformFee =
    (totals.local.sold.platform_fee + totals.local.refunded.platform_fee +
     totals.international.sold.platform_fee + totals.international.refunded.platform_fee);

  const totalTaxesSold =
    (totals.local.sold.pra_tax + totals.local.sold.sales_tax + totals.local.sold.income_tax +
     totals.international.sold.pra_tax + totals.international.sold.sales_tax + totals.international.sold.income_tax);

  const cards = [
    { k:"Local Net Payable", v: fmtPKR(localNet.net) },
    { k:"International Net Payable", v: fmtPKR(intlNet.net) },
    { k:"Total Net Payable", v: fmtPKR(localNet.net + intlNet.net) },
    { k:"Total Platform Fee", v: fmtPKR(totalPlatformFee) },
    { k:"Total Taxes (Sold)", v: fmtPKR(totalTaxesSold) }
  ];

  metricsEl.innerHTML = cards.map(c => `
    <div class="metric">
      <div class="k">${c.k}</div>
      <div class="v">${c.v}</div>
    </div>
  `).join("");

  // Laam-like blocks
  localEl.innerHTML = renderLaamSideBlock(totals.local);
  intlEl.innerHTML = renderLaamSideBlock(totals.international);
}

function calcNetPayable(sideTotals){
  const A = calcSubTotal(sideTotals.sold);
  const B = calcSubTotal(sideTotals.refunded);
  const D = calcSubTotal(sideTotals.adjustment);

  const hasD = Math.abs(D) > 0.000001;

  return {
    A, B, D,
    hasD,
    net: hasD ? (A + B + D) : (A + B)
  };
}

function renderLaamSideBlock(sideTotals){
  const sold = sideTotals.sold;
  const refunded = sideTotals.refunded;
  const adj = sideTotals.adjustment;

  const net = calcNetPayable(sideTotals);

  // Sold block
  const soldBlock = `
    <div class="block">
      <div class="row muted"><div class="l">Items Sold (Realized)</div><div class="r"></div></div>
      ${rowLine("Total Realized Sale", sold.realized_sale)}
      ${rowLine("Gross Platform Fee", -sold.platform_fee, true)}
      ${rowLine("PRA Tax", -sold.pra_tax, true)}
      ${rowLine("Sales Tax", -sold.sales_tax, true)}
      ${rowLine("Income Tax", -sold.income_tax, true)}
      <div class="row total"><div class="l">SUB TOTAL (A)</div><div class="r">${fmtPKR(net.A)}</div></div>
    </div>
  `;

  // Refunded block (Laam shows refunded totals often as negatives; we display raw)
  const refundBlock = `
    <div class="block">
      <div class="row muted"><div class="l">Items Refunded</div><div class="r"></div></div>
      ${rowLine("Total Refunds", refunded.realized_sale)}
      ${rowLine("Gross Platform Fee", refunded.platform_fee)}
      ${rowLine("PRA Tax", refunded.pra_tax)}
      ${rowLine("Sales Tax", refunded.sales_tax)}
      ${rowLine("Income Tax", refunded.income_tax)}
      <div class="row total"><div class="l">SUB TOTAL (B)</div><div class="r">${fmtPKR(net.B)}</div></div>
    </div>
  `;

  // Adjustments block only if present
  const adjBlock = net.hasD ? `
    <div class="block">
      <div class="row muted"><div class="l">Adjustments</div><div class="r"></div></div>
      ${rowLine("Adjustments (net)", adj.adjustment_amount || 0)}
      <div class="row total"><div class="l">SUB TOTAL (D)</div><div class="r">${fmtPKR(net.D)}</div></div>
    </div>
  ` : "";

  const netLabel = net.hasD ? "Net Payable (A + B + D)" : "Net Payable (A + B)";

  return soldBlock + refundBlock + adjBlock + `
    <div class="block">
      <div class="row total"><div class="l">${netLabel}</div><div class="r">${fmtPKR(net.net)}</div></div>
    </div>
  `;
}

// If isDeductionDisplay=true we keep the number as-is but you can pass negative to show (PKR x)
function rowLine(label, amount){
  return `<div class="row"><div class="l">${label}</div><div class="r">${fmtPKR(amount)}</div></div>`;
}

// =====================
// Details table
// =====================
function renderDetailsTable(summary){
  const lines = [];

  function push(file, side, bucket, obj){
    lines.push({
      file, side, bucket,
      realized_sale: obj.realized_sale,
      platform_fee: obj.platform_fee,
      pra_tax: obj.pra_tax,
      sales_tax: obj.sales_tax,
      income_tax: obj.income_tax,
      adjustment_amount: obj.adjustment_amount || 0,
      subtotal: calcSubTotal(obj)
    });
  }

  // Marketplace (if present)
  if (state.parsed.marketplace){
    ["local","international"].forEach(side => {
      ["sold","refunded","adjustment"].forEach(bucket => push("Marketplace", side, bucket, summary.marketplace[side][bucket]));
    });
  }

  // Octane (if present)
  if (state.parsed.octane){
    ["local","international"].forEach(side => {
      ["sold","refunded","adjustment"].forEach(bucket => push("Octane", side, bucket, summary.octane[side][bucket]));
    });
  }

  // Consolidated
  ["local","international"].forEach(side => {
    ["sold","refunded","adjustment"].forEach(bucket => push("Consolidated", side, bucket, summary.consolidated[side][bucket]));
  });

  return `
    <table>
      <thead>
        <tr>
          <th>File</th><th>Side</th><th>Bucket</th>
          <th>Realized</th><th>Platform Fee</th><th>PRA</th><th>Sales Tax</th><th>Income Tax</th><th>Adjustments</th><th>Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${lines.map(x => `
          <tr>
            <td>${x.file}</td>
            <td>${x.side}</td>
            <td>${x.bucket}</td>
            <td>${fmtPKR(x.realized_sale)}</td>
            <td>${fmtPKR(x.platform_fee)}</td>
            <td>${fmtPKR(x.pra_tax)}</td>
            <td>${fmtPKR(x.sales_tax)}</td>
            <td>${fmtPKR(x.income_tax)}</td>
            <td>${fmtPKR(x.adjustment_amount)}</td>
            <td><strong>${fmtPKR(x.subtotal)}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// =====================
// Actions: reset, copy, download
// =====================
function onReset(){
  ["fileMarketplace","fileOctane","fileItemAdj","fileVendorDed"].forEach(id => $(id).value = "");

  state.files = { marketplace:null, octane:null, item_adjustments:null, vendor_deductions:null };
  state.parsed = { marketplace:null, octane:null, item_adjustments:null, vendor_deductions:null };
  state.mappingDraft = {};
  state.pendingMapping = null;
  state.lastSummary = null;

  $("results").classList.add("hidden");
  $("mappingPanel").classList.add("hidden");

  $("btnCopy").disabled = true;
  $("btnDownloadJson").disabled = true;

  setStatus("Reset done.");
}

function onCopy(){
  if (!state.lastSummary) return;

  const s = state.lastSummary;
  const cLoc = calcNetPayable(s.consolidated.local).net;
  const cIntl = calcNetPayable(s.consolidated.international).net;

  const parts = [
    "Laam Ledger Summary",
    state.parsed.marketplace ? "Marketplace: Included" : "Marketplace: Not uploaded",
    state.parsed.octane ? "Octane: Included" : "Octane: Not uploaded",
    `Consolidated Local Net Payable: ${fmtPKR(cLoc)}`,
    `Consolidated International Net Payable: ${fmtPKR(cIntl)}`,
    `Consolidated Total Net Payable: ${fmtPKR(cLoc + cIntl)}`
  ];

  navigator.clipboard.writeText(parts.join("\n"))
    .then(() => setStatus("Summary copied to clipboard."))
    .catch(() => setStatus("Copy failed (browser permissions)."));
}

function onDownloadJson(){
  if (!state.lastSummary) return;

  const blob = new Blob([JSON.stringify(state.lastSummary, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "laam-summary.json";
  a.click();

  URL.revokeObjectURL(url);
}
