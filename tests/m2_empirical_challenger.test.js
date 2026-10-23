/**
 * @file tests/m2_empirical_challenger.test.js
 * Adversarial Empirical Verification Suite for Milestone 2:
 * 1. High-Frequency Push Latency SLA Benchmark (<50ms under rapid mutations)
 * 2. Multi-Tenant Channel Isolation (zero cross-talk across 4 clinics)
 * 3. Connection Churn & Resource Cleanliness (rapid connect/snapshot/disconnect cycles)
 * 4. Unregistered & Invalid Clinic Rejection (immediate 404, no hanging streams)
 * 5. High-Concurrency Interleaved Multi-Clinic Mutations
 *
 * Execution: node --test tests/m2_empirical_challenger.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  startServer,
  stopServer,
  apiRequest,
  getClinicToken,
  resetAllClinics,
  DEFAULT_CLINICS
} = require('./test_helper.js');

/**
 * High-precision SSE Client for empirical latency benchmarking and event auditing
 */
function createPrecisionSSEClient(baseUrl, clinicId, options = {}) {
  const controller = new AbortController();
  const events = [];
  const rawComments = [];
  let snapshotResolve;
  const snapshotPromise = new Promise(resolve => { snapshotResolve = resolve; });

  const eventListeners = new Set();

  const promise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/clinics/${clinicId}/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' }
      });

      if (res.status !== 200) {
        return { status: res.status, error: 'Non-200 status' };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const now = performance.now();
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          if (!block.trim()) continue;

          // Check for SSE comments (: connected, : heartbeat)
          if (block.startsWith(':')) {
            rawComments.push({ comment: block.trim(), receivedAt: now });
            continue;
          }

          const match = block.match(/data:\s*(.+)/s);
          if (match) {
            try {
              const data = JSON.parse(match[1]);
              const eventRecord = { data, receivedAt: now };
              events.push(eventRecord);

              if (data.action === 'QUEUE_SNAPSHOT' || data.type === 'QUEUE_SNAPSHOT') {
                snapshotResolve(eventRecord);
              }

              for (const listener of eventListeners) {
                listener(eventRecord);
              }
            } catch (err) {
              // ignore JSON parse error in malformed blocks
            }
          }
        }
      }
    } catch (e) {
      // Abort is expected when disconnecting
    }
  })();

  return {
    events,
    rawComments,
    waitForSnapshot: (timeoutMs = 5000) => {
      return Promise.race([
        snapshotPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Snapshot timeout')), timeoutMs))
      ]);
    },
    waitForNextEvent: (predicate, timeoutMs = 5000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for matching event after ${timeoutMs}ms`));
        }, timeoutMs);

        const listener = (eventRecord) => {
          if (!predicate || predicate(eventRecord.data)) {
            cleanup();
            resolve(eventRecord);
          }
        };

        const cleanup = () => {
          clearTimeout(timer);
          eventListeners.delete(listener);
        };

        eventListeners.add(listener);
      });
    },
    waitForCount: async (targetCount, timeoutMs = 8000) => {
      const start = Date.now();
      while (events.length < targetCount && (Date.now() - start) < timeoutMs) {
        await new Promise(r => setTimeout(r, 20));
      }
      return events;
    },
    close: () => {
      controller.abort();
    },
    isClosed: () => controller.signal.aborted,
    done: promise
  };
}

describe('Milestone 2 Empirical Challenger Adversarial Verification', () => {
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
  // CHALLENGE 1: Push Latency Benchmark across Multiple Rapid Mutations (<50ms SLA)
  // =========================================================================
  describe('Challenge 1: High-Frequency Mutation Push Latency SLA Benchmark', () => {
    it('should empirically verify sub-50ms push latency across 20 rapid back-to-back mutations', async () => {
      const client = createPrecisionSSEClient(baseUrl, 'pediatrics');
      await client.waitForSnapshot();

      const latencies = [];
      const mutationTypes = [
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/skip', body: null, expectedAction: 'SKIP' },
        { path: '/status', body: { status: 'Brief Break' }, expectedAction: 'SET_STATUS' },
        { path: '/status', body: { status: 'In Clinic' }, expectedAction: 'SET_STATUS' },
        { path: '/recall', body: null, expectedAction: 'RECALL' },
        { path: '/chime', body: null, expectedAction: 'CHIME' },
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/skip', body: null, expectedAction: 'SKIP' },
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/recall', body: null, expectedAction: 'RECALL' },
        { path: '/status', body: { status: 'Finished' }, expectedAction: 'SET_STATUS' },
        { path: '/status', body: { status: 'In Clinic' }, expectedAction: 'SET_STATUS' },
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/chime', body: null, expectedAction: 'CHIME' },
        { path: '/next', body: null, expectedAction: 'NEXT' },
        { path: '/skip', body: null, expectedAction: 'SKIP' },
        { path: '/recall', body: null, expectedAction: 'RECALL' },
        { path: '/reset', body: null, expectedAction: 'RESET' }
      ];

      for (let i = 0; i < mutationTypes.length; i++) {
        const mutation = mutationTypes[i];
        const reqStart = performance.now();

        // Setup event listener before triggering mutation
        const eventPromise = client.waitForNextEvent(data => {
          return data.clinicId === 'pediatrics' && data.action === mutation.expectedAction;
        }, 3000);

        // Execute mutation
        const res = await apiRequest(baseUrl, `/api/clinics/pediatrics${mutation.path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` },
          body: mutation.body
        });
        assert.equal(res.status, 200, `Mutation ${i} (${mutation.path}) failed with status ${res.status}`);

        // Await event arrival over SSE stream
        const eventRecord = await eventPromise;
        const pushLatency = eventRecord.receivedAt - reqStart;
        latencies.push(pushLatency);

        assert.ok(
          pushLatency < 50,
          `Latency violation on mutation ${i} (${mutation.path}): ${pushLatency.toFixed(2)}ms exceeded 50ms SLA`
        );
      }

      client.close();

      // Compute statistics
      latencies.sort((a, b) => a - b);
      const min = latencies[0];
      const max = latencies[latencies.length - 1];
      const sum = latencies.reduce((acc, val) => acc + val, 0);
      const mean = sum / latencies.length;
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];

      console.log(`[Challenger SLA Benchmark] 20 Mutations -> Min: ${min.toFixed(2)}ms | Mean: ${mean.toFixed(2)}ms | p50: ${p50.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | Max: ${max.toFixed(2)}ms`);

      assert.ok(max < 50, `Max latency (${max.toFixed(2)}ms) must be strictly less than 50ms`);
      assert.ok(mean < 30, `Mean latency (${mean.toFixed(2)}ms) must be well below 30ms`);
      assert.equal(latencies.length, 20, 'All 20 mutations must be recorded');
    });
  });

  // =========================================================================
  // CHALLENGE 2: Multi-Tenant Channel Isolation
  // =========================================================================
  describe('Challenge 2: Multi-Tenant Channel Isolation Stress Test', () => {
    it('should guarantee zero event leakage from Pediatrics mutations to Cardiology, General, or Dental streams', async () => {
      // 1. Establish 4 concurrent SSE clients, one per clinic
      const pedsClient = createPrecisionSSEClient(baseUrl, 'pediatrics');
      const cardioClient = createPrecisionSSEClient(baseUrl, 'cardiology');
      const genClient = createPrecisionSSEClient(baseUrl, 'general');
      const dentalClient = createPrecisionSSEClient(baseUrl, 'dental');

      // Await initial snapshot on all 4
      await Promise.all([
        pedsClient.waitForSnapshot(),
        cardioClient.waitForSnapshot(),
        genClient.waitForSnapshot(),
        dentalClient.waitForSnapshot()
      ]);

      // Verify each snapshot belongs strictly to its clinic
      assert.equal(pedsClient.events[0].data.clinicId, 'pediatrics');
      assert.equal(cardioClient.events[0].data.clinicId, 'cardiology');
      assert.equal(genClient.events[0].data.clinicId, 'general');
      assert.equal(dentalClient.events[0].data.clinicId, 'dental');

      // Snapshot counts before mutations
      assert.equal(pedsClient.events.length, 1);
      assert.equal(cardioClient.events.length, 1);
      assert.equal(genClient.events.length, 1);
      assert.equal(dentalClient.events.length, 1);

      // 2. Blast 30 rapid mutations to Pediatrics
      const pedsMutations = 30;
      for (let i = 0; i < pedsMutations; i++) {
        const action = i % 3 === 0 ? '/next' : (i % 3 === 1 ? '/chime' : '/status');
        const body = action === '/status' ? { status: (i % 2 === 0 ? 'Brief Break' : 'In Clinic') } : null;

        const res = await apiRequest(baseUrl, `/api/clinics/pediatrics${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` },
          body
        });
        assert.equal(res.status, 200);
      }

      // 3. Simultaneously send 15 mutations to Cardiology
      const cardioMutations = 15;
      for (let i = 0; i < cardioMutations; i++) {
        const res = await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cardiologyToken}` }
        });
        assert.equal(res.status, 200);
      }

      // Wait for all expected events to propagate
      await pedsClient.waitForCount(1 + pedsMutations, 5000);
      await cardioClient.waitForCount(1 + cardioMutations, 5000);

      // Wait a short settle window to catch any rogue leakage
      await new Promise(r => setTimeout(r, 200));

      // 4. Assert strict isolation
      // Pediatrics: exactly 1 snapshot + 30 mutations = 31 events, all pediatrics
      assert.equal(pedsClient.events.length, 1 + pedsMutations, 'Pediatrics received unexpected event count');
      for (const ev of pedsClient.events) {
        assert.equal(ev.data.clinicId, 'pediatrics', `Pediatrics stream received foreign event for ${ev.data.clinicId}`);
      }

      // Cardiology: exactly 1 snapshot + 15 mutations = 16 events, all cardiology
      assert.equal(cardioClient.events.length, 1 + cardioMutations, 'Cardiology received unexpected event count');
      for (const ev of cardioClient.events) {
        assert.equal(ev.data.clinicId, 'cardiology', `Cardiology stream received foreign event for ${ev.data.clinicId}`);
      }

      // General Medicine: exactly 1 event (initial snapshot), ZERO mutations received
      assert.equal(
        genClient.events.length,
        1,
        `General stream suffered tenant contamination! Received ${genClient.events.length} events instead of 1 snapshot`
      );
      assert.equal(genClient.events[0].data.clinicId, 'general');

      // Dental: exactly 1 event (initial snapshot), ZERO mutations received
      assert.equal(
        dentalClient.events.length,
        1,
        `Dental stream suffered tenant contamination! Received ${dentalClient.events.length} events instead of 1 snapshot`
      );
      assert.equal(dentalClient.events[0].data.clinicId, 'dental');

      pedsClient.close();
      cardioClient.close();
      genClient.close();
      dentalClient.close();
    });
  });

  // =========================================================================
  // CHALLENGE 3: Connection Churn & Socket/Timer Leak Stress Test
  // =========================================================================
  describe('Challenge 3: Connection Churn & Resource Cleanliness', () => {
    it('should handle 30 rapid concurrent connect/snapshot/disconnect cycles with zero socket or timer leaks', async () => {
      const concurrency = 30;
      const churnClients = [];

      // Phase A: Open 30 concurrent SSE connections to Pediatrics
      const openPromises = [];
      for (let i = 0; i < concurrency; i++) {
        const client = createPrecisionSSEClient(baseUrl, 'pediatrics');
        churnClients.push(client);
        openPromises.push(client.waitForSnapshot(4000));
      }

      // Await snapshot arrival on all 30 clients
      const snapshots = await Promise.all(openPromises);
      assert.equal(snapshots.length, concurrency, `Expected ${concurrency} snapshots`);

      // Verify all 30 clients received valid snapshot
      for (const s of snapshots) {
        assert.equal(s.data.clinicId, 'pediatrics');
        assert.equal(s.data.action, 'QUEUE_SNAPSHOT');
      }

      // Phase B: Rapidly abort/disconnect all 30 clients
      for (const client of churnClients) {
        client.close();
      }

      // Allow node event loop to process TCP close events and trigger server-side cleanups
      await new Promise(r => setTimeout(r, 200));

      // Phase C: Repeat another wave of 20 rapid churn connections to General Medicine
      const wave2Clients = [];
      const wave2Promises = [];
      for (let i = 0; i < 20; i++) {
        const client = createPrecisionSSEClient(baseUrl, 'general');
        wave2Clients.push(client);
        wave2Promises.push(client.waitForSnapshot(4000));
      }
      await Promise.all(wave2Promises);
      for (const client of wave2Clients) {
        client.close();
      }
      await new Promise(r => setTimeout(r, 200));

      // Phase D: Verification Probe - Server must remain 100% responsive and healthy
      const probeClient = createPrecisionSSEClient(baseUrl, 'pediatrics');
      await probeClient.waitForSnapshot();

      const probeReqStart = performance.now();
      const probeEventPromise = probeClient.waitForNextEvent(data => data.action === 'NEXT', 2000);

      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);

      const probeEvent = await probeEventPromise;
      const probeLatency = probeEvent.receivedAt - probeReqStart;

      console.log(`[Challenger Post-Churn Probe] Push latency after 50 churned connections: ${probeLatency.toFixed(2)}ms`);
      assert.ok(probeLatency < 50, `Post-churn probe latency (${probeLatency.toFixed(2)}ms) exceeded 50ms SLA`);
      assert.equal(probeEvent.data.currentServing, 1);

      probeClient.close();
    });
  });

  // =========================================================================
  // CHALLENGE 4: Unregistered & Invalid Clinic Stream Rejection
  // =========================================================================
  describe('Challenge 4: Unregistered & Malformed Clinic Stream Rejection', () => {
    it('should immediately reject nonexistent clinic with 404 JSON without establishing an SSE stream', async () => {
      const nonexistentClinics = [
        'nonexistent',
        'unknown_clinic_999',
        'pediatrics_fake',
        'cardio_hacked'
      ];

      for (const clinicId of nonexistentClinics) {
        const reqStart = performance.now();
        const res = await fetch(`${baseUrl}/api/clinics/${clinicId}/events`, {
          headers: { Accept: 'text/event-stream' }
        });
        const elapsed = performance.now() - reqStart;

        assert.equal(res.status, 404, `Expected 404 for nonexistent clinic '${clinicId}', got ${res.status}`);
        
        const contentType = res.headers.get('content-type') || '';
        assert.ok(
          contentType.includes('application/json'),
          `Expected application/json header, got '${contentType}'`
        );
        assert.ok(
          !contentType.includes('text/event-stream'),
          `404 must NOT return text/event-stream content type`
        );

        const body = await res.json();
        assert.ok(body.error, 'Response body must contain error property');
        assert.ok(body.error.includes(clinicId) || body.error.toLowerCase().includes('not found'));

        // Verify rejection is immediate and does not hang
        assert.ok(elapsed < 100, `Rejection took ${elapsed.toFixed(2)}ms; must be immediate (<100ms)`);
      }
    });

    it('should reject malformed or blank clinic IDs with 404 Not Found without hanging', async () => {
      const invalidPaths = [
        '/api/clinics/%20/events', // space
        '/api/clinics/null/events',
        '/api/clinics/undefined/events'
      ];

      for (const path of invalidPaths) {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { Accept: 'text/event-stream' }
        });
        assert.equal(res.status, 404, `Expected 404 for invalid path '${path}', got ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        assert.ok(!contentType.includes('text/event-stream'));
      }
    });
  });

  // =========================================================================
  // CHALLENGE 5: High-Concurrency Interleaved Multi-Clinic Mutations
  // =========================================================================
  describe('Challenge 5: High-Concurrency Interleaved Multi-Clinic Mutations', () => {
    it('should concurrently process interleaved mutations across all 4 clinics without race conditions or deadlocks', async () => {
      const clients = {
        pediatrics: createPrecisionSSEClient(baseUrl, 'pediatrics'),
        cardiology: createPrecisionSSEClient(baseUrl, 'cardiology'),
        general: createPrecisionSSEClient(baseUrl, 'general'),
        dental: createPrecisionSSEClient(baseUrl, 'dental')
      };

      await Promise.all(Object.values(clients).map(c => c.waitForSnapshot()));

      const tokens = {
        pediatrics: pediatricsToken,
        cardiology: cardiologyToken,
        general: generalToken,
        dental: dentalToken
      };

      const clinicIds = ['pediatrics', 'cardiology', 'general', 'dental'];
      const mutationsPerClinic = 12; // 4 * 12 = 48 concurrent requests

      // Launch 4 parallel concurrent workers dispatching mutations
      const workers = clinicIds.map(async (clinicId) => {
        for (let i = 0; i < mutationsPerClinic; i++) {
          const action = i % 2 === 0 ? '/next' : '/chime';
          const res = await apiRequest(baseUrl, `/api/clinics/${clinicId}${action}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokens[clinicId]}` }
          });
          assert.equal(res.status, 200);
        }
      });

      await Promise.all(workers);

      // Verify each clinic received its 1 snapshot + 12 mutation events
      for (const clinicId of clinicIds) {
        const client = clients[clinicId];
        await client.waitForCount(1 + mutationsPerClinic, 6000);
        assert.equal(client.events.length, 1 + mutationsPerClinic, `Clinic ${clinicId} missing events`);

        // Verify all events are strictly for this clinic
        for (const ev of client.events) {
          assert.equal(ev.data.clinicId, clinicId);
        }
        client.close();
      }
    });
  });

  // =========================================================================
  // CHALLENGE 6: High-Concurrency Burst Race Condition Resistance
  // =========================================================================
  describe('Challenge 6: High-Concurrency Burst Race Condition Resistance', () => {
    it('should cleanly serialize 25 simultaneous concurrent next requests with zero lost updates and monotonically increasing serving numbers', async () => {
      const client = createPrecisionSSEClient(baseUrl, 'pediatrics');
      await client.waitForSnapshot();

      const burstCount = 25;
      const burstPromises = [];

      for (let i = 0; i < burstCount; i++) {
        burstPromises.push(
          apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
            method: 'POST',
            headers: { Authorization: `Bearer ${pediatricsToken}` }
          })
        );
      }

      // Fire all 25 simultaneously
      const responses = await Promise.all(burstPromises);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      // Await all 25 events on SSE stream (+1 initial snapshot)
      await client.waitForCount(1 + burstCount, 6000);
      assert.equal(client.events.length, 1 + burstCount, 'SSE stream missing burst events');

      // Verify final REST state matches exactly 25
      const stateRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(stateRes.status, 200);
      assert.equal(stateRes.body.currentServing, burstCount, `Expected currentServing to be ${burstCount}, got ${stateRes.body.currentServing}`);

      // Verify event stream monotonically increases: 1, 2, 3, ..., 25
      const servingNumbers = client.events.slice(1).map(e => e.data.currentServing);
      assert.equal(servingNumbers.length, burstCount);
      for (let i = 0; i < burstCount; i++) {
        assert.equal(servingNumbers[i], i + 1, `Discrepancy at index ${i}: expected serving number ${i + 1}, got ${servingNumbers[i]}`);
      }

      client.close();
    });
  });
});

