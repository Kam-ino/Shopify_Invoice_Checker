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

/** -----------------------------
 * Utilities
 * ----------------------------*/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

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
  // Keep your old naming but sanitize storeKey
  return `${ORDERS_PREFIX}${safeMongoSuffix(storeKey)}`;
}

/**
 * Discovers ALL stores from env based on SHOP_KEYS groups.
 *
 * For group KEY (e.g. CELLUMOVE), it will include:
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
  const byShop = new Map();     // shop domain -> storeCfg
  const byStoreKey = new Map(); // storeKey -> storeCfg

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
        groupKey: KEY.toLowerCase(), // e.g. cellumove
        storeKey,                    // e.g. cellumove_es
        domain,                      // e.g. rjhgvi-iz.myshopify.com
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

  // Stable order for logs/health
  stores.sort((a, b) => a.storeKey.localeCompare(b.storeKey));
  return { stores, byShop, byStoreKey };
}

const STORE_REGISTRY = buildStoreRegistryFromEnv();

function resolveStoreFromRequest(req) {
  // Preferred: Shopify calls commonly include `shop`
  const shopQ = normalizeShopDomain(req.query.shop);
  if (shopQ && STORE_REGISTRY.byShop.has(shopQ)) return STORE_REGISTRY.byShop.get(shopQ);

  // Sometimes available as header (webhooks/app proxy setups vary)
  const shopH = normalizeShopDomain(req.headers["x-shopify-shop-domain"]);
  if (shopH && STORE_REGISTRY.byShop.has(shopH)) return STORE_REGISTRY.byShop.get(shopH);

  // Fallback: your legacy param ?store=bloomommy OR ?store=cellumove_es
  const storeQ = String(req.query.store || "").trim().toLowerCase();
  if (storeQ && STORE_REGISTRY.byStoreKey.has(storeQ)) return STORE_REGISTRY.byStoreKey.get(storeQ);

  // Default to first configured store
  return STORE_REGISTRY.stores[0] || null;
}

/** -----------------------------
 * MongoDB connection (with IPv4 preference)
 * ----------------------------*/
if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI");
}

let _mongoClient = null;
let _mongoPromise = null;

async function getMongoClient() {
  if (_mongoClient) return _mongoClient;

  if (!_mongoPromise) {
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

  // Token docs keyed by shop domain (and storeKey for convenience)
  await tokens.createIndex({ domain: 1 }, { unique: true });
  await tokens.createIndex({ storeKey: 1 }, { unique: true });

  // Meta docs keyed by storeKey
  await meta.createIndex({ storeKey: 1 }, { unique: true });
  await meta.createIndex({ domain: 1 });

  // Orders keyed by Shopify order id (global ID)
  await orders.createIndex({ id: 1 }, { unique: true });
  await orders.createIndex({ createdAt: -1 });
  await orders.createIndex({ updatedAt: -1 });
}

/** -----------------------------
 * 1) Token: fetch + store in Mongo
 * ----------------------------*/
async function fetchClientCredentialsToken({ domain, clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error(`Missing client credentials for ${storeHint(domain)}. Check <GROUP>_SHOPIFY_CLIENT_ID/SECRET`);
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

  // Refresh 60 seconds early
  const effective = (expiresIn || 86399) - 60;
  const expiresAtMs = Date.now() + Math.max(1, effective) * 1000;

  return { token, expiresIn: expiresIn || 86399, expiresAtMs };
}

function storeHint(domain) {
  return domain ? `shop=${domain}` : "shop=<unknown>";
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
 * Shopify GraphQL (with basic 429 backoff)
 * ----------------------------*/
async function shopifyGraphql({ domain, token, query, variables }) {
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  const maxRetries = 6;
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
        const e = new Error("Shopify GraphQL returned errors");
        e.shopifyStatus = 200;
        e.shopifyData = resp.data;
        throw e;
      }

      return resp.data?.data;
    } catch (err) {
      const status = err?.response?.status ?? err.shopifyStatus ?? null;

      if (status === 429 && attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        await sleep(backoffMs);
        continue;
      }

      if (status === 401) {
        const e = new Error("Unauthorized (401) from Shopify");
        e.shopifyStatus = 401;
        e.shopifyData = err?.response?.data || err.shopifyData || null;
        throw e;
      }

      const e = new Error(err.message || "Shopify request failed");
      e.shopifyStatus = status;
      e.shopifyData = err?.response?.data || err.shopifyData || null;
      throw e;
    }
  }
}

/** -----------------------------
 * 2) Orders: fetch + store in Mongo
 * ----------------------------*/
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

  const queryString = updatedSinceIso ? `updated_at:>=${updatedSinceIso}` : null;

  const data = await shopifyGraphql({
    domain,
    token,
    query: q,
    variables: { first: 250, after: after || null, query: queryString },
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

async function estimatedOrderCount(storeKey) {
  const col = await getOrdersCol(storeKey);
  return col.estimatedDocumentCount();
}

/** -----------------------------
 * Sync engine
 * ----------------------------*/
const syncLocks = new Map(); // storeKey -> Promise

async function syncStore(store, { full = false } = {}) {
  if (!store?.storeKey) throw new Error("syncStore requires a store config");

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
      error: null,
      mode: modeFull ? "full" : "incremental",
      priorCachedCount: count,
      note: null,
    });

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
      note: null,
    });

    return { ok: true, storeKey: key, domain: store.domain, pages, upserts, watermark: watermark.toISOString() };
  })()
    .catch(async (err) => {
      await setMeta(store, {
        status: "error",
        finishedAt: new Date(),
        error: err?.message || String(err),
      });
      return { ok: false, storeKey: store.storeKey, domain: store.domain, error: err?.message || String(err) };
    })
    .finally(() => {
      syncLocks.delete(key);
    });

  syncLocks.set(key, p);
  return p;
}

async function syncAll({ full = false } = {}) {
  const results = [];
  for (const store of STORE_REGISTRY.stores) {
    results.push(await syncStore(store, { full }));
  }
  return results;
}

/** -----------------------------
 * 3) Serve from MongoDB (fast)
 * ----------------------------*/
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

app.get("/api/orders", async (req, res) => {
  const store = resolveStoreFromRequest(req);
  const limit = Math.max(0, Math.min(Number(req.query.limit || 200) || 200, 5000));

  try {
    if (!store) {
      return res.status(400).json({
        ok: false,
        error: "Unknown store. Pass ?shop={shop}.myshopify.com (preferred) or ?store={storeKey}.",
      });
    }

    if (SYNC_ON_READ) {
      syncStore(store, { full: false }).catch(() => {});
    }

    const col = await getOrdersCol(store.storeKey);
    const orders = await col.find({}).sort({ createdAt: -1 }).limit(limit).toArray();

    res.json({
      ok: true,
      store: store.storeKey,
      group: store.groupKey,
      shop: store.domain,
      source: "mongodb",
      collection: ordersCollectionName(store.storeKey),
      count: orders.length,
      orders,
      note:
        orders.length === 0
          ? "No cached orders yet. Trigger POST /api/sync-shop?shop=... (or /api/sync-all) and check /api/health."
          : undefined,
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
        error: m?.error || null,
        note: m?.note || null,
      });
    }

    res.json({
      ok: true,
      db: MONGODB_DB,
      groups: SHOP_KEYS.map((k) => k.toLowerCase()),
      stores: STORE_REGISTRY.stores.map((s) => s.storeKey),
      snapshot,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/** -----------------------------
 * Manual sync endpoints
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

app.post("/api/sync-shop", async (req, res) => {
  if (!requireSyncSecret(req, res)) return;

  // Prefer: /api/sync-shop?shop=xxx.myshopify.com
  const shop = normalizeShopDomain(req.query.shop);
  const storeKey = String(req.query.store || "").trim().toLowerCase();
  const full = String(req.query.full || "false").toLowerCase() === "true";

  let store = null;
  if (shop && STORE_REGISTRY.byShop.has(shop)) store = STORE_REGISTRY.byShop.get(shop);
  else if (storeKey && STORE_REGISTRY.byStoreKey.has(storeKey)) store = STORE_REGISTRY.byStoreKey.get(storeKey);

  if (!store) {
    return res.status(400).json({
      ok: false,
      error: "shop or store is required. Example: /api/sync-shop?shop=dm1i1x-d4.myshopify.com",
    });
  }

  syncStore(store, { full }).catch(() => {});
  res.json({ ok: true, started: true, store: store.storeKey, shop: store.domain, full });
});

app.post("/api/sync-all", async (req, res) => {
  if (!requireSyncSecret(req, res)) return;

  const full = String(req.query.full || "false").toLowerCase() === "true";
  syncAll({ full }).catch(() => {});
  res.json({ ok: true, started: true, stores: STORE_REGISTRY.stores.map((s) => s.storeKey), full });
});

/** -----------------------------
 * Boot
 * ----------------------------*/
app.listen(PORT, async () => {
  console.log(`Server running: http://localhost:${PORT}/api/orders`);
  console.log(`API_VERSION=${API_VERSION}`);
  console.log(`MongoDB db=${MONGODB_DB}`);
  console.log(`Groups=${SHOP_KEYS.map((k) => k.toLowerCase()).join(", ")}`);
  console.log(`Discovered stores=${STORE_REGISTRY.stores.map((s) => `${s.storeKey}=>${s.domain}`).join(", ")}`);
  console.log(`Orders collections: ${ORDERS_PREFIX}<storeKey>`);

  try {
    await getMongoClient();
    console.log("[mongo] connected");
  } catch (e) {
    console.warn("[mongo] connection failed:", e?.message || e);
  }

  if (SYNC_ON_START) {
    syncAll({ full: false }).catch(() => {});
    console.log("[sync] started on boot (incremental, full if empty)");
  }
});

module.exports = app;
