/**
 * @file tests/m2_adversarial_stress.test.js
 * Empirical Adversarial & Stress Testing Suite for Milestone 2:
 * 
 * 1. Unauthenticated Mutation Attacks (401 Unauthorized Invariant across all endpoints & clinics)
 * 2. Cross-Clinic Multi-Tenant Attacks (403 Forbidden Tenant Isolation Invariant)
 * 3. Boundary Payloads & Malformed JSON Injection (400 Syntax Errors, huge/negative numbers, invalid status strings)
 * 4. Login Brute Force & Malformed Body Attacks (Empty/non-string credentials, injection attempts, rapid bursts)
 * 5. High-Concurrency Stress & Race Condition Attacks (Parallel mutations, counter uniqueness, floor clamping, persistence integrity)
 * 
 * Execution: node --test tests/m2_adversarial_stress.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  startServer,
  stopServer,
  apiRequest,
  getClinicToken,
  resetAllClinics,
  DEFAULT_CLINICS,
  getDataDir
} = require('./test_helper.js');

const { generateToken, TokenService } = require('../src/auth/token_service.js');
const { config } = require('../src/config/app_config.js');

describe('Milestone 2 Empirical Adversarial & Stress Testing Suite', () => {
  let baseUrl = '';
  let pediatricsToken = '';
  let cardiologyToken = '';
  let generalToken = '';
  let dentalToken = '';

  const MUTATION_ENDPOINTS = [
    { name: 'next', method: 'POST', path: '/next', body: {} },
    { name: 'recall', method: 'POST', path: '/recall', body: {} },
    { name: 'skip', method: 'POST', path: '/skip', body: {} },
    { name: 'reset', method: 'POST', path: '/reset', body: {} },
    { name: 'status', method: 'POST', path: '/status', body: { status: 'Brief Break' } },
    { name: 'chime', method: 'POST', path: '/chime', body: {} }
  ];

  before(async () => {
    baseUrl = await startServer();
    pediatricsToken = await getClinicToken(baseUrl, 'pediatrics');
    cardiologyToken = await getClinicToken(baseUrl, 'cardiology');
    generalToken = await getClinicToken(baseUrl, 'general');
    dentalToken = await getClinicToken(baseUrl, 'dental');

    assert.ok(pediatricsToken, 'Failed to acquire pediatricsToken');
    assert.ok(cardiologyToken, 'Failed to acquire cardiologyToken');
    assert.ok(generalToken, 'Failed to acquire generalToken');
    assert.ok(dentalToken, 'Failed to acquire dentalToken');
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetAllClinics(baseUrl);
  });

  // =========================================================================
  // SUITE 1: Unauthenticated Mutation Attacks (401 Unauthorized)
  // =========================================================================
  describe('Suite 1: Unauthenticated Mutation Attacks (401 Unauthorized Invariant)', () => {
    it('1.1 should reject all 6 mutation endpoints with 401 when Authorization header is missing across all 4 clinics', async () => {
      const clinics = ['pediatrics', 'cardiology', 'general', 'dental'];

      for (const clinicId of clinics) {
        for (const ep of MUTATION_ENDPOINTS) {
          const url = `${baseUrl}/api/clinics/${clinicId}${ep.path}`;
          const res = await fetch(url, {
            method: ep.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ep.body)
          });

          assert.equal(
            res.status,
            401,
            `Expected 401 Unauthorized for unauthenticated ${ep.method} /api/clinics/${clinicId}${ep.path}, got ${res.status}`
          );

          const data = await res.json();
          assert.equal(data.error, 'Unauthorized');

          // Verify WWW-Authenticate header is set
          const wwwAuth = res.headers.get('www-authenticate');
          assert.ok(wwwAuth && wwwAuth.includes('Bearer'), 'Expected WWW-Authenticate header with Bearer challenge');
        }
      }
    });

    it('1.2 should reject empty or whitespace Authorization headers with 401', async () => {
      const headersToTest = [
        { Authorization: '' },
        { Authorization: '   ' },
        { Authorization: 'Bearer' },
        { Authorization: 'Bearer ' },
        { Authorization: 'Bearer    ' },
        { Authorization: 'Bearer \t\n' }
      ];

      for (const hdr of headersToTest) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
          method: 'POST',
          headers: hdr
        });
        assert.equal(res.status, 401, `Expected 401 for Authorization: "${hdr.Authorization}"`);
      }
    });

    it('1.3 should reject non-Bearer authorization schemes with 401', async () => {
      const invalidSchemes = [
        'Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
        'Digest username="test", realm="clinic"',
        'Token pediatrics_token_12345',
        'OAuth oauth_token="abcdef"',
        'CustomAuth pediatrics'
      ];

      for (const scheme of invalidSchemes) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
          method: 'POST',
          headers: { Authorization: scheme }
        });
        assert.equal(res.status, 401, `Expected 401 for scheme: "${scheme}"`);
      }
    });

    it('1.4 should reject cryptographically forged or tampered Bearer tokens with 401', async () => {
      const parts = pediatricsToken.split('.');
      assert.equal(parts.length, 3);

      // Attack A: Corrupt the signature
      const corruptedSig = parts[2].slice(0, -4) + 'WXYZ';
      const tamperedSigToken = `${parts[0]}.${parts[1]}.${corruptedSig}`;

      const res1 = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tamperedSigToken}` }
      });
      assert.equal(res1.status, 401, 'Expected 401 for corrupted signature');

      // Attack B: Tamper payload claims (elevate to admin or change clinic) without updating signature
      const payloadObj = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      payloadObj.clinicId = 'cardiology';
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
      const tamperedPayloadToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;

      const res2 = await fetch(`${baseUrl}/api/clinics/cardiology/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tamperedPayloadToken}` }
      });
      assert.equal(res2.status, 401, 'Expected 401 for tampered payload claims');

      // Attack C: alg: none attack
      const noneHeaderB64 = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const algNoneToken = `${noneHeaderB64}.${parts[1]}.`;

      const res3 = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${algNoneToken}` }
      });
      assert.equal(res3.status, 401, 'Expected 401 for alg:none attack');
    });

    it('1.5 should reject expired tokens with 401', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredToken = generateToken('pediatrics', {
        now: now - 7200,
        expiresIn: 3600 // Expired 1 hour ago
      });

      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${expiredToken}` }
      });
      assert.equal(res.status, 401, 'Expected 401 for expired token');
    });

    it('1.6 should reject tokens signed with an unauthorized/different secret key with 401', async () => {
      const rogueTokenService = new TokenService('rogue_unauthorized_attacker_secret_key!');
      const rogueToken = rogueTokenService.generateToken('pediatrics');

      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${rogueToken}` }
      });
      assert.equal(res.status, 401, 'Expected 401 for token signed with wrong secret');
    });

    it('1.7 should reject tokens issued far in the future (>60s clock skew) with 401', async () => {
      const futureNow = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
      const futureToken = generateToken('pediatrics', {
        now: futureNow,
        expiresIn: 3600
      });

      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${futureToken}` }
      });
      assert.equal(res.status, 401, 'Expected 401 for future issued token');
    });
  });

  // =========================================================================
  // SUITE 2: Cross-Clinic Multi-Tenant Attacks (403 Forbidden Invariant)
  // =========================================================================
  describe('Suite 2: Cross-Clinic Mutation Attacks (403 Forbidden Tenant Isolation Invariant)', () => {
    it('2.1 should reject Pediatrics token on ALL mutation endpoints for Cardiology, General, Dental with 403', async () => {
      const targetClinics = ['cardiology', 'general', 'dental'];

      for (const targetClinic of targetClinics) {
        for (const ep of MUTATION_ENDPOINTS) {
          const res = await fetch(`${baseUrl}/api/clinics/${targetClinic}${ep.path}`, {
            method: ep.method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${pediatricsToken}`
            },
            body: JSON.stringify(ep.body)
          });

          assert.equal(
            res.status,
            403,
            `Expected 403 Forbidden when Pediatrics token attacks ${targetClinic}${ep.path}, got ${res.status}`
          );

          const data = await res.json();
          assert.equal(data.error, 'Forbidden');
          assert.ok(
            data.message.includes('pediatrics') && data.message.includes(targetClinic),
            `Expected error message referencing tenant mismatch, got: ${data.message}`
          );
        }
      }
    });

    it('2.2 should reject cross-clinic mutations across full permutation matrix of all 4 clinics', async () => {
      const clinicTokens = [
        { id: 'pediatrics', token: pediatricsToken },
        { id: 'cardiology', token: cardiologyToken },
        { id: 'general', token: generalToken },
        { id: 'dental', token: dentalToken }
      ];

      for (const staff of clinicTokens) {
        for (const target of clinicTokens) {
          if (staff.id === target.id) continue;

          // Cross-tenant attack on /next
          const resNext = await fetch(`${baseUrl}/api/clinics/${target.id}/next`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${staff.token}` }
          });
          assert.equal(
            resNext.status,
            403,
            `Staff ${staff.id} modifying ${target.id}/next must return 403 Forbidden`
          );

          // Cross-tenant attack on /reset
          const resReset = await fetch(`${baseUrl}/api/clinics/${target.id}/reset`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${staff.token}` }
          });
          assert.equal(
            resReset.status,
            403,
            `Staff ${staff.id} resetting ${target.id}/reset must return 403 Forbidden`
          );

          // Cross-tenant attack on /status
          const resStatus = await fetch(`${baseUrl}/api/clinics/${target.id}/status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${staff.token}`
            },
            body: JSON.stringify({ status: 'Brief Break' })
          });
          assert.equal(
            resStatus.status,
            403,
            `Staff ${staff.id} modifying ${target.id}/status must return 403 Forbidden`
          );
        }
      }
    });

    it('2.3 should normalize path casing and URL encoding without bypassing 403 check', async () => {
      // Attacker tries uppercase or encoded clinic paths with Pediatrics token
      const trickyPaths = [
        '/api/clinics/CARDIOLOGY/next',
        '/api/clinics/Cardiology/next',
        '/api/clinics/%63ardiology/next',
        '/api/clinics/cardiology/../cardiology/next'
      ];

      for (const p of trickyPaths) {
        const res = await fetch(`${baseUrl}${p}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        });
        // Must either be 403 (properly resolved to cardiology) or 404 (normalized out)
        assert.ok(
          res.status === 403 || res.status === 404,
          `Tricky path ${p} must not bypass tenant boundary (got status ${res.status})`
        );
        if (res.status === 403) {
          const data = await res.json();
          assert.equal(data.error, 'Forbidden');
        }
      }
    });

    it('2.4 should reject non-existent clinic mutations with 404 even with valid token', async () => {
      const res = await fetch(`${baseUrl}/api/clinics/non_existent_department/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 404, 'Mutating non-existent clinic must return 404 Not Found');
    });

    it('2.5 should not allow body spoofing (specifying different clinicId in JSON body) to alter cross-clinic queue', async () => {
      // Pediatrics staff calls pediatrics endpoint but sends body claiming cardiology
      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pediatricsToken}`
        },
        body: JSON.stringify({ clinicId: 'cardiology' })
      });
      assert.equal(res.status, 200);

      // Verify Cardiology state remains 0 and unchanged
      const cardState = await apiRequest(baseUrl, '/api/clinics/cardiology/state');
      assert.equal(cardState.body.currentServing, 0, 'Cardiology state must remain 0');

      // Verify Pediatrics state was incremented to 1
      const pedsState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(pedsState.body.currentServing, 1, 'Pediatrics state must be 1');
    });
  });

  // =========================================================================
  // SUITE 3: Boundary Payloads, Injection & Malformed Body Attacks
  // =========================================================================
  describe('Suite 3: Boundary Payloads, Injection & Malformed Body Attacks', () => {
    it('3.1 should trap malformed JSON syntax errors and return 400 Bad Request', async () => {
      const brokenPayloads = [
        '{"status": ',
        '{ status: "In Clinic" }', // Unquoted keys
        '{"status": "In Clinic"',  // Missing closing brace
        '{"status": "In Clinic",}', // Trailing comma
        '[1, 2, 3, ]',
        'undefined',
        '<<<XML NOT JSON>>>'
      ];

      for (const broken of brokenPayloads) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pediatricsToken}`
          },
          body: broken
        });

        assert.equal(res.status, 400, `Expected 400 for malformed payload: "${broken}"`);
        const data = await res.json();
        assert.equal(data.error, 'Bad Request');
        assert.ok(data.message.includes('Malformed JSON payload'));
      }
    });

    it('3.2 should reject invalid status strings, numbers, booleans, arrays, and objects with 400', async () => {
      const invalidStatusPayloads = [
        { status: 'Open' },
        { status: 'Closed' },
        { status: 'Active' },
        { status: 'in clinic' }, // Wrong casing
        { status: 'IN CLINIC' },
        { status: 'In_Clinic' },
        { status: '' },
        { status: '   ' },
        { status: 999999999999 },
        { status: -1 },
        { status: 0 },
        { status: 3.14159 },
        { status: true },
        { status: false },
        { status: null },
        { status: ['In Clinic'] },
        { status: { text: 'In Clinic' } },
        { status: '<script>alert("XSS")</script>' },
        { status: "' OR '1'='1" },
        {} // Missing status field
      ];

      for (const payload of invalidStatusPayloads) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pediatricsToken}`
          },
          body: JSON.stringify(payload)
        });

        assert.equal(
          res.status,
          400,
          `Expected 400 for status payload: ${JSON.stringify(payload)}, got ${res.status}`
        );
        const data = await res.json();
        assert.equal(data.error, 'Bad Request');
        assert.ok(data.message.includes('Status must be one of'));
      }
    });

    it('3.3 should accept all three valid statuses and update state correctly', async () => {
      const validStatuses = ['Brief Break', 'Finished', 'In Clinic'];

      for (const st of validStatuses) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pediatricsToken}`
          },
          body: JSON.stringify({ status: st })
        });

        assert.equal(res.status, 200, `Expected 200 for valid status: "${st}"`);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, st);

        const check = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
        assert.equal(check.body.status, st);
      }
    });

    it('3.4 should reject reset if explicit confirm is set to false: { confirm: false }', async () => {
      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pediatricsToken}`
        },
        body: JSON.stringify({ confirm: false })
      });

      assert.equal(res.status, 400, 'Expected 400 when confirm: false is passed to reset');
      const data = await res.json();
      assert.equal(data.error, 'Bad Request');
    });

    it('3.5 should safely handle huge, negative, and non-integer startNumber on reset', async () => {
      const weirdStartNumbers = [
        { startNumber: -999 },
        { startNumber: 1e30 },
        { startNumber: 'huge' },
        { startNumber: null },
        { startNumber: NaN }
      ];

      for (const body of weirdStartNumbers) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/reset`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pediatricsToken}`
          },
          body: JSON.stringify({ confirm: true, ...body })
        });

        assert.equal(res.status, 200, `Expected 200 for reset with body: ${JSON.stringify(body)}`);
        const data = await res.json();
        assert.equal(data.currentServing, 0, 'currentServing must safely default to 0');
      }
    });

    it('3.6 should strictly clamp counter at 0 under repeated recall attacks', async () => {
      // Counter starts at 0
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${baseUrl}/api/clinics/pediatrics/recall`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.currentServing, 0, `Counter must stay clamped at 0 on recall #${i + 1}`);
      }

      // Verify state snapshot
      const state = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(state.body.currentServing, 0);
    });

    it('3.7 should safely advance to 1 on skip when counter is at 0 without recording 0 in skipped array (B1-4)', async () => {
      const res = await fetch(`${baseUrl}/api/clinics/pediatrics/skip`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.currentServing, 1, 'Counter must advance to 1');
      assert.deepEqual(data.skipped, [], 'Skipped list must NOT contain 0');

      const state = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(state.body.currentServing, 1);
      assert.deepEqual(state.body.skipped, []);
    });
  });

  // =========================================================================
  // SUITE 4: Login Endpoint Adversarial & Malformed Body Attacks
  // =========================================================================
  describe('Suite 4: Login Endpoint Adversarial & Malformed Body Attacks', () => {
    it('4.1 should reject empty, whitespace, or missing credentials with 400', async () => {
      const badLogins = [
        { username: '', password: 'pwd' },
        { username: 'pediatrics', password: '' },
        { username: '   ', password: 'pwd' },
        { username: 'pediatrics', password: '   ' },
        { username: '', password: '' },
        { username: 'pediatrics' }, // Missing password
        { password: 'pwd' }, // Missing username
        {} // Missing both
      ];

      for (const payload of badLogins) {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        assert.equal(
          res.status,
          400,
          `Expected 400 for login body: ${JSON.stringify(payload)}, got ${res.status}`
        );
        const data = await res.json();
        assert.equal(data.error, 'Username and password required');
      }
    });

    it('4.2 should reject non-string credential types with 400 without crashing', async () => {
      const typeAttacks = [
        { username: 12345, password: 'pwd' },
        { username: 'pediatrics', password: 12345 },
        { username: true, password: 'pwd' },
        { username: 'pediatrics', password: false },
        { username: ['pediatrics'], password: 'pwd' },
        { username: 'pediatrics', password: ['pwd'] },
        { username: { $gt: '' }, password: 'pwd' }, // NoSQL injection style
        { username: 'pediatrics', password: { $gt: '' } },
        { username: null, password: null }
      ];

      for (const attack of typeAttacks) {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attack)
        });

        assert.equal(
          res.status,
          400,
          `Expected 400 for type attack: ${JSON.stringify(attack)}, got ${res.status}`
        );
      }
    });

    it('4.3 should return 400 on malformed JSON body to /api/auth/login', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"username": "pediatrics", "password": '
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error, 'Bad Request');
      assert.ok(data.message.includes('Malformed JSON payload'));
    });

    it('4.4 should reject incorrect passwords and SQLi/XSS injection usernames with 401', async () => {
      const hostileCredentials = [
        { username: 'pediatrics', password: 'wrong_password_123' },
        { username: 'admin', password: 'admin' },
        { username: "' OR '1'='1", password: "' OR '1'='1" },
        { username: 'pediatrics', password: "' OR 1=1 --" },
        { username: '<script>alert(1)</script>', password: 'password' },
        { username: 'root', password: 'toor' }
      ];

      for (const cred of hostileCredentials) {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cred)
        });

        assert.equal(res.status, 401, `Expected 401 for hostile credential: ${cred.username}`);
        const data = await res.json();
        assert.equal(data.error, 'Invalid clinic credentials');
      }
    });

    it('4.5 should withstand a rapid brute force burst of 50 incorrect logins without crashing and remain functional', async () => {
      const burstRequests = Array.from({ length: 50 }, (_, i) =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'pediatrics',
            password: `brute_force_guess_${i}`
          })
        })
      );

      const responses = await Promise.all(burstRequests);
      for (const res of responses) {
        assert.equal(res.status, 401);
      }

      // Immediately verify valid login succeeds without service disruption
      const legitRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'pediatrics',
          password: 'pediatrics123'
        })
      });
      assert.equal(legitRes.status, 200);
      const legitData = await legitRes.json();
      assert.ok(legitData.token);
    });
  });

  // =========================================================================
  // SUITE 5: High-Concurrency Stress, Race Conditions & Disk Persistence Under Load
  // =========================================================================
  describe('Suite 5: Concurrency, Contention & Workload Stress Under Load', () => {
    it('5.1 should handle 50 concurrent /next mutations without lost updates or duplicate numbers', async () => {
      const NUM_REQUESTS = 50;

      // Launch 50 concurrent nextPatient requests
      const promises = Array.from({ length: NUM_REQUESTS }, () =>
        fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        }).then(r => r.json())
      );

      const results = await Promise.all(promises);

      // Verify all succeeded
      for (const r of results) {
        assert.equal(r.success, true);
        assert.equal(typeof r.currentServing, 'number');
      }

      // Extract all assigned serving numbers
      const servingNumbers = results.map(r => r.currentServing);
      assert.equal(servingNumbers.length, NUM_REQUESTS);

      // Verify all numbers are unique (no race condition assigning duplicate ticket numbers)
      const uniqueNumbers = new Set(servingNumbers);
      assert.equal(
        uniqueNumbers.size,
        NUM_REQUESTS,
        `Expected ${NUM_REQUESTS} unique ticket numbers, but got ${uniqueNumbers.size}. Possible race condition!`
      );

      // Verify final counter matches exactly
      const finalState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(finalState.body.currentServing, NUM_REQUESTS);
    });

    it('5.2 should safely clamp counter at 0 under 25 concurrent /recall mutations', async () => {
      // First advance queue to 5
      for (let i = 0; i < 5; i++) {
        await fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        });
      }

      const midState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(midState.body.currentServing, 5);

      // Concurrently fire 25 recalls
      const recalls = Array.from({ length: 25 }, () =>
        fetch(`${baseUrl}/api/clinics/pediatrics/recall`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        }).then(r => r.json())
      );

      const results = await Promise.all(recalls);
      for (const r of results) {
        assert.equal(r.success, true);
        assert.ok(r.currentServing >= 0, `Counter dropped below 0: ${r.currentServing}`);
      }

      // Final state must be exactly 0
      const finalState = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(finalState.body.currentServing, 0, 'Counter must be clamped at 0');
    });

    it('5.3 should handle interleaved concurrent flood (30 next, 15 skip, 15 recall, 5 status, 5 chime) without server crash', async () => {
      const tasks = [];

      // 30 next mutations
      for (let i = 0; i < 30; i++) {
        tasks.push(
          fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${pediatricsToken}` }
          })
        );
      }

      // 15 skip mutations
      for (let i = 0; i < 15; i++) {
        tasks.push(
          fetch(`${baseUrl}/api/clinics/pediatrics/skip`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${pediatricsToken}` }
          })
        );
      }

      // 15 recall mutations
      for (let i = 0; i < 15; i++) {
        tasks.push(
          fetch(`${baseUrl}/api/clinics/pediatrics/recall`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${pediatricsToken}` }
          })
        );
      }

      // 5 status mutations
      const statuses = ['In Clinic', 'Brief Break', 'In Clinic', 'Finished', 'In Clinic'];
      for (const st of statuses) {
        tasks.push(
          fetch(`${baseUrl}/api/clinics/pediatrics/status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${pediatricsToken}`
            },
            body: JSON.stringify({ status: st })
          })
        );
      }

      // 5 chime mutations
      for (let i = 0; i < 5; i++) {
        tasks.push(
          fetch(`${baseUrl}/api/clinics/pediatrics/chime`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${pediatricsToken}` }
          })
        );
      }

      // Execute all 70 requests simultaneously
      const responses = await Promise.all(tasks);
      for (const res of responses) {
        assert.equal(
          res.status,
          200,
          `Expected 200 OK under interleaved load, got ${res.status}`
        );
      }

      // Verify domain invariants remain uncorrupted
      const state = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.ok(
        Number.isInteger(state.body.currentServing) && state.body.currentServing >= 0,
        `currentServing must be a non-negative integer: ${state.body.currentServing}`
      );
      assert.ok(
        ['In Clinic', 'Brief Break', 'Finished'].includes(state.body.status),
        `status must be valid: ${state.body.status}`
      );
      assert.ok(Array.isArray(state.body.skipped), 'skipped must be an array');
      for (const s of state.body.skipped) {
        assert.ok(Number.isInteger(s) && s > 0, `skipped item must be integer > 0: ${s}`);
      }
    });

    it('5.4 should isolate concurrent multi-clinic load (40 Pediatrics + 40 Cardiology requests)', async () => {
      const pedsTasks = Array.from({ length: 40 }, () =>
        fetch(`${baseUrl}/api/clinics/pediatrics/next`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pediatricsToken}` }
        })
      );

      const cardTasks = Array.from({ length: 40 }, () =>
        fetch(`${baseUrl}/api/clinics/cardiology/next`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cardiologyToken}` }
        })
      );

      const allResponses = await Promise.all([...pedsTasks, ...cardTasks]);
      for (const r of allResponses) {
        assert.equal(r.status, 200);
      }

      const pedsFinal = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      const cardFinal = await apiRequest(baseUrl, '/api/clinics/cardiology/state');

      assert.equal(pedsFinal.body.currentServing, 40, 'Pediatrics counter must be 40');
      assert.equal(cardFinal.body.currentServing, 40, 'Cardiology counter must be 40');

      // General and Dental must remain untouched (0)
      const genFinal = await apiRequest(baseUrl, '/api/clinics/general/state');
      const dentalFinal = await apiRequest(baseUrl, '/api/clinics/dental/state');
      assert.equal(genFinal.body.currentServing, 0, 'General counter must remain 0');
      assert.equal(dentalFinal.body.currentServing, 0, 'Dental counter must remain 0');
    });

    it('5.5 should verify that on-disk persistence correctly reflects queue state after concurrent load', async () => {
      // Perform a series of known mutations
      await fetch(`${baseUrl}/api/clinics/dental/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      });
      await fetch(`${baseUrl}/api/clinics/dental/next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      });
      await fetch(`${baseUrl}/api/clinics/dental/skip`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dentalToken}` }
      });
      await fetch(`${baseUrl}/api/clinics/dental/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dentalToken}`
        },
        body: JSON.stringify({ status: 'Brief Break' })
      });

      // Small delay for disk flush
      await new Promise(r => setTimeout(r, 100));

      const inMemoryState = await apiRequest(baseUrl, '/api/clinics/dental/state');
      assert.equal(inMemoryState.body.currentServing, 3);
      assert.deepEqual(inMemoryState.body.skipped, [2]);
      assert.equal(inMemoryState.body.status, 'Brief Break');

      // Check on-disk file
      const dataFilePath = path.join(getDataDir(), 'clinic_queues.json');
      let diskJson = null;
      try {
        const raw = await fs.readFile(dataFilePath, 'utf8');
        diskJson = JSON.parse(raw);
      } catch {
        // Fallback to default config data file if test dir was not populated
        const defaultRaw = await fs.readFile(path.resolve(config.dataFile), 'utf8');
        diskJson = JSON.parse(defaultRaw);
      }

      assert.ok(diskJson && diskJson.clinics, 'Persistence JSON must contain clinics map');
      const dentalDisk = diskJson.clinics.dental;
      assert.ok(dentalDisk, 'Dental clinic record must exist on disk');
      assert.equal(dentalDisk.currentServing, 3, 'Persisted currentServing must match in-memory');
      assert.deepEqual(dentalDisk.skipped, [2], 'Persisted skipped must match in-memory');
      assert.equal(dentalDisk.status, 'Brief Break', 'Persisted status must match in-memory');
    });
  });
});
