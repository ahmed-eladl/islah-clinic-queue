/**
 * @file src/persistence/storage_factory.js
 * Automatic Persistence Provider Factory
 * Auto-detects Vercel KV, Upstash Redis, Firebase RTDB, or local atomic disk storage.
 */

const path = require('node:path');
const { AtomicFileAdapter } = require('./atomic_file_adapter.js');
const { UpstashRedisAdapter } = require('./upstash_adapter.js');
const { QueueStore } = require('../domain/queue_store.js');
const { config } = require('../config/app_config.js');

let FirebaseAdapter = null;
try {
  ({ FirebaseAdapter } = require('./firebase_adapter.js'));
} catch {}

/**
 * Creates or detects the appropriate persistence adapter
 * @param {object} [options={}]
 * @returns {object} persistence adapter
 */
function createPersistenceAdapter(options = {}) {
  // 1. Upstash Redis / Vercel KV auto-detection
  const upstash = new UpstashRedisAdapter(options);
  if (upstash.isConfigured()) {
    console.log('[StorageFactory] Using Upstash Redis / Vercel KV cloud persistence.');
    return upstash;
  }

  // 2. Firebase RTDB auto-detection
  if (FirebaseAdapter && (process.env.FIREBASE_DATABASE_URL || options.databaseUrl)) {
    console.log('[StorageFactory] Using Firebase Realtime Database cloud persistence.');
    const fb = new FirebaseAdapter(options);
    fb.isCloud = true;
    return fb;
  }

  // 3. Vercel Serverless environment fallback (use /tmp to prevent EROFS)
  const isVercel = Boolean(process.env.VERCEL || process.env.NOW_REGION);
  if (isVercel) {
    const tmpPath = path.join('/tmp', 'clinic_queues.json');
    console.log(`[StorageFactory] Running in Vercel serverless mode. Using writable fallback: ${tmpPath}`);
    return new AtomicFileAdapter(tmpPath);
  }

  // 4. Standard local file storage (Default for Node.js server)
  const localFile = options.dataFile || config.dataFile;
  return new AtomicFileAdapter(localFile);
}

/**
 * Creates and initializes a QueueStore instance with the best persistence adapter
 * @param {object} [options={}]
 * @returns {QueueStore}
 */
function createQueueStore(options = {}) {
  const adapter = createPersistenceAdapter(options);
  const dataPath = options.dataFile || config.dataFile;
  return new QueueStore(dataPath, adapter);
}

module.exports = {
  createPersistenceAdapter,
  createQueueStore
};
