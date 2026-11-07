import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MAX_STORED_JOBS = 40;
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const terminal = job => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status);

export class StudioJobStore {
  constructor(outputRoot) {
    const root = path.resolve(outputRoot);
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'studio-jobs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;');
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
      'event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, principal_id TEXT, ' +
      'action TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT)');
    this.db.exec('CREATE INDEX IF NOT EXISTS cloud_audit_events_tenant_time ' +
      'ON cloud_audit_events(tenant_id, created_at)');
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
      'INSERT INTO cloud_audit_events (event_id, tenant_id, project_id, principal_id, action, resource_id, outcome, created_at, details) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.listCloudAuditStatement = this.db.prepare(
      'SELECT event_id AS eventId, tenant_id AS tenantId, project_id AS projectId, principal_id AS principalId, ' +
      'action, resource_id AS resourceId, outcome, created_at AS createdAt, details ' +
      'FROM cloud_audit_events WHERE tenant_id=? ORDER BY created_at, rowid');
    this.deleteStatement = this.db.prepare('DELETE FROM studio_jobs WHERE id=?');
  }

  save(job) {
    const snapshot = { ...job };
    delete snapshot.abortController;
    delete snapshot._deduplicated;
    const now = new Date().toISOString();
    this.put.run(snapshot.id, snapshot.createdAt || now, now, JSON.stringify(snapshot));
  }

  saveCloudSubmission(job) {
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

  recordCloudAudit(event) {
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
    this.insertCloudAuditStatement.run(
      randomUUID(), event.tenantId, event.projectId || null, event.principalId || null,
      event.action, event.resourceId || null, event.outcome || 'success', createdAt, details,
    );
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
