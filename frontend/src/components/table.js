import { useState } from "react";
import * as XLSX from "xlsx";

function makeUniqueHeaders(headerRow) {
  const counts = new Map();
  return (headerRow || []).map((h, idx) => {
    const base =
      h !== undefined && h !== null && String(h).trim() !== ""
        ? String(h).trim()
        : `Column ${idx + 1}`;

    const n = counts.get(base) || 0;
    counts.set(base, n + 1);

    // "SKU", "SKU.1", "SKU.2" ...
    return n === 0 ? base : `${base}.${n}`;
  });
}

function Table({ title, onDataChange }) {
  const [rows, setRows] = useState(null);
  const [columns, setColumns] = useState([]);
  const [typeError, setTypeError] = useState(null);

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

        // ✅ Make headers unique so React keys + object keys never collide
        const headerRow = rowsAsArrays[0];
        const headers = makeUniqueHeaders(headerRow);

        const dataRows = rowsAsArrays.slice(1).map((rowArr) => {
          const obj = {};
          headers.forEach((header, i) => {
            obj[header] = rowArr[i];
          });
          return obj;
        });

        setColumns(headers);
        setRows(dataRows);

        // ✅ pass file + buffer so App.js can do multi-sheet parsing + corrected download
        onDataChange &&
          onDataChange({
            rows: dataRows,
            columns: headers,
            file: selectedFile,
            arrayBuffer: buffer,
          });
      } catch (err) {
        console.error("Error reading file", err);
        setTypeError("There was a problem reading this file.");
        setRows(null);
        setColumns([]);
        onDataChange && onDataChange(null);
      }
    };
  };

  return (
    <div className="wrapper">
      <h3>{title}</h3>

      <form className="form-group custom-form" onSubmit={(e) => e.preventDefault()}>
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
                  {columns.map((col, colIndex) => (
                    <th key={`${col}-${colIndex}`}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 9999).map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {columns.map((col, colIndex) => (
                      <td key={`${rowIndex}-${col}-${colIndex}`}>{row[col]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No file is uploaded yet.</p>
        )}
      </div>
    </div>
  );
}

export default Table;
