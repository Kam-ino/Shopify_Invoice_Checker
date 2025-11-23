import { useState } from "react";
import * as XLSX from "xlsx";

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

  return (
    <div className="wrapper">
      <h3>{title}</h3>

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
        ) : (
          <p>No file is uploaded yet.</p>
        )}
      </div>
    </div>
  );
}

export default Table;
