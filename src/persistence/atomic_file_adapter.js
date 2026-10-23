/**
 * @file atomic_file_adapter.js
 * Crash-resilient atomic file persistence adapter for clinic queue state.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class AtomicFileAdapter {
  /**
   * @param {string} [filePath='./data/clinic_queues.json'] - Target JSON storage path
   * @param {object} [options={}]
   * @param {number} [options.maxRetries=5] - Retries for Windows rename lock contention
   * @param {boolean} [options.pretty=true] - Format JSON with 2 spaces
   */
  constructor(filePath = './data/clinic_queues.json', options = {}) {
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    this.maxRetries = options.maxRetries ?? 5;
    this.pretty = options.pretty ?? true;
    this._writeQueue = Promise.resolve();
  }

  /**
   * Ensures the storage directory exists.
   */
  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  /**
   * Checks if the target storage file exists.
   * @returns {Promise<boolean>}
   */
  async exists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads and parses JSON from the target file.
   * @returns {Promise<object|null>} Parsed state or null if not found
   */
  async read() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      if (!content.trim()) {
        throw new Error('Storage file is empty (0 bytes)');
      }
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Alias for read()
   */
  async loadState() {
    return this.read();
  }

  /**
   * Enqueues an atomic write operation.
   * @param {object} data - State object to persist
   * @returns {Promise<void>}
   */
  async save(data) {
    const operation = this._writeQueue.then(() => this._executeAtomicWrite(data));
    this._writeQueue = operation.catch(() => {});
    return operation;
  }

  /**
   * Alias for save()
   */
  async saveState(data) {
    return this.save(data);
  }

  /**
   * Executes atomic write-then-rename with fsync and Windows backoff retry.
   * @private
   */
  async _executeAtomicWrite(data) {
    await this.ensureDirectory();

    const serialized = this.pretty
      ? JSON.stringify(data, null, 2) + '\n'
      : JSON.stringify(data) + '\n';

    // Co-located unique temporary file
    const uniqueSuffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const tempFileName = `${path.basename(this.filePath)}.tmp.${uniqueSuffix}`;
    const tempFilePath = path.join(this.directory, tempFileName);

    let fileHandle = null;
    try {
      // 1. Open and write to temp file
      fileHandle = await fs.open(tempFilePath, 'w');
      await fileHandle.writeFile(serialized, 'utf8');

      // 2. Flush dirty OS page cache to disk (fsync)
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;

      // 3. Atomically rename temp file to target file with retry for Windows locks
      await this._renameWithRetry(tempFilePath, this.filePath);
    } catch (err) {
      // Clean up temp file on failure
      if (fileHandle) {
        try { await fileHandle.close(); } catch {}
      }
      try { await fs.unlink(tempFilePath); } catch {}
      throw new Error(`[AtomicFileAdapter] Failed atomic write to '${this.filePath}': ${err.message}`);
    }
  }

  /**
   * Retries fs.rename on Windows lock errors (EPERM, EBUSY, EACCES).
   * @private
   */
  async _renameWithRetry(source, destination) {
    let attempt = 0;
    while (true) {
      try {
        await fs.rename(source, destination);
        return;
      } catch (err) {
        const isWindowsLock = ['EPERM', 'EBUSY', 'EACCES'].includes(err.code);
        if (isWindowsLock && attempt < this.maxRetries) {
          attempt++;
          const delay = Math.pow(2, attempt) * 10 + Math.floor(Math.random() * 20);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Quarantines a corrupted file by renaming it with a timestamp suffix.
   * @returns {Promise<string>} Path to the quarantined backup file
   */
  async quarantineCorruptedFile() {
    const corruptPath = `${this.filePath}.corrupt.${Date.now()}`;
    try {
      await fs.rename(this.filePath, corruptPath);
      return corruptPath;
    } catch (err) {
      await fs.copyFile(this.filePath, corruptPath);
      await fs.unlink(this.filePath);
      return corruptPath;
    }
  }
}

/**
 * Loads and validates clinic queue state from storage, falling back to seed config.
 * @param {AtomicFileAdapter} adapter
 * @param {Array<object>} seedClinicsList - Array of clinic definitions
 * @returns {Promise<object>} Clean, validated state map
 */
async function initializeClinicState(adapter, seedClinicsList = []) {
  let rawState = null;
  let fileExisted = false;

  try {
    rawState = await adapter.read();
    fileExisted = rawState !== null;
  } catch (err) {
    // File exists but contains corrupted / truncated JSON
    const quarantinePath = await adapter.quarantineCorruptedFile();
    rawState = null;
    fileExisted = false;
  }

  // If no file existed or file was corrupted, initialize fresh seed state
  if (!fileExisted || !rawState) {
    const initialState = createInitialSeedState(seedClinicsList);
    await adapter.save(initialState);
    return initialState;
  }

  // File exists: Validate and reconcile against known clinics
  const { validatedState, wasRepaired } = reconcileAndValidateState(rawState, seedClinicsList);

  if (wasRepaired) {
    await adapter.save(validatedState);
  }

  return validatedState;
}

function createInitialSeedState(seedClinics = []) {
  const now = new Date().toISOString();
  const state = {
    version: 1,
    lastUpdated: now,
    clinics: {}
  };

  for (const clinic of seedClinics) {
    const id = clinic.id || clinic.clinicId;
    state.clinics[id] = {
      clinicId: id,
      name: clinic.name || id,
      room: clinic.room || '',
      doctorName: clinic.doctorName || '',
      currentServing: 0,
      status: 'In Clinic',
      skipped: [],
      lastUpdated: now,
      averageServiceMinutes: clinic.averageServiceMinutes || 8,
      recentHistory: []
    };
  }

  return state;
}

function reconcileAndValidateState(rawState, seedClinics = []) {
  let wasRepaired = false;
  const now = new Date().toISOString();
  const allowedStatuses = ['In Clinic', 'Brief Break', 'Finished'];

  const clinicsMap = rawState && typeof rawState.clinics === 'object' && rawState.clinics !== null
    ? rawState.clinics
    : (wasRepaired = true, {});

  const validatedState = {
    version: rawState?.version || 1,
    lastUpdated: rawState?.lastUpdated || now,
    clinics: {}
  };

  // Reconcile and retain existing clinics
  for (const [id, rawExisting] of Object.entries(clinicsMap)) {
    const existing = (rawExisting && typeof rawExisting === 'object')
      ? rawExisting
      : (wasRepaired = true, {});

    const isValidServing = typeof existing.currentServing === 'number' &&
      Number.isSafeInteger(existing.currentServing) &&
      existing.currentServing >= 0;
    const currentServing = isValidServing
      ? existing.currentServing
      : (wasRepaired = true, 0);

    const status = (typeof existing.status === 'string' && allowedStatuses.includes(existing.status))
      ? existing.status
      : (wasRepaired = true, 'In Clinic');

    let skipped = [];
    if (Array.isArray(existing.skipped)) {
      const cleanSkipped = [];
      for (const n of existing.skipped) {
        if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) {
          if (!cleanSkipped.includes(n)) {
            cleanSkipped.push(n);
          }
        }
      }
      if (cleanSkipped.length !== existing.skipped.length) {
        wasRepaired = true;
      }
      skipped = cleanSkipped;
    } else {
      wasRepaired = true;
      skipped = [];
    }

    validatedState.clinics[id] = {
      clinicId: existing.clinicId || id,
      name: existing.name || id,
      room: existing.room || '',
      doctorName: existing.doctorName || '',
      currentServing,
      status,
      skipped,
      lastUpdated: existing.lastUpdated || now,
      averageServiceMinutes: existing.averageServiceMinutes || 8,
      recentHistory: Array.isArray(existing.recentHistory) ? existing.recentHistory : []
    };
  }

  // Ensure each seed clinic exists in validatedState
  for (const seed of seedClinics) {
    const id = seed.id || seed.clinicId;
    if (!validatedState.clinics[id]) {
      wasRepaired = true;
      validatedState.clinics[id] = {
        clinicId: id,
        name: seed.name || id,
        room: seed.room || '',
        doctorName: seed.doctorName || '',
        currentServing: 0,
        status: 'In Clinic',
        skipped: [],
        lastUpdated: now,
        averageServiceMinutes: seed.averageServiceMinutes || 8,
        recentHistory: []
      };
    }
  }

  return { validatedState, wasRepaired };
}

module.exports = {
  AtomicFileAdapter,
  initializeClinicState
};
