const express = require('express');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { validateOrder } = require('./orderValidation');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const STOCK_SERVICE_URL = process.env.STOCK_SERVICE_URL || 'http://localhost:3003';
const KITCHEN_QUEUE_URL = process.env.KITCHEN_QUEUE_URL || 'http://localhost:3004';
const NOTIFICATION_HUB_URL = process.env.NOTIFICATION_HUB_URL || 'http://localhost:3005';

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  return redis;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
const metrics = { totalOrders: 0, failedOrders: 0, latencies: [], errors: 0 };
const LATENCY_WINDOW = 30; // seconds for bonus alert

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const latency = Date.now() - start;
    metrics.latencies.push({ latency, time: Date.now() });
    // keep only last 5 min
    const cutoff = Date.now() - 5 * 60 * 1000;
    metrics.latencies = metrics.latencies.filter(l => l.time > cutoff);
    if (res.statusCode >= 500) metrics.errors++;
  });
  next();
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Missing bearer token' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/orders', requireAuth, async (req, res) => {
  const start = Date.now();
  const orderId = uuidv4();

  // 1. Validate order structure
  const validation = validateOrder(req.body);
  if (!validation.valid) {
    metrics.failedOrders++;
    return res.status(400).json({ error: 'Invalid order', details: validation.errors });
  }

  const { items } = req.body;

  // 2. Cache-first stock check
  try {
    const r = getRedis();
    for (const item of items) {
      const cacheKey = `stock:${item.itemId}`;
      const cached = await r.get(cacheKey);
      if (cached !== null && parseInt(cached) < item.quantity) {
        metrics.failedOrders++;
        return res.status(409).json({
          error: 'Out of stock',
          itemId: item.itemId,
          available: parseInt(cached),
          source: 'cache'
        });
      }
    }
  } catch (err) {
    console.warn('Redis cache check failed, proceeding:', err.message);
  }

  // 3. Notify: PENDING
  await fetch(`${NOTIFICATION_HUB_URL}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, status: 'PENDING', message: 'Order received, checking stock...', data: { items } }),
  }).catch(() => {});

  // 4. Decrement stock via Stock Service (with optimistic locking + idempotency)
  for (const item of items) {
    try {
      const stockRes = await fetch(`${STOCK_SERVICE_URL}/stock/${item.itemId}/decrement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: item.quantity, orderId }),
      });

      if (!stockRes.ok) {
        const err = await stockRes.json();
        metrics.failedOrders++;
        await fetch(`${NOTIFICATION_HUB_URL}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId, status: 'FAILED', message: `Stock error: ${err.error}` }),
        }).catch(() => {});
        return res.status(409).json({ error: err.error, orderId });
      }

      // Update cache
      const data = await stockRes.json();
      try {
        const r = getRedis();
        await r.set(`stock:${item.itemId}`, data.newQuantity, 'EX', 60);
      } catch {}

    } catch (err) {
      metrics.failedOrders++;
      return res.status(502).json({ error: 'Stock service unavailable', orderId });
    }
  }

  // 5. Notify: STOCK_VERIFIED
  await fetch(`${NOTIFICATION_HUB_URL}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, status: 'STOCK_VERIFIED', message: 'Stock confirmed! Sending to kitchen... 🔪', data: { items } }),
  }).catch(() => {});

  // 6. Send to Kitchen Queue (async — <2s ack)
  try {
    const kitchenRes = await fetch(`${KITCHEN_QUEUE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        studentId: req.user.studentId,
        items,
        total: req.body.total,
      }),
    });
    if (!kitchenRes.ok) throw new Error('Kitchen queue error');
  } catch (err) {
    metrics.failedOrders++;
    return res.status(502).json({ error: 'Kitchen queue unavailable', orderId });
  }

  metrics.totalOrders++;
  const latency = Date.now() - start;
  res.json({ success: true, orderId, status: 'QUEUED', message: 'Order accepted!', latencyMs: latency });
});

// Proxy stock endpoint for frontend
app.get('/stock', requireAuth, async (req, res) => {
  try {
    const stockRes = await fetch(`${STOCK_SERVICE_URL}/stock`);
    const data = await stockRes.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Stock service unavailable' });
  }
});

app.get('/health', async (req, res) => {
  const checks = {};
  const deps = [
    ['stock-service', `${STOCK_SERVICE_URL}/health`],
    ['kitchen-queue', `${KITCHEN_QUEUE_URL}/health`],
    ['notification-hub', `${NOTIFICATION_HUB_URL}/health`],
  ];

  let allOk = true;
  for (const [name, url] of deps) {
    try {
      const r = await fetch(url, { timeout: 2000 });
      checks[name] = r.ok ? 'ok' : 'degraded';
      if (!r.ok) allOk = false;
    } catch {
      checks[name] = 'down';
      allOk = false;
    }
  }

  try {
    await getRedis().ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'down';
    allOk = false;
  }

  const status = allOk ? 200 : 503;
  res.status(status).json({ status: allOk ? 'ok' : 'degraded', service: 'order-gateway', dependencies: checks });
});

app.get('/metrics', (req, res) => {
  const now = Date.now();
  const window30 = metrics.latencies.filter(l => l.time > now - LATENCY_WINDOW * 1000);
  const avg30 = window30.length ? Math.round(window30.reduce((s, l) => s + l.latency, 0) / window30.length) : 0;
  const avgAll = metrics.latencies.length ? Math.round(metrics.latencies.reduce((s, l) => s + l.latency, 0) / metrics.latencies.length) : 0;

  res.json({
    totalOrders: metrics.totalOrders,
    failedOrders: metrics.failedOrders,
    errors: metrics.errors,
    avgLatencyMs: avgAll,
    avgLatency30sMs: avg30,
    alertHighLatency: avg30 > 1000, // BONUS: alert if >1s over 30s window
    requestCount: metrics.latencies.length,
  });
});

const PORT = process.env.PORT || 3002;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Order Gateway running on :${PORT}`));
}
module.exports = app;
