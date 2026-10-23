// tests/test_helper.js
// Shared test utilities, lifecycle management, and mathematical calculators for E2E tests

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ReferenceServer, DEFAULT_CLINICS } = require('./reference_server');

let runningServerInstance = null;
let runningChildProcess = null;
let activeBaseUrl = null;

async function checkUrl(url, timeoutMs = 500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${url}/api/clinics`, { signal: controller.signal });
    clearTimeout(timer);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function startServer() {
  if (activeBaseUrl) return activeBaseUrl;

  const envUrl = process.env.TEST_SERVER_URL;
  if (envUrl && await checkUrl(envUrl)) {
    activeBaseUrl = envUrl;
    return activeBaseUrl;
  }

  // Check default port 3000
  if (await checkUrl('http://127.0.0.1:3000')) {
    activeBaseUrl = 'http://127.0.0.1:3000';
    return activeBaseUrl;
  }

  // Check if real server.js exists
  const serverPath = path.resolve(__dirname, '../server.js');
  if (fs.existsSync(serverPath) && process.env.USE_REFERENCE_SERVER !== 'true') {
    const port = 3000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'pipe'
    });
    runningChildProcess = child;
    const testUrl = `http://127.0.0.1:${port}`;

    // Poll until ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (await checkUrl(testUrl)) {
        activeBaseUrl = testUrl;
        return activeBaseUrl;
      }
    }
  }

  const activeDataDir = process.env.TEST_DATA_DIR || path.resolve(__dirname, `../data_test_${process.pid}`);

  // Fallback to compliant ReferenceServer
  runningServerInstance = new ReferenceServer({ port: 0, dataDir: activeDataDir });
  activeBaseUrl = await runningServerInstance.start();
  return activeBaseUrl;
}

function getDataDir() {
  return process.env.TEST_DATA_DIR || path.resolve(__dirname, `../data_test_${process.pid}`);
}

async function stopServer() {
  if (runningChildProcess) {
    runningChildProcess.kill('SIGTERM');
    runningChildProcess = null;
  }
  if (runningServerInstance) {
    await runningServerInstance.stop();
    runningServerInstance = null;
  }
  try {
    const dir = getDataDir();
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
  activeBaseUrl = null;
}

async function apiRequest(baseUrl, endpoint, options = {}) {
  const url = `${baseUrl}${endpoint}`;
  const headers = { ...options.headers };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof String)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, { ...options, headers });
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    data = await res.text();
  }
  return {
    status: res.status,
    headers: res.headers,
    body: data
  };
}

async function getClinicToken(baseUrl, clinicId = 'pediatrics', password = null) {
  const found = DEFAULT_CLINICS.find(c => c.id === clinicId);
  const pwd = password || (found ? found.password : `${clinicId}123`);
  const res = await apiRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: clinicId, password: pwd }
  });
  if (res.status === 200 && res.body && res.body.token) {
    return res.body.token;
  }
  return null;
}

async function resetClinicQueue(baseUrl, clinicId, token) {
  return await apiRequest(baseUrl, `/api/clinics/${clinicId}/reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function resetAllClinics(baseUrl) {
  for (const c of DEFAULT_CLINICS) {
    const token = await getClinicToken(baseUrl, c.id);
    if (token) {
      await resetClinicQueue(baseUrl, c.id, token);
      await apiRequest(baseUrl, `/api/clinics/${c.id}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { status: 'In Clinic' }
      });
    }
  }
}

function listenToSSE(baseUrl, clinicId, onEvent, maxWaitMs = 5000) {
  const controller = new AbortController();
  const events = [];
  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, maxWaitMs);

  const promise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/clinics/${clinicId}/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' }
      });
      if (res.status !== 200 || !res.body) return events;

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const block of lines) {
          const match = block.match(/data:\s*(.+)/);
          if (match) {
            try {
              const parsed = JSON.parse(match[1]);
              events.push(parsed);
              if (onEvent) onEvent(parsed);
            } catch {
              // ignore non-json keepalives
            }
          }
        }
      }
    } catch (e) {
      // Abort is expected when stopping listener
    }
    return events;
  })();

  return {
    events,
    close: () => {
      clearTimeout(timeoutTimer);
      controller.abort();
    },
    waitForCount: async (count, checkIntervalMs = 50, maxWait = maxWaitMs) => {
      const start = Date.now();
      while (events.length < count && Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, checkIntervalMs));
      }
      return events;
    },
    done: promise
  };
}

// Algorithmic specifications matching section 4 of spec_report.md
function calculatePatientsAhead(tPatient, tServing) {
  if (tPatient > tServing) return tPatient - tServing;
  if (tPatient === tServing) return 0;
  return -(tServing - tPatient);
}

function calculateWaitTime(tPatient, tServing, avgMinutes = 8, status = 'In Clinic', breakMinutes = 15) {
  const pAhead = calculatePatientsAhead(tPatient, tServing);
  if (pAhead < 0) return { pAhead, waitMinutes: null, label: 'Turn passed' };
  if (pAhead === 0) return { pAhead, waitMinutes: 0, label: 'Now Serving' };
  if (status === 'Finished') return { pAhead, waitMinutes: null, label: 'Clinic Finished' };

  let wait = pAhead * avgMinutes;
  if (status === 'Brief Break') {
    wait += breakMinutes;
  }
  return { pAhead, waitMinutes: wait, label: formatWaitTime(wait) };
}

function formatWaitTime(minutes) {
  if (minutes === 0) return 'Now Serving';
  if (minutes < 60) return `~${minutes} mins`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) return `~${hours} hr`;
  return `~${hours} hr ${remaining} mins`;
}

module.exports = {
  startServer,
  stopServer,
  apiRequest,
  getClinicToken,
  resetClinicQueue,
  resetAllClinics,
  listenToSSE,
  calculatePatientsAhead,
  calculateWaitTime,
  formatWaitTime,
  getDataDir,
  DEFAULT_CLINICS
};
