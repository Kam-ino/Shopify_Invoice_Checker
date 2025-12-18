import "./App.css";
<<<<<<< Updated upstream
import React, { useState } from "react";
=======
import React, { useState, useEffect, useMemo } from "react";
import axios from "axios";
>>>>>>> Stashed changes
import Table from "./components/table";
import * as XLSX from "xlsx-js-style";

<<<<<<< Updated upstream
// Helper to parse totals from Oct prices (strip currency etc)
=======
/* ---------------- Existing helpers ---------------- */

>>>>>>> Stashed changes
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

const COUNTRY_COLUMNS = {
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
  BE: { total: "Total to BE", upsell: "Upsell to BE" },
};

function buildPriceIndex(pricesRows) {
  const index = {};
  if (!pricesRows) return index;

  pricesRows.forEach((row) => {
    const sku = row["SKU"];
    const qty = Number(row["QTY"] || 0);
    if (!sku || !qty) return;

    if (!index[sku]) index[sku] = {};
    index[sku][qty] = row;
  });

  return index;
}

function groupByOrder(ordersRows) {
  const map = {};
  if (!ordersRows) return map;
  ordersRows.forEach((row) => {
    const orderNo = row["Order#"];
    if (!orderNo) return;
    if (!map[orderNo]) map[orderNo] = [];
    map[orderNo].push(row);
  });
  return map;
}

function computeOrderResult(orderRows, priceIndex) {
  if (!orderRows || orderRows.length === 0) return null;

  const orderNo = orderRows[0]["Order#"];

  const countryRow =
    orderRows.find((r) => r["Country"] && String(r["Country"]).trim() !== "") || null;
  const country = countryRow ? String(countryRow["Country"]).trim() : null;
  const countryCols = COUNTRY_COLUMNS[country] || null;

  const groups = {};
  orderRows.forEach((row) => {
    const skuBase = row["SKU.1"] || row["SKU"];
    const qty = Number(row["QTY"] || 0);
    const cost = Number(row["Cost"] || 0);
    const upsell = Number(row["Upsell"] || 0);
    if (!skuBase || !qty) return;

    if (!groups[skuBase]) groups[skuBase] = { qty: 0, cost: 0, upsell: 0 };
    groups[skuBase].qty += qty;
    groups[skuBase].cost += cost;
    groups[skuBase].upsell += upsell;
  });

  let baseTotal = 0;
  let upsellTotal = 0;

  if (countryCols) {
    Object.entries(groups).forEach(([skuBase, info]) => {
      const { qty, cost, upsell } = info;
      const skuPrices = priceIndex[skuBase];
      if (!skuPrices) return;
      const priceRow = skuPrices[qty];
      if (!priceRow) return;

      if (cost > 0 && (!upsell || upsell === 0)) {
        baseTotal += parsePrice(priceRow[countryCols.total]);
      } else if ((!cost || cost === 0) && upsell > 0) {
        upsellTotal += parsePrice(priceRow[countryCols.upsell]);
      }
    });
  }

  const expectedTotal = baseTotal + upsellTotal;

  const totalRow = orderRows.find(
    (r) => r["Total"] !== null && r["Total"] !== undefined && r["Total"] !== ""
  );
  const reportedTotal = totalRow ? Number(totalRow["Total"]) : NaN;

  const difference =
    !isNaN(expectedTotal) && !isNaN(reportedTotal) ? reportedTotal - expectedTotal : NaN;

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

/**
 * ✅ Keep only real "ordered/fulfillable/fulfilled" items; exclude "removed".
 * Uses fulfillableQuantity / fulfillmentStatus if present.
 */
const shouldKeepShopifyLineItem = (node) => {
  if (!node) return false;

  const title = normText(node.title);
  if (!title) return false;

  // exclude E-book always
  if (title.toLowerCase().includes("e-book")) return false;

  // quantity/currentQuantity fallback
  const qty = Number(node.currentQuantity ?? node.quantity ?? 0) || 0;
  if (qty <= 0) return false;

  const hasFQ = node.fulfillableQuantity !== undefined && node.fulfillableQuantity !== null;
  const hasFS = node.fulfillmentStatus !== undefined && node.fulfillmentStatus !== null;

  // If backend provides these, enforce them:
  if (hasFQ || hasFS) {
    const fq = Number(node.fulfillableQuantity ?? 0) || 0;
    const fs = String(node.fulfillmentStatus ?? "").toUpperCase();
    return fs === "FULFILLED" || fq > 0;
  }

  // If not available, do not break behavior
  return true;
};

const buildTrackingSignature = (orderRows, columns) => {
  const qtyCol = findColumn(columns, ["QTY", "Quantity"]);
  const variantCol = findColumn(columns, ["Variant"]);
  const lineItemsCol = findColumn(columns, ["Line Items"]);
  const itemNameCol = findColumn(columns, ["Item name", "Item Name", "Item"]);

  if (!qtyCol) return [];

  const sigs = [];

  for (const r of orderRows) {
    const qty = Number(r?.[qtyCol] ?? 0) || 0;
    if (qty <= 0) continue;

    let item = "";
    let variant = "";

    if (lineItemsCol) item = normText(r?.[lineItemsCol]);
    if (variantCol) variant = normText(r?.[variantCol]);

    if (!item && itemNameCol) {
      const sp = splitItemAndVariant(r?.[itemNameCol]);
      item = item || sp.item;
      variant = variant || sp.variant;
    }

    if (!item) continue;

    sigs.push(`${item.toLowerCase()}||${variant.toLowerCase()}||${qty}`);
  }

  sigs.sort();
  return sigs;
};

const buildShopifySignature = (shopifyOrder) => {
  const edges = shopifyOrder?.lineItems?.edges ?? [];
  const sigs = [];

  for (const e of edges) {
    const node = e?.node;
    if (!shouldKeepShopifyLineItem(node)) continue;

    const title = normText(node.title);
    let variant = normText(node?.variant?.title);
    if (variant.toLowerCase() === "default title") variant = "";

    const qty = Number(node.currentQuantity ?? node.quantity ?? 0) || 0;
    if (qty <= 0) continue;

    sigs.push(`${title.toLowerCase()}||${variant.toLowerCase()}||${qty}`);
  }

  sigs.sort();
  return sigs;
};

const arraysEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/* ---------------- App ---------------- */

function App() {
  const [ordersFile, setOrdersFile] = useState(null);
  const [pricesFile, setPricesFile] = useState(null);
  const [results, setResults] = useState([]);
  const [correctedOrders, setCorrectedOrders] = useState(null);
  const [message, setMessage] = useState("");
  const [resultsSortDir, setResultsSortDir] = useState("asc");
<<<<<<< Updated upstream
=======

  // Shopify
  const [shopifyError, setShopifyError] = useState("");
  const [orders, setOrders] = useState([]);
  const [shopifyLoading, setShopifyLoading] = useState(false);

  const [orderSearch, setOrderSearch] = useState("");

  const getDigits = (v) => {
    const m = String(v ?? "").match(/\d+/);
    return m ? m[0] : "";
  };

  const orderSearchNum = useMemo(() => getDigits(orderSearch), [orderSearch]);

  // ✅ Filter Shopify orders once so ALL UI uses clean data (no removed items, no E-book)
  const filteredShopifyOrders = useMemo(() => {
    return (orders || []).map((o) => {
      const edges = o?.lineItems?.edges ?? [];
      const filteredEdges = edges.filter((e) => shouldKeepShopifyLineItem(e?.node));
      return { ...o, lineItems: { edges: filteredEdges } };
    });
  }, [orders]);

  const shopifyOrder = useMemo(() => {
    if (!orderSearchNum) return null;
    return (filteredShopifyOrders || []).find((o) => getDigits(o?.name) === orderSearchNum) || null;
  }, [filteredShopifyOrders, orderSearchNum]);

  const shopifyDisplay = useMemo(() => {
    if (!shopifyOrder) return null;

    const edges = shopifyOrder?.lineItems?.edges ?? [];
    const filtered = edges.map((e) => e?.node).filter(Boolean);

    const lineItems = filtered.map((n) => n.title || "N/A");
    const variants = filtered.map((n) => {
      const v = n?.variant?.title || "";
      return String(v).toLowerCase() === "default title" ? "" : v;
    });
    const quantities = filtered.map((n) => n?.currentQuantity ?? n?.quantity ?? "N/A");

    const customer = shopifyOrder?.customer
      ? `${shopifyOrder.customer.firstName ?? ""} ${shopifyOrder.customer.lastName ?? ""}`.trim() ||
        shopifyOrder.customer.email ||
        "N/A"
      : "N/A";

    const country = shopifyOrder?.billingAddress?.country ?? "N/A";

    return { customer, country, lineItems, variants, quantities };
  }, [shopifyOrder]);

  const invoiceDisplay = useMemo(() => {
    if (!orderSearchNum) return null;
    if (!ordersFile?.rows || ordersFile.rows.length === 0) return null;

    const cols = ordersFile.columns || Object.keys(ordersFile.rows[0] || {});
    const orderCol = findColumn(cols, ["Order#", "Order #", "Order Number", "Order"]);
    if (!orderCol) return null;

    const rows = ordersFile.rows.filter((r) => getDigits(r?.[orderCol]) === orderSearchNum);
    if (rows.length === 0) return null;

    const carrierCol = findColumn(cols, ["Carrier"]);
    const trackingCol = findColumn(cols, ["Tracking", "Tracking #", "Tracking Number"]);

    const qtyCol = findColumn(cols, ["QTY", "Quantity"]);
    const variantCol = findColumn(cols, ["Variant"]);
    const lineItemsCol = findColumn(cols, ["Line Items"]);
    const itemNameCol = findColumn(cols, ["Item name", "Item Name", "Item"]);

    const carrier = carrierCol ? rows.find((r) => r?.[carrierCol])?.[carrierCol] ?? "" : "";
    const tracking = trackingCol ? rows.find((r) => r?.[trackingCol])?.[trackingCol] ?? "" : "";

    const lineItems = [];
    const variants = [];
    const quantities = [];

    rows.forEach((r) => {
      const q = qtyCol ? Number(r?.[qtyCol] ?? 0) || 0 : 0;

      let item = lineItemsCol ? normText(r?.[lineItemsCol]) : "";
      let variant = variantCol ? normText(r?.[variantCol]) : "";

      if ((!item || !variant) && itemNameCol) {
        const sp = splitItemAndVariant(r?.[itemNameCol]);
        if (!item) item = sp.item;
        if (!variant) variant = sp.variant;
      }

      if (item) lineItems.push(item);
      variants.push(variant || "");
      quantities.push(q || 0);
    });

    return {
      order: `#${orderSearchNum}`,
      carrier: normText(carrier),
      tracking: normText(tracking),
      lineItems,
      variants,
      quantities,
    };
  }, [ordersFile, orderSearchNum]);

  useEffect(() => {
    const fetchOrders = async () => {
      setShopifyLoading(true);
      try {
        setShopifyError("");
        const response = await axios.get("http://localhost:4000/api/orders");
        const apiOrders = response.data?.orders;
        setOrders(Array.isArray(apiOrders) ? apiOrders : []);
      } catch (err) {
        console.error("Error fetching orders:", err);
        setOrders([]);
        setShopifyError("Failed to load Shopify orders (check API server).");
      } finally {
        setShopifyLoading(false);
      }
    };

    fetchOrders();
  }, []);
>>>>>>> Stashed changes

  const handleRunCheck = () => {
    if (!ordersFile || !ordersFile.rows || !pricesFile || !pricesFile.rows) {
      setMessage("Please upload both Orders tracking & costs and prices files.");
      setResults([]);
      setCorrectedOrders(null);
      return;
    }

    const ordersRows = ordersFile.rows;
    const pricesRows = pricesFile.rows;

    const priceIndex = buildPriceIndex(pricesRows);
    const ordersByOrderNo = groupByOrder(ordersRows);

    // Build Shopify lookup: "18339" -> shopifyOrder (already filtered)
    const shopifyByNum = {};
    (filteredShopifyOrders || []).forEach((o) => {
      const k = normOrderKey(o?.name);
      if (k && !shopifyByNum[k]) shopifyByNum[k] = o;
    });

    const trackingCols = ordersFile.columns || Object.keys(ordersRows[0] || {});

    const newResults = [];
    const correctedTotalsByOrder = {};

    Object.keys(ordersByOrderNo).forEach((trackingOrderRaw) => {
      const orderRows = ordersByOrderNo[trackingOrderRaw];

      const res = computeOrderResult(orderRows, priceIndex);
      if (!res) return;

      if (res.status === "mismatch" && !isNaN(res.expectedTotal)) {
        correctedTotalsByOrder[trackingOrderRaw] = Math.round(res.expectedTotal * 100) / 100;
      }

      const trackingNum = normOrderKey(trackingOrderRaw);
      const shopifyOrderForCompare = trackingNum ? shopifyByNum[trackingNum] : null;

      let shopifyMatch = "—";
      let itemsCompared = 0;

      if (shopifyOrderForCompare) {
        const trackingSig = buildTrackingSignature(orderRows, trackingCols);
        const shopifySig = buildShopifySignature(shopifyOrderForCompare);
        itemsCompared = trackingSig.length;

        shopifyMatch = arraysEqual(trackingSig, shopifySig) ? "✅ match" : "❌ mismatch";
      } else {
        shopifyMatch = "⚠️ not found";
      }

      newResults.push({
        ...res,
        shopifyMatch,
        itemsCompared,
      });
    });

    const sorted = sortResultsByOrder(newResults, resultsSortDir);
    setResults(sorted);

    const correctedRows = ordersRows.map((row) => {
      const orderNo = row["Order#"];
      const corrected = correctedTotalsByOrder[orderNo];
      return {
        ...row,
        "Corrected Total": corrected !== undefined && corrected !== null ? corrected : "",
      };
    });

    const existingCols = ordersFile.columns || Object.keys(ordersRows[0] || {});
    const correctedColumns = existingCols.includes("Corrected Total")
      ? existingCols
      : [...existingCols, "Corrected Total"];

    setCorrectedOrders({ rows: correctedRows, columns: correctedColumns });

    const mismatchCount = newResults.filter((r) => r.status === "mismatch").length;
    const shopifyMatchCount = newResults.filter((r) => r.shopifyMatch === "✅ match").length;

    setMessage(
      `Check completed: ${newResults.length} orders processed. ` +
        `${mismatchCount} invoice mismatches. ` +
        `${shopifyMatchCount} Shopify matches.`
    );
  };

  const handleDownload = () => {
    if (!correctedOrders || !correctedOrders.rows.length) {
      setMessage("Nothing to download yet. Run the check first.");
      return;
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(correctedOrders.rows, {
      header: correctedOrders.columns,
    });

    const cols = correctedOrders.columns;

    correctedOrders.rows.forEach((row, rowIdx) => {
      const correctedVal = row["Corrected Total"];
      if (correctedVal === null || correctedVal === undefined || correctedVal === "") return;

      const fillRgb = "FFAFAF";

      cols.forEach((colName, colIndex) => {
        const addr = XLSX.utils.encode_cell({ r: rowIdx + 1, c: colIndex });

        if (!ws[addr]) {
          const cellVal = row[colName];
          ws[addr] = {
            t: typeof cellVal === "number" ? "n" : "s",
            v: cellVal ?? "",
          };
        }

        ws[addr].s = ws[addr].s || {};
        ws[addr].s.fill = { patternType: "solid", fgColor: { rgb: fillRgb } };
      });
    });

    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, "Orders_tracking_corrected.xlsx");
  };

  return (
    <div className="App">
      {/* Optional: if you already added the CSS I sent earlier, this blocks interaction */}
      {shopifyLoading && (
        <div className="loading-overlay" role="alert" aria-busy="true">
          <div className="loading-card">
            <div className="spinner" />
            <div className="loading-text">Fetching Shopify orders…</div>
            <div className="loading-subtext">Please wait</div>
          </div>
        </div>
      )}

      <h1 style={{ color: "#fff" }}>INVOICE CHECKER</h1>

      <div className="controls">
        <button className="button" onClick={handleRunCheck} disabled={shopifyLoading}>
          RUN PROGRAM
        </button>
        <button className="button secondary" onClick={handleDownload} disabled={shopifyLoading}>
          DOWNLOAD CORRECTED INVOICE FILE
        </button>
        {message && <div className="status-message">{message}</div>}
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
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
              alignItems: "start",
            }}
          >
            {/* Invoice */}
            <div
              style={{
                background: "rgba(0,0,0,0.15)",
                padding: 12,
                borderRadius: 12,
                margin: 20,
              }}
            >
              <div style={{ color: "#fff", fontWeight: 700, marginBottom: 8 }}>Invoice</div>
              {invoiceDisplay ? (
                <table className="table results-table">
                  <thead>
                    <tr>
                      <th>Order#</th>
                      <th>Carrier</th>
                      <th>Tracking</th>
                      <th>Line Items</th>
                      <th>Variant</th>
                      <th>Quantity</th>
                    </tr>
                  </thead>

                  <tbody>
                    <tr>
                      <td>{invoiceDisplay.order}</td>
                      <td>{invoiceDisplay.carrier || "—"}</td>
                      <td>{invoiceDisplay.tracking || "—"}</td>
                      <td>
                        {invoiceDisplay.lineItems.map((t, i) => (
                          <div key={i}>{t}</div>
                        ))}
                      </td>
                      <td>
                        {invoiceDisplay.variants.map((t, i) => (
                          <div key={i}>{t || "—"}</div>
                        ))}
                      </td>
                      <td>
                        {invoiceDisplay.quantities.map((q, i) => (
                          <div key={i}>{q}</div>
                        ))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div style={{ color: "#fff", opacity: 0.9 }}>
                  Not found in invoice table (upload Order Tracking & Costs first).
                </div>
              )}
            </div>

            {/* Shopify */}
            <div
              style={{
                background: "rgba(0,0,0,0.15)",
                padding: 12,
                borderRadius: 12,
                margin: 20,
              }}
            >
              <div style={{ color: "#fff", fontWeight: 700, marginBottom: 8 }}>Shopify</div>

              {shopifyOrder && shopifyDisplay ? (
                <table className="table results-table">
                  <thead>
                    <tr>
                      <th>Order#</th>
                      <th>Customer</th>
                      <th>Country</th>
                      <th>Line Items</th>
                      <th>Variant</th>
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
                        {shopifyDisplay.variants.map((t, i) => (
                          <div key={i}>{t || "—"}</div>
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
                <div style={{ color: "#fff", opacity: 0.9 }}>
                  Not found in Shopify (or still loading).
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="side-by-side">
        <Table title="ORDER TRACKING & COSTS" onDataChange={setOrdersFile} />
        <Table title="PRICES" onDataChange={setPricesFile} />
<<<<<<< Updated upstream
=======

        {/* ✅ Pass filtered orders so removed items don't show in ShopifyTable */}
        <ShopifyTable title="SHOPIFY" data={filteredShopifyOrders} error={shopifyError} />
>>>>>>> Stashed changes
      </div>

      {results && results.length > 0 && (
        <div className="results-wrapper">
          <div className="results-header">
            <h2>RESULTS (INVOICE + SHOPIFY)</h2>
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
                  <th>Shopify Match</th>
                </tr>
              </thead>

              <tbody>
                {results.map((r) => (
                  <tr key={r.order} className={r.status === "mismatch" ? "row-red" : "row-green"}>
                    <td>{r.order}</td>
                    <td>{r.country}</td>
                    <td>{Number(r.baseTotal || 0).toFixed(2)}</td>
                    <td>{Number(r.upsellTotal || 0).toFixed(2)}</td>
                    <td>{Number(r.expectedTotal || 0).toFixed(2)}</td>
                    <td>{isNaN(r.reportedTotal) ? "" : Number(r.reportedTotal).toFixed(2)}</td>
                    <td>{isNaN(r.difference) ? "" : Number(r.difference).toFixed(2)}</td>
                    <td>{r.status === "mismatch" ? "❌ mismatch" : "✅ ok"}</td>
                    <td>{r.itemsCompared ?? 0}</td>
                    <td>{r.shopifyMatch ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
