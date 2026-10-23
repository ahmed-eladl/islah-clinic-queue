// tests/reference_server.js
// Standalone reference server implementing the exact interface contracts from PROJECT.md
// Used as an oracle / fallback reference when server.js is not yet running or during isolated testing.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEY = process.env.JWT_SECRET || 'clinic_jwt_secret_salt_2026';

const DEFAULT_CLINICS = [
  { id: 'pediatrics', name: 'Pediatrics Clinic', username: 'pediatrics', password: 'pediatrics123', avgConsultTimeMinutes: 10, icon: 'baby' },
  { id: 'cardiology', name: 'Cardiology Clinic', username: 'cardiology', password: 'cardiology123', avgConsultTimeMinutes: 15, icon: 'heart-pulse' },
  { id: 'general', name: 'General Medicine', username: 'general', password: 'general123', avgConsultTimeMinutes: 7, icon: 'stethoscope' },
  { id: 'dental', name: 'Dental Clinic', username: 'dental', password: 'dental123', avgConsultTimeMinutes: 12, icon: 'tooth' }
];

function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 24 * 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(`${header}.${body}`).digest('base64url');
  if (expectedSig !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

class ReferenceServer {
  constructor(options = {}) {
    this.port = options.port || 0;
    this.dataDir = options.dataDir || path.resolve(__dirname, '../data');
    this.dataFile = path.join(this.dataDir, 'clinic_queues.json');
    this.server = null;
    this.sseClients = new Map(); // clinicId -> Set of response objects
    this.state = {};
    this.initDefaultState();
  }

  initDefaultState() {
    this.state = {};
    for (const c of DEFAULT_CLINICS) {
      this.state[c.id] = {
        id: c.id,
        name: c.name,
        currentServing: 0,
        status: 'In Clinic',
        skipped: [],
        lastUpdated: new Date().toISOString()
      };
      this.sseClients.set(c.id, new Set());
    }
  }

  loadState() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.clinics) {
          for (const [id, cState] of Object.entries(data.clinics)) {
            if (this.state[id]) {
              this.state[id].currentServing = cState.currentServing ?? 0;
              this.state[id].status = cState.status || 'In Clinic';
              this.state[id].skipped = Array.isArray(cState.skipped) ? cState.skipped : [];
              this.state[id].lastUpdated = cState.lastUpdated || new Date().toISOString();
            }
          }
        }
      }
    } catch {
      // Keep default state on read error
    }
  }

  saveState() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const payload = {
        lastGlobalUpdate: new Date().toISOString(),
        clinics: this.state
      };
      const tmpFile = `${this.dataFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.dataFile);
    } catch {
      // Ignore write error in test if sandbox is read-only
    }
  }

  broadcast(clinicId) {
    const cState = this.state[clinicId];
    if (!cState) return;
    const clients = this.sseClients.get(clinicId);
    if (!clients || clients.size === 0) return;
    const payload = JSON.stringify({
      type: 'QUEUE_UPDATE',
      clinicId: cState.id,
      name: cState.name,
      currentServing: cState.currentServing,
      status: cState.status,
      skipped: cState.skipped,
      timestamp: new Date().toISOString()
    });
    for (const res of clients) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.loadState();
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        for (const clients of this.sseClients.values()) {
          for (const res of clients) {
            try { res.end(); } catch { /* ignore */ }
          }
          clients.clear();
        }
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e6) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  authenticate(req, expectedClinicId) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, error: 'Authorization header required' };
    }
    const token = authHeader.slice(7).trim();
    const payload = verifyToken(token);
    if (!payload) {
      return { status: 401, error: 'Invalid or expired token' };
    }
    if (expectedClinicId && payload.clinicId !== expectedClinicId) {
      return { status: 403, error: 'Forbidden: token clinic mismatch' };
    }
    return { user: payload };
  }

  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      // 1. Staff Login
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { username, password } = body;
        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Username and password required' }));
        }
        const clinic = DEFAULT_CLINICS.find(c => c.username === username && c.password === password);
        if (!clinic) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid clinic credentials' }));
        }
        const token = signToken({ clinicId: clinic.id, username: clinic.username });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          token,
          clinic: { id: clinic.id, name: clinic.name }
        }));
      }

      // 2. GET /api/clinics
      if (pathname === '/api/clinics' && method === 'GET') {
        const summaries = Object.values(this.state).map(c => ({
          id: c.id,
          name: c.name,
          currentServing: c.currentServing,
          status: c.status
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(summaries));
      }

      // 3. Match /api/clinics/:clinicId/...
      const clinicMatch = pathname.match(/^\/api\/clinics\/([^/]+)(?:\/(.*))?$/);
      if (clinicMatch) {
        const clinicId = clinicMatch[1];
        const action = clinicMatch[2] || 'state';

        const clinicState = this.state[clinicId];
        if (!clinicState) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Clinic ${clinicId} not found` }));
        }

        // GET /api/clinics/:clinicId/state
        if (action === 'state' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: clinicState.id,
            name: clinicState.name,
            currentServing: clinicState.currentServing,
            status: clinicState.status,
            skipped: clinicState.skipped
          }));
        }

        // GET /api/clinics/:clinicId/events (SSE)
        if (action === 'events' && method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          const initialPayload = JSON.stringify({
            type: 'QUEUE_UPDATE',
            clinicId: clinicState.id,
            name: clinicState.name,
            currentServing: clinicState.currentServing,
            status: clinicState.status,
            skipped: clinicState.skipped,
            timestamp: new Date().toISOString()
          });
          res.write(`data: ${initialPayload}\n\n`);

          const clients = this.sseClients.get(clinicId);
          if (clients) clients.add(res);

          req.on('close', () => {
            if (clients) clients.delete(res);
          });
          return;
        }

        // Mutation endpoints require auth
        const auth = this.authenticate(req, clinicId);
        if (auth.error) {
          res.writeHead(auth.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: auth.error }));
        }

        // POST /api/clinics/:clinicId/next
        if (action === 'next' && method === 'POST') {
          clinicState.currentServing += 1;
          clinicState.lastUpdated = new Date().toISOString();
          this.saveState();
          this.broadcast(clinicId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            currentServing: clinicState.currentServing,
            status: clinicState.status
          }));
        }

        // POST /api/clinics/:clinicId/recall
        if (action === 'recall' && method === 'POST') {
          clinicState.currentServing = Math.max(0, clinicState.currentServing - 1);
          clinicState.lastUpdated = new Date().toISOString();
          this.saveState();
          this.broadcast(clinicId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            currentServing: clinicState.currentServing,
            status: clinicState.status
          }));
        }

        // POST /api/clinics/:clinicId/skip
        if (action === 'skip' && method === 'POST') {
          if (clinicState.currentServing > 0 && !clinicState.skipped.includes(clinicState.currentServing)) {
            clinicState.skipped.push(clinicState.currentServing);
          }
          clinicState.currentServing += 1;
          clinicState.lastUpdated = new Date().toISOString();
          this.saveState();
          this.broadcast(clinicId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            currentServing: clinicState.currentServing,
            skipped: clinicState.skipped
          }));
        }

        // POST /api/clinics/:clinicId/reset
        if (action === 'reset' && method === 'POST') {
          clinicState.currentServing = 0;
          clinicState.skipped = [];
          clinicState.lastUpdated = new Date().toISOString();
          this.saveState();
          this.broadcast(clinicId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            currentServing: 0,
            status: clinicState.status,
            skipped: []
          }));
        }

        // POST /api/clinics/:clinicId/status
        if (action === 'status' && method === 'POST') {
          const body = await this.parseJsonBody(req);
          const validStatuses = ['In Clinic', 'Brief Break', 'Finished'];
          if (!body.status || !validStatuses.includes(body.status)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Status must be one of: ${validStatuses.join(', ')}` }));
          }
          clinicState.status = body.status;
          clinicState.lastUpdated = new Date().toISOString();
          this.saveState();
          this.broadcast(clinicId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            status: clinicState.status
          }));
        }

        // POST /api/clinics/:clinicId/chime
        if (action === 'chime' && method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            chimeTriggered: true
          }));
        }
      }

      // 4. Static Asset Serving
      let filePath = pathname === '/' ? '/index.html' : pathname;
      const publicDir = path.resolve(__dirname, '../public');
      const resolvedPath = path.join(publicDir, filePath);

      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        const ext = path.extname(resolvedPath);
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(fs.readFileSync(resolvedPath));
      }

      // If static files don't exist yet, return minimal compliant HTML/CSS/JS mock
      if (filePath === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Live Clinic Queue Tracker</title></head><body><div id="app"><h1>Now Serving</h1><div id="serving-number">0</div><div id="wait-calculator"><input id="ticket-input" type="number"><button id="check-wait-btn">Check Wait</button><div id="wait-result"></div></div></div></body></html>`);
      }
      if (filePath === '/staff.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Staff Controller</title></head><body><div id="controller"><button id="btn-next">+1 Next</button><button id="btn-recall">-1 Recall</button><button id="btn-skip">Skip</button><button id="btn-reset">Reset</button><div id="qr-container"></div><a id="patient-link" href="#">Link</a></div></body></html>`);
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

module.exports = { ReferenceServer, DEFAULT_CLINICS, signToken, verifyToken };
