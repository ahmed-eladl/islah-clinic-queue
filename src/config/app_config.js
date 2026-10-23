/**
 * @file app_config.js
 * Central Application Configuration & Clinic Metadata Registry
 * Zero-dependency, immutable runtime configuration.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Resolve project root directory reliably
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// Development default signing secret
const DEV_SESSION_SECRET = 'clinic-tracker-insecure-dev-secret-key-32bytes-min!';

let sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
if (!sessionSecret) {
  if (isProduction && !process.env.VERCEL) {
    console.warn('[SECURITY WARNING] SESSION_SECRET not provided in production. Using secure fallback.');
  }
  sessionSecret = 'islah-clinic-queue-production-secret-2026-auth-token-key';
}

const config = Object.freeze({
  env: NODE_ENV,
  isProduction,
  port: parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10),
  sessionSecret,
  tokenExpiresInSeconds: parseInt(process.env.TOKEN_EXPIRES_IN_SECONDS || '86400', 10), // 24 hours
  dataFile: process.env.DATA_FILE_PATH 
    ? path.resolve(process.env.DATA_FILE_PATH) 
    : path.join(PROJECT_ROOT, 'data', 'clinic_queues.json'),
  clinicsConfigFile: process.env.CLINICS_CONFIG_PATH
    ? path.resolve(process.env.CLINICS_CONFIG_PATH)
    : path.join(PROJECT_ROOT, 'src', 'config', 'clinics.json'),
  persistenceMode: process.env.PERSISTENCE_MODE || 'local', // 'local' | 'firebase'
  corsOrigin: process.env.CORS_ORIGIN || '*'
});

/**
 * Hash password with PBKDF2-SHA512
 * @param {string} password 
 * @param {string} saltHex (32-character hex string)
 * @returns {string} (128-character hex string)
 */
function hashPassword(password, saltHex) {
  return crypto.pbkdf2Sync(password, saltHex, 100000, 64, 'sha512').toString('hex');
}

/**
 * Safe constant-time comparison of two hex hashes
 * @param {string} hashA 
 * @param {string} hashB 
 * @returns {boolean}
 */
function timingSafeCompare(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return false;
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// In-memory clinic cache loaded from clinics.json
let clinicList = [];
const clinicMap = new Map();
const usernameMap = new Map();

/**
 * Load, validate, and index clinics configuration
 */
function loadClinicsConfig(customFilePath) {
  const filePath = customFilePath || config.clinicsConfigFile;
  let parsed = null;

  if (customFilePath && fs.existsSync(customFilePath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(customFilePath, 'utf8'));
    } catch (err) {
      throw new Error(`[AppConfig] Malformed JSON in clinics config (${customFilePath}): ${err.message}`);
    }
  }

  if (!parsed) {
    try {
      parsed = require('./clinics.json');
    } catch {
      if (fs.existsSync(filePath)) {
        try {
          parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
          throw new Error(`[AppConfig] Malformed JSON in clinics config (${filePath}): ${err.message}`);
        }
      }
    }
  }

  if (!parsed) {
    throw new Error(`[AppConfig] Clinics configuration file not found at: ${filePath}`);
  }

  const rawList = Array.isArray(parsed) 
    ? parsed 
    : (parsed.clinics && Array.isArray(parsed.clinics) ? parsed.clinics : Object.values(parsed.clinics || parsed));

  clinicList = [];
  clinicMap.clear();
  usernameMap.clear();

  for (const clinic of rawList) {
    if (!clinic.id || !clinic.name || !clinic.passwordHash || !clinic.salt) {
      throw new Error(`[AppConfig] Clinic entry missing required fields: ${JSON.stringify(clinic)}`);
    }

    const normalized = Object.freeze({
      id: clinic.id.toLowerCase().trim(),
      name: clinic.name.trim(),
      room: clinic.room ? clinic.room.trim() : 'Room 1',
      doctorName: clinic.doctorName ? clinic.doctorName.trim() : 'Attending Physician',
      staffUsername: (clinic.staffUsername || clinic.id).toLowerCase().trim(),
      salt: clinic.salt,
      passwordHash: clinic.passwordHash,
      averageServiceMinutes: Number.isInteger(clinic.averageServiceMinutes) && clinic.averageServiceMinutes > 0 
        ? clinic.averageServiceMinutes 
        : 10
    });

    clinicList.push(normalized);
    clinicMap.set(normalized.id, normalized);
    usernameMap.set(normalized.staffUsername, normalized);
  }

  return clinicList;
}

// Automatically load on initialization if file exists
if (fs.existsSync(config.clinicsConfigFile)) {
  loadClinicsConfig(config.clinicsConfigFile);
}

/**
 * Get internal clinic by ID (includes credential hashes)
 */
function getClinicById(id) {
  if (!id) return undefined;
  return clinicMap.get(id.toLowerCase().trim());
}

/**
 * Get internal clinic by staff username
 */
function getClinicByUsername(username) {
  if (!username) return undefined;
  return usernameMap.get(username.toLowerCase().trim());
}

/**
 * Get all clinics (internal list)
 */
function getAllClinics() {
  return [...clinicList];
}

/**
 * Sanitized public clinic view for patients and unauthenticated APIs
 */
function sanitizeClinic(clinic) {
  if (!clinic) return null;
  return {
    id: clinic.id,
    name: clinic.name,
    room: clinic.room,
    doctorName: clinic.doctorName,
    averageServiceMinutes: clinic.averageServiceMinutes
  };
}

/**
 * Get all clinics sanitized (safe for GET /api/clinics)
 */
function getPublicClinics() {
  return clinicList.map(sanitizeClinic);
}

/**
 * Get single clinic sanitized (safe for GET /api/clinics/:id)
 */
function getPublicClinicById(id) {
  return sanitizeClinic(getClinicById(id));
}

/**
 * Verify clinic staff credentials
 * Matches by clinicId OR staffUsername
 * @returns {object|null} Sanitized clinic if valid, null if invalid
 */
function verifyClinicCredentials(identifier, password) {
  if (!identifier || !password || typeof identifier !== 'string' || typeof password !== 'string') {
    return null;
  }

  const clinic = getClinicByUsername(identifier) || getClinicById(identifier);
  if (!clinic) {
    // Constant-time dummy hash to resist username enumeration via timing attacks
    hashPassword('dummy_password_timing_pad', '00112233445566778899aabbccddeeff');
    return null;
  }

  const calculatedHash = hashPassword(password, clinic.salt);
  const isValid = timingSafeCompare(calculatedHash, clinic.passwordHash);

  return isValid ? sanitizeClinic(clinic) : null;
}

module.exports = {
  config,
  hashPassword,
  timingSafeCompare,
  loadClinicsConfig,
  getClinicById,
  getClinicByUsername,
  getAllClinics,
  getPublicClinics,
  getPublicClinicById,
  verifyClinicCredentials,
  sanitizeClinic
};
