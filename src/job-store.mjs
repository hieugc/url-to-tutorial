import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MAX_STORED_JOBS = 40;
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

export class StudioJobStore {
  constructor(outputRoot) {
    const root = path.resolve(outputRoot);
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'studio-jobs.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS studio_jobs (' +
      'id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)');
    this.put = this.db.prepare('INSERT INTO studio_jobs (id, created_at, updated_at, json) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json');
    this.deleteStatement = this.db.prepare('DELETE FROM studio_jobs WHERE id=?');
  }

  save(job) {
    const snapshot = { ...job };
    delete snapshot.abortController;
    const now = new Date().toISOString();
    this.put.run(snapshot.id, snapshot.createdAt || now, now, JSON.stringify(snapshot));
  }

  all() {
    return this.db.prepare('SELECT json FROM studio_jobs ORDER BY created_at DESC LIMIT ?')
      .all(MAX_STORED_JOBS).map(row => JSON.parse(row.json)).reverse();
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
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status) &&
      now - Date.parse(job.finishedAt || job.createdAt) > RETENTION_MS);
  }

  trim() {
    const excess = this.db.prepare(
      'SELECT id FROM studio_jobs ORDER BY created_at DESC LIMIT -1 OFFSET ?'
    ).all(MAX_STORED_JOBS);
    for (const { id } of excess) this.delete(id);
    return excess.map(({ id }) => id);
  }

  close() { this.db.close(); }
}
