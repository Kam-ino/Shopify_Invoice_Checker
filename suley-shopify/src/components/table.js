import { useState } from "react";
import * as XLSX from 'xlsx';

function Table({
  title = "Upload & View Excel Sheets",
  idKey = "ID",
  onDataChange,
  enableSorting = true,
  highlightValue,          // <- new: order number to bring to top & highlight
}) {
  const [typeError, setTypeError] = useState(null);
  const [excelData, setExcelData] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc'); // 'asc' or 'desc'

  const handleFile = (e) => {
    const fileTypes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ];
    const selectedFile = e.target.files[0];

    if (!selectedFile) {
      return;
    }

    if (!fileTypes.includes(selectedFile.type)) {
      setTypeError('Please select only Excel or CSV file types');
      setExcelData(null);
      if (onDataChange) onDataChange([]);
      return;
    }

    setTypeError(null);

    const reader = new FileReader();
    reader.readAsArrayBuffer(selectedFile);
    reader.onload = (event) => {
      const buffer = event.target.result;
      try {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const worksheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[worksheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        setExcelData(data);
        if (onDataChange) {
          onDataChange(data);
        }
      } catch (err) {
        console.error('Error reading file', err);
        setTypeError('There was a problem reading this file. Please check the format.');
        setExcelData(null);
        if (onDataChange) onDataChange([]);
      }
    };
  };

  const toggleSortDirection = () => {
    setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
  };

  const getSortedData = () => {
    if (!excelData) return null;
    if (!excelData.length) return [];

    let dataCopy = [...excelData];

    // Sort by ID if the column exists
    if (idKey in dataCopy[0]) {
      dataCopy.sort((a, b) => {
        const valA = a[idKey];
        const valB = b[idKey];

        if (valA == null || valB == null) return 0;

        const numA = Number(valA);
        const numB = Number(valB);

        if (!isNaN(numA) && !isNaN(numB)) {
          // numeric sort
          return sortDirection === 'asc' ? numA - numB : numB - numA;
        }

        // string sort fallback
        const strA = String(valA);
        const strB = String(valB);
        if (strA < strB) return sortDirection === 'asc' ? -1 : 1;
        if (strA > strB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    // If a search highlight is set, move the matching row(s) to the top
    if (highlightValue != null) {
      const normalizedHighlight = String(highlightValue).trim();
      const highlightedRows = [];
      const otherRows = [];

      dataCopy.forEach((row) => {
        const rawId = row[idKey];
        const normalizedId =
          rawId != null ? String(rawId).trim() : '';

        if (normalizedId === normalizedHighlight) {
          highlightedRows.push(row);
        } else {
          otherRows.push(row);
        }
      });

      dataCopy = [...highlightedRows, ...otherRows];
    }

    return dataCopy;
  };

  const sortedData = getSortedData();

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
          id="upload"
          className="form-control"
          onChange={handleFile}
          style={{ display: 'none' }}
        />
        <label htmlFor="upload" className="button">
          UPLOAD
        </label>

        {typeError && (
          <div className="alert alert-danger" role="alert">
            {typeError}
          </div>
        )}
      </form>

      {excelData && enableSorting && (
        <button
          type="button"
          className="button"
          onClick={toggleSortDirection}
          style={{ marginTop: '10px', marginBottom: '10px' }}
        >
          Sort by {idKey} ({sortDirection === 'asc' ? 'Ascending' : 'Descending'})
        </button>
      )}

      {/* view data */}
      <div className="viewer">
        {sortedData && sortedData.length > 0 ? (
          <div className="table-responsive">
            <table className="table">
              <thead>
                <tr>
                  {Object.keys(sortedData[0]).map((key) => (
                    <th key={key}>{key}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {sortedData.map((row, index) => {
                  const rawId = row[idKey];
                  const normalizedId =
                    rawId != null ? String(rawId).trim() : '';
                  const isHighlighted =
                    highlightValue != null &&
                    normalizedId === String(highlightValue).trim();

                  return (
                    <tr
                      key={index}
                      className={isHighlighted ? 'highlight-row' : ''}
                      style={
                        isHighlighted
                          ? { backgroundColor: '#c8f7c5' } // light green
                          : {}
                      }
                    >
                      {Object.keys(row).map((key) => (
                        <td key={key}>{row[key]}</td>
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
