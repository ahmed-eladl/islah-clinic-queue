/**
 * @file tests/vercel_api_smoke.test.js
 * Verify api/index.js works as a serverless handler for routes
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../api/index.js');
const http = require('node:http');

describe('Vercel API Handler Smoke Test', () => {
  let server;
  let baseUrl;

  it('should start an ephemeral HTTP server wrapping the exported app', async () => {
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
    assert.ok(baseUrl);
  });

  it('should respond to GET /api/clinics with list of clinics', async () => {
    const res = await fetch(`${baseUrl}/api/clinics`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 4);
  });

  it('should respond to GET /api/clinics/pediatrics/state with status 200', async () => {
    const res = await fetch(`${baseUrl}/api/clinics/pediatrics/state`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, 'pediatrics');
    assert.equal(typeof data.currentServing, 'number');
  });

  it('should authenticate staff at POST /api/auth/login and return token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pediatrics', password: 'pediatrics123' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.token);
    assert.equal(data.clinic.id, 'pediatrics');
  });

  it('should clean up server', async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
