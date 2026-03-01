const request = require('supertest');
const app = require('./index');

describe('Identity Provider', () => {
  test('POST /auth/login - valid credentials returns token', async () => {
    const res = await request(app).post('/auth/login').send({ studentId: 'STU001', password: 'iftar2024' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('POST /auth/login - invalid credentials returns 401', async () => {
    const res = await request(app).post('/auth/login').send({ studentId: 'STU001', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('POST /auth/login - missing fields returns 400', async () => {
    const res = await request(app).post('/auth/login').send({ studentId: 'STU001' });
    expect(res.status).toBe(400);
  });

  test('POST /auth/verify - valid token', async () => {
    const loginRes = await request(app).post('/auth/login').send({ studentId: 'STU001', password: 'iftar2024' });
    const token = loginRes.body.token;
    const res = await request(app).post('/auth/verify').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
