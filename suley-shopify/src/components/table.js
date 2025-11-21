import { useState } from "react";
import * as XLSX from "xlsx";

function Table({
  title = "Upload & View Excel Sheets",
  idKey = "ID",
  uploadId = "upload-input",
  onDataChange,
  enableSorting = true,
  highlightValue, // normalized order number from App.js
}) {
  const [typeError, setTypeError] = useState(null);
  const [rows, setRows] = useState(null);       // data rows
  const [columns, setColumns] = useState([]);   // header order
  const [sortDirection, setSortDirection] = useState("asc");

  const allowedFileTypes = [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ];

  const normalize = (value) => {
    if (value == null) return "";
    return String(value).replace(/[^0-9A-Za-z]/g, "").trim();
  };

  // Auto-upload & parse on file select
  const handleFile = (e) => {
    const selectedFile = e.target.files[0];

    if (!selectedFile) return;

    if (!allowedFileTypes.includes(selectedFile.type)) {
      setTypeError("Please select only Excel or CSV file types");
      setRows(null);
      setColumns([]);
      if (onDataChange) onDataChange([]);
      return;
    }

    setTypeError(null);

    const reader = new FileReader();
    reader.readAsArrayBuffer(selectedFile);
    reader.onload = (event) => {
      const buffer = event.target.result;
      try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const worksheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[worksheetName];

        // Read as arrays so we preserve the exact column order
        const rowsAsArrays = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,   // first row is headers
          defval: "",  // keep empty cells as ""
        });

        if (!rowsAsArrays.length) {
          setRows([]);
          setColumns([]);
          if (onDataChange) onDataChange([]);
          return;
        }

        const headerRow = rowsAsArrays[0];
        const headers = headerRow.map((h, idx) =>
          h && String(h).trim() !== "" ? String(h) : `Column ${idx + 1}`
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
        if (onDataChange) {
          onDataChange(dataRows);
        }
      } catch (err) {
        console.error("Error reading file", err);
        setTypeError(
          "There was a problem reading this file. Please check the format."
        );
        setRows(null);
        setColumns([]);
        if (onDataChange) onDataChange([]);
      }
    };
  };

  const toggleSortDirection = () => {
    setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
  };

  const getSortedRows = () => {
    if (!rows) return null;
    if (!rows.length) return [];

    let dataCopy = [...rows];

    // Sort by ID column if it exists
    if (columns.includes(idKey)) {
      dataCopy.sort((a, b) => {
        const aStr = normalize(a[idKey]);
        const bStr = normalize(b[idKey]);

        const numA = Number(aStr);
        const numB = Number(bStr);

        if (!isNaN(numA) && !isNaN(numB)) {
          // numeric sort
          return sortDirection === "asc" ? numA - numB : numB - numA;
        }

        // string sort fallback
        if (sortDirection === "asc") {
          return aStr.localeCompare(bStr);
        } else {
          return bStr.localeCompare(aStr);
        }
      });
    }

    // If a search highlight is set, move the matching row(s) to the top
    if (highlightValue != null && highlightValue !== "") {
      const highlightedRows = [];
      const otherRows = [];

      dataCopy.forEach((row) => {
        const rowIdNormalized = normalize(row[idKey]);
        if (rowIdNormalized === String(highlightValue)) {
          highlightedRows.push(row);
        } else {
          otherRows.push(row);
        }
      });

      dataCopy = [...highlightedRows, ...otherRows];
    }

    return dataCopy;
  };

  const sortedRows = getSortedRows();

  return (
    <div className="wrapper">
      <h3>{title}</h3>

      {/* file upload form (auto-upload on select) */}
      <form
        className="form-group custom-form"
        onSubmit={(e) => e.preventDefault()}
      >
        <input
          type="file"
          id={uploadId}
          className="form-control"
          onChange={handleFile}
          style={{ display: "none" }}
        />
        <label htmlFor={uploadId} className="button">
          UPLOAD
        </label>

        {typeError && (
          <div className="alert alert-danger" role="alert">
            {typeError}
          </div>
        )}
      </form>

      {rows && enableSorting && (
        <button
          type="button"
          className="button"
          onClick={toggleSortDirection}
          style={{ marginTop: "10px", marginBottom: "10px" }}
        >
          Sort by {idKey} ({sortDirection === "asc" ? "Ascending" : "Descending"}
          )
        </button>
      )}

      {/* view data */}
      <div className="viewer">
        {sortedRows && sortedRows.length > 0 ? (
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
                {sortedRows.map((row, index) => {
                  const isHighlighted =
                    highlightValue != null &&
                    normalize(row[idKey]) === String(highlightValue);

                  return (
                    <tr
                      key={index}
                      className={isHighlighted ? "highlight-row" : ""}
                      style={
                        isHighlighted
                          ? { backgroundColor: "#c8f7c5" } // light green
                          : {}
                      }
                    >
                      {columns.map((col) => (
                        <td key={col}>{row[col]}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div>No File is uploaded yet!</div>
        )}
      </div>
    </div>
  );
}

export default Table;
