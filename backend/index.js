require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

/** -----------------------------
 * Config
 * ----------------------------*/
const PORT = Number(process.env.PORT || 4000);
const API_VERSION = String(process.env.SHOPIFY_API_VERSION || "2025-10");

const MONGODB_URI = String(process.env.MONGODB_URI || "").trim();
const MONGODB_DB = String(process.env.MONGODB_DB || "invoiceapp").trim();
const TOKENS_COL = String(process.env.MONGODB_TOKENS_COLLECTION || "shopify_tokens").trim();
const META_COL = String(process.env.MONGODB_SYNC_META_COLLECTION || "shopify_sync_meta").trim();
const ORDERS_PREFIX = String(process.env.MONGODB_ORDERS_PREFIX || "shopify_orders_").trim();

const SHOP_KEYS = String(process.env.SHOP_KEYS || "bloomommy,cellumove,yuma")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const SYNC_ON_START = String(process.env.SYNC_ON_START || "true").toLowerCase() === "true";
const FULL_SYNC_IF_EMPTY = String(process.env.FULL_SYNC_IF_EMPTY || "true").toLowerCase() === "true";
const SYNC_ON_READ = String(process.env.SYNC_ON_READ || "false").toLowerCase() === "true";
const SYNC_PAGE_DELAY_MS = Number(process.env.SYNC_PAGE_DELAY_MS || 250);

const SYNC_SECRET = String(process.env.SYNC_SECRET || "").trim();

// IMPORTANT: include all order statuses (closed/cancelled/etc)
const SHOPIFY_ORDERS_QUERY_BASE = String(process.env.SHOPIFY_ORDERS_QUERY_BASE || "status:any").trim();

// Shopify GraphQL connection page size: max commonly 250
const SHOPIFY_ORDERS_PAGE_SIZE = Math.max(1, Math.min(Number(process.env.SHOPIFY_ORDERS_PAGE_SIZE || 250), 250));

// Keep error payloads bounded in Mongo/meta
const MAX_ERROR_DETAIL_CHARS = Number(process.env.MAX_ERROR_DETAIL_CHARS || 4000);

/** -----------------------------
 * Utilities
 * ----------------------------*/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeShopDomain(shop) {
  return String(shop || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function safeMongoSuffix(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function ordersCollectionName(storeKey) {
  return `${ORDERS_PREFIX}${safeMongoSuffix(storeKey)}`;
}

function truncateDetail(val, max = MAX_ERROR_DETAIL_CHARS) {
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `... (truncated, ${s.length} chars)`;
}

function parseAxiosError(err) {
  const status = err?.response?.status ?? err?.shopifyStatus ?? null;
  const data = err?.response?.data ?? err?.shopifyData ?? null;
  return {
    status,
    data,
    detail: truncateDetail(data),
    message: err?.message || String(err),
  };
}

/**
 * Discovers ALL stores from env based on SHOP_KEYS groups.
 * For group KEY (e.g. CELLUMOVE), includes:
 * - KEY_SHOPIFY_STORE_DOMAIN
 * - any KEY_*_SHOPIFY_STORE_DOMAIN (CELLUMOVE_ES_..., CELLUMOVE_MX_..., etc)
 *
 * Each discovered store inherits KEY_SHOPIFY_CLIENT_ID/SECRET.
 */
function buildStoreRegistryFromEnv() {
  if (!SHOP_KEYS.length) {
    throw new Error("SHOP_KEYS is empty. Example: SHOP_KEYS=bloomommy,cellumove,yuma");
  }

  const stores = [];
  const byShop = new Map(); // domain -> cfg
  const byStoreKey = new Map(); // storeKey -> cfg

  for (const KEY of SHOP_KEYS) {
    const clientId = String(process.env[`${KEY}_SHOPIFY_CLIENT_ID`] || "").trim();
    const clientSecret = String(process.env[`${KEY}_SHOPIFY_CLIENT_SECRET`] || "").trim();

    if (!clientId || !clientSecret) {
      console.warn(`[env] Missing ${KEY}_SHOPIFY_CLIENT_ID/SECRET (group credentials).`);
    }

    const prefix = `${KEY}_`;
    for (const [envName, envVal] of Object.entries(process.env)) {
      if (!envName.startsWith(prefix)) continue;
      if (!envName.endsWith("_SHOPIFY_STORE_DOMAIN")) continue;

      const domain = normalizeShopDomain(envVal);
      if (!domain || !domain.includes(".myshopify.com")) continue;

      const storeKey = envName.replace(/_SHOPIFY_STORE_DOMAIN$/, "").toLowerCase(); // e.g. cellumove_es
      const cfg = {
        groupKey: KEY.toLowerCase(),
        storeKey,
        domain,
        clientId,
        clientSecret,
      };

      stores.push(cfg);
      byShop.set(domain, cfg);
      byStoreKey.set(storeKey, cfg);
    }
  }

  if (!stores.length) {
    throw new Error("No *_SHOPIFY_STORE_DOMAIN vars discovered for SHOP_KEYS groups.");
  }

  stores.sort((a, b) => a.storeKey.localeCompare(b.storeKey));
  return { stores, byShop, byStoreKey };
}

const STORE_REGISTRY = buildStoreRegistryFromEnv();

function resolveStoreFromRequest(req) {
  const shopQ = normalizeShopDomain(req.query.shop);
  if (shopQ && STORE_REGISTRY.byShop.has(shopQ)) return STORE_REGISTRY.byShop.get(shopQ);

  const shopH = normalizeShopDomain(req.headers["x-shopify-shop-domain"]);
  if (shopH && STORE_REGISTRY.byShop.has(shopH)) return STORE_REGISTRY.byShop.get(shopH);

  const storeQ = String(req.query.store || "").trim().toLowerCase();
  if (storeQ && STORE_REGISTRY.byStoreKey.has(storeQ)) return STORE_REGISTRY.byStoreKey.get(storeQ);

  return STORE_REGISTRY.stores[0] || null;
}

/** -----------------------------
 * MongoDB connection
 * ----------------------------*/
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

let _mongoClient = null;
let _mongoPromise = null;

async function getMongoClient() {
  if (_mongoClient) return _mongoClient;

  if (!_mongoPromise) {
    // IPv4 preference helps in some environments
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      family: 4,
      autoSelectFamily: false,
    });
    _mongoPromise = client.connect();
  }

  _mongoClient = await _mongoPromise;
  return _mongoClient;
}

async function getDb() {
  const client = await getMongoClient();
  return client.db(MONGODB_DB);
}

async function getTokensCol() {
  const db = await getDb();
  return db.collection(TOKENS_COL);
}

async function getMetaCol() {
  const db = await getDb();
  return db.collection(META_COL);
}

async function getOrdersCol(storeKey) {
  const db = await getDb();
  return db.collection(ordersCollectionName(storeKey));
}

async function ensureIndexesForStore(store) {
  const tokens = await getTokensCol();
  const meta = await getMetaCol();
  const orders = await getOrdersCol(store.storeKey);

  await tokens.createIndex({ domain: 1 }, { unique: true });
  await tokens.createIndex({ storeKey: 1 }, { unique: true });

  await meta.createIndex({ storeKey: 1 }, { unique: true });
  await meta.createIndex({ domain: 1 });

  await orders.createIndex({ id: 1 }, { unique: true });
  await orders.createIndex({ createdAt: -1 });
  await orders.createIndex({ updatedAt: -1 });
}

/** -----------------------------
 * Meta helpers
 * ----------------------------*/
async function getMeta(storeKey) {
  const meta = await getMetaCol();
  return meta.findOne({ storeKey });
}

async function setMeta(store, patch) {
  const meta = await getMetaCol();
  await meta.updateOne(
    { storeKey: store.storeKey },
    {
      $set: {
        storeKey: store.storeKey,
        domain: store.domain,
        groupKey: store.groupKey,
        ...patch,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

/** -----------------------------
 * Token: fetch + store in Mongo
 * ----------------------------*/
async function fetchClientCredentialsToken({ domain, clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error(`Missing client credentials for ${domain}. Check <GROUP>_SHOPIFY_CLIENT_ID/SECRET`);
  }

  const url = `https://${domain}/admin/oauth/access_token`;
  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", clientId);
  body.append("client_secret", clientSecret);

  try {
    const resp = await axios.post(url, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    const token = resp.data?.access_token;
    const expiresIn = Number(resp.data?.expires_in ?? 0);
    if (!token) throw new Error(`No access_token returned for ${domain}`);

    const effective = (expiresIn || 86399) - 60;
    const expiresAtMs = Date.now() + Math.max(1, effective) * 1000;

    return { token, expiresIn: expiresIn || 86399, expiresAtMs };
  } catch (err) {
    const parsed = parseAxiosError(err);
    const e = new Error(`Token mint failed for ${domain} (HTTP ${parsed.status}): ${parsed.detail}`);
    e.shopifyStatus = parsed.status;
    e.shopifyData = parsed.data;
    throw e;
  }
}

async function readTokenDocByDomain(domain) {
  const tokens = await getTokensCol();
  return tokens.findOne({ domain });
}

async function upsertTokenDoc(store, token, expiresAtMs, expiresIn) {
  const tokens = await getTokensCol();
  await tokens.updateOne(
    { domain: store.domain },
    {
      $set: {
        storeKey: store.storeKey,
        groupKey: store.groupKey,
        domain: store.domain,
        token,
        expiresAtMs,
        expiresIn,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function getShopifyToken(store, { force = false } = {}) {
  if (!store?.domain) throw new Error("Missing store.domain");

  if (!force) {
    const doc = await readTokenDocByDomain(store.domain);
    if (doc?.token && Number(doc.expiresAtMs || 0) > Date.now()) {
      return { domain: store.domain, token: doc.token, source: "mongo" };
    }
  }

  const fresh = await fetchClientCredentialsToken({
    domain: store.domain,
    clientId: store.clientId,
    clientSecret: store.clientSecret,
  });

  await upsertTokenDoc(store, fresh.token, fresh.expiresAtMs, fresh.expiresIn);
  return { domain: store.domain, token: fresh.token, source: "minted" };
}

/** -----------------------------
 * Shopify GraphQL
 * - Handles HTTP 429
 * - Handles GraphQL THROTTLED errors (HTTP 200 with errors)
 * - Captures error payloads for debugging
 * ----------------------------*/
function isThrottledGraphQLError(graphQLErrors) {
  if (!Array.isArray(graphQLErrors)) return false;
  return graphQLErrors.some((e) => {
    const msg = String(e?.message || "").toUpperCase();
    const code = String(e?.extensions?.code || "").toUpperCase();
    return msg.includes("THROTTLED") || code === "THROTTLED";
  });
}

function computeThrottleBackoffMs(respData, attempt) {
  const throttle = respData?.extensions?.cost?.throttleStatus;
  const restoreRate = Number(throttle?.restoreRate || 0);
  const currentlyAvailable = Number(throttle?.currentlyAvailable || 0);

  let ms = 1000 * Math.pow(2, attempt);

  if (restoreRate > 0 && currentlyAvailable < 50) {
    const seconds = Math.ceil((50 - currentlyAvailable) / restoreRate);
    ms = Math.max(ms, seconds * 1000);
  }

  return Math.min(ms, 30000);
}

async function shopifyGraphql({ domain, token, query, variables }) {
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  const maxRetries = 8;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.post(
        url,
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
        if (isThrottledGraphQLError(resp.data.errors) && attempt < maxRetries) {
          const waitMs = computeThrottleBackoffMs(resp.data, attempt);
          await sleep(waitMs);
          continue;
        }

        const e = new Error(`Shopify GraphQL returned errors: ${truncateDetail(resp.data)}`);
        e.shopifyStatus = 200;
        e.shopifyData = resp.data;
        throw e;
      }

      return resp.data?.data;
    } catch (err) {
      const status = err?.response?.status ?? err.shopifyStatus ?? null;

      if (status === 429 && attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        await sleep(Math.min(backoffMs, 30000));
        continue;
      }

      if (status === 401) {
        const e = new Error(
          `Unauthorized (401) from Shopify: ${truncateDetail(err?.response?.data || err.shopifyData)}`
        );
        e.shopifyStatus = 401;
        e.shopifyData = err?.response?.data || err.shopifyData || null;
        throw e;
      }

      const parsed = parseAxiosError(err);
      const e = new Error(`Shopify request failed (HTTP ${parsed.status}): ${parsed.detail}`);
      e.shopifyStatus = parsed.status;
      e.shopifyData = parsed.data;
      throw e;
    }
  }
}

/** -----------------------------
 * Orders: fetch + store in Mongo
 * ----------------------------*/
function buildOrdersQueryString(updatedSinceIso) {
  const terms = [];
  if (SHOPIFY_ORDERS_QUERY_BASE) terms.push(SHOPIFY_ORDERS_QUERY_BASE);
  if (updatedSinceIso) terms.push(`updated_at:>=${updatedSinceIso}`);
  return terms.length ? terms.join(" AND ") : null;
}

async function fetchOrdersPage({ domain, token, after, updatedSinceIso }) {
  const q = `
    query OrdersPage($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: false) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            updatedAt
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

  const queryString = buildOrdersQueryString(updatedSinceIso);

  const data = await shopifyGraphql({
    domain,
    token,
    query: q,
    variables: { first: SHOPIFY_ORDERS_PAGE_SIZE, after: after || null, query: queryString },
  });

  const conn = data?.orders;
  const edges = conn?.edges || [];
  const nodes = edges.map((e) => e.node).filter(Boolean);

  return {
    nodes,
    hasNextPage: !!conn?.pageInfo?.hasNextPage,
    endCursor: conn?.pageInfo?.endCursor || null,
  };
}

async function bulkUpsertOrders(storeKey, orders) {
  if (!orders.length) return 0;

  const col = await getOrdersCol(storeKey);

  const ops = orders.map((o) => ({
    updateOne: {
      filter: { id: o.id },
      update: {
        $set: {
          ...o,
          createdAt: o.createdAt ? new Date(o.createdAt) : null,
          updatedAt: o.updatedAt ? new Date(o.updatedAt) : null,
          cachedAt: new Date(),
        },
        $setOnInsert: { insertedAt: new Date() },
      },
      upsert: true,
    },
  }));

  const res = await col.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount || 0) + (res.modifiedCount || 0);
}

async function estimatedOrderCount(storeKey) {
  const col = await getOrdersCol(storeKey);
  return col.estimatedDocumentCount();
}

/** -----------------------------
 * Sync engine
 * ----------------------------*/
const syncLocks = new Map(); // storeKey -> Promise

async function syncStore(store, { full = false, clear = false } = {}) {
  const key = String(store.storeKey).toLowerCase();
  if (syncLocks.has(key)) return syncLocks.get(key);

  const p = (async () => {
    await ensureIndexesForStore(store);

    const count = await estimatedOrderCount(key);
    let modeFull = full;

    let updatedSinceIso = null;
    const meta = await getMeta(key);

    if (!modeFull) {
      if (meta?.lastSyncedUpdatedAt) {
        updatedSinceIso = new Date(meta.lastSyncedUpdatedAt).toISOString();
      } else if (FULL_SYNC_IF_EMPTY && count === 0) {
        modeFull = true;
      }
    }

    await setMeta(store, {
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      errorStatus: null,
      errorDetail: null,
      mode: modeFull ? "full" : "incremental",
      priorCachedCount: count,
      pages: 0,
      lastRunUpserts: 0,
      note: modeFull ? "Full sync starting" : "Incremental sync starting",
    });

    if (modeFull && clear) {
      const ordersCol = await getOrdersCol(key);
      await ordersCol.deleteMany({});
      await setMeta(store, { note: "Cleared orders collection before full sync." });
    }

    let auth = await getShopifyToken(store);

    let after = null;
    let pages = 0;
    let upserts = 0;
    let maxUpdatedAt = null;

    while (true) {
      pages += 1;

      try {
        const page = await fetchOrdersPage({
          domain: auth.domain,
          token: auth.token,
          after,
          updatedSinceIso: modeFull ? null : updatedSinceIso,
        });

        if (page.nodes.length) {
          for (const o of page.nodes) {
            if (o.updatedAt) {
              const d = new Date(o.updatedAt);
              if (!maxUpdatedAt || d > maxUpdatedAt) maxUpdatedAt = d;
            }
          }
          upserts += await bulkUpsertOrders(key, page.nodes);
        }

        if (!page.hasNextPage) break;
        after = page.endCursor;
        await sleep(SYNC_PAGE_DELAY_MS);
      } catch (e) {
        if (e.shopifyStatus === 401) {
          await setMeta(store, { note: "401 from Shopify: refreshing token and retrying..." });
          auth = await getShopifyToken(store, { force: true });
          await sleep(250);
          continue;
        }

        const parsed = parseAxiosError(e);
        await setMeta(store, {
          error: parsed.message,
          errorStatus: parsed.status,
          errorDetail: parsed.detail,
          note: "Sync failed; see errorDetail",
        });

        throw e;
      }
    }

    const watermark = maxUpdatedAt || new Date();
    await setMeta(store, {
      status: "idle",
      finishedAt: new Date(),
      pages,
      lastRunUpserts: upserts,
      lastSyncedUpdatedAt: watermark,
      error: null,
      errorStatus: null,
      errorDetail: null,
      note: null,
    });

    return { ok: true, storeKey: key, pages, upserts, watermark: watermark.toISOString() };
  })()
    .catch(async (err) => {
      const parsed = parseAxiosError(err);
      await setMeta(store, {
        status: "error",
        finishedAt: new Date(),
        error: parsed.message,
        errorStatus: parsed.status,
        errorDetail: parsed.detail,
      });
      return { ok: false, storeKey: store.storeKey, error: parsed.message, status: parsed.status };
    })
    .finally(() => {
      syncLocks.delete(key);
    });

  syncLocks.set(key, p);
  return p;
}

async function syncAll({ full = false, clear = false } = {}) {
  const results = [];
  for (const store of STORE_REGISTRY.stores) {
    results.push(await syncStore(store, { full, clear }));
  }
  return results;
}

/** -----------------------------
 * API endpoints
 * ----------------------------*/
function requireSyncSecret(req, res) {
  if (!SYNC_SECRET) return true;
  const provided = String(req.headers["x-sync-secret"] || "").trim();
  if (provided !== SYNC_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/api/stores", (req, res) => {
  res.json({
    ok: true,
    count: STORE_REGISTRY.stores.length,
    stores: STORE_REGISTRY.stores.map((s) => ({
      storeKey: s.storeKey,
      groupKey: s.groupKey,
      domain: s.domain,
      collection: ordersCollectionName(s.storeKey),
    })),
  });
});

// Read cached orders from Mongo
// - Default: paginated
// - If ?all=true : return ALL orders (no cap)
app.get("/api/orders", async (req, res) => {
  const store = resolveStoreFromRequest(req);

  const all = String(req.query.all || "false").toLowerCase() === "true";

  // Normal paginated mode
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 5000));
  const skip = Math.max(0, Number(req.query.skip || 0) || 0);

  try {
    if (!store) {
      return res.status(400).json({ ok: false, error: "Unknown store. Use ?store=... or ?shop=...myshopify.com" });
    }

    if (SYNC_ON_READ) {
      syncStore(store, { full: false }).catch(() => {});
    }

    const col = await getOrdersCol(store.storeKey);

    // Useful for UI even in "all" mode
    const totalCached = await col.estimatedDocumentCount().catch(() => null);

    let cursor = col.find({}).sort({ createdAt: -1 });

    if (!all) {
      cursor = cursor.skip(skip).limit(limit);
    }

    const orders = await cursor.toArray();

    res.json({
      ok: true,
      store: store.storeKey,
      group: store.groupKey,
      shop: store.domain,
      source: "mongodb",
      collection: ordersCollectionName(store.storeKey),

      all,
      totalCached,

      skip: all ? 0 : skip,
      limit: all ? null : limit,
      count: orders.length,

      orders,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    const db = await getDb();
    const meta = await getMetaCol();

    const snapshot = [];
    for (const store of STORE_REGISTRY.stores) {
      const colName = ordersCollectionName(store.storeKey);
      const cachedCount = await db.collection(colName).estimatedDocumentCount().catch(() => 0);
      const m = await meta.findOne({ storeKey: store.storeKey });

      snapshot.push({
        store: store.storeKey,
        group: store.groupKey,
        shop: store.domain,
        collection: colName,
        cachedCount,
        syncStatus: m?.status || "unknown",
        mode: m?.mode || null,
        lastSyncedUpdatedAt: m?.lastSyncedUpdatedAt || null,
        lastRunUpserts: m?.lastRunUpserts || 0,
        pages: m?.pages || null,
        error: m?.error || null,
        errorStatus: m?.errorStatus || null,
        errorDetail: m?.errorDetail || null,
        note: m?.note || null,
      });
    }

    res.json({
      ok: true,
      db: MONGODB_DB,
      groups: SHOP_KEYS.map((k) => k.toLowerCase()),
      stores: STORE_REGISTRY.stores.map((s) => s.storeKey),
      ordersQueryBase: SHOPIFY_ORDERS_QUERY_BASE,
      snapshot,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/sync-shop", async (req, res) => {
  if (!requireSyncSecret(req, res)) return;

  const full = String(req.query.full || "false").toLowerCase() === "true";
  const clear = String(req.query.clear || "false").toLowerCase() === "true";

  const shop = normalizeShopDomain(req.query.shop);
  const storeKey = String(req.query.store || "").trim().toLowerCase();

  let store = null;
  if (shop && STORE_REGISTRY.byShop.has(shop)) store = STORE_REGISTRY.byShop.get(shop);
  else if (storeKey && STORE_REGISTRY.byStoreKey.has(storeKey)) store = STORE_REGISTRY.byStoreKey.get(storeKey);

  if (!store) {
    return res.status(400).json({
      ok: false,
      error: "Use /api/sync-shop?store=cellumove_es or /api/sync-shop?shop=xxxx.myshopify.com",
    });
  }

  syncStore(store, { full, clear }).catch(() => {});
  res.json({ ok: true, started: true, store: store.storeKey, shop: store.domain, full, clear });
});

app.post("/api/sync-all", async (req, res) => {
  if (!requireSyncSecret(req, res)) return;

  const full = String(req.query.full || "false").toLowerCase() === "true";
  const clear = String(req.query.clear || "false").toLowerCase() === "true";

  syncAll({ full, clear }).catch(() => {});
  res.json({ ok: true, started: true, stores: STORE_REGISTRY.stores.map((s) => s.storeKey), full, clear });
});

// Verify granted scopes for a given shop/store using currentAppInstallation
app.get("/api/scopes", async (req, res) => {
  const store = resolveStoreFromRequest(req);
  if (!store) return res.status(400).json({ ok: false, error: "Unknown store. Use ?store=... or ?shop=..." });

  try {
    const auth = await getShopifyToken(store, { force: false });

    const q = `
      query {
        currentAppInstallation {
          accessScopes { handle }
        }
      }
    `;

    const data = await shopifyGraphql({ domain: auth.domain, token: auth.token, query: q, variables: {} });
    const scopes = data?.currentAppInstallation?.accessScopes?.map((s) => s.handle) || [];

    res.json({
      ok: true,
      store: store.storeKey,
      shop: store.domain,
      scopes,
      has_read_all_orders: scopes.includes("read_all_orders"),
    });
  } catch (err) {
    const parsed = parseAxiosError(err);
    res.status(500).json({ ok: false, error: parsed.message, status: parsed.status, detail: parsed.detail });
  }
});

/** -----------------------------
 * Boot
 * ----------------------------*/
app.listen(PORT, async () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`API_VERSION=${API_VERSION}`);
  console.log(`MongoDB db=${MONGODB_DB}`);
  console.log(`Orders query base="${SHOPIFY_ORDERS_QUERY_BASE}"`);
  console.log(`Discovered stores=${STORE_REGISTRY.stores.map((s) => `${s.storeKey}=>${s.domain}`).join(", ")}`);

  try {
    await getMongoClient();
    console.log("[mongo] connected");
  } catch (e) {
    console.warn("[mongo] connection failed:", e?.message || e);
  }

  if (SYNC_ON_START) {
    syncAll({ full: false, clear: false }).catch(() => {});
    console.log("[sync] started on boot (incremental; full if empty)");
  }
});

module.exports = app;
