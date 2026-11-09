import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresPublishLock } from '../src/cloud-coordination-postgres.mjs';

const connectionString = process.env.COORDINATION_DATABASE_URL;

test('PostgreSQL integration: shared lock serializes writers and rejects reclaimed stale leases', {
  skip: !connectionString && 'Set COORDINATION_DATABASE_URL to run the PostgreSQL integration test',
}, async t => {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString, max: 2 });
  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  t.after(async () => {
    await Promise.all([poolA.end(), poolB.end(), admin.end()]);
  });

  const migration = await readFile(new URL('../migrations/001-cloud-coordination.sql', import.meta.url), 'utf8');
  await admin.query(migration);

  const lockA = createPostgresPublishLock({
    pool: poolA, leaseMs: 5000, renewIntervalMs: 1000, retryIntervalMs: 20,
  });
  const lockB = createPostgresPublishLock({
    pool: poolB, leaseMs: 5000, renewIntervalMs: 1000, retryIntervalMs: 20,
  });
  const resource = 'integration:' + randomUUID();
  const entered = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = lockA.withLock(resource, async lease => {
    entered.push('first');
    await lease.assertHeld();
    await firstGate;
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  const second = lockB.withLock(resource, async lease => {
    entered.push('second');
    await lease.assertHeld();
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(entered, ['first']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ['first', 'second']);

  let staleLease;
  let releaseStale;
  const staleGate = new Promise(resolve => { releaseStale = resolve; });
  const staleOwner = lockA.withLock(resource, async lease => {
    staleLease = lease;
    await staleGate;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  await admin.query(
    'UPDATE tutorial_publish_locks SET expires_at = clock_timestamp() - interval \'1 second\' WHERE resource = $1',
    [resource],
  );

  await lockB.withLock(resource, async lease => {
    await lease.assertHeld();
  });
  await assert.rejects(staleLease.assertHeld(), /no longer valid/);
  releaseStale();
  await staleOwner;

  const remaining = await admin.query(
    'SELECT resource FROM tutorial_publish_locks WHERE resource = $1',
    [resource],
  );
  assert.equal(remaining.rowCount, 0);
});
