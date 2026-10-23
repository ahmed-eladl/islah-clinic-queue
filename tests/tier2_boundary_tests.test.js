// tests/tier2_boundary_tests.test.js
// Tier 2: Boundary & Edge Case Suite
// Derived from ORIGINAL_REQUEST.md, PROJECT.md, and TEST_INFRA.md

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer,
  stopServer,
  apiRequest,
  getClinicToken,
  resetClinicQueue,
  resetAllClinics,
  listenToSSE,
  calculatePatientsAhead,
  calculateWaitTime,
  formatWaitTime
} = require('./test_helper');

describe('Tier 2: Boundary & Edge Cases Suite', () => {
  let baseUrl = '';
  let pediatricsToken = '';

  before(async () => {
    baseUrl = await startServer();
    pediatricsToken = await getClinicToken(baseUrl, 'pediatrics');
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetAllClinics(baseUrl);
  });

  // =========================================================================
  // B1: Queue Floor & Minimum Clamp
  // =========================================================================
  describe('Boundary B1: Queue Floor at 0 (Clamping & Undo)', () => {
    it('B1-1: Single recall on initial queue (0) clamps at 0', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.currentServing, 0);
    });

    it('B1-2: 10 consecutive recalls on empty queue remain clamped at 0', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        });
        assert.equal(res.body.currentServing, 0, `Failed on iteration ${i + 1}`);
      }
      const state = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(state.body.currentServing, 0);
    });

    it('B1-3: Advance to 1 then double recall clamps at 0 without negative numbers', async () => {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.body.currentServing, 0);
    });

    it('B1-4: Skip on empty queue (0) increments to 1 without crashing', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.currentServing, 1);
    });
  });

  // =========================================================================
  // B2: Negative Numbers & Non-Integer Tickets
  // =========================================================================
  describe('Boundary B2: Negative Numbers & Floating Points', () => {
    it('B2-1: Patient ticket calculator with negative number identifies turn passed', () => {
      const pAhead = calculatePatientsAhead(-5, 10);
      assert.ok(pAhead < 0, 'Negative ticket must result in negative pAhead');
      const calc = calculateWaitTime(-5, 10);
      assert.equal(calc.label, 'Turn passed');
    });

    it('B2-2: Ticket 0 in calculator handles boundary cleanly', () => {
      const pAhead = calculatePatientsAhead(0, 0);
      assert.equal(pAhead, 0);
      const calc = calculateWaitTime(0, 5);
      assert.equal(calc.label, 'Turn passed');
    });

    it('B2-3: Floating point ticket inputs floor or sanitize cleanly', () => {
      const floatTicket = 14.8;
      const floored = Math.floor(floatTicket);
      assert.equal(floored, 14);
      const calc = calculateWaitTime(floored, 10, 8);
      assert.equal(calc.pAhead, 4);
    });
  });

  // =========================================================================
  // B3: Large Ticket Numbers & Wait Time Formatting
  // =========================================================================
  describe('Boundary B3: Large Numbers & Extended Wait Durations', () => {
    it('B3-1: Large ticket number 9999 computes correct distance and wait', () => {
      const pAhead = calculatePatientsAhead(9999, 100);
      assert.equal(pAhead, 9899);
      const calc = calculateWaitTime(9999, 100, 10);
      assert.equal(calc.waitMinutes, 98990);
    });

    it('B3-2: Format wait time handles exact hours (>60 mins without remainder)', () => {
      assert.equal(formatWaitTime(120), '~2 hr');
      assert.equal(formatWaitTime(180), '~3 hr');
    });

    it('B3-3: Format wait time handles hours and remaining minutes', () => {
      assert.equal(formatWaitTime(75), '~1 hr 15 mins');
      assert.equal(formatWaitTime(130), '~2 hr 10 mins');
      assert.equal(formatWaitTime(500), '~8 hr 20 mins');
    });

    it('B3-4: 0 minutes wait formats as "Now Serving"', () => {
      assert.equal(formatWaitTime(0), 'Now Serving');
    });

    it('B3-5: Sub-hour wait formats in minutes only', () => {
      assert.equal(formatWaitTime(45), '~45 mins');
      assert.equal(formatWaitTime(1), '~1 mins');
    });
  });

  // =========================================================================
  // B4: Empty Strings & Payload Boundary Conditions
  // =========================================================================
  describe('Boundary B4: Empty Strings & Special Character Inputs', () => {
    it('B4-1: Login with empty string username returns 400', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: '', password: 'password123' }
      });
      assert.equal(res.status, 400);
    });

    it('B4-2: Login with empty string password returns 400', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics', password: '' }
      });
      assert.equal(res.status, 400);
    });

    it('B4-3: Status change with empty string returns 400 Bad Request', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: '' }
      });
      assert.equal(res.status, 400);
    });

    it('B4-4: Status change with non-existent status string returns 400', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Emergency Meeting' }
      });
      assert.equal(res.status, 400);
    });

    it('B4-5: Empty JSON body on mutation endpoint handled gracefully', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: {}
      });
      assert.equal(res.status, 400);
    });
  });

  // =========================================================================
  // B5: Malformed Tokens & Security Boundaries
  // =========================================================================
  describe('Boundary B5: Malformed Tokens & Header Boundaries', () => {
    it('B5-1: Empty Bearer token returns 401', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' }
      });
      assert.equal(res.status, 401);
    });

    it('B5-2: Corrupted/random string Bearer token returns 401', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: 'Bearer random_garbage_string_12345' }
      });
      assert.equal(res.status, 401);
    });

    it('B5-3: Non-Bearer authorization header scheme returns 401', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: 'Basic dXNlcjpwYXNz' }
      });
      assert.equal(res.status, 401);
    });

    it('B5-4: Token with valid structure but forged signature returns 401', async () => {
      const forgedToken = `${pediatricsToken.split('.').slice(0, 2).join('.')}.forged_signature`;
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${forgedToken}` }
      });
      assert.equal(res.status, 401);
    });

    it('B5-5: Oversized token header (>4KB) returns 401 without server crash', async () => {
      const giantToken = 'Bearer ' + 'A'.repeat(5000);
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: giantToken }
      });
      assert.ok(res.status === 401 || res.status === 431);
    });
  });

  // =========================================================================
  // B6: Rapid Concurrent Button Taps (Debounce & Atomic Concurrency)
  // =========================================================================
  describe('Boundary B6: Rapid Concurrent Button Taps', () => {
    it('B6-1: 10 rapid concurrent next requests advance queue sequentially', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
            method: 'POST',
            headers: { Authorization: `Bearer ${pediatricsToken}` }
          })
        );
      }
      const results = await Promise.all(promises);
      for (const res of results) {
        assert.equal(res.status, 200);
      }
      const finalState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(finalState.body.currentServing, 10, 'Queue must advance by exactly 10');
    });

    it('B6-2: Interleaved concurrent next and recall requests maintain consistency', async () => {
      const ops = [
        apiRequest(baseUrl, '/api/clinics/pediatrics/next', { method: 'POST', headers: { Authorization: `Bearer ${pediatricsToken}` } }),
        apiRequest(baseUrl, '/api/clinics/pediatrics/next', { method: 'POST', headers: { Authorization: `Bearer ${pediatricsToken}` } }),
        apiRequest(baseUrl, '/api/clinics/pediatrics/recall', { method: 'POST', headers: { Authorization: `Bearer ${pediatricsToken}` } })
      ];
      const results = await Promise.all(ops);
      for (const res of results) {
        assert.equal(res.status, 200);
      }
      const finalState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.ok(finalState.body.currentServing >= 0);
    });
  });

  // =========================================================================
  // B7: SSE Connection Drop and Reconnect
  // =========================================================================
  describe('Boundary B7: SSE Stream Drop & Immediate Reconnect', () => {
    it('B7-1: Client abort does not cause server errors', async () => {
      const sse = listenToSSE(baseUrl, 'pediatrics');
      await sse.waitForCount(1);
      sse.close(); // client disconnects
      await new Promise(r => setTimeout(r, 100));

      // Verify server remains responsive
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(res.status, 200);
    });

    it('B7-2: Reconnecting client immediately receives up-to-date state', async () => {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      const sse = listenToSSE(baseUrl, 'pediatrics');
      const events = await sse.waitForCount(1);
      sse.close();

      assert.ok(events.length >= 1);
      assert.equal(events[0].currentServing, 1);
    });

    it('B7-3: Rapid 5-cycle connect and disconnect executes cleanly', async () => {
      for (let i = 0; i < 5; i++) {
        const sse = listenToSSE(baseUrl, 'pediatrics');
        await sse.waitForCount(1);
        sse.close();
      }
      const check = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(check.status, 200);
    });
  });

  // =========================================================================
  // B8: Rapid Status Transitions
  // =========================================================================
  describe('Boundary B8: Rapid Status Transitions', () => {
    it('B8-1: Fast toggle between In Clinic and Brief Break retains final state', async () => {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Brief Break' }
      });
      await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'In Clinic' }
      });
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(res.body.status, 'In Clinic');
    });

    it('B8-2: Status transitions broadcast cleanly over SSE', async () => {
      const sse = listenToSSE(baseUrl, 'pediatrics');
      await sse.waitForCount(1);

      await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Finished' }
      });

      const events = await sse.waitForCount(2);
      sse.close();
      assert.ok(events.length >= 2);
      assert.equal(events[1].status, 'Finished');
    });
  });
});
