import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresRolloutStore } from '../src/cloud-rollout-postgres.mjs';

const connectionString = process.env.COORDINATION_DATABASE_URL;

test('PostgreSQL rollout store persists acknowledgements, fences stale coordinators and recovers expired leases', {
  skip: !connectionString && 'Set COORDINATION_DATABASE_URL to run the PostgreSQL integration test',
}, async t => {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString, max: 2 });
  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  t.after(async () => {
    await Promise.all([poolA.end(), poolB.end(), admin.end()]);
  });

  const migration = await readFile(new URL('../migrations/002-cloud-rollouts.sql', import.meta.url), 'utf8');
  await admin.query(migration);

  const storeA = createPostgresRolloutStore({ pool: poolA, leaseMs: 5000 });
  const storeB = createPostgresRolloutStore({ pool: poolB, leaseMs: 5000 });
  const rolloutId = 'rollout-' + randomUUID();
  const replicaIds = ['api-a', 'api-b'];

  const firstLease = await storeA.beginRollout({
    rolloutId,
    targetVersion: '101',
    snapshotDigest: 'a'.repeat(64),
    actorId: 'security-operator',
    replicaIds,
  });
  assert.ok(firstLease.leaseToken.length >= 16);

  await assert.rejects(storeB.beginRollout({
    rolloutId: 'rollout-' + randomUUID(),
    targetVersion: '102',
    snapshotDigest: 'b'.repeat(64),
    actorId: 'security-operator',
    replicaIds,
  }), /already active/i);

  await storeA.recordReplicaAck({
    rolloutId, leaseToken: firstLease.leaseToken, replicaId: 'api-a',
    targetVersion: '101', actorId: 'security-operator',
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: '1234567890abcdef', keyIds: ['1234567890abcdef'] },
  });
  await storeA.recordReplicaFailure({
    rolloutId, leaseToken: firstLease.leaseToken, replicaId: 'api-b',
    targetVersion: '101', actorId: 'security-operator',
    errorCode: 'REPLICA_UNAVAILABLE',
  });
  await storeA.markPartialRollout({
    rolloutId, leaseToken: firstLease.leaseToken, targetVersion: '101',
    acknowledgedReplicaIds: ['api-a'], failedReplicaIds: ['api-b'],
    actorId: 'security-operator',
  });

  const partial = await storeB.getRollout(rolloutId);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.acknowledgedReplicaIds, ['api-a']);
  assert.deepEqual(partial.replicaIds, replicaIds);
  assert.equal(JSON.stringify(partial).includes('multi-replica-tenant-token'), false);

  const resumedLease = await storeB.resumeRollout({ rolloutId, actorId: 'security-operator' });
  assert.notEqual(resumedLease.leaseToken, firstLease.leaseToken);
  await assert.rejects(storeA.recordReplicaAck({
    rolloutId, leaseToken: firstLease.leaseToken, replicaId: 'api-b',
    targetVersion: '101', actorId: 'security-operator',
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: '1234567890abcdef', keyIds: ['1234567890abcdef'] },
  }), /lease|fencing|ownership/i);

  await storeB.recordReplicaAck({
    rolloutId, leaseToken: resumedLease.leaseToken, replicaId: 'api-b',
    targetVersion: '101', actorId: 'security-operator',
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: '1234567890abcdef', keyIds: ['1234567890abcdef'] },
  });
  await storeB.completeRollout({
    rolloutId, leaseToken: resumedLease.leaseToken, targetVersion: '101',
    replicaIds, actorId: 'security-operator',
  });
  assert.equal((await storeA.getRollout(rolloutId)).state, 'completed');

  const crashedId = 'rollout-' + randomUUID();
  const crashedLease = await storeA.beginRollout({
    rolloutId: crashedId,
    targetVersion: '102',
    snapshotDigest: 'c'.repeat(64),
    actorId: 'security-operator',
    replicaIds,
  });
  await admin.query(
    "UPDATE tutorial_credential_rollouts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE rollout_id = $1",
    [crashedId],
  );
  const recoveredLease = await storeB.resumeRollout({ rolloutId: crashedId, actorId: 'security-operator' });
  assert.notEqual(recoveredLease.leaseToken, crashedLease.leaseToken);
  await assert.rejects(storeA.recordReplicaFailure({
    rolloutId: crashedId, leaseToken: crashedLease.leaseToken, replicaId: 'api-a',
    targetVersion: '102', actorId: 'security-operator', errorCode: 'STALE_COORDINATOR',
  }), /lease|fencing|ownership/i);

  for (const replicaId of replicaIds) {
    await storeB.recordReplicaAck({
      rolloutId: crashedId, leaseToken: recoveredLease.leaseToken, replicaId,
      targetVersion: '102', actorId: 'security-operator',
      tokenIds: ['service-a-current'],
      auditKeyRing: { activeKeyId: '1234567890abcdef', keyIds: ['1234567890abcdef'] },
    });
  }
  await storeB.completeRollout({
    rolloutId: crashedId, leaseToken: recoveredLease.leaseToken,
    targetVersion: '102', replicaIds, actorId: 'security-operator',
  });

  await assert.rejects(storeA.beginRollout({
    rolloutId: 'rollout-' + randomUUID(),
    targetVersion: '100',
    snapshotDigest: 'd'.repeat(64),
    actorId: 'security-operator',
    replicaIds,
  }), /rollback|older version/i);

  const persisted = await admin.query(
    'SELECT * FROM tutorial_credential_rollouts WHERE rollout_id = ANY($1::text[])',
    [[rolloutId, crashedId]],
  );
  assert.equal(persisted.rowCount, 2);
  assert.equal(JSON.stringify(persisted.rows).includes('multi-replica-tenant-token'), false);
});
