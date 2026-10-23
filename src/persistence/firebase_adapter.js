/**
 * @file src/persistence/firebase_adapter.js
 * Zero-cost cloud persistence adapter for Firebase Realtime Database.
 * Implements REST persistence with offline local fallback and zero npm dependencies.
 * Conforms to QueueStore persistence contract: saveState(data), loadState().
 */

const path = require('node:path');
let AtomicFileAdapter;
try {
  ({ AtomicFileAdapter } = require('./atomic_file_adapter.js'));
} catch {
  // Graceful fallback if co-located
}

class FirebaseAdapter {
  /**
   * @param {object} [options={}]
   * @param {string} [options.databaseUrl] - Base Firebase RTDB URL (e.g., https://my-proj-default-rtdb.firebaseio.com)
   * @param {string} [options.authSecret] - Database secret or Firebase auth token
   * @param {string} [options.nodePath='clinic_queues'] - Database node path
   * @param {number} [options.timeoutMs=4000] - HTTP request timeout in milliseconds
   * @param {number} [options.maxRetries=2] - Transient retry attempts for 5xx errors
   * @param {object} [options.fallbackAdapter=null] - Local adapter instance for offline fallback
   * @param {boolean} [options.enableFallback=true] - Whether to engage fallback adapter on failure
   * @param {string} [options.fallbackPath] - Path to local fallback JSON file
   */
  constructor(options = {}) {
    const rawUrl = options.databaseUrl || process.env.FIREBASE_DATABASE_URL || '';
    this.databaseUrl = rawUrl.replace(/\/+$/, ''); // Strip trailing slashes
    this.authSecret = options.authSecret || process.env.FIREBASE_AUTH_SECRET || '';
    this.nodePath = (options.nodePath || process.env.FIREBASE_NODE_PATH || 'clinic_queues').replace(/^\/+|\/+$/g, '');
    this.timeoutMs = options.timeoutMs || 4000;
    this.maxRetries = options.maxRetries ?? 2;
    this.enableFallback = options.enableFallback ?? true;

    // Optional local fallback adapter (AtomicFileAdapter)
    if (options.fallbackAdapter) {
      this.fallbackAdapter = options.fallbackAdapter;
    } else if (this.enableFallback && AtomicFileAdapter) {
      const fallbackPath = options.fallbackPath || process.env.DATA_FILE_PATH || path.resolve('./data/clinic_queues.json');
      this.fallbackAdapter = new AtomicFileAdapter(fallbackPath);
    } else {
      this.fallbackAdapter = null;
    }

    this.isOffline = false;
    this.lastSyncError = null;
  }

  /**
   * Builds the REST endpoint URL with optional auth token
   * @private
   */
  _buildUrl(subPath = '') {
    if (!this.databaseUrl) {
      throw new Error('[FirebaseAdapter] Database URL is not configured. Set FIREBASE_DATABASE_URL.');
    }
    const cleanSubPath = subPath ? `/${subPath.replace(/^\/+/, '')}` : '';
    const fullPath = `${this.nodePath}${cleanSubPath}`;
    const url = new URL(`${this.databaseUrl}/${fullPath}.json`);
    if (this.authSecret) {
      url.searchParams.set('auth', this.authSecret);
    }
    return url.toString();
  }

  /**
   * Helper for fetch with timeout and backoff retry
   * @private
   */
  async _fetchWithTimeout(url, fetchOptions = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal
        });
        clearTimeout(timer);

        // Retry on transient 500, 502, 503, 504 server errors
        if (res.status >= 500 && attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 100 + Math.floor(Math.random() * 50);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 100 + Math.floor(Math.random() * 50);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }
    throw lastError;
  }

  /**
   * Loads state from Firebase Realtime Database with offline fallback
   * @returns {Promise<object|null>} Validated state object or null if database empty
   */
  async loadState() {
    // If no databaseUrl provided and fallback is enabled, transparently read fallback
    if (!this.databaseUrl && this.fallbackAdapter) {
      return this.fallbackAdapter.loadState();
    }

    try {
      const endpoint = this._buildUrl();
      const res = await this._fetchWithTimeout(endpoint, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
        throw new Error(`Firebase RTDB GET failed: HTTP ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      if (!data) {
        // Firebase RTDB returns null for empty paths
        return null;
      }

      this.isOffline = false;
      this.lastSyncError = null;

      // Normalize Firebase RTDB peculiarities (missing empty arrays, sparse objects)
      return this._normalizeFirebaseState(data);
    } catch (err) {
      this.isOffline = true;
      this.lastSyncError = err.message;
      console.warn(`[FirebaseAdapter] Failed to load remote state (${err.message}). Engaging fallback.`);

      if (this.enableFallback && this.fallbackAdapter) {
        return this.fallbackAdapter.loadState();
      }
      throw err;
    }
  }

  /**
   * Alias for loadState()
   */
  async read() {
    return this.loadState();
  }

  /**
   * Saves state to Firebase Realtime Database with offline fallback
   * @param {object} data - Snapshot from QueueStore.exportSnapshot()
   * @returns {Promise<void>}
   */
  async saveState(data) {
    if (!data || typeof data !== 'object') {
      throw new TypeError('[FirebaseAdapter] saveState requires a valid data object');
    }

    // Always keep fallback adapter up-to-date locally if configured
    if (this.enableFallback && this.fallbackAdapter) {
      try {
        await this.fallbackAdapter.saveState(data);
      } catch (fallbackErr) {
        console.warn('[FirebaseAdapter] Warning: Local fallback write failed:', fallbackErr.message);
      }
    }

    // If no cloud URL is configured, local write is sufficient
    if (!this.databaseUrl) {
      return;
    }

    try {
      const endpoint = this._buildUrl();
      const res = await this._fetchWithTimeout(endpoint, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(data)
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Firebase RTDB PUT failed: HTTP ${res.status} ${res.statusText} (${bodyText})`);
      }

      this.isOffline = false;
      this.lastSyncError = null;
    } catch (err) {
      this.isOffline = true;
      this.lastSyncError = err.message;
      console.warn(`[FirebaseAdapter] Remote write failed (${err.message}). State saved to local fallback.`);

      if (!this.enableFallback || !this.fallbackAdapter) {
        throw new Error(`[FirebaseAdapter] Persistence failed: ${err.message}`);
      }
    }
  }

  /**
   * Alias for saveState()
   */
  async save(data) {
    return this.saveState(data);
  }

  /**
   * Reconciles and normalizes Firebase RTDB quirks
   * @private
   */
  _normalizeFirebaseState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const normalized = {
      version: raw.version || 1,
      lastUpdated: raw.lastUpdated || new Date().toISOString(),
      clinics: {}
    };

    if (raw.clinics && typeof raw.clinics === 'object') {
      for (const [id, clinic] of Object.entries(raw.clinics)) {
        if (!clinic || typeof clinic !== 'object') continue;

        // Firebase drops empty arrays: restore [] if missing
        let cleanSkipped = [];
        if (Array.isArray(clinic.skipped)) {
          cleanSkipped = clinic.skipped.filter(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
        } else if (clinic.skipped && typeof clinic.skipped === 'object') {
          // Firebase turns sparse arrays into { "0": 12, "1": 15 }
          cleanSkipped = Object.values(clinic.skipped)
            .filter(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
        }

        normalized.clinics[id] = {
          clinicId: clinic.clinicId || id,
          name: clinic.name || id,
          room: clinic.room || '',
          doctorName: clinic.doctorName || '',
          currentServing: Math.max(0, parseInt(clinic.currentServing, 10) || 0),
          status: ['In Clinic', 'Brief Break', 'Finished'].includes(clinic.status) ? clinic.status : 'In Clinic',
          skipped: cleanSkipped,
          lastUpdated: clinic.lastUpdated || normalized.lastUpdated,
          averageServiceMinutes: parseInt(clinic.averageServiceMinutes, 10) || 8,
          recentHistory: Array.isArray(clinic.recentHistory) ? clinic.recentHistory : []
        };
      }
    }

    return normalized;
  }

  /**
   * Health check / connectivity probe
   * @returns {Promise<boolean>}
   */
  async isHealthy() {
    if (!this.databaseUrl) {
      return this.fallbackAdapter ? true : false;
    }
    try {
      const endpoint = this._buildUrl();
      const res = await this._fetchWithTimeout(endpoint, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Persistence Factory: seamlessly instantiates appropriate adapter based on config
 */
function createPersistenceAdapter(options = {}) {
  const mode = options.mode || process.env.PERSISTENCE_MODE || 'local';
  if (mode === 'firebase') {
    return new FirebaseAdapter({
      databaseUrl: options.databaseUrl || process.env.FIREBASE_DATABASE_URL,
      authSecret: options.authSecret || process.env.FIREBASE_AUTH_SECRET,
      fallbackPath: options.dataFile || process.env.DATA_FILE_PATH,
      enableFallback: true
    });
  }
  return new AtomicFileAdapter(options.dataFile || process.env.DATA_FILE_PATH || './data/clinic_queues.json');
}

module.exports = {
  FirebaseAdapter,
  createPersistenceAdapter
};
