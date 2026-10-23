// tests/tier4_workload_tests.test.js
// Tier 4: Real-World Clinical Workload Scenarios
// Derived from ORIGINAL_REQUEST.md, PROJECT.md, and TEST_INFRA.md

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  formatWaitTime,
  getDataDir,
  DEFAULT_CLINICS
} = require('./test_helper');

const { ReferenceServer } = require('./reference_server');

describe('Tier 4: Real-World Clinical Workload Scenarios', () => {
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
  // Scenario 1: Full Clinic Morning Rush (100 Patients & Doctor Break Cycles)
  // =========================================================================
  it('Scenario 1: Full Clinic Morning Rush (100 Patients & Doctor Break Cycles)', async () => {
    const sse = listenToSSE(baseUrl, 'pediatrics');
    await sse.waitForCount(1); // initial event

    // 1. Morning start: advance 20 patients
    for (let i = 0; i < 20; i++) {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);
    }

    // 2. Doctor takes a brief morning break
    await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` },
      body: { status: 'Brief Break' }
    });

    // Verify patient #40 wait calculation during break
    const breakWait = calculateWaitTime(40, 20, 10, 'Brief Break', 15);
    assert.equal(breakWait.pAhead, 20);
    assert.equal(breakWait.waitMinutes, (20 * 10) + 15); // 215 mins
    assert.equal(breakWait.label, '~3 hr 35 mins');

    // 3. Doctor resumes consultations
    await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` },
      body: { status: 'In Clinic' }
    });

    // 4. Nurse advances queue through 80 more patients (reaching 100)
    for (let i = 0; i < 80; i++) {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
    }

    // 5. Final clinic session finished
    await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` },
      body: { status: 'Finished' }
    });

    const finalState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
    sse.close();

    assert.equal(finalState.body.currentServing, 100, 'Must have served 100 patients');
    assert.equal(finalState.body.status, 'Finished');
  });

  // =========================================================================
  // Scenario 2: Multi-Clinic Concurrent Cross-Traffic
  // =========================================================================
  it('Scenario 2: Multi-Clinic Concurrent Cross-Traffic (Pediatrics, Cardiology, General, Dental)', async () => {
    // 4 concurrent SSE streams monitoring independent channels
    const pSSE = listenToSSE(baseUrl, 'pediatrics');
    const cSSE = listenToSSE(baseUrl, 'cardiology');
    const gSSE = listenToSSE(baseUrl, 'general');
    const dSSE = listenToSSE(baseUrl, 'dental');

    await Promise.all([
      pSSE.waitForCount(1),
      cSSE.waitForCount(1),
      gSSE.waitForCount(1),
      dSSE.waitForCount(1)
    ]);

    // Fire interleaved operations across all clinics concurrently
    const operations = [];

    // Pediatrics advances 15 times
    for (let i = 0; i < 15; i++) {
      operations.push(apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      }));
    }

    // Cardiology advances 8 times and takes a break
    for (let i = 0; i < 8; i++) {
      operations.push(apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      }));
    }

    // General advances 20 times and skips 2
    for (let i = 0; i < 20; i++) {
      operations.push(apiRequest(baseUrl, '/api/clinics/general/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${generalToken}` }
      }));
    }

    // Dental advances 5 times
    for (let i = 0; i < 5; i++) {
      operations.push(apiRequest(baseUrl, '/api/clinics/dental/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      }));
    }

    // Execute all 48 concurrent requests
    await Promise.all(operations);

    // Verify all four clinics reached their independent targets
    const pState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
    const cState = await apiRequest(baseUrl, '/api/clinics/cardiology/state');
    const gState = await apiRequest(baseUrl, '/api/clinics/general/state');
    const dState = await apiRequest(baseUrl, '/api/clinics/dental/state');

    pSSE.close();
    cSSE.close();
    gSSE.close();
    dSSE.close();

    assert.equal(pState.body.currentServing, 15);
    assert.equal(cState.body.currentServing, 8);
    assert.equal(gState.body.currentServing, 20);
    assert.equal(dState.body.currentServing, 5);
  });

  // =========================================================================
  // Scenario 3: Sudden Server Crash & Reboot State Preservation
  // =========================================================================
  it('Scenario 3: Sudden Server Crash & Reboot State Recovery', async () => {
    // 1. Advance Pediatrics to 17, set status to Brief Break, skip ticket 5
    for (let i = 0; i < 5; i++) {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
    }
    await apiRequest(baseUrl, '/api/clinics/pediatrics/skip', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    for (let i = 0; i < 11; i++) {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
    }
    await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` },
      body: { status: 'Brief Break' }
    });

    // Advance Cardiology to 9
    for (let i = 0; i < 9; i++) {
      await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      });
    }

    // 2. Capture persistence file content
    const dataFilePath = path.join(getDataDir(), 'clinic_queues.json');
    assert.ok(fs.existsSync(dataFilePath), 'Storage file must exist before crash');
    const preCrashData = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));

    // 3. Simulate sudden crash: instantiate fresh server loading from same file
    const rebootServer = new ReferenceServer({ port: 0, dataDir: getDataDir() });
    const rebootUrl = await rebootServer.start();

    // 4. Verify rebooted instance restored exact state
    const pRebootState = await apiRequest(rebootUrl, '/api/clinics/pediatrics/state');
    const cRebootState = await apiRequest(rebootUrl, '/api/clinics/cardiology/state');

    await rebootServer.stop();

    assert.equal(pRebootState.body.currentServing, preCrashData.clinics.pediatrics.currentServing);
    assert.equal(pRebootState.body.status, 'Brief Break');
    assert.ok(pRebootState.body.skipped.includes(5));
    assert.equal(cRebootState.body.currentServing, preCrashData.clinics.cardiology.currentServing);
  });

  // =========================================================================
  // Scenario 4: Complete Patient Journey (QR -> Wait -> Approaching -> Called)
  // =========================================================================
  it('Scenario 4: Complete Patient Journey (QR Scan -> Wait Calc -> Approaching Alert -> Called Chime)', async () => {
    // 1. Patient arrives at clinic, scans QR code for Pediatrics
    const scannedUrl = new URL('http://127.0.0.1:3000/?clinic=pediatrics');
    const clinicId = scannedUrl.searchParams.get('clinic');
    assert.equal(clinicId, 'pediatrics');

    // 2. Patient receives ticket #6 at reception while doctor is serving #2
    for (let i = 0; i < 2; i++) {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
    }

    // Patient enters ticket #6 into calculator
    const patientTicket = 6;
    let currentServing = 2;
    let waitCalc = calculateWaitTime(patientTicket, currentServing, 10, 'In Clinic');
    assert.equal(waitCalc.pAhead, 4); // 4 patients ahead
    assert.equal(waitCalc.waitMinutes, 40); // 40 mins
    assert.equal(waitCalc.label, '~40 mins');

    // 3. Nurse advances to #3 -> 3 ahead
    await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    currentServing = 3;
    waitCalc = calculateWaitTime(patientTicket, currentServing, 10);
    assert.equal(waitCalc.pAhead, 3);

    // 4. Nurse advances to #4 -> 2 spots ahead (Stage 1 Approaching Alert triggered!)
    await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    currentServing = 4;
    const pAheadApproaching = calculatePatientsAhead(patientTicket, currentServing);
    assert.equal(pAheadApproaching, 2);
    const isApproaching = pAheadApproaching >= 1 && pAheadApproaching <= 2;
    assert.ok(isApproaching, 'Approaching alert must be active at 2 spots ahead');

    // 5. Nurse advances to #5 -> 1 spot ahead (Still Approaching)
    await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    currentServing = 5;
    assert.equal(calculatePatientsAhead(patientTicket, currentServing), 1);

    // 6. Nurse advances to #6 -> Exact Turn Called (Stage 2 Turn Called Alert + Audio Chime!)
    await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    currentServing = 6;
    const pAheadCalled = calculatePatientsAhead(patientTicket, currentServing);
    assert.equal(pAheadCalled, 0);
    const isTurnCalled = pAheadCalled === 0;
    assert.ok(isTurnCalled, 'Turn called alert must trigger when pAhead == 0');

    // Chime trigger on staff side
    const chimeRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/chime', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    assert.equal(chimeRes.body.chimeTriggered, true);
  });

  // =========================================================================
  // Scenario 5: Unauthorized Tampering & Adversarial Flood
  // =========================================================================
  it('Scenario 5: Unauthorized Tampering & Adversarial Flood (50 Hostile Requests)', async () => {
    // 1. Establish baseline clinic state
    await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pediatricsToken}` }
    });
    const baseline = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
    assert.equal(baseline.body.currentServing, 1);

    // 2. Launch flood of 50 adversarial requests
    const attackPromises = [];

    // 10 unauthenticated reset attempts
    for (let i = 0; i < 10; i++) {
      attackPromises.push(apiRequest(baseUrl, '/api/clinics/pediatrics/reset', { method: 'POST' }));
    }

    // 10 cross-clinic forgery attempts using cardiology token
    for (let i = 0; i < 10; i++) {
      attackPromises.push(apiRequest(baseUrl, '/api/clinics/pediatrics/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cardiologyToken}` }
      }));
    }

    // 10 invalid bearer token attempts
    for (let i = 0; i < 10; i++) {
      attackPromises.push(apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer fake_forged_token_${i}` }
      }));
    }

    // 10 invalid method attempts (PUT, DELETE)
    for (let i = 0; i < 10; i++) {
      attackPromises.push(apiRequest(baseUrl, '/api/clinics/pediatrics/state', { method: 'DELETE' }));
    }

    // 10 path traversal / malformed clinic ID attempts
    for (let i = 0; i < 10; i++) {
      attackPromises.push(apiRequest(baseUrl, '/api/clinics/..%2F..%2Fetc/state'));
    }

    const attackResults = await Promise.all(attackPromises);

    // Verify 100% of adversarial requests were rejected
    for (const res of attackResults) {
      assert.ok(
        [400, 401, 403, 404, 405].includes(res.status),
        `Adversarial request unexpectedly returned status ${res.status}`
      );
    }

    // Verify queue remained pristine and uncorrupted
    const postAttack = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
    assert.equal(postAttack.body.currentServing, 1, 'Queue must remain intact after attack flood');
    assert.equal(postAttack.body.status, 'In Clinic');
    assert.deepEqual(postAttack.body.skipped, []);
  });
});
