const express = require('express');
const Docker = require('dockerode');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Map service names to container name patterns
const SERVICE_MAP = {
  'identity-provider': 'identity-provider',
  'order-gateway': 'order-gateway',
  'stock-service': 'stock-service',
  'kitchen-queue': 'kitchen-queue',
  'notification-hub': 'notification-hub',
};

async function findContainer(serviceName) {
  const containers = await docker.listContainers({ all: true });
  const pattern = SERVICE_MAP[serviceName];
  if (!pattern) return null;
  return containers.find(c =>
    c.Names.some(n => n.toLowerCase().includes(pattern.toLowerCase()))
  );
}

app.post('/chaos/kill/:service', async (req, res) => {
  const { service } = req.params;
  if (!SERVICE_MAP[service]) return res.status(400).json({ error: 'Unknown service' });

  try {
    const info = await findContainer(service);
    if (!info) return res.status(404).json({ error: `Container for ${service} not found` });
    if (info.State !== 'running') return res.status(409).json({ error: `${service} is already stopped` });

    const container = docker.getContainer(info.Id);
    await container.stop();
    res.json({ success: true, action: 'killed', service, containerId: info.Id.slice(0, 12) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chaos/revive/:service', async (req, res) => {
  const { service } = req.params;
  if (!SERVICE_MAP[service]) return res.status(400).json({ error: 'Unknown service' });

  try {
    const info = await findContainer(service);
    if (!info) return res.status(404).json({ error: `Container for ${service} not found` });
    if (info.State === 'running') return res.status(409).json({ error: `${service} is already running` });

    const container = docker.getContainer(info.Id);
    await container.start();
    res.json({ success: true, action: 'revived', service, containerId: info.Id.slice(0, 12) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/chaos/status', async (req, res) => {
  try {
    const statuses = {};
    for (const service of Object.keys(SERVICE_MAP)) {
      const info = await findContainer(service);
      statuses[service] = info ? info.State : 'not found';
    }
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'chaos-controller' }));

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => console.log(`Chaos Controller running on :${PORT}`));
