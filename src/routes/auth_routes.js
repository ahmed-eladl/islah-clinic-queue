/**
 * @file auth_routes.js
 * Dedicated Clinic Staff Authentication Routes (Feature F02)
 */

const express = require('express');
const router = express.Router();

const { verifyClinicCredentials } = require('../config/app_config.js');
const { generateToken } = require('../auth/token_service.js');

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Response 200: { token, clinic: { id, name } }
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  // 1. Validation: username and password must be non-empty strings
  if (!username || typeof username !== 'string' || !username.trim() ||
      !password || typeof password !== 'string' || !password.trim()) {
    return res.status(400).json({
      error: 'Username and password required',
      message: 'Username and password required'
    });
  }

  // 2. Credential verification via PBKDF2 constant-time check
  const clinic = verifyClinicCredentials(username.trim(), password);
  if (!clinic) {
    return res.status(401).json({
      error: 'Invalid clinic credentials',
      message: 'Invalid clinic credentials'
    });
  }

  // 3. Issue scoped HMAC-SHA256 session token
  const token = generateToken({
    clinicId: clinic.id,
    role: 'staff'
  });

  // 4. Return compliant token response
  return res.status(200).json({
    token,
    clinic: {
      id: clinic.id,
      name: clinic.name
    }
  });
});

module.exports = router;
