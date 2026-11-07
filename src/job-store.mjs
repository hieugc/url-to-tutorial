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
    const root = path.resolve(outputRoot);
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'studio-jobs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;');
    if (auditKey !== null && typeof auditKey !== 'string' && !Buffer.isBuffer(auditKey)) {
      throw new TypeError('Cloud audit signing key must be a string or Buffer');
    }
    this.auditKey = auditKey === null ? null : Buffer.from(auditKey);
    if (this.auditKey && this.auditKey.length < 32) {
      throw new TypeError('Cloud audit signing key must contain at least 32 bytes');
    }
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
      this.initializeAuditChain();
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cloud_audit_events_sequence ON cloud_audit_events(sequence)');
    }
  }

  save(job) {
    const snapshot = { ...job };
    delete snapshot.abortController;
    delete snapshot._deduplicated;
    const now = new Date().toISOString();
    this.put.run(snapshot.id, snapshot.createdAt || now, now, JSON.stringify(snapshot));
  }

  saveCloudSubmission(job, auditEvent = null) {
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
