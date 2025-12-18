<<<<<<< Updated upstream
import { useState } from "react";
import * as XLSX from "xlsx";

function Table({ title, onDataChange }) {
  const [rows, setRows] = useState(null);
  const [columns, setColumns] = useState([]);
  const [typeError, setTypeError] = useState(null);
=======
import { useState, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";

function Table({ title, onDataChange, builtIn, rows, columns }) {
  const [localRows, setLocalRows] = useState([]);
  const [localCols, setLocalCols] = useState([]);
  const [error, setError] = useState(null);

  // Pagination
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const rowsPerPage = 20;

  // Expand / collapse
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (builtIn && rows && columns) {
      setLocalRows(rows);
      setLocalCols(columns);
    }
  }, [builtIn, rows, columns]);
>>>>>>> Stashed changes

  const allowedFileTypes = [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ];

  const handleFile = (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    if (!allowedFileTypes.includes(selectedFile.type)) {
      setTypeError("Please select an Excel or CSV file");
      setRows(null);
      setColumns([]);
      onDataChange && onDataChange(null);
      return;
    }

    setTypeError(null);

    const reader = new FileReader();
    reader.readAsArrayBuffer(selectedFile);
    reader.onload = (event) => {
      try {
        const buffer = event.target.result;
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Read as array-of-arrays to preserve exact column order
        const rowsAsArrays = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: "",
        });

        if (!rowsAsArrays.length) {
          setRows([]);
          setColumns([]);
          onDataChange && onDataChange(null);
          return;
        }

        const headerRow = rowsAsArrays[0];
        const headers = headerRow.map((h, idx) =>
          h !== undefined && h !== null && String(h) !== ""
            ? String(h) // keep original header exactly
            : `Column ${idx + 1}`
        );

        const dataRows = rowsAsArrays.slice(1).map((rowArr) => {
          const obj = {};
          headers.forEach((header, i) => {
            obj[header] = rowArr[i];
          });
          return obj;
        });

        setColumns(headers);
        setRows(dataRows);
        onDataChange && onDataChange({ rows: dataRows, columns: headers });
      } catch (err) {
        console.error("Error reading file", err);
        setTypeError("There was a problem reading this file.");
        setRows(null);
        setColumns([]);
        onDataChange && onDataChange(null);
      }
    };
  };

<<<<<<< Updated upstream
=======
  const lower = (s) => String(s || "").toLowerCase();
  const norm = (v) => String(v ?? "").trim();

  // Find Order# column
  const orderKey = useMemo(() => {
    if (!localCols?.length) return null;

    const preferred = ["order#", "order #", "order number", "ordernumber", "order"];
    for (const name of preferred) {
      const hit = localCols.find((c) => lower(c) === name);
      if (hit) return hit;
    }
    const fallback = localCols.find((c) => lower(c).includes("order"));
    return fallback || null;
  }, [localCols]);

  // Find "Item name" column (to split into Line Items + Variant)
  const itemNameKey = useMemo(() => {
    if (!localCols?.length) return null;
    const exact = localCols.find((c) => lower(c) === "item name");
    if (exact) return exact;
    return localCols.find((c) => lower(c).includes("item") && lower(c).includes("name")) || null;
  }, [localCols]);

  // Columns to render (replace Item name -> Line Items + Variant)
  const displayCols = useMemo(() => {
    if (!localCols?.length) return [];

    if (!itemNameKey) return localCols;

    const out = [];
    for (const c of localCols) {
      if (c === itemNameKey) {
        out.push("Line Items");
        out.push("Variant");
      } else {
        out.push(c);
      }
    }
    return out;
  }, [localCols, itemNameKey]);

  // Grouping + merging rows by order number
  const groupedRows = useMemo(() => {
    if (!localRows?.length) return [];
    if (!orderKey) return localRows;

    const map = new Map();
    for (const r of localRows) {
      const keyVal = norm(r?.[orderKey]);
      const key = keyVal || "__NO_ORDER__";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }

    const uniqueKeepOrder = (arr) => {
      const out = [];
      const seen = new Set();
      for (const v of arr) {
        const s = norm(v);
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    };

    const isLineItemColumn = (colName) => {
      const c = lower(colName);
      return (
        c.includes("line items") ||
        c.includes("variant") ||
        c.includes("sku") ||
        c === "qty" ||
        c.includes("quantity") ||
        (itemNameKey && colName === itemNameKey)
      );
    };

    const splitItemName = (raw) => {
      let s = norm(raw);
      if (!s) return { base: "", variant: "" };

      // If sheet sometimes has "2 <name> - <variant>" remove small leading counters like "2 "
      // (keeps product codes safe; only strips 1..9)
      const m = s.match(/^([1-9])\s+(.*)$/);
      if (m) s = m[2];

      // Split on LAST " - " so titles that contain hyphens still work
      const idx = s.lastIndexOf(" - ");
      if (idx === -1) return { base: s, variant: "" };

      const base = s.slice(0, idx).trim();
      const variant = s.slice(idx + 3).trim();
      return { base, variant };
    };

    const merged = [];
    for (const [key, rowsArr] of map.entries()) {
      const m = {};
      m[orderKey] = key === "__NO_ORDER__" ? "" : key;

      // If we have Item name, we will build Line Items + Variant arrays aligned to row count
      let lineItemsArr = null;
      let variantsArr = null;

      if (itemNameKey) {
        lineItemsArr = [];
        variantsArr = [];
        for (const rr of rowsArr) {
          const { base, variant } = splitItemName(rr?.[itemNameKey]);
          if (base) lineItemsArr.push(base);
          if (variant) variantsArr.push(variant);
          else variantsArr.push(""); // keep alignment
        }
      }

      for (const col of localCols) {
        if (col === orderKey) continue;
        if (itemNameKey && col === itemNameKey) continue; // we replace it

        const values = rowsArr.map((rr) => rr?.[col]);

        if (isLineItemColumn(col)) {
          const kept = values.map(norm).filter((v) => v !== "");
          m[col] = kept.length <= 1 ? (kept[0] ?? "") : kept;
        } else {
          const cleaned = uniqueKeepOrder(values);
          m[col] = cleaned.length <= 1 ? (cleaned[0] ?? "") : cleaned;
        }
      }

      if (itemNameKey) {
        const liClean = lineItemsArr.map(norm).filter((v) => v !== "");
        const vaClean = variantsArr.map(norm).filter((v) => v !== "");

        m["Line Items"] = liClean.length <= 1 ? (liClean[0] ?? "") : liClean;

        // Keep variants aligned visually: if all empty, just show empty
        const anyVariant = variantsArr.some((v) => norm(v) !== "");
        if (!anyVariant) {
          m["Variant"] = "";
        } else {
          m["Variant"] = variantsArr.length <= 1 ? (variantsArr[0] ?? "") : variantsArr;
        }
      }

      merged.push(m);
    }

    return merged;
  }, [localRows, localCols, orderKey, itemNameKey]);

  useEffect(() => {
    setPage(1);
  }, [groupedRows]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(groupedRows.length / rowsPerPage));
  const safePage = Math.min(Math.max(page, 1), totalPages);

  const start = (safePage - 1) * rowsPerPage;
  const paginatedRows = groupedRows.slice(start, start + rowsPerPage);

  const clampPage = (n) => Math.max(1, Math.min(n, totalPages));

  const handlePageInputChange = (value) => {
    setPageInput(value);
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return;
    setPage(clampPage(n));
  };

  const PaginationBar = () => (
    <div
      className="pagination-controls"
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        flexWrap: "wrap",
        margin: "10px 0 14px",
      }}
    >
      <button className="button-small" disabled={safePage === 1} onClick={() => setPage(1)}>
        First
      </button>

      <button className="button-small" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>
        Previous
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#fff", whiteSpace: "nowrap" }}>
          Page {safePage} / {totalPages}
        </span>

        <input
          type="number"
          min="1"
          max={totalPages}
          value={pageInput}
          onChange={(e) => handlePageInputChange(e.target.value)}
          onBlur={() => {
            const n = parseInt(pageInput, 10);
            if (!Number.isFinite(n)) setPageInput(String(safePage));
            else setPageInput(String(clampPage(n)));
          }}
          style={{ width: 90, padding: "6px 8px" }}
        />
      </div>

      <button
        className="button-small"
        disabled={safePage === totalPages}
        onClick={() => setPage(safePage + 1)}
      >
        Next
      </button>

      <button className="button-small" disabled={safePage === totalPages} onClick={() => setPage(totalPages)}>
        Last
      </button>
    </div>
  );

>>>>>>> Stashed changes
  return (
    <div className="wrapper">
      <h3>{title}</h3>

<<<<<<< Updated upstream
      <form
        className="form-group custom-form"
        onSubmit={(e) => e.preventDefault()}
      >
        <input
          type="file"
          id={title}
          className="form-control"
          onChange={handleFile}
          style={{ display: "none" }}
        />
        <label htmlFor={title} className="button">
          UPLOAD FILE
        </label>

        {typeError && (
          <div className="alert alert-danger" role="alert">
            {typeError}
          </div>
        )}
      </form>

      <div className="viewer">
        {rows && rows.length > 0 ? (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 9999).map((row, index) => (
                  <tr key={index}>
                    {columns.map((col) => (
                      <td key={col}>{row[col]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
=======
        {builtIn && (
          <button className="button-small" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide" : "Show"}
          </button>
        )}

        {!builtIn && (
          <form className="custom-form" onSubmit={(e) => e.preventDefault()}>
            <input type="file" id={title} style={{ display: "none" }} onChange={handleFile} />
            <label htmlFor={title} className="button">
              UPLOAD FILE
            </label>
            {error && <div className="alert alert-danger">{error}</div>}
          </form>
        )}
      </h3>

      <div
        className="viewer"
        style={{
          display: "block",
          maxHeight: expanded ? "600px" : "0px",
          overflowY: expanded ? "auto" : "hidden",
          overflowX: "auto",
          transition: "max-height 0.3s ease-in-out",
        }}
      >
        {groupedRows && groupedRows.length > 0 ? (
          <>
            {totalPages > 1 && <PaginationBar />}

            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    {displayCols.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {paginatedRows.map((row, i) => (
                    <tr key={i}>
                      {displayCols.map((c) => {
                        const value = row?.[c];

                        // render arrays stacked (like ShopifyTable)
                        if (Array.isArray(value)) {
                          return (
                            <td key={c}>
                              {value.map((v, idx) => (
                                <div key={idx}>{v}</div>
                              ))}
                            </td>
                          );
                        }

                        return <td key={c}>{value ?? ""}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
>>>>>>> Stashed changes
        ) : (
          <p>No file is uploaded yet.</p>
        )}
      </div>
    </div>
  );
}

export default Table;
