const express = require('express');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// SSE client registry: orderId -> Set of response objects
const clients = new Map(); // orderId -> [res, ...]
const orderStatuses = new Map();
const metrics = { totalNotifications: 0, totalLatency: 0, requestCount: 0, errors: 0 };

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => { metrics.totalLatency += Date.now() - start; metrics.requestCount++; });
  next();
});

// SSE subscription per orderId
app.get('/events/:orderId', (req, res) => {
  const { orderId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current status if exists
  if (orderStatuses.has(orderId)) {
    res.write(`data: ${JSON.stringify(orderStatuses.get(orderId))}\n\n`);
  }

  if (!clients.has(orderId)) clients.set(orderId, new Set());
  clients.get(orderId).add(res);

  req.on('close', () => {
    clients.get(orderId)?.delete(res);
    if (clients.get(orderId)?.size === 0) clients.delete(orderId);
  });
});

// Push a notification to all subscribers for an order
app.post('/notify', (req, res) => {
  const { orderId, status, message, data } = req.body;
  if (!orderId || !status) return res.status(400).json({ error: 'orderId and status required' });

  const payload = { orderId, status, message, data, timestamp: new Date().toISOString() };
  orderStatuses.set(orderId, payload);
  metrics.totalNotifications++;

  const subscribers = clients.get(orderId);
  if (subscribers) {
    const eventStr = `data: ${JSON.stringify(payload)}\n\n`;
    for (const clientRes of subscribers) {
      try { clientRes.write(eventStr); } catch {}
    }
  }

  res.json({ success: true, subscriberCount: subscribers?.size || 0 });
});

// Get all current statuses (for admin dashboard)
app.get('/statuses', (req, res) => {
  const statuses = Object.fromEntries(orderStatuses);
  res.json(statuses);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'notification-hub', connectedClients: clients.size });
});

app.get('/metrics', (req, res) => {
  res.json({
    totalNotifications: metrics.totalNotifications,
    errors: metrics.errors,
    avgLatencyMs: metrics.requestCount ? Math.round(metrics.totalLatency / metrics.requestCount) : 0,
    activeConnections: [...clients.values()].reduce((sum, s) => sum + s.size, 0),
    requestCount: metrics.requestCount,
  });
});

const PORT = process.env.PORT || 3005;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Notification Hub running on :${PORT}`));
}
module.exports = app;
