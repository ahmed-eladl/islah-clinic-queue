/**
 * tests/m1_domain_auth_persistence.test.js
 * Comprehensive unit test suite for Milestone 1 (F01, F02, F03, F04, F05, F06).
 * Execution: node --test tests/m1_domain_auth_persistence.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// --- Imports from src/ ---
const { QueueModel } = require('../src/domain/queue_model.js');
const { QueueStore } = require('../src/domain/queue_store.js');
const { TokenService } = require('../src/auth/token_service.js');
const { AtomicFileAdapter, initializeClinicState } = require('../src/persistence/atomic_file_adapter.js');

// Seed clinic definitions for testing
const SEED_CLINICS = [
  { id: 'pediatrics', name: 'Pediatrics Clinic', room: 'Room 101', doctorName: 'Dr. Sarah Jenkins' },
  { id: 'cardiology', name: 'Cardiology Clinic', room: 'Room 204', doctorName: 'Dr. Marcus Vance' },
  { id: 'general', name: 'General Practice', room: 'Room 102', doctorName: 'Dr. Elena Rostova' },
  { id: 'dental', name: 'Dental Clinic', room: 'Room 305', doctorName: 'Dr. David Chen' }
];

const TEST_SECRET = 'test_jwt_hmac_secret_key_32_characters_long_for_security';

describe('Milestone 1: Domain, Auth & Persistence Unit Tests', () => {

  // =========================================================================
  // SUITE 1: QueueModel State Machine (F05)
  // =========================================================================
  describe('1. QueueModel State Machine (F05)', () => {
    let model;

    beforeEach(() => {
      model = new QueueModel({
        clinicId: 'pediatrics',
        name: 'Pediatrics Clinic',
        room: 'Room 101',
        doctorName: 'Dr. Jenkins',
        currentServing: 0,
        status: 'In Clinic',
        skipped: []
      });
    });

    it('should initialize with default state and clamps', () => {
      const state = model.getState();
      assert.equal(state.clinicId, 'pediatrics');
      assert.equal(state.currentServing, 0);
      assert.equal(state.status, 'In Clinic');
      assert.deepEqual(state.skipped, []);
    });

    it('should advance patient with nextPatient (+1)', () => {
      const s1 = model.nextPatient();
      assert.equal(s1.currentServing, 1);
      const s2 = model.nextPatient();
      assert.equal(s2.currentServing, 2);
    });

    it('should auto-resume status to "In Clinic" on nextPatient if paused', () => {
      model.setStatus('Brief Break');
      assert.equal(model.getState().status, 'Brief Break');
      const updated = model.nextPatient();
      assert.equal(updated.currentServing, 1);
      assert.equal(updated.status, 'In Clinic');
    });

    it('should decrement with recallPatient (-1) and floor-clamp at 0 (never negative)', () => {
      model.nextPatient(); // 1
      model.nextPatient(); // 2
      const recalled = model.recallPatient();
      assert.equal(recalled.currentServing, 1);
      model.recallPatient(); // 0
      assert.equal(model.getState().currentServing, 0);
      const clamped = model.recallPatient(); // floor clamp at 0
      assert.equal(clamped.currentServing, 0);
    });

    it('should track skipped patients in skipped registry array', () => {
      model.nextPatient(); // 1
      const state = model.skipPatient(); // skips 1, advances to 2
      assert.equal(state.currentServing, 2);
      assert.deepEqual(state.skipped, [1]);

      model.skipPatient(); // skips 2, advances to 3
      assert.equal(model.getState().currentServing, 3);
      assert.deepEqual(model.getState().skipped, [1, 2]);
    });

    it('should reject resetQueue if confirmReset flag is missing or false', () => {
      model.nextPatient();
      assert.throws(() => {
        model.resetQueue({ confirmReset: false });
      }, /Confirmation required/);
      assert.equal(model.getState().currentServing, 1);
    });

    it('should reset queue to 0 and clear skipped array on confirmed reset', () => {
      model.nextPatient();
      model.skipPatient();
      assert.equal(model.getState().currentServing, 2);
      assert.equal(model.getState().skipped.length, 1);

      const resetState = model.resetQueue({ confirmReset: true });
      assert.equal(resetState.currentServing, 0);
      assert.deepEqual(resetState.skipped, []);
      assert.equal(resetState.status, 'In Clinic');
    });

    it('should update status between allowed values and reject invalid', () => {
      model.setStatus('Brief Break');
      assert.equal(model.getState().status, 'Brief Break');

      model.setStatus('Finished');
      assert.equal(model.getState().status, 'Finished');

      model.setStatus('In Clinic');
      assert.equal(model.getState().status, 'In Clinic');

      assert.throws(() => {
        model.setStatus('On Vacation');
      }, /Invalid status/);
    });
  });

  // =========================================================================
  // SUITE 2: Multi-Clinic Isolation & QueueStore (F04)
  // =========================================================================
  describe('2. Multi-Clinic Isolation (F04)', () => {
    let store;

    beforeEach(() => {
      store = new QueueStore();
      for (const clinic of SEED_CLINICS) {
        store.registerClinic(clinic);
      }
    });

    it('should maintain independent queue state across all 4 clinics', () => {
      store.nextPatient('pediatrics');
      store.nextPatient('pediatrics');

      assert.equal(store.getClinicState('pediatrics').currentServing, 2);
      assert.equal(store.getClinicState('cardiology').currentServing, 0);
      assert.equal(store.getClinicState('general').currentServing, 0);
      assert.equal(store.getClinicState('dental').currentServing, 0);
    });

    it('should keep skip lists isolated per clinic', () => {
      store.nextPatient('cardiology'); // 1
      store.skipPatient('cardiology');  // skips 1, advances to 2

      assert.deepEqual(store.getClinicState('cardiology').skipped, [1]);
      assert.deepEqual(store.getClinicState('pediatrics').skipped, []);
    });

    it('should isolate queue reset to target clinic only', () => {
      store.nextPatient('pediatrics');
      store.nextPatient('cardiology');

      store.resetQueue('cardiology', { confirmReset: true });

      assert.equal(store.getClinicState('cardiology').currentServing, 0);
      assert.equal(store.getClinicState('pediatrics').currentServing, 1);
    });

    it('should route event subscriptions strictly to the target clinic channel', () => {
      const pediaEvents = [];
      const cardioEvents = [];

      store.subscribe('pediatrics', (event) => pediaEvents.push(event));
      store.subscribe('cardiology', (event) => cardioEvents.push(event));

      store.nextPatient('pediatrics');

      assert.equal(pediaEvents.length, 1);
      assert.equal(pediaEvents[0].clinicId, 'pediatrics');
      assert.equal(cardioEvents.length, 0); // Zero cross-talk
    });

    it('should throw error when operating on unknown clinicId', () => {
      assert.throws(() => {
        store.getClinicState('radiology');
      }, /Clinic not found/);
    });
  });

  // =========================================================================
  // SUITE 3: Token Service & Cryptographic Verification (F02, F03)
  // =========================================================================
  describe('3. Token Service & Cryptographic Verification (F02, F03)', () => {
    let tokenService;

    beforeEach(() => {
      tokenService = new TokenService(TEST_SECRET);
    });

    it('should generate a 3-part base64url signed HMAC token', () => {
      const token = tokenService.generateToken({ clinicId: 'pediatrics', role: 'staff' });
      assert.equal(typeof token, 'string');
      const parts = token.split('.');
      assert.equal(parts.length, 3);
    });

    it('should verify a valid token and return payload claims', () => {
      const token = tokenService.generateToken({ clinicId: 'cardiology', role: 'staff' });
      const decoded = tokenService.verifyToken(token);
      assert.ok(decoded);
      assert.equal(decoded.clinicId, 'cardiology');
      assert.equal(decoded.role, 'staff');
    });

    it('should reject an expired token', () => {
      const token = tokenService.generateToken(
        { clinicId: 'general', role: 'staff' },
        { expiresInSeconds: -10 } // Expired 10 seconds ago
      );
      const decoded = tokenService.verifyToken(token);
      assert.equal(decoded, null);
    });

    it('should reject token with tampered payload', () => {
      const token = tokenService.generateToken({ clinicId: 'pediatrics', role: 'staff' });
      const [header, payload, signature] = token.split('.');

      // Tamper payload: replace pediatrics with cardiology
      const rawPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      rawPayload.clinicId = 'cardiology';
      const tamperedPayload = Buffer.from(JSON.stringify(rawPayload)).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

      const decoded = tokenService.verifyToken(tamperedToken);
      assert.equal(decoded, null); // Signature mismatch
    });

    it('should reject token with tampered signature', () => {
      const token = tokenService.generateToken({ clinicId: 'dental', role: 'staff' });
      const [header, payload, signature] = token.split('.');
      const alteredSig = signature.slice(0, -2) + 'aa';
      const tamperedToken = `${header}.${payload}.${alteredSig}`;

      const decoded = tokenService.verifyToken(tamperedToken);
      assert.equal(decoded, null);
    });

    it('should reject token signed with a different secret', () => {
      const foreignService = new TokenService('foreign_secret_key_different_from_test_secret_123');
      const token = foreignService.generateToken({ clinicId: 'pediatrics', role: 'staff' });

      const decoded = tokenService.verifyToken(token);
      assert.equal(decoded, null);
    });

    it('should reject algorithm substitution tampering (e.g. "alg": "none")', () => {
      const fakeHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ clinicId: 'pediatrics', exp: Date.now() + 10000 })).toString('base64url');
      const attackToken = `${fakeHeader}.${payload}.`;

      const decoded = tokenService.verifyToken(attackToken);
      assert.equal(decoded, null);
    });

    it('should safely reject malformed, empty, or non-string tokens', () => {
      assert.equal(tokenService.verifyToken(''), null);
      assert.equal(tokenService.verifyToken(null), null);
      assert.equal(tokenService.verifyToken('invalid.token'), null);
      assert.equal(tokenService.verifyToken('part1.part2.part3.part4'), null);
    });
  });

  // =========================================================================
  // SUITE 4: Atomic Persistence & Crash Recovery (F06)
  // =========================================================================
  describe('4. Atomic Persistence & Crash Recovery (F06)', () => {
    let testDir;
    let testFilePath;
    let adapter;

    beforeEach(async () => {
      testDir = path.resolve(`./tests/.tmp_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
      testFilePath = path.join(testDir, 'nested', 'clinic_queues.json');
      adapter = new AtomicFileAdapter(testFilePath);
    });

    afterEach(async () => {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should automatically create target directories recursively', async () => {
      const dummyState = { version: 1, test: true };
      await adapter.save(dummyState);

      const exists = await adapter.exists();
      assert.equal(exists, true);
    });

    it('should perform atomic write and read roundtrip without corruption', async () => {
      const testState = {
        version: 1,
        clinics: {
          pediatrics: { currentServing: 42, status: 'In Clinic', skipped: [3, 7] }
        }
      };

      await adapter.save(testState);
      const loaded = await adapter.read();

      assert.deepEqual(loaded, testState);
    });

    it('should persist state across distinct adapter instances (reload simulation)', async () => {
      const testState = { version: 1, token: 'persisted_marker_abc' };
      await adapter.save(testState);

      // Fresh adapter simulating server reboot
      const rebootedAdapter = new AtomicFileAdapter(testFilePath);
      const reloaded = await rebootedAdapter.read();

      assert.deepEqual(reloaded, testState);
    });

    it('should not leave orphaned .tmp files in storage directory', async () => {
      await adapter.save({ version: 1, count: 1 });
      await adapter.save({ version: 1, count: 2 });

      const files = await fs.readdir(path.dirname(testFilePath));
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      assert.equal(tmpFiles.length, 0, 'No orphaned .tmp files should remain');
    });

    it('should handle rapid concurrent writes cleanly via queue serialization', async () => {
      const writes = [];
      for (let i = 1; i <= 25; i++) {
        writes.push(adapter.save({ version: 1, counter: i }));
      }
      await Promise.all(writes);

      const finalState = await adapter.read();
      assert.equal(finalState.counter, 25);
    });

    it('should cold-start seed file if it does not exist', async () => {
      const state = await initializeClinicState(adapter, SEED_CLINICS);

      assert.ok(state.clinics.pediatrics);
      assert.ok(state.clinics.cardiology);
      assert.equal(state.clinics.pediatrics.currentServing, 0);

      const onDisk = await adapter.read();
      assert.deepEqual(onDisk, state);
    });

    it('should quarantine corrupted JSON file and reseed cleanly without crash', async () => {
      await adapter.ensureDirectory();
      // Write intentionally truncated corrupted JSON
      await fs.writeFile(testFilePath, '{"clinics": {"pediatrics": { "current', 'utf8');

      const restoredState = await initializeClinicState(adapter, SEED_CLINICS);

      assert.ok(restoredState.clinics.pediatrics);
      assert.equal(restoredState.clinics.pediatrics.currentServing, 0);

      // Verify corrupted file was quarantined
      const files = await fs.readdir(path.dirname(testFilePath));
      const quarantined = files.filter((f) => f.includes('.corrupt.'));
      assert.equal(quarantined.length, 1, 'Corrupted file must be quarantined with timestamp');
    });

    it('should gracefully add newly configured seed clinic to existing on-disk state', async () => {
      // Seed initial state with 2 clinics
      const initialClinics = [SEED_CLINICS[0], SEED_CLINICS[1]];
      await initializeClinicState(adapter, initialClinics);

      // Warm boot with 4 clinics (adding general and dental)
      const updatedState = await initializeClinicState(adapter, SEED_CLINICS);

      assert.ok(updatedState.clinics.pediatrics);
      assert.ok(updatedState.clinics.cardiology);
      assert.ok(updatedState.clinics.general);
      assert.ok(updatedState.clinics.dental);
      assert.equal(updatedState.clinics.general.currentServing, 0);
    });
  });
});
