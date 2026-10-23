/**
 * @file api/index.js
 * Vercel Serverless Function Entrypoint
 * Bridges Express.js & QueueStore to Vercel's serverless edge/lambda execution environment.
 */

const { createApp } = require('../server.js');
const { createQueueStore } = require('../src/persistence/storage_factory.js');
const { getAllClinics } = require('../src/config/app_config.js');

let cachedApp = null;
let initPromise = null;

async function getExpressApp() {
  if (cachedApp) return cachedApp;
  if (!initPromise) {
    initPromise = (async () => {
      const queueStore = createQueueStore();
      await queueStore.init(getAllClinics());
      cachedApp = createApp(queueStore);
      return cachedApp;
    })();
  }
  return initPromise;
}

module.exports = async (req, res) => {
  const app = await getExpressApp();
  return app(req, res);
};
