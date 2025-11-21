import './App.css';
import { useState } from 'react';
import Table from './components/table';

function App() {
  const [leftData, setLeftData] = useState([]);
  const [rightData, setRightData] = useState([]);

  // Search state
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightLeftId, setHighlightLeftId] = useState(null);
  const [highlightRightId, setHighlightRightId] = useState(null);

  // Info for the side container
  const [searchInfo, setSearchInfo] = useState(null);

  const idKey = 'ORDER NUMBER';

  const normalize = (value) => {
    if (value == null) return '';
    return String(value).replace(/[^0-9A-Za-z]/g, '').trim();
  };

  const handleSearch = (e) => {
    e.preventDefault();

    const query = searchTerm.trim();
    if (!query) {
      setHighlightLeftId(null);
      setHighlightRightId(null);
      setSearchInfo(null);
      return;
    }

    const normalizedQuery = normalize(query);

    // If nothing uploaded yet
    if (!leftData.length && !rightData.length) {
      setHighlightLeftId(null);
      setHighlightRightId(null);
      setSearchInfo({
        query,
        foundInLeft: false,
        foundInRight: false,
        shopifyMatches: [],
        message: 'Please upload both tables before searching.',
      });
      return;
    }

    const foundInLeft = leftData.some(
      (row) => normalize(row[idKey]) === normalizedQuery
    );
    const foundInRight = rightData.some(
      (row) => normalize(row[idKey]) === normalizedQuery
    );

    const shopifyMatches = rightData.filter(
      (row) => normalize(row[idKey]) === normalizedQuery
    );

    setHighlightLeftId(foundInLeft ? normalizedQuery : null);
    setHighlightRightId(foundInRight ? normalizedQuery : null);

    let message;
    if (!foundInLeft && !foundInRight) {
      message = `Order ${query} was not found in either table.`;
    } else {
      const parts = [];
      parts.push(foundInLeft ? 'Found in INVOICE' : 'Missing in INVOICE');
      parts.push(foundInRight ? 'Found in SHOPIFY' : 'Missing in SHOPIFY');
      message = `${parts.join(' | ')} for order ${query}.`;
    }

    setSearchInfo({
      query,
      foundInLeft,
      foundInRight,
      shopifyMatches,
      message,
    });
  };

  const clearSearch = () => {
    setSearchTerm('');
    setHighlightLeftId(null);
    setHighlightRightId(null);
    setSearchInfo(null);
  };

  // Colors for the INVOICE / SHOPIFY cells in the top 1x2 grid
  const invoiceCellColor = searchInfo
    ? searchInfo.foundInLeft
      ? '#31ca31'
      : '#f12222'
    : '#cccccc';

  const shopifyCellColor = searchInfo
    ? searchInfo.foundInRight
      ? '#31ca31'
      : '#f12222'
    : '#cccccc';

  return (
    <div className="App">
      <div className='side-by-side'>
        <div className="search-container">
          <form onSubmit={handleSearch} className="search-form">
            <div className="Card">
              <div className="CardInner">
                <label htmlFor="order-search">
                  Search by {idKey}
                </label>

                <div className="SearchCard-container">
                  <div className="Icon">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#657789"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="feather feather-search"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>

                  <div className="InputContainer">
                    <input
                      id="order-search"
                      placeholder="Enter order number..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <button type="submit" className="button search-card-button">
              Search
            </button>

            {searchTerm && (
              <button
                type="button"
                className="button secondary search-card-button"
                onClick={clearSearch}
              >
                Clear
              </button>
            )}
          </form>
        </div>
      </div>

      <div className="main-layout">
        <div className="tables-column">
          <div className="side-by-side">
            <div className="top-bottom">
              <Table
                title="INVOICE (SAMPLE)"
                idKey={idKey}
                uploadId="invoice-upload"
                onDataChange={setLeftData}
                enableSorting={true}
                highlightValue={highlightLeftId}
              />
              <Table
                title="SHOPIFY (SAMPLE)"
                idKey={idKey}
                uploadId="shopify-upload"
                onDataChange={setRightData}
                enableSorting={true}
                highlightValue={highlightRightId}
              />
            </div>
            <div className="search-panel">
              <div className="search-popup">
                <div className="search-popup-grid">
                  <div
                    className="search-popup-cell"
                    style={{ backgroundColor: invoiceCellColor }}
                  >
                    INVOICE
                  </div>
                  <div
                    className="search-popup-cell"
                    style={{ backgroundColor: shopifyCellColor }}
                  >
                    SHOPIFY
                  </div>
                </div>

                <div className="search-popup-body">
                  {searchInfo ? (
                    <>
                      <p>
                        <strong>Order:</strong> {searchInfo.query}
                      </p>
                      <p className="search-popup-message">{searchInfo.message}</p>

                      {searchInfo.shopifyMatches &&
                      searchInfo.shopifyMatches.length > 0 ? (
                        <>
                          <h4>Shopify details</h4>
                          <div className="search-popup-details">
                            {Object.entries(searchInfo.shopifyMatches[0]).map(
                              ([key, value]) => (
                                <div className="detail-row" key={key}>
                                  <span className="detail-key">{key}</span>
                                  <span className="detail-value">
                                    {value != null ? String(value) : ''}
                                  </span>
                                </div>
                              )
                            )}
                          </div>
                        </>
                      ) : (
                        <p>No Shopify data found for this order.</p>
                      )}
                    </>
                  ) : (
                    <p>Search for an order above to see Shopify details here.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>


      </div>
    </div>
  );
}

export default App;
