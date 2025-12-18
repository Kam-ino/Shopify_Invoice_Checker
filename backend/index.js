require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

const SHOP = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "your-store.myshopify.com"
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

if (!SHOP || !TOKEN) {
  console.error("Missing env vars. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN in backend/.env");
  process.exit(1);
}

const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseOrderNumber(name) {
  // "#19027" -> 19027
  const n = parseInt(String(name || "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

async function shopifyGraphQL(query, variables = {}) {
  const resp = await axios.post(
    GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      timeout: 60_000,
    }
  );

  // GraphQL errors can come back with HTTP 200
  if (resp.data?.errors?.length) {
    const msg = resp.data.errors.map((e) => e.message).join(" | ");
    const lower = msg.toLowerCase();
    const isThrottled = lower.includes("throttled") || lower.includes("throttle");

    if (isThrottled) {
      // Back off a bit and let caller retry
      const throttleStatus = resp.data?.extensions?.cost?.throttleStatus;
      const retryMs = throttleStatus?.restoreRate ? 1200 : 1500;
      const err = new Error(`THROTTLED:${msg}`);
      err.retryMs = retryMs;
      throw err;
    }

    throw new Error(msg);
  }

  return resp.data?.data;
}

async function getAccessScopesViaGraphQL() {
  const query = `
    query {
      currentAppInstallation {
        accessScopes { handle }
      }
    }
  `;

  try {
    const data = await shopifyGraphQL(query);
    return data?.currentAppInstallation?.accessScopes?.map((s) => s.handle) ?? [];
  } catch (e) {
    console.warn("Could not read access scopes via GraphQL:", e.message);
    return null;
  }
}

async function fetchAllOrders({
  searchQuery = "status:any",
  stopAtOrderNumber = null,
  maxPages = null,
} = {}) {
  const QUERY = `
    query Orders($first: Int!, $after: String, $query: String!) {
      orders(
        first: $first,
        after: $after,
        query: $query,
        sortKey: CREATED_AT,
        reverse: true
      ) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus

            customer { firstName lastName email }

            billingAddress {
              address1
              address2
              city
              province
              country
              zip
            }

            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  fulfillableQuantity
                  fulfillmentStatus
                  variant { id title }
                }
              }
            }
          }
        }
      }
    }
  `;

  let after = null;
  const all = [];
  let pages = 0;

  while (true) {
    try {
      const data = await shopifyGraphQL(QUERY, {
        first: 250,
        after,
        query: searchQuery,
      });

      const conn = data?.orders;
      if (!conn) throw new Error("No orders connection returned.");

      const batch = conn.edges.map((e) => e.node);
      all.push(...batch);
      pages++;

      // Optional safety: stop after N pages (debug)
      if (Number.isFinite(maxPages) && maxPages > 0 && pages >= maxPages) break;

      // Optional early stop when we reach a specific order number (e.g. 18000)
      if (stopAtOrderNumber != null) {
        // Because we paginate from newest -> older, once we SEE <= stopAt, we can stop.
        const hit = batch.some((o) => {
          const num = parseOrderNumber(o.name);
          return num != null && num <= stopAtOrderNumber;
        });
        if (hit) break;
      }

      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    } catch (e) {
      // Throttling retry
      if (String(e.message || "").startsWith("THROTTLED:")) {
        await sleep(e.retryMs || 1500);
        continue;
      }
      throw e;
    }
  }

  return { orders: all, pages };
}

// --- Routes ---

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// GET /api/orders
// Optional query params:
//   q=status:any
//   stopAt=18000         (stop once we reach order number <= 18000)
//   maxPages=10          (debug)
app.get("/api/orders", async (req, res) => {
  try {
    const q = (req.query.q && String(req.query.q).trim()) || "status:any";

    const stopAt = req.query.stopAt ? Number(req.query.stopAt) : null;
    const stopAtOrderNumber = Number.isFinite(stopAt) ? stopAt : null;

    const maxPagesRaw = req.query.maxPages ? Number(req.query.maxPages) : null;
    const maxPages = Number.isFinite(maxPagesRaw) ? maxPagesRaw : null;

    const result = await fetchAllOrders({
      searchQuery: q,
      stopAtOrderNumber,
      maxPages,
    });

    res.json({
      count: result.orders.length,
      pages: result.pages,
      orders: result.orders,
    });
  } catch (err) {
    console.error("API /api/orders error:", err.message || err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

// --- Start ---
app.listen(PORT, async () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Orders endpoint: http://localhost:${PORT}/api/orders`);

  const scopes = await getAccessScopesViaGraphQL();
  if (scopes) {
    console.log("Token scopes:", scopes.join(", "));
    if (!scopes.includes("read_all_orders")) {
      console.warn(
        "WARNING: Token is missing read_all_orders. You must reinstall/reauthorize the app to generate a NEW token."
      );
    }
  }
});
