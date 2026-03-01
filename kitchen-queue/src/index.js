const express = require('express');
const amqp = require('amqplib');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://cafeteria:iftar2024@localhost:5672';
const NOTIFICATION_HUB_URL = process.env.NOTIFICATION_HUB_URL || 'http://localhost:3005';
const QUEUE_NAME = 'kitchen_orders';

let channel = null;
let rabbitConnected = false;
const metrics = { totalOrders: 0, failedOrders: 0, totalLatency: 0, requestCount: 0 };

async function connectRabbit(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE_NAME, { durable: true });
      rabbitConnected = true;
      console.log('Connected to RabbitMQ');
      // Start consuming
      channel.consume(QUEUE_NAME, processOrder, { noAck: false });
      return;
    } catch (err) {
      console.log(`RabbitMQ not ready (attempt ${i+1}), retrying...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function notify(orderId, status, message, data) {
  try {
    await fetch(`${NOTIFICATION_HUB_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, status, message, data }),
    });
  } catch (err) {
    console.error('Notification failed:', err.message);
  }
}

async function processOrder(msg) {
  if (!msg) return;
  const order = JSON.parse(msg.content.toString());
  console.log(`Processing order ${order.orderId}...`);

  try {
    // Simulate cooking time: 3-7 seconds
    await notify(order.orderId, 'IN_KITCHEN', 'Your order is being prepared 👨‍🍳', order);
    const cookTime = 3000 + Math.random() * 4000;
    await new Promise(r => setTimeout(r, cookTime));

    await notify(order.orderId, 'READY', 'Your Iftar is ready! Come pick it up 🎉', order);
    channel.ack(msg);
    metrics.totalOrders++;
  } catch (err) {
    console.error('Order processing failed:', err.message);
    metrics.failedOrders++;
    channel.nack(msg, false, false); // dead-letter
  }
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => { metrics.totalLatency += Date.now() - start; metrics.requestCount++; });
  next();
});

// Accept order and immediately acknowledge (<2s)
app.post('/orders', async (req, res) => {
  const { orderId, studentId, items, total } = req.body;
  if (!orderId || !studentId || !items)
    return res.status(400).json({ error: 'orderId, studentId, items required' });

  if (!rabbitConnected || !channel)
    return res.status(503).json({ error: 'Kitchen queue unavailable' });

  const order = { orderId, studentId, items, total, queuedAt: new Date().toISOString() };
  channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(order)), { persistent: true });

  // Immediately respond
  res.json({ success: true, orderId, message: 'Order queued for kitchen processing', status: 'QUEUED' });
});

app.get('/health', async (req, res) => {
  if (!rabbitConnected) {
    return res.status(503).json({ status: 'degraded', service: 'kitchen-queue', dependencies: { rabbitmq: 'down' } });
  }
  res.json({ status: 'ok', service: 'kitchen-queue', dependencies: { rabbitmq: 'ok' } });
});

app.get('/metrics', (req, res) => {
  res.json({
    totalOrders: metrics.totalOrders,
    failedOrders: metrics.failedOrders,
    avgLatencyMs: metrics.requestCount ? Math.round(metrics.totalLatency / metrics.requestCount) : 0,
    requestCount: metrics.requestCount,
  });
});

const PORT = process.env.PORT || 3004;
if (require.main === module) {
  connectRabbit().then(() => {
    app.listen(PORT, () => console.log(`Kitchen Queue running on :${PORT}`));
  });
}
module.exports = app;
