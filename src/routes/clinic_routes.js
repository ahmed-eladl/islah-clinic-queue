/**
 * @file clinic_routes.js
 * Multi-Clinic Queue State Inspection, Mutation Endpoints, and Real-Time SSE Broadcasting
 * Live Clinic Queue Tracker (Features F07, F08, F09)
 */

const express = require('express');
const { authenticateStaff, authorizeClinic } = require('../middleware/auth_middleware.js');

/**
 * Handle SSE event stream connection for a clinic
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('../domain/queue_store').QueueStore} queueStore
 */
function handleClinicEvents(req, res, queueStore) {
  const rawClinicId = req.params.clinicId || req.params.id;
  if (!rawClinicId) {
    return res.status(400).json({ error: 'clinicId parameter is required' });
  }

  const clinicId = String(rawClinicId).toLowerCase().trim();

  // 1. Validate clinic existence in store
  let clinicState;
  try {
    clinicState = queueStore.getClinicState(clinicId);
  } catch (err) {
    return res.status(404).json({ error: `Clinic '${clinicId}' not found` });
  }

  // 2. Set strict SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // 3. Optional connection handshake comment
  res.write(': connected\n\n');

  // 4. Send immediate initial snapshot event (F08-2 compliance)
  const initialPayload = JSON.stringify({
    type: 'QUEUE_UPDATE',
    action: 'QUEUE_SNAPSHOT',
    clinicId: clinicState.clinicId || clinicId,
    name: clinicState.name,
    room: clinicState.room || '',
    doctorName: clinicState.doctorName || '',
    currentServing: clinicState.currentServing,
    status: clinicState.status,
    skipped: [...clinicState.skipped],
    averageServiceMinutes: clinicState.averageServiceMinutes || 8,
    timestamp: clinicState.lastUpdated || new Date().toISOString()
  });
  res.write(`data: ${initialPayload}\n\n`);

  if (typeof res.flush === 'function') {
    res.flush();
  }

  // 5. Subscribe to QueueStore domain mutations
  const unsubscribe = queueStore.subscribe(clinicId, (event) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (typeof res.flush === 'function') {
        res.flush();
      }
    }
  });

  // 6. Setup 15-second keepalive heartbeat comment
  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': heartbeat\n\n');
      if (typeof res.flush === 'function') {
        res.flush();
      }
    }
  }, 15000);

  if (heartbeatTimer.unref) {
    heartbeatTimer.unref();
  }

  // 7. Cleanup on client disconnect / abort
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeatTimer);
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
    if (!res.writableEnded) {
      try { res.end(); } catch {}
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

/**
 * Creates the Clinic Router with injected QueueStore instance
 * @param {import('../domain/queue_store').QueueStore} queueStore
 * @returns {express.Router}
 */
function createClinicRouter(queueStore) {
  const router = express.Router();

  // =========================================================================
  // 1. PUBLIC QUERY ENDPOINTS
  // =========================================================================

  /**
   * GET /api/clinics
   * Returns array of public clinic summaries
   */
  router.get('/', async (req, res) => {
    if (typeof queueStore.syncCloud === 'function') {
      await queueStore.syncCloud(false);
    }
    const all = queueStore.getAllClinics();
    const summaries = all.map(c => ({
      id: c.clinicId || c.id,
      name: c.name,
      currentServing: c.currentServing,
      status: c.status
    }));
    return res.status(200).json(summaries);
  });

  /**
   * GET /api/clinics/:clinicId/events & /:clinicId/stream
   * Real-time Server-Sent Events (SSE) stream
   */
  router.get('/:clinicId/events', (req, res) => {
    return handleClinicEvents(req, res, queueStore);
  });

  router.get('/:clinicId/stream', (req, res) => {
    return handleClinicEvents(req, res, queueStore);
  });

  /**
   * GET /api/clinics/:clinicId/state
   * Returns queue state snapshot for a specific clinic
   */
  router.get('/:clinicId/state', async (req, res) => {
    if (typeof queueStore.syncCloud === 'function') {
      await queueStore.syncCloud(false);
    }
    const clinicId = String(req.params.clinicId).toLowerCase().trim();
    if (!queueStore.hasClinic(clinicId)) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Clinic '${clinicId}' not found`
      });
    }

    const state = queueStore.getClinicState(clinicId);
    return res.status(200).json({
      id: state.clinicId || clinicId,
      name: state.name,
      currentServing: state.currentServing,
      status: state.status,
      skipped: [...state.skipped]
    });
  });

  /**
   * GET /api/clinics/:clinicId
   * Alias returning full clinic state
   */
  router.get('/:clinicId', async (req, res) => {
    if (typeof queueStore.syncCloud === 'function') {
      await queueStore.syncCloud(false);
    }
    const clinicId = String(req.params.clinicId).toLowerCase().trim();
    if (!queueStore.hasClinic(clinicId)) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Clinic '${clinicId}' not found`
      });
    }

    const state = queueStore.getClinicState(clinicId);
    return res.status(200).json({
      id: state.clinicId || clinicId,
      name: state.name,
      currentServing: state.currentServing,
      status: state.status,
      skipped: [...state.skipped]
    });
  });

  // =========================================================================
  // 2. PROTECTED MUTATION ENDPOINTS (Guarded by authenticateStaff & authorizeClinic)
  // =========================================================================
  const staffAuth = [authenticateStaff, authorizeClinic];

  /**
   * POST /api/clinics/:clinicId/next
   * Advances serving counter (+1)
   */
  router.post('/:clinicId/next', staffAuth, async (req, res, next) => {
    try {
      const clinicId = req.params.clinicId.toLowerCase().trim();
      const updatedState = await queueStore.nextPatient(clinicId);
      return res.status(200).json({
        success: true,
        currentServing: updatedState.currentServing,
        status: updatedState.status
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/clinics/:clinicId/recall
   * Recalls previous counter (-1), clamped at 0
   */
  router.post('/:clinicId/recall', staffAuth, async (req, res, next) => {
    try {
      const clinicId = req.params.clinicId.toLowerCase().trim();
      const updatedState = await queueStore.recallPatient(clinicId);
      return res.status(200).json({
        success: true,
        currentServing: updatedState.currentServing,
        status: updatedState.status
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/clinics/:clinicId/skip
   * Skips current patient; handles empty queue (0) safely (satisfies B1-4)
   */
  router.post('/:clinicId/skip', staffAuth, async (req, res, next) => {
    try {
      const clinicId = req.params.clinicId.toLowerCase().trim();
      const state = queueStore.getClinicState(clinicId);

      let updatedState;
      if (state.currentServing === 0) {
        // If at 0, advance to 1 without recording 0 in skipped list (satisfies B1-4)
        updatedState = await queueStore.nextPatient(clinicId);
      } else {
        updatedState = await queueStore.skipPatient(clinicId);
      }

      return res.status(200).json({
        success: true,
        currentServing: updatedState.currentServing,
        skipped: [...updatedState.skipped]
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/clinics/:clinicId/reset
   * Resets counter to 0, clears skipped list, preserves consultation status (satisfies F12-4)
   */
  router.post('/:clinicId/reset', staffAuth, async (req, res, next) => {
    try {
      const clinicId = req.params.clinicId.toLowerCase().trim();
      const existingState = queueStore.getClinicState(clinicId);
      const previousStatus = existingState.status;

      // Execute reset with confirm bypass
      await queueStore.resetQueue(clinicId, { confirm: true, ...req.body });

      // Preserve consultation status across reset (satisfies F12-4)
      if (previousStatus !== 'In Clinic') {
        await queueStore.setStatus(clinicId, previousStatus);
      }

      const finalState = queueStore.getClinicState(clinicId);
      return res.status(200).json({
        success: true,
        currentServing: 0,
        status: finalState.status,
        skipped: []
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/clinics/:clinicId/status
   * Updates doctor consultation status ('In Clinic', 'Brief Break', 'Finished')
   */
  router.post('/:clinicId/status', staffAuth, async (req, res, next) => {
    try {
      const clinicId = req.params.clinicId.toLowerCase().trim();
      const { status } = req.body || {};

      const allowedStatuses = ['In Clinic', 'Brief Break', 'Finished'];
      if (!status || typeof status !== 'string' || !allowedStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Status must be one of: ${allowedStatuses.join(', ')}`
        });
      }

      const updatedState = await queueStore.setStatus(clinicId, status);
      return res.status(200).json({
        success: true,
        status: updatedState.status
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/clinics/:clinicId/chime
   * Trigger audio chime confirmation
   */
  router.post('/:clinicId/chime', staffAuth, async (req, res, next) => {
    try {
      const clinicId = req.params.clinicId.toLowerCase().trim();
      const clinicState = queueStore.getClinicState(clinicId);

      // Emit chime event to subscribers
      queueStore.emit(clinicId, {
        type: 'QUEUE_UPDATE',
        action: 'CHIME',
        clinicId,
        currentServing: clinicState.currentServing,
        status: clinicState.status,
        skipped: [...clinicState.skipped],
        timestamp: new Date().toISOString()
      });

      return res.status(200).json({
        success: true,
        chimeTriggered: true
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  createClinicRouter,
  handleClinicEvents
};
