/**
 * @file tests/vercel_api_smoke.test.js
 * Verify api/index.js works as a serverless handler
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/index.js');
const { EventEmitter } = require('node:events');

describe('Vercel API Handler Smoke Test', () => {
  it('should respond to GET /api/clinics with status 200 and list of clinics', async () => {
    // Mock req
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/api/clinics';
    req.headers = { host: 'localhost' };

    // Mock res
    let statusCode = null;
    let headers = {};
    let responseBody = '';

    const res = new EventEmitter();
    res.setHeader = (k, v) => { headers[k] = v; };
    res.getHeader = (k) => headers[k];
    res.status = (code) => { statusCode = code; return res; };
    res.writeHead = (code, h) => { statusCode = code; if (h) Object.assign(headers, h); return res; };
    res.end = (chunk) => {
      if (chunk) responseBody += chunk;
      res.emit('finish');
    };
    res.write = (chunk) => {
      if (chunk) responseBody += chunk;
      return true;
    };

    const completionPromise = new Promise(resolve => res.on('finish', resolve));
    await handler(req, res);
    await completionPromise;

    assert.equal(statusCode, 200);
    const parsed = JSON.parse(responseBody);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 4);
    assert.ok(parsed.find(c => c.id === 'pediatrics'));
  });
});
