const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
  console.warn("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN in .env");
}

// For JSON body parsing if needed later
app.use(express.json());

// Simple health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Proxy endpoint: GET /api/shopify/orders/:orderNo
app.get("/api/shopify/orders/:orderNo", async (req, res) => {
  const orderIdentifier = req.params.orderNo;
  const raw = String(orderIdentifier);
  const match = raw.match(/\d+/);
  if (!match) {
    return res.status(400).json({ error: "Invalid order identifier" });
  }
  const orderNumber = match[0];

  const nameParam = encodeURIComponent(`#${orderNumber}`);
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&name=${nameParam}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Shopify response error", resp.status, text);
      return res
        .status(resp.status)
        .json({ error: "Shopify error", status: resp.status, body: text });
    }

    const data = await resp.json();
    const order = data.orders && data.orders.length > 0 ? data.orders[0] : null;
    res.json({ order });
  } catch (err) {
    console.error("Error calling Shopify API", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Shopify proxy server listening on port ${PORT}`);
});
