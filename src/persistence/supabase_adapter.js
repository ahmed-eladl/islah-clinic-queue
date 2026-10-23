/**
 * @file src/persistence/supabase_adapter.js
 * Zero-dependency persistence adapter for Supabase PostgreSQL via PostgREST.
 * Implements loadState() and saveState(data) with in-memory caching and TTL.
 */

class SupabaseAdapter {
  /**
   * @param {object} [options={}]
   * @param {string} [options.url] - Supabase Project URL (e.g. https://xxx.supabase.co)
   * @param {string} [options.key] - Supabase Anon or Service Role API Key
   * @param {string} [options.table='clinic_queues'] - Storage table name
   * @param {string} [options.recordId='global'] - Primary key row identifier
   * @param {number} [options.cacheTtlMs=400] - In-memory cache TTL in ms
   */
  constructor(options = {}) {
    this.url = (options.url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    this.key = options.key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
    this.table = options.table || process.env.SUPABASE_TABLE || 'clinic_queues';
    this.recordId = options.recordId || 'global';
    this.cacheTtlMs = options.cacheTtlMs || 400;
    this.cachedData = null;
    this.lastFetchTime = 0;
    this.isCloud = true;
  }

  isConfigured() {
    return Boolean(this.url && this.key);
  }

  async loadState(force = false) {
    if (!this.isConfigured()) return null;
    const now = Date.now();
    if (!force && this.cachedData && (now - this.lastFetchTime < this.cacheTtlMs)) {
      return this.cachedData;
    }

    try {
      const endpoint = `${this.url}/rest/v1/${this.table}?id=eq.${encodeURIComponent(this.recordId)}&select=data`;
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'apikey': this.key,
          'Authorization': `Bearer ${this.key}`,
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
        if (res.status === 404 || res.status === 400) {
          console.warn(`[SupabaseAdapter] Table '${this.table}' not found (HTTP ${res.status}). Run: CREATE TABLE ${this.table} (id TEXT PRIMARY KEY, data JSONB);`);
        }
        return this.cachedData;
      }

      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].data) {
        this.cachedData = rows[0].data;
        this.lastFetchTime = Date.now();
        return this.cachedData;
      }
      return null;
    } catch (err) {
      console.warn('[SupabaseAdapter] loadState failed:', err.message);
      return this.cachedData;
    }
  }

  async saveState(data) {
    if (!this.isConfigured() || !data) return;
    this.cachedData = data;
    this.lastFetchTime = Date.now();

    try {
      const endpoint = `${this.url}/rest/v1/${this.table}`;
      const payload = {
        id: this.recordId,
        data: data
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'apikey': this.key,
          'Authorization': `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[SupabaseAdapter] saveState HTTP ${res.status}:`, text);
      }
    } catch (err) {
      console.warn('[SupabaseAdapter] saveState failed:', err.message);
    }
  }

  async read() {
    return this.loadState();
  }
}

module.exports = { SupabaseAdapter };
