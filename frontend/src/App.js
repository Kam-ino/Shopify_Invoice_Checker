import "./App.css";
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import axios from "axios";
import Table from "./components/table";
import * as XLSX from "xlsx-js-style";
import ShopifyTable from "./components/ShopifyTable";

const API_BASE = (process.env.REACT_APP_API_BASE || "https://shopify-invoice-checker-backend.onrender.com").replace(/\/+$/, "");

/* ---------------- Existing helpers ---------------- */

function parsePrice(val) {
  if (val === null || val === undefined || val === "") return NaN;
  if (typeof val === "number") return val;
  let s = String(val).trim();
  ["US$", "$", "€", "EUR"].forEach((p) => {
    if (s.startsWith(p)) s = s.slice(p.length);
  });
  const num = Number(s);
  return isNaN(num) ? NaN : num;
}

// ✅ Base known columns (we will extend dynamically from Quotation/Prices file)
const BASE_COUNTRY_COLUMNS = {
  FR: { total: "Total to FR", upsell: "Upsell to FR" },
  BE: { total: "Total to BE", upsell: "Upsell to BE" },
  CH: { total: "Total to CH", upsell: "Upsell to CH" },
  CA: { total: "Total to CA", upsell: "Upsell to CA" },
  CZ: { total: "Total to CZ", upsell: "Upsell to CZ" },
  SK: { total: "Total to SK", upsell: "Upsell to SK" },
  RO: { total: "Total to RO", upsell: "Upsell to RO" },
  ES: { total: "Total to ES", upsell: "Upsell to ES" },
  IT: { total: "Total to IT", upsell: "Upsell to IT" },
  GR: { total: "Total to GR", upsell: "Upsell to GR" },
  PL: { total: "Total to GR", upsell: "Upsell to PL" },
  GB: { total: "Total to GB", upsell: "Upsell to GB" },
  "GB-remote area": { total: "Total to GB-remote area", upsell: "Upsell to GB-remote area" },
  US: { total: "Total to US", upsell: "Upsell to US" },
  PT: { total: "Total to GR", upsell: "Upsell to GR" },
  DE: { total: "Total to DE", upsell: "Upsell to DE" },
  "AU-1": { total: "Total to AU-1", upsell: "Upsell to AU-1" },
  "AU-2": { total: "Total to AU-2", upsell: "Upsell to AU-2" },
  "AU-3": { total: "Total to AU-3", upsell: "Upsell to AU-3" },
  "AU-4": { total: "Total to AU-4", upsell: "Upsell to AU-4" },
  NZ: { total: "Total to NZ", upsell: "Upsell to NZ" },
  MA: { total: "Total to MA", upsell: "Upsell to MA" },
  ZA: { total: "Total to ZA", upsell: "Upsell to ZA" },
  AE: { total: "Total to AE", upsell: "Upsell to AE" },
  MT: { total: "Total to MT", upsell: "Upsell to MT" },
  SE: { total: "Total to SE", upsell: "Upsell to SE" },
  MX: { total: "Total to MX", upsell: "Upsell to MX" },
  EG: { total: "Total to EG", upsell: "Upsell to EG" },
  AT: { total: "Total to AT", upsell: "Upsell to AT" },
  DK: { total: "Total to DK", upsell: "Upsell to DK" },
  FI: { total: "Total to FI", upsell: "Upsell to FI" },
  SI: { total: "Total to SI", upsell: "Upsell to SI" },
  BR: { total: "Total to BR", upsell: "Upsell to BR" },
  LT: { total: "Total to LT", upsell: "Upsell to LT" },
  NL: { total: "Total to NL", upsell: "Upsell to NL" },
  IL: { total: "Total to IL", upsell: "Upsell to IL" },
  MY: { total: "Total to MY", upsell: "Upsell to MY" },
  LV: { total: "Total to LV", upsell: "Upsell to LV" },
  "MX-tax included": { total: "Total to MX-tax included", upsell: "Upsell to MX-tax included" },
  BG: { total: "Total to BG", upsell: "Upsell to BG" },
  CO: { total: "Total to CO", upsell: "Upsell to CO" },
  EE: { total: "Total to EE", upsell: "Upsell to EE" },
  IN: { total: "Total to IN", upsell: "Upsell to IN" },
  BH: { total: "Total to BH", upsell: "Upsell to BH" },
  HR: { total: "Total to HR", upsell: "Upsell to HR" },
  QA: { total: "Total to QA", upsell: "Upsell to QA" },
  IE: { total: "Total to IE", upsell: "Upsell to IE" },
};

function normalizeSkuBase(raw) {
  const s = String(raw || "").trim();

  // take only the first token before variant separators
  const first = s.split(/[\s\-/_]/)[0]; // "ce001-black/l" -> "ce001"

  // keep leading letters+digits with optional trailing letter (CE001A)
  const m = first.match(/^([A-Z]+)(\d+)([A-Z])?$/i);
  if (!m) return first.toUpperCase();

  return `${m[1]}${m[2]}${m[3] || ""}`.toUpperCase();
}


function sheetRowsToObjects(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!aoa || aoa.length < 2) return { rows: [], columns: [] };

  const rawHeaders = (aoa[0] || []).map((h) => (h === null || h === undefined ? "" : String(h)));
  const columns = rawHeaders.map((h, i) => (String(h).trim() ? String(h) : `Column ${i + 1}`));

  // make duplicate headers unique
  const counts = new Map();
  const uniqueCols = columns.map((c) => {
    const key = String(c);
    const n = counts.get(key) || 0;
    counts.set(key, n + 1);
    return n === 0 ? key : `${key}.${n}`;
  });

  const rows = aoa.slice(1).map((rowArr) => {
    const obj = {};
    uniqueCols.forEach((col, i) => {
      obj[col] = rowArr[i];
    });
    return obj;
  });

  return { rows, columns: uniqueCols };
}

function getSheetNameInsensitive(workbook, wantedName) {
  const wanted = String(wantedName || "").trim().toLowerCase();
  const names = workbook?.SheetNames || [];
  return names.find((n) => String(n).trim().toLowerCase() === wanted) || null;
}

function deriveCountryColumnsFromQuotationColumns(columns) {
  // Detect columns like "Total to XX" and "Upsell to XX" (quotation file often contains line breaks).
  const map = {};
  (columns || []).forEach((col) => {
    const orig = String(col || "");
    const norm = orig.replace(/\s+/g, " ").trim(); // collapse newlines/spaces

    const mTotal = norm.match(/^Total\s+to\s+([A-Z]{2})\b/i);
    if (mTotal) {
      const cc = mTotal[1].toUpperCase();
      map[cc] = map[cc] || {};
      map[cc].total = orig; // keep exact header as the row key
      return;
    }
    const mUpsell = norm.match(/^Upsell\s+to\s+([A-Z]{2})\b/i);
    if (mUpsell) {
      const cc = mUpsell[1].toUpperCase();
      map[cc] = map[cc] || {};
      map[cc].upsell = orig; // keep exact header as the row key
      return;
    }
  });

  // Ensure both keys exist if one is present
  Object.keys(map).forEach((cc) => {
    map[cc].total = map[cc].total || `Total to ${cc}`;
    map[cc].upsell = map[cc].upsell || `Upsell to ${cc}`;
  });

  return map;
}

function buildPriceIndex(pricesRows) {
  const index = {};
  if (!pricesRows) return index;

  pricesRows.forEach((row) => {
    const sku = row["SKU"];
    const qtyRaw = row["QTY"];
    const qty = qtyRaw === "" || qtyRaw === null || qtyRaw === undefined ? 1 : Number(qtyRaw || 0);
    if (!sku || !qty) return;

    if (!index[sku]) index[sku] = {};
    index[sku][qty] = row;
  });

  return index;
}

// function groupByOrder(ordersRows) {
//   const map = {};
//   if (!ordersRows) return map;

//   // Drop identical rows duplicated across sheets (common in multi-sheet exports)
//   const DEDUPE_COLS = ["Store", "Order#", "Country", "Tracking", "Carrier", "Item", "SKU.1", "SKU", "QTY", "Cost", "Upsell", "Total"];
//   const seen = new Map(); // orderNo -> Set(dedupeKey)

//   ordersRows.forEach((row) => {
//     const orderNo = row["Order#"];
//     if (!orderNo) return;

//     const key = DEDUPE_COLS.map((c) =>
//       String(row?.[c] ?? "").trim().replace(/\s+/g, " ")
//     ).join("||");

//     if (!seen.has(orderNo)) seen.set(orderNo, new Set());
//     const set = seen.get(orderNo);

//     if (set.has(key)) return; // ✅ duplicate (same order, same row values)
//     set.add(key);

//     if (!map[orderNo]) map[orderNo] = [];
//     map[orderNo].push(row);
//   });

//   return map;
// }


function computeOrderResult(orderRows, priceIndexDefault, priceIndexQty1to5, countryColumnsMap) {
  if (!orderRows || orderRows.length === 0) return null;

  const orderNo = orderRows[0]["Order#"];

  const countryRow = orderRows.find((r) => r["Country"] && String(r["Country"]).trim() !== "") || null;
  const country = countryRow ? String(countryRow["Country"]).trim() : null;

  // NOTE:
  // We intentionally compute totals per *row* (not aggregated per order/SKU/qty lookups).
  // This avoids false mismatches when the same order number appears across multiple rows.
  // (priceIndexDefault/priceIndexQty1to5/countryColumnsMap remain in the signature to avoid
  // wider refactors, but are no longer used for the invoice total calculation.)

  let baseTotal = 0;
  let upsellTotal = 0;

  for (const row of orderRows) {
    const cost = parsePrice(row?.["Cost"]);
    const upsell = parsePrice(row?.["Upsell"]);

    if (!isNaN(cost) && cost > 0) baseTotal += cost;
    if (!isNaN(upsell) && upsell > 0) upsellTotal += upsell;
  }

  const expectedTotal = (isNaN(baseTotal) ? 0 : baseTotal) + (isNaN(upsellTotal) ? 0 : upsellTotal);

  const totals = [];
  orderRows.forEach((r) => {
    const v = parsePrice(r["Total"]);
    if (!isNaN(v) && v > 0) totals.push(v);
  });

  // Total column can be either:
  //  - the order total repeated on every row, OR
  //  - a per-line total.
  // Pick whichever (max vs sum) is closer to the computed expected total.
  const uniq = Array.from(new Set(totals.map((x) => Number(x.toFixed(6)))));
  const candidateMax = totals.length ? Math.max(...totals) : NaN;
  const candidateSum = totals.length ? totals.reduce((a, b) => a + b, 0) : NaN;

  let reportedTotal = NaN;
  if (uniq.length === 0) {
    reportedTotal = NaN;
  } else if (uniq.length === 1) {
    // repeated order total
    reportedTotal = uniq[0];
  } else if (!isNaN(expectedTotal)) {
    // choose the candidate that best matches expectedTotal
    const dMax = isNaN(candidateMax) ? Number.POSITIVE_INFINITY : Math.abs(candidateMax - expectedTotal);
    const dSum = isNaN(candidateSum) ? Number.POSITIVE_INFINITY : Math.abs(candidateSum - expectedTotal);
    reportedTotal = dSum <= dMax ? candidateSum : candidateMax;
  } else {
    // fallback
    reportedTotal = candidateSum;
  }

  const difference = !isNaN(expectedTotal) && !isNaN(reportedTotal) ? reportedTotal - expectedTotal : NaN;
  const status = isNaN(difference) || Math.abs(difference) <= 0.01 ? "ok" : "mismatch";

  return {
    order: orderNo,
    country,
    baseTotal,
    upsellTotal,
    expectedTotal,
    reportedTotal,
    difference,
    status,
    detail: "",
  };
}

const sortResultsByOrder = (list, dir) => {
  const getOrderNumber = (val) => {
    const s = String(val ?? "");
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : 0;
  };

  const copy = [...list];
  copy.sort((a, b) => {
    const numA = getOrderNumber(a.order);
    const numB = getOrderNumber(b.order);
    return dir === "asc" ? numA - numB : numB - numA;
  });
  return copy;
};

/* ---------------- Shopify vs Tracking comparison helpers ---------------- */

const normText = (v) =>
  String(v ?? "")
    .trim()
    .replace(/\s+/g, " ");

const normOrderKey = (v) => {
  const m = String(v ?? "").match(/\d+/);
  return m ? m[0] : "";
};

const findColumn = (columns, candidates) => {
  if (!columns?.length) return null;
  const lowerCols = columns.map((c) => String(c).toLowerCase());
  for (const cand of candidates) {
    const idx = lowerCols.indexOf(String(cand).toLowerCase());
    if (idx >= 0) return columns[idx];
  }
  return null;
};

const splitItemAndVariant = (raw) => {
  let s = normText(raw);
  if (!s) return { item: "", variant: "" };

  const m = s.match(/^([1-9])\s+(.*)$/);
  if (m) s = m[2];

  const idx = s.lastIndexOf(" - ");
  if (idx === -1) return { item: s, variant: "" };

  return {
    item: s.slice(0, idx).trim(),
    variant: s.slice(idx + 3).trim(),
  };
};

// ✅ canonicalizer for title comparisons (diacritics/™/dashes/brand suffix)
// const canonTitle = (s) => {
//   let t = normText(s)
//     .normalize("NFD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/[™®©]/g, "")
//     .replace(/[–—]/g, "-")
//     .trim();

//   // remove common branding suffix patterns
//   t = t.replace(/\s*-\s*cellumove\s*$/i, "").trim();

//   return t.toLowerCase();
// };

// const canonProductBase = (s) => {
//   let t = normText(s)
//     .normalize("NFD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/[™®©]/g, "")
//     .replace(/[–—]/g, "-")
//     .trim();

//   // keep only base before marketing tagline
//   t = t.split(/\s-\s/)[0].trim();

//   // small plural normalization
//   t = t.replace(/\bleggings\b/gi, "legging");
//   t = t.replace(/\bsleeves\b/gi, "sleeve");

//   return t.toLowerCase();
// };


/**
 * ✅ Keep only real "ordered/fulfillable/fulfilled" items; exclude "removed".
 * Uses fulfillableQuantity / fulfillmentStatus if present.
 */
const shouldKeepShopifyLineItem = (node) => {
  if (!node) return false;

  const title = normText(node.title);
  if (!title) return false;

  // exclude E-book always
  const t = title.toLowerCase();
  if (t.includes("e-book") || t.includes("ebook")) return false;

  const qty = Number(node.currentQuantity ?? node.quantity ?? 0) || 0;
  if (qty <= 0) return false;

  const hasFQ = node.fulfillableQuantity !== undefined && node.fulfillableQuantity !== null;
  const hasFS = node.fulfillmentStatus !== undefined && node.fulfillmentStatus !== null;

  if (hasFQ || hasFS) {
    const fq = Number(node.fulfillableQuantity ?? 0) || 0;
    const fs = String(node.fulfillmentStatus ?? "").toUpperCase();
    return fs === "FULFILLED" || fq > 0;
  }

  return true;
};

// Build SKU -> Item name map from quotation sheet rows
// const buildSkuToItemNameMap = (rows) => {
//   const map = new Map();
//   (rows || []).forEach((r) => {
//     const skuRaw = r?.["SKU"] || r?.["Sku"];
//     if (!skuRaw) return;

//     const skuBase = normalizeSkuBase(skuRaw);
//     const name = String(r?.["Item name"] || r?.["Item Name"] || r?.["Item"] || r?.["Name"] || "").trim();
//     if (!name) return;

//     if (!map.has(skuBase)) map.set(skuBase, name);
//   });
//   return map;
// };

// ✅ Invoice signature for Shopify comparison:
// uses Trackings&Costs: Item (SKU-ish) + QTY → maps to Quotation: SKU → Item name
// const buildInvoiceSignatureViaQuotation = (orderRows, columns, skuToNameMap) => {
//   const qtyCol = findColumn(columns, ["QTY", "Quantity"]);
//   const itemCol = findColumn(columns, ["Item", "SKU.1", "SKU"]);
//   if (!qtyCol || !itemCol) return [];

//   const agg = new Map(); // canonProductBase(quotationName) -> qty

//   for (const r of orderRows) {
//     const qty = Number(r?.[qtyCol] ?? 0) || 0;
//     if (qty <= 0) continue;

//     const rawSku = String(r?.[itemCol] ?? "").trim();
//     if (!rawSku) continue;

//     const skuBase = normalizeSkuBase(rawSku);
//     const quotationName = skuToNameMap.get(skuBase) || `unknown sku ${skuBase}`;

//     const key = canonProductBase(quotationName);
//     agg.set(key, (agg.get(key) || 0) + qty);
//   }

//   return Array.from(agg.entries())
//     .map(([k, v]) => `${k}||${v}`)
//     .sort();
// };

/**
 * ✅ Tracking signature:
 * Prefer SKU+QTY if SKU exists.
 * Else use normalized title+QTY.
 */
// const buildTrackingSignature = (orderRows, columns) => {
//   const qtyCol = findColumn(columns, ["QTY", "Quantity"]);
//   const skuCol = findColumn(columns, ["SKU", "Sku", "Variant SKU", "Variant Sku", "SKU.1"]); // include SKU.1
//   const lineItemsCol = findColumn(columns, ["Line Items", "Line Item", "Line items", "Line item"]);

//   const itemNameCol = findColumn(columns, [
//     "Item name",
//     "Item Name",
//     "Product name",
//     "Product Name",
//     "Product",
//     "Name",
//     "Line item name",
//     "Line Item Name",
//     "Item",
//   ]);

//   if (!qtyCol) return [];

//   // ✅ aggregate: key -> summedQty
//   const agg = new Map();

//   for (const r of orderRows) {
//     const qty = Number(r?.[qtyCol] ?? 0) || 0;
//     if (qty <= 0) continue;

//     // Prefer SKU if present
//     const sku = skuCol ? normText(r?.[skuCol]) : "";
//     if (sku) {
//       const key = `sku:${sku.toLowerCase()}`;
//       agg.set(key, (agg.get(key) || 0) + qty);
//       continue;
//     }

//     // Otherwise build a clean item name (strip variant)
//     let item = "";
//     if (itemNameCol) {
//       item = splitItemAndVariant(r?.[itemNameCol]).item; // strips " - Variant"
//     }
//     if (!item && lineItemsCol) {
//       // if Line Items is used, strip variant too
//       item = splitItemAndVariant(r?.[lineItemsCol]).item;
//     }

//     item = normText(item);
//     if (!item) continue;

//     const key = canonTitle(item);
//     agg.set(key, (agg.get(key) || 0) + qty);
//   }

//   const sigs = [];
//   for (const [key, summedQty] of agg.entries()) {
//     sigs.push(`${key}||${summedQty}`);
//   }
//   sigs.sort();
//   return sigs;
// };

/**
 * ✅ Shopify signature:
 * Prefer SKU+QTY if available (node.sku or node.variant.sku).
 * Else use normalized title+QTY.
 */
// const buildShopifySignature = (shopifyOrder) => {
//   const edges = shopifyOrder?.lineItems?.edges ?? [];
//   const agg = new Map();

//   for (const e of edges) {
//     const node = e?.node;
//     if (!shouldKeepShopifyLineItem(node)) continue;

//     const qty = Number(node.currentQuantity ?? node.quantity ?? 0) || 0;
//     if (qty <= 0) continue;

//     const title = normText(node.title);
//     if (!title) continue;

//     const key = canonProductBase(title);
//     agg.set(key, (agg.get(key) || 0) + qty);
//   }

//   return Array.from(agg.entries())
//     .map(([k, v]) => `${k}||${v}`)
//     .sort();
// };

const arraysEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/* ---------------- Multi-sheet parsing + corrections ---------------- */

function sheetToRowsWithMeta(wb) {
  const all = [];

  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets?.[sheetName];
    if (!ws || !ws["!ref"]) continue;

    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!aoa || aoa.length < 2) continue;

    const headerRowIdx = 0;
    const headers = (aoa[headerRowIdx] || []).map((h) => String(h || "").trim());

    const colIndexByName = {};
    headers.forEach((h, i) => {
      if (h) colIndexByName[h] = i;
    });

    for (let r = headerRowIdx + 1; r < aoa.length; r++) {
      const rowArr = aoa[r] || [];
      const isEmpty = rowArr.every((v) => String(v ?? "").trim() === "");
      if (isEmpty) continue;

      const obj = {};
      headers.forEach((h, c) => {
        if (!h) return;
        obj[h] = rowArr[c];
      });

      // ✅ attach meta for precise cell correction later
      obj.__sheet = sheetName;
      obj.__rowIndex = r; // 0-based row index in the worksheet (AOA row)
      obj.__headers = headers;
      obj.__colIndexByName = colIndexByName;

      all.push(obj);
    }
  }

  return all;
}

function getCellAddress(rowObj, colName) {
  const idx = rowObj?.__colIndexByName?.[colName];
  if (idx === undefined || idx === null) return null;
  const r = rowObj.__rowIndex;
  return XLSX.utils.encode_cell({ r, c: idx });
}

function applyCorrectionsToWorkbook(wb, corrections) {
  (corrections || []).forEach((fix) => {
    const ws = wb.Sheets?.[fix.sheetName];
    if (!ws) return;

    const addr = fix.cell;
    if (!addr) return;

    const existing = ws[addr] || {};
    existing.v = fix.value;
    existing.t = typeof fix.value === "number" ? "n" : "s";
    ws[addr] = existing;
  });
}

/* ---------------- Store routing (per row) ---------------- */

function extractCountryFromStoreCell(storeCellValue) {
  const s = String(storeCellValue || "").toUpperCase();

  const paren = s.match(/\(([A-Z]{2})\)/);
  if (paren) return paren[1];

  const tokens = s.split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (last && /^[A-Z]{2}$/.test(last)) return last;

  return null;
}

function inferStoreKeyFromTracking(orderRows, columns, selectedStore) {
  const storeCol = findColumn(columns, ["Store"]);
  const countryCol = findColumn(columns, ["Country", "Ship Country", "Shipping Country"]);

  const storeRaw = storeCol ? orderRows.find((r) => r?.[storeCol])?.[storeCol] : null;
  const storeText = String(storeRaw || "").toLowerCase();

  // If the sheet is for non-cellumove brands, route accordingly
  if (storeText.includes("bloomommy")) return "bloomommy";
  if (storeText.includes("yuma")) return "yuma";

  // Cellumove mapping by country
  if (storeText.includes("cellumove") || storeText.includes("cellu")) {
    const map = {
      UK: "cellumove",
      DE: "cellumove_de",
      CZ: "cellumove_cz",
      ES: "cellumove_es",
      FR: "cellumove_fr",
      GR: "cellumove_gr",
      MX: "cellumove_mx",
      PL: "cellumove_pl",
      PT: "cellumove_pt",
      RO: "cellumove_ro",
    };

    // ✅ 1) Prefer explicit country in Store cell (e.g. "(DE)")
    const ccFromStore = extractCountryFromStoreCell(storeRaw);
    if (ccFromStore && map[ccFromStore]) return map[ccFromStore];

    // ✅ 2) Fallback: destination Country column
    if (countryCol) {
      const ccFromCountry = String(orderRows.find((r) => r?.[countryCol])?.[countryCol] || "").toUpperCase().trim();
      if (ccFromCountry && map[ccFromCountry]) return map[ccFromCountry];
    }

    // ✅ 3) Last fallback
    return "cellumove";
  }

  // Fallback: selected store from dropdown
  return selectedStore || "";
}

/* ---------------- App ---------------- */

function App() {
  const [ordersFile, setOrdersFile] = useState(null);
  const [pricesFile, setPricesFile] = useState(null);

  // ✅ multi-sheet flattened tracking rows
  const [trackingAllRows, setTrackingAllRows] = useState([]);
  const [trackingAllColumnsGuess, setTrackingAllColumnsGuess] = useState([]);

  // ✅ keep original tracking workbook bytes for precise correction download
  const [trackingArrayBuffer, setTrackingArrayBuffer] = useState(null);

  const [results, setResults] = useState([]);
  const [message, setMessage] = useState("");
  const [resultsSortDir, setResultsSortDir] = useState("asc");

  // ✅ corrections to apply on download
  const [cellCorrections, setCellCorrections] = useState([]);
  // const [expandedOrder, setExpandedOrder] = useState(null);

  // ✅ side-by-side compare toggle
  const [compareShowAllRows, setCompareShowAllRows] = useState(false);

  // Shopify
  const [selectedStore, setSelectedStore] = useState("");
  const [shopifyLoading, setShopifyLoading] = useState(false);
  const [shopifyError, setShopifyError] = useState("");
  const [orders, setOrders] = useState([]);

  // Stores list (dynamic)
  const [availableStores, setAvailableStores] = useState([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesError, setStoresError] = useState("");

  const [orderSearch, setOrderSearch] = useState("");

  // ✅ cache Shopify orders per storeKey for cross-store comparisons
  const shopifyCacheRef = useRef(new Map()); // storeKey -> { filteredOrders, byNum }
  const shopifyFetchPromiseRef = useRef(new Map()); // storeKey -> Promise

  const getDigits = (v) => {
    const m = String(v ?? "").match(/\d+/);
    return m ? m[0] : "";
  };

  const orderSearchNum = useMemo(() => getDigits(orderSearch), [orderSearch]);

  // ✅ dynamic country columns map from quotation/prices file columns
  const countryColumnsMap = useMemo(() => {
    const fromQuote = deriveCountryColumnsFromQuotationColumns(pricesFile?.columns || []);
    return { ...BASE_COUNTRY_COLUMNS, ...fromQuote };
  }, [pricesFile?.columns]);

  // ✅ Filter Shopify orders once so ALL UI uses clean data (no removed items, no E-book)
  const filteredShopifyOrders = useMemo(() => {
    return (orders || []).map((o) => {
      const edges = o?.lineItems?.edges ?? [];
      const filteredEdges = edges.filter((e) => shouldKeepShopifyLineItem(e?.node));
      return { ...o, lineItems: { edges: filteredEdges } };
    });
  }, [orders]);

  // Seed cache for currently selected store
  useEffect(() => {
    if (!selectedStore) return;
    const byNum = {};
    (filteredShopifyOrders || []).forEach((o) => {
      const k = normOrderKey(o?.name);
      if (k && !byNum[k]) byNum[k] = o;
    });
    shopifyCacheRef.current.set(selectedStore, { filteredOrders: filteredShopifyOrders || [], byNum });
  }, [selectedStore, filteredShopifyOrders]);

  const shopifyOrder = useMemo(() => {
    if (!orderSearchNum) return null;
    return (filteredShopifyOrders || []).find((o) => getDigits(o?.name) === orderSearchNum) || null;
  }, [filteredShopifyOrders, orderSearchNum]);

  const shopifyDisplay = useMemo(() => {
    if (!shopifyOrder) return null;

    const edges = shopifyOrder?.lineItems?.edges ?? [];
    const filtered = edges.map((e) => e?.node).filter(Boolean);

    const lineItems = filtered.map((n) => n.title || "N/A");
    const quantities = filtered.map((n) => n?.currentQuantity ?? n?.quantity ?? "N/A");

    const customer = shopifyOrder?.customer
      ? `${shopifyOrder.customer.firstName ?? ""} ${shopifyOrder.customer.lastName ?? ""}`.trim() ||
        shopifyOrder.customer.email ||
        "N/A"
      : "N/A";

    const country = shopifyOrder?.billingAddress?.country ?? "N/A";

    return { customer, country, lineItems, quantities };
  }, [shopifyOrder]);

  // ✅ invoice display should search across ALL sheets
  const invoiceDisplay = useMemo(() => {
    if (!orderSearchNum) return null;

    const rowsSource = trackingAllRows?.length ? trackingAllRows : ordersFile?.rows || [];
    if (!rowsSource || rowsSource.length === 0) return null;

    const cols =
      (rowsSource[0]?.__headers && rowsSource[0].__headers) ||
      ordersFile?.columns ||
      Object.keys(rowsSource[0] || {});

    const orderCol = findColumn(cols, ["Order#", "Order #", "Order Number", "Order"]);
    if (!orderCol) return null;

    const rows = rowsSource.filter((r) => getDigits(r?.[orderCol]) === orderSearchNum);
    if (rows.length === 0) return null;

    const countryCol = findColumn(cols, ["Country", "Ship Country", "Shipping Country"]);
    const trackingCol = findColumn(cols, ["Tracking", "Tracking #", "Tracking Number"]);

    const qtyCol = findColumn(cols, ["QTY", "Quantity"]);
    const variantCol = findColumn(cols, ["Variant"]);
    const lineItemsCol = findColumn(cols, ["Line Items"]);
    const itemNameCol = findColumn(cols, ["Item name", "Item Name", "Product name", "Product Name", "Product", "Name", "Item"]);

    const country = countryCol ? rows.find((r) => r?.[countryCol])?.[countryCol] ?? "" : "";
    const tracking = trackingCol ? rows.find((r) => r?.[trackingCol])?.[trackingCol] ?? "" : "";

    // Aggregate identical items (and sum quantities) so invoice display matches Shopify-style aggregation
    const skuCol = findColumn(cols, ["SKU", "Sku", "Variant SKU", "Variant Sku", "SKU.1"]);
    const itemsMap = new Map(); // key -> { name, qty, skus: Set }

    rows.forEach((r) => {
      const q = qtyCol ? Number(r?.[qtyCol] ?? 0) || 0 : 0;
      if (q <= 0) return; // ignore zero-qty rows

      let item = lineItemsCol ? normText(r?.[lineItemsCol]) : "";
      let variant = variantCol ? normText(r?.[variantCol]) : "";

      if ((!item || !variant) && itemNameCol) {
        const sp = splitItemAndVariant(r?.[itemNameCol]);
        if (!item) item = sp.item;
        if (!variant) variant = sp.variant;
      }

      if (itemNameCol && String(itemNameCol).toLowerCase() === "item" && item && /^[A-Z]{2,}\d{2,}$/i.test(item) && item.length <= 10) {
        item = "";
      }

      const skuRaw = skuCol ? normText(r?.[skuCol]) : "";
      const sku = skuRaw ? normalizeSkuBase(skuRaw) : "";

      if (!item && !sku) return;

      const key = variant ? `${item}||${variant}` : (item || `sku:${sku}`);
      const prev = itemsMap.get(key) || { name: item || `sku:${sku}`, qty: 0, skus: new Set() };
      prev.qty += q;
      if (sku) prev.skus.add(sku);
      itemsMap.set(key, prev);
    });

    const lineItems = Array.from(itemsMap.values()).map((v) => ({ name: v.name, qty: v.qty, skus: Array.from(v.skus) }));
    const quantities = lineItems.map((v) => v.qty);

    return {
      order: `#${orderSearchNum}`,
      country: normText(country),
      tracking: normText(tracking),
      lineItems,
      quantities,
    };
  }, [ordersFile, trackingAllRows, orderSearchNum]);

  useEffect(() => {
    if (shopifyLoading) document.body.classList.add("no-scroll");
    else document.body.classList.remove("no-scroll");
    return () => document.body.classList.remove("no-scroll");
  }, [shopifyLoading]);

  // Load stores from backend
  const fetchStores = useCallback(async () => {
    setStoresLoading(true);
    setStoresError("");

    try {
      const resp = await axios.get(`${API_BASE}/api/stores`);
      const stores = Array.isArray(resp.data?.stores) ? resp.data.stores : [];
      setAvailableStores(stores);

      if (!selectedStore && stores.length > 0) setSelectedStore(stores[0].storeKey);

      if (selectedStore && stores.length > 0) {
        const stillExists = stores.some((s) => s.storeKey === selectedStore);
        if (!stillExists) setSelectedStore(stores[0].storeKey);
      }
    } catch (err) {
      console.error("Error fetching stores:", err);
      setAvailableStores([]);
      setStoresError(err?.response?.data?.error || "Failed to load stores list from /api/stores.");
      if (!selectedStore) setSelectedStore("bloomommy");
    } finally {
      setStoresLoading(false);
    }
  }, [selectedStore]);

  useEffect(() => {
    fetchStores();
  }, [fetchStores]);

  // Fetch Shopify orders for selected storeKey
  useEffect(() => {
    const fetchOrders = async () => {
      if (!selectedStore) return;

      setShopifyLoading(true);
      setShopifyError("");

      try {
        const response = await axios.get(`${API_BASE}/api/orders`, {
          params: { store: selectedStore, all: true },
        });

        const apiOrders = response.data?.orders;
        setOrders(Array.isArray(apiOrders) ? apiOrders : []);
      } catch (err) {
        console.error("Error fetching orders:", err);
        setOrders([]);
        setShopifyError(err?.response?.data?.error || "Failed to load Shopify orders (check API server).");
      } finally {
        setShopifyLoading(false);
      }
    };

    fetchOrders();
  }, [selectedStore]);

  // ✅ When ORDER TRACKING & COSTS file changes, parse ALL sheets if possible
  useEffect(() => {
    const parseMultiSheetTracking = async () => {
      try {
        const maybeFile = ordersFile?.file || ordersFile?.rawFile || null;
        const maybeArrayBuffer = ordersFile?.arrayBuffer || ordersFile?.rawArrayBuffer || null;

        let ab = null;

        if (maybeArrayBuffer instanceof ArrayBuffer) ab = maybeArrayBuffer;
        else if (maybeFile && typeof maybeFile.arrayBuffer === "function") ab = await maybeFile.arrayBuffer();

        if (!ab) {
          const fallback = Array.isArray(ordersFile?.rows) ? ordersFile.rows : [];
          setTrackingAllRows(fallback);
          setTrackingAllColumnsGuess(ordersFile?.columns || (fallback[0] ? Object.keys(fallback[0]) : []));
          setTrackingArrayBuffer(null);
          return;
        }

        setTrackingArrayBuffer(ab);

        const wb = XLSX.read(ab, { type: "array" });
        const allRows = sheetToRowsWithMeta(wb);

        // ✅ Per-row Total = Cost + Upsell (NO summing across multiple rows)
        const allRowsWithRowTotal = allRows.map((r) => {
          const cost = parsePrice(r?.["Cost"]);
          const upsell = parsePrice(r?.["Upsell"]);

          // If neither exists, keep row unchanged
          if (isNaN(cost) && isNaN(upsell)) return r;

          const rowTotal = (isNaN(cost) ? 0 : cost) + (isNaN(upsell) ? 0 : upsell);
          return { ...r, Total: rowTotal };
        });

        setTrackingAllRows(allRowsWithRowTotal);

        const colsGuess =
          allRows.find((r) => Array.isArray(r.__headers) && r.__headers.length > 0)?.__headers ||
          ordersFile?.columns ||
          (allRows[0] ? Object.keys(allRows[0]).filter((k) => !k.startsWith("__")) : []);
        setTrackingAllColumnsGuess(colsGuess);
      } catch (e) {
        console.error("Failed multi-sheet parse:", e);
        const fallback = Array.isArray(ordersFile?.rows) ? ordersFile.rows : [];
        setTrackingAllRows(fallback);
        setTrackingAllColumnsGuess(ordersFile?.columns || (fallback[0] ? Object.keys(fallback[0]) : []));
        setTrackingArrayBuffer(null);
      }
    };

    if (ordersFile) parseMultiSheetTracking();
    else {
      setTrackingAllRows([]);
      setTrackingAllColumnsGuess([]);
      setTrackingArrayBuffer(null);
    }
  }, [ordersFile]);

  // ✅ Auto-select store inferred from uploaded tracking file (e.g., choose "cellumove" when detected)
  useEffect(() => {
    if (!ordersFile) return;

    try {
      const rowsSource = trackingAllRows?.length ? trackingAllRows : ordersFile?.rows || [];
      if (!rowsSource || rowsSource.length === 0) return;

      const cols =
        (rowsSource[0]?.__headers && rowsSource[0].__headers) || ordersFile?.columns || trackingAllColumnsGuess ||
        (rowsSource[0] ? Object.keys(rowsSource[0]).filter((k) => !k.startsWith("__")) : []);

      const inferred = inferStoreKeyFromTracking(rowsSource, cols, selectedStore);
      if (!inferred) return;

      // If the inferred store exists in the fetched stores list, prefer it.
      if (availableStores && availableStores.some((s) => s.storeKey === inferred)) {
        if (inferred !== selectedStore) setSelectedStore(inferred);
        return;
      }

      // Otherwise, prefer cellumove family when detected (even if not present in availableStores yet)
      if (String(inferred).toLowerCase().startsWith("cellumove") && inferred !== selectedStore) {
        setSelectedStore(inferred);
      }
    } catch (e) {
      console.error("Auto-select store from uploaded trackings file failed:", e);
    }
  }, [ordersFile, trackingAllRows, trackingAllColumnsGuess, availableStores, selectedStore]);

  // ✅ Ensure Shopify store cache is available for comparisons even when NOT selected in dropdown
  const ensureShopifyStoreLoaded = useCallback(async (storeKey) => {
    if (!storeKey) return { filteredOrders: [], byNum: {} };

    const cached = shopifyCacheRef.current.get(storeKey);
    if (cached) return cached;

    const pending = shopifyFetchPromiseRef.current.get(storeKey);
    if (pending) return await pending;

    const p = (async () => {
      const response = await axios.get(`${API_BASE}/api/orders`, {
        params: { store: storeKey, all: true },
      });

      const apiOrders = Array.isArray(response.data?.orders) ? response.data.orders : [];

      const filteredOrders = (apiOrders || []).map((o) => {
        const edges = o?.lineItems?.edges ?? [];
        const filteredEdges = edges.filter((e) => shouldKeepShopifyLineItem(e?.node));
        return { ...o, lineItems: { edges: filteredEdges } };
      });

      const byNum = {};
      (filteredOrders || []).forEach((o) => {
        const k = normOrderKey(o?.name);
        if (k && !byNum[k]) byNum[k] = o;
      });

      const packed = { filteredOrders, byNum };
      shopifyCacheRef.current.set(storeKey, packed);
      return packed;
    })();

    shopifyFetchPromiseRef.current.set(storeKey, p);

    try {
      const out = await p;
      return out;
    } finally {
      shopifyFetchPromiseRef.current.delete(storeKey);
    }
  }, []);

const handleRunCheck = async () => {
  const trackingRows = trackingAllRows?.length ? trackingAllRows : ordersFile?.rows || [];
  const quotationRows = pricesFile?.rows || [];

  if (!trackingRows || trackingRows.length === 0 || !quotationRows || quotationRows.length === 0) {
    setMessage("Please upload both Orders tracking & costs and prices (quotation) files.");
    setResults([]);
    setCellCorrections([]);
    return;
  }

  setShopifyLoading(true);
  setShopifyError("");
  setMessage("");

  // ---------- Local helpers (scoped to this run) ----------

  // Canonicalize to a "base product name" so taglines don't break equality
  const canonProductBase = (s) => {
    let t = normText(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[™®©]/g, "")
      .replace(/[–—]/g, "-")
      .trim();

    // Remove marketing taglines after " - "
    t = t.split(/\s-\s/)[0].trim();

    // Light normalization to reduce false mismatches
    t = t.replace(/\bleggings\b/gi, "legging");
    t = t.replace(/\bsleeves\b/gi, "sleeve");

    return t.toLowerCase();
  };

  // Build SKU(base) -> Quotation Item name map
  const buildSkuToItemNameMap = (rows) => {
    const map = new Map();
    if (!Array.isArray(rows)) return map;

    const pick = (r, keys) => {
      for (const k of keys) {
        const v = r?.[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return v;
      }
      return "";
    };

    rows.forEach((r) => {
      const skuRaw = pick(r, ["SKU", "Sku", "sku"]);
      if (!skuRaw) return;

      const skuBase = normalizeSkuBase(skuRaw);

      const nameRaw = pick(r, ["Item name", "Item Name", "Item", "Name"]);
      const name = String(nameRaw || "").trim();
      if (!name) return;

      // First one wins (avoid noisy overwrites)
      if (!map.has(skuBase)) map.set(skuBase, name);
    });

    return map;
  };

  // Invoice signature: Trackings Item(SKU-ish) -> Quotation name -> base-name key || qty
  const buildInvoiceSigViaQuotation = (orderRows, columns, skuToNameMap) => {
    const qtyCol = findColumn(columns, ["QTY", "Quantity"]);
    const itemCol = findColumn(columns, ["Item", "SKU.1", "SKU"]);
    if (!qtyCol || !itemCol) return [];

    const agg = new Map(); // baseName -> summedQty

    for (const r of orderRows) {
      const qty = Number(r?.[qtyCol] ?? 0) || 0;
      if (qty <= 0) continue;

      const raw = String(r?.[itemCol] ?? "").trim();
      if (!raw) continue;

      const skuBase = normalizeSkuBase(raw);
      const quotationName = skuToNameMap.get(skuBase) || skuBase; // fallback to SKU if unmapped

      const key = canonProductBase(quotationName);
      agg.set(key, (agg.get(key) || 0) + qty);
    }

    return Array.from(agg.entries())
      .map(([k, v]) => `${k}||${v}`)
      .sort();
  };

  // Shopify signature: base-name key || qty (no SKU)
  const buildShopifySigByBaseName = (shopifyOrder) => {
    const edges = shopifyOrder?.lineItems?.edges ?? [];
    const agg = new Map(); // baseName -> summedQty

    for (const e of edges) {
      const node = e?.node;
      if (!shouldKeepShopifyLineItem(node)) continue;

      const qty = Number(node.currentQuantity ?? node.quantity ?? 0) || 0;
      if (qty <= 0) continue;

      const title = normText(node.title);
      if (!title) continue;

      const key = canonProductBase(title);
      agg.set(key, (agg.get(key) || 0) + qty);
    }

    return Array.from(agg.entries())
      .map(([k, v]) => `${k}||${v}`)
      .sort();
  };

  // Dedupe duplicate rows across sheets before grouping by Order#
  const groupByOrderDeduped = (rows) => {
    const map = {};
    const seenByOrder = new Map(); // orderNo -> Set(dedupeKey)

    const DEDUPE_COLS = [
      "Store",
      "Order#",
      "Country",
      "Tracking",
      "Carrier",
      "Item",
      "SKU.1",
      "SKU",
      "QTY",
      "Cost",
      "Upsell",
      "Total",
    ];

    for (const r of rows || []) {
      const orderNo = r?.["Order#"];
      if (!orderNo) continue;

      const key = DEDUPE_COLS.map((c) => String(r?.[c] ?? "").trim().replace(/\s+/g, " ")).join("||");

      if (!seenByOrder.has(orderNo)) seenByOrder.set(orderNo, new Set());
      const set = seenByOrder.get(orderNo);

      if (set.has(key)) continue; // duplicate row copy
      set.add(key);

      if (!map[orderNo]) map[orderNo] = [];
      map[orderNo].push(r);
    }

    return map;
  };

  try {
    // ---- Build quotation indexes from workbook (supports multiple sheets + newline headers) ----
    let priceIndexDefault = {};
    let priceIndexQty1to5 = {};
    let effectiveCountryColumnsMap = countryColumnsMap;

    // ✅ NEW: SKU -> Quotation item name map
    let skuToNameMap = new Map();

    try {
      const quotationAB =
        pricesFile?.arrayBuffer ||
        (pricesFile?.file && (await pricesFile.file.arrayBuffer())) ||
        null;

      if (quotationAB) {
        const qwb = XLSX.read(quotationAB, { type: "array" });
        const defaultSheetName =
          getSheetNameInsensitive(qwb, "Quotation") ||
          (qwb.SheetNames && qwb.SheetNames[0]);

        const qty1to5SheetName = getSheetNameInsensitive(qwb, "QTY=1-5");

        const defaultWS = defaultSheetName ? qwb.Sheets[defaultSheetName] : null;
        const qtyWS = qty1to5SheetName ? qwb.Sheets[qty1to5SheetName] : null;

        const { rows: defaultRows, columns: defaultCols } = defaultWS
          ? sheetRowsToObjects(defaultWS)
          : { rows: [], columns: [] };
        const { rows: qtyRows, columns: qtyCols } = qtyWS
          ? sheetRowsToObjects(qtyWS)
          : { rows: [], columns: [] };

        priceIndexDefault = buildPriceIndex(defaultRows);
        priceIndexQty1to5 = buildPriceIndex(qtyRows);

        const unionCols = Array.from(new Set([...(defaultCols || []), ...(qtyCols || [])]));
        const fromQuote = deriveCountryColumnsFromQuotationColumns(unionCols);
        effectiveCountryColumnsMap = { ...BASE_COUNTRY_COLUMNS, ...fromQuote };

        // ✅ NEW: merge SKU -> Item name maps from both sheets
        const m1 = buildSkuToItemNameMap(defaultRows);
        const m2 = buildSkuToItemNameMap(qtyRows);

        skuToNameMap = new Map([...m1.entries()]);
        for (const [k, v] of m2.entries()) {
          if (!skuToNameMap.has(k)) skuToNameMap.set(k, v);
        }
      } else {
        priceIndexDefault = buildPriceIndex(quotationRows);
        priceIndexQty1to5 = {};
        skuToNameMap = buildSkuToItemNameMap(quotationRows);
      }
    } catch (e) {
      console.error("Failed reading quotation workbook sheets:", e);
      priceIndexDefault = buildPriceIndex(quotationRows);
      priceIndexQty1to5 = {};
      skuToNameMap = buildSkuToItemNameMap(quotationRows);
    }

    // ✅ NEW: group by order with dedupe to avoid double-counting across sheets
    const ordersByOrderNo = groupByOrderDeduped(trackingRows);

    const newResults = [];
    const newCorrections = [];

    for (const trackingOrderRaw of Object.keys(ordersByOrderNo)) {
      const orderRows = ordersByOrderNo[trackingOrderRaw];

      const columns =
        (orderRows?.[0]?.__headers && orderRows[0].__headers) ||
        ordersFile?.columns ||
        trackingAllColumnsGuess ||
        Object.keys(orderRows?.[0] || {}).filter((k) => !k.startsWith("__"));

      // ✅ price comparison (unchanged)
      const res = computeOrderResult(orderRows, priceIndexDefault, priceIndexQty1to5, effectiveCountryColumnsMap);
      if (!res) continue;

      // Choose store for Shopify order lookup
      const storeKeyForThisOrder = inferStoreKeyFromTracking(orderRows, columns, selectedStore);

      let shopifyMatch = "—";
      let itemsCompared = 0;

      const trackingNum = normOrderKey(trackingOrderRaw);

      try {
        const { byNum } = await ensureShopifyStoreLoaded(storeKeyForThisOrder);
        const shopifyOrderForCompare = trackingNum ? byNum[trackingNum] : null;

        if (shopifyOrderForCompare) {
          // ✅ NEW: Invoice side uses Quotation item name (via SKU base)
          const invoiceSig = buildInvoiceSigViaQuotation(orderRows, columns, skuToNameMap);

          // ✅ NEW: Shopify side uses base-name canonicalized titles
          const shopifySig = buildShopifySigByBaseName(shopifyOrderForCompare);

          itemsCompared = invoiceSig.length;
          shopifyMatch = arraysEqual(invoiceSig, shopifySig) ? "✅ match" : "❌ mismatch";
        } else {
          shopifyMatch = "⚠️ not found";
        }
      } catch (err) {
        console.error(`Error fetching Shopify for ${storeKeyForThisOrder}:`, err);
        shopifyMatch = "⚠️ Shopify error";
      }

      // ✅ corrections logic (unchanged guard against bad 0 corrections)
      const hasPricingConfidence = !res.detail || String(res.detail).trim() === "";
      const expected = Number(res.expectedTotal);
      const reported = Number(res.reportedTotal);

      const shouldCorrect =
        res.status === "mismatch" &&
        Number.isFinite(expected) &&
        hasPricingConfidence &&
        !(expected === 0 && Number.isFinite(reported) && reported !== 0);

      if (shouldCorrect) {
        const totalCol = findColumn(columns, ["Total"]) || "Total";
        const totalRowObj = orderRows.find(
          (r) => r?.[totalCol] !== null && r?.[totalCol] !== undefined && String(r?.[totalCol]).trim() !== ""
        );

        if (totalRowObj?.__sheet && totalRowObj?.__rowIndex !== undefined && totalRowObj?.__colIndexByName) {
          const addr = getCellAddress(totalRowObj, totalCol);
          if (addr) {
            const corrected = Math.round(expected * 100) / 100;
            newCorrections.push({
              sheetName: totalRowObj.__sheet,
              cell: addr,
              value: corrected,
              oldValue: totalRowObj[totalCol],
              order: trackingOrderRaw,
              column: totalCol,
              rowIndex: totalRowObj.__rowIndex,
            });
          }
        }
      }

      newResults.push({
        ...res,
        shopifyMatch,
        itemsCompared,
      });
    }

    const sorted = sortResultsByOrder(newResults, resultsSortDir);
    setResults(sorted);
    setCellCorrections(newCorrections);

    const mismatchCount = newResults.filter((r) => r.status === "mismatch").length;
    const shopifyMatchCount = newResults.filter((r) => r.shopifyMatch === "✅ match").length;

    setMessage(
      `Check completed: ${newResults.length} orders processed. ${mismatchCount} invoice mismatches. ${shopifyMatchCount} Shopify matches.`
    );
  } finally {
    setShopifyLoading(false);
  }
};

  const handleDownload = async () => {
    if (trackingArrayBuffer && cellCorrections && cellCorrections.length > 0) {
      try {
        const wb = XLSX.read(trackingArrayBuffer, { type: "array" });
        applyCorrectionsToWorkbook(wb, cellCorrections);
        XLSX.writeFile(wb, "trackings&costs.corrected.xlsx");
        return;
      } catch (e) {
        console.error("Failed to write corrected workbook:", e);
        setMessage("Failed to write corrected workbook. Falling back to basic export.");
      }
    }

    setMessage("No precise corrections available to apply (make sure you uploaded the original XLSX).");
  };

  const selectedStoreMeta = useMemo(() => {
    if (!availableStores?.length || !selectedStore) return null;
    return availableStores.find((s) => s.storeKey === selectedStore) || null;
  }, [availableStores, selectedStore]);

  /* ---------------- NEW: Side-by-side ORIGINAL vs CORRECTED rows ---------------- */

  const trackingRowsForCompare = useMemo(() => {
    return trackingAllRows?.length ? trackingAllRows : ordersFile?.rows || [];
  }, [trackingAllRows, ordersFile]);

  const trackingColumnsForCompare = useMemo(() => {
    const cols =
      (trackingRowsForCompare?.[0]?.__headers && trackingRowsForCompare[0].__headers) ||
      ordersFile?.columns ||
      trackingAllColumnsGuess ||
      (trackingRowsForCompare?.[0] ? Object.keys(trackingRowsForCompare[0]).filter((k) => !k.startsWith("__")) : []);
    return Array.isArray(cols) ? cols : [];
  }, [trackingRowsForCompare, ordersFile, trackingAllColumnsGuess]);

  const rowKeyOf = (r) => `${r?.__sheet ?? ""}::${r?.__rowIndex ?? ""}`;

  const correctionsByRowAndCol = useMemo(() => {
    // map: rowKey -> { colName -> {newValue, oldValue, cell} }
    const map = new Map();
    (cellCorrections || []).forEach((fix) => {
      const rk = `${fix.sheetName ?? ""}::${fix.rowIndex ?? ""}`;
      if (!rk.includes("::")) return;

      if (!map.has(rk)) map.set(rk, {});
      map.get(rk)[fix.column] = {
        newValue: fix.value,
        oldValue: fix.oldValue,
        cell: fix.cell,
        order: fix.order,
      };
    });
    return map;
  }, [cellCorrections]);

  const pickedCompareColumns = useMemo(() => {
    // Prefer “useful debugging” columns, but only if they exist
    const preferred = [
      "Order#",
      "Store",
      "Country",
      "SKU.1",
      "SKU",
      "Item",
      "Item name",
      "Line Items",
      "QTY",
      "Cost",
      "Upsell",
      "Total",
      "Carrier",
      "Tracking",
    ];

    const cols = trackingColumnsForCompare || [];
    const lower = cols.map((c) => String(c).toLowerCase());

    const out = [];
    preferred.forEach((p) => {
      const idx = lower.indexOf(String(p).toLowerCase());
      if (idx >= 0) out.push(cols[idx]);
    });

    // Fallback: first 12 non-meta columns
    if (out.length === 0) {
      const cleaned = cols.filter((c) => !String(c).startsWith("__"));
      return cleaned.slice(0, 12);
    }
    return out;
  }, [trackingColumnsForCompare]);

  const compareRows = useMemo(() => {
    const rows = trackingRowsForCompare || [];
    if (!rows.length) return { originalRows: [], correctedRows: [], changedRowKeys: new Set(), changedCells: new Set() };

    const changedRowKeys = new Set();
    const changedCells = new Set(); // `${rowKey}::${col}`

    // Mark changed rows/cells from corrections
    correctionsByRowAndCol.forEach((cols, rk) => {
      changedRowKeys.add(rk);
      Object.keys(cols || {}).forEach((col) => changedCells.add(`${rk}::${col}`));
    });

    // Build original and corrected row representations (only with chosen columns to keep UI light)
    const originalRows = [];
    const correctedRows = [];

    for (const r of rows) {
      const rk = rowKeyOf(r);
      const isChanged = changedRowKeys.has(rk);

      if (!compareShowAllRows && !isChanged) continue;

      const o = { __rk: rk, __sheet: r.__sheet, __rowIndex: r.__rowIndex };
      const c = { __rk: rk, __sheet: r.__sheet, __rowIndex: r.__rowIndex };

      pickedCompareColumns.forEach((col) => {
        o[col] = r?.[col];

        const fixForRow = correctionsByRowAndCol.get(rk);
        if (fixForRow && fixForRow[col] && fixForRow[col].newValue !== undefined) {
          c[col] = fixForRow[col].newValue;
        } else {
          c[col] = r?.[col];
        }
      });

      originalRows.push(o);
      correctedRows.push(c);
    }

    return { originalRows, correctedRows, changedRowKeys, changedCells };
  }, [trackingRowsForCompare, pickedCompareColumns, correctionsByRowAndCol, compareShowAllRows]);

  const renderCompareTable = (title, rows, changedRowKeys, changedCells) => {
    return (
      <div style={{ background: "rgba(0,0,0,0.15)", padding: 12, borderRadius: 12 }}>
        <div style={{ color: "#fff", fontWeight: 800, marginBottom: 10 }}>{title}</div>

        <div className="table-wrapper">
          <table className="table results-table">
            <thead>
              <tr>
                <th style={{ minWidth: 120 }}>Sheet / Row</th>
                {pickedCompareColumns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => {
                const rk = r.__rk;
                const rowChanged = changedRowKeys.has(rk);

                return (
                  <tr
                    key={rk}
                    style={{
                      background: rowChanged ? "rgba(255, 0, 0, 0.30)" : "transparent",
                    }}
                  >
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.__sheet ?? "—"} / {typeof r.__rowIndex === "number" ? r.__rowIndex + 1 : "—"}
                    </td>

                    {pickedCompareColumns.map((col) => {
                      const cellChanged = changedCells.has(`${rk}::${col}`);
                      return (
                        <td
                          key={`${rk}-${col}`}
                          style={{
                            background: cellChanged ? "rgba(255, 0, 0, 0.50)" : "transparent",
                            fontWeight: cellChanged ? 800 : 400,
                          }}
                        >
                          {r[col] === null || r[col] === undefined ? "" : String(r[col])}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={1 + pickedCompareColumns.length} style={{ color: "#fff", opacity: 0.9 }}>
                    No rows to display.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className={`App ${shopifyLoading ? "is-loading" : ""}`}>
      <h1 style={{ color: "#fff", margin: 20 }}>INVOICE CHECKER</h1>

      <div className="controls">
        <button className="button" onClick={handleRunCheck} disabled={shopifyLoading}>
          RUN PROGRAM
        </button>
        <button className="button secondary" onClick={handleDownload} disabled={shopifyLoading}>
          DOWNLOAD CORRECTED INVOICE FILE
        </button>

        {message && <div className="status-message">{message}</div>}

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginLeft: 20, marginTop: 10, flexWrap: "wrap" }}>
          <label style={{ color: "#fff", fontWeight: 700 }}>Store:</label>

          <select
            value={selectedStore}
            onChange={(e) => setSelectedStore(e.target.value)}
            disabled={shopifyLoading || storesLoading}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.25)",
              outline: "none",
              minWidth: 260,
            }}
          >
            {availableStores?.length > 0 ? (
              availableStores.map((s) => (
                <option key={s.storeKey} value={s.storeKey}>
                  {s.storeKey}
                  {s.domain ? ` (${s.domain})` : ""}
                </option>
              ))
            ) : (
              <>
                <option value="bloomommy">bloomommy</option>
                <option value="cellumove">cellumove</option>
                <option value="yuma">yuma</option>
              </>
            )}
          </select>

          <button
            type="button"
            className="button small"
            onClick={() => fetchStores()}
            disabled={storesLoading || shopifyLoading}
            style={{ padding: "8px 10px" }}
          >
            Refresh Stores
          </button>

          {storesLoading && <span style={{ color: "#fff" }}>Loading stores…</span>}
          {storesError && <span style={{ color: "#ffb3b3" }}>{storesError}</span>}

          {shopifyLoading && <span style={{ color: "#fff" }}>Loading orders…</span>}
          {shopifyError && <span style={{ color: "#ffb3b3" }}>{shopifyError}</span>}

          {selectedStoreMeta?.groupKey && (
            <span style={{ color: "#fff", opacity: 0.9 }}>
              Group: <strong>{selectedStoreMeta.groupKey}</strong>
            </span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="text"
          value={orderSearch}
          onChange={(e) => setOrderSearch(e.target.value)}
          placeholder="Search Order # (example: 18339)"
          style={{
            width: 360,
            maxWidth: "90%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.25)",
            outline: "none",
            marginLeft: 20,
          }}
        />

        {orderSearchNum && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
            {/* Invoice */}
            <div style={{ background: "rgba(0,0,0,0.15)", padding: 12, borderRadius: 12, margin: 20 }}>
              <div style={{ color: "#fff", fontWeight: 700, marginBottom: 8 }}>Invoice</div>
              {invoiceDisplay ? (
                <table className="table results-table">
                  <thead>
                    <tr>
                      <th>Order#</th>
                      <th>Country</th>
                      <th>Tracking</th>
                      <th>Line Items</th>
                      <th>Quantity</th>
                    </tr>
                  </thead>

                  <tbody>
                    <tr>
                      <td>{invoiceDisplay.order}</td>
                      <td>{invoiceDisplay.country || "—"}</td>
                      <td>{invoiceDisplay.tracking || "—"}</td>
                      <td>
                        {invoiceDisplay.lineItems.map((li, i) => (
                          <div key={i}>
                            {li.name} {li.skus && li.skus.length ? <span style={{ opacity: 0.85 }}>({li.skus.join(", ")})</span> : null}
                          </div>
                        ))}
                      </td>
                      <td>
                        {invoiceDisplay.lineItems.map((li, i) => (
                          <div key={i}>{li.qty}</div>
                        ))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{ color: "#fff", opacity: 0.9 }}>Not found in invoice table (upload Order Tracking & Costs first).</div>
              )}
            </div>

            {/* Shopify */}
            <div style={{ background: "rgba(0,0,0,0.15)", padding: 12, borderRadius: 12, margin: 20 }}>
              <div style={{ color: "#fff", fontWeight: 700, marginBottom: 8 }}>Shopify</div>

              {shopifyOrder && shopifyDisplay ? (
                <table className="table results-table">
                  <thead>
                    <tr>
                      <th>Order#</th>
                      <th>Customer</th>
                      <th>Country</th>
                      <th>Line Items</th>
                      <th>Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{shopifyOrder.name}</td>
                      <td>{shopifyDisplay.customer}</td>
                      <td>{shopifyDisplay.country}</td>
                      <td>
                        {shopifyDisplay.lineItems.map((t, i) => (
                          <div key={i}>{t}</div>
                        ))}
                      </td>
                      <td>
                        {shopifyDisplay.quantities.map((t, i) => (
                          <div key={i}>{t}</div>
                        ))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{ color: "#fff", opacity: 0.9 }}>Not found in Shopify (or still loading).</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="side-by-side">
        <Table title="ORDER TRACKING & COSTS" onDataChange={setOrdersFile} />
        <Table title="PRICES" onDataChange={setPricesFile} />
        <ShopifyTable title="SHOPIFY" data={filteredShopifyOrders} error={shopifyError} />
      </div>

      {/* SUMMARY (same as before) */}
      {results && results.length > 0 && (
        <div className="results-wrapper">
          <div className="results-header">
            <h2>SUMMARY (INVOICE + SHOPIFY)</h2>
            <button
              type="button"
              className="button small"
              onClick={() =>
                setResultsSortDir((prevDir) => {
                  const newDir = prevDir === "asc" ? "desc" : "asc";
                  setResults((prev) => sortResultsByOrder(prev, newDir));
                  return newDir;
                })
              }
            >
              Sort by Order# ({resultsSortDir === "asc" ? "Ascending" : "Descending"})
            </button>
          </div>

          <div className="table-wrapper">
            <table className="table results-table">
              <thead>
                <tr>
                  <th>Order#</th>
                  <th>Country</th>
                  <th>Base total</th>
                  <th>Upsell total</th>
                  <th>Expected total</th>
                  <th>Reported total</th>
                  <th>Difference</th>
                  <th>Invoice Status</th>
                  <th>Items Compared</th>
                  {/* <th>Details</th> */}
                  <th>Shopify Match</th>
                </tr>
              </thead>

              <tbody>
                {results.map((r) => {
                  // const isExpanded = expandedOrder === r.order;
                  return (
                    <React.Fragment key={r.order}>
                      <tr className={r.status === "mismatch" ? "row-red" : "row-green"}>
                        <td>{r.order}</td>
                        <td>{r.country}</td>
                        <td>{Number(r.baseTotal || 0).toFixed(2)}</td>
                        <td>{Number(r.upsellTotal || 0).toFixed(2)}</td>
                        <td>{Number(r.expectedTotal || 0).toFixed(2)}</td>
                        <td>{isNaN(r.reportedTotal) ? "" : Number(r.reportedTotal).toFixed(2)}</td>
                        <td>{isNaN(r.difference) ? "" : Number(r.difference).toFixed(2)}</td>
                        <td>{r.status === "mismatch" ? "❌ mismatch" : "✅ ok"}</td>
                        <td>{r.itemsCompared ?? 0}</td>
                        {/* <td>
                          <button
                            type="button"
                            className="button small"
                            onClick={() => setExpandedOrder(isExpanded ? null : r.order)}
                          >
                            {isExpanded ? "Hide" : "Show"}
                          </button>
                        </td> */}
                        <td>{r.shopifyMatch ?? "—"}</td>
                      </tr>

                      {/* {isExpanded && (
                        <tr key={`${r.order}-detail`}>
                          <td colSpan={11} style={{ background: "rgba(0,0,0,0.06)", color: "#000", padding: 12 }}>
                            <div style={{ display: "flex", gap: 20 }}>
                              <div style={{ flex: 1 }}>
                                <strong>
                                  Invoice (tracking) — {Object.keys(r.trackingMap || {}).length} item(s)
                                  {typeof r.trackingSig !== 'undefined' ? ` — sigs: ${r.trackingSig?.length ?? 0}` : ''}
                                </strong>
                                <ul style={{ marginTop: 6 }}>
                                  {(r.trackingMap && Object.keys(r.trackingMap).length) ? Object.entries(r.trackingMap).map(([k, v]) => (
                                    <li key={k}>{k} — {v}</li>
                                  )) : (<li>—</li>)}
                                </ul>
                              </div>

                              <div style={{ flex: 1 }}>
                                <strong>
                                  Shopify — {Object.keys(r.shopifyMap || {}).length} item(s)
                                  {typeof r.shopifySig !== 'undefined' ? ` — sigs: ${r.shopifySig?.length ?? 0}` : ''}
                                </strong>
                                <ul style={{ marginTop: 6 }}>
                                  {(r.shopifyMap && Object.keys(r.shopifyMap).length) ? Object.entries(r.shopifyMap).map(([k, v]) => (
                                    <li key={k}>{k} — {v}</li>
                                  )) : (<li>—</li>)}
                                </ul>
                              </div>

                              <div style={{ flex: 1 }}>
                                <strong>Diff</strong>
                                <ul style={{ marginTop: 6 }}>
                                  {Array.from(new Set([...(Object.keys(r.trackingMap || {})), ...(Object.keys(r.shopifyMap || {}))])).sort().map((k) => {
                                    const t = r.trackingMap?.[k] ?? 0;
                                    const s = r.shopifyMap?.[k] ?? 0;
                                    return (
                                      <li key={k}>{k}: {t} vs {s}{t === s ? '' : ' ⚠️'}</li>
                                    );
                                  })}
                                </ul>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )} */}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {cellCorrections?.length > 0 && (
            <div style={{ margin: "10px 20px", color: "#fff", opacity: 0.9 }}>
              Ready to correct <strong>{cellCorrections.length}</strong> cell(s) in the original XLSX on download.
            </div>
          )}
        </div>
      )}

      {/* NEW: SIDE-BY-SIDE ORIGINAL vs CORRECTED */}
      {trackingRowsForCompare?.length > 0 && (
        <div className="results-wrapper">
          <div className="results-header" style={{ alignItems: "center" }}>
            <h2>RESULTS TABLE (TRACKINGS&COSTS: ORIGINAL vs CORRECTED)</h2>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ color: "#fff", opacity: 0.95, display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={compareShowAllRows}
                  onChange={(e) => setCompareShowAllRows(e.target.checked)}
                />
                Show all rows (may be slow)
              </label>

              <div style={{ color: "#fff", opacity: 0.9 }}>
                Showing{" "}
                <strong>
                  {compareRows.originalRows.length}
                </strong>{" "}
                row(s){compareShowAllRows ? "" : " (changed rows only)"}.
              </div>
            </div>
          </div>

          <div style={{ margin: "0 20px 10px", color: "#fff", opacity: 0.9 }}>
            Highlighted rows/cells are the ones that would be changed in the corrected file.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "45vw 45vw", gap: 30, margin: "0 20px 20px" }}>
            {renderCompareTable("ORIGINAL (Trackings&Costs)", compareRows.originalRows, compareRows.changedRowKeys, compareRows.changedCells)}
            {renderCompareTable("CORRECTED (Trackings&Costs)", compareRows.correctedRows, compareRows.changedRowKeys, compareRows.changedCells)}
          </div>
        </div>
      )}

      {shopifyLoading && (
        <div className="loading-overlay" role="alert" aria-busy="true" aria-live="polite">
          <div className="loading-card">
            <div className="spinner" />
            <div className="loading-text">Fetching Shopify orders…</div>
            <div className="loading-subtext">Please wait</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
