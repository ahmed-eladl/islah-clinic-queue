/**
 * @file src/routes/admin_routes.js
 * Admin Management Routes for Clinics Configuration & Password Protection
 */

const express = require('express');
const { authenticateAdmin } = require('../middleware/auth_middleware.js');
const { getAllClinics, upsertClinic, deleteClinic } = require('../config/app_config.js');

function createAdminRouter(queueStore) {
  const router = express.Router();

  // All admin routes require admin authentication
  router.use(authenticateAdmin);

  /**
   * GET /api/admin/clinics
   * Returns list of all clinics with current operational state
   */
  router.get('/clinics', async (req, res) => {
    if (typeof queueStore.syncCloud === 'function') {
      await queueStore.syncCloud(false);
    }

    const configs = getAllClinics();
    const result = configs.map(c => {
      let state = {};
      try {
        state = queueStore.getClinicState(c.id);
      } catch {}
      return {
        id: c.id,
        name: c.name,
        room: c.room,
        doctorName: c.doctorName,
        staffUsername: c.staffUsername,
        averageServiceMinutes: c.averageServiceMinutes,
        currentServing: typeof state.currentServing !== 'undefined' ? state.currentServing : 0,
        status: state.status || 'In Clinic'
      };
    });

    return res.status(200).json(result);
  });

  /**
   * POST /api/admin/clinics
   * Create or update a clinic
   */
  router.post('/clinics', async (req, res) => {
    const { id, name, room, doctorName, staffUsername, password, averageServiceMinutes } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'اسم العيادة بالعربية مطلوب' });
    }

    try {
      // Auto-generate ID if not provided (admin doesn't need to specify technical IDs)
      let cleanId = id ? String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
      if (!cleanId) {
        if (staffUsername && typeof staffUsername === 'string' && staffUsername.trim()) {
          cleanId = staffUsername.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        }
        if (!cleanId) {
          cleanId = 'clinic_' + Date.now().toString(36);
        }
      }

      const savedClinic = upsertClinic({
        id: cleanId,
        name: name.trim(),
        room: (room || 'غرفة ١٠١').trim(),
        doctorName: (doctorName || '').trim(),
        staffUsername: (staffUsername || cleanId).trim(),
        password: password ? String(password).trim() : undefined,
        averageServiceMinutes: parseInt(averageServiceMinutes, 10) || 10
      });

      // Update in QueueStore
      queueStore.registerClinic(savedClinic);

      // Persist to Upstash Redis and storage
      await queueStore.persist();

      return res.status(200).json({
        success: true,
        message: 'تم حفظ العيادة بنجاح',
        clinic: {
          id: savedClinic.id,
          name: savedClinic.name,
          room: savedClinic.room,
          doctorName: savedClinic.doctorName,
          staffUsername: savedClinic.staffUsername,
          averageServiceMinutes: savedClinic.averageServiceMinutes
        }
      });
    } catch (err) {
      console.error('[AdminRouter Error]', err);
      return res.status(500).json({ error: 'فشل في حفظ العيادة: ' + err.message });
    }
  });

  /**
   * DELETE /api/admin/clinics/:id
   * Delete a clinic
   */
  router.delete('/clinics/:id', async (req, res) => {
    const clinicId = String(req.params.id || '').toLowerCase().trim();
    if (!clinicId) {
      return res.status(400).json({ error: 'معرف العيادة مطلوب' });
    }

    try {
      const deleted = deleteClinic(clinicId);
      if (deleted) {
        queueStore.removeClinic(clinicId);
        await queueStore.persist();
        return res.status(200).json({ success: true, message: `تم حذف العيادة '${clinicId}' بنجاح` });
      } else {
        return res.status(404).json({ error: 'العيادة غير موجودة' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'فشل في حذف العيادة: ' + err.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
