/**
 * @file src/persistence/upstash_adapter.js
 * Zero-cost, zero-dependency persistence adapter for Upstash Redis & Vercel KV.
 * Implements loadState() and saveState(data) with in-memory caching and TTL.
 */

class UpstashRedisAdapter {
  /**
   * @param {object} [options={}]
   * @param {string} [options.url] - Upstash REST URL or KV_REST_API_URL
   * @param {string} [options.token] - Upstash REST Token or KV_REST_API_TOKEN
   * @param {string} [options.key='islah_clinic_queues'] - Storage key
   * @param {number} [options.cacheTtlMs=1200] - Cache TTL in ms to optimize free tier quotas
   */
  constructor(options = {}) {
    this.url = (options.url || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
    this.token = options.token || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
    this.key = options.key || 'islah_clinic_queues';
    this.cacheTtlMs = options.cacheTtlMs || 1200;
    this.cachedData = null;
    this.lastFetchTime = 0;
    this.isCloud = true;
  }

  isConfigured() {
    return Boolean(this.url && this.token);
  }

  async loadState(force = false) {
    if (!this.isConfigured()) return null;
    const now = Date.now();
    if (!force && this.cachedData && (now - this.lastFetchTime < this.cacheTtlMs)) {
      return this.cachedData;
    }

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['GET', this.key])
      });

      if (!res.ok) {
        console.warn(`[UpstashAdapter] GET HTTP ${res.status}: ${res.statusText}`);
        return this.cachedData;
      }

      const body = await res.json();
      if (!body || body.result === null || body.result === undefined) {
        return null;
      }

      let parsed = body.result;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          return null;
        }
      }

      this.cachedData = parsed;
      this.lastFetchTime = Date.now();
      return parsed;
    } catch (err) {
      console.warn('[UpstashAdapter] loadState fetch failed:', err.message);
      return this.cachedData;
    }
  }

  async saveState(data) {
    if (!this.isConfigured() || !data) return;
    this.cachedData = data;
    this.lastFetchTime = Date.now();

    try {
      const stringified = typeof data === 'string' ? data : JSON.stringify(data);
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', this.key, stringified])
      });

      if (!res.ok) {
        console.warn(`[UpstashAdapter] SET HTTP ${res.status}: ${res.statusText}`);
      }
    } catch (err) {
      console.warn('[UpstashAdapter] saveState fetch failed:', err.message);
    }
  }

  async read() {
    return this.loadState();
  }

  async save(data) {
    return this.saveState(data);
  }
}

module.exports = { UpstashRedisAdapter };
