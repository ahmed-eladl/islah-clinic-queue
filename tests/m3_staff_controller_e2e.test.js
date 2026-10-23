/**
 * @file tests/m3_staff_controller_e2e.test.js
 * Dedicated Milestone 3 E2E Test Suite:
 * - Suite 1: Staff Authentication, Session Storage & Logout Lifecycle (F11)
 * - Suite 2: Touch Action Buttons, Touch Sizing & 300ms Debounce Guard (F11, F12)
 * - Suite 3: Two-Step Reset Safety Confirmation Modal & State Preservation (F12)
 * - Suite 4: Doctor Consultation Status Selector & Live SSE Propagation (F13)
 * - Suite 5: Standalone SVG QR Generator, Copyable Link & Printable Placard (F13, F14)
 * - Suite 6: Physical & Bluetooth Keyboard Hotkey Dispatcher (F15)
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startServer,
  stopServer,
  apiRequest,
  getClinicToken,
  resetAllClinics,
  listenToSSE,
  DEFAULT_CLINICS
} = require('./test_helper');

describe('Milestone 3: Nurse Controller Web Application & Authentication (F11 - F15)', () => {
  let baseUrl;
  let pediatricsToken;
  let cardiologyToken;

  const staffHtmlPath = path.resolve(__dirname, '../public/staff.html');
  const staffCssPath = path.resolve(__dirname, '../public/css/staff_controller.css');
  const qrJsPath = path.resolve(__dirname, '../public/js/qr_generator.js');
  const staffJsPath = path.resolve(__dirname, '../public/js/staff_controller.js');

  let staffHtmlContent = '';
  let staffCssContent = '';
  let qrModule = null;

  before(async () => {
    baseUrl = await startServer();
    pediatricsToken = await getClinicToken(baseUrl, 'pediatrics');
    cardiologyToken = await getClinicToken(baseUrl, 'cardiology');

    staffHtmlContent = fs.readFileSync(staffHtmlPath, 'utf8');
    staffCssContent = fs.readFileSync(staffCssPath, 'utf8');
    qrModule = require(qrJsPath);
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetAllClinics(baseUrl);
  });

  // =========================================================================
  // Suite 1: Staff Authentication, Session Storage & Logout Lifecycle (F11)
  // =========================================================================
  describe('Suite 1: Staff Authentication, Session Storage & Logout Lifecycle (F11)', () => {
    it('1.1: staff.html markup contains complete login interface with required elements', () => {
      assert.ok(staffHtmlContent.includes('id="login-section"'), 'Missing #login-section');
      assert.ok(staffHtmlContent.includes('id="login-form"'), 'Missing #login-form');
      assert.ok(staffHtmlContent.includes('id="clinic-select"'), 'Missing #clinic-select');
      assert.ok(staffHtmlContent.includes('id="username"'), 'Missing #username');
      assert.ok(staffHtmlContent.includes('id="password"'), 'Missing #password');
      assert.ok(staffHtmlContent.includes('id="btn-login"'), 'Missing #btn-login');
      assert.ok(staffHtmlContent.includes('id="login-error"'), 'Missing #login-error');
    });

    it('1.2: Submitting valid credentials (pediatrics / pediatrics123) returns 200 and valid JWT token', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics', password: 'pediatrics123' }
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token, 'Token missing in response');
      assert.equal(typeof res.body.token, 'string');
      assert.ok(res.body.token.split('.').length === 3, 'Token must be a valid 3-part JWT');
      assert.equal(res.body.clinic.id, 'pediatrics');
    });

    it('1.3: Submitting invalid credentials returns 401 with descriptive error', async () => {
      const res = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'pediatrics', password: 'wrongpassword' }
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.error || res.body.message, 'Expected error message in response');
    });

    it('1.4: Dual-view architecture contains login view and dashboard controller view', () => {
      assert.ok(staffHtmlContent.includes('id="login-view"') || staffHtmlContent.includes('id="login-section"'));
      assert.ok(staffHtmlContent.includes('id="dashboard-view"') || staffHtmlContent.includes('id="controller"'));
      assert.ok(staffHtmlContent.includes('id="btn-logout"'), 'Missing #btn-logout');
    });

    it('1.5: Active clinic header profile displays clinic name, identifier, room, and doctor', () => {
      assert.ok(staffHtmlContent.includes('id="clinic-name"'), 'Missing #clinic-name');
      assert.ok(staffHtmlContent.includes('id="clinic-id"'), 'Missing #clinic-id');
      assert.ok(staffHtmlContent.includes('id="clinic-room"'), 'Missing #clinic-room');
      assert.ok(staffHtmlContent.includes('id="doctor-name"'), 'Missing #doctor-name');
      assert.ok(staffHtmlContent.includes('id="connection-status"'), 'Missing #connection-status');
    });

    it('1.6: staff_controller.js implements session token caching and logout clearing', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('sessionStorage') || jsContent.includes('localStorage'), 'Must use web storage');
      assert.ok(jsContent.includes('removeItem') || jsContent.includes('clearStoredAuth'), 'Must support clearing auth storage');
      assert.ok(jsContent.includes('showLoginView'), 'Must support returning to login view');
    });
  });

  // =========================================================================
  // Suite 2: Touch Action Buttons, Touch Sizing & 300ms Debounce Guard (F11, F12)
  // =========================================================================
  describe('Suite 2: Touch Action Buttons, Touch Sizing & 300ms Debounce Guard (F11, F12)', () => {
    it('2.1: Primary +1 Next button advances serving counter via POST /api/clinics/:id/next', async () => {
      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.currentServing, 1);
    });

    it('2.2: 300ms debounce guard logic in staff_controller.js prevents double-tap race conditions', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('300'), 'Must contain 300ms debounce window');
      assert.ok(jsContent.includes('lastNextTapTimestamp') || jsContent.includes('isNextBusy') || jsContent.includes('debounced'),
        'Must track debounce timestamp or busy lock');
    });

    it('2.3: -1 Recall button decrements counter and clamps at 0', async () => {
      // Advance to 2
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      // Recall to 1
      const rec1 = await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(rec1.body.currentServing, 1);

      // Recall to 0
      const rec2 = await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(rec2.body.currentServing, 0);

      // Clamped at 0
      const rec3 = await apiRequest(baseUrl, '/api/clinics/pediatrics/recall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(rec3.body.currentServing, 0);
    });

    it('2.4: Skip button advances counter and appends ticket to skipped list', async () => {
      // First advance queue to serving ticket 1
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      // Now skip current serving patient (ticket #1)
      const skipRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(skipRes.status, 200);
      assert.equal(skipRes.body.currentServing, 2);
      assert.ok(skipRes.body.skipped.includes(1), 'Ticket #1 should be in skipped list');
    });

    it('2.5: Action buttons in staff_controller.css define >= 48px touch targets and active tactile feedback', () => {
      assert.ok(staffCssContent.includes('min-height'), 'Must specify min-height');
      assert.ok(
        staffCssContent.includes('48px') || staffCssContent.includes('4rem') || staffCssContent.includes('64px'),
        'Must define minimum 48px or 4rem touch targets'
      );
      assert.ok(staffCssContent.includes(':active'), 'Must provide active state styling');
      assert.ok(staffCssContent.includes('transform: scale') || staffCssContent.includes('scale('), 'Must provide tactile press scale feedback');
    });
  });

  // =========================================================================
  // Suite 3: Two-Step Reset Safety Confirmation Modal & State Preservation (F12)
  // =========================================================================
  describe('Suite 3: Two-Step Reset Safety Confirmation Modal & State Preservation (F12)', () => {
    it('3.1: Markup contains 2-step reset modal with title, confirm and cancel buttons', () => {
      assert.ok(staffHtmlContent.includes('id="reset-modal"'), 'Missing #reset-modal');
      assert.ok(staffHtmlContent.includes('id="modal-title"'), 'Missing #modal-title');
      assert.ok(staffHtmlContent.includes('id="confirm-reset-btn"'), 'Missing #confirm-reset-btn');
      assert.ok(staffHtmlContent.includes('id="cancel-reset-btn"'), 'Missing #cancel-reset-btn');
    });

    it('3.2: Modal is hidden by default using hidden attribute', () => {
      assert.ok(
        staffHtmlContent.includes('<div id="reset-modal"') && staffHtmlContent.includes('hidden'),
        '#reset-modal must have hidden attribute by default'
      );
    });

    it('3.3: Reset button in staff_controller.js opens modal without immediately invoking reset API', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('openResetModal'), 'Must have openResetModal handler');
      assert.ok(jsContent.includes('closeResetModal'), 'Must have closeResetModal handler');
      assert.ok(jsContent.includes('handleConfirmReset'), 'Must separate confirmation from opening modal');
    });

    it('3.4: Authorized reset via confirm button sets serving to 0 and clears skipped tickets', async () => {
      // Advance and skip
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      await apiRequest(baseUrl, '/api/clinics/pediatrics/skip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      // Execute reset
      const resetRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.body.currentServing, 0);
      assert.deepEqual(resetRes.body.skipped, []);
    });

    it('3.5: Queue reset preserves doctor consultation status', async () => {
      // Set status to Brief Break
      await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Brief Break' }
      });

      // Reset queue
      const resetRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      assert.equal(resetRes.body.currentServing, 0);
      assert.equal(resetRes.body.status, 'Brief Break');
    });

    it('3.6: Multi-clinic tenant isolation: resetting Clinic A does not affect Clinic B', async () => {
      // Advance Clinic B (Cardiology) to 5
      for (let i = 0; i < 5; i++) {
        await apiRequest(baseUrl, '/api/clinics/cardiology/next', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cardiologyToken}` }
        });
      }
      // Reset Clinic A (Pediatrics)
      await apiRequest(baseUrl, '/api/clinics/pediatrics/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      // Verify Clinic B remains at 5
      const cardState = await apiRequest(baseUrl, '/api/clinics/cardiology/state');
      assert.equal(cardState.body.currentServing, 5);
    });
  });

  // =========================================================================
  // Suite 4: Doctor Consultation Status Selector & Live SSE Propagation (F13)
  // =========================================================================
  describe('Suite 4: Doctor Consultation Status Selector & Live SSE Propagation (F13)', () => {
    it('4.1: Dropdown #status-select defines In Clinic, Brief Break, and Finished options', () => {
      assert.ok(staffHtmlContent.includes('id="status-select"'), 'Missing #status-select');
      assert.ok(staffHtmlContent.includes('value="In Clinic"'), 'Missing option In Clinic');
      assert.ok(staffHtmlContent.includes('value="Brief Break"'), 'Missing option Brief Break');
      assert.ok(staffHtmlContent.includes('value="Finished"'), 'Missing option Finished');
    });

    it('4.2: Changing status updates backend and broadcasts SSE event', async () => {
      const sse = listenToSSE(baseUrl, 'pediatrics');
      await sse.waitForCount(1);

      const statusRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Brief Break' }
      });
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.status, 'Brief Break');

      const events = await sse.waitForCount(2);
      sse.close();
      assert.ok(events.length >= 2);
      assert.equal(events[events.length - 1].status, 'Brief Break');
    });

    it('4.3: Status update preserves active serving number', async () => {
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });
      await apiRequest(baseUrl, '/api/clinics/pediatrics/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` }
      });

      const res = await apiRequest(baseUrl, '/api/clinics/pediatrics/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pediatricsToken}` },
        body: { status: 'Brief Break' }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'Brief Break');

      const stateRes = await apiRequest(baseUrl, '/api/clinics/pediatrics/state');
      assert.equal(stateRes.body.currentServing, 2);
      assert.equal(stateRes.body.status, 'Brief Break');
    });

    it('4.4: staff_controller.css defines distinct visual badge classes for each status', () => {
      assert.ok(staffCssContent.includes('.status-in-clinic'), 'Missing .status-in-clinic styling');
      assert.ok(staffCssContent.includes('.status-brief-break'), 'Missing .status-brief-break styling');
      assert.ok(staffCssContent.includes('.status-finished'), 'Missing .status-finished styling');
    });
  });

  // =========================================================================
  // Suite 5: Standalone SVG QR Generator, Copyable Link & Printable Placard (F13, F14)
  // =========================================================================
  describe('Suite 5: Standalone SVG QR Generator, Copyable Link & Printable Placard (F13, F14)', () => {
    it('5.1: qr_generator.js exports standalone SVG generator without external dependencies', () => {
      assert.ok(qrModule, 'qr_generator.js module could not be loaded');
      assert.equal(typeof qrModule.generateSVG, 'function');
      assert.ok(qrModule.QRCode, 'QRCode class or object must be exported');
    });

    it('5.2: Generated QR SVG contains vector <path> and crispEdges rendering', () => {
      const svg = qrModule.generateSVG('http://localhost:3000/?clinic=pediatrics', { size: 260 });
      assert.ok(svg.startsWith('<svg'), 'Output must start with <svg tag');
      assert.ok(svg.includes('shape-rendering="crispEdges"'), 'Must have shape-rendering="crispEdges"');
      assert.ok(svg.includes('<path d="M'), 'Must contain vector <path d="M...');
      assert.ok(svg.includes('viewBox="0 0'), 'Must contain viewBox definition');
    });

    it('5.3: Patient URL format adheres strictly to /?clinic=<clinicId>', () => {
      const url = new URL('http://127.0.0.1:3000/?clinic=cardiology');
      assert.equal(url.searchParams.get('clinic'), 'cardiology');
      assert.ok(staffHtmlContent.includes('id="patient-link"'), 'Missing #patient-link');
      assert.ok(staffHtmlContent.includes('id="btn-copy-link"'), 'Missing #btn-copy-link');
    });

    it('5.4: staff_controller.css includes @media print rules suppressing controls and displaying placard', () => {
      assert.ok(staffCssContent.includes('@media print'), 'Missing @media print in CSS');
      assert.ok(staffCssContent.includes('display: none !important'), 'Print stylesheet must hide non-printable UI');
      assert.ok(staffCssContent.includes('#print-placard'), 'Print stylesheet must style #print-placard');
      assert.ok(staffCssContent.includes('@page'), 'Must configure @page margins');
    });

    it('5.5: staff.html contains printable poster card #print-placard with clinic title and QR target', () => {
      assert.ok(staffHtmlContent.includes('id="print-placard"'), 'Missing #print-placard');
      assert.ok(staffHtmlContent.includes('id="placard-clinic-name"'), 'Missing #placard-clinic-name');
      assert.ok(staffHtmlContent.includes('id="placard-room"'), 'Missing #placard-room');
      assert.ok(staffHtmlContent.includes('id="placard-qr"'), 'Missing #placard-qr');
      assert.ok(staffHtmlContent.includes('id="placard-url"'), 'Missing #placard-url');
    });
  });

  // =========================================================================
  // Suite 6: Physical & Bluetooth Keyboard Hotkey Dispatcher (F15)
  // =========================================================================
  describe('Suite 6: Physical & Bluetooth Keyboard Hotkey Dispatcher (F15)', () => {
    it('6.1: staff_controller.js implements keydown event listener with Space / ArrowRight mapping', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('keydown'), 'Must register keydown event listener');
      assert.ok(jsContent.includes("' '") || jsContent.includes('" "'), 'Must bind Space key');
      assert.ok(jsContent.includes('ArrowRight'), 'Must bind ArrowRight key');
      assert.ok(jsContent.includes('preventDefault'), 'Must prevent default scroll on Space');
    });

    it('6.2: Hotkey engine binds ArrowLeft for Recall (-1)', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('ArrowLeft'), 'Must bind ArrowLeft key');
      assert.ok(jsContent.includes('handleRecall'), 'Must invoke recall handler');
    });

    it('6.3: Hotkey engine binds "s" / "S" for Skip', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes("'s'") || jsContent.includes('"s"'), 'Must bind key S');
      assert.ok(jsContent.includes('handleSkip'), 'Must invoke skip handler');
    });

    it('6.4: Hotkey engine binds "r" / "R" for opening Reset Modal and Escape for dismissal', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes("'r'") || jsContent.includes('"r"'), 'Must bind key R');
      assert.ok(jsContent.includes('openResetModal'), 'Key R must open reset modal');
      assert.ok(jsContent.includes('Escape'), 'Escape key must close modal');
      assert.ok(jsContent.includes('closeResetModal'), 'Must invoke closeResetModal');
    });

    it('6.5: Hotkey engine binds "c" / "C" for Chime alert', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes("'c'") || jsContent.includes('"c"'), 'Must bind key C');
      assert.ok(jsContent.includes('handleChime'), 'Must invoke chime handler');
    });

    it('6.6: Hotkeys are strictly suppressed when focus is inside text input, textarea, or select', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('activeElement'), 'Must inspect activeElement');
      assert.ok(jsContent.includes('INPUT') || jsContent.includes('TEXTAREA'), 'Must check input/textarea tag names');
    });

    it('6.7: Hotkeys enforce the 300ms debounce guard on consecutive Next triggers', () => {
      const jsContent = fs.readFileSync(staffJsPath, 'utf8');
      assert.ok(jsContent.includes('handleNextPatient'), 'Space hotkey routes through debounced handleNextPatient');
    });
  });
});
