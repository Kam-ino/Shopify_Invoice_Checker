require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

/**
 * Runtime refresh settings
 * - ENABLE_TOKEN_REFRESH=true  -> refresh all store tokens on an interval
 * - TOKEN_REFRESH_MINUTES=60   -> default hourly
 * - ENV_FILE_PATH=/path/to/.env (optional)
 *
 * Note: Persisting to .env only works on writable, long-running servers. On serverless,
 * writing to disk may fail; this code logs and still uses in-memory cache.
 */
const ENABLE_TOKEN_REFRESH = String(process.env.ENABLE_TOKEN_REFRESH || "").toLowerCase() === "true";
const TOKEN_REFRESH_MINUTES = Number(process.env.TOKEN_REFRESH_MINUTES || 60);
const ENV_FILE_PATH = process.env.ENV_FILE_PATH
  ? path.resolve(process.env.ENV_FILE_PATH)
  : path.resolve(process.cwd(), ".env");

/**
 * Optional protection for manual refresh endpoint:
 * - REFRESH_SECRET=someLongSecret
 * Call POST /api/refresh-tokens with header x-refresh-secret: <secret>
 */
const REFRESH_SECRET = String(process.env.REFRESH_SECRET || "").trim();

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

  return { storeKey, domain, staticToken, clientId, clientSecret, accessTokenEnv: cfg.accessTokenEnv };
}

/**
 * Shopify client-credentials grant (server-to-server)
 * Returns an "access_token" + "expires_in" (commonly ~86399s)
 */
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
  const expiresIn = Number(resp.data?.expires_in ?? 0); // seconds

  if (!token) throw new Error(`No access_token returned for ${domain}`);

  // Refresh early (60s)
  const effectiveExpiresIn = (expiresIn || 86399) - 60;
  const expiresAtMs = Date.now() + Math.max(1, effectiveExpiresIn) * 1000;

  return { token, expiresAtMs, expiresIn: expiresIn || 86399 };
}

/**
 * .env persistence helpers
 */
function upsertEnvVar(fileText, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(fileText)) return fileText.replace(re, line);
  const trimmed = fileText.endsWith("\n") ? fileText : fileText + "\n";
  return trimmed + line + "\n";
}

function persistTokenToEnv(storeKey, token) {
  const cfg = STORES[storeKey];
  if (!cfg) throw new Error(`Unknown storeKey: ${storeKey}`);

  const envKey = cfg.accessTokenEnv;

  // Update runtime immediately
  process.env[envKey] = token;

  // Persist to disk (best-effort; may fail on serverless)
  const current = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, "utf8") : "";
  const updated = upsertEnvVar(current, envKey, token);

  // Simple atomic write
  const tmp = `${ENV_FILE_PATH}.tmp`;
  fs.writeFileSync(tmp, updated, "utf8");
  fs.renameSync(tmp, ENV_FILE_PATH);
}

/**
 * Mint a fresh token for a store, cache it, and persist it into .env (best-effort).
 */
async function mintAndPersistToken(storeKey) {
  const cfg = getStoreCfg(storeKey);

  const fresh = await fetchClientCredentialsToken(cfg);
  tokenCache.set(storeKey, { token: fresh.token, expiresAtMs: fresh.expiresAtMs });

  let persisted = false;
  let persistError = null;

  try {
    persistTokenToEnv(storeKey, fresh.token);
    persisted = true;
  } catch (e) {
    persisted = false;
    persistError = e?.message || String(e);
  }

  return {
    storeKey,
    domain: cfg.domain,
    tokenSuffix: tokenSuffix(fresh.token),
    expiresIn: fresh.expiresIn,
    persisted,
    persistError,
  };
}

async function refreshAllTokensOnce() {
  const keys = Object.keys(STORES);

  const results = await Promise.allSettled(keys.map((k) => mintAndPersistToken(k)));

  results.forEach((r, i) => {
    const storeKey = keys[i];
    if (r.status === "fulfilled") {
      const out = r.value;
      console.log(
        `[token-refresh] store=${storeKey} domain=${out.domain} tokenSuffix=${out.tokenSuffix} persisted=${out.persisted} expiresIn=${out.expiresIn}s`
      );
      if (!out.persisted && out.persistError) {
        console.warn(`[token-refresh] store=${storeKey} persist failed: ${out.persistError}`);
      }
    } else {
      console.warn(`[token-refresh] store=${storeKey} FAILED: ${r.reason?.message || r.reason}`);
    }
  });
}

/**
 * Token retrieval:
 * 1) Use valid cached oauth token if present
 * 2) Otherwise use env token if present
 * 3) Otherwise mint a new oauth token (and persist best-effort)
 *
 * If forceRefresh=true, skip cache and env and mint new.
 */
async function getAccessTokenForStore(storeKey, { forceRefresh = false } = {}) {
  const cfg = getStoreCfg(storeKey);

  if (!forceRefresh) {
    const cached = tokenCache.get(cfg.storeKey);
    if (cached?.token && cached.expiresAtMs > Date.now()) {
      return { store: cfg.storeKey, domain: cfg.domain, token: cached.token, source: "cache" };
    }

    if (cfg.staticToken) {
      return { store: cfg.storeKey, domain: cfg.domain, token: cfg.staticToken, source: "env" };
    }
  }

  // Mint fresh + persist
  const out = await mintAndPersistToken(cfg.storeKey);
  return { store: cfg.storeKey, domain: cfg.domain, token: process.env[cfg.accessTokenEnv], source: "oauth" };
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
 * Fetch ALL orders using cursor pagination.
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
    if (limit > 0 && all.length >= limit) return all.slice(0, limit);
    if (maxPages > 0 && page >= maxPages) return all;
    if (!hasNext) return all;

    after = endCursor;

    // Small delay to reduce throttle risk
    await sleep(200);
  }
}

/**
 * Health snapshot (helps debug which token source is used)
 */
app.get("/api/health", (req, res) => {
  const keys = Object.keys(STORES);
  const snapshot = keys.map((k) => {
    const cfg = getStoreCfg(k);
    const cached = tokenCache.get(k);
    return {
      store: k,
      domain: cfg.domain,
      envHasToken: Boolean(cfg.staticToken),
      cacheHasToken: Boolean(cached?.token),
      cacheTtlSec: cached?.expiresAtMs ? Math.max(0, Math.floor((cached.expiresAtMs - Date.now()) / 1000)) : null,
      envFilePath: ENV_FILE_PATH,
      refreshEnabled: ENABLE_TOKEN_REFRESH,
      refreshMinutes: TOKEN_REFRESH_MINUTES,
    };
  });
  res.json({ ok: true, snapshot });
});

/**
 * Manual token refresh endpoint (useful if you trigger via cron)
 */
app.post("/api/refresh-tokens", async (req, res) => {
  if (REFRESH_SECRET) {
    const provided = String(req.headers["x-refresh-secret"] || "").trim();
    if (provided !== REFRESH_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  try {
    await refreshAllTokensOnce();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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

    // fetch all orders (retry once on 401 by minting a new token and persisting)
    try {
      const orders = await fetchAllOrders({
        domain: auth.domain,
        token: auth.token,
        limit,
        maxPages,
      });

      const pages = Math.max(1, Math.ceil(orders.length / 250));

      return res.json({ store, count: orders.length, pages, orders });
    } catch (err) {
      const status = err.shopifyStatus;

      if (status === 401) {
        console.warn(`[orders] 401 for ${store}. Minting fresh token and retrying once...`);
        tokenCache.delete(store);

        try {
          await mintAndPersistToken(store);
        } catch (e) {
          console.warn(`[orders] token mint failed for ${store}: ${e?.message || e}`);
        }

        auth = await getAccessTokenForStore(store, { forceRefresh: true });

        console.log(
          `[orders] RETRY store=${store} domain=${auth.domain} source=${auth.source} tokenSuffix=${tokenSuffix(
            auth.token
          )}`
        );

        const orders = await fetchAllOrders({
          domain: auth.domain,
          token: auth.token,
          limit,
          maxPages,
        });

        const pages = Math.max(1, Math.ceil(orders.length / 250));

        return res.json({ store, count: orders.length, pages, orders });
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

app.listen(PORT, async () => {
  console.log(`Server running: http://localhost:${PORT}/api/orders`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`API_VERSION=${API_VERSION}`);
  console.log(`ENV_FILE_PATH=${ENV_FILE_PATH}`);

  if (ENABLE_TOKEN_REFRESH) {
    console.log(`[token-refresh] enabled every ${TOKEN_REFRESH_MINUTES} minutes`);

    // Run once immediately at boot
    try {
      await refreshAllTokensOnce();
    } catch (e) {
      console.warn("[token-refresh] startup refresh failed:", e?.message || e);
    }

    setInterval(() => {
      refreshAllTokensOnce().catch((e) => console.warn("[token-refresh] interval refresh failed:", e?.message || e));
    }, TOKEN_REFRESH_MINUTES * 60 * 1000);
  }
});
