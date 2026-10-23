/**
 * @file tests/m2_server_api_sse.test.js
 * Comprehensive Milestone 2 Integration Test Suite:
 * - Server Boot, Dynamic Port Binding, and Health Checks
 * - Staff Authentication & HMAC Token Acquisition
 * - Unauthenticated Mutation Rejection (401 Unauthorized Invariant)
 * - Cross-Clinic Mutation Rejection (403 Forbidden Tenant Boundary Invariant)
 * - Real-Time SSE Stream Handshake, Initial Snapshot, and Sub-50ms Broadcast SLA
 * - Disconnect Cleanup and Multi-Client Channel Isolation
 *
 * Execution: node --test tests/m2_server_api_sse.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const fs = require('node:fs');
const path = require('node:path');
const {
  startServer,
  stopServer,
  apiRequest,
  getClinicToken,
  resetAllClinics,
  listenToSSE,
  DEFAULT_CLINICS
} = require('./test_helper.js');
const { FirebaseAdapter, createPersistenceAdapter } = require('../src/persistence/firebase_adapter.js');
const { AtomicFileAdapter } = require('../src/persistence/atomic_file_adapter.js');

describe('Milestone 2 Integration Test Suite: Server API & Real-Time SSE', () => {
  let baseUrl = '';
  let pediatricsToken = '';
  let cardiologyToken = '';
  let generalToken = '';
  let dentalToken = '';

  before(async () => {
    baseUrl = await startServer();
    pediatricsToken = await getClinicToken(baseUrl, 'pediatrics');
    cardiologyToken = await getClinicToken(baseUrl, 'cardiology');
    generalToken = await getClinicToken(baseUrl, 'general');
    dentalToken = await getClinicToken(baseUrl, 'dental');
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetAllClinics(baseUrl);
  });

  // =========================================================================
  // SUITE 1: Server Boot, Port Binding & Health Check
  // =========================================================================
  describe('Suite 1: Server Boot, Port Binding & Health Lifecycle', () => {
    it('1.1 should successfully respond to HTTP GET on active server URL', async () => {
      assert.ok(baseUrl.startsWith('http://'), `Invalid baseUrl: ${baseUrl}`);
      const res = await apiRequest(baseUrl, '/api/clinics');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body), 'Expected JSON array of clinics');
      assert.equal(res.body.length, 4, 'Expected all 4 default clinics');
    });

    it('1.2 should expose necessary CORS headers for zero-cost static hosting', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics');
      const cors = res.headers.get('access-control-allow-origin');
      assert.ok(cors === '*' || cors?.includes('http'), 'Expected CORS access-control-allow-origin header');
    });

    it('1.3 should respond with 404 for non-existent API routes', async () => {
      const res = await apiRequest(baseUrl, '/api/non_existent_route');
      assert.equal(res.status, 404);
    });
  });

  // =========================================================================
  // SUITE 2: Dedicated Clinic Staff Login & Token Issuance
  // =========================================================================
  describe('Suite 2: Clinic Staff Login & Token Issuance (F02)', () => {
    it('2.1 should log in valid staff and return token with clinic profile', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics', password: 'pediatrics123' }
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token, 'Token string missing');
      assert.equal(typeof res.body.token, 'string');
      assert.equal(res.body.clinic.id, 'pediatrics');
      assert.equal(res.body.clinic.name, 'Pediatrics Clinic');

      // Verify token is a valid 3-part base64url JWT
      const parts = res.body.token.split('.');
      assert.equal(parts.length, 3, 'Token must be 3-part compact JWT');
    });

    it('2.2 should authenticate all 4 pre-configured clinics with unique credentials', async () => {
      for (const clinic of DEFAULT_CLINICS) {
        const res = await apiRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { username: clinic.username, password: clinic.password }
        });
        assert.equal(res.status, 200, `Login failed for ${clinic.id}`);
        assert.equal(res.body.clinic.id, clinic.id);
      }
    });

    it('2.3 should reject login with incorrect password with 401', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics', password: 'WRONG_PASSWORD_XYZ' }
      });
      assert.equal(res.status, 401);
    });

    it('2.4 should reject login with non-existent clinic username with 401', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'oncology_unknown', password: 'some_password' }
      });
      assert.equal(res.status, 401);
    });

    it('2.5 should reject login with missing username or password with 400', async () => {
      const res1 = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics' }
      });
      assert.ok(res1.status === 400 || res1.status === 401);

      const res2 = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: {}
      });
      assert.ok(res2.status === 400 || res2.status === 401);
    });
  });

  // =========================================================================
  // SUITE 3: Unauthenticated Mutation Protection Invariant (401)
  // =========================================================================
  describe('Suite 3: Unauthenticated Mutation Rejection (401 Invariant, F03)', () => {
    const endpoints = [
      { name: 'next', path: '/api/clinics/pediatrics/next', method: 'POST' },
      { name: 'recall', path: '/api/clinics/pediatrics/recall', method: 'POST' },
      { name: 'skip', path: '/api/clinics/pediatrics/skip', method: 'POST' },
      { name: 'reset', path: '/api/clinics/pediatrics/reset', method: 'POST' },
      { name: 'status', path: '/api/clinics/pediatrics/status', method: 'POST', body: { status: 'Brief Break' } },
      { name: 'chime', path: '/api/clinics/pediatrics/chime', method: 'POST' }
    ];

    for (const ep of endpoints) {
      it(`3.1 should reject unauthenticated POST ${ep.name} with 401`, async () => {
        const res = await apiRequest(baseUrl, ep.path, {
          method: ep.method,
          body: ep.body || {}
        });
        assert.equal(res.status, 401, `Expected 401 for unauthenticated ${ep.name}`);
      });

      it(`3.2 should reject POST ${ep.name} with invalid/malformed token with 401`, async () => {
        const res = await apiRequest(baseUrl, ep.path, {
          method: ep.method,
          headers: { Authorization: 'Bearer totally.invalid.tampered.token' },
          body: ep.body || {}
        });
        assert.equal(res.status, 401);
      });
    }

    it('3.3 should verify queue state remains unmodified after rejected unauthenticated mutations', async () => {
      // Attempt unauthenticated advance
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', { method: 'POST' });

      // State check
      const stateRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(stateRes.status, 200);
      assert.equal(stateRes.body.currentServing, 0, 'Queue counter must remain 0');
    });
  });

  // =========================================================================
  // SUITE 4: Cross-Clinic Mutation Rejection (403 Forbidden Tenant Boundary)
  // =========================================================================
  describe('Suite 4: Cross-Clinic Mutation Rejection (403 Tenant Isolation, F04)', () => {
    it('4.1 should reject Pediatrics token attempting to advance Cardiology with 403', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403, 'Cross-clinic mutation must return 403 Forbidden');
    });

    it('4.2 should reject Pediatrics token attempting to recall General Medicine with 403', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/general/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('4.3 should reject Pediatrics token attempting to skip Dental clinic patient with 403', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/dental/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('4.4 should reject Pediatrics token attempting to reset Cardiology queue with 403', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/cardiology/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('4.5 should reject Cardiology token attempting to advance Pediatrics queue with 403', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('4.6 should ensure cross-clinic attack attempts do not alter target queue state', async () => {
      await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      const cardState = await apiRequest(baseUrl, '/api/clinics/cardiology/state');
      assert.equal(cardState.body.currentServing, 0, 'Cardiology state must remain untampered');
    });
  });

  // =========================================================================
  // SUITE 5: Real-Time SSE Stream, Handshake & Sub-50ms Broadcast SLA (F08)
  // =========================================================================
  describe('Suite 5: Real-Time SSE Stream & Latency SLA (F08)', () => {
    it('5.1 should return correct SSE response headers on /events connection', async () => {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' }
      });

      assert.equal(res.status, 200);
      const contentType = res.headers.get('content-type') || '';
      assert.ok(contentType.includes('text/event-stream'), `Unexpected content-type: ${contentType}`);
      const cacheControl = res.headers.get('cache-control') || '';
      assert.ok(cacheControl.includes('no-cache'), `Unexpected cache-control: ${cacheControl}`);

      controller.abort();
    });

    it('5.2 should immediately push initial snapshot event on connection', async () => {
      const sse = listenToSSE(baseUrl, 'pediatrics', null, 3000);
      const events = await sse.waitForCount(1, 10, 2000);
      sse.close();

      assert.ok(events.length >= 1, 'Expected at least 1 initial event');
      assert.equal(events[0].type, 'QUEUE_UPDATE');
      assert.equal(events[0].clinicId, 'pediatrics');
      assert.equal(events[0].currentServing, 0);
      assert.equal(events[0].status, 'In Clinic');
      assert.deepEqual(events[0].skipped, []);
    });

    it('5.3 should broadcast live mutation to SSE subscribers in sub-50ms SLA', async () => {
      let mutationArrivedAt = 0;
      const sse = listenToSSE(baseUrl, 'pediatrics', (ev) => {
        if (ev.currentServing === 1 && !mutationArrivedAt) {
          mutationArrivedAt = performance.now();
        }
      }, 4000);

      await sse.waitForCount(1, 10, 2000); // Wait for initial snapshot

      const initialCount = sse.events.length;
      const startTime = performance.now();

      // Trigger mutation via REST
      const mutRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(mutRes.status, 200);

      // Wait for broadcast
      await sse.waitForCount(initialCount + 1, 5, 2000);
      const latencyMs = mutationArrivedAt ? (mutationArrivedAt - startTime) : (performance.now() - startTime);
      sse.close();

      assert.ok(sse.events.length > initialCount, 'Broadcast event not received');
      const latestEvent = sse.events[sse.events.length - 1];
      assert.equal(latestEvent.type, 'QUEUE_UPDATE');
      assert.equal(latestEvent.currentServing, 1);

      // Latency Assertion: Sub-50ms requirement
      assert.ok(
        latencyMs < 50,
        `SSE push latency was ${latencyMs.toFixed(2)}ms, exceeding 50ms SLA requirement`
      );
    });

    it('5.4 should push events for recall, skip, reset, and doctor status mutations', async () => {
      const sse = listenToSSE(baseUrl, 'pediatrics', null, 5000);
      await sse.waitForCount(1, 10, 2000);

      // Next
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      // Skip
      await apiRequest(baseUrl, '/api/clinics/pediatrics/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      // Status
      await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Brief Break' }
      });

      await sse.waitForCount(4, 10, 3000);
      sse.close();

      assert.ok(sse.events.length >= 4, `Expected at least 4 events, got ${sse.events.length}`);
      const latest = sse.events[sse.events.length - 1];
      assert.equal(latest.status, 'Brief Break');
    });
  });

  // =========================================================================
  // SUITE 6: Disconnect Cleanup & Multi-Client Channel Isolation
  // =========================================================================
  describe('Suite 6: Disconnect Cleanup & Channel Isolation (F04, F08)', () => {
    it('6.1 should enforce complete channel isolation between different clinic SSE streams', async () => {
      const pediatricsSSE = listenToSSE(baseUrl, 'pediatrics', null, 4000);
      const cardiologySSE = listenToSSE(baseUrl, 'cardiology', null, 4000);

      await pediatricsSSE.waitForCount(1, 10, 2000);
      await cardiologySSE.waitForCount(1, 10, 2000);

      const pInitial = pediatricsSSE.events.length;
      const cInitial = cardiologySSE.events.length;

      // Mutate Pediatrics ONLY
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      await pediatricsSSE.waitForCount(pInitial + 1, 10, 2000);
      await new Promise(r => setTimeout(r, 100)); // Allow any potential leak to travel

      pediatricsSSE.close();
      cardiologySSE.close();

      assert.equal(pediatricsSSE.events.length, pInitial + 1, 'Pediatrics subscriber must receive update');
      assert.equal(cardiologySSE.events.length, cInitial, 'Cardiology subscriber must NOT receive Pediatrics update');
    });

    it('6.2 should deliver broadcast simultaneously to multiple subscribers on the same clinic', async () => {
      const client1 = listenToSSE(baseUrl, 'pediatrics', null, 4000);
      const client2 = listenToSSE(baseUrl, 'pediatrics', null, 4000);

      await client1.waitForCount(1, 10, 2000);
      await client2.waitForCount(1, 10, 2000);

      const c1Count = client1.events.length;
      const c2Count = client2.events.length;

      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      await client1.waitForCount(c1Count + 1, 10, 2000);
      await client2.waitForCount(c2Count + 1, 10, 2000);

      client1.close();
      client2.close();

      assert.equal(client1.events.length, c1Count + 1);
      assert.equal(client2.events.length, c2Count + 1);
    });

    it('6.3 should gracefully clean up socket on client abort without unhandled errors', async () => {
      // Connect and instantly abort 5 times in rapid succession
      for (let i = 0; i < 5; i++) {
        const controller = new AbortController();
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/events`, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' }
        });
        assert.equal(res.status, 200);
        controller.abort();
      }

      // Mutating queue state after abrupt client closures must succeed without crash
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.currentServing >= 1);
    });
  });

  // =========================================================================
  // SUITE 7: FirebaseAdapter & Persistence Factory (F10)
  // =========================================================================
  describe('Suite 7: FirebaseAdapter & Cloud Persistence Architecture (F10)', () => {
    it('7.1 should instantiate AtomicFileAdapter by default in local mode', () => {
      const adapter = createPersistenceAdapter({ mode: 'local' });
      assert.ok(adapter instanceof AtomicFileAdapter);
    });

    it('7.2 should instantiate FirebaseAdapter when mode is firebase', () => {
      const adapter = createPersistenceAdapter({
        mode: 'firebase',
        databaseUrl: 'https://test-clinic-default-rtdb.firebaseio.com'
      });
      assert.ok(adapter instanceof FirebaseAdapter);
      assert.equal(adapter.databaseUrl, 'https://test-clinic-default-rtdb.firebaseio.com');
    });

    it('7.3 should construct correct Firebase REST URLs with auth parameter', () => {
      const adapter = new FirebaseAdapter({
        databaseUrl: 'https://test-clinic.firebaseio.com/',
        authSecret: 'secret_token_123',
        nodePath: '/clinics_root/'
      });
      const url = adapter._buildUrl('pediatrics');
      assert.equal(url, 'https://test-clinic.firebaseio.com/clinics_root/pediatrics.json?auth=secret_token_123');
    });

    it('7.4 should heal Firebase RTDB dropped empty arrays and sparse objects in normalization', () => {
      const adapter = new FirebaseAdapter();
      const rawFirebaseData = {
        version: 1,
        clinics: {
          pediatrics: {
            clinicId: 'pediatrics',
            name: 'Pediatrics Clinic',
            currentServing: 12,
            status: 'In Clinic'
            // skipped omitted by Firebase
          },
          cardiology: {
            clinicId: 'cardiology',
            name: 'Cardiology Clinic',
            currentServing: 5,
            status: 'Brief Break',
            // sparse array converted to object by Firebase
            skipped: { '0': 2, '1': 4 }
          }
        }
      };

      const normalized = adapter._normalizeFirebaseState(rawFirebaseData);
      assert.deepEqual(normalized.clinics.pediatrics.skipped, []);
      assert.deepEqual(normalized.clinics.cardiology.skipped, [2, 4]);
      assert.equal(normalized.clinics.cardiology.status, 'Brief Break');
    });

    it('7.5 should transparently fall back to AtomicFileAdapter on local disk when offline', async () => {
      const tempPath = path.resolve(__dirname, `../data/temp_fb_fallback_${Date.now()}.json`);
      const fallbackAdapter = new AtomicFileAdapter(tempPath);
      const adapter = new FirebaseAdapter({
        fallbackAdapter,
        enableFallback: true
      });

      const sampleState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        clinics: {
          dental: {
            clinicId: 'dental',
            name: 'Dental Clinic',
            currentServing: 7,
            status: 'In Clinic',
            skipped: [3]
          }
        }
      };

      await adapter.saveState(sampleState);
      const loaded = await adapter.loadState();

      assert.equal(loaded.clinics.dental.currentServing, 7);
      assert.deepEqual(loaded.clinics.dental.skipped, [3]);

      try {
        fs.unlinkSync(tempPath);
      } catch {}
    });
  });
});

