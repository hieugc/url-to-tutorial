import { mkdirSync } from 'node:fs';
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
    this.put = this.db.prepare('INSERT INTO studio_jobs (id, created_at, updated_at, json) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json');
    this.recordCloudSubmission = this.db.prepare('INSERT OR IGNORE INTO cloud_job_submissions ' +
      '(job_id, tenant_id, project_id, created_at) VALUES (?, ?, ?, ?)');
    this.countCloudSubmissionsStatement = this.db.prepare(
      'SELECT COUNT(*) AS count FROM cloud_job_submissions WHERE tenant_id=? AND created_at>=?');
    this.pruneCloudSubmissionsStatement = this.db.prepare(
      'DELETE FROM cloud_job_submissions WHERE created_at<?');
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
