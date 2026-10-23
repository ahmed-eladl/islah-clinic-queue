/**
 * @file api/index.js
 * Vercel Serverless Function Entrypoint
 * Direct Express Application Export for @vercel/node runtime.
 */

const { createApp } = require('../server.js');
const { createQueueStore } = require('../src/persistence/storage_factory.js');
const { getAllClinics } = require('../src/config/app_config.js');

// 1. Synchronously initialize QueueStore & register clinic tenants
const queueStore = createQueueStore();
const clinics = getAllClinics();
for (const clinic of clinics) {
  queueStore.registerClinic(clinic);
}

// 2. Background async load from persistence (Upstash / KV / /tmp)
queueStore.init(clinics).catch(err => {
  console.warn('[Vercel Serverless] QueueStore async init warning:', err.message);
});

// 3. Instantiate Express Application
const app = createApp(queueStore);

// 4. Export Express app instance directly for Vercel (@vercel/node)
module.exports = app;
