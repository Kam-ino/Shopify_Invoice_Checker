import './App.css';
import { useState, useMemo } from 'react';
import Table from './components/table';

function App() {
  const [leftData, setLeftData] = useState([]);
  const [rightData, setRightData] = useState([]);

  // Search state
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightLeftId, setHighlightLeftId] = useState(null);
  const [highlightRightId, setHighlightRightId] = useState(null);
  const [searchStatus, setSearchStatus] = useState('');

  const idKey = 'ORDER NUMBER'; // must match the column name in your Excel

  const normalize = (value) => {
    if (value == null) return '';
    return String(value).trim();
  };

  const comparison = useMemo(() => {
    if (!leftData.length || !rightData.length) return null;

    const leftIds = new Set(leftData.map(row => row[idKey]));
    const rightIds = new Set(rightData.map(row => row[idKey]));

    const inLeftNotRight = leftData.filter(row => !rightIds.has(row[idKey]));
    const inRightNotLeft = rightData.filter(row => !leftIds.has(row[idKey]));
    const inBoth = leftData.filter(row => rightIds.has(row[idKey]));

    return { inLeftNotRight, inRightNotLeft, inBoth };
  }, [leftData, rightData, idKey]);

  const handleSearch = (e) => {
    e.preventDefault();

    const query = searchTerm.trim();
    if (!query) {
      setHighlightLeftId(null);
      setHighlightRightId(null);
      setSearchStatus('Please enter an order number to search.');
      return;
    }

    // If no data uploaded yet
    if (!leftData.length && !rightData.length) {
      setHighlightLeftId(null);
      setHighlightRightId(null);
      setSearchStatus('Please upload both tables before searching.');
      return;
    }

    const normalizedQuery = normalize(query);

    const foundInLeft = leftData.some(
      (row) => normalize(row[idKey]) === normalizedQuery
    );
    const foundInRight = rightData.some(
      (row) => normalize(row[idKey]) === normalizedQuery
    );

    setHighlightLeftId(foundInLeft ? normalizedQuery : null);
    setHighlightRightId(foundInRight ? normalizedQuery : null);

    if (!foundInLeft && !foundInRight) {
      // Missing in both → popup message
      setSearchStatus(`Order ${query} was not found in either table.`);
    } else {
      // Found in at least one table
      const parts = [];
      parts.push(
        foundInLeft
          ? 'Found in INVOICE'
          : 'Missing in INVOICE'
      );
      parts.push(
        foundInRight
          ? 'Found in SHOPIFY'
          : 'Missing in SHOPIFY'
      );
      setSearchStatus(`${parts.join(' | ')} for order ${query}.`);
    }
  };

  const clearSearch = () => {
    setSearchTerm('');
    setHighlightLeftId(null);
    setHighlightRightId(null);
    setSearchStatus('');
  };

  return (
    <div className="App">
      {/* Search UI */}
      <div className="search-container">
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder={`Search by ${idKey}`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          <button type="submit" className="button">
            Search
          </button>
          {searchTerm && (
            <button
              type="button"
              className="button secondary"
              onClick={clearSearch}
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Tables */}
      <div className="side-by-side">
        <Table
          title="INVOICE"
          idKey={idKey}
          onDataChange={setLeftData}
          enableSorting={true}
          highlightValue={highlightLeftId}
        />
        <Table
          title="SHOPIFY"
          idKey={idKey}
          onDataChange={setRightData}
          enableSorting={true}
          highlightValue={highlightRightId}
        />
      </div>

      {/* Comparison summary */}
      <div className="comparison">
        <h2>Comparison by {idKey}</h2>
        {!comparison ? (
          <p>Upload both files to see the comparison.</p>
        ) : (
          <>
            <p>Only in INVOICE: {comparison.inLeftNotRight.length}</p>
            <p>Only in SHOPIFY: {comparison.inRightNotLeft.length}</p>
            <p>Present in both: {comparison.inBoth.length}</p>

            <h3>IDs only in INVOICE</h3>
            <ul>
              {comparison.inLeftNotRight.map((row, i) => (
                <li key={i}>{row[idKey]}</li>
              ))}
            </ul>

            <h3>IDs only in SHOPIFY</h3>
            <ul>
              {comparison.inRightNotLeft.map((row, i) => (
                <li key={i}>{row[idKey]}</li>
              ))}
            </ul>

            <h3>IDs in both</h3>
            <ul>
              {comparison.inBoth.map((row, i) => (
                <li key={i}>{row[idKey]}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Side popup for search status */}
      {searchStatus && (
        <div className="search-popup">
          {searchStatus}
        </div>
      )}
    </div>
  );
}

export default App;
