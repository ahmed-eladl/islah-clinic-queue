/**
 * @file tests/m1_adversarial_stress.test.js
 * Empirical Adversarial & Stress Testing Suite for Milestone 1:
 * - Cryptographic Token Attacks (Forged signatures, expired tokens, tampered payloads, alg=none, malformed headers)
 * - Multi-Clinic Auth & Tenant Boundary Enforcement (401 Unauthorized, 403 Forbidden, 404 Not Found)
 * - Atomic Persistence & Contention Stress (Rapid concurrent writes, Windows rename locking, corrupted file recovery)
 * - Domain Model & State Machine Concurrency & Edge Cases (Clamping, skipped arrays, unconfirmed resets)
 * 
 * Execution: node --test tests/m1_adversarial_stress.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Target modules under test
const { TokenService, base64UrlEncode, base64UrlDecode } = require('../src/auth/token_service.js');
const { authenticateStaff, authorizeClinic } = require('../src/middleware/auth_middleware.js');
const { AtomicFileAdapter, initializeClinicState } = require('../src/persistence/atomic_file_adapter.js');
const { QueueModel, DomainError, DomainValidationError } = require('../src/domain/queue_model.js');
const { QueueStore, NotFoundError } = require('../src/domain/queue_store.js');

// Standard test credentials & seed fixtures
const TEST_SECRET = 'adversarial_stress_secret_key_32chars_long!';
const SEED_CLINICS = [
  { id: 'pediatrics', name: 'Pediatrics Clinic', room: 'Room 101', doctorName: 'Dr. Jenkins' },
  { id: 'cardiology', name: 'Cardiology Clinic', room: 'Room 204', doctorName: 'Dr. Vance' },
  { id: 'general', name: 'General Practice', room: 'Room 102', doctorName: 'Dr. Rostova' },
  { id: 'dental', name: 'Dental Clinic', room: 'Room 305', doctorName: 'Dr. Chen' }
];

/**
 * Helper to construct lightweight mock Express req/res objects
 */
function createMockHttp({ headers = {}, params = {}, body = {}, auth = null } = {}) {
  const req = {
    headers: { ...headers },
    params: { ...params },
    body: { ...body },
    auth
  };

  const res = {
    statusCode: 200,
    headers: {},
    responseBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.responseBody = data;
      return this;
    },
    setHeader(name, val) {
      this.headers[name] = val;
      return this;
    }
  };

  let nextCalled = false;
  const next = () => { nextCalled = true; };

  return { req, res, next, isNextCalled: () => nextCalled };
}

describe('Empirical Adversarial & Stress Testing Suite (Milestone 1)', () => {

  // =========================================================================
  // SECTION 1: Token Attacks & Cryptographic Forgery Suite
  // =========================================================================
  describe('1. Token Attacks & Cryptographic Verification', () => {
    let tokenService;

    beforeEach(() => {
      tokenService = new TokenService(TEST_SECRET);
    });

    describe('1.1 Forged Signatures & Secret Tampering', () => {
      it('rejects token signed with an arbitrary attacker secret', () => {
        const attackerService = new TokenService('attacker_arbitrary_secret_key_32_characters');
        const token = attackerService.generateToken({ clinicId: 'pediatrics', role: 'staff' });

        const verified = tokenService.verifyToken(token);
        assert.equal(verified, null, 'Server must reject tokens signed with untrusted secret');
      });

      it('rejects token with single-bit flip in HMAC signature', () => {
        const token = tokenService.generateToken({ clinicId: 'pediatrics', role: 'staff' });
        const [header, payload, sig] = token.split('.');

        // Flip the last character in the base64url signature
        const lastChar = sig.slice(-1);
        const replacement = lastChar === 'a' ? 'b' : 'a';
        const tamperedSig = sig.slice(0, -1) + replacement;
        const tamperedToken = `${header}.${payload}.${tamperedSig}`;

        const verified = tokenService.verifyToken(tamperedToken);
        assert.equal(verified, null, 'Bit-flipped signature must be rejected');
      });

      it('rejects token with truncated signature bytes', () => {
        const token = tokenService.generateToken({ clinicId: 'cardiology', role: 'staff' });
        const [header, payload, sig] = token.split('.');
        const truncatedToken = `${header}.${payload}.${sig.slice(0, 16)}`;

        const verified = tokenService.verifyToken(truncatedToken);
        assert.equal(verified, null, 'Truncated signature must be rejected');
      });

      it('rejects token with appended garbage in signature', () => {
        const token = tokenService.generateToken({ clinicId: 'general', role: 'staff' });
        const [header, payload, sig] = token.split('.');
        const bloatedToken = `${header}.${payload}.${sig}==extraGarbage`;

        const verified = tokenService.verifyToken(bloatedToken);
        assert.equal(verified, null, 'Bloated signature must be rejected');
      });
    });

    describe('1.2 Expired Tokens & Temporal Clock Skew', () => {
      it('rejects token that expired 1 second in the past', () => {
        const now = Math.floor(Date.now() / 1000);
        const token = tokenService.generateToken(
          { clinicId: 'pediatrics' },
          { now, expiresInSeconds: -1 }
        );

        const verified = tokenService.verifyToken(token, { now });
        assert.equal(verified, null, 'Immediately expired token must be rejected');
      });

      it('rejects token expired in distant past', () => {
        const now = Math.floor(Date.now() / 1000);
        const token = tokenService.generateToken(
          { clinicId: 'pediatrics' },
          { now: now - 100000, expiresInSeconds: 100 }
        );

        const verified = tokenService.verifyToken(token, { now });
        assert.equal(verified, null, 'Stale expired token must be rejected');
      });

      it('rejects token issued in the future beyond clock-skew tolerance (>60s)', () => {
        const now = Math.floor(Date.now() / 1000);
        const token = tokenService.generateToken(
          { clinicId: 'pediatrics' },
          { now: now + 120, expiresInSeconds: 3600 } // Issued 120s in future
        );

        const verified = tokenService.verifyToken(token, { now });
        assert.equal(verified, null, 'Token with future iat > 60s must be rejected');
      });

      it('accepts token issued within reasonable clock skew (<=60s in future)', () => {
        const now = Math.floor(Date.now() / 1000);
        const token = tokenService.generateToken(
          { clinicId: 'pediatrics' },
          { now: now + 30, expiresInSeconds: 3600 } // 30s skew
        );

        const verified = tokenService.verifyToken(token, { now });
        assert.ok(verified, 'Token within 60s clock skew tolerance should be accepted');
        assert.equal(verified.clinicId, 'pediatrics');
      });
    });

    describe('1.3 Altered Payload & Claim Tampering Attacks', () => {
      it('rejects token when clinicId in payload is swapped for another clinic', () => {
        // Generate valid token for Pediatrics
        const token = tokenService.generateToken({ clinicId: 'pediatrics', role: 'staff' });
        const [header, payloadB64, sig] = token.split('.');

        // Tamper payload to claim Cardiology
        const payload = JSON.parse(base64UrlDecode(payloadB64));
        payload.clinicId = 'cardiology';
        const tamperedB64 = base64UrlEncode(JSON.stringify(payload));
        const tamperedToken = `${header}.${tamperedB64}.${sig}`;

        const verified = tokenService.verifyToken(tamperedToken);
        assert.equal(verified, null, 'Payload tampering must invalidate token signature');
      });

      it('rejects token when role is elevated to admin/root without secret', () => {
        const token = tokenService.generateToken({ clinicId: 'pediatrics', role: 'staff' });
        const [header, payloadB64, sig] = token.split('.');

        const payload = JSON.parse(base64UrlDecode(payloadB64));
        payload.role = 'superuser';
        const tamperedB64 = base64UrlEncode(JSON.stringify(payload));
        const tamperedToken = `${header}.${tamperedB64}.${sig}`;

        const verified = tokenService.verifyToken(tamperedToken);
        assert.equal(verified, null, 'Privilege escalation via claim tamper must fail');
      });

      it('rejects token when expiration is extended in payload', () => {
        const now = Math.floor(Date.now() / 1000);
        const token = tokenService.generateToken({ clinicId: 'pediatrics' }, { now, expiresInSeconds: -10 });
        const [header, payloadB64, sig] = token.split('.');

        // Attempt to un-expire the token by modifying exp
        const payload = JSON.parse(base64UrlDecode(payloadB64));
        payload.exp = now + 1000000;
        const tamperedB64 = base64UrlEncode(JSON.stringify(payload));
        const tamperedToken = `${header}.${tamperedB64}.${sig}`;

        const verified = tokenService.verifyToken(tamperedToken, { now });
        assert.equal(verified, null, 'Tampered expiration must fail signature check');
      });

      it('rejects payload with non-string or malicious clinicId shapes', () => {
        // Hand-craft tokens with malicious payload structures signed with proper secret
        const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

        const maliciousPayloads = [
          { role: 'staff', exp: 9999999999 }, // Missing clinicId
          { clinicId: '', role: 'staff', exp: 9999999999 }, // Empty clinicId
          { clinicId: '   ', role: 'staff', exp: 9999999999 }, // Whitespace clinicId
          { clinicId: 12345, role: 'staff', exp: 9999999999 }, // Number clinicId
          { clinicId: true, role: 'staff', exp: 9999999999 }, // Boolean clinicId
          { clinicId: { $ne: null }, role: 'staff', exp: 9999999999 }, // Object injection clinicId
          { clinicId: ['pediatrics'], role: 'staff', exp: 9999999999 } // Array clinicId
        ];

        for (const malPayload of maliciousPayloads) {
          const payloadB64 = base64UrlEncode(JSON.stringify(malPayload));
          const data = `${headerB64}.${payloadB64}`;
          const sig = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('base64url');
          const token = `${data}.${sig}`;

          const verified = tokenService.verifyToken(token);
          assert.equal(verified, null, `Malicious payload shape should be rejected: ${JSON.stringify(malPayload)}`);
        }
      });
    });

    describe('1.4 Algorithm Substitution & "none" Algorithm Injection', () => {
      it('rejects classic "alg": "none" with empty signature', () => {
        const header = base64UrlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
        const payload = base64UrlEncode(JSON.stringify({ clinicId: 'pediatrics', exp: 9999999999 }));
        const attackToken = `${header}.${payload}.`;

        const verified = tokenService.verifyToken(attackToken);
        assert.equal(verified, null, 'Algorithm none with trailing dot must be rejected');
      });

      it('rejects "alg": "none" with forged non-empty signature', () => {
        const header = base64UrlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
        const payload = base64UrlEncode(JSON.stringify({ clinicId: 'pediatrics', exp: 9999999999 }));
        const attackToken = `${header}.${payload}.arbitrarySignatureString`;

        const verified = tokenService.verifyToken(attackToken);
        assert.equal(verified, null, 'Algorithm none with fake signature must be rejected');
      });

      it('rejects case variations of "none" (None, NONE, NoNe)', () => {
        const caseVariations = ['None', 'NONE', 'NoNe', 'none '];
        for (const alg of caseVariations) {
          const header = base64UrlEncode(JSON.stringify({ alg, typ: 'JWT' }));
          const payload = base64UrlEncode(JSON.stringify({ clinicId: 'pediatrics', exp: 9999999999 }));
          const attackToken = `${header}.${payload}.`;

          const verified = tokenService.verifyToken(attackToken);
          assert.equal(verified, null, `Algorithm variation "${alg}" must be rejected`);
        }
      });

      it('rejects unsupported asymmetric/symmetric algorithms (RS256, ES256, HS384, HS512)', () => {
        const unsupportedAlgs = ['RS256', 'RS512', 'ES256', 'HS384', 'HS512'];
        for (const alg of unsupportedAlgs) {
          const header = base64UrlEncode(JSON.stringify({ alg, typ: 'JWT' }));
          const payload = base64UrlEncode(JSON.stringify({ clinicId: 'pediatrics', exp: 9999999999 }));
          const data = `${header}.${payload}`;
          const sig = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('base64url');
          const attackToken = `${data}.${sig}`;

          const verified = tokenService.verifyToken(attackToken);
          assert.equal(verified, null, `Unsupported algorithm "${alg}" must be rejected`);
        }
      });

      it('rejects token when header is missing alg property or empty object', () => {
        const invalidHeaders = [
          {},
          { typ: 'JWT' },
          { alg: null },
          { alg: 123 },
          { alg: ['HS256'] }
        ];

        for (const hdr of invalidHeaders) {
          const headerB64 = base64UrlEncode(JSON.stringify(hdr));
          const payloadB64 = base64UrlEncode(JSON.stringify({ clinicId: 'pediatrics', exp: 9999999999 }));
          const data = `${headerB64}.${payloadB64}`;
          const sig = crypto.createHmac('sha256', TEST_SECRET).update(data).digest('base64url');
          const attackToken = `${data}.${sig}`;

          const verified = tokenService.verifyToken(attackToken);
          assert.equal(verified, null, `Invalid header ${JSON.stringify(hdr)} must be rejected`);
        }
      });
    });

    describe('1.5 Malformed Tokens & Encoding Edge Cases', () => {
      it('safely handles non-string and empty token inputs without throwing', () => {
        const garbageInputs = [
          null,
          undefined,
          '',
          '   ',
          12345,
          {},
          [],
          true,
          false,
          NaN,
          Infinity
        ];

        for (const input of garbageInputs) {
          const verified = tokenService.verifyToken(input);
          assert.equal(verified, null, `Garbage input ${input} must return null cleanly`);
        }
      });

      it('rejects tokens with invalid segment counts', () => {
        const invalidSegments = [
          'singlePart',
          'partOne.partTwo',
          'partOne.partTwo.partThree.partFour',
          'partOne.partTwo.partThree.partFour.partFive',
          '..',
          'a..b',
          '.b.',
          '..c'
        ];

        for (const token of invalidSegments) {
          const verified = tokenService.verifyToken(token);
          assert.equal(verified, null, `Segment count mismatch in "${token}" must return null`);
        }
      });

      it('rejects tokens containing non-base64url characters', () => {
        const badToken = 'header!@#.payload$%^.signature&*()';
        const verified = tokenService.verifyToken(badToken);
        assert.equal(verified, null);
      });

      it('rejects tokens containing non-JSON header or payload', () => {
        const notJsonHeader = base64UrlEncode('<xml>Not JSON</xml>');
        const notJsonPayload = base64UrlEncode('SELECT * FROM users');
        const sig = 'dummySignatureBase64StringForTesting';

        assert.equal(tokenService.verifyToken(`${notJsonHeader}.${notJsonPayload}.${sig}`), null);
      });

      it('survives oversized token (>64KB) without crash or memory exhaustion', () => {
        const hugeString = 'a'.repeat(65536);
        const hugeToken = `header.${hugeString}.signature`;

        const start = Date.now();
        const verified = tokenService.verifyToken(hugeToken);
        const duration = Date.now() - start;

        assert.equal(verified, null);
        assert.ok(duration < 200, `Oversized token rejection took ${duration}ms, must be <200ms`);
      });
    });
  });

  // =========================================================================
  // SECTION 2: Multi-Clinic Auth Middleware & Tenant Isolation
  // =========================================================================
  describe('2. Multi-Clinic Auth Middleware & Tenant Boundaries', () => {
    let tokenService;
    let pediatricsToken;
    let cardiologyToken;

    beforeEach(() => {
      tokenService = new TokenService(); // Uses system sessionSecret
      pediatricsToken = tokenService.generateToken({ clinicId: 'pediatrics', role: 'staff' });
      cardiologyToken = tokenService.generateToken({ clinicId: 'cardiology', role: 'staff' });
    });

    describe('2.1 authenticateStaff Middleware', () => {
      it('returns 401 Unauthorized when Authorization header is missing', () => {
        const { req, res, next, isNextCalled } = createMockHttp({ headers: {} });

        authenticateStaff(req, res, next);

        assert.equal(res.statusCode, 401);
        assert.equal(isNextCalled(), false);
        assert.equal(res.responseBody.error, 'Unauthorized');
      });

      it('returns 401 Unauthorized for non-Bearer schemes (e.g. Basic, Digest)', () => {
        const nonBearer = ['Basic dXNlcjpwYXNz', 'Digest username="abc"', 'Token abcdef'];
        for (const authHeader of nonBearer) {
          const { req, res, next, isNextCalled } = createMockHttp({ headers: { authorization: authHeader } });

          authenticateStaff(req, res, next);

          assert.equal(res.statusCode, 401);
          assert.equal(isNextCalled(), false);
        }
      });

      it('returns 401 Unauthorized when Bearer token is empty or whitespace', () => {
        const emptyBearers = ['Bearer ', 'Bearer', 'Bearer    '];
        for (const authHeader of emptyBearers) {
          const { req, res, next, isNextCalled } = createMockHttp({ headers: { authorization: authHeader } });

          authenticateStaff(req, res, next);

          assert.equal(res.statusCode, 401);
          assert.equal(isNextCalled(), false);
        }
      });

      it('attaches req.auth and calls next() on valid Bearer token', () => {
        const { req, res, next, isNextCalled } = createMockHttp({
          headers: { authorization: `Bearer ${pediatricsToken}` }
        });

        authenticateStaff(req, res, next);

        assert.equal(res.statusCode, 200);
        assert.equal(isNextCalled(), true);
        assert.ok(req.auth);
        assert.equal(req.auth.clinicId, 'pediatrics');
      });
    });

    describe('2.2 authorizeClinic Multi-Tenant Boundary', () => {
      it('allows mutation when token clinicId matches target clinicId exactly', () => {
        const { req, res, next, isNextCalled } = createMockHttp({
          auth: { clinicId: 'pediatrics' },
          params: { clinicId: 'pediatrics' }
        });

        authorizeClinic(req, res, next);

        assert.equal(res.statusCode, 200);
        assert.equal(isNextCalled(), true);
      });

      it('allows mutation when target clinicId has different casing (normalized to lower)', () => {
        const { req, res, next, isNextCalled } = createMockHttp({
          auth: { clinicId: 'pediatrics' },
          params: { clinicId: 'PEDIATRICS' }
        });

        authorizeClinic(req, res, next);

        assert.equal(res.statusCode, 200);
        assert.equal(isNextCalled(), true);
      });

      it('returns 403 Forbidden when Pediatrics token attempts to mutate Cardiology', () => {
        const { req, res, next, isNextCalled } = createMockHttp({
          auth: { clinicId: 'pediatrics' },
          params: { clinicId: 'cardiology' }
        });

        authorizeClinic(req, res, next);

        assert.equal(res.statusCode, 403);
        assert.equal(isNextCalled(), false);
        assert.equal(res.responseBody.error, 'Forbidden');
      });

      it('returns 403 Forbidden across all cross-clinic combinations', () => {
        const clinics = ['pediatrics', 'cardiology', 'general', 'dental'];

        for (const clinicA of clinics) {
          for (const clinicB of clinics) {
            if (clinicA === clinicB) continue;

            const { req, res, next, isNextCalled } = createMockHttp({
              auth: { clinicId: clinicA },
              params: { clinicId: clinicB }
            });

            authorizeClinic(req, res, next);

            assert.equal(res.statusCode, 403, `Clinic ${clinicA} must NOT mutate ${clinicB}`);
            assert.equal(isNextCalled(), false);
          }
        }
      });

      it('returns 404 Not Found when target clinic does not exist in registry', () => {
        const { req, res, next, isNextCalled } = createMockHttp({
          auth: { clinicId: 'pediatrics' },
          params: { clinicId: 'radiology' }
        });

        authorizeClinic(req, res, next);

        assert.equal(res.statusCode, 404);
        assert.equal(isNextCalled(), false);
      });

      it('returns 400 Bad Request when target clinicId is omitted', () => {
        const { req, res, next, isNextCalled } = createMockHttp({
          auth: { clinicId: 'pediatrics' },
          params: {},
          body: {}
        });

        authorizeClinic(req, res, next);

        assert.equal(res.statusCode, 400);
        assert.equal(isNextCalled(), false);
      });
    });
  });

  // =========================================================================
  // SECTION 3: Persistence Stress & Atomic File Resilience
  // =========================================================================
  describe('3. Persistence Stress & Atomic File Resilience', () => {
    let testDir;
    let testFilePath;
    let adapter;

    beforeEach(async () => {
      testDir = path.resolve(`./tests/.adversarial_tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
      testFilePath = path.join(testDir, 'clinic_queues.json');
      adapter = new AtomicFileAdapter(testFilePath);
      await adapter.ensureDirectory();
    });

    afterEach(async () => {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {}
    });

    describe('3.1 High-Concurrency Single-Adapter Write Contention', () => {
      it('executes 50 simultaneous concurrent save operations without file corruption', async () => {
        const TOTAL_WRITES = 50;
        const promises = [];

        for (let i = 1; i <= TOTAL_WRITES; i++) {
          promises.push(adapter.save({
            version: 1,
            batchId: 'concurrency_test',
            counter: i,
            timestamp: new Date().toISOString()
          }));
        }

        // All 50 writes should resolve cleanly without uncaught rejections
        const results = await Promise.allSettled(promises);
        const rejected = results.filter(r => r.status === 'rejected');
        assert.equal(rejected.length, 0, `Expected 0 rejections, got: ${rejected.length}`);

        // Target file on disk must be readable and valid JSON
        const onDisk = await adapter.read();
        assert.ok(onDisk);
        assert.equal(onDisk.batchId, 'concurrency_test');
        assert.equal(onDisk.counter, TOTAL_WRITES, 'Final persisted state should reflect the last queued write');

        // Verify zero lingering .tmp files
        const dirFiles = await fs.readdir(testDir);
        const tmpFiles = dirFiles.filter(f => f.includes('.tmp.'));
        assert.equal(tmpFiles.length, 0, 'No orphaned .tmp files should exist');
      });
    });

    describe('3.2 Multi-Adapter Cross-Instance Contention Simulation', () => {
      it('survives 15 concurrent writes from 5 distinct adapter instances on the same file', async () => {
        const adapters = [
          new AtomicFileAdapter(testFilePath),
          new AtomicFileAdapter(testFilePath),
          new AtomicFileAdapter(testFilePath),
          new AtomicFileAdapter(testFilePath),
          new AtomicFileAdapter(testFilePath)
        ];

        const operations = [];
        for (let round = 0; round < 3; round++) {
          for (let a = 0; a < adapters.length; a++) {
            operations.push(adapters[a].save({
              round,
              adapterIndex: a,
              ts: Date.now()
            }));
          }
        }

        const settled = await Promise.allSettled(operations);
        const rejected = settled.filter(s => s.status === 'rejected');
        assert.equal(rejected.length, 0, `Cross-adapter contention caused ${rejected.length} rejections`);

        // Final state must parse cleanly as valid JSON
        const finalContent = await adapter.read();
        assert.ok(finalContent);
        assert.ok(typeof finalContent.round === 'number');

        // Check for temp file cleanup
        const files = await fs.readdir(testDir);
        const orphans = files.filter(f => f.includes('.tmp.'));
        assert.equal(orphans.length, 0, 'No orphaned temp files from multiple adapters');
      });
    });

    describe('3.3 Corrupt Storage Quarantine & Reseed Recovery', () => {
      it('quarantines truncated/half-written JSON and reseeds clean initial state', async () => {
        // Simulate sudden crash halfway through writing JSON
        await fs.writeFile(testFilePath, '{"version": 1, "clinics": { "pediatrics": { "curr', 'utf8');

        const state = await initializeClinicState(adapter, SEED_CLINICS);

        assert.ok(state.clinics.pediatrics);
        assert.equal(state.clinics.pediatrics.currentServing, 0);

        const files = await fs.readdir(testDir);
        const corruptBackups = files.filter(f => f.includes('.corrupt.'));
        assert.equal(corruptBackups.length, 1, 'Corrupted file must be moved to .corrupt.<timestamp>');
      });

      it('quarantines completely empty (0-byte) file and reseeds clean state', async () => {
        // Create 0-byte file (can occur on power loss before write flush)
        await fs.writeFile(testFilePath, '', 'utf8');

        const state = await initializeClinicState(adapter, SEED_CLINICS);

        assert.ok(state.clinics.pediatrics);
        assert.equal(state.clinics.pediatrics.currentServing, 0);

        const files = await fs.readdir(testDir);
        const corruptBackups = files.filter(f => f.includes('.corrupt.'));
        assert.equal(corruptBackups.length, 1, 'Empty file must be quarantined');
      });

      it('quarantines random binary garbage file and reseeds clean state', async () => {
        const randomBinary = crypto.randomBytes(512);
        await fs.writeFile(testFilePath, randomBinary);

        const state = await initializeClinicState(adapter, SEED_CLINICS);

        assert.ok(state.clinics.cardiology);
        assert.equal(state.clinics.cardiology.currentServing, 0);

        const files = await fs.readdir(testDir);
        const corruptBackups = files.filter(f => f.includes('.corrupt.'));
        assert.equal(corruptBackups.length, 1, 'Binary garbage must be quarantined');
      });
    });

    describe('3.4 Schema Healing & Boundary Sanitation', () => {
      it('heals negative currentServing on disk back to 0', async () => {
        const invalidState = {
          version: 1,
          clinics: {
            pediatrics: { currentServing: -99, status: 'In Clinic', skipped: [] }
          }
        };
        await fs.writeFile(testFilePath, JSON.stringify(invalidState), 'utf8');

        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        assert.equal(healed.clinics.pediatrics.currentServing, 0, 'Negative ticket count must be healed to 0');
      });

      it('heals invalid status string on disk back to "In Clinic"', async () => {
        const invalidState = {
          version: 1,
          clinics: {
            cardiology: { currentServing: 5, status: 'HackedStatusString', skipped: [] }
          }
        };
        await fs.writeFile(testFilePath, JSON.stringify(invalidState), 'utf8');

        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        assert.equal(healed.clinics.cardiology.status, 'In Clinic', 'Invalid status must heal to "In Clinic"');
        assert.equal(healed.clinics.cardiology.currentServing, 5, 'Valid currentServing preserved');
      });

      it('sanitizes skipped array containing negative values and non-integers', async () => {
        const dirtyState = {
          version: 1,
          clinics: {
            general: { currentServing: 10, status: 'In Clinic', skipped: [2, -4, 'abc', 7, null, 12] }
          }
        };
        await fs.writeFile(testFilePath, JSON.stringify(dirtyState), 'utf8');

        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        // Only positive integers >= 0 survive filter
        assert.deepEqual(healed.clinics.general.skipped, [2, 7, 12]);
      });

      it('tests whether on-disk skipped array with ticket 0 can be ingested by QueueModel without crash', async () => {
        const dirtyState = {
          version: 1,
          clinics: {
            general: { currentServing: 10, status: 'In Clinic', skipped: [0, 5] }
          }
        };
        await fs.writeFile(testFilePath, JSON.stringify(dirtyState), 'utf8');

        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        // Verify QueueModel can ingest the healed state without throwing DomainValidationError
        assert.doesNotThrow(() => {
          QueueModel.fromJSON(healed.clinics.general);
        }, 'QueueModel.fromJSON must accept healed state without throwing DomainValidationError');
      });

      it('tests whether on-disk unsafe integer currentServing (e.g. 1e30) can be ingested by QueueModel without crash', async () => {
        const dirtyState = {
          version: 1,
          clinics: {
            pediatrics: { currentServing: 1e30, status: 'In Clinic', skipped: [] }
          }
        };
        await fs.writeFile(testFilePath, JSON.stringify(dirtyState), 'utf8');

        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        assert.doesNotThrow(() => {
          QueueModel.fromJSON(healed.clinics.pediatrics);
        }, 'QueueModel.fromJSON must accept healed currentServing without throwing DomainValidationError');
      });
    });
  });

  // =========================================================================
  // SECTION 4: Queue Domain Model & State Machine Stress
  // =========================================================================
  describe('4. Queue Domain Model & State Machine Stress', () => {
    let model;

    beforeEach(() => {
      model = new QueueModel({ clinicId: 'pediatrics', name: 'Pediatrics' });
    });

    describe('4.1 Clamping & Boundary Guards', () => {
      it('strictly clamps recallPatient at 0 regardless of repeated calls', () => {
        for (let i = 0; i < 20; i++) {
          model.recallPatient();
          assert.equal(model.currentServing, 0);
        }
      });

      it('prevents skipPatient when queue counter is at 0', () => {
        assert.throws(() => {
          model.skipPatient();
        }, (err) => {
          return err instanceof DomainError && /counter is at 0/.test(err.message);
        });
        assert.equal(model.currentServing, 0);
        assert.deepEqual(model.skipped, []);
      });

      it('does not insert duplicate ticket numbers into skipped registry', () => {
        model.nextPatient(); // 1
        model.skipPatient(); // skips 1, advances to 2
        assert.deepEqual(model.skipped, [1]);

        // Manually attempt to re-add 1
        model.skipped.push(1);
        // QueueModel validateSkippedArray deduplicates
        const clean = QueueModel.validateSkippedArray([1, 1, 1, 2, 2, 3]);
        assert.deepEqual(clean, [1, 2, 3]);
      });

      it('strictly caps recentHistory audit log to the last 20 transitions', () => {
        for (let i = 0; i < 50; i++) {
          model.nextPatient();
        }
        assert.equal(model.currentServing, 50);
        assert.equal(model.recentHistory.length, 20, 'recentHistory must cap at 20 entries');
        assert.equal(model.recentHistory[19].newNumber, 50);
      });
    });

    describe('4.2 Reset Confirmation Safety Guard', () => {
      it('rejects resetQueue when called without confirmation flag', () => {
        model.nextPatient(); // 1
        model.nextPatient(); // 2

        const invalidOptions = [
          undefined,
          null,
          {},
          { confirm: false },
          { confirmReset: false },
          { confirm: 'yes' },
          { confirm: 1 }
        ];

        for (const opt of invalidOptions) {
          assert.throws(() => {
            model.resetQueue(opt);
          }, /Confirmation required/);
        }

        assert.equal(model.currentServing, 2, 'Counter must remain unchanged on rejected reset');
      });

      it('resets queue to 0 and clears skipped when confirm or confirmReset is true', () => {
        model.nextPatient(); // 1
        model.skipPatient(); // skips 1, serving 2
        model.setStatus('Brief Break');

        const resetResult = model.resetQueue({ confirm: true });
        assert.equal(resetResult.currentServing, 0);
        assert.deepEqual(resetResult.skipped, []);
        assert.equal(resetResult.status, 'In Clinic');
        assert.deepEqual(resetResult.recentHistory, []);
      });
    });

    describe('4.3 QueueStore Multi-Clinic Concurrent Operations', () => {
      let store;

      beforeEach(() => {
        store = new QueueStore();
        for (const clinic of SEED_CLINICS) {
          store.registerClinic(clinic);
        }
      });

      it('executes 100 concurrent operations across 4 clinics with perfect isolation', async () => {
        const operations = [];

        // Distribute operations across clinics
        for (let i = 0; i < 25; i++) {
          operations.push(store.nextPatient('pediatrics'));
          operations.push(store.nextPatient('cardiology'));
          operations.push(store.nextPatient('general'));
          operations.push(store.nextPatient('dental'));
        }

        await Promise.all(operations);

        assert.equal(store.getClinicState('pediatrics').currentServing, 25);
        assert.equal(store.getClinicState('cardiology').currentServing, 25);
        assert.equal(store.getClinicState('general').currentServing, 25);
        assert.equal(store.getClinicState('dental').currentServing, 25);
      });

      it('isolates subscriber notifications without cross-clinic event leakage', async () => {
        const events = {
          pediatrics: [],
          cardiology: [],
          general: [],
          dental: []
        };

        store.subscribe('pediatrics', (e) => events.pediatrics.push(e));
        store.subscribe('cardiology', (e) => events.cardiology.push(e));
        store.subscribe('general', (e) => events.general.push(e));
        store.subscribe('dental', (e) => events.dental.push(e));

        await store.nextPatient('pediatrics');
        await store.nextPatient('pediatrics');
        await store.nextPatient('cardiology');

        assert.equal(events.pediatrics.length, 2);
        assert.equal(events.cardiology.length, 1);
        assert.equal(events.general.length, 0, 'General must receive 0 events');
        assert.equal(events.dental.length, 0, 'Dental must receive 0 events');
      });

      it('rolls back in-memory state cleanly if persistence adapter throws error', async () => {
        const failingAdapter = {
          saveState: async () => {
            throw new Error('Disk write I/O hardware failure simulation');
          }
        };

        const storeWithFailingDisk = new QueueStore({ persistenceAdapter: failingAdapter });
        storeWithFailingDisk.registerClinic(SEED_CLINICS[0]); // pediatrics at 0

        assert.equal(storeWithFailingDisk.getClinicState('pediatrics').currentServing, 0);

        await assert.rejects(async () => {
          await storeWithFailingDisk.nextPatient('pediatrics');
        }, /Disk write I\/O hardware failure/);

        // State must be rolled back to 0
        assert.equal(
          storeWithFailingDisk.getClinicState('pediatrics').currentServing,
          0,
          'State must rollback to pre-mutation value when persistence fails'
        );
      });
    });
  });
});
