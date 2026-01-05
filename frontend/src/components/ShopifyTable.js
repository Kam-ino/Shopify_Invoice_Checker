import React, { useMemo, useState, useEffect } from "react";

export default function ShopifyTable({ orders: ordersProp, data, title }) {
  const [expanded, setExpanded] = useState(true);

  const orders = useMemo(() => {
    if (Array.isArray(ordersProp)) return ordersProp;
    if (Array.isArray(data?.orders)) return data.orders;
    if (Array.isArray(data)) return data;
    return [];
  }, [ordersProp, data]);

  const rowsPerPage = 10;

  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");

  useEffect(() => {
    setPage(1);
  }, [orders]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(orders.length / rowsPerPage));
  const safePage = Math.min(Math.max(page, 1), totalPages);

  const start = (safePage - 1) * rowsPerPage;
  const paginatedOrders = orders.slice(start, start + rowsPerPage);

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

  return (
    <div className="wrapper">
      <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {title}
        <button className="button-small" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide" : "Show"}
        </button>
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
        {orders.length > 0 ? (
          <>
            {/* ✅ Pagination on top */}
            {totalPages > 1 && <PaginationBar />}

            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order Number</th>
                    <th>Customer Name</th>
                    <th>Address</th>
                    <th>Country</th>
                    <th>Line Items</th>
                    <th>Variant</th>
                    <th>Quantity</th>
                  </tr>
                </thead>

                <tbody>
                  {paginatedOrders.map((order) => {
                    const customer = order?.customer ?? null;
                    const billing = order?.billingAddress ?? null;
                    const edges = (order?.lineItems?.edges ?? []).filter(
                      (e) => !(e?.node?.title || "").toLowerCase().includes("e-book")
                    );
                    const customerName = customer
                      ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() ||
                        customer.email ||
                        "N/A"
                      : "N/A";

                    const addressHtml = `
                      <strong>Address 1:</strong> ${billing?.address1 ?? "N/A"} <br />
                      <strong>Address 2:</strong> ${billing?.address2 ?? "N/A"} <br />
                      <strong>City:</strong> ${billing?.city ?? "N/A"} <br />
                      <strong>Province:</strong> ${billing?.province ?? "N/A"} <br />
                      <strong>Zip:</strong> ${billing?.zip ?? "N/A"} <br />
                      <strong>Country:</strong> ${billing?.country ?? "N/A"}
                    `;

                    const lineItems = edges.map((item, index) => (
                      <div key={index}>{item?.node?.title ?? "N/A"}</div>
                    ));

                    const variants = edges.map((item, index) => (
                      <div key={index}>{item?.node?.variant?.title ?? "N/A"}</div>
                    ));

                    const quantities = edges.map((item, index) => (
                      <div key={index}>{item?.node?.quantity ?? "N/A"}</div>
                    ));

                    return (
                      <tr key={order?.id ?? order?.name}>
                        <td>{order?.name ?? "N/A"}</td>
                        <td>{customerName}</td>
                        <td dangerouslySetInnerHTML={{ __html: addressHtml }} />
                        <td>{billing?.country ?? "N/A"}</td>
                        <td>{lineItems}</td>
                        <td>{variants}</td>
                        <td>{quantities}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p>Loading…</p>
        )}
      </div>
    </div>
  );
}
