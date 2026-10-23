/**
 * @file token_service.js
 * Stateless HMAC-SHA256 Session Token Generator & Verifier
 * Compliant with RFC 7519 JWT format using native node:crypto.
 */

const crypto = require('node:crypto');
const { config } = require('../config/app_config.js');

/**
 * Base64URL encode a buffer or UTF-8 string
 */
function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64url');
}

/**
 * Base64URL decode to UTF-8 string
 */
function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

class TokenService {
  /**
   * @param {string} [secret] - Optional secret key override
   */
  constructor(secret = null) {
    this.secret = secret;
  }

  /**
   * Generate a cryptographically signed HMAC-SHA256 token
   * 
   * @param {string|object} clinicIdOrPayload - Clinic ID or payload object
   * @param {object} [options]
   * @param {string} [options.role='staff'] - Role claim
   * @param {number} [options.expiresIn] - Expiration window in seconds
   * @param {number} [options.expiresInSeconds] - Expiration window in seconds
   * @param {string} [options.secret] - Token signing secret override
   * @param {number} [options.now] - Current timestamp override
   * @returns {string} 3-part compact JWT string
   */
  generateToken(clinicIdOrPayload, options = {}) {
    let clinicId;
    let role = 'staff';

    if (typeof clinicIdOrPayload === 'object' && clinicIdOrPayload !== null) {
      clinicId = clinicIdOrPayload.clinicId;
      role = clinicIdOrPayload.role || options.role || 'staff';
    } else {
      clinicId = clinicIdOrPayload;
      role = options.role || 'staff';
    }

    if (!clinicId || typeof clinicId !== 'string' || clinicId.trim() === '') {
      throw new TypeError('[TokenService] clinicId must be a non-empty string');
    }

    const secret = options.secret || this.secret || config.sessionSecret;
    if (!secret || typeof secret !== 'string') {
      throw new Error('[TokenService] Secret must be a non-empty string');
    }

    const expiresIn = typeof options.expiresInSeconds === 'number'
      ? options.expiresInSeconds
      : (typeof options.expiresIn === 'number' ? options.expiresIn : config.tokenExpiresInSeconds);

    const now = typeof options.now === 'number' ? options.now : Math.floor(Date.now() / 1000);

    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const payload = {
      clinicId: clinicId.toLowerCase().trim(),
      role,
      iat: now,
      exp: now + expiresIn
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const dataToSign = `${headerB64}.${payloadB64}`;

    const signature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('base64url');

    return `${dataToSign}.${signature}`;
  }

  /**
   * Verify an HMAC-SHA256 token and extract validated claims
   * 
   * @param {string} token - The 3-part compact token
   * @param {object} [options]
   * @param {string} [options.secret] - Secret override
   * @param {number} [options.now] - Current timestamp override (for testing)
   * @returns {object|null} Payload object with claims if valid, null if invalid
   */
  verifyToken(token, options = {}) {
    if (!token || typeof token !== 'string') {
      return null;
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) {
      return null;
    }

    const secret = options.secret || this.secret || config.sessionSecret;
    if (!secret) {
      return null;
    }

    // 1. Signature Verification with Constant-Time Comparison
    const dataToVerify = `${headerB64}.${payloadB64}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(dataToVerify)
      .digest('base64url');

    const providedSigBuf = Buffer.from(signatureB64);
    const expectedSigBuf = Buffer.from(expectedSignature);

    if (providedSigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)) {
      return null;
    }

    // 2. Header Parsing & Algorithm Lockdown
    let header;
    try {
      header = JSON.parse(base64UrlDecode(headerB64));
    } catch {
      return null;
    }

    if (!header || header.alg !== 'HS256') {
      return null;
    }

    // 3. Payload Parsing & Claim Validation
    let payload;
    try {
      payload = JSON.parse(base64UrlDecode(payloadB64));
    } catch {
      return null;
    }

    if (!payload || typeof payload !== 'object') {
      return null;
    }

    // 4. Expiration Validation
    const currentTime = typeof options.now === 'number' ? options.now : Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= currentTime) {
      return null;
    }

    // 5. Future Issuance Check (Clock Skew Tolerance: 60 seconds)
    if (typeof payload.iat === 'number' && payload.iat > currentTime + 60) {
      return null;
    }

    // 6. Required Claims Check
    if (!payload.clinicId || typeof payload.clinicId !== 'string' || payload.clinicId.trim() === '') {
      return null;
    }

    return {
      valid: true,
      clinicId: payload.clinicId,
      role: payload.role || 'staff',
      iat: payload.iat,
      exp: payload.exp
    };
  }
}

const defaultTokenService = new TokenService();

function generateToken(clinicIdOrPayload, options) {
  return defaultTokenService.generateToken(clinicIdOrPayload, options);
}

function verifyToken(token, options) {
  return defaultTokenService.verifyToken(token, options);
}

/**
 * Helper to extract Bearer token from HTTP Authorization header
 */
function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

module.exports = {
  TokenService,
  defaultTokenService,
  generateToken,
  verifyToken,
  extractBearerToken,
  base64UrlEncode,
  base64UrlDecode
};
