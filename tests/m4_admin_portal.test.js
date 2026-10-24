/**
 * @file tests/m4_admin_portal.test.js
 * Unit and integration tests for Admin Authentication and Clinic Management Endpoints
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../server.js');
const { createQueueStore } = require('../src/persistence/storage_factory.js');
const { getAllClinics, getClinicById } = require('../src/config/app_config.js');

describe('Admin Portal & Clinic Management Suite', () => {
  let server = null;
  let baseUrl = '';
  let adminToken = '';

  before(async () => {
    const queueStore = createQueueStore();
    const clinics = getAllClinics();
    for (const c of clinics) queueStore.registerClinic(c);
    const app = createApp(queueStore);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('should reject invalid admin password with 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong_password' })
    });
    assert.equal(res.status, 401);
  });

  it('should authenticate admin with default password and issue admin token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin123' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.token);
    assert.equal(data.role, 'admin');
    adminToken = data.token;
  });

  it('should reject unauthenticated requests to /api/admin/clinics with 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/clinics`);
    assert.equal(res.status, 401);
  });

  it('should list all clinics for authenticated admin', async () => {
    const res = await fetch(`${baseUrl}/api/admin/clinics`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 4);
    assert.ok(list.some(c => c.id === 'pediatrics'));
  });

  it('should allow admin to add a new clinic', async () => {
    const newClinic = {
      id: 'dermatology',
      name: 'عيادة الجلدية والتناسلية',
      room: 'غرفة ٢٠٨',
      doctorName: 'استشاري الأمراض الجلدية',
      staffUsername: 'dermatology',
      password: 'dermaPassword123',
      averageServiceMinutes: 12
    };

    const res = await fetch(`${baseUrl}/api/admin/clinics`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(newClinic)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.clinic.id, 'dermatology');

    // Verify it exists in public list
    const pubRes = await fetch(`${baseUrl}/api/clinics`);
    const pubList = await pubRes.json();
    assert.ok(pubList.some(c => c.id === 'dermatology'));
  });

  it('should allow admin to edit an existing clinic', async () => {
    const editPayload = {
      id: 'dermatology',
      name: 'عيادة الجلدية والتجميل والليزر',
      room: 'غرفة ٢٠٩',
      doctorName: 'دكتور أخصائي الجلدية',
      averageServiceMinutes: 15
    };

    const res = await fetch(`${baseUrl}/api/admin/clinics`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(editPayload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.clinic.name, 'عيادة الجلدية والتجميل والليزر');
    assert.equal(data.clinic.room, 'غرفة ٢٠٩');
  });

  it('should allow admin to delete a clinic', async () => {
    const res = await fetch(`${baseUrl}/api/admin/clinics/dermatology`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const check = getClinicById('dermatology');
    assert.equal(check, undefined);
  });
});
