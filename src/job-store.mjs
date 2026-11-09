import { mkdirSync } from 'node:fs';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MAX_STORED_JOBS = 40;
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const EMPTY_AUDIT_HASH = '0'.repeat(64);
const terminal = job => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status);

export class StudioJobStore {
  constructor(outputRoot, { auditKey = null, auditKeyRing = null, artifactCipher = null } = {}) {
    if (auditKey !== null && auditKeyRing !== null) {
      throw new TypeError('Configure either auditKey or auditKeyRing, not both');
    }
    if (artifactCipher !== null && (
      typeof artifactCipher.encryptBuffer !== 'function' ||
      typeof artifactCipher.decryptBuffer !== 'function'
    )) {
      throw new TypeError('Cloud artifact cipher must support buffer encryption and decryption');
    }
    this.artifactCipher = artifactCipher;
    this.legacyPlaintextRows = false;
    this.needsEncryptedStorageCompaction = false;
    this.auditKeys = new Map();
    this.activeAuditKeyId = null;
    if (auditKeyRing !== null) {
      if (!auditKeyRing || typeof auditKeyRing !== 'object' ||
          !/^[a-f0-9]{16}$/.test(auditKeyRing.activeKeyId || '') ||
          !auditKeyRing.keys || typeof auditKeyRing.keys !== 'object' || Array.isArray(auditKeyRing.keys)) {
        throw new TypeError('Cloud audit key ring requires activeKeyId and a keys object');
      }
      for (const [keyId, value] of Object.entries(auditKeyRing.keys)) {
        if (!/^[a-f0-9]{16}$/.test(keyId) ||
            (typeof value !== 'string' && !Buffer.isBuffer(value))) {
          throw new TypeError('Cloud audit key ring entries require 16-hex IDs and string/Buffer keys');
        }
        const key = Buffer.from(value);
        if (key.length < 32) throw new TypeError('Cloud audit keys must contain at least 32 bytes');
        if (createHash('sha256').update(key).digest('hex').slice(0, 16) !== keyId) {
          throw new TypeError('Cloud audit key ID must match the SHA-256 key fingerprint');
        }
        this.auditKeys.set(keyId, key);
      }
      if (!this.auditKeys.has(auditKeyRing.activeKeyId)) {
        throw new TypeError('Active cloud audit key is missing from the key ring');
      }
      this.activeAuditKeyId = auditKeyRing.activeKeyId;
    } else if (auditKey !== null) {
      if (typeof auditKey !== 'string' && !Buffer.isBuffer(auditKey)) {
        throw new TypeError('Cloud audit signing key must be a string or Buffer');
      }
      const key = Buffer.from(auditKey);
      if (key.length < 32) throw new TypeError('Cloud audit signing key must contain at least 32 bytes');
      this.activeAuditKeyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
      this.auditKeys.set(this.activeAuditKeyId, key);
    }
    this.auditKey = this.activeAuditKeyId ? this.auditKeys.get(this.activeAuditKeyId) : null;
    // During pre-key-ID migration, the ring's active key must be the legacy signer.
    // This permits a controlled one-time migration before switching to the new key.
    this.legacyAuditKey = auditKeyRing !== null
      ? Buffer.from(this.auditKeys.get(this.activeAuditKeyId))
      : (auditKey === null ? null : Buffer.from(auditKey));
    const root = path.resolve(outputRoot);
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'studio-jobs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;');
    if (this.artifactCipher) {
      this.db.exec('CREATE TABLE IF NOT EXISTS cloud_storage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const state = this.db.prepare('SELECT value FROM cloud_storage_metadata WHERE key=?')
        .get('job-record-encryption-v1');
      this.needsEncryptedStorageCompaction = !state;
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
      'resource_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT, key_id TEXT)');
    const auditColumns = new Set(this.db.prepare('PRAGMA table_info(cloud_audit_events)')
      .all().map(column => column.name));
    for (const [name, type] of [['sequence', 'INTEGER'], ['previous_hash', 'TEXT'], ['event_hash', 'TEXT'], ['key_id', 'TEXT']]) {
      if (!auditColumns.has(name)) this.db.exec('ALTER TABLE cloud_audit_events ADD COLUMN ' + name + ' ' + type);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_audit_events_tenant_time ' +
      'ON cloud_audit_events(tenant_id, created_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_audit_state (' +
      'id INTEGER PRIMARY KEY CHECK(id=1), last_sequence INTEGER NOT NULL, last_hash TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cloud_audit_archive_state (' +
      'id INTEGER PRIMARY KEY CHECK(id=1), last_archived_sequence INTEGER NOT NULL, ' +
      'last_archived_hash TEXT NOT NULL, updated_at TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO cloud_audit_archive_state ' +
      '(id, last_archived_sequence, last_archived_hash, updated_at) VALUES (1, 0, ?, ?)')
      .run(EMPTY_AUDIT_HASH, new Date().toISOString());
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
    this.cloudStorageUsageByJobStatement = this.db.prepare(
      'SELECT bytes FROM cloud_storage_usage WHERE job_id=?');
    this.cloudUsageForJobStatement = this.db.prepare(
      'SELECT worker_ms AS workerMs FROM cloud_usage_events WHERE job_id=?');
    this.updateCloudUsageArtifactBytesStatement = this.db.prepare(
      'UPDATE cloud_usage_events SET artifact_bytes=?, cost_micros=?, finalized_at=? WHERE job_id=?');
    this.deleteCloudStorageReservationStatement = this.db.prepare(
      'DELETE FROM cloud_storage_reservations WHERE job_id=?');
    this.deleteCloudStorageUsageStatement = this.db.prepare(
      'DELETE FROM cloud_storage_usage WHERE job_id=?');
    this.insertCloudAuditStatement = this.db.prepare(
      'INSERT INTO cloud_audit_events (event_id, sequence, previous_hash, event_hash, tenant_id, project_id, principal_id, action, resource_id, outcome, created_at, details, key_id) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.listCloudAuditStatement = this.db.prepare(
      'SELECT event_id AS eventId, sequence, previous_hash AS previousHash, event_hash AS eventHash, key_id AS keyId, ' +
      'tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, ' +
      'action, resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events WHERE tenant_id=? ORDER BY sequence, rowid');
    this.auditStateStatement = this.db.prepare(
      'SELECT last_sequence AS lastSequence, last_hash AS lastHash FROM cloud_audit_state WHERE id=1');
    this.auditArchiveStateStatement = this.db.prepare(
      'SELECT last_archived_sequence AS lastArchivedSequence, last_archived_hash AS lastArchivedHash ' +
      'FROM cloud_audit_archive_state WHERE id=1');
    this.auditArchiveBatchStatement = this.db.prepare(
      'SELECT event_id AS eventId, sequence, previous_hash AS previousHash, event_hash AS eventHash, key_id AS keyId, ' +
      'tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, action, ' +
      'resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events WHERE sequence>? ORDER BY sequence LIMIT ?');
    this.auditArchiveEventAtSequenceStatement = this.db.prepare(
      'SELECT event_hash AS eventHash FROM cloud_audit_events WHERE sequence=?');
    this.updateAuditArchiveStateStatement = this.db.prepare(
      'UPDATE cloud_audit_archive_state SET last_archived_sequence=?, last_archived_hash=?, updated_at=? WHERE id=1');
    this.updateAuditStateStatement = this.db.prepare(
      'UPDATE cloud_audit_state SET last_sequence=?, last_hash=? WHERE id=1');
    this.auditRowsStatement = this.db.prepare(
      'SELECT event_id AS eventId, sequence, previous_hash AS previousHash, event_hash AS eventHash, key_id AS keyId, ' +
      'tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, action, ' +
      'resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events ORDER BY sequence, rowid');
    this.legacyAuditRowsStatement = this.db.prepare(
      'SELECT event_id AS eventId, sequence, previous_hash AS previousHash, event_hash AS eventHash, ' +
      'tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, ' +
      'action, resource_id AS resourceId, outcome, created_at AS createdAt, details, key_id AS keyId ' +
      'FROM cloud_audit_events ORDER BY rowid');
    this.updateAuditRowStatement = this.db.prepare(
      'UPDATE cloud_audit_events SET sequence=?, previous_hash=?, event_hash=?, key_id=? WHERE event_id=?');
    this.deleteStatement = this.db.prepare('DELETE FROM studio_jobs WHERE id=?');
    if (this.auditKeys.size > 0) {
      try {
        this.initializeAuditChain();
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cloud_audit_events_sequence ON cloud_audit_events(sequence)');
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }

  serializeJob(snapshot) {
    const serialized = JSON.stringify(snapshot);
    if (!this.artifactCipher) return serialized;
    const encrypted = this.artifactCipher.encryptBuffer(Buffer.from(serialized, 'utf8'), {
      jobId: snapshot.id,
      filename: 'studio-job-record.json',
    });
    return JSON.stringify({
      storageFormat: 'utv-cloud-job-record-v1',
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      payload: encrypted.toString('base64'),
    });
  }

  deserializeJob(raw) {
    const value = JSON.parse(raw);
    if (value?.storageFormat !== 'utv-cloud-job-record-v1') {
      if (value?.storageFormat !== undefined) {
        throw new Error('Studio job record uses an unsupported encrypted storage format');
      }
      // Existing cloud installations can migrate legacy plaintext rows during
      // the pre-listen artifact-protection step. Local-only stores stay plaintext.
      if (this.artifactCipher) this.legacyPlaintextRows = true;
      return value;
    }
    if (!this.artifactCipher || typeof value.id !== 'string' ||
        typeof value.createdAt !== 'string' || typeof value.payload !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.payload)) {
      throw new Error('Encrypted Studio job record cannot be opened by this host');
    }
    const encrypted = Buffer.from(value.payload, 'base64');
    if (encrypted.toString('base64') !== value.payload) {
      throw new Error('Encrypted Studio job record encoding is invalid');
    }
    const plaintext = this.artifactCipher.decryptBuffer(encrypted, {
      jobId: value.id,
      filename: 'studio-job-record.json',
    }, 64 * 1024 * 1024);
    const snapshot = JSON.parse(plaintext.toString('utf8'));
    if (!snapshot || snapshot.id !== value.id || snapshot.createdAt !== value.createdAt) {
      throw new Error('Encrypted Studio job record identity does not match its envelope');
    }
    return snapshot;
  }

  save(job) {
    const snapshot = { ...job };
    delete snapshot.abortController;
    delete snapshot._deduplicated;
    const now = new Date().toISOString();
    this.put.run(snapshot.id, snapshot.createdAt || now, now, this.serializeJob(snapshot));
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

  reconcileCloudArtifactBytes(job, {
    artifactBytes,
    workerCostPerSecondMicros,
    artifactCostPerMiBMicros,
  } = {}) {
    if (!job?.id || !job.tenantId || !job.projectId ||
        !Number.isSafeInteger(artifactBytes) || artifactBytes < 0 ||
        !Number.isSafeInteger(workerCostPerSecondMicros) || workerCostPerSecondMicros < 0 ||
        !Number.isSafeInteger(artifactCostPerMiBMicros) || artifactCostPerMiBMicros < 0) {
      throw new TypeError('Invalid cloud artifact storage reconciliation');
    }
    const usage = this.cloudUsageForJobStatement.get(job.id);
    if (!usage) throw new Error('Cloud usage record is missing during artifact storage reconciliation');
    const previous = this.cloudStorageUsageByJobStatement.get(job.id);
    if (Number(previous?.bytes ?? -1) === artifactBytes) return false;
    const workerMs = Number(usage.workerMs || 0);
    const costMicros =
      Math.ceil(workerMs / 1000) * workerCostPerSecondMicros +
      Math.ceil(artifactBytes / (1024 * 1024)) * artifactCostPerMiBMicros;
    if (!Number.isSafeInteger(costMicros)) {
      throw new Error('Reconciled cloud usage cost exceeds safe integer range');
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertCloudStorageStatement.run(
        job.id, job.tenantId, job.projectId, artifactBytes, now,
      );
      const updated = this.updateCloudUsageArtifactBytesStatement.run(
        artifactBytes, costMicros, now, job.id,
      );
      if (Number(updated.changes) !== 1) {
        throw new Error('Cloud usage record changed during artifact storage reconciliation');
      }
      this.insertCloudAudit({
        tenantId: job.tenantId,
        projectId: job.projectId,
        principalId: null,
        action: 'artifact.storage_reconciled',
        resourceId: job.id,
        outcome: 'success',
        details: { artifactBytes },
      });
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
      this.put.run(snapshot.id, snapshot.createdAt, now, this.serializeJob(snapshot));
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

  legacyAuditEventHash(sequence, previousHash, event) {
    // The active ring key must be the legacy signer during a pre-key-ID migration.
    const key = this.legacyAuditKey || this.auditKeys.get(this.activeAuditKeyId);
    if (!key) throw new Error('Legacy audit key is required to verify pre-key-ID events');
    const payload = JSON.stringify([
      event.eventId, event.tenantId, event.projectId, event.principalId,
      event.action, event.resourceId, event.outcome, event.createdAt, event.details,
    ]);
    return createHmac('sha256', key)
      .update(String(sequence) + '\\n' + previousHash + '\\n' + payload, 'utf8')
      .digest('hex');
  }

  auditEventHash(sequence, previousHash, event) {
    const keyId = event.keyId || this.activeAuditKeyId;
    const key = this.auditKeys.get(keyId);
    if (!key) throw new Error('Cloud audit signing key is unavailable: ' + keyId);
    const payload = JSON.stringify([
      event.eventId, keyId, event.tenantId, event.projectId, event.principalId,
      event.action, event.resourceId, event.outcome, event.createdAt, event.details,
    ]);
    return createHmac('sha256', key)
      .update(String(sequence) + '\\n' + previousHash + '\\n' + payload, 'utf8')
      .digest('hex');
  }

  insertCloudAudit(event) {
    if (!this.activeAuditKeyId || !this.auditKeys.has(this.activeAuditKeyId)) {
      throw new Error('Cloud audit signing key is not configured');
    }
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
      outcome: event.outcome || 'success', createdAt, details, keyId: this.activeAuditKeyId,
    };
    const state = this.auditStateStatement.get();
    const sequence = Number(state.lastSequence) + 1;
    const previousHash = state.lastHash;
    const eventHash = this.auditEventHash(sequence, previousHash, row);
    this.insertCloudAuditStatement.run(
      row.eventId, sequence, previousHash, eventHash, row.tenantId, row.projectId,
      row.principalId, row.action, row.resourceId, row.outcome, row.createdAt, row.details, row.keyId,
    );
    this.updateAuditStateStatement.run(sequence, eventHash);
  }

  initializeAuditChain() {
    const rows = this.legacyAuditRowsStatement.all();
    const state = this.auditStateStatement.get();
    const chainRows = this.auditRowsStatement.all();
    const unsigned = chainRows.filter(row =>
      row.sequence === null && row.previousHash === null && row.eventHash === null);
    const missingKeyIds = chainRows.filter(row => !row.keyId);
    if (rows.length === 0) {
      if (Number(state.lastSequence) !== 0 || state.lastHash !== EMPTY_AUDIT_HASH) {
        throw new Error('Cloud audit integrity verification failed: chain state has no events');
      }
      return;
    }
    // Upgrade pre-key-ID HMAC rows once. Never rewrite an already externally
    // archived prefix: its immutable copy must remain independently verifiable.
    if (missingKeyIds.length === chainRows.length) {
      const archive = this.auditArchiveStateStatement.get();
      if (Number(archive.lastArchivedSequence) !== 0) {
        throw new Error('Cloud audit key-ID migration requires the external archive checkpoint to be zero');
      }
      if (unsigned.length === chainRows.length) {
        if (Number(state.lastSequence) !== 0 || state.lastHash !== EMPTY_AUDIT_HASH) {
          throw new Error('Cloud audit integrity verification failed: unsigned events conflict with chain state');
        }
      } else {
        let legacySequence = 0;
        let legacyPreviousHash = EMPTY_AUDIT_HASH;
        for (const row of rows) {
          legacySequence++;
          const expected = Buffer.from(this.legacyAuditEventHash(
            legacySequence, legacyPreviousHash, row), 'hex');
          const actual = Buffer.from(row.eventHash || '', 'hex');
          if (actual.length !== 32 || !timingSafeEqual(expected, actual)) {
            throw new Error('Cloud audit integrity verification failed: legacy event signature mismatch');
          }
          legacyPreviousHash = row.eventHash;
        }
        if (Number(state.lastSequence) !== legacySequence || state.lastHash !== legacyPreviousHash) {
          throw new Error('Cloud audit integrity verification failed: legacy checkpoint mismatch');
        }
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        let sequence = 0;
        let previousHash = EMPTY_AUDIT_HASH;
        for (const row of rows) {
          sequence++;
          const migrated = { ...row, keyId: this.activeAuditKeyId };
          const eventHash = this.auditEventHash(sequence, previousHash, migrated);
          this.updateAuditRowStatement.run(sequence, previousHash, eventHash,
            this.activeAuditKeyId, row.eventId);
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
    if (unsigned.length > 0 || missingKeyIds.length > 0 || chainRows.some(row =>
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
    if (this.auditKeys.size === 0) return { valid: false, reason: 'Audit signing key ring is not configured' };
    let sequence = 0;
    let previousHash = EMPTY_AUDIT_HASH;
    for (const row of this.auditRowsStatement.all()) {
      if (row.sequence !== sequence + 1 || row.previousHash !== previousHash ||
          !/^[a-f0-9]{16}$/.test(row.keyId || '') || !this.auditKeys.has(row.keyId) ||
          !/^[a-f0-9]{64}$/.test(row.eventHash || '')) {
        return { valid: false, reason: 'Audit sequence, key ID or previous-hash link is invalid', sequence: row.sequence };
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

  rotateAuditSigningKey({ keyId, key, actorId = 'operator' } = {}) {
    if (!this.activeAuditKeyId || !this.verifyCloudAuditChain().valid) {
      throw new Error('Cannot rotate an unverified audit signing key ring');
    }
    if (typeof keyId !== 'string' || !/^[a-f0-9]{16}$/.test(keyId) ||
        (typeof key !== 'string' && !Buffer.isBuffer(key))) {
      throw new TypeError('New audit key requires a 16-hex keyId and string/Buffer key');
    }
    const resolved = Buffer.from(key);
    if (resolved.length < 32) throw new TypeError('New audit signing key must contain at least 32 bytes');
    if (createHash('sha256').update(resolved).digest('hex').slice(0, 16) !== keyId) {
      throw new TypeError('New audit key ID must match the SHA-256 key fingerprint');
    }
    if (keyId === this.activeAuditKeyId) {
      throw new Error('Audit signing key is already active');
    }
    const existingKey = this.auditKeys.get(keyId);
    if (existingKey && (existingKey.length !== resolved.length || !timingSafeEqual(existingKey, resolved))) {
      throw new Error('Audit key ID is already bound to a different key');
    }
    if (typeof actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/.test(actorId)) {
      throw new TypeError('Audit key rotation actorId is invalid');
    }
    const previousKeyId = this.activeAuditKeyId;
    const addedKey = !existingKey;
    if (addedKey) this.auditKeys.set(keyId, resolved);
    this.activeAuditKeyId = keyId;
    this.auditKey = resolved;
    try {
      this.recordCloudAudit({
        tenantId: 'platform', principalId: actorId, action: 'audit.signing_key_rotated',
        details: { previousKeyId, activeKeyId: keyId },
      });
    } catch (error) {
      if (addedKey) this.auditKeys.delete(keyId);
      this.activeAuditKeyId = previousKeyId;
      this.auditKey = this.auditKeys.get(previousKeyId);
      throw error;
    }
    return { previousKeyId, activeKeyId: keyId };
  }

  auditKeyRingMetadata() {
    return { activeKeyId: this.activeAuditKeyId, keyIds: [...this.auditKeys.keys()] };
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

  cloudAuditArchiveBatch(limit = 500) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new TypeError('Audit archive batch limit must be between 1 and 5000');
    }
    const checkpoint = this.auditArchiveStateStatement.get();
    const integrity = this.verifyCloudAuditChain();
    if (!integrity.valid) throw new Error('Cannot archive an invalid audit chain: ' + integrity.reason);
    const archivedSequence = Number(checkpoint.lastArchivedSequence);
    if (archivedSequence > integrity.lastSequence) {
      throw new Error('Audit archive checkpoint is ahead of the local ledger');
    }
    if (archivedSequence > 0) {
      const event = this.auditArchiveEventAtSequenceStatement.get(archivedSequence);
      if (!event || event.eventHash !== checkpoint.lastArchivedHash) {
        throw new Error('Audit archive checkpoint does not match the local ledger');
      }
    } else if (checkpoint.lastArchivedHash !== EMPTY_AUDIT_HASH) {
      throw new Error('Empty audit archive checkpoint has an invalid hash');
    }
    const events = this.auditArchiveBatchStatement.all(archivedSequence, limit).map(event => ({
      ...event,
      details: event.details ? JSON.parse(event.details) : null,
    }));
    return {
      previousSequence: archivedSequence,
      previousHash: checkpoint.lastArchivedHash,
      events,
      throughSequence: events.at(-1)?.sequence ?? archivedSequence,
      throughHash: events.at(-1)?.eventHash ?? checkpoint.lastArchivedHash,
    };
  }

  commitCloudAuditArchiveCheckpoint({ expectedPreviousSequence, throughSequence, throughHash } = {}) {
    if (!Number.isSafeInteger(expectedPreviousSequence) || expectedPreviousSequence < 0 ||
        !Number.isSafeInteger(throughSequence) || throughSequence < expectedPreviousSequence ||
        typeof throughHash !== 'string' || !/^[a-f0-9]{64}$/.test(throughHash)) {
      throw new TypeError('Invalid external audit archive checkpoint');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.auditArchiveStateStatement.get();
      if (Number(current.lastArchivedSequence) !== expectedPreviousSequence) {
        throw new Error('Audit archive checkpoint changed concurrently; fetch a new batch');
      }
      const local = throughSequence === 0
        ? { eventHash: EMPTY_AUDIT_HASH }
        : this.auditArchiveEventAtSequenceStatement.get(throughSequence);
      if (!local || local.eventHash !== throughHash) {
        throw new Error('External archive acknowledgement does not match the local audit chain');
      }
      this.updateAuditArchiveStateStatement.run(
        throughSequence, throughHash, new Date().toISOString(),
      );
      this.db.exec('COMMIT');
      return { lastArchivedSequence: throughSequence, lastArchivedHash: throughHash };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
      .all().map(row => this.deserializeJob(row.json));
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

  compactEncryptedRecords() {
    if (!this.artifactCipher ||
        (!this.legacyPlaintextRows && !this.needsEncryptedStorageCompaction)) return false;
    // WAL checkpoint + VACUUM removes superseded plaintext JSON pages left by
    // pre-encryption versions; otherwise old values could survive in free pages.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.prepare('INSERT INTO cloud_storage_metadata (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('job-record-encryption-v1', 'complete');
    this.legacyPlaintextRows = false;
    this.needsEncryptedStorageCompaction = false;
    return true;
  }

  close() { this.db.close(); }
}
