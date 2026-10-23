/**
 * @file queue_model.js
 * Pure Domain Model & State Machine for a single clinic queue.
 */

const ALLOWED_STATUSES = Object.freeze([
  'In Clinic',
  'Brief Break',
  'Finished'
]);

class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
  }
}

class DomainValidationError extends DomainError {
  constructor(message) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

class QueueModel {
  /**
   * @param {Object} params
   * @param {string} params.clinicId - Unique clinic identifier
   * @param {string} [params.name] - Human-readable clinic name
   * @param {string} [params.room=''] - Consultation room
   * @param {string} [params.doctorName=''] - Attending physician
   * @param {number} [params.currentServing=0] - Initial ticket counter
   * @param {string} [params.status='In Clinic'] - Initial consultation status
   * @param {number[]} [params.skipped=[]] - Initial skipped ticket numbers
   * @param {string} [params.lastUpdated] - ISO timestamp
   * @param {number} [params.averageServiceMinutes=8] - Estimated duration
   * @param {Array} [params.recentHistory=[]] - Audit log of recent transitions
   */
  constructor({
    clinicId,
    name,
    room = '',
    doctorName = '',
    currentServing = 0,
    status = 'In Clinic',
    skipped = [],
    lastUpdated = new Date().toISOString(),
    averageServiceMinutes = 8,
    recentHistory = []
  } = {}) {
    if (!clinicId || typeof clinicId !== 'string' || clinicId.trim() === '') {
      throw new DomainValidationError('clinicId must be a non-empty string');
    }
    this.clinicId = clinicId.trim();
    this.name = (typeof name === 'string' && name.trim()) ? name.trim() : this.clinicId;
    this.room = typeof room === 'string' ? room.trim() : '';
    this.doctorName = typeof doctorName === 'string' ? doctorName.trim() : '';

    this.currentServing = QueueModel.validateInteger(currentServing, 'currentServing', 0);
    this.status = QueueModel.validateStatus(status);
    this.skipped = QueueModel.validateSkippedArray(skipped);
    this.lastUpdated = QueueModel.validateTimestamp(lastUpdated);
    this.averageServiceMinutes = typeof averageServiceMinutes === 'number' && averageServiceMinutes > 0
      ? averageServiceMinutes
      : 8;
    this.recentHistory = Array.isArray(recentHistory) ? [...recentHistory].slice(-20) : [];
  }

  get currentNumber() {
    return this.currentServing;
  }

  static validateInteger(val, fieldName, minValue = 0) {
    const num = Number(val);
    if (!Number.isSafeInteger(num) || num < minValue) {
      throw new DomainValidationError(`${fieldName} must be a safe integer >= ${minValue}, got: ${val}`);
    }
    return num;
  }

  static validateStatus(status) {
    if (!ALLOWED_STATUSES.includes(status)) {
      throw new DomainValidationError(
        `Invalid status: "${status}". Allowed values: ${ALLOWED_STATUSES.join(', ')}`
      );
    }
    return status;
  }

  static validateSkippedArray(arr) {
    if (!Array.isArray(arr)) {
      throw new DomainValidationError('skipped must be an array of ticket numbers');
    }
    const clean = [];
    for (const item of arr) {
      const num = Number(item);
      if (!Number.isSafeInteger(num) || num <= 0) {
        throw new DomainValidationError(`Invalid skipped ticket: ${item}. Must be integer > 0`);
      }
      if (!clean.includes(num)) {
        clean.push(num);
      }
    }
    return clean;
  }

  static validateTimestamp(ts) {
    if (typeof ts !== 'string' || isNaN(Date.parse(ts))) {
      return new Date().toISOString();
    }
    return ts;
  }

  _addHistory(entry) {
    this.recentHistory.push(entry);
    if (this.recentHistory.length > 20) {
      this.recentHistory = this.recentHistory.slice(-20);
    }
  }

  /**
   * Advance to next patient (+1)
   * Auto-resumes status to 'In Clinic' if currently paused or finished.
   * @returns {Object} Updated clinic snapshot
   */
  nextPatient() {
    if (this.currentServing >= Number.MAX_SAFE_INTEGER) {
      throw new DomainError('Maximum ticket number reached');
    }
    if (this.status === 'Brief Break' || this.status === 'Finished') {
      this.status = 'In Clinic';
    }
    const previous = this.currentServing;
    this.currentServing += 1;
    const now = new Date().toISOString();
    this.lastUpdated = now;
    this._addHistory({
      action: 'next',
      previousNumber: previous,
      newNumber: this.currentServing,
      timestamp: now
    });
    return this.toJSON();
  }

  /**
   * Alias for nextPatient()
   */
  next() {
    return this.nextPatient();
  }

  /**
   * Recall / Undo previous patient (-1), floor-clamped at 0
   * @returns {Object} Updated clinic snapshot
   */
  recallPatient() {
    const previous = this.currentServing;
    this.currentServing = Math.max(0, this.currentServing - 1);
    const now = new Date().toISOString();
    this.lastUpdated = now;
    this._addHistory({
      action: 'recall',
      previousNumber: previous,
      newNumber: this.currentServing,
      timestamp: now
    });
    return this.toJSON();
  }

  /**
   * Alias for recallPatient()
   */
  recall() {
    return this.recallPatient();
  }

  /**
   * Skip current patient: records current ticket in skipped registry and advances (+1)
   * @returns {Object} Updated clinic snapshot
   */
  skipPatient() {
    if (this.currentServing === 0) {
      throw new DomainError('Cannot skip patient when queue counter is at 0');
    }
    if (!this.skipped.includes(this.currentServing)) {
      this.skipped.push(this.currentServing);
    }
    const previous = this.currentServing;
    this.currentServing += 1;
    const now = new Date().toISOString();
    this.lastUpdated = now;
    this._addHistory({
      action: 'skip',
      skippedNumber: previous,
      newNumber: this.currentServing,
      timestamp: now
    });
    return this.toJSON();
  }

  /**
   * Alias for skipPatient()
   */
  skip() {
    return this.skipPatient();
  }

  /**
   * Reset queue counter to 0 (or startNumber) and clear skipped registry.
   * STRICT SAFETY GUARD: Requires { confirm: true } or { confirmReset: true }
   * @param {Object} options
   * @param {boolean} [options.confirm]
   * @param {boolean} [options.confirmReset]
   * @param {number} [options.startNumber=0]
   * @returns {Object} Updated clinic snapshot
   */
  resetQueue(options = {}) {
    if (!options || (options.confirm !== true && options.confirmReset !== true)) {
      throw new DomainError('Confirmation required: queue reset requires { confirm: true } or { confirmReset: true }');
    }
    const startNumber = (typeof options.startNumber === 'number' && Number.isSafeInteger(options.startNumber) && options.startNumber >= 0)
      ? options.startNumber
      : 0;
    this.currentServing = startNumber;
    this.skipped = [];
    this.status = 'In Clinic';
    this.recentHistory = [];
    this.lastUpdated = new Date().toISOString();
    return this.toJSON();
  }

  /**
   * Update doctor consultation status ('In Clinic', 'Brief Break', 'Finished')
   * @param {string} status
   * @returns {Object} Updated clinic snapshot
   */
  setStatus(status) {
    this.status = QueueModel.validateStatus(status);
    this.lastUpdated = new Date().toISOString();
    return this.toJSON();
  }

  /**
   * Return clean state object snapshot
   */
  getState() {
    return this.toJSON();
  }

  /**
   * Exports an immutable, clean plain JavaScript snapshot
   */
  toJSON() {
    return {
      clinicId: this.clinicId,
      name: this.name,
      room: this.room,
      doctorName: this.doctorName,
      currentServing: this.currentServing,
      status: this.status,
      skipped: [...this.skipped],
      lastUpdated: this.lastUpdated,
      averageServiceMinutes: this.averageServiceMinutes,
      recentHistory: [...this.recentHistory]
    };
  }

  /**
   * Factory method to reconstruct QueueModel from JSON or persistence record
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new DomainValidationError('Invalid data for QueueModel.fromJSON');
    }
    return new QueueModel({
      clinicId: data.clinicId || data.id,
      name: data.name,
      room: data.room,
      doctorName: data.doctorName,
      currentServing: data.currentServing,
      status: data.status,
      skipped: data.skipped,
      lastUpdated: data.lastUpdated,
      averageServiceMinutes: data.averageServiceMinutes,
      recentHistory: data.recentHistory
    });
  }
}

module.exports = {
  ALLOWED_STATUSES,
  DomainError,
  DomainValidationError,
  QueueModel
};
