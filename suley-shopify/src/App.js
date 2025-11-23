import "./App.css";
import React, { useState } from "react";
import Table from "./components/table";
import * as XLSX from "xlsx";

// Helper to parse totals from Oct prices (strip currency etc)
function parsePrice(val) {
  if (val === null || val === undefined || val === "") return NaN;
  if (typeof val === "number") return val;
  let s = String(val).trim();
  ["US$", "$", "€", "EUR"].forEach((p) => {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
    }
  });
  const num = Number(s);
  return isNaN(num) ? NaN : num;
}

// Mapping for country-specific columns in Oct prices
const COUNTRY_COLUMNS = {
  FR: { total: "Total to FR", upsell: "Upsell to FR" },
  BE: { total: "Total to BE", upsell: "Upsell to BE" },
  CH: { total: "Total to CH", upsell: "Upsell to CH" },
  // In the provided file, this header actually has spaces before CA
  CA: { total: "Total to CA", upsell: "Upsell to    CA" },
};

// Build index from Oct prices: index[SKU][QTY] = row
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

// Group orders rows by Order#
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

// Compute expected total vs reported total for an order
function computeOrderResult(orderRows, priceIndex) {
  if (!orderRows || orderRows.length === 0) return null;

  const orderNo = orderRows[0]["Order#"];

  // Country = first non-empty Country cell
  const countryRow =
    orderRows.find(
      (r) => r["Country"] && String(r["Country"]).trim() !== ""
    ) || null;
  const country = countryRow ? String(countryRow["Country"]).trim() : null;
  const countryCols = COUNTRY_COLUMNS[country] || null;

  // Group by base SKU
  const groups = {};
  orderRows.forEach((row) => {
    const skuBase = row["SKU.1"] || row["SKU"];
    const qty = Number(row["QTY"] || 0);
    const cost = Number(row["Cost"] || 0);
    const upsell = Number(row["Upsell"] || 0);
    if (!skuBase || !qty) return;

    if (!groups[skuBase]) {
      groups[skuBase] = { qty: 0, cost: 0, upsell: 0 };
    }
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
        // base product
        baseTotal += parsePrice(priceRow[countryCols.total]);
      } else if ((!cost || cost === 0) && upsell > 0) {
        // upsell only
        upsellTotal += parsePrice(priceRow[countryCols.upsell]);
      } else {
        // weird combination, skip
      }
    });
  }

  const expectedTotal = baseTotal + upsellTotal;

  // reported total: first non-empty Total cell for this order
  const totalRow = orderRows.find(
    (r) => r["Total"] !== null && r["Total"] !== undefined && r["Total"] !== ""
  );
  const reportedTotal = totalRow ? Number(totalRow["Total"]) : NaN;

  const difference =
    !isNaN(expectedTotal) && !isNaN(reportedTotal)
      ? reportedTotal - expectedTotal
      : NaN;

  const status =
    isNaN(difference) || Math.abs(difference) <= 0.01 ? "ok" : "mismatch";

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

// Helper to sort results by numeric Order# (handles "#114006")
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

function App() {
  const [ordersFile, setOrdersFile] = useState(null); // { rows, columns }
  const [pricesFile, setPricesFile] = useState(null); // { rows, columns }
  const [results, setResults] = useState([]);
  const [correctedOrders, setCorrectedOrders] = useState(null);
  const [message, setMessage] = useState("");
  const [resultsSortDir, setResultsSortDir] = useState("asc");

  const handleRunCheck = () => {
    if (!ordersFile || !ordersFile.rows || !pricesFile || !pricesFile.rows) {
      setMessage("Please upload both Orders tracking & costs and Oct prices.");
      setResults([]);
      setCorrectedOrders(null);
      return;
    }

    const ordersRows = ordersFile.rows;
    const pricesRows = pricesFile.rows;

    const priceIndex = buildPriceIndex(pricesRows);
    const ordersByOrderNo = groupByOrder(ordersRows);

    const newResults = [];
    const correctedTotalsByOrder = {};

    Object.keys(ordersByOrderNo).forEach((orderNo) => {
      const orderRows = ordersByOrderNo[orderNo];
      const res = computeOrderResult(orderRows, priceIndex);
      if (!res) return;
      newResults.push(res);

      if (res.status === "mismatch" && !isNaN(res.expectedTotal)) {
        correctedTotalsByOrder[orderNo] =
          Math.round(res.expectedTotal * 100) / 100;
      }
    });

    const sorted = sortResultsByOrder(newResults, resultsSortDir);
    setResults(sorted);

    // Build new orders rows with "Corrected Total" column
    const correctedRows = ordersRows.map((row) => {
      const orderNo = row["Order#"];
      const corrected = correctedTotalsByOrder[orderNo];
      return {
        ...row,
        "Corrected Total":
          corrected !== undefined && corrected !== null ? corrected : "",
      };
    });

    const existingCols =
      ordersFile.columns || Object.keys(ordersRows[0] || {});
    const correctedColumns = existingCols.includes("Corrected Total")
      ? existingCols
      : [...existingCols, "Corrected Total"];

    setCorrectedOrders({ rows: correctedRows, columns: correctedColumns });

    setMessage(
      `Check completed: ${newResults.length} orders processed. ` +
        `${newResults.filter((r) => r.status === "mismatch").length} mismatches.`
    );
  };

  const handleDownload = () => {
    if (!correctedOrders || !correctedOrders.rows.length) {
      setMessage("Nothing to download yet. Run the check first.");
      return;
    }

    // Map order -> status so we can color cells
    const statusByOrder = {};
    results.forEach((r) => {
      statusByOrder[String(r.order)] = r.status;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(correctedOrders.rows, {
      header: correctedOrders.columns,
    });

    // Find column indexes we care about
    const cols = correctedOrders.columns;
    const orderColIndex = cols.indexOf("Order#");
    const totalColIndex = cols.indexOf("Total");
    const correctedColIndex = cols.indexOf("Corrected Total");

    // Excel row 1 (r = 0) is header; data starts at r = 1
    correctedOrders.rows.forEach((row, rowIdx) => {
      const orderVal = row["Order#"];
      const status = statusByOrder[String(orderVal)];
      if (!status) return; // no info, skip

      let fillRgb = null;
      if (status === "mismatch") {
        // light red
        fillRgb = "FFFFC7CE";
      } else if (status === "ok") {
        // light green
        fillRgb = "FFC6EFCE";
      }

      if (!fillRgb) return;

      const applyFill = (colIndex) => {
        if (colIndex < 0) return;
        const addr = XLSX.utils.encode_cell({
          r: rowIdx + 1, // +1 for header row
          c: colIndex,
        });
        if (!ws[addr]) {
          ws[addr] = { t: "n", v: row[cols[colIndex]] ?? "" };
        }
        ws[addr].s = ws[addr].s || {};
        ws[addr].s.fill = {
          patternType: "solid",
          fgColor: { rgb: fillRgb },
        };
      };

      // Color the original Total column
      applyFill(totalColIndex);
      // And also the Corrected Total column if you want that colored too
      applyFill(correctedColIndex);
    });

    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, "Orders_tracking_corrected.xlsx");
  };

  return (
    <div className="App">
      {/* Top buttons */}
      <div className="controls">
        <button className="button" onClick={handleRunCheck}>
          Run check
        </button>
        <button className="button secondary" onClick={handleDownload}>
          Download corrected Orders file
        </button>
        {message && <div className="status-message">{message}</div>}
      </div>

      {/* Upload tables */}
      <div className="side-by-side">
        <Table title="Orders tracking & costs" onDataChange={setOrdersFile} />
        <Table title="October prices" onDataChange={setPricesFile} />
      </div>

      {/* Results table */}
      {results && results.length > 0 && (
        <div className="results-wrapper">
          <div className="results-header">
            <h2>Order check results</h2>
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
              Sort by Order# (
              {resultsSortDir === "asc" ? "Ascending" : "Descending"})
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
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr
                    key={r.order}
                    className={r.status === "mismatch" ? "row-red" : "row-green"}
                  >
                    <td>{r.order}</td>
                    <td>{r.country}</td>
                    <td>{r.baseTotal.toFixed(2)}</td>
                    <td>{r.upsellTotal.toFixed(2)}</td>
                    <td>{r.expectedTotal.toFixed(2)}</td>
                    <td>
                      {isNaN(r.reportedTotal)
                        ? ""
                        : r.reportedTotal.toFixed(2)}
                    </td>
                    <td>
                      {isNaN(r.difference) ? "" : r.difference.toFixed(2)}
                    </td>
                    <td>{r.status === "mismatch" ? "❌ mismatch" : "✅ ok"}</td>
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
