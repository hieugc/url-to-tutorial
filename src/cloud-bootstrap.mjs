import { createHash } from 'node:crypto';
import { createStudioServer } from './studio-server.mjs';

const OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;

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

async function authorizeOperator(operatorAuthenticator, context, action) {
  if (!operatorAuthenticator || typeof operatorAuthenticator.authorize !== 'function') {
    throw new Error('An authenticated operator workflow is required for cloud secret reload');
  }
  const identity = await operatorAuthenticator.authorize(context, { action });
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

  const snapshot = validateSecretSnapshot(await secretManager.readCloudSecrets());
  const initialTokenDigest = digestTokens(snapshot.tokens);
  const initialAuditKeyRing = auditKeyRingMetadata(snapshot.auditKeyRing);
  const studio = createStudioServerImpl({
    ...serverOptions,
    cloudMode: true,
    cloudTokens: snapshot.tokens,
    cloudAuditKey: null,
    cloudAuditKeyRing: snapshot.auditKeyRing,
  });
  if (!studio?.server || !studio.tokenAdmin || !studio.auditAdmin) {
    throw new Error('Cloud server factory did not return the trusted token/audit administration capabilities');
  }
  const liveKeyRing = studio.auditAdmin.keyMetadata();
  if (liveKeyRing.activeKeyId !== initialAuditKeyRing.activeKeyId ||
      JSON.stringify([...liveKeyRing.keyIds].sort()) !== JSON.stringify(initialAuditKeyRing.keyIds)) {
    studio.store?.close?.();
    throw new Error('Cloud server audit key ring does not match the secret manager snapshot');
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
    });
  }

  async function reloadTokens(context) {
    if (reloadInFlight) throw new Error('A cloud credential reload is already in progress');
    reloadInFlight = true;
    try {
      const actorId = await authorizeOperator(
        operatorAuthenticator, context, 'cloud.credentials.reload',
      );
      const next = validateSecretSnapshot(await secretManager.readCloudSecrets());
      if (BigInt(next.version) < BigInt(secretVersion)) {
        throw new Error('Secret manager returned an older snapshot revision; refusing credential rollback');
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

  return Object.freeze({
    server: studio.server,
    studio,
    status,
    reloadTokens,
  });
}
