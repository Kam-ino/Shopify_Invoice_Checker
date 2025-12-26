/**
 * Vercel-ready Express API (single function) that:
 * - Mints Shopify client-credentials access tokens
 * - Stores them in Vercel KV with TTL
 * - Auto-retries once on 401 by re-minting token
 * - Provides a cron endpoint to refresh tokens hourly
 *
 * Required deps:
 *   npm i express axios cors @vercel/kv
 *
 * Required env vars per store:
 *   BLOOMOMMY_SHOPIFY_STORE_DOMAIN
 *   BLOOMOMMY_SHOPIFY_CLIENT_ID
 *   BLOOMOMMY_SHOPIFY_CLIENT_SECRET
 *   (repeat for CELLUMOVE_, YUMA_)
 *
 * Optional:
 *   SHOPIFY_API_VERSION=2025-10
 *   REFRESH_SECRET=<some secret>  (protects cron endpoint)
 */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { kv } = require("@vercel/kv"); // Vercel KV (durable Redis)

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const REFRESH_SECRET = String(process.env.REFRESH_SECRET || "").trim();

const STORES = {
  bloomommy: {
    domainEnv: "BLOOMOMMY_SHOPIFY_STORE_DOMAIN",
    clientIdEnv: "BLOOMOMMY_SHOPIFY_CLIENT_ID",
    clientSecretEnv: "BLOOMOMMY_SHOPIFY_CLIENT_SECRET",
  },
  cellumove: {
    domainEnv: "CELLUMOVE_SHOPIFY_STORE_DOMAIN",
    clientIdEnv: "CELLUMOVE_SHOPIFY_CLIENT_ID",
    clientSecretEnv: "CELLUMOVE_SHOPIFY_CLIENT_SECRET",
  },
  yuma: {
    domainEnv: "YUMA_SHOPIFY_STORE_DOMAIN",
    clientIdEnv: "YUMA_SHOPIFY_CLIENT_ID",
    clientSecretEnv: "YUMA_SHOPIFY_CLIENT_SECRET",
  },
};

function envTrim(name) {
  return String(process.env[name] || "").trim();
}
function mustEnv(name) {
  const v = envTrim(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function getStoreCfg(storeKeyRaw) {
  const storeKey = String(storeKeyRaw || "bloomommy").toLowerCase();
  const cfg = STORES[storeKey];
  if (!cfg) {
    throw new Error(`Invalid store "${storeKey}". Use: ${Object.keys(STORES).join(", ")}`);
  }

  const domain = mustEnv(cfg.domainEnv);
  const clientId = mustEnv(cfg.clientIdEnv);
  const clientSecret = mustEnv(cfg.clientSecretEnv);

  return { storeKey, domain, clientId, clientSecret };
}

function tokenKey(storeKey) {
  return `shopify:access_token:${storeKey}`;
}
function tokenSuffix(token) {
  const t = String(token || "");
  return t.length >= 6 ? t.slice(-6) : t;
}

async function fetchClientCredentialsToken({ domain, clientId, clientSecret }) {
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
  const expiresIn = Number(resp.data?.expires_in ?? 0) || 86399; // default ~1 day if missing

  if (!token) throw new Error(`No access_token returned for ${domain}`);

  // Refresh early by 60 seconds
  const expiresAtMs = Date.now() + Math.max(1, expiresIn - 60) * 1000;

  return { token, expiresIn, expiresAtMs };
}

async function getTokenFromKV(storeKey) {
  const raw = await kv.get(tokenKey(storeKey));
  if (!raw) return null;

  // raw can be string or object depending on KV client/runtime
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function setTokenInKV(storeKey, tokenObj) {
  // KV TTL: set a little shorter than actual expiry
  const ttlSec = Math.max(60, Math.floor((tokenObj.expiresAtMs - Date.now()) / 1000));
  await kv.set(tokenKey(storeKey), JSON.stringify(tokenObj), { ex: ttlSec }); // ex = seconds :contentReference[oaicite:2]{index=2}
}

async function getAccessTokenForStore(storeKey, { forceRefresh = false } = {}) {
  const cfg = getStoreCfg(storeKey);

  if (!forceRefresh) {
    const cached = await getTokenFromKV(cfg.storeKey);
    if (cached?.token && cached.expiresAtMs > Date.now()) {
      return { store: cfg.storeKey, domain: cfg.domain, token: cached.token, source: "kv" };
    }
  }

  const fresh = await fetchClientCredentialsToken(cfg);
  await setTokenInKV(cfg.storeKey, { token: fresh.token, expiresAtMs: fresh.expiresAtMs });

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

    if (limit > 0 && all.length >= limit) return all.slice(0, limit);
    if (maxPages > 0 && page >= maxPages) return all;
    if (!hasNext) return all;

    after = endCursor;

    // small throttle cushion
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Routes
 */

app.get("/api/health", async (req, res) => {
  try {
    const stores = Object.keys(STORES);
    const snapshot = await Promise.all(
      stores.map(async (k) => {
        const cfg = getStoreCfg(k);
        const cached = await getTokenFromKV(k);
        return {
          store: k,
          domain: cfg.domain,
          cacheHasToken: Boolean(cached?.token),
          cacheTtlSec: cached?.expiresAtMs ? Math.max(0, Math.floor((cached.expiresAtMs - Date.now()) / 1000)) : null,
        };
      })
    );
    res.json({ ok: true, apiVersion: API_VERSION, snapshot });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Orders endpoint:
 * GET /api/orders?store=bloomommy
 * Optional: &limit=200 &maxPages=2
 */
app.get("/api/orders", async (req, res) => {
  const store = String(req.query.store || "bloomommy").toLowerCase();
  const limit = Number(req.query.limit || 0) || 0;
  const maxPages = Number(req.query.maxPages || 0) || 0;

  let auth;
  try {
    auth = await getAccessTokenForStore(store);

    console.log(
      `[orders] store=${store} domain=${auth.domain} source=${auth.source} tokenSuffix=${tokenSuffix(auth.token)}`
    );

    try {
      const orders = await fetchAllOrders({ domain: auth.domain, token: auth.token, limit, maxPages });
      return res.json({ store, count: orders.length, pages: Math.max(1, Math.ceil(orders.length / 250)), orders });
    } catch (err) {
      // If token is invalid, refresh and retry once
      if (err.shopifyStatus === 401) {
        console.warn(`[orders] 401 store=${store}. Refreshing token and retrying once...`);
        auth = await getAccessTokenForStore(store, { forceRefresh: true });

        console.log(
          `[orders] RETRY store=${store} domain=${auth.domain} source=${auth.source} tokenSuffix=${tokenSuffix(
            auth.token
          )}`
        );

        const orders = await fetchAllOrders({ domain: auth.domain, token: auth.token, limit, maxPages });
        return res.json({ store, count: orders.length, pages: Math.max(1, Math.ceil(orders.length / 250)), orders });
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
  } catch (e) {
    return res.status(500).json({
      store,
      status: e?.shopifyStatus || null,
      error: e?.shopifyData || e?.message || String(e),
    });
  }
});

/**
 * Cron endpoint (GET) to refresh all store tokens:
 * GET /api/cron/refresh-tokens?secret=...
 *
 * Use with Vercel Cron Jobs (vercel.json "crons").
 */
app.get("/api/cron/refresh-tokens", async (req, res) => {
  if (REFRESH_SECRET) {
    const provided = String(req.query.secret || "");
    if (provided !== REFRESH_SECRET) return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const keys = Object.keys(STORES);
    const results = await Promise.all(
      keys.map(async (k) => {
        const auth = await getAccessTokenForStore(k, { forceRefresh: true });
        return { store: k, domain: auth.domain, tokenSuffix: tokenSuffix(auth.token) };
      })
    );
    return res.json({ ok: true, refreshed: results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Vercel requires exporting the Express app (no app.listen).
 * A CommonJS export works as the module's default export. :contentReference[oaicite:3]{index=3}
 */
module.exports = app;
