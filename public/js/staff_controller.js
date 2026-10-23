/**
 * @file public/js/staff_controller.js
 * Dedicated Clinic Staff Queue Controller (Features F11, F12, F13, F14, F15)
 * Pure Vanilla JavaScript ES6+ implementation.
 */

(function () {
  'use strict';

  // --- State Machine ---
  const State = {
    token: null,
    clinic: null, // { id, name, room, doctorName }
    currentServing: 0,
    status: 'In Clinic',
    skipped: [],
    eventSource: null,
    lastNextTapTimestamp: 0,
    isNextBusy: false,
    isResetBusy: false
  };

  // Storage keys
  const TOKEN_KEY = 'clinic_staff_token';
  const PROFILE_KEY = 'clinic_staff_profile';

  // --- Storage Helpers ---
  function getStoredToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) ||
             sessionStorage.getItem('auth_token') || localStorage.getItem('auth_token');
    } catch (e) {
      return null;
    }
  }

  function setStoredToken(token) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem('auth_token', token);
    } catch (e) {}
  }

  function getStoredProfile() {
    try {
      const raw = sessionStorage.getItem(PROFILE_KEY) || localStorage.getItem(PROFILE_KEY) ||
                  sessionStorage.getItem('current_clinic') || localStorage.getItem('current_clinic');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setStoredProfile(profile) {
    try {
      const json = JSON.stringify(profile);
      sessionStorage.setItem(PROFILE_KEY, json);
      sessionStorage.setItem('current_clinic', json);
    } catch (e) {}
  }

  function clearStoredAuth() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem('auth_token');
      sessionStorage.removeItem(PROFILE_KEY);
      sessionStorage.removeItem('current_clinic');
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem('auth_token');
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem('current_clinic');
    } catch (e) {}
  }

  // --- UI Error & Notification Banner ---
  function showErrorBanner(message) {
    const banner = document.getElementById('error-banner');
    const msgEl = document.getElementById('error-message');
    if (banner && msgEl) {
      msgEl.textContent = message;
      banner.hidden = false;
    }
  }

  function hideErrorBanner() {
    const banner = document.getElementById('error-banner');
    if (banner) {
      banner.hidden = true;
    }
  }

  // --- View Switcher ---
  function showLoginView() {
    const loginView = document.getElementById('login-view') || document.getElementById('login-section');
    const loginSection = document.getElementById('login-section');
    const dashboardView = document.getElementById('dashboard-view') || document.getElementById('controller');
    const controller = document.getElementById('controller');

    if (loginView) loginView.hidden = false;
    if (loginSection) loginSection.hidden = false;
    if (dashboardView) dashboardView.hidden = true;
    if (controller && controller !== dashboardView) controller.hidden = true;

    if (State.eventSource) {
      State.eventSource.close();
      State.eventSource = null;
    }
    State.token = null;
    State.clinic = null;
  }

  function showDashboardView(clinic) {
    const loginView = document.getElementById('login-view') || document.getElementById('login-section');
    const loginSection = document.getElementById('login-section');
    const dashboardView = document.getElementById('dashboard-view') || document.getElementById('controller');
    const controller = document.getElementById('controller');

    if (loginView) loginView.hidden = true;
    if (loginSection) loginSection.hidden = true;
    if (dashboardView) dashboardView.hidden = false;
    if (controller) controller.hidden = false;

    hideErrorBanner();
    updateClinicProfileUI(clinic);
    generatePlacardAndQR(clinic);
    connectSSE(clinic.id);
    fetchClinicState(clinic.id);
  }

  // --- Clinic Metadata & Profile Display ---
  function updateClinicProfileUI(clinic) {
    if (!clinic) return;
    State.clinic = clinic;

    const nameEl = document.getElementById('clinic-name');
    const idEl = document.getElementById('clinic-id');
    const roomEl = document.getElementById('clinic-room');
    const docEl = document.getElementById('doctor-name');
    const controllerEl = document.getElementById('controller');

    if (nameEl) nameEl.textContent = clinic.name || 'عيادة كشف';
    if (idEl) idEl.style.display = 'none';
    if (roomEl) roomEl.textContent = toArabicDigits(clinic.room || 'غرفة ١٠١');
    if (docEl) docEl.textContent = clinic.doctorName || '';
    if (controllerEl) controllerEl.dataset.clinicId = clinic.id || '';

    // Print placard metadata
    const placardClinicName = document.getElementById('placard-clinic-name');
    const placardRoom = document.getElementById('placard-room');
    const onscreenClinicName = document.getElementById('onscreen-clinic-name');
    const onscreenRoom = document.getElementById('onscreen-room-number');
    const printPlacard = document.getElementById('print-placard');

    if (placardClinicName) placardClinicName.textContent = clinic.name || '';
    if (placardRoom) placardRoom.textContent = toArabicDigits(clinic.room || 'غرفة ١٠١');
    if (onscreenClinicName) onscreenClinicName.textContent = clinic.name || '';
    if (onscreenRoom) onscreenRoom.textContent = toArabicDigits(clinic.room || 'غرفة ١٠١');
    if (printPlacard) printPlacard.dataset.clinicId = clinic.id || '';
  }

  // --- QR Code Placard Generator (Feature F13, F14) ---
  function generatePlacardAndQR(clinic) {
    if (!clinic || !clinic.id) return;
    const origin = window.location.origin || `${window.location.protocol}//${window.location.host}`;
    const patientUrl = `${origin}/?clinic=${encodeURIComponent(clinic.id)}`;

    // Patient Link
    const patientLink = document.getElementById('patient-link');
    if (patientLink) {
      patientLink.href = `/?clinic=${encodeURIComponent(clinic.id)}`;
      patientLink.textContent = patientUrl;
    }

    const placardUrlEl = document.getElementById('placard-url');
    if (placardUrlEl) {
      placardUrlEl.textContent = patientUrl;
    }

    // QR Code Render
    const qrContainer = document.getElementById('qr-container');
    const placardQr = document.getElementById('placard-qr');

    let svgMarkup = '';
    if (typeof window.QRCode !== 'undefined' && typeof window.QRCode.generateSVG === 'function') {
      svgMarkup = window.QRCode.generateSVG(patientUrl, { size: 240, margin: 4 });
    } else if (typeof window.generateQRCodeSVG === 'function') {
      svgMarkup = window.generateQRCodeSVG(patientUrl, { size: 240, margin: 4 });
    }

    if (svgMarkup) {
      if (qrContainer) qrContainer.innerHTML = svgMarkup;
      if (placardQr) placardQr.innerHTML = svgMarkup;
    }
  }

  // --- Authenticated REST API Client ---
  async function apiMutate(action, body = null) {
    const token = State.token || getStoredToken();
    const clinic = State.clinic || getStoredProfile();

    if (!token || !clinic) {
      handleSessionExpired('Authentication required. Please sign in.');
      throw new Error('Unauthorized');
    }

    const clinicId = clinic.id;
    const url = `/api/clinics/${encodeURIComponent(clinicId)}/${action}`;
    const headers = {
      'Authorization': `Bearer ${token}`
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 401 || res.status === 403) {
      handleSessionExpired('Session expired or unauthorized. Please sign in again.');
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    updateDashboardUI(data);
    return data;
  }

  async function fetchClinicState(clinicId) {
    try {
      const res = await fetch(`/api/clinics/${encodeURIComponent(clinicId)}/state?t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        updateDashboardUI(data);
      }
    } catch (e) {
      // Offline or network error; SSE will provide state on connect
    }
  }

  function handleSessionExpired(msg) {
    clearStoredAuth();
    showLoginView();
    showErrorBanner(msg || 'Session expired. Please sign in.');
  }

  // --- Real-time SSE Stream Listener ---
  function connectSSE(clinicId) {
    if (State.eventSource) {
      State.eventSource.close();
    }

    const statusEl = document.getElementById('connection-status');
    const statusText = document.getElementById('connection-status-text');

    const sseUrl = `/api/clinics/${encodeURIComponent(clinicId)}/events`;
    const es = new EventSource(sseUrl);
    State.eventSource = es;

    es.onopen = () => {
      if (statusEl) {
        statusEl.className = 'conn-badge conn-online';
        if (statusText) statusText.textContent = 'متصل مباشرة';
      }
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateDashboardUI(data);
      } catch (e) {
        // Heartbeat comment or non-json message
      }
    };

    es.onerror = () => {
      if (statusEl) {
        statusEl.className = 'conn-badge conn-reconnecting';
        if (statusText) statusText.textContent = 'جارٍ الاتصال...';
      }
    };

    if (window._staffSyncTimer) clearInterval(window._staffSyncTimer);
    window._staffSyncTimer = setInterval(() => {
      if (State.clinic && State.clinic.id && State.token) {
        fetchClinicState(State.clinic.id);
      }
    }, 2500);
  }

  // --- Dashboard UI Sync ---
  function updateDashboardUI(data) {
    if (!data) return;

    // 1. Serving Number
    if (typeof data.currentServing !== 'undefined') {
      const isRecentMutation = State.lastMutationTime && (Date.now() - State.lastMutationTime < 3500);
      if (isRecentMutation && data.currentServing < State.currentServing) {
        // Ignore stale backward-moving poll from out-of-sync container right after mutation
      } else {
        State.currentServing = data.currentServing;
        const servingEl = document.getElementById('serving-number');
        if (servingEl) {
          servingEl.textContent = toArabicDigits(data.currentServing);
          servingEl.dataset.serving = String(data.currentServing);
        }
      }
    }

    // 2. Doctor Consultation Status
    if (data.status) {
      State.status = data.status;
      const statusSelect = document.getElementById('status-select');
      const statusBadge = document.getElementById('status-badge');

      if (statusSelect && statusSelect.value !== data.status) {
        statusSelect.value = data.status;
      }
      if (statusBadge) {
        let label = 'في العيادة (كشف نشط)';
        if (data.status === 'Brief Break' || data.status === 'استراحة قصيرة') label = 'استراحة قصيرة للطبيب';
        else if (data.status === 'Finished' || data.status === 'انتهت العيادة') label = 'انتهت العيادة';
        statusBadge.textContent = label;
        statusBadge.dataset.status = data.status;
        statusBadge.className = 'status-badge ' + getStatusClass(data.status);
      }

      // Update 3 status buttons styling
      const btnInClinic = document.getElementById('status-btn-in-clinic');
      const btnBreak = document.getElementById('status-btn-break');
      const btnFinished = document.getElementById('status-btn-finished');
      if (btnInClinic && btnBreak && btnFinished) {
        const isClinic = (data.status === 'In Clinic' || data.status === 'في العيادة');
        const isBreak = (data.status === 'Brief Break' || data.status === 'استراحة قصيرة');
        const isFinished = (data.status === 'Finished' || data.status === 'انتهت العيادة');

        btnInClinic.style.background = isClinic ? '#dcfce7' : '#ffffff';
        btnInClinic.style.borderColor = isClinic ? '#16a34a' : '#cbd5e1';
        btnInClinic.style.color = isClinic ? '#15803d' : '#64748b';

        btnBreak.style.background = isBreak ? '#fef3c7' : '#ffffff';
        btnBreak.style.borderColor = isBreak ? '#d97706' : '#cbd5e1';
        btnBreak.style.color = isBreak ? '#b45309' : '#64748b';

        btnFinished.style.background = isFinished ? '#fee2e2' : '#ffffff';
        btnFinished.style.borderColor = isFinished ? '#dc2626' : '#cbd5e1';
        btnFinished.style.color = isFinished ? '#b91c1c' : '#64748b';
      }
    }

    // 3. Skipped Tickets List
    if (Array.isArray(data.skipped)) {
      State.skipped = data.skipped;
      renderSkippedList(data.skipped);
    }
  }

  function getStatusClass(status) {
    switch (status) {
      case 'In Clinic':
        return 'status-in-clinic';
      case 'Brief Break':
        return 'status-brief-break';
      case 'Finished':
        return 'status-finished';
      default:
        return 'status-in-clinic';
    }
  }

  function renderSkippedList(skipped) {
    const container = document.getElementById('skipped-list');
    const countEl = document.getElementById('skipped-count');
    if (!container) return;

    if (countEl) countEl.textContent = toArabicDigits(skipped.length);

    if (!skipped || skipped.length === 0) {
      container.innerHTML = '<span id="skipped-empty" class="text-muted">لا توجد أرقام متخطاة</span>';
      return;
    }

    container.innerHTML = '';
    skipped.forEach(num => {
      const badge = document.createElement('span');
      badge.className = 'skipped-badge';
      badge.textContent = `تذكرة ${toArabicDigits(num)}`;
      container.appendChild(badge);
    });
  }

  // Helper to convert numbers to Arabic numerals ٠-٩
  function toArabicDigits(str) {
    if (str === null || str === undefined) return '';
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return String(str).replace(/[0-9]/g, d => arabicDigits[d]);
  }

  // --- 300ms Debounced Next Patient Handler (Feature F11, F12) ---
  // --- Instant Optimistic Next Patient Handler ---
  async function handleNextPatient() {
    if (State.isNextBusy) return;
    State.isNextBusy = true;
    State.lastMutationTime = Date.now();

    const btnNext = document.getElementById('btn-next');
    if (btnNext) {
      btnNext.disabled = true;
      btnNext.style.opacity = '0.6';
      btnNext.style.cursor = 'wait';
    }

    const prevServing = State.currentServing;
    State.currentServing = prevServing + 1;
    const servingEl = document.getElementById('serving-number');
    if (servingEl) {
      servingEl.textContent = toArabicDigits(State.currentServing);
      servingEl.dataset.serving = String(State.currentServing);
    }

    try {
      const data = await apiMutate('next');
      if (data && typeof data.currentServing !== 'undefined') {
        State.currentServing = data.currentServing;
        if (servingEl) servingEl.textContent = toArabicDigits(data.currentServing);
      }
    } catch (err) {
      State.currentServing = prevServing;
      if (servingEl) servingEl.textContent = toArabicDigits(prevServing);
      showErrorBanner('فشل في مناداة المريض التالي: ' + err.message);
    } finally {
      State.isNextBusy = false;
      if (btnNext) {
        btnNext.disabled = false;
        btnNext.style.opacity = '1';
        btnNext.style.cursor = 'pointer';
      }
    }
  }

  // --- Instant Optimistic Recall Handler ---
  async function handleRecall() {
    if (State.isRecallBusy) return;
    State.isRecallBusy = true;
    State.lastMutationTime = Date.now();

    const btnRecall = document.getElementById('btn-recall');
    if (btnRecall) {
      btnRecall.disabled = true;
      btnRecall.style.opacity = '0.6';
    }

    const prevServing = State.currentServing;
    State.currentServing = Math.max(0, prevServing - 1);
    const servingEl = document.getElementById('serving-number');
    if (servingEl) {
      servingEl.textContent = toArabicDigits(State.currentServing);
      servingEl.dataset.serving = String(State.currentServing);
    }

    try {
      const data = await apiMutate('recall');
      if (data && typeof data.currentServing !== 'undefined') {
        State.currentServing = data.currentServing;
        if (servingEl) servingEl.textContent = toArabicDigits(data.currentServing);
      }
    } catch (err) {
      State.currentServing = prevServing;
      if (servingEl) servingEl.textContent = toArabicDigits(prevServing);
      showErrorBanner('فشل في التراجع: ' + err.message);
    } finally {
      State.isRecallBusy = false;
      if (btnRecall) {
        btnRecall.disabled = false;
        btnRecall.style.opacity = '1';
      }
    }
  }

  // --- Skip Handler ---
  async function handleSkip() {
    if (State.isSkipBusy) return;
    State.isSkipBusy = true;
    State.lastMutationTime = Date.now();

    const btnSkip = document.getElementById('btn-skip');
    if (btnSkip) {
      btnSkip.disabled = true;
      btnSkip.style.opacity = '0.6';
    }

    try {
      await apiMutate('skip');
    } catch (err) {
      showErrorBanner('فشل في تخطي المريض: ' + err.message);
    } finally {
      State.isSkipBusy = false;
      if (btnSkip) {
        btnSkip.disabled = false;
        btnSkip.style.opacity = '1';
      }
    }
  }

  // --- Chime Handler (Optional) ---
  async function handleChime() {
    try {
      await apiMutate('chime');
    } catch (err) {
      // quiet
    }
  }

  // --- 2-Step Reset Modal Controller (Feature F12) ---
  function openResetModal() {
    const modal = document.getElementById('reset-modal');
    if (modal) {
      modal.hidden = false;
      modal.removeAttribute('hidden');
      const cancelBtn = document.getElementById('cancel-reset-btn');
      if (cancelBtn) cancelBtn.focus();
    }
  }

  function closeResetModal() {
    const modal = document.getElementById('reset-modal');
    if (modal) {
      modal.hidden = true;
      modal.setAttribute('hidden', '');
    }
  }

  function isResetModalOpen() {
    const modal = document.getElementById('reset-modal');
    return modal && !modal.hidden && modal.getAttribute('hidden') === null;
  }

  async function handleConfirmReset() {
    if (State.isResetBusy) return;
    State.isResetBusy = true;

    const confirmBtn = document.getElementById('confirm-reset-btn');
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      await apiMutate('reset');
      closeResetModal();
    } catch (err) {
      showErrorBanner('Failed to reset queue: ' + err.message);
    } finally {
      State.isResetBusy = false;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // --- Copy Link & Print Handlers ---
  function handleCopyLink() {
    const patientLink = document.getElementById('patient-link');
    const feedback = document.getElementById('copy-feedback');
    const url = patientLink ? (patientLink.href || patientLink.textContent) : window.location.href;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        showCopyFeedback(feedback);
      }).catch(() => {
        fallbackCopy(url, feedback);
      });
    } else {
      fallbackCopy(url, feedback);
    }
  }

  function fallbackCopy(text, feedback) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showCopyFeedback(feedback);
    } catch (e) {
      showErrorBanner('Could not copy link to clipboard');
    }
    document.body.removeChild(textarea);
  }

  function showCopyFeedback(feedback) {
    if (feedback) {
      feedback.hidden = false;
      setTimeout(() => {
        feedback.hidden = true;
      }, 2000);
    }
  }

  // --- Dedicated Standalone Print Placard Controller ---
  function handlePrintPlacard() {
    const clinic = State.clinic || getStoredProfile() || { id: 'pediatrics', name: 'عيادة الأطفال وحديثي الولادة', room: 'غرفة 101' };
    const origin = window.location.origin || `${window.location.protocol}//${window.location.host}`;
    const patientUrl = `${origin}/?clinic=${encodeURIComponent(clinic.id)}`;
    
    let qrSvg = '';
    if (typeof window.QRCode !== 'undefined' && typeof window.QRCode.generateSVG === 'function') {
      qrSvg = window.QRCode.generateSVG(patientUrl, { size: 280, margin: 4 });
    } else if (typeof window.generateQRCodeSVG === 'function') {
      qrSvg = window.generateQRCodeSVG(patientUrl, { size: 280, margin: 4 });
    }

    const printWin = window.open('', '_blank', 'width=850,height=950');
    if (!printWin) {
      window.print();
      return;
    }

    printWin.document.write(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <title>طباعة لافتة العيادة - ${clinic.name || 'مجمع الإصلاح الطبي'}</title>
        <style>
          @page { size: A4 portrait; margin: 1cm; }
          * { box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
            margin: 0;
            padding: 1.5cm 1cm;
            text-align: center;
            background: #ffffff;
            color: #0f172a;
          }
          .poster {
            border: 4px solid #0f766e;
            border-radius: 20px;
            padding: 2.5rem 1.5rem;
            max-width: 650px;
            margin: 0 auto;
          }
          .logo {
            max-height: 80px;
            width: auto;
            margin-bottom: 0.75rem;
          }
          .hospital-title {
            font-size: 1.8rem;
            font-weight: 800;
            color: #0f766e;
            margin: 0 0 0.5rem 0;
          }
          .clinic-name {
            font-size: 2.2rem;
            font-weight: 900;
            color: #0284c7;
            margin: 0.5rem 0;
          }
          .clinic-room {
            font-size: 1.3rem;
            font-weight: 700;
            color: #475569;
            margin-bottom: 1.5rem;
          }
          .qr-box {
            margin: 1.25rem auto;
            display: inline-block;
            padding: 14px;
            border: 3px solid #0f172a;
            border-radius: 16px;
            background: #ffffff;
          }
          .qr-box svg {
            display: block;
            width: 280px;
            height: 280px;
          }
          .instruction {
            font-size: 1.5rem;
            font-weight: 800;
            margin: 1.25rem 0 0.5rem;
          }
          .sub-instruction {
            font-size: 1.15rem;
            color: #475569;
            margin-bottom: 1.25rem;
            line-height: 1.6;
          }
          .url-box {
            font-family: monospace;
            font-size: 1.1rem;
            font-weight: 700;
            color: #0369a1;
            direction: ltr;
            padding: 0.5rem 1rem;
            background: #f1f5f9;
            border-radius: 8px;
            display: inline-block;
          }
          .footer {
            margin-top: 2rem;
            font-size: 0.95rem;
            color: #64748b;
            border-top: 1px solid #cbd5e1;
            padding-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="poster">
          <img src="${origin}/images/islah-medical-logo.png" alt="مجمع الإصلاح الطبي" class="logo" onerror="this.style.display='none'">
          <div class="hospital-title">مجمع الإصلاح الطبي</div>
          <div class="clinic-name">${clinic.name || 'عيادة كشف'}</div>
          <div class="clinic-room">${clinic.room ? clinic.room + ' &bull; ' : ''}${clinic.doctorName || ''}</div>
          
          <div class="instruction">امسح الرمز بكاميرا جوالك لمتابعة دورك مباشرة</div>
          <div class="sub-instruction">
            تابع رقمك لحظة بلحظة على هاتفك من أي مكان خارج المستشفى أو بالمقهى<br>
            دون الحاجة للجلوس والانتظار في الزحام.
          </div>

          <div class="qr-box">
            ${qrSvg}
          </div>

          <div class="footer">
            مجمع الإصلاح الطبي - المنصورة &bull; هاتف واستفسار: 01000620720
          </div>
        </div>
        <script>
          window.onload = function() {
            setTimeout(function() {
              window.print();
            }, 300);
          };
        <\/script>
      </body>
      </html>
    `);
    printWin.document.close();
  }

  // --- Keyboard Shortcuts Engine (Feature F15) ---
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // 1. Text input focus suppression (Feature F15-4)
      const activeEl = document.activeElement;
      const activeTag = activeEl ? activeEl.tagName : '';
      const isTextInput = ['INPUT', 'TEXTAREA'].includes(activeTag) ||
        (activeTag === 'SELECT' && e.key !== 'Escape');

      if (isTextInput) {
        if (e.key === 'Escape') {
          closeResetModal();
          activeEl.blur();
        }
        return;
      }

      // 2. Ensure controller dashboard is active and authenticated
      const dashboard = document.getElementById('dashboard-view') || document.getElementById('controller');
      if (!dashboard || dashboard.hidden) return;

      // 3. Modal-specific hotkeys
      if (isResetModalOpen()) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeResetModal();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          handleConfirmReset();
          return;
        }
        return; // Don't trigger queue mutations while modal is open
      }

      // 4. Standard Queue Hotkeys
      const key = e.key;

      // Next Patient: Space or ArrowRight (Feature F15-1 & F15-5)
      if (key === ' ' || key === 'ArrowRight' || key === 'Enter') {
        e.preventDefault(); // Suppress window scroll on Space
        handleNextPatient();
        return;
      }

      // Recall / Undo: ArrowLeft (Feature F15-2)
      if (key === 'ArrowLeft' || key === 'u' || key === 'U') {
        e.preventDefault();
        handleRecall();
        return;
      }

      // Skip Patient: 's' or 'S' (Feature F15-3)
      if (key === 's' || key === 'S') {
        e.preventDefault();
        handleSkip();
        return;
      }

      // Ring Chime: 'c' or 'C'
      if (key === 'c' || key === 'C') {
        e.preventDefault();
        handleChime();
        return;
      }

      // Open Reset Modal: 'r' or 'R'
      if (key === 'r' || key === 'R') {
        e.preventDefault();
        openResetModal();
        return;
      }

      // Escape: Dismiss
      if (key === 'Escape') {
        e.preventDefault();
        closeResetModal();
        return;
      }
    });
  }

  // --- Attach DOM Event Handlers ---
  function initDOMEvents() {
    // 1. Login Form Submit
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const loginError = document.getElementById('login-error');
        if (loginError) loginError.hidden = true;

        const clinicSelect = document.getElementById('clinic-select') || document.getElementById('login-clinic-id');
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password') || document.getElementById('login-password');

        const selectedClinic = clinicSelect ? clinicSelect.value : '';
        const rawUsername = usernameInput ? usernameInput.value.trim() : '';
        const username = rawUsername || selectedClinic;
        const password = passwordInput ? passwordInput.value : '';

        if (!username || !password) {
          if (loginError) {
            loginError.textContent = 'Please select a clinic (or enter username) and enter password.';
            loginError.hidden = false;
          }
          return;
        }

        const btnLogin = document.getElementById('btn-login');
        if (btnLogin) btnLogin.disabled = true;

        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || data.error || 'Authentication failed');
          }

          // Successful login
          State.token = data.token;
          State.clinic = data.clinic;
          setStoredToken(data.token);
          setStoredProfile(data.clinic);

          showDashboardView(data.clinic);
        } catch (err) {
          if (loginError) {
            loginError.textContent = err.message || 'Invalid credentials';
            loginError.hidden = false;
          }
        } finally {
          if (btnLogin) btnLogin.disabled = false;
        }
      });
    }

    // 2. Clinic Select auto-sync username
    const clinicSelect = document.getElementById('clinic-select') || document.getElementById('login-clinic-id');
    const usernameInput = document.getElementById('username');
    if (clinicSelect && usernameInput) {
      clinicSelect.addEventListener('change', () => {
        if (!usernameInput.value || clinicSelect.value) {
          usernameInput.value = clinicSelect.value;
        }
      });
    }

    // 3. Logout Button
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        clearStoredAuth();
        showLoginView();
      });
    }

    // 4. Action Buttons Grid
    const btnNext = document.getElementById('btn-next');
    if (btnNext) btnNext.addEventListener('click', handleNextPatient);

    const btnRecall = document.getElementById('btn-recall');
    if (btnRecall) btnRecall.addEventListener('click', handleRecall);

    const btnSkip = document.getElementById('btn-skip');
    if (btnSkip) btnSkip.addEventListener('click', handleSkip);

    const btnChime = document.getElementById('btn-chime');
    if (btnChime) btnChime.addEventListener('click', handleChime);

    const btnReset = document.getElementById('btn-reset');
    if (btnReset) btnReset.addEventListener('click', openResetModal);

    // 5. Doctor Status Selector & 3-Button Toggle
    document.querySelectorAll('.btn-status').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetStatus = btn.dataset.status;
        try {
          await apiMutate('status', { status: targetStatus });
        } catch (err) {
          showErrorBanner('فشل في تحديث حالة الطبيب: ' + err.message);
        }
      });
    });

    const statusSelect = document.getElementById('status-select');
    if (statusSelect) {
      statusSelect.addEventListener('change', async () => {
        const newStatus = statusSelect.value;
        try {
          await apiMutate('status', { status: newStatus });
        } catch (err) {
          showErrorBanner('Failed to update status: ' + err.message);
        }
      });
    }

    // 6. Reset Modal Buttons & Overlay
    const confirmResetBtn = document.getElementById('confirm-reset-btn');
    if (confirmResetBtn) confirmResetBtn.addEventListener('click', handleConfirmReset);

    const cancelResetBtn = document.getElementById('cancel-reset-btn');
    if (cancelResetBtn) cancelResetBtn.addEventListener('click', closeResetModal);

    const resetModal = document.getElementById('reset-modal');
    if (resetModal) {
      resetModal.addEventListener('click', (e) => {
        if (e.target === resetModal) {
          closeResetModal();
        }
      });
    }

    // 7. Copy Patient Link
    const btnCopyLink = document.getElementById('btn-copy-link');
    if (btnCopyLink) btnCopyLink.addEventListener('click', handleCopyLink);

    // 8. Print Placard Buttons
    const btnPrintPlacard = document.getElementById('btn-print-placard') || document.getElementById('btn-print-poster');
    if (btnPrintPlacard) btnPrintPlacard.addEventListener('click', handlePrintPlacard);

    const btnPrintPoster = document.getElementById('btn-print-poster');
    if (btnPrintPoster && btnPrintPoster !== btnPrintPlacard) {
      btnPrintPoster.addEventListener('click', handlePrintPlacard);
    }

    // 9. Error Banner Dismiss
    const btnCloseBanner = document.getElementById('btn-close-banner');
    if (btnCloseBanner) btnCloseBanner.addEventListener('click', hideErrorBanner);
  }

  // --- Session Bootstrapping ---
  function init() {
    initDOMEvents();
    initKeyboardShortcuts();

    const token = getStoredToken();
    const profile = getStoredProfile();

    if (token && profile && profile.id) {
      State.token = token;
      State.clinic = profile;
      showDashboardView(profile);
    } else {
      showLoginView();
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export methods for test runner if running in Node / JSDOM
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      State,
      handleNextPatient,
      handleRecall,
      handleSkip,
      handleChime,
      openResetModal,
      closeResetModal,
      handleConfirmReset,
      updateDashboardUI,
      apiMutate,
      init
    };
  }
})();
