const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// In-memory student DB (demo)
const students = {
  'STU001': { password: 'iftar2024', name: 'Ahmed Hassan', studentId: 'STU001' },
  'STU002': { password: 'iftar2024', name: 'Fatima Rahman', studentId: 'STU002' },
  'STU003': { password: 'iftar2024', name: 'Omar Siddiqui', studentId: 'STU003' },
  'admin':  { password: 'admin2024', name: 'Admin User', studentId: 'admin', role: 'admin' },
};

// Metrics
const metrics = { totalLogins: 0, failedLogins: 0, totalLatency: 0, requestCount: 0 };

// BONUS: Rate limiter — 3 attempts/minute per IP+studentId
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${req.ip}-${req.body?.studentId || 'unknown'}`,
  message: { error: 'Too many login attempts. Try again in 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    metrics.totalLatency += Date.now() - start;
    metrics.requestCount++;
  });
  next();
});

app.post('/auth/login', loginLimiter, (req, res) => {
  const { studentId, password } = req.body;
  if (!studentId || !password)
    return res.status(400).json({ error: 'studentId and password required' });

  const student = students[studentId];
  if (!student || student.password !== password) {
    metrics.failedLogins++;
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  metrics.totalLogins++;
  const token = jwt.sign(
    { studentId: student.studentId, name: student.name, role: student.role || 'student' },
    JWT_SECRET,
    { expiresIn: '2h' }
  );

  res.json({ token, student: { studentId: student.studentId, name: student.name, role: student.role || 'student' } });
});

app.post('/auth/verify', (req, res) => {
  const { token } = req.body;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, payload });
  } catch {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'identity-provider', timestamp: new Date().toISOString() });
});

app.get('/metrics', (req, res) => {
  res.json({
    totalLogins: metrics.totalLogins,
    failedLogins: metrics.failedLogins,
    avgLatencyMs: metrics.requestCount ? Math.round(metrics.totalLatency / metrics.requestCount) : 0,
    requestCount: metrics.requestCount,
  });
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Identity Provider running on :${PORT}`));
}
module.exports = app;
