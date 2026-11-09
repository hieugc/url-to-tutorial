import { randomUUID } from 'node:crypto';

const ROLLOUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const VERSION = /^(0|[1-9][0-9]{0,127})$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;
const REPLICA_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function validatePool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A connect-capable PostgreSQL pool is required');
  }
}

function validateLeaseMs(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 1_800_000) {
    throw new TypeError('leaseMs must be between 1 second and 30 minutes');
  }
}

function validateReplicaIds(replicaIds, { allowEmpty = false } = {}) {
  if (!Array.isArray(replicaIds) || (!allowEmpty && replicaIds.length === 0) ||
      replicaIds.some(id => typeof id !== 'string' || !REPLICA_ID.test(id)) ||
      new Set(replicaIds).size !== replicaIds.length) {
    throw new TypeError('A unique non-empty replica ID list is required');
  }
  return [...replicaIds].sort();
}

function parseLeaseToken(token) {
  if (typeof token !== 'string' || token.length > 256) {
    throw new Error('Rollout lease token is invalid');
  }
  const match = token.match(/^([0-9a-f-]{36})\.([1-9][0-9]*)$/);
  if (!match) throw new Error('Rollout lease token is invalid');
  return { ownerId: match[1], fencingToken: match[2] };
}

function assertInput(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !fields.includes(key))) {
    throw new TypeError('Rollout store input is invalid');
  }
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error?.code === '23505') {
      throw new Error('Another credential rollout is already active');
    }
    if (error?.code === '23514' || error?.code === '22P02') {
      throw new Error('Rollout store rejected invalid metadata');
    }
    throw error;
  } finally {
    client.release();
  }
}

function safeStoreError() {
  return new Error('Durable credential rollout storage is unavailable');
}

async function requireLease(client, input, lease) {
  const result = await client.query(
    `SELECT rollout_id FROM tutorial_credential_rollouts
      WHERE rollout_id = $1 AND state = 'in_progress'
        AND lease_owner = $2::uuid AND fencing_token = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND target_version = $4`,
    [input.rolloutId, lease.ownerId, lease.fencingToken, input.targetVersion],
  );
  if (result.rowCount !== 1) {
    throw new Error('Rollout lease expired or fencing token no longer owns the record');
  }
}

export function createPostgresRolloutStore({ pool, leaseMs = 300_000 } = {}) {
  validatePool(pool);
  validateLeaseMs(leaseMs);

  async function run(operation) {
    try { return await transaction(pool, operation); }
    catch (error) {
      if (error.message?.startsWith('Another credential rollout') ||
          error.message?.startsWith('Rollout lease') ||
          error.message?.startsWith('Rollout cannot') ||
          error.message?.startsWith('Rollout version') ||
          error.message?.startsWith('All replicas')) throw error;
      throw safeStoreError();
    }
  }

  async function beginRollout(input) {
    assertInput(input, ['rolloutId', 'targetVersion', 'snapshotDigest', 'actorId', 'replicaIds']);
    if (typeof input.rolloutId !== 'string' || !ROLLOUT_ID.test(input.rolloutId) ||
        typeof input.targetVersion !== 'string' || !VERSION.test(input.targetVersion) ||
        typeof input.snapshotDigest !== 'string' || !DIGEST.test(input.snapshotDigest) ||
        typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId)) {
      throw new TypeError('Rollout metadata is invalid');
    }
    const replicaIds = validateReplicaIds(input.replicaIds);
    const ownerId = randomUUID();
    return run(async client => {
      const control = await client.query(
        'SELECT current_version FROM tutorial_rollout_control WHERE singleton_id = 1 FOR UPDATE',
      );
      if (control.rowCount !== 1 || BigInt(input.targetVersion) < BigInt(control.rows[0].current_version)) {
        throw new Error('Rollout version rollback is not allowed');
      }
      await client.query(
        `INSERT INTO tutorial_credential_rollouts
          (rollout_id, target_version, snapshot_digest, actor_id, replica_ids,
           state, lease_owner, fencing_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'in_progress', $6::uuid, 1,
                 clock_timestamp() + ($7 * interval '1 millisecond'))`,
        [input.rolloutId, input.targetVersion, input.snapshotDigest, input.actorId,
          JSON.stringify(replicaIds), ownerId, leaseMs],
      );
      return { leaseToken: ownerId + '.1' };
    });
  }

  async function getRollout(rolloutId) {
    if (typeof rolloutId !== 'string' || !ROLLOUT_ID.test(rolloutId)) {
      throw new TypeError('A valid rollout ID is required');
    }
    let result;
    try {
      result = await pool.query(
        `SELECT rollout_id, target_version, snapshot_digest, actor_id, replica_ids,
                state, acknowledged, failures, failed_replica_ids
           FROM tutorial_credential_rollouts WHERE rollout_id = $1`,
        [rolloutId],
      );
    } catch { throw safeStoreError(); }
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    const acknowledgements = row.acknowledged ?? {};
    return {
      rolloutId: row.rollout_id,
      targetVersion: row.target_version,
      snapshotDigest: row.snapshot_digest.trim(),
      actorId: row.actor_id,
      replicaIds: row.replica_ids,
      state: row.state,
      acknowledgedReplicaIds: Object.keys(acknowledgements).sort(),
      acknowledgements,
      failures: row.failures ?? {},
      failedReplicaIds: row.failed_replica_ids ?? [],
    };
  }

  async function resumeRollout(input) {
    assertInput(input, ['rolloutId', 'actorId']);
    if (typeof input.rolloutId !== 'string' || !ROLLOUT_ID.test(input.rolloutId) ||
        typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId)) {
      throw new TypeError('Rollout resume identity is invalid');
    }
    const ownerId = randomUUID();
    return run(async client => {
      const result = await client.query(
        `UPDATE tutorial_credential_rollouts
            SET state = 'in_progress', actor_id = $2,
                lease_owner = $3::uuid, fencing_token = fencing_token + 1,
                lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
                updated_at = clock_timestamp()
          WHERE rollout_id = $1 AND
            (state = 'partial' OR
             (state = 'in_progress' AND lease_expires_at <= clock_timestamp()))
          RETURNING fencing_token`,
        [input.rolloutId, input.actorId, ownerId, leaseMs],
      );
      if (result.rowCount !== 1) throw new Error('Rollout cannot be resumed while another lease is active');
      return { leaseToken: ownerId + '.' + result.rows[0].fencing_token };
    });
  }

  async function renewRollout(input) {
    assertInput(input, ['rolloutId', 'leaseToken']);
    if (typeof input.rolloutId !== 'string' || !ROLLOUT_ID.test(input.rolloutId)) {
      throw new TypeError('A valid rollout ID is required');
    }
    const lease = parseLeaseToken(input.leaseToken);
    return run(async client => {
      const result = await client.query(
        `UPDATE tutorial_credential_rollouts
            SET lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
                updated_at = clock_timestamp()
          WHERE rollout_id = $1 AND state = 'in_progress'
            AND lease_owner = $2::uuid AND fencing_token = $3::bigint
            AND lease_expires_at > clock_timestamp()
          RETURNING rollout_id`,
        [input.rolloutId, lease.ownerId, lease.fencingToken, leaseMs],
      );
      if (result.rowCount !== 1) throw new Error('Rollout lease expired or fencing token no longer owns the record');
      return { renewed: true };
    });
  }

  async function recordReplicaAck(input) {
    assertInput(input, ['rolloutId', 'leaseToken', 'replicaId', 'targetVersion', 'actorId', 'tokenIds', 'auditKeyRing']);
    const lease = parseLeaseToken(input.leaseToken);
    if (typeof input.replicaId !== 'string' || !REPLICA_ID.test(input.replicaId) ||
        typeof input.targetVersion !== 'string' || !VERSION.test(input.targetVersion) ||
        typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId) ||
        !Array.isArray(input.tokenIds) || input.tokenIds.some(id => typeof id !== 'string' || !REPLICA_ID.test(id)) ||
        !input.auditKeyRing || typeof input.auditKeyRing.activeKeyId !== 'string' ||
        !/^[a-f0-9]{16}$/.test(input.auditKeyRing.activeKeyId) ||
        !Array.isArray(input.auditKeyRing.keyIds) || input.auditKeyRing.keyIds.length === 0 ||
        input.auditKeyRing.keyIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) ||
        new Set(input.auditKeyRing.keyIds).size !== input.auditKeyRing.keyIds.length ||
        !input.auditKeyRing.keyIds.includes(input.auditKeyRing.activeKeyId)) {
      throw new TypeError('Replica acknowledgement metadata is invalid');
    }
    return run(async client => {
      await requireLease(client, input, lease);
      const result = await client.query(
        `UPDATE tutorial_credential_rollouts
            SET acknowledged = acknowledged || jsonb_build_object($4,
                  jsonb_build_object('targetVersion', $5, 'tokenIds', $6::jsonb,
                    'auditKeyRing', $7::jsonb, 'actorId', $8)),
                failures = failures - $4, failed_replica_ids = failed_replica_ids - $4,
                updated_at = clock_timestamp()
          WHERE rollout_id = $1 AND lease_owner = $2::uuid AND fencing_token = $3::bigint
            AND replica_ids ? $4`,
        [input.rolloutId, lease.ownerId, lease.fencingToken, input.replicaId,
          input.targetVersion, JSON.stringify([...input.tokenIds].sort()),
          JSON.stringify(input.auditKeyRing), input.actorId],
      );
      if (result.rowCount !== 1) throw new Error('Rollout lease ownership changed');
    });
  }

  async function recordReplicaFailure(input) {
    assertInput(input, ['rolloutId', 'leaseToken', 'replicaId', 'targetVersion', 'actorId', 'errorCode']);
    const lease = parseLeaseToken(input.leaseToken);
    if (typeof input.replicaId !== 'string' || !REPLICA_ID.test(input.replicaId) ||
        typeof input.targetVersion !== 'string' || !VERSION.test(input.targetVersion) ||
        typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId) ||
        typeof input.errorCode !== 'string' || !ERROR_CODE.test(input.errorCode)) {
      throw new TypeError('Replica failure metadata is invalid');
    }
    return run(async client => {
      await requireLease(client, input, lease);
      const result = await client.query(
        `UPDATE tutorial_credential_rollouts
            SET acknowledged = acknowledged - $4,
                failures = failures || jsonb_build_object($4, $5),
                failed_replica_ids = (SELECT COALESCE(jsonb_agg(DISTINCT item ORDER BY item), '[]'::jsonb)
                  FROM jsonb_array_elements_text(failed_replica_ids || jsonb_build_array($4)) AS existing(item)),
                updated_at = clock_timestamp()
          WHERE rollout_id = $1 AND lease_owner = $2::uuid AND fencing_token = $3::bigint
            AND replica_ids ? $4`,
        [input.rolloutId, lease.ownerId, lease.fencingToken, input.replicaId, input.errorCode],
      );
      if (result.rowCount !== 1) throw new Error('Rollout lease ownership changed');
    });
  }

  async function markPartialRollout(input) {
    assertInput(input, ['rolloutId', 'leaseToken', 'targetVersion', 'acknowledgedReplicaIds', 'failedReplicaIds', 'actorId']);
    const lease = parseLeaseToken(input.leaseToken);
    const acknowledged = validateReplicaIds(input.acknowledgedReplicaIds, { allowEmpty: true });
    const failed = validateReplicaIds(input.failedReplicaIds, { allowEmpty: true });
    if (typeof input.targetVersion !== 'string' || !VERSION.test(input.targetVersion) ||
        typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId)) {
      throw new TypeError('Partial rollout metadata is invalid');
    }
    return run(async client => {
      await requireLease(client, input, lease);
      const current = await client.query(
        'SELECT replica_ids, acknowledged FROM tutorial_credential_rollouts WHERE rollout_id = $1 FOR UPDATE',
        [input.rolloutId],
      );
      if (current.rowCount !== 1) throw new Error('Rollout record is missing');
      const registered = current.rows[0].replica_ids;
      if ([...acknowledged, ...failed].some(id => !registered.includes(id)) ||
          JSON.stringify(Object.keys(current.rows[0].acknowledged ?? {}).sort()) !== JSON.stringify(acknowledged)) {
        throw new Error('Partial rollout replica state does not match persisted acknowledgements');
      }
      const result = await client.query(
        `UPDATE tutorial_credential_rollouts
            SET state = 'partial', failed_replica_ids = $4::jsonb,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = clock_timestamp()
          WHERE rollout_id = $1 AND lease_owner = $2::uuid AND fencing_token = $3::bigint`,
        [input.rolloutId, lease.ownerId, lease.fencingToken, JSON.stringify(failed)],
      );
      if (result.rowCount !== 1) throw new Error('Rollout lease ownership changed');
    });
  }

  async function completeRollout(input) {
    assertInput(input, ['rolloutId', 'leaseToken', 'targetVersion', 'replicaIds', 'actorId']);
    const lease = parseLeaseToken(input.leaseToken);
    const replicaIds = validateReplicaIds(input.replicaIds);
    if (typeof input.targetVersion !== 'string' || !VERSION.test(input.targetVersion) ||
        typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId)) {
      throw new TypeError('Rollout completion metadata is invalid');
    }
    return run(async client => {
      await requireLease(client, input, lease);
      const row = await client.query(
        'SELECT acknowledged, replica_ids FROM tutorial_credential_rollouts WHERE rollout_id = $1 FOR UPDATE',
        [input.rolloutId],
      );
      const ackIds = Object.keys(row.rows[0].acknowledged ?? {}).sort();
      if (JSON.stringify(ackIds) !== JSON.stringify(replicaIds) ||
          JSON.stringify([...row.rows[0].replica_ids].sort()) !== JSON.stringify(replicaIds)) {
        throw new Error('All replicas must acknowledge before rollout completion');
      }
      const control = await client.query(
        'SELECT current_version FROM tutorial_rollout_control WHERE singleton_id = 1 FOR UPDATE',
      );
      if (BigInt(input.targetVersion) < BigInt(control.rows[0].current_version)) {
        throw new Error('Rollout version rollback is not allowed');
      }
      const updated = await client.query(
        `UPDATE tutorial_credential_rollouts
            SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
                completed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE rollout_id = $1 AND lease_owner = $2::uuid AND fencing_token = $3::bigint`,
        [input.rolloutId, lease.ownerId, lease.fencingToken],
      );
      if (updated.rowCount !== 1) throw new Error('Rollout lease ownership changed');
      await client.query(
        `UPDATE tutorial_rollout_control
            SET current_version = $1, current_rollout_id = $2, updated_at = clock_timestamp()
          WHERE singleton_id = 1`,
        [input.targetVersion, input.rolloutId],
      );
    });
  }

  return Object.freeze({
    beginRollout,
    getRollout,
    resumeRollout,
    renewRollout,
    renewIntervalMs: Math.max(1_000, Math.floor(leaseMs / 3)),
    recordReplicaAck,
    recordReplicaFailure,
    markPartialRollout,
    completeRollout,
  });
}
