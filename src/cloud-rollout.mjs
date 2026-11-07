import { createHash, randomUUID } from 'node:crypto';

const OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;
const VERSION = /^(0|[1-9][0-9]{0,127})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

function requireFunction(value, name) {
  if (!value || typeof value[name] !== 'function') {
    throw new TypeError(name + ' adapter method is required');
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inspectSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      typeof snapshot.version !== 'string' || !VERSION.test(snapshot.version) ||
      !Array.isArray(snapshot.tokens) || snapshot.tokens.length === 0) {
    throw new TypeError('Secret manager returned an invalid versioned credential snapshot');
  }

  const tokenIds = [];
  const normalizedTokens = [];
  for (const token of snapshot.tokens) {
    if (!token || typeof token !== 'object' || Array.isArray(token) ||
        typeof token.token !== 'string' || token.token.length < 32) {
      throw new TypeError('Secret manager returned an invalid credential entry');
    }
    const tokenId = token.tokenId ?? token.id;
    const principalId = token.principalId ?? token.id;
    if (typeof tokenId !== 'string' || !IDENTIFIER.test(tokenId) ||
        typeof principalId !== 'string' || !IDENTIFIER.test(principalId)) {
      throw new TypeError('Secret manager returned an invalid credential identity');
    }
    tokenIds.push(tokenId);
    normalizedTokens.push({
      tokenId,
      principalId,
      tenantId: token.tenantId ?? null,
      projectIds: Array.isArray(token.projectIds) ? [...token.projectIds].sort() : null,
      expiresAt: token.expiresAt ?? null,
      token: token.token,
    });
  }
  if (new Set(tokenIds).size !== tokenIds.length) {
    throw new TypeError('Secret manager returned duplicate credential IDs');
  }
  tokenIds.sort();
  normalizedTokens.sort((a, b) => a.tokenId.localeCompare(b.tokenId));

  const ring = snapshot.auditKeyRing;
  if (!ring || typeof ring !== 'object' || Array.isArray(ring) ||
      typeof ring.activeKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(ring.activeKeyId) ||
      !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys)) {
    throw new TypeError('Secret manager returned an invalid audit signing-key ring');
  }
  const keyIds = Object.keys(ring.keys).sort();
  if (!keyIds.length || !keyIds.includes(ring.activeKeyId)) {
    throw new TypeError('Secret manager audit key ring is missing its active key');
  }
  const keyFingerprints = [];
  for (const keyId of keyIds) {
    const key = ring.keys[keyId];
    if (!/^[a-f0-9]{16}$/.test(keyId) ||
        (typeof key !== 'string' && !Buffer.isBuffer(key))) {
      throw new TypeError('Secret manager returned an invalid audit signing key');
    }
    const bytes = Buffer.from(key);
    if (bytes.length < 32 || hash(bytes).slice(0, 16) !== keyId) {
      throw new TypeError('Secret manager audit signing-key fingerprint mismatch');
    }
    keyFingerprints.push([keyId, hash(bytes)]);
  }

  const auditKeyRing = Object.freeze({
    activeKeyId: ring.activeKeyId,
    keyIds: Object.freeze(keyIds),
  });
  const snapshotDigest = hash(JSON.stringify({
    version: snapshot.version,
    tokens: normalizedTokens,
    auditKeyFingerprints: keyFingerprints,
  }));
  return Object.freeze({
    version: snapshot.version,
    tokenIds: Object.freeze(tokenIds),
    auditKeyRing,
    snapshotDigest,
  });
}

async function readSnapshot(secretManager, version) {
  try {
    return await secretManager.readCloudSecrets(
      version === undefined ? undefined : { version },
    );
  } catch {
    throw new Error('Cloud secret manager read failed');
  }
}

async function authorize(operatorAuthenticator, context, action) {
  let identity;
  try {
    identity = await operatorAuthenticator.authorize(context, { action });
  } catch {
    throw new Error('Cloud credential rollout authorization failed');
  }
  if (!identity || identity.mfaVerified !== true ||
      typeof identity.actorId !== 'string' || !OPERATOR_ID.test(identity.actorId)) {
    throw new Error('Cloud credential rollout requires an MFA-verified operator');
  }
  return Object.freeze({ actorId: identity.actorId, mfaVerified: true });
}

function validateReplicaList(replicas) {
  if (!Array.isArray(replicas) || replicas.length === 0) {
    throw new Error('No cloud API replicas are registered for credential rollout');
  }
  const ids = [];
  for (const replica of replicas) {
    if (!replica || typeof replica !== 'object' ||
        typeof replica.id !== 'string' || !IDENTIFIER.test(replica.id) ||
        typeof replica.reloadTokens !== 'function' || typeof replica.status !== 'function') {
      throw new TypeError('Replica directory returned an invalid replica adapter');
    }
    ids.push(replica.id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('Replica directory returned duplicate replica IDs');
  }
  return [...replicas].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeRecord(record, rolloutId) {
  if (!record || record.rolloutId !== rolloutId ||
      !VERSION.test(String(record.targetVersion)) ||
      !Array.isArray(record.replicaIds) ||
      !['in_progress', 'partial'].includes(record.state)) {
    throw new Error('Credential rollout record is missing or is not resumable');
  }
  const acknowledged = Array.isArray(record.acknowledgedReplicaIds)
    ? record.acknowledgedReplicaIds : [];
  return {
    ...record,
    targetVersion: String(record.targetVersion),
    replicaIds: [...record.replicaIds].sort(),
    acknowledgedReplicaIds: [...new Set(acknowledged)],
  };
}

function statusMatches(status, snapshot) {
  if (!status || status.secretVersion !== snapshot.version ||
      !Array.isArray(status.tokenIds) ||
      JSON.stringify([...status.tokenIds].sort()) !== JSON.stringify(snapshot.tokenIds)) {
    return false;
  }
  const ring = status.auditKeyRing;
  return Boolean(ring && ring.activeKeyId === snapshot.auditKeyRing.activeKeyId &&
    Array.isArray(ring.keyIds) &&
    JSON.stringify([...ring.keyIds].sort()) === JSON.stringify(snapshot.auditKeyRing.keyIds));
}

function safeErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'REPLICA_OPERATION_FAILED';
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function validateStore(store) {
  for (const method of [
    'beginRollout', 'getRollout', 'recordReplicaAck',
    'recordReplicaFailure', 'markPartialRollout', 'completeRollout',
  ]) requireFunction(store, method);
}

/**
 * Coordinates one immutable secret revision across a fixed set of API replicas.
 *
 * Host adapters must provide:
 * - a secret manager that can read the latest snapshot or pin an immutable revision;
 * - an MFA authenticator that can mint short-lived, per-replica assertions;
 * - mutually authenticated replica RPC clients;
 * - a durable rollout store with atomic begin/complete transitions.
 *
 * Raw credential material is never sent to replicas or written to the rollout
 * store. Each replica reads the exact pinned version from its own secret manager.
 */
export async function runCloudCredentialRollout({
  secretManager,
  operatorAuthenticator,
  replicaDirectory,
  rolloutStore,
  context,
  rolloutId,
  concurrency = 4,
  now = () => Date.now(),
} = {}) {
  requireFunction(secretManager, 'readCloudSecrets');
  requireFunction(operatorAuthenticator, 'authorize');
  requireFunction(operatorAuthenticator, 'createReplicaAssertion');
  requireFunction(replicaDirectory, 'list');
  validateStore(rolloutStore);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new TypeError('Credential rollout concurrency must be an integer from 1 to 32');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const resuming = rolloutId !== undefined;
  if (resuming && (typeof rolloutId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(rolloutId))) {
    throw new TypeError('A valid rollout ID is required when resuming');
  }

  let previousRecord = null;
  if (resuming) {
    try {
      previousRecord = normalizeRecord(await rolloutStore.getRollout(rolloutId), rolloutId);
    } catch {
      throw new Error('Credential rollout cannot be resumed');
    }
  }

  const identity = await authorize(
    operatorAuthenticator,
    context,
    resuming ? 'cloud.credentials.rollout.resume' : 'cloud.credentials.rollout',
  );

  const rawSnapshot = await readSnapshot(
    secretManager,
    previousRecord?.targetVersion,
  );
  const snapshot = inspectSnapshot(rawSnapshot);
  if (previousRecord && snapshot.snapshotDigest !== previousRecord.snapshotDigest) {
    throw new Error('Pinned secret revision no longer matches the recorded rollout; refusing resume');
  }

  let replicas;
  try {
    replicas = validateReplicaList(await replicaDirectory.list());
  } catch {
    throw new Error('Cloud API replica inventory is unavailable or invalid');
  }
  const replicaIds = replicas.map(replica => replica.id);
  if (previousRecord &&
      JSON.stringify(replicaIds) !== JSON.stringify(previousRecord.replicaIds)) {
    throw new Error('Replica inventory changed; start a new rollout instead of resuming');
  }

  const id = rolloutId ?? randomUUID();
  if (!previousRecord) {
    try {
      await rolloutStore.beginRollout({
        rolloutId: id,
        targetVersion: snapshot.version,
        snapshotDigest: snapshot.snapshotDigest,
        actorId: identity.actorId,
        replicaIds,
      });
    } catch {
      throw new Error('Credential rollout could not acquire its durable rollout record');
    }
  }

  let record;
  try {
    record = normalizeRecord(await rolloutStore.getRollout(id), id);
  } catch {
    throw new Error('Credential rollout record could not be read after initialization');
  }
  if (record.targetVersion !== snapshot.version ||
      record.snapshotDigest !== snapshot.snapshotDigest ||
      JSON.stringify(record.replicaIds) !== JSON.stringify(replicaIds)) {
    throw new Error('Credential rollout record does not match the pinned secret revision and replica set');
  }

  const acknowledged = new Set(record.acknowledgedReplicaIds);
  const failures = [];
  const completed = await mapLimit(replicas, concurrency, async replica => {
    try {
      if (acknowledged.has(replica.id)) {
        let current;
        try { current = await replica.status(); } catch { current = null; }
        if (statusMatches(current, snapshot)) {
          return { replicaId: replica.id, acknowledged: true, reused: true };
        }
      }

      let assertion;
      try {
        assertion = await operatorAuthenticator.createReplicaAssertion(identity, {
          action: 'cloud.credentials.reload',
          rolloutId: id,
          targetVersion: snapshot.version,
          replicaId: replica.id,
          expiresAt: new Date(now() + 60_000).toISOString(),
        });
      } catch {
        throw Object.assign(new Error('assertion failed'), { code: 'ASSERTION_ISSUE_FAILED' });
      }
      if (typeof assertion !== 'string' || assertion.length < 16 || assertion.length > 16_384) {
        throw Object.assign(new Error('invalid assertion'), { code: 'ASSERTION_INVALID' });
      }

      await replica.reloadTokens(assertion, {
        expectedVersion: snapshot.version,
        rolloutId: id,
        replicaId: replica.id,
      });
      const current = await replica.status();
      if (!statusMatches(current, snapshot)) {
        throw Object.assign(new Error('replica did not apply the pinned revision'), {
          code: 'REPLICA_VERSION_MISMATCH',
        });
      }

      try {
        await rolloutStore.recordReplicaAck({
          rolloutId: id,
          replicaId: replica.id,
          targetVersion: snapshot.version,
          actorId: identity.actorId,
          tokenIds: snapshot.tokenIds,
          auditKeyRing: snapshot.auditKeyRing,
        });
      } catch {
        throw Object.assign(new Error('ack persistence failed'), {
          code: 'ROLLOUT_ACK_PERSIST_FAILED',
        });
      }
      return { replicaId: replica.id, acknowledged: true, reused: false };
    } catch (error) {
      const errorCode = safeErrorCode(error);
      try {
        await rolloutStore.recordReplicaFailure({
          rolloutId: id,
          replicaId: replica.id,
          targetVersion: snapshot.version,
          actorId: identity.actorId,
          errorCode,
        });
      } catch {
        throw new Error('Credential rollout failure could not be durably recorded');
      }
      failures.push({ replicaId: replica.id, errorCode });
      return { replicaId: replica.id, acknowledged: false, errorCode };
    }
  });

  const failedReplicaIds = [...new Set(failures.map(item => item.replicaId))].sort();
  const acknowledgedReplicaIds = completed
    .filter(item => item.acknowledged)
    .map(item => item.replicaId)
    .sort();

  if (failedReplicaIds.length) {
    try {
      await rolloutStore.markPartialRollout({
        rolloutId: id,
        targetVersion: snapshot.version,
        acknowledgedReplicaIds,
        failedReplicaIds,
        actorId: identity.actorId,
      });
    } catch {
      throw new Error('Partial credential rollout state could not be persisted');
    }
    return Object.freeze({
      rolloutId: id,
      state: 'partial',
      targetVersion: snapshot.version,
      totalReplicas: replicas.length,
      acknowledgedReplicaIds: Object.freeze(acknowledgedReplicaIds),
      failedReplicaIds: Object.freeze(failedReplicaIds),
    });
  }

  try {
    await rolloutStore.completeRollout({
      rolloutId: id,
      targetVersion: snapshot.version,
      replicaIds,
      actorId: identity.actorId,
    });
  } catch {
    throw new Error('Credential rollout acknowledgements are complete but finalization failed');
  }
  return Object.freeze({
    rolloutId: id,
    state: 'completed',
    targetVersion: snapshot.version,
    totalReplicas: replicas.length,
    acknowledgedReplicaIds: Object.freeze(acknowledgedReplicaIds),
    failedReplicaIds: Object.freeze([]),
  });
}
