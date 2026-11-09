import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresPublishLock } from '../src/cloud-coordination-postgres.mjs';

class FakePostgresPool {
  constructor() {
    this.rows = new Map();
    this.now = () => Date.now();
  }

  async query(sql, values = []) {
    if (sql.includes('INSERT INTO tutorial_publish_locks')) {
      const [resource, ownerId, leaseMs] = values;
      const current = this.rows.get(resource);
      if (current && current.expiresAt > this.now()) return { rows: [] };
      const row = {
        resource,
        ownerId,
        fencingToken: (current?.fencingToken ?? 0) + 1,
        expiresAt: this.now() + leaseMs,
      };
      this.rows.set(resource, row);
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }

    if (sql.includes('UPDATE tutorial_publish_locks')) {
      const [resource, ownerId, fencingToken, leaseMs] = values;
      const row = this.rows.get(resource);
      if (!row || row.ownerId !== ownerId ||
          row.fencingToken !== Number(fencingToken) ||
          row.expiresAt <= this.now()) return { rows: [] };
      row.expiresAt = this.now() + leaseMs;
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }

    if (sql.includes('SELECT fencing_token FROM tutorial_publish_locks')) {
      const [resource, ownerId, fencingToken] = values;
      const row = this.rows.get(resource);
      if (!row || row.ownerId !== ownerId ||
          row.fencingToken !== Number(fencingToken) ||
          row.expiresAt <= this.now()) return { rows: [] };
      return { rows: [{ fencing_token: String(row.fencingToken) }] };
    }

    if (sql.includes('DELETE FROM tutorial_publish_locks')) {
      const [resource, ownerId, fencingToken] = values;
      const row = this.rows.get(resource);
      if (row && row.ownerId === ownerId &&
          row.fencingToken === Number(fencingToken)) this.rows.delete(resource);
      return { rows: [] };
    }

    throw new Error('Unexpected SQL in fake pool: ' + sql);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Postgres publish lock serializes concurrent writers for the same resource', async () => {
  const pool = new FakePostgresPool();
  const firstLock = createPostgresPublishLock({
    pool, leaseMs: 1000, renewIntervalMs: 100, retryIntervalMs: 5,
  });
  const secondLock = createPostgresPublishLock({
    pool, leaseMs: 1000, renewIntervalMs: 100, retryIntervalMs: 5,
  });
  const gate = deferred();
  const entered = [];

  const first = firstLock.withLock('aws-secrets-manager:runtime', async lease => {
    entered.push('first');
    await lease.assertHeld();
    await gate.promise;
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = secondLock.withLock('aws-secrets-manager:runtime', async lease => {
    entered.push('second');
    await lease.assertHeld();
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(entered, ['first']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ['first', 'second']);
  assert.equal(pool.rows.size, 0);
});

test('expired publish lock can be reclaimed and stale fencing tokens are rejected', async () => {
  const pool = new FakePostgresPool();
  const firstLock = createPostgresPublishLock({
    pool, leaseMs: 25, renewIntervalMs: 1000, retryIntervalMs: 2,
  });
  const secondLock = createPostgresPublishLock({
    pool, leaseMs: 1000, renewIntervalMs: 100, retryIntervalMs: 2,
  });
  const gate = deferred();
  let staleLease;

  const first = firstLock.withLock('runtime', async lease => {
    staleLease = lease;
    await gate.promise;
  });
  await new Promise(resolve => setTimeout(resolve, 35));
  await secondLock.withLock('runtime', async lease => {
    await lease.assertHeld();
  });
  await assert.rejects(staleLease.assertHeld(), /no longer valid/);
  gate.resolve();
  await first;
});

test('publish lock renews a lease while its callback is still running', async () => {
  const pool = new FakePostgresPool();
  const lock = createPostgresPublishLock({
    pool, leaseMs: 40, renewIntervalMs: 10, retryIntervalMs: 2,
  });
  await lock.withLock('runtime', async lease => {
    await new Promise(resolve => setTimeout(resolve, 65));
    await lease.assertHeld();
  });
  assert.equal(pool.rows.size, 0);
});

test('publish lock releases ownership when the protected operation throws', async () => {
  const pool = new FakePostgresPool();
  const lock = createPostgresPublishLock({ pool });
  await assert.rejects(lock.withLock('runtime', async () => {
    throw new Error('publisher failed');
  }), /publisher failed/);
  assert.equal(pool.rows.size, 0);
});

test('publish lock validates resource and lease configuration', () => {
  const pool = new FakePostgresPool();
  assert.throws(() => createPostgresPublishLock({ pool: {} }), /query-capable PostgreSQL pool/);
  const lock = createPostgresPublishLock({ pool });
  assert.rejects(lock.withLock('', async () => {}), /resource/);
});
