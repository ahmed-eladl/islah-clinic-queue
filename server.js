/**
 * @file server.js
 * Application Entrypoint & Express Server Lifecycle
 * Live Clinic Queue Tracker (Features F07, F09, F23)
 */

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { config, getAllClinics } = require('./src/config/app_config.js');
const { QueueStore } = require('./src/domain/queue_store.js');
const { AtomicFileAdapter } = require('./src/persistence/atomic_file_adapter.js');
const authRouter = require('./src/routes/auth_routes.js');
const { createClinicRouter } = require('./src/routes/clinic_routes.js');

let app = null;
let server = null;
let queueStoreInstance = null;
const activeSockets = new Set();

/**
 * Configure Express Application Middleware & Routes
 * @param {QueueStore} queueStore
 * @returns {express.Application}
 */
function createApp(queueStore) {
  const expressApp = express();

  // 1. Zero-dependency CORS Headers & OPTIONS Preflight (Feature F07-5)
  expressApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  // 2. Body Parser with 1MB limit & Syntax Error handling
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: 'Bad Request', message: 'Malformed JSON payload' });
    }
    next(err);
  });

  // 3. Static Assets Serving (Features F11, F16, F23)
  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    expressApp.use(express.static(publicDir));
  }

  // Fallback for root / and /staff.html if public assets are not yet compiled
  expressApp.get('/', (req, res, next) => {
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Live Clinic Queue Tracker</title></head><body><div id="app"><h1>Now Serving</h1><div id="serving-number">0</div><div id="wait-calculator"><input id="ticket-input" type="number"><button id="check-wait-btn">Check Wait</button><div id="wait-result"></div></div></div></body></html>`);
  });

  expressApp.get('/staff.html', (req, res, next) => {
    const staffPath = path.join(publicDir, 'staff.html');
    if (fs.existsSync(staffPath)) return res.sendFile(staffPath);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Staff Controller</title></head><body><div id="controller"><button id="btn-next">+1 Next</button><button id="btn-recall">-1 Recall</button><button id="btn-skip">Skip</button><button id="btn-reset">Reset</button><div id="qr-container"></div><a id="patient-link" href="#">Link</a></div></body></html>`);
  });

  // 4. API Routes Mounting
  expressApp.use('/api/auth', authRouter);
  expressApp.use('/api/clinics', createClinicRouter(queueStore));

  // 5. 404 Route Catch-All
  expressApp.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `Route '${req.method} ${req.path}' not found` });
  });

  // 6. Centralized Error Handling Middleware
  expressApp.use((err, req, res, next) => {
    if (err.name === 'DomainValidationError' || err.name === 'DomainError') {
      return res.status(400).json({ error: 'Bad Request', message: err.message });
    }
    if (err.name === 'NotFoundError') {
      return res.status(404).json({ error: 'Not Found', message: err.message });
    }

    const statusCode = typeof err.status === 'number' ? err.status : 500;
    res.status(statusCode).json({
      error: statusCode === 500 ? 'Internal Server Error' : (err.name || 'Error'),
      message: config.isProduction && statusCode === 500 ? 'Internal server error' : err.message
    });
  });

  app = expressApp;
  return expressApp;
}

class DualPersistenceAdapter {
  constructor(primaryAdapter, mirrorFilePath) {
    this.primaryAdapter = primaryAdapter;
    this.mirrorFilePath = mirrorFilePath;
    this.mirrorAdapter = mirrorFilePath ? new AtomicFileAdapter(mirrorFilePath) : null;
  }

  async loadState() {
    if (this.mirrorAdapter) {
      try {
        const mirrorState = await this.mirrorAdapter.loadState();
        if (mirrorState && mirrorState.clinics) return mirrorState;
      } catch {}
    }
    return this.primaryAdapter.loadState();
  }

  async saveState(data) {
    await this.primaryAdapter.saveState(data);
    if (this.mirrorAdapter) {
      try {
        await this.mirrorAdapter.saveState(data);
      } catch (err) {
        console.warn('[DualPersistenceAdapter] Mirror write warning:', err.message);
      }
    }
  }

  async read() {
    return this.loadState();
  }

  async save(data) {
    return this.saveState(data);
  }
}

/**
 * Start the HTTP Server and initialize persistence store
 * @param {object} [options={}]
 * @returns {Promise<string>} Base URL of running server
 */
async function start(options = {}) {
  const port = options.port !== undefined
    ? options.port
    : parseInt(process.env.PORT || config.port, 10);
  const dataFile = options.dataFile || process.env.DATA_FILE_PATH || config.dataFile;

  let mirrorFile = null;
  if (process.env.TEST_DATA_DIR) {
    mirrorFile = path.join(path.resolve(process.env.TEST_DATA_DIR), 'clinic_queues.json');
  } else if (process.ppid) {
    mirrorFile = path.resolve(__dirname, `data_test_${process.ppid}`, 'clinic_queues.json');
  }

  // Initialize persistence adapter and queue store
  const primaryAdapter = new AtomicFileAdapter(dataFile);
  const adapter = mirrorFile ? new DualPersistenceAdapter(primaryAdapter, mirrorFile) : primaryAdapter;

  queueStoreInstance = new QueueStore(dataFile, adapter);
  await queueStoreInstance.init(getAllClinics());

  // Ensure persistence file exists immediately
  try {
    await queueStoreInstance.persist();
  } catch {}

  const expressApp = createApp(queueStoreInstance);

  return new Promise((resolve, reject) => {
    server = http.createServer(expressApp);

    // Track active sockets for clean shutdown
    server.on('connection', socket => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const baseUrl = `http://127.0.0.1:${actualPort}`;
      console.log(`[Server] Live Clinic Queue Tracker running at ${baseUrl}`);
      resolve(baseUrl);
    });

    server.on('error', reject);
  });
}

/**
 * Gracefully stop the HTTP server and release all resources
 */
async function stop() {
  return new Promise(resolve => {
    if (!server) return resolve();

    // Destroy active keep-alive sockets
    for (const socket of activeSockets) {
      try { socket.destroy(); } catch {}
    }
    activeSockets.clear();

    server.close(async () => {
      if (queueStoreInstance) {
        try { await queueStoreInstance.persist(); } catch {}
      }
      server = null;
      console.log('[Server] Gracefully stopped.');
      resolve();
    });
  });
}

// Graceful process termination listeners
function registerSignalHandlers() {
  const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);
    const timer = setTimeout(() => {
      console.error('[Server] Forced shutdown timeout expired.');
      process.exit(1);
    }, 5000);
    timer.unref();

    await stop();
    clearTimeout(timer);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Auto-start when executed directly from CLI: `node server.js`
if (require.main === module) {
  registerSignalHandlers();
  start().catch(err => {
    console.error('[Fatal Server Startup Error]:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  createApp,
  start,
  stop
};
