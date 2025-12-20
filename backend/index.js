require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

const STORES = {
  bloomommy: {
    domainEnv: "BLOOMOMMY_SHOPIFY_STORE_DOMAIN",
    clientIdEnv: "BLOOMOMMY_SHOPIFY_CLIENT_ID",
    clientSecretEnv: "BLOOMOMMY_SHOPIFY_CLIENT_SECRET",
    accessTokenEnv: "BLOOMOMMY_SHOPIFY_ACCESS_TOKEN",
  },
  cellumove: {
    domainEnv: "CELLUMOVE_SHOPIFY_STORE_DOMAIN",
    clientIdEnv: "CELLUMOVE_SHOPIFY_CLIENT_ID",
    clientSecretEnv: "CELLUMOVE_SHOPIFY_CLIENT_SECRET",
    accessTokenEnv: "CELLUMOVE_SHOPIFY_ACCESS_TOKEN",
  },
  yuma: {
    domainEnv: "YUMA_SHOPIFY_STORE_DOMAIN",
    clientIdEnv: "YUMA_SHOPIFY_CLIENT_ID",
    clientSecretEnv: "YUMA_SHOPIFY_CLIENT_SECRET",
    accessTokenEnv: "YUMA_SHOPIFY_ACCESS_TOKEN",
  },
};

// storeKey -> { token, expiresAtMs }
const tokenCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envTrim(name) {
  return String(process.env[name] || "").trim();
}
function mustEnv(name) {
  const v = envTrim(name);
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}
function tokenSuffix(token) {
  const t = String(token || "");
  return t.length >= 6 ? t.slice(-6) : t;
}

function getStoreCfg(storeKeyRaw) {
  const storeKey = String(storeKeyRaw || "bloomommy").toLowerCase();
  const cfg = STORES[storeKey];
  if (!cfg) {
    throw new Error(`Invalid store "${storeKey}". Use: ${Object.keys(STORES).join(", ")}`);
  }

  const domain = mustEnv(cfg.domainEnv);
  const staticToken = envTrim(cfg.accessTokenEnv);
  const clientId = envTrim(cfg.clientIdEnv);
  const clientSecret = envTrim(cfg.clientSecretEnv);

  return { storeKey, domain, staticToken, clientId, clientSecret };
}

async function fetchClientCredentialsToken({ domain, clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing client credentials for ${domain}. Set *_SHOPIFY_CLIENT_ID and *_SHOPIFY_CLIENT_SECRET in .env`
    );
  }

  const url = `https://${domain}/admin/oauth/access_token`;
  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", clientId);
  body.append("client_secret", clientSecret);

  const resp = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  const token = resp.data?.access_token;
  const expiresIn = Number(resp.data?.expires_in ?? 0); // usually ~86399 seconds

  if (!token) throw new Error(`No access_token returned for ${domain}`);

  const effectiveExpiresIn = (expiresIn || 86399) - 60; // refresh early
  const expiresAtMs = Date.now() + Math.max(1, effectiveExpiresIn) * 1000;

  return { token, expiresAtMs };
}

async function getAccessTokenForStore(storeKey, { forceRefresh = false } = {}) {
  const cfg = getStoreCfg(storeKey);

  // Prefer static env token if provided (shpat_...)
  if (cfg.staticToken) {
    return { store: cfg.storeKey, domain: cfg.domain, token: cfg.staticToken, source: "env" };
  }

  if (!forceRefresh) {
    const cached = tokenCache.get(cfg.storeKey);
    if (cached?.token && cached.expiresAtMs > Date.now()) {
      return { store: cfg.storeKey, domain: cfg.domain, token: cached.token, source: "cache" };
    }
  }

  const fresh = await fetchClientCredentialsToken(cfg);
  tokenCache.set(cfg.storeKey, fresh);
  return { store: cfg.storeKey, domain: cfg.domain, token: fresh.token, source: "oauth" };
}

async function shopifyGraphql({ domain, token, query, variables }) {
  const graphqlUrl = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  try {
    const resp = await axios.post(
      graphqlUrl,
      { query, variables: variables || {} },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        timeout: 60000,
      }
    );

    // GraphQL errors come back as 200 with errors[]
    if (resp.data?.errors?.length) {
      const e = new Error("Shopify GraphQL returned errors");
      e.shopifyStatus = 200;
      e.shopifyData = resp.data;
      throw e;
    }

    return resp.data?.data;
  } catch (err) {
    const status = err?.response?.status ?? err.shopifyStatus ?? null;
    const data = err?.response?.data ?? err.shopifyData ?? null;

    const e = new Error(err.message || "Shopify request failed");
    e.shopifyStatus = status;
    e.shopifyData = data;
    throw e;
  }
}

/**
 * ✅ Fetch ALL orders using cursor pagination.
 * Options:
 * - limit: stop after N orders (for quick tests)
 * - maxPages: stop after N pages (each page up to 250)
 */
async function fetchAllOrders({ domain, token, limit = 0, maxPages = 0 }) {
  const query = `
    query OrdersPage($first: Int!, $after: String) {
      orders(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            customer { firstName lastName email }
            billingAddress { address1 address2 city province country zip }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
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

  const all = [];
  let after = null;
  let page = 0;

  while (true) {
    page += 1;

    const data = await shopifyGraphql({
      domain,
      token,
      query,
      variables: { first: 250, after },
    });

    const conn = data?.orders;
    const edges = conn?.edges || [];
    const nodes = edges.map((e) => e.node).filter(Boolean);

    all.push(...nodes);

    const hasNext = !!conn?.pageInfo?.hasNextPage;
    const endCursor = conn?.pageInfo?.endCursor || null;

    // Stop conditions
    if (limit > 0 && all.length >= limit) {
      return all.slice(0, limit);
    }
    if (maxPages > 0 && page >= maxPages) {
      return all;
    }
    if (!hasNext) {
      return all;
    }

    after = endCursor;

    // Small delay to reduce throttle risk
    await sleep(200);
  }
}

/**
 * GET /api/orders?store=bloomommy|cellumove|yuma
 * Optional:
 *   &limit=500        -> only first 500 orders (debug)
 *   &maxPages=3       -> only first 3 pages (debug)
 */
app.get("/api/orders", async (req, res) => {
  const store = String(req.query.store || "bloomommy").toLowerCase();
  const limit = Number(req.query.limit || 0) || 0;
  const maxPages = Number(req.query.maxPages || 0) || 0;

  try {
    // get token
    let auth = await getAccessTokenForStore(store);

    console.log(
      `[orders] store=${store} domain=${auth.domain} source=${auth.source} tokenSuffix=${tokenSuffix(auth.token)}`
    );

    // fetch all orders (with retry-on-401 for oauth/cache tokens)
    try {
      const orders = await fetchAllOrders({
        domain: auth.domain,
        token: auth.token,
        limit,
        maxPages,
      });

      const pages = Math.max(1, Math.ceil(orders.length / 250));

      return res.json({
        store,
        count: orders.length,
        pages,
        orders,
      });
    } catch (err) {
      // If 401 and token is from oauth/cache, clear & retry once
      const status = err.shopifyStatus;

      if (status === 401 && (auth.source === "oauth" || auth.source === "cache")) {
        console.warn(`[orders] 401 for ${store} using ${auth.source}. Clearing cache and retrying once...`);
        tokenCache.delete(store);

        auth = await getAccessTokenForStore(store, { forceRefresh: true });

        console.log(
          `[orders] RETRY store=${store} domain=${auth.domain} source=${auth.source} tokenSuffix=${tokenSuffix(auth.token)}`
        );

        const orders = await fetchAllOrders({
          domain: auth.domain,
          token: auth.token,
          limit,
          maxPages,
        });

        const pages = Math.max(1, Math.ceil(orders.length / 250));

        return res.json({
          store,
          count: orders.length,
          pages,
          orders,
        });
      }

      console.error("=== /api/orders ERROR ===");
      console.error("store:", store);
      console.error("domain:", auth.domain);
      console.error("source:", auth.source);
      console.error("tokenSuffix:", tokenSuffix(auth.token));
      console.error("status:", err.shopifyStatus);
      console.error("data:", JSON.stringify(err.shopifyData, null, 2));
      console.error("message:", err.message);

      return res.status(500).json({
        store,
        status: err.shopifyStatus || null,
        error: err.shopifyData || err.message,
      });
    }
  } catch (err) {
    console.error("=== /api/orders TOP-LEVEL ERROR ===");
    console.error("store:", store);
    console.error("status:", err.shopifyStatus);
    console.error("data:", JSON.stringify(err.shopifyData, null, 2));
    console.error("message:", err.message);

    return res.status(500).json({
      store,
      status: err.shopifyStatus || null,
      error: err.shopifyData || err.message || "Failed to fetch orders",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}/api/orders`);
});
