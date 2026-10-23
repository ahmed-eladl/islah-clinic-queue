// tests/tier3_isolation_tests.test.js
// Tier 3: Multi-Clinic Isolation & Security Suite
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
  DEFAULT_CLINICS
} = require('./test_helper');

describe('Tier 3: Multi-Clinic Isolation & Security Suite', () => {
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
  // I1: Cross-Clinic Mutation Forgery & Token Scoping
  // =========================================================================
  describe('Isolation I1: Cross-Clinic Authorization Tampering (Token Scope)', () => {
    it('I1-1: Pediatrics staff token cannot advance Cardiology queue (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('I1-2: Pediatrics staff token cannot recall General Medicine queue (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/general/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('I1-3: Pediatrics staff token cannot skip Dental clinic patient (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/dental/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('I1-4: Pediatrics staff token cannot reset Cardiology queue (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/cardiology/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('I1-5: Pediatrics staff token cannot change General Medicine status (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/general/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Brief Break' }
      });
      assert.equal(res.status, 403);
    });

    it('I1-6: Cardiology staff token cannot mutate Pediatrics queue (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      });
      assert.equal(res.status, 403);
    });

    it('I1-7: Dental staff token cannot reset General Medicine queue (403)', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/general/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      });
      assert.equal(res.status, 403);
    });
  });

  // =========================================================================
  // I2: Unauthenticated Protection Across All Clinics
  // =========================================================================
  describe('Isolation I2: Unauthenticated Protection Across All Clinics', () => {
    it('I2-1: Unauthenticated next patient rejected on all 4 clinics', async () => {
      for (const clinic of ['pediatrics', 'cardiology', 'general', 'dental']) {
        const res = await apiRequest(baseUrl, `/api/clinics/${clinic}/next`, { method: 'POST' });
        assert.equal(res.status, 401, `Failed to reject unauthenticated call on ${clinic}`);
      }
    });

    it('I2-2: Unauthenticated recall patient rejected on all 4 clinics', async () => {
      for (const clinic of ['pediatrics', 'cardiology', 'general', 'dental']) {
        const res = await apiRequest(baseUrl, `/api/clinics/${clinic}/recall`, { method: 'POST' });
        assert.equal(res.status, 401);
      }
    });

    it('I2-3: Unauthenticated queue reset rejected on all 4 clinics', async () => {
      for (const clinic of ['pediatrics', 'cardiology', 'general', 'dental']) {
        const res = await apiRequest(baseUrl, `/api/clinics/${clinic}/reset`, { method: 'POST' });
        assert.equal(res.status, 401);
      }
    });

    it('I2-4: Unauthenticated status modification rejected on all 4 clinics', async () => {
      for (const clinic of ['pediatrics', 'cardiology', 'general', 'dental']) {
        const res = await apiRequest(baseUrl, `/api/clinics/${clinic}/status`, {
          method: 'POST',
          body: { status: 'Brief Break' }
        });
        assert.equal(res.status, 401);
      }
    });
  });

  // =========================================================================
  // I3: Real-Time SSE Channel Isolation
  // =========================================================================
  describe('Isolation I3: Real-Time SSE Channel Isolation (Zero Cross-Talk)', () => {
    it('I3-1: Pediatrics event does not leak to Cardiology or General streams', async () => {
      const pSSE = listenToSSE(baseUrl, 'pediatrics');
      const cSSE = listenToSSE(baseUrl, 'cardiology');
      const gSSE = listenToSSE(baseUrl, 'general');

      await Promise.all([
        pSSE.waitForCount(1),
        cSSE.waitForCount(1),
        gSSE.waitForCount(1)
      ]);

      // Advance Pediatrics
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      await pSSE.waitForCount(2);
      await new Promise(r => setTimeout(r, 100));

      pSSE.close();
      cSSE.close();
      gSSE.close();

      assert.equal(pSSE.events.length, 2, 'Pediatrics should have received update');
      assert.equal(cSSE.events.length, 1, 'Cardiology must NOT receive Pediatrics update');
      assert.equal(gSSE.events.length, 1, 'General must NOT receive Pediatrics update');
    });

    it('I3-2: Cardiology event delivers only to Cardiology subscribers', async () => {
      const pSSE = listenToSSE(baseUrl, 'pediatrics');
      const cSSE = listenToSSE(baseUrl, 'cardiology');

      await Promise.all([pSSE.waitForCount(1), cSSE.waitForCount(1)]);

      // Advance Cardiology
      await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      });

      await cSSE.waitForCount(2);
      await new Promise(r => setTimeout(r, 100));

      pSSE.close();
      cSSE.close();

      assert.equal(cSSE.events.length, 2);
      assert.equal(pSSE.events.length, 1);
    });
  });

  // =========================================================================
  // I4: Pairwise State Separation & Independent Lifecycles
  // =========================================================================
  describe('Isolation I4: Pairwise State Separation & Independent Lifecycles', () => {
    it('I4-1: Independent serving numbers across all 4 clinics', async () => {
      // Advance Pediatrics to 3
      for (let i = 0; i < 3; i++) {
        await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        });
      }
      // Advance Cardiology to 7
      for (let i = 0; i < 7; i++) {
        await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cardiologyToken}` }
        });
      }
      // Advance General to 1
      await apiRequest(baseUrl, '/api/clinics/general/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${generalToken}` }
      });

      const p = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      const c = await apiRequest(baseUrl, '/api/clinics/cardiology/state');
      const g = await apiRequest(baseUrl, '/api/clinics/general/state');
      const d = await apiRequest(baseUrl, '/api/clinics/dental/state');

      assert.equal(p.body.currentServing, 3);
      assert.equal(c.body.currentServing, 7);
      assert.equal(g.body.currentServing, 1);
      assert.equal(d.body.currentServing, 0);
    });

    it('I4-2: Resetting one clinic leaves other clinics completely intact', async () => {
      // Advance both
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      });

      // Reset Cardiology only
      await apiRequest(baseUrl, '/api/clinics/cardiology/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      });

      const p = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      const c = await apiRequest(baseUrl, '/api/clinics/cardiology/state');

      assert.equal(p.body.currentServing, 1, 'Pediatrics must remain 1');
      assert.equal(c.body.currentServing, 0, 'Cardiology must be reset to 0');
    });

    it('I4-3: Skipped patient lists are strictly isolated per clinic', async () => {
      await apiRequest(baseUrl, '/api/clinics/dental/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      });
      await apiRequest(baseUrl, '/api/clinics/dental/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      });

      const dentalState = await apiRequest(baseUrl, '/api/clinics/dental/state');
      const pedState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');

      assert.ok(dentalState.body.skipped.includes(1));
      assert.deepEqual(pedState.body.skipped, []);
    });
  });

  // =========================================================================
  // I5: Credential Boundary Protection
  // =========================================================================
  describe('Isolation I5: Credential Boundary Protection', () => {
    it('I5-1: Pediatrics username cannot authenticate with Cardiology password', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics', password: 'cardiology123' }
      });
      assert.equal(res.status, 401);
    });

    it('I5-2: Cardiology username cannot authenticate with General Medicine password', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'cardiology', password: 'general123' }
      });
      assert.equal(res.status, 401);
    });
  });
});
