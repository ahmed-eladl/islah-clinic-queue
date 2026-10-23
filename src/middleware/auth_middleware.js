/**
 * @file auth_middleware.js
 * Security Middleware for Multi-Clinic Authentication & Authorization Guards
 * Enforces 401 (Unauthorized) and 403 (Forbidden) invariants.
 */

const { verifyToken, extractBearerToken } = require('../auth/token_service.js');
const { getClinicById } = require('../config/app_config.js');

/**
 * Express middleware to authenticate staff bearer tokens
 */
function authenticateStaff(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = extractBearerToken(authHeader);

  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Missing or malformed Authorization header"');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Missing or malformed Authorization header. Expected Bearer token.'
    });
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Invalid or expired session token"');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired session token'
    });
  }

  // Attach authenticated claims to request object
  req.auth = payload;
  next();
}

/**
 * Express middleware to enforce clinic-level multi-tenant authorization
 */
function authorizeClinic(req, res, next) {
  if (!req.auth || !req.auth.clinicId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication context missing'
    });
  }

  const rawClinicId = (req.params && (req.params.clinicId || req.params.id)) || (req.body && req.body.clinicId);
  if (!rawClinicId) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Target clinicId parameter is required'
    });
  }

  const targetClinicId = String(rawClinicId).toLowerCase().trim();
  const knownClinic = getClinicById(targetClinicId);

  if (!knownClinic) {
    return res.status(404).json({
      error: 'Not Found',
      message: `Clinic '${targetClinicId}' not found`
    });
  }

  // Strict tenant boundary check
  if (req.auth.clinicId !== targetClinicId) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `Access denied: Staff of clinic '${req.auth.clinicId}' cannot mutate clinic '${targetClinicId}'`
    });
  }

  next();
}

/**
 * Composed convenience middleware combining authentication and clinic authorization
 */
const requireClinicStaff = [authenticateStaff, authorizeClinic];

module.exports = {
  authenticateStaff,
  authorizeClinic,
  requireClinicStaff
};
