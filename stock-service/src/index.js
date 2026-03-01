const express = require('express');
const Redis = require('ioredis');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

let redis;
const metrics = { totalDecrements: 0, failedDecrements: 0, totalLatency: 0, requestCount: 0 };

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }
  return redis;
}

// Initialize stock items
const MENU_ITEMS = {
  'biryani': { name: 'Chicken Biryani', price: 120, emoji: '🍛' },
  'khichuri': { name: 'Special Khichuri', price: 80, emoji: '🥘' },
  'haleem': { name: 'Beef Haleem', price: 150, emoji: '🍲' },
  'dates': { name: 'Dates Pack', price: 50, emoji: '🌴' },
  'juice': { name: 'Mixed Fruit Juice', price: 60, emoji: '🧃' },
};

async function initializeStock(r) {
  for (const [id, item] of Object.entries(MENU_ITEMS)) {
    const key = `stock:${id}`;
    const existing = await r.get(key);
    if (!existing) {
      await r.set(key, 100); // 100 units default
    }
  }
}

app.use(async (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => { metrics.totalLatency += Date.now() - start; metrics.requestCount++; });
  next();
});

app.get('/stock', async (req, res) => {
  try {
    const r = getRedis();
    const result = {};
    for (const [id, item] of Object.entries(MENU_ITEMS)) {
      const qty = await r.get(`stock:${id}`);
      result[id] = { ...item, quantity: parseInt(qty) || 0 };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/stock/:itemId', async (req, res) => {
  try {
    const r = getRedis();
    const { itemId } = req.params;
    if (!MENU_ITEMS[itemId]) return res.status(404).json({ error: 'Item not found' });
    const qty = await r.get(`stock:${itemId}`);
    res.json({ itemId, ...MENU_ITEMS[itemId], quantity: parseInt(qty) || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Optimistic locking via Redis WATCH for concurrency control
app.post('/stock/:itemId/decrement', async (req, res) => {
  const { itemId } = req.params;
  const { quantity = 1, orderId } = req.body;

  if (!MENU_ITEMS[itemId]) return res.status(404).json({ error: 'Item not found' });

  // Idempotency: check if order already processed
  const r = getRedis();
  const idempotencyKey = `idempotent:decrement:${orderId}`;
  if (orderId) {
    const existing = await r.get(idempotencyKey);
    if (existing) {
      return res.json({ success: true, idempotent: true, message: 'Already processed' });
    }
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const stockKey = `stock:${itemId}`;
    await r.watch(stockKey);
    const current = parseInt(await r.get(stockKey)) || 0;

    if (current < quantity) {
      await r.unwatch();
      metrics.failedDecrements++;
      return res.status(409).json({ error: 'Insufficient stock', available: current });
    }

    const pipeline = r.multi();
    pipeline.decrby(stockKey, quantity);
    if (orderId) pipeline.set(idempotencyKey, '1', 'EX', 3600);

    const result = await pipeline.exec();
    if (result === null) {
      // Watch failed - retry
      continue;
    }

    metrics.totalDecrements++;
    const newQty = result[0][1];
    return res.json({ success: true, itemId, newQuantity: newQty, decremented: quantity });
  }

  metrics.failedDecrements++;
  res.status(500).json({ error: 'Too many concurrent modifications, try again' });
});

app.post('/stock/:itemId/reset', async (req, res) => {
  try {
    const r = getRedis();
    const { itemId } = req.params;
    const { quantity = 100 } = req.body;
    if (!MENU_ITEMS[itemId]) return res.status(404).json({ error: 'Item not found' });
    await r.set(`stock:${itemId}`, quantity);
    res.json({ success: true, itemId, quantity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/stock/reset-all', async (req, res) => {
  try {
    const r = getRedis();
    for (const id of Object.keys(MENU_ITEMS)) {
      await r.set(`stock:${id}`, 100);
    }
    res.json({ success: true, message: 'All stock reset to 100' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    const r = getRedis();
    await r.ping();
    res.json({ status: 'ok', service: 'stock-service', dependencies: { redis: 'ok' } });
  } catch {
    res.status(503).json({ status: 'degraded', service: 'stock-service', dependencies: { redis: 'down' } });
  }
});

app.get('/metrics', (req, res) => {
  res.json({
    totalDecrements: metrics.totalDecrements,
    failedDecrements: metrics.failedDecrements,
    avgLatencyMs: metrics.requestCount ? Math.round(metrics.totalLatency / metrics.requestCount) : 0,
    requestCount: metrics.requestCount,
  });
});

const PORT = process.env.PORT || 3003;
if (require.main === module) {
  const r = getRedis();
  r.once('ready', async () => {
    await initializeStock(r);
    app.listen(PORT, () => console.log(`Stock Service running on :${PORT}`));
  });
}
module.exports = { app, getRedis };
