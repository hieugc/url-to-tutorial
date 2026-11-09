import { createHash } from 'node:crypto';
import { createStudioServer } from './studio-server.mjs';
import { createCloudArtifactCipher } from './cloud-artifact-crypto.mjs';

const OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;

function artifactKeyRingMetadata(ring) {
  const cipher = createCloudArtifactCipher({ keyRing: ring });
  const metadata = cipher.keyMetadata();
  const keyMaterialDigest = createHash('sha256').update(JSON.stringify(
    metadata.keyIds.map(keyId => [
      keyId,
      createHash('sha256').update(Buffer.from(ring.keys[keyId], 'hex')).digest('hex'),
    ]),
  )).digest('hex');
  return Object.freeze({
    activeKeyId: metadata.activeKeyId,
    keyIds: metadata.keyIds,
    keyMaterialDigest,
  });
}

function validateSecretSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      typeof snapshot.version !== 'string' || !/^(0|[1-9][0-9]{0,127})$/.test(snapshot.version)) {
    throw new TypeError('Secret manager must return a non-empty versioned cloud secret snapshot');
  }
  if (!Array.isArray(snapshot.tokens) || snapshot.tokens.length === 0) {
    throw new TypeError('Secret manager snapshot must contain at least one cloud token');
  }
  const ring = snapshot.auditKeyRing;
  if (!ring || typeof ring !== 'object' || Array.isArray(ring) ||
      typeof ring.activeKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(ring.activeKeyId) ||
      !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys)) {
    throw new TypeError('Secret manager snapshot must contain a versioned audit key ring');
  }
  artifactKeyRingMetadata(snapshot.artifactKeyRing);
  return snapshot;
}

function digestTokens(tokens) {
  const normalized = tokens.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string') {
      throw new TypeError('Secret manager cloud token entries must contain a token');
    }
    return {
      tokenId: entry.tokenId ?? entry.id ?? null,
      principalId: entry.principalId ?? entry.id ?? null,
      tenantId: entry.tenantId ?? null,
      projectIds: Array.isArray(entry.projectIds) ? [...entry.projectIds].sort() : null,
      expiresAt: entry.expiresAt ?? null,
      token: entry.token,
    };
  }).sort((a, b) => String(a.tokenId).localeCompare(String(b.tokenId)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function auditKeyRingMetadata(ring) {
  const keyIds = Object.keys(ring.keys).sort();
  if (!keyIds.includes(ring.activeKeyId)) {
    throw new TypeError('Secret manager audit key ring does not include its active key');
  }
  for (const keyId of keyIds) {
    const value = ring.keys[keyId];
    if (!/^[a-f0-9]{16}$/.test(keyId) ||
        (typeof value !== 'string' && !Buffer.isBuffer(value))) {
      throw new TypeError('Secret manager audit key entries must use 16-hex IDs and string/Buffer keys');
    }
    const key = Buffer.from(value);
    if (key.length < 32 ||
        createHash('sha256').update(key).digest('hex').slice(0, 16) !== keyId) {
      throw new TypeError('Secret manager audit key fingerprint does not match its key material');
    }
  }
  const keyMaterialDigest = createHash('sha256').update(JSON.stringify(keyIds.map(keyId => [
    keyId,
    createHash('sha256').update(Buffer.from(ring.keys[keyId])).digest('hex'),
  ]))).digest('hex');
  return Object.freeze({
    activeKeyId: ring.activeKeyId,
    keyIds: Object.freeze(keyIds),
    keyMaterialDigest,
  });
}

async function readCloudSecrets(secretManager, options) {
  try {
    return options === undefined
      ? await secretManager.readCloudSecrets()
      : await secretManager.readCloudSecrets(options);
  } catch {
    // Provider errors may contain request details; never forward them to callers.
    throw new Error('Cloud secret manager read failed');
  }
}

async function authorizeOperator(operatorAuthenticator, context, action, constraints = {}) {
  if (!operatorAuthenticator || typeof operatorAuthenticator.authorize !== 'function') {
    throw new Error('An authenticated operator workflow is required for cloud secret reload');
  }
  let identity;
  try {
    identity = await operatorAuthenticator.authorize(context, { action, ...constraints });
  } catch {
    throw new Error('Cloud secret reload operator authorization failed');
  }
  if (!identity || identity.mfaVerified !== true || typeof identity.actorId !== 'string' ||
      !OPERATOR_ID.test(identity.actorId)) {
    throw new Error('Cloud secret reload requires an MFA-verified operator identity');
  }
  return identity.actorId;
}

/**
 * Bootstraps the opt-in Cloud API from a host-injected secret manager.
 *
 * This module deliberately has no vendor SDK and no HTTP administration route.
 * The deployment supplies a secretManager.readCloudSecrets() adapter and an
 * operatorAuthenticator.authorize() adapter; credentials never enter env vars.
 */
export async function createCloudStudioFromSecretManager({
  secretManager,
  operatorAuthenticator,
  serverOptions = {},
  createStudioServerImpl = createStudioServer,
} = {}) {
  if (!secretManager || typeof secretManager.readCloudSecrets !== 'function') {
    throw new TypeError('A secret manager with readCloudSecrets() is required');
  }
  if (!serverOptions || typeof serverOptions !== 'object' || Array.isArray(serverOptions)) {
    throw new TypeError('Cloud server options must be an object');
  }
  if (typeof createStudioServerImpl !== 'function') {
    throw new TypeError('createStudioServerImpl must be a function');
  }

  const snapshot = validateSecretSnapshot(await readCloudSecrets(secretManager));
  const initialTokenDigest = digestTokens(snapshot.tokens);
  const initialAuditKeyRing = auditKeyRingMetadata(snapshot.auditKeyRing);
  const initialArtifactKeyRing = artifactKeyRingMetadata(snapshot.artifactKeyRing);
  const studio = createStudioServerImpl({
    ...serverOptions,
    cloudMode: true,
    cloudTokens: snapshot.tokens,
    cloudAuditKey: null,
    cloudAuditKeyRing: snapshot.auditKeyRing,
    cloudArtifactKeyRing: snapshot.artifactKeyRing,
  });
  if (!studio?.server || !studio.tokenAdmin || !studio.auditAdmin ||
      typeof studio.protectCloudArtifacts !== 'function') {
    throw new Error('Cloud server factory did not return the trusted token/audit administration capabilities');
  }
  const liveKeyRing = studio.auditAdmin.keyMetadata();
  if (liveKeyRing.activeKeyId !== initialAuditKeyRing.activeKeyId ||
      JSON.stringify([...liveKeyRing.keyIds].sort()) !== JSON.stringify(initialAuditKeyRing.keyIds)) {
    studio.store?.close?.();
    throw new Error('Cloud server audit key ring does not match the secret manager snapshot');
  }

  // Docker-backed workers expose this hook. Run it only after Studio has
  // recovered persisted jobs, and before the caller can listen for requests.
  // A failed reconciliation must fail closed rather than accept work with
  // potentially leaked per-job network state.
  const reconcileNetworks = serverOptions.cloudWorker?.reconcileOrphanedNetworks;
  if (typeof reconcileNetworks === 'function') {
    try {
      if (!(studio.jobs instanceof Map)) {
        throw new Error('Cloud Studio did not expose its recovered job inventory');
      }
      const activeJobIds = [...studio.jobs.values()]
        .filter(job => ['queued', 'running'].includes(job?.status))
        .map(job => job.id);
      const recovery = await reconcileNetworks({ activeJobIds });
      if (!recovery || !Array.isArray(recovery.failed) || recovery.failed.length > 0) {
        throw new Error('Docker network reconciliation was incomplete');
      }
    } catch {
      studio.store?.close?.();
      throw new Error('Cloud Docker network recovery failed; refusing to start the Cloud API');
    }
  }

  try {
    // Encrypt legacy plaintext artifacts and SQLite job snapshots before the
    // HTTP server is returned to its caller and can accept tenant requests.
    await studio.protectCloudArtifacts();
  } catch {
    try { studio.store?.close?.(); } catch {}
    throw new Error('Cloud artifact protection failed; refusing to start the Cloud API');
  }

  let secretVersion = snapshot.version;
  let tokenDigest = initialTokenDigest;
  const keyRingDigest = initialAuditKeyRing.keyMaterialDigest;
  let tokenMetadata = studio.tokenAdmin.list();
  let reloadInFlight = false;

  function status() {
    return Object.freeze({
      secretVersion,
      tokenCount: tokenMetadata.length,
      tokenIds: Object.freeze(tokenMetadata.map(token => token.tokenId)),
      auditKeyRing: studio.auditAdmin.keyMetadata(),
      artifactKeyRing: Object.freeze({
        activeKeyId: initialArtifactKeyRing.activeKeyId,
        keyIds: initialArtifactKeyRing.keyIds,
      }),
    });
  }

  async function reloadTokens(context, options = {}) {
    if (reloadInFlight) throw new Error('A cloud credential reload is already in progress');
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => !['expectedVersion', 'rolloutId', 'replicaId'].includes(key))) {
      throw new TypeError('Cloud credential reload options are invalid');
    }
    const expectedVersion = options.expectedVersion;
    const rolloutId = options.rolloutId;
    const replicaId = options.replicaId;
    if (expectedVersion !== undefined &&
        (typeof expectedVersion !== 'string' || !/^(0|[1-9][0-9]{0,127})$/.test(expectedVersion))) {
      throw new TypeError('A valid pinned secret version is required');
    }
    if (rolloutId !== undefined &&
        (typeof rolloutId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(rolloutId))) {
      throw new TypeError('A valid credential rollout ID is required');
    }
    if (replicaId !== undefined &&
        (typeof replicaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(replicaId))) {
      throw new TypeError('A valid credential replica ID is required');
    }
    reloadInFlight = true;
    try {
      const actorId = await authorizeOperator(
        operatorAuthenticator,
        context,
        'cloud.credentials.reload',
        {
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          ...(rolloutId === undefined ? {} : { rolloutId }),
          ...(replicaId === undefined ? {} : { replicaId }),
        },
      );
      const next = validateSecretSnapshot(await readCloudSecrets(
        secretManager,
        expectedVersion === undefined ? undefined : { version: expectedVersion },
      ));
      if (expectedVersion !== undefined && next.version !== expectedVersion) {
        throw new Error('Secret manager did not return the pinned credential revision');
      }
      if (BigInt(next.version) < BigInt(secretVersion)) {
        throw new Error('Secret manager returned an older snapshot revision; refusing credential rollback');
      }
      const nextArtifactRing = artifactKeyRingMetadata(next.artifactKeyRing);
      if (nextArtifactRing.activeKeyId !== initialArtifactKeyRing.activeKeyId ||
          JSON.stringify([...nextArtifactRing.keyIds].sort()) !== JSON.stringify([...initialArtifactKeyRing.keyIds].sort()) ||
          nextArtifactRing.keyMaterialDigest !== initialArtifactKeyRing.keyMaterialDigest) {
        throw new Error('Artifact key ring changes require a coordinated restart and staged key rotation');
      }
      const nextRing = auditKeyRingMetadata(next.auditKeyRing);
      if (nextRing.activeKeyId !== initialAuditKeyRing.activeKeyId ||
          JSON.stringify([...nextRing.keyIds].sort()) !== JSON.stringify(initialAuditKeyRing.keyIds) ||
          nextRing.keyMaterialDigest !== keyRingDigest) {
        throw new Error('Audit key ring changes require the separate staged key-rotation workflow');
      }

      const nextTokenDigest = digestTokens(next.tokens);
      if (next.version === secretVersion && nextTokenDigest !== tokenDigest) {
        throw new Error('Secret manager changed credentials without advancing the snapshot version');
      }
      if (nextTokenDigest !== tokenDigest) {
        // replace() writes the operator audit event before swapping the in-memory
        // registry, so a failed SQLite audit append leaves active credentials intact.
        tokenMetadata = studio.tokenAdmin.replace(next.tokens, { actorId });
        tokenDigest = nextTokenDigest;
      }
      secretVersion = next.version;
      return status();
    } finally {
      reloadInFlight = false;
    }
  }

  // Do not return the raw Studio object: it contains tokenAdmin, auditAdmin,
  // SQLite handles and in-memory signing keys. Expose only the HTTP server and
  // the MFA-gated reload/status capabilities.
  return Object.freeze({
    server: studio.server,
    status,
    reloadTokens,
    // Narrow host-only capability: archive audit batches without exposing the
    // raw auditAdmin, SQLite store, signing keys or token administration.
    archiveAuditBatch: studio.auditAdmin.archiveBatch,
  });
}
