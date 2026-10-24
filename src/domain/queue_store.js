/**
 * @file queue_store.js
 * Multi-Clinic Queue State Aggregate Store & Event Pub/Sub Registry.
 */

const { QueueModel, DomainError, DomainValidationError } = require('./queue_model.js');

let AtomicFileAdapter;
try {
  ({ AtomicFileAdapter } = require('../persistence/atomic_file_adapter.js'));
} catch {
  // Graceful fallback for standalone or mocked test environments
}

class NotFoundError extends DomainError {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

class QueueStore {
  /**
   * Constructs a new QueueStore.
   * Supports:
   * 1. PROJECT.md Interface Contract: constructor(filePath, persistenceAdapter)
   * 2. Options Object & Direct Adapter: constructor(options = {}) / constructor(adapter)
   *
   * @param {string|Object} [filePathOrOptions={}] - Target storage path, configuration options, or adapter
   * @param {Object} [maybeAdapter=null] - Optional persistence adapter or adapter options when first arg is filePath
   */
  constructor(filePathOrOptions = {}, maybeAdapter = null) {
    let resolvedFilePath = null;
    let resolvedAdapter = null;

    if (typeof filePathOrOptions === 'string') {
      // Signature 1: constructor(filePath, [persistenceAdapter])
      resolvedFilePath = filePathOrOptions;

      if (maybeAdapter && (typeof maybeAdapter.save === 'function' || typeof maybeAdapter.saveState === 'function')) {
        resolvedAdapter = maybeAdapter;
      } else if (maybeAdapter && typeof maybeAdapter === 'object' && maybeAdapter.persistenceAdapter) {
        resolvedAdapter = maybeAdapter.persistenceAdapter;
      } else if (AtomicFileAdapter) {
        const adapterOptions = (maybeAdapter && typeof maybeAdapter === 'object') ? maybeAdapter : {};
        resolvedAdapter = new AtomicFileAdapter(resolvedFilePath, adapterOptions);
      }
    } else if (filePathOrOptions && (typeof filePathOrOptions.save === 'function' || typeof filePathOrOptions.saveState === 'function')) {
      // Direct adapter instance: constructor(adapter)
      resolvedAdapter = filePathOrOptions;
      resolvedFilePath = filePathOrOptions.filePath || null;
    } else if (filePathOrOptions && typeof filePathOrOptions === 'object') {
      // Signature 2: constructor(options = {})
      resolvedFilePath = filePathOrOptions.filePath || null;

      if (filePathOrOptions.persistenceAdapter) {
        resolvedAdapter = filePathOrOptions.persistenceAdapter;
      } else if (resolvedFilePath && AtomicFileAdapter) {
        resolvedAdapter = new AtomicFileAdapter(resolvedFilePath, filePathOrOptions.adapterOptions || {});
      }
    }

    this.filePath = resolvedFilePath;
    this.persistenceAdapter = resolvedAdapter;

    this.clinics = new Map(); // Map<string, QueueModel>
    this.subscribers = new Map(); // Map<string, Set<Function>>
    this.globalSubscribers = new Set(); // Set<Function>
    this.mutexChains = new Map(); // Map<string, Promise<void>>
  }

  /**
   * Register a new clinic or update existing registration
   * @param {Object} clinic - Clinic metadata or config
   * @returns {QueueModel}
   */
  registerClinic(clinic) {
    if (!clinic) return null;
    const clinicId = clinic.id || clinic.clinicId;
    const model = new QueueModel({
      clinicId,
      name: clinic.name,
      room: clinic.room,
      doctorName: clinic.doctorName,
      currentServing: clinic.currentServing || 0,
      status: clinic.status || 'In Clinic',
      skipped: clinic.skipped || [],
      averageServiceMinutes: clinic.averageServiceMinutes
    });
    this.clinics.set(model.clinicId, model);
    return model;
  }

  /**
   * Initialize the store with existing persisted state or seed configurations
   * @param {Array<Object>} [seedClinics=[]] - Pre-configured clinic definitions
   */
  async init(seedClinics = []) {
    let loadedState = null;

    if (this.persistenceAdapter) {
      try {
        if (typeof this.persistenceAdapter.loadState === 'function') {
          loadedState = await this.persistenceAdapter.loadState();
        } else if (typeof this.persistenceAdapter.read === 'function') {
          loadedState = await this.persistenceAdapter.read();
        }
      } catch (err) {
        console.warn('[QueueStore] Persistence load failed or file empty, falling back to seed:', err.message);
      }
    }

    if (loadedState && loadedState.clinics) {
      this.importSnapshot(loadedState);

      // Reconcile any newly configured seed clinics that are missing from disk
      if (Array.isArray(seedClinics) && seedClinics.length > 0) {
        let hasNewClinics = false;
        for (const seed of seedClinics) {
          const clinicId = seed.id || seed.clinicId;
          if (clinicId && !this.clinics.has(clinicId)) {
            this.registerClinic(seed);
            hasNewClinics = true;
          }
        }
        if (hasNewClinics) {
          await this.persist();
        }
      }
    } else if (Array.isArray(seedClinics) && seedClinics.length > 0) {
      for (const seed of seedClinics) {
        this.registerClinic(seed);
      }
      await this.persist();
    }
  }

  /**
   * Run an asynchronous operation with exclusive per-clinic locking.
   * Operations on different clinics execute concurrently without blocking.
   */
  async withLock(clinicId, task) {
    const currentPromise = this.mutexChains.get(clinicId) || Promise.resolve();
    let release;
    const nextPromise = new Promise(resolve => { release = resolve; });
    this.mutexChains.set(clinicId, currentPromise.then(() => nextPromise));

    await currentPromise;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Retrieve state for a specific clinic
   * @param {string} clinicId
   * @returns {Object} Immutable clinic state snapshot
   */
  getClinicState(clinicId) {
    const clinic = this.clinics.get(clinicId);
    if (!clinic) {
      throw new NotFoundError(`Clinic not found: '${clinicId}'`);
    }
    return clinic.toJSON();
  }

  /**
   * Retrieve summary snapshots for all configured clinics
   * @returns {Array<Object>}
   */
  getAllClinics() {
    return Array.from(this.clinics.values()).map(c => c.toJSON());
  }

  /**
   * Check if clinic exists in store
   */
  hasClinic(clinicId) {
    return this.clinics.has(clinicId);
  }

  /**
   * Refreshes the in-memory store from persistence adapter if cloud persistence is active
   */
  async syncCloud(force = false) {
    if (this.persistenceAdapter && this.persistenceAdapter.isCloud) {
      try {
        const fresh = typeof this.persistenceAdapter.loadState === 'function'
          ? await this.persistenceAdapter.loadState(force)
          : await this.persistenceAdapter.read();
        if (fresh && fresh.clinics) {
          this.importSnapshot(fresh);
        }
      } catch (err) {
        console.warn('[QueueStore] syncCloud error:', err.message);
      }
    }
  }

  /**
   * Core mutation executor with rollback and persistence coordination
   */
  async mutateClinic(clinicId, actionName, mutator) {
    if (this.persistenceAdapter && this.persistenceAdapter.isCloud) {
      await this.syncCloud(true);
    }

    const clinic = this.clinics.get(clinicId);
    if (!clinic) {
      throw new NotFoundError(`Clinic not found: '${clinicId}'`);
    }

    // Capture state before mutation for rollback safety
    const previousState = clinic.toJSON();

    let updatedState;
    try {
      // 1. Execute domain logic (synchronously applied to in-memory model)
      updatedState = mutator(clinic);
    } catch (err) {
      const restored = QueueModel.fromJSON(previousState);
      this.clinics.set(clinicId, restored);
      throw err;
    }

    // 2. Persist state if adapter configured (with rollback on persistence failure)
    if (this.persistenceAdapter) {
      try {
        await this.persist();
      } catch (err) {
        const restored = QueueModel.fromJSON(previousState);
        this.clinics.set(clinicId, restored);
        throw err;
      }
    }

    // 3. Emit real-time update event ONLY after successful mutation & persistence
    this.emit(clinicId, {
      type: 'QUEUE_UPDATE',
      action: actionName,
      clinicId,
      currentServing: updatedState.currentServing,
      status: updatedState.status,
      skipped: [...updatedState.skipped],
      timestamp: updatedState.lastUpdated
    });

    return updatedState;
  }

  /**
   * Advance to next patient (+1)
   */
  nextPatient(clinicId) {
    return this.mutateClinic(clinicId, 'NEXT', clinic => clinic.nextPatient());
  }

  /**
   * Recall previous patient (-1), floor-clamped at 0
   */
  recallPatient(clinicId) {
    return this.mutateClinic(clinicId, 'RECALL', clinic => clinic.recallPatient());
  }

  /**
   * Skip current patient (+1, recorded in skipped)
   */
  skipPatient(clinicId) {
    return this.mutateClinic(clinicId, 'SKIP', clinic => clinic.skipPatient());
  }

  /**
   * Reset queue counter to 0 (requires { confirm: true } or { confirmReset: true })
   */
  resetQueue(clinicId, options = {}) {
    return this.mutateClinic(clinicId, 'RESET', clinic => clinic.resetQueue(options));
  }

  /**
   * Update doctor consultation status ('In Clinic', 'Brief Break', 'Finished')
   */
  setStatus(clinicId, status) {
    return this.mutateClinic(clinicId, 'SET_STATUS', clinic => clinic.setStatus(status));
  }

  /**
   * Pub/Sub Event Subscription
   * @param {string} clinicId - Clinic ID or '*' for wildcard
   * @param {Function} callback - Listener receiving event object
   * @returns {Function} Unsubscribe closure
   */
  subscribe(clinicId, callback) {
    if (typeof callback !== 'function') {
      throw new DomainValidationError('Subscription callback must be a function');
    }

    if (clinicId === '*') {
      this.globalSubscribers.add(callback);
      return () => this.unsubscribe('*', callback);
    }

    if (!this.subscribers.has(clinicId)) {
      this.subscribers.set(clinicId, new Set());
    }
    this.subscribers.get(clinicId).add(callback);

    return () => this.unsubscribe(clinicId, callback);
  }

  /**
   * Pub/Sub Unsubscribe
   */
  unsubscribe(clinicId, callback) {
    if (clinicId === '*') {
      return this.globalSubscribers.delete(callback);
    }

    const set = this.subscribers.get(clinicId);
    if (!set) return false;

    const removed = set.delete(callback);
    if (set.size === 0) {
      this.subscribers.delete(clinicId); // Prevent memory leaks
    }
    return removed;
  }

  /**
   * Emit event to clinic-specific and global subscribers with error isolation
   */
  emit(clinicId, event) {
    const targets = [];

    const clinicSet = this.subscribers.get(clinicId);
    if (clinicSet) {
      for (const cb of clinicSet) targets.push(cb);
    }

    for (const cb of this.globalSubscribers) {
      targets.push(cb);
    }

    for (const callback of targets) {
      try {
        callback(event);
      } catch (err) {
        console.error(`[QueueStore PubSub Error] Subscriber failed for clinic '${clinicId}':`, err);
      }
    }
  }

  /**
   * Remove clinic from store
   * @param {string} clinicId 
   */
  removeClinic(clinicId) {
    if (!clinicId) return false;
    const id = clinicId.toLowerCase().trim();
    return this.clinics.delete(id);
  }

  /**
   * Export serializable snapshot of all clinic queues
   */
  exportSnapshot() {
    const { getAllClinics } = require('../config/app_config.js');
    const clinicsObj = {};
    for (const [id, model] of this.clinics.entries()) {
      clinicsObj[id] = model.toJSON();
    }
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      exportedAt: new Date().toISOString(),
      clinics: clinicsObj,
      clinicsRegistry: getAllClinics()
    };
  }

  /**
   * Import snapshot into store with full schema validation
   */
  importSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.clinics) {
      throw new DomainValidationError('Invalid snapshot format');
    }

    if (Array.isArray(snapshot.clinicsRegistry) && snapshot.clinicsRegistry.length > 0) {
      try {
        const { setClinicsList } = require('../config/app_config.js');
        setClinicsList(snapshot.clinicsRegistry);
      } catch (e) {}
    }

    const newMap = new Map();
    for (const [id, data] of Object.entries(snapshot.clinics)) {
      const model = QueueModel.fromJSON({ ...data, clinicId: id });
      newMap.set(id, model);
    }

    this.clinics = newMap;
  }

  /**
   * Flush current snapshot to persistence adapter
   */
  async persist() {
    if (this.persistenceAdapter) {
      const snapshot = this.exportSnapshot();
      if (typeof this.persistenceAdapter.saveState === 'function') {
        return this.persistenceAdapter.saveState(snapshot);
      }
      if (typeof this.persistenceAdapter.save === 'function') {
        return this.persistenceAdapter.save(snapshot);
      }
    }
  }
}

module.exports = {
  NotFoundError,
  QueueStore
};
