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

const SHOP_KEYS = String(process.env.SHOP_KEYS || "bloomommy,cellumove")
  .split(",")
  .map((s) => s.trim().toLowerCase())
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

function getStoreCfg(storeKeyRaw) {
  const storeKey = String(storeKeyRaw).toLowerCase();
  const prefix = storeKey.toUpperCase();

  const domain = mustEnv(`${prefix}_SHOPIFY_STORE_DOMAIN`);
  const clientId = mustEnv(`${prefix}_SHOPIFY_CLIENT_ID`);
  const clientSecret = mustEnv(`${prefix}_SHOPIFY_CLIENT_SECRET`);

  return { storeKey, domain, clientId, clientSecret };
}

function ordersCollectionName(storeKey) {
  return `${ORDERS_PREFIX}${storeKey}`;
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
    // The TLS/SSL errors you saw on Windows often resolve when IPv4 is forced.
    // This is safe and commonly used in environments with IPv6/DNS issues.
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

async function ensureIndexesForStore(storeKey) {
  const tokens = await getTokensCol();
  const meta = await getMetaCol();
  const orders = await getOrdersCol(storeKey);

  // Token docs keyed by storeKey
  await tokens.createIndex({ storeKey: 1 }, { unique: true });

  // Meta docs keyed by storeKey
  await meta.createIndex({ storeKey: 1 }, { unique: true });

  // Orders keyed by Shopify order id (global ID)
  await orders.createIndex({ id: 1 }, { unique: true });
  await orders.createIndex({ createdAt: -1 });
  await orders.createIndex({ updatedAt: -1 });
}

/** -----------------------------
 * 1) Token: fetch + store in Mongo
 * ----------------------------*/
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
  const expiresIn = Number(resp.data?.expires_in ?? 0); // seconds (if missing, we assume ~24h)
  if (!token) throw new Error(`No access_token returned for ${domain}`);

  // Refresh 60 seconds early
  const effective = (expiresIn || 86399) - 60;
  const expiresAtMs = Date.now() + Math.max(1, effective) * 1000;

  return { token, expiresIn: expiresIn || 86399, expiresAtMs };
}

async function readTokenDoc(storeKey) {
  const tokens = await getTokensCol();
  return tokens.findOne({ storeKey });
}

async function upsertTokenDoc(storeKey, domain, token, expiresAtMs, expiresIn) {
  const tokens = await getTokensCol();
  await tokens.updateOne(
    { storeKey },
    {
      $set: {
        storeKey,
        domain,
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

async function getShopifyToken(storeKey, { force = false } = {}) {
  const cfg = getStoreCfg(storeKey);

  if (!force) {
    const doc = await readTokenDoc(cfg.storeKey);
    if (doc?.token && Number(doc.expiresAtMs || 0) > Date.now()) {
      return { domain: cfg.domain, token: doc.token, source: "mongo" };
    }
  }

  // Mint new token and store in Mongo
  const fresh = await fetchClientCredentialsToken(cfg);
  await upsertTokenDoc(cfg.storeKey, cfg.domain, fresh.token, fresh.expiresAtMs, fresh.expiresIn);
  return { domain: cfg.domain, token: fresh.token, source: "minted" };
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

      // Retry on 429 with exponential backoff (Shopify recommends waiting before retrying). :contentReference[oaicite:5]{index=5}
      if (status === 429 && attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
        await sleep(backoffMs);
        continue;
      }

      // If token is invalid/expired, surface for caller to refresh & retry
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
 *    Incremental sync uses updated_at filter via orders(query: ...). :contentReference[oaicite:6]{index=6}
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

async function setMeta(storeKey, patch) {
  const meta = await getMetaCol();
  await meta.updateOne(
    { storeKey },
    {
      $set: { storeKey, ...patch, updatedAt: new Date() },
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

async function syncStore(storeKey, { full = false } = {}) {
  const key = String(storeKey).toLowerCase();
  if (syncLocks.has(key)) return syncLocks.get(key);

  const p = (async () => {
    await ensureIndexesForStore(key);

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

    await setMeta(key, {
      status: "running",
      startedAt: new Date(),
      error: null,
      mode: modeFull ? "full" : "incremental",
      priorCachedCount: count,
    });

    // token from Mongo, refresh if expired
    let auth = await getShopifyToken(key);

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
        // 4) if token expired/invalid, mint new token, store, retry loop
        if (e.shopifyStatus === 401) {
          await setMeta(key, { note: "401 from Shopify: refreshing token and retrying..." });
          auth = await getShopifyToken(key, { force: true });
          await sleep(250);
          continue;
        }
        throw e;
      }
    }

    const watermark = maxUpdatedAt || new Date();
    await setMeta(key, {
      status: "idle",
      finishedAt: new Date(),
      pages,
      lastRunUpserts: upserts,
      lastSyncedUpdatedAt: watermark,
      error: null,
    });

    return { ok: true, storeKey: key, pages, upserts, watermark: watermark.toISOString() };
  })()
    .catch(async (err) => {
      await setMeta(storeKey, {
        status: "error",
        finishedAt: new Date(),
        error: err?.message || String(err),
      });
      return { ok: false, storeKey, error: err?.message || String(err) };
    })
    .finally(() => {
      syncLocks.delete(key);
    });

  syncLocks.set(key, p);
  return p;
}

async function syncAll({ full = false } = {}) {
  const results = [];
  for (const k of SHOP_KEYS) {
    // sequential reduces throttling risk
    results.push(await syncStore(k, { full }));
  }
  return results;
}

/** -----------------------------
 * 3) Serve from MongoDB (fast)
 * ----------------------------*/
app.get("/api/orders", async (req, res) => {
  const store = String(req.query.store || SHOP_KEYS[0] || "bloomommy").toLowerCase();
  const limit = Math.max(0, Math.min(Number(req.query.limit || 200) || 200, 5000));

  try {
    if (!SHOP_KEYS.includes(store)) {
      return res.status(400).json({ ok: false, error: `Unknown store. Allowed: ${SHOP_KEYS.join(", ")}` });
    }

    if (SYNC_ON_READ) {
      syncStore(store, { full: false }).catch(() => {});
    }

    const col = await getOrdersCol(store);
    const orders = await col.find({}).sort({ createdAt: -1 }).limit(limit).toArray();

    res.json({
      ok: true,
      store,
      source: "mongodb",
      collection: ordersCollectionName(store),
      count: orders.length,
      orders,
      note:
        orders.length === 0
          ? "No cached orders yet. Trigger POST /api/sync-shop?store=... (or /api/sync-all) and check /api/health."
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
    for (const store of SHOP_KEYS) {
      const colName = ordersCollectionName(store);
      const cachedCount = await db.collection(colName).estimatedDocumentCount().catch(() => 0);
      const m = await meta.findOne({ storeKey: store });

      snapshot.push({
        store,
        collection: colName,
        cachedCount,
        syncStatus: m?.status || "unknown",
        mode: m?.mode || null,
        lastSyncedUpdatedAt: m?.lastSyncedUpdatedAt || null,
        lastRunUpserts: m?.lastRunUpserts || 0,
        error: m?.error || null,
      });
    }

    res.json({ ok: true, db: MONGODB_DB, shops: SHOP_KEYS, snapshot });
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

  const store = String(req.query.store || "").toLowerCase();
  const full = String(req.query.full || "false").toLowerCase() === "true";

  if (!store || !SHOP_KEYS.includes(store)) {
    return res.status(400).json({ ok: false, error: `store is required. Allowed: ${SHOP_KEYS.join(", ")}` });
  }

  // start async
  syncStore(store, { full }).catch(() => {});
  res.json({ ok: true, started: true, store, full });
});

app.post("/api/sync-all", async (req, res) => {
  if (!requireSyncSecret(req, res)) return;

  const full = String(req.query.full || "false").toLowerCase() === "true";
  syncAll({ full }).catch(() => {});
  res.json({ ok: true, started: true, shops: SHOP_KEYS, full });
});

/** -----------------------------
 * Boot
 * ----------------------------*/
app.listen(PORT, async () => {
  console.log(`Server running: http://localhost:${PORT}/api/orders`);
  console.log(`API_VERSION=${API_VERSION}`);
  console.log(`MongoDB db=${MONGODB_DB}`);
  console.log(`Shops=${SHOP_KEYS.join(", ")}`);
  console.log(`Orders collections: ${ORDERS_PREFIX}<storeKey>`);

  try {
    // validate mongo connectivity
    await getMongoClient();
    console.log("[mongo] connected");
  } catch (e) {
    console.warn("[mongo] connection failed:", e?.message || e);
  }

  if (SYNC_ON_START) {
    // non-blocking sync on start
    syncAll({ full: false }).catch(() => {});
    console.log("[sync] started on boot (incremental, full if empty)");
  }
});

module.exports = app; 