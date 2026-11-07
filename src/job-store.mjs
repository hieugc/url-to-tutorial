import { mkdirSync } from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MAX_STORED_JOBS = 40;
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const EMPTY_AUDIT_HASH = '0'.repeat(64);
const terminal = job => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status);

export class StudioJobStore {
  constructor(outputRoot, { auditKey = null } = {}) {
    if (auditKey !== null && typeof auditKey !== 'string' && !Buffer.isBuffer(auditKey)) {
      throw new TypeError('Cloud audit signing key must be a string or Buffer');
    }
    const resolvedAuditKey = auditKey === null ? null : Buffer.from(auditKey);
    if (resolvedAuditKey && resolvedAuditKey.length < 32) {
      throw new TypeError('Cloud audit signing key must contain at least 32 bytes');
    }
    const root = path.resolve(outputRoot);
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'studio-jobs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.auditKey = resolvedAuditKey;
    this.db.exec('CREATE TABLE IF NOT EXISTS studio_jobs (' +
      'id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_job_submissions (' +
      'job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_job_submissions_tenant_time ' +
      'ON cloud_job_submissions(tenant_id, created_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_request_events (' +
      'event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_request_events_tenant_time ' +
      'ON cloud_request_events(tenant_id, created_at_ms)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_usage_events (' +
      'job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, ' +
      'period TEXT NOT NULL, job_type TEXT NOT NULL, outcome TEXT NOT NULL, ' +
      'worker_ms INTEGER NOT NULL, artifact_bytes INTEGER NOT NULL, cost_micros INTEGER NOT NULL, ' +
      'created_at TEXT NOT NULL, finalized_at TEXT NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_usage_events_tenant_period ' +
      'ON cloud_usage_events(tenant_id, period)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_storage_usage (' +
      'job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, ' +
      'bytes INTEGER NOT NULL, updated_at TEXT NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_storage_usage_tenant ' +
      'ON cloud_storage_usage(tenant_id)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_storage_reservations (' +
      'job_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, created_at TEXT NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_storage_reservations_tenant ' +
      'ON cloud_storage_reservations(tenant_id)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_audit_events (' +
      'event_id TEXT PRIMARY KEY, sequence INTEGER, previous_hash TEXT, event_hash TEXT, ' +
      'tenant_id TEXT NOT NULL, project_id TEXT, principal_id TEXT, action TEXT NOT NULL, ' +
      'resource_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT)');
    const auditColumns = new Set(this.db.prepare('PRAGMA table_info(cloud_audit_events)')
      .all().map(column => column.name));
    for (const [name, type] of [['sequence', 'INTEGER'], ['previous_hash', 'TEXT'], ['event_hash', 'TEXT']]) {
      if (!auditColumns.has(name)) this.db.exec('ALTER TABLE cloud_audit_events ADD COLUMN ' + name + ' ' + type);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_audit_events_tenant_time ' +
      'ON cloud_audit_events(tenant_id, created_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_audit_state (' +
      'id INTEGER PRIMARY KEY CHECK(id=1), last_sequence INTEGER NOT NULL, last_hash TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO cloud_audit_state (id, last_sequence, last_hash) VALUES (1, 0, ?)')
      .run(EMPTY_AUDIT_HASH);
    this.put = this.db.prepare('INSERT INTO studio_jobs (id, created_at, updated_at, json) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json');
    this.recordCloudSubmission = this.db.prepare('INSERT OR IGNORE INTO cloud_job_submissions ' +
      '(job_id, tenant_id, project_id, created_at) VALUES (?, ?, ?, ?)');
    this.countCloudSubmissionsStatement = this.db.prepare(
      'SELECT COUNT(*) AS count FROM cloud_job_submissions WHERE tenant_id=? AND created_at>=?');
    this.pruneCloudSubmissionsStatement = this.db.prepare(
      'DELETE FROM cloud_job_submissions WHERE created_at<?');
    this.pruneCloudRequestsStatement = this.db.prepare(
      'DELETE FROM cloud_request_events WHERE created_at_ms<?');
    this.countCloudRequestsStatement = this.db.prepare(
      'SELECT COUNT(*) AS count, MIN(created_at_ms) AS oldest FROM cloud_request_events ' +
      'WHERE tenant_id=? AND created_at_ms>=?');
    this.insertCloudRequestStatement = this.db.prepare(
      'INSERT INTO cloud_request_events (event_id, tenant_id, created_at_ms) VALUES (?, ?, ?)');
    this.reserveCloudStorageStatement = this.db.prepare(
      'INSERT INTO cloud_storage_reservations (job_id, tenant_id, reserved_bytes, created_at) VALUES (?, ?, ?, ?)');
    this.storageTotalsStatement = this.db.prepare(
      'SELECT COALESCE((SELECT SUM(bytes) FROM cloud_storage_usage WHERE tenant_id=?), 0) AS used, ' +
      'COALESCE((SELECT SUM(reserved_bytes) FROM cloud_storage_reservations WHERE tenant_id=?), 0) AS reserved');
    this.monthlyUsageStatement = this.db.prepare(
      'SELECT COUNT(*) AS jobs, COALESCE(SUM(worker_ms), 0) AS workerMs, ' +
      'COALESCE(SUM(artifact_bytes), 0) AS artifactBytes, COALESCE(SUM(cost_micros), 0) AS costMicros ' +
      'FROM cloud_usage_events WHERE tenant_id=? AND period=?');
    this.monthlyReservationsStatement = this.db.prepare(
      'SELECT COUNT(*) AS count FROM cloud_storage_reservations WHERE tenant_id=?');
    this.hasCloudUsageStatement = this.db.prepare(
      'SELECT 1 AS present FROM cloud_usage_events WHERE job_id=?');
    this.insertCloudUsageStatement = this.db.prepare(
      'INSERT INTO cloud_usage_events (job_id, tenant_id, project_id, period, job_type, outcome, worker_ms, artifact_bytes, cost_micros, created_at, finalized_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET ' +
      'outcome=excluded.outcome, worker_ms=excluded.worker_ms, artifact_bytes=excluded.artifact_bytes, ' +
      'cost_micros=excluded.cost_micros, finalized_at=excluded.finalized_at');
    this.insertCloudStorageStatement = this.db.prepare(
      'INSERT INTO cloud_storage_usage (job_id, tenant_id, project_id, bytes, updated_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(job_id) DO UPDATE SET bytes=excluded.bytes, updated_at=excluded.updated_at');
    this.deleteCloudStorageReservationStatement = this.db.prepare(
      'DELETE FROM cloud_storage_reservations WHERE job_id=?');
    this.deleteCloudStorageUsageStatement = this.db.prepare(
      'DELETE FROM cloud_storage_usage WHERE job_id=?');
    this.insertCloudAuditStatement = this.db.prepare(
      'INSERT INTO cloud_audit_events (event_id, sequence, previous_hash, event_hash, tenant_id, project_id, principal_id, action, resource_id, outcome, created_at, details) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.listCloudAuditStatement = this.db.prepare(
      'SELECT event_id AS eventId, sequence, previous_hash AS previousHash, event_hash AS eventHash, ' +
      'tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, ' +
      'action, resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events WHERE tenant_id=? ORDER BY sequence, rowid');
    this.auditStateStatement = this.db.prepare(
      'SELECT last_sequence AS lastSequence, last_hash AS lastHash FROM cloud_audit_state WHERE id=1');
    this.updateAuditStateStatement = this.db.prepare(
      'UPDATE cloud_audit_state SET last_sequence=?, last_hash=? WHERE id=1');
    this.auditRowsStatement = this.db.prepare(
      'SELECT event_id AS eventId, sequence, previous_hash AS previousHash, event_hash AS eventHash, ' +
      'tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, action, ' +
      'resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events ORDER BY sequence, rowid');
    this.legacyAuditRowsStatement = this.db.prepare(
      'SELECT event_id AS eventId, tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, ' +
      'action, resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events ORDER BY rowid');
    this.updateAuditRowStatement = this.db.prepare(
      'UPDATE cloud_audit_events SET sequence=?, previous_hash=?, event_hash=? WHERE event_id=?');
    this.deleteStatement = this.db.prepare('DELETE FROM studio_jobs WHERE id=?');
    if (this.auditKey) {
      try {
        this.initializeAuditChain();
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cloud_audit_events_sequence ON cloud_audit_events(sequence)');
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }

  save(job) {
    const snapshot = { ...job };
    delete snapshot.abortController;
    delete snapshot._deduplicated;
    const now = new Date().toISOString();
    this.put.run(snapshot.id, snapshot.createdAt || now, now, JSON.stringify(snapshot));
  }

  reserveCloudStorage(jobId, tenantId, bytes, budgetBytes, createdAt) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 ||
        !Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
      throw new TypeError('Invalid cloud storage reservation');
    }
    const totals = this.storageTotalsStatement.get(tenantId, tenantId);
    const used = Number(totals.used || 0);
    const reserved = Number(totals.reserved || 0);
    if (used + reserved + bytes > budgetBytes) {
      const error = new Error('Tenant storage budget exceeded');
      error.code = 'CLOUD_STORAGE_BUDGET';
      throw error;
    }
    this.reserveCloudStorageStatement.run(jobId, tenantId, bytes, createdAt);
  }

  finalizeCloudUsage(job, { workerMs, artifactBytes, costMicros = 0, period, outcome } = {}, auditEvent = null) {
    if (!job?.id || !job.tenantId || !job.projectId ||
        !Number.isSafeInteger(workerMs) || workerMs < 0 ||
        !Number.isSafeInteger(artifactBytes) || artifactBytes < 0 ||
        !Number.isSafeInteger(costMicros) || costMicros < 0 ||
        typeof period !== 'string' || !/^\d{4}-\d{2}$/.test(period)) {
      throw new TypeError('Invalid cloud usage finalization');
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteCloudStorageReservationStatement.run(job.id);
      this.insertCloudStorageStatement.run(job.id, job.tenantId, job.projectId, artifactBytes, now);
      this.insertCloudUsageStatement.run(
        job.id, job.tenantId, job.projectId, period, job.type, outcome || job.status,
        workerMs, artifactBytes, costMicros, job.createdAt, now,
      );
      if (auditEvent) this.insertCloudAudit(auditEvent);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  hasCloudUsage(jobId) {
    return Boolean(this.hasCloudUsageStatement.get(jobId));
  }

  cloudUsage(tenantId, period) {
    const usage = this.monthlyUsageStatement.get(tenantId, period);
    const storage = this.storageTotalsStatement.get(tenantId, tenantId);
    return {
      period, jobs: Number(usage.jobs || 0), workerMs: Number(usage.workerMs || 0),
      artifactBytes: Number(usage.artifactBytes || 0), costMicros: Number(usage.costMicros || 0),
      storageBytes: Number(storage.used || 0), reservedStorageBytes: Number(storage.reserved || 0),
    };
  }

  deleteCloudUsage(jobId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteCloudStorageReservationStatement.run(jobId);
      this.deleteCloudStorageUsageStatement.run(jobId);
      // Monthly usage events are financial/accounting records and outlive job artifacts.
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveCloudSubmission(job, auditEvent = null, storage = null) {
    if (!job?.tenantId || !job?.projectId || !job?.id || !job?.createdAt) {
      throw new TypeError('Cloud submission requires job, tenant and project identity');
    }
    const snapshot = { ...job };
    delete snapshot.abortController;
    delete snapshot._deduplicated;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.put.run(snapshot.id, snapshot.createdAt, now, JSON.stringify(snapshot));
      this.recordCloudSubmission.run(snapshot.id, snapshot.tenantId, snapshot.projectId, snapshot.createdAt);
      if (storage?.maxJobsPerMonth && storage?.period) {
        const usage = this.monthlyUsageStatement.get(snapshot.tenantId, storage.period);
        const reservations = this.monthlyReservationsStatement.get(snapshot.tenantId);
        if (Number(usage.jobs || 0) + Number(reservations.count || 0) >= storage.maxJobsPerMonth) {
          const error = new Error('Tenant monthly job budget exceeded');
          error.code = 'CLOUD_MONTHLY_JOB_BUDGET';
          throw error;
        }
      }
      if (storage) this.reserveCloudStorage(snapshot.id, snapshot.tenantId,
        storage.reservationBytes, storage.budgetBytes, snapshot.createdAt);
      if (auditEvent) this.insertCloudAudit(auditEvent);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  countCloudSubmissions(tenantId, since) {
    const result = this.countCloudSubmissionsStatement.get(tenantId, since);
    return Number(result?.count || 0);
  }

  pruneCloudSubmissions(before) {
    this.pruneCloudSubmissionsStatement.run(before);
  }

  consumeCloudRequest(tenantId, now, windowMs, limit) {
    if (typeof tenantId !== 'string' || !tenantId ||
        !Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs < 1 ||
        !Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('Invalid durable cloud request quota arguments');
    }
    const cutoff = now - windowMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pruneCloudRequestsStatement.run(cutoff);
      const row = this.countCloudRequestsStatement.get(tenantId, cutoff);
      const count = Number(row?.count || 0);
      if (count >= limit) {
        this.db.exec('COMMIT');
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((Number(row.oldest) + windowMs - now) / 1000)),
        };
      }
      this.insertCloudRequestStatement.run(randomUUID(), tenantId, now);
      this.db.exec('COMMIT');
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  auditEventHash(sequence, previousHash, event) {
    const payload = JSON.stringify([
      event.eventId, event.tenantId, event.projectId, event.principalId,
      event.action, event.resourceId, event.outcome, event.createdAt, event.details,
    ]);
    return createHmac('sha256', this.auditKey)
      .update(String(sequence) + '\\n' + previousHash + '\\n' + payload, 'utf8')
      .digest('hex');
  }

  insertCloudAudit(event) {
    if (!this.auditKey) throw new Error('Cloud audit signing key is not configured');
    if (!event || typeof event.tenantId !== 'string' || !event.tenantId ||
        typeof event.action !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(event.action) ||
        !['success', 'denied', 'failed'].includes(event.outcome || 'success')) {
      throw new TypeError('Invalid cloud audit event');
    }
    const details = event.details === undefined ? null : JSON.stringify(event.details);
    if (details && Buffer.byteLength(details) > 4096) {
      throw new TypeError('Cloud audit details exceed 4 KiB');
    }
    const createdAt = event.createdAt || new Date().toISOString();
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      throw new TypeError('Cloud audit createdAt must be a valid date string');
    }
    const row = {
      eventId: randomUUID(), tenantId: event.tenantId,
      projectId: event.projectId || null, principalId: event.principalId || null,
      action: event.action, resourceId: event.resourceId || null,
      outcome: event.outcome || 'success', createdAt, details,
    };
    const state = this.auditStateStatement.get();
    const sequence = Number(state.lastSequence) + 1;
    const previousHash = state.lastHash;
    const eventHash = this.auditEventHash(sequence, previousHash, row);
    this.insertCloudAuditStatement.run(
      row.eventId, sequence, previousHash, eventHash, row.tenantId, row.projectId,
      row.principalId, row.action, row.resourceId, row.outcome, row.createdAt, row.details,
    );
    this.updateAuditStateStatement.run(sequence, eventHash);
  }

  initializeAuditChain() {
    const rows = this.legacyAuditRowsStatement.all();
    const state = this.auditStateStatement.get();
    const chainRows = this.auditRowsStatement.all();
    const unsigned = chainRows.filter(row =>
      row.sequence === null && row.previousHash === null && row.eventHash === null);
    if (rows.length === 0) {
      if (Number(state.lastSequence) !== 0 || state.lastHash !== EMPTY_AUDIT_HASH) {
        throw new Error('Cloud audit integrity verification failed: chain state has no events');
      }
      return;
    }
    if (unsigned.length === chainRows.length) {
      if (Number(state.lastSequence) !== 0 || state.lastHash !== EMPTY_AUDIT_HASH) {
        throw new Error('Cloud audit integrity verification failed: unsigned events conflict with chain state');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        let sequence = 0;
        let previousHash = EMPTY_AUDIT_HASH;
        for (const row of rows) {
          sequence++;
          const eventHash = this.auditEventHash(sequence, previousHash, row);
          this.updateAuditRowStatement.run(sequence, previousHash, eventHash, row.eventId);
          previousHash = eventHash;
        }
        this.updateAuditStateStatement.run(sequence, previousHash);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    if (unsigned.length > 0 || chainRows.some(row =>
      !Number.isSafeInteger(row.sequence) || typeof row.previousHash !== 'string' ||
      typeof row.eventHash !== 'string')) {
      throw new Error('Cloud audit integrity verification failed: partial or missing signatures');
    }
    const verification = this.verifyCloudAuditChain();
    if (!verification.valid) {
      throw new Error('Cloud audit integrity verification failed: ' + verification.reason);
    }
  }

  verifyCloudAuditChain() {
    if (!this.auditKey) return { valid: false, reason: 'Audit signing key is not configured' };
    let sequence = 0;
    let previousHash = EMPTY_AUDIT_HASH;
    for (const row of this.auditRowsStatement.all()) {
      if (row.sequence !== sequence + 1 || row.previousHash !== previousHash ||
          !/^[a-f0-9]{64}$/.test(row.eventHash || '')) {
        return { valid: false, reason: 'Audit sequence or previous-hash link is invalid', sequence: row.sequence };
      }
      const expected = Buffer.from(this.auditEventHash(row.sequence, previousHash, row), 'hex');
      const actual = Buffer.from(row.eventHash, 'hex');
      if (!timingSafeEqual(expected, actual)) {
        return { valid: false, reason: 'Audit event signature does not match stored event', sequence: row.sequence };
      }
      sequence = row.sequence;
      previousHash = row.eventHash;
    }
    const state = this.auditStateStatement.get();
    if (Number(state.lastSequence) !== sequence || state.lastHash !== previousHash) {
      return { valid: false, reason: 'Audit chain checkpoint does not match stored events' };
    }
    return { valid: true, count: sequence, lastSequence: sequence, lastHash: previousHash };
  }

  recordCloudAudits(events) {
    if (!Array.isArray(events)) throw new TypeError('Cloud audit events must be an array');
    if (events.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) this.insertCloudAudit(event);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordCloudAudit(event) {
    this.recordCloudAudits([event]);
  }

  cloudAuditEvents(tenantId) {
    return this.listCloudAuditStatement.all(tenantId).map(event => ({
      ...event,
      details: event.details ? JSON.parse(event.details) : null,
    }));
  }

  all() {
    // Recovery/retention must see old rows too, including databases created by
    // earlier versions. Limiting reads hid expired artifacts and active jobs.
    return this.db.prepare('SELECT json FROM studio_jobs ORDER BY created_at, rowid')
      .all().map(row => JSON.parse(row.json));
  }

  recover() {
    const jobs = this.all();
    for (const job of jobs) {
      if (['queued', 'running'].includes(job.status)) {
        job.status = 'interrupted';
        job.error = 'Studio restarted. Browser execution was not resumed automatically.';
        job.finishedAt = new Date().toISOString();
        this.save(job);
      }
    }
    return jobs;
  }

  delete(id) {
    this.deleteStatement.run(id);
    this.deleteCloudUsage(id);
  }

  expired(now = Date.now()) {
    return this.all().filter(job =>
      terminal(job) &&
      now - Date.parse(job.finishedAt || job.createdAt) > RETENTION_MS);
  }

  trim() {
    const jobs = this.all();
    const excess = jobs.filter(terminal).slice(0, Math.max(0, jobs.length - MAX_STORED_JOBS));
    for (const { id } of excess) this.delete(id);
    return excess.map(({ id }) => id);
  }

  close() { this.db.close(); }
}
