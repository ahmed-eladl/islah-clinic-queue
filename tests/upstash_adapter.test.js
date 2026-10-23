/**
 * @file tests/upstash_adapter.test.js
 * Unit test for UpstashRedisAdapter and StorageFactory
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { UpstashRedisAdapter } = require('../src/persistence/upstash_adapter.js');
const { createPersistenceAdapter } = require('../src/persistence/storage_factory.js');

describe('Upstash Redis Adapter & Storage Factory', () => {
  it('should detect unconfigured state when URL or token is missing', () => {
    const adapter = new UpstashRedisAdapter({ url: '', token: '' });
    assert.equal(adapter.isConfigured(), false);
  });

  it('should detect configured state when URL and token are provided', () => {
    const adapter = new UpstashRedisAdapter({ url: 'https://test.upstash.io', token: 'mock-token' });
    assert.equal(adapter.isConfigured(), true);
  });

  it('should respect cache TTL to minimize remote requests', async () => {
    const adapter = new UpstashRedisAdapter({ url: 'https://test.upstash.io', token: 'mock-token', cacheTtlMs: 2000 });
    const fakeData = { clinics: { pediatrics: { currentServing: 5 } } };
    
    // Simulate cached data from saveState
    adapter.cachedData = fakeData;
    adapter.lastFetchTime = Date.now();

    // Call loadState without force
    const loaded = await adapter.loadState(false);
    assert.deepEqual(loaded, fakeData);
  });

  it('should fallback to AtomicFileAdapter when no cloud persistence env vars are set', () => {
    const adapter = createPersistenceAdapter({ dataFile: './data/clinic_queues.json' });
    assert.ok(adapter);
    assert.equal(typeof adapter.loadState, 'function');
    assert.equal(typeof adapter.saveState, 'function');
  });
});
