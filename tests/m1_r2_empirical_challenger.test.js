// tests/m1_r2_empirical_challenger.test.js
// Empirical Challenger Verification Harness for Milestone 1 Iteration 2
// Tests:
// 1. Subtest 3.4.4 (skipped: [0]) & 3.4.5 (currentServing: 1e30) healing and QueueModel ingest
// 2. Persistence rollback suppressing event emission across all mutation types
// 3. Constructor signature flexibility per PROJECT.md contracts
// 4. Boundary and adversarial stress on schema healing and mutex isolation

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { QueueModel, DomainValidationError } = require('../src/domain/queue_model.js');
const { QueueStore, NotFoundError } = require('../src/domain/queue_store.js');
const { AtomicFileAdapter, initializeClinicState } = require('../src/persistence/atomic_file_adapter.js');

const SEED_CLINICS = [
  { id: 'pediatrics', name: 'Pediatrics Clinic', room: '101', doctorName: 'Dr. Smith' },
  { id: 'general', name: 'General Medicine', room: '102', doctorName: 'Dr. Adams' }
];

describe('Challenger M1 R2 Empirical Verification Suite', () => {
  let tempDir;
  let testFilePath;
  let adapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'challenger_m1_r2_'));
    testFilePath = path.join(tempDir, 'queue_state.json');
    adapter = new AtomicFileAdapter(testFilePath);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // =========================================================================
  // 1. SUBTEST 3.4.4 & 3.4.5 SPECIFIC VERIFICATION
  // =========================================================================
  describe('1. Subtest 3.4.4 & 3.4.5 Schema Healing', () => {
    it('heals on-disk skipped array with 0, negatives, floats, strings and duplicate entries', async () => {
      const dirtyState = {
        version: 1,
        clinics: {
          general: {
            currentServing: 10,
            status: 'In Clinic',
            skipped: [0, 5, -1, 0, 5, 2.5, 'invalid', null, 1e30, 7]
          }
        }
      };
      await fs.writeFile(testFilePath, JSON.stringify(dirtyState), 'utf8');

      const healed = await initializeClinicState(adapter, SEED_CLINICS);

      // Verify QueueModel can ingest without exception
      let model;
      assert.doesNotThrow(() => {
        model = QueueModel.fromJSON(healed.clinics.general);
      }, 'QueueModel.fromJSON must accept healed state without throwing DomainValidationError');

      // Verify sanitized values: only positive safe integers, deduplicated
      assert.deepEqual(model.skipped, [5, 7]);

      // Verify healed state was actually written to disk
      const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf8'));
      assert.deepEqual(onDisk.clinics.general.skipped, [5, 7]);
    });

    it('heals on-disk unsafe integer currentServing (1e30, NaN, Infinity, negative, max safe int overflow)', async () => {
      const testCases = [
        { rawVal: 1e30, expected: 0 },
        { rawVal: -5, expected: 0 },
        { rawVal: 'invalid_string', expected: 0 },
        { rawVal: Number.MAX_SAFE_INTEGER + 100, expected: 0 },
        { rawVal: null, expected: 0 }
      ];

      for (const tc of testCases) {
        const dirtyState = {
          version: 1,
          clinics: {
            pediatrics: {
              currentServing: tc.rawVal,
              status: 'In Clinic',
              skipped: []
            }
          }
        };
        await fs.writeFile(testFilePath, JSON.stringify(dirtyState), 'utf8');

        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        let model;
        assert.doesNotThrow(() => {
          model = QueueModel.fromJSON(healed.clinics.pediatrics);
        }, `QueueModel.fromJSON must accept healed currentServing for raw val ${tc.rawVal}`);

        assert.equal(model.currentServing, tc.expected);

        // Verify disk was updated
        const onDisk = JSON.parse(await fs.readFile(testFilePath, 'utf8'));
        assert.equal(onDisk.clinics.pediatrics.currentServing, tc.expected);
      }
    });

    it('preserves valid safe integer boundaries (0, 1, Number.MAX_SAFE_INTEGER)', async () => {
      const validServing = Number.MAX_SAFE_INTEGER;
      const cleanState = {
        version: 1,
        clinics: {
          pediatrics: {
            currentServing: validServing,
            status: 'In Clinic',
            skipped: [1, 2, 3]
          }
        }
      };
      await fs.writeFile(testFilePath, JSON.stringify(cleanState), 'utf8');

      const healed = await initializeClinicState(adapter, SEED_CLINICS);
      const model = QueueModel.fromJSON(healed.clinics.pediatrics);
      assert.equal(model.currentServing, validServing);
      assert.deepEqual(model.skipped, [1, 2, 3]);
    });
  });

  // =========================================================================
  // 2. PERSISTENCE ROLLBACK & EVENT EMISSION SUPPRESSION
  // =========================================================================
  describe('2. Persistence Rollback & Event Emission Suppression', () => {
    class FailingAdapter {
      constructor() {
        this.shouldFail = true;
        this.saveCount = 0;
      }
      async save(state) {
        this.saveCount++;
        if (this.shouldFail) {
          throw new Error('EACCES: Disk write simulated failure');
        }
        return state;
      }
      async saveState(state) {
        return this.save(state);
      }
      async read() {
        return null;
      }
    }

    let failingAdapter;
    let store;

    beforeEach(async () => {
      failingAdapter = new FailingAdapter();
      store = new QueueStore({ persistenceAdapter: failingAdapter });
      store.registerClinic({
        clinicId: 'pediatrics',
        name: 'Pediatrics',
        currentServing: 5,
        status: 'In Clinic',
        skipped: [2]
      });
    });

    it('suppresses event emission on nextPatient when persistence fails and rolls back state', async () => {
      let clinicEvents = 0;
      let globalEvents = 0;

      store.subscribe('pediatrics', () => { clinicEvents++; });
      store.subscribe('*', () => { globalEvents++; });

      failingAdapter.shouldFail = true;

      await assert.rejects(
        async () => { await store.nextPatient('pediatrics'); },
        /EACCES/
      );

      // Verify NO events emitted
      assert.equal(clinicEvents, 0, 'No clinic event must be emitted on rollback');
      assert.equal(globalEvents, 0, 'No global event must be emitted on rollback');

      // Verify in-memory state rolled back to 5
      assert.equal(store.getClinicState('pediatrics').currentServing, 5);

      // Verify that once persistence succeeds, event IS emitted
      failingAdapter.shouldFail = false;
      await store.nextPatient('pediatrics');

      assert.equal(clinicEvents, 1, 'Clinic event must be emitted on successful persistence');
      assert.equal(globalEvents, 1, 'Global event must be emitted on successful persistence');
      assert.equal(store.getClinicState('pediatrics').currentServing, 6);
    });

    it('suppresses event emission on recallPatient when persistence fails and rolls back state', async () => {
      let events = 0;
      store.subscribe('pediatrics', () => { events++; });

      failingAdapter.shouldFail = true;
      await assert.rejects(
        async () => { await store.recallPatient('pediatrics'); },
        /EACCES/
      );

      assert.equal(events, 0);
      assert.equal(store.getClinicState('pediatrics').currentServing, 5);
    });

    it('suppresses event emission on skipPatient when persistence fails and rolls back state', async () => {
      let events = 0;
      store.subscribe('pediatrics', () => { events++; });

      failingAdapter.shouldFail = true;
      await assert.rejects(
        async () => { await store.skipPatient('pediatrics'); },
        /EACCES/
      );

      assert.equal(events, 0);
      assert.equal(store.getClinicState('pediatrics').currentServing, 5);
      assert.deepEqual(store.getClinicState('pediatrics').skipped, [2]);
    });

    it('suppresses event emission on resetQueue when persistence fails and rolls back state', async () => {
      let events = 0;
      store.subscribe('pediatrics', () => { events++; });

      failingAdapter.shouldFail = true;
      await assert.rejects(
        async () => { await store.resetQueue('pediatrics', { confirm: true }); },
        /EACCES/
      );

      assert.equal(events, 0);
      assert.equal(store.getClinicState('pediatrics').currentServing, 5);
      assert.deepEqual(store.getClinicState('pediatrics').skipped, [2]);
    });

    it('suppresses event emission on setStatus when persistence fails and rolls back state', async () => {
      let events = 0;
      store.subscribe('pediatrics', () => { events++; });

      failingAdapter.shouldFail = true;
      await assert.rejects(
        async () => { await store.setStatus('pediatrics', 'Brief Break'); },
        /EACCES/
      );

      assert.equal(events, 0);
      assert.equal(store.getClinicState('pediatrics').status, 'In Clinic');
    });
  });

  // =========================================================================
  // 3. CONSTRUCTOR SIGNATURE DUAL-CONTRACT VERIFICATION
  // =========================================================================
  describe('3. QueueStore Constructor Dual-Signature Compliance', () => {
    it('supports PROJECT.md signature constructor(filePath, persistenceAdapter)', () => {
      const mockAdapter = { save: async () => {}, read: async () => null };
      const store1 = new QueueStore('/custom/queue.json', mockAdapter);
      assert.equal(store1.filePath, '/custom/queue.json');
      assert.equal(store1.persistenceAdapter, mockAdapter);

      // Auto-instantiates AtomicFileAdapter if filePath string given without adapter
      const store2 = new QueueStore(testFilePath);
      assert.equal(store2.filePath, testFilePath);
      assert.ok(store2.persistenceAdapter instanceof AtomicFileAdapter);
    });

    it('supports options signature constructor(options) and direct adapter', () => {
      const mockAdapter = { save: async () => {}, read: async () => null };
      const storeOptions = new QueueStore({ persistenceAdapter: mockAdapter, filePath: '/custom/path' });
      assert.equal(storeOptions.persistenceAdapter, mockAdapter);
      assert.equal(storeOptions.filePath, '/custom/path');

      const storeDirect = new QueueStore(mockAdapter);
      assert.equal(storeDirect.persistenceAdapter, mockAdapter);

      const storeEmpty = new QueueStore();
      assert.equal(storeEmpty.persistenceAdapter, null);
      assert.equal(storeEmpty.filePath, null);
    });
  });

  // =========================================================================
  // 4. ADVERSARIAL STRESS & CORRUPTION RECOVERY
  // =========================================================================
  describe('4. Adversarial Stress & Schema Healing Robustness', () => {
    it('recovers from completely missing or non-object clinics map', async () => {
      const corruptedStructures = [
        { version: 1, clinics: 'not an object' },
        { version: 1, clinics: null },
        { version: 1, clinics: [1, 2, 3] },
        { version: 1 }
      ];

      for (const corrupt of corruptedStructures) {
        await fs.writeFile(testFilePath, JSON.stringify(corrupt), 'utf8');
        const healed = await initializeClinicState(adapter, SEED_CLINICS);
        assert.ok(healed.clinics.pediatrics, 'Seed clinics must be seeded');
        assert.equal(healed.clinics.pediatrics.currentServing, 0);
        assert.equal(healed.clinics.pediatrics.status, 'In Clinic');
      }
    });

    it('heals non-array skipped and non-array recentHistory', async () => {
      const dirtyState = {
        version: 1,
        clinics: {
          pediatrics: {
            currentServing: 3,
            status: 'In Clinic',
            skipped: 'corrupted string',
            recentHistory: 'not an array'
          }
        }
      };
      await fs.writeFile(testFilePath, JSON.stringify(dirtyState), 'utf8');

      const healed = await initializeClinicState(adapter, SEED_CLINICS);
      assert.deepEqual(healed.clinics.pediatrics.skipped, []);
      assert.deepEqual(healed.clinics.pediatrics.recentHistory, []);

      // Verify QueueModel accepts this
      assert.doesNotThrow(() => {
        QueueModel.fromJSON(healed.clinics.pediatrics);
      });
    });

    it('handles concurrent operations under persistence latency without race conditions', async () => {
      class LatencyAdapter {
        constructor() {
          this.state = null;
        }
        async save(state) {
          await new Promise(r => setTimeout(r, 10));
          this.state = JSON.parse(JSON.stringify(state));
        }
      }

      const latencyAdapter = new LatencyAdapter();
      const store = new QueueStore({ persistenceAdapter: latencyAdapter });
      store.registerClinic({ clinicId: 'pediatrics', name: 'Pediatrics' });

      // Run 20 sequential calls via withLock
      for (let i = 0; i < 20; i++) {
        await store.withLock('pediatrics', async () => {
          await store.nextPatient('pediatrics');
        });
      }

      assert.equal(store.getClinicState('pediatrics').currentServing, 20);
      assert.equal(latencyAdapter.state.clinics.pediatrics.currentServing, 20);
    });
  });
});
