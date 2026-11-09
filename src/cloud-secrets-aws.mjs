import { createHash, randomUUID } from 'node:crypto';
import { createCloudAuth } from './cloud-auth.mjs';

export const AWS_SECRET_REVISION_STAGE_PREFIX = 'UTVREV_';
const VERSION = /^(0|[1-9][0-9]{0,127})$/;
const MAX_SECRET_BYTES = 64 * 1024;

function validateSecretId(secretId) {
  if (typeof secretId !== 'string' || !secretId.trim() ||
      secretId.length > 512 || /[\u0000-\u0020\u007f]/.test(secretId)) {
    throw new TypeError('A valid AWS Secrets Manager secret ID or ARN is required');
  }
  return secretId.trim();
}

export function awsSecretRevisionStage(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new TypeError('AWS secret revision must be a canonical decimal string');
  }
  const stage = AWS_SECRET_REVISION_STAGE_PREFIX + version;
  if (stage.length > 256) throw new TypeError('AWS secret revision stage exceeds 256 characters');
  return stage;
}

function decodeSecretValue(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('AWS Secrets Manager returned an invalid response');
  }
  const hasString = typeof response.SecretString === 'string';
  const hasBinary = response.SecretBinary !== undefined && response.SecretBinary !== null;
  if (hasString === hasBinary) {
    throw new Error('AWS Secrets Manager must return exactly one string or binary secret value');
  }

  let raw;
  let size;
  if (hasString) {
    raw = response.SecretString;
    size = Buffer.byteLength(raw, 'utf8');
  } else if (Buffer.isBuffer(response.SecretBinary) ||
      response.SecretBinary instanceof Uint8Array ||
      response.SecretBinary instanceof ArrayBuffer) {
    size = response.SecretBinary.byteLength;
    if (size < 1 || size > MAX_SECRET_BYTES) {
      throw new Error('AWS cloud secret bundle must be between 1 byte and 64 KiB');
    }
    raw = Buffer.from(response.SecretBinary).toString('utf8');
  } else {
    throw new Error('AWS Secrets Manager returned an unsupported binary value');
  }
  if (size < 1 || size > MAX_SECRET_BYTES) {
    throw new Error('AWS cloud secret bundle must be between 1 byte and 64 KiB');
  }
  return raw;
}

function validateAuditKeyRing(ring) {
  if (!ring || typeof ring !== 'object' || Array.isArray(ring) ||
      Object.getPrototypeOf(ring) !== Object.prototype ||
      Object.keys(ring).some(key => !['activeKeyId', 'keys'].includes(key)) ||
      typeof ring.activeKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(ring.activeKeyId) ||
      !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys) ||
      Object.getPrototypeOf(ring.keys) !== Object.prototype) {
    throw new TypeError('AWS cloud secret bundle contains an invalid audit key ring');
  }

  const keyIds = Object.keys(ring.keys);
  if (!keyIds.length || !keyIds.includes(ring.activeKeyId)) {
    throw new TypeError('AWS cloud secret bundle is missing its active audit key');
  }
  for (const keyId of keyIds) {
    const key = ring.keys[keyId];
    if (!/^[a-f0-9]{16}$/.test(keyId) || typeof key !== 'string' ||
        Buffer.byteLength(key, 'utf8') < 32 ||
        createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16) !== keyId) {
      throw new TypeError('AWS cloud secret bundle contains an invalid audit key fingerprint');
    }
  }
}

function validateArtifactKeyRing(ring) {
  if (!ring || typeof ring !== 'object' || Array.isArray(ring) ||
      Object.getPrototypeOf(ring) !== Object.prototype ||
      Object.keys(ring).some(key => !['activeKeyId', 'keys'].includes(key)) ||
      typeof ring.activeKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(ring.activeKeyId) ||
      !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys) ||
      Object.getPrototypeOf(ring.keys) !== Object.prototype) {
    throw new TypeError('AWS cloud secret bundle contains an invalid artifact encryption key ring');
  }
  const keyIds = Object.keys(ring.keys);
  if (!keyIds.length || keyIds.length > 32 || !keyIds.includes(ring.activeKeyId)) {
    throw new TypeError('AWS cloud secret bundle is missing its active artifact encryption key');
  }
  for (const keyId of keyIds) {
    const value = ring.keys[keyId];
    if (!/^[a-f0-9]{16}$/.test(keyId) || typeof value !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value) ||
        createHash('sha256').update(Buffer.from(value, 'hex')).digest('hex').slice(0, 16) !== keyId) {
      throw new TypeError('AWS cloud secret bundle contains an invalid artifact encryption key fingerprint');
    }
  }
}

function parseCloudSecret(raw, expectedVersion) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('AWS cloud secret bundle is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      Object.keys(parsed).some(key =>
        !['schemaVersion', 'revision', 'tokens', 'auditKeyRing', 'artifactKeyRing'].includes(key)) ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.revision !== 'string' || !VERSION.test(parsed.revision) ||
      !Array.isArray(parsed.tokens) || parsed.tokens.length === 0) {
    throw new TypeError('AWS cloud secret bundle must use schemaVersion 1 with revision, tokens and auditKeyRing');
  }
  if (expectedVersion !== undefined && parsed.revision !== expectedVersion) {
    throw new Error('AWS Secrets Manager did not return the pinned secret revision');
  }

  validateAuditKeyRing(parsed.auditKeyRing);
  validateArtifactKeyRing(parsed.artifactKeyRing);
  // Reuse the production registry validator; it retains only token digests.
  try {
    createCloudAuth({ tokens: parsed.tokens });
  } catch {
    throw new TypeError('AWS cloud secret bundle contains an invalid bearer-token registry');
  }

  return {
    version: parsed.revision,
    tokens: parsed.tokens,
    auditKeyRing: parsed.auditKeyRing,
    artifactKeyRing: parsed.artifactKeyRing,
  };
}

/**
 * AWS Secrets Manager read adapter.
 *
 * Secret JSON schema:
 * {
 *   "schemaVersion": 1,
 *   "revision": "42",
 *   "tokens": [...],
 *   "auditKeyRing": { "activeKeyId": "...", "keys": { "...": "..." } },
 *   "artifactKeyRing": { "activeKeyId": "...", "keys": { "...": "<32-byte lowercase hex>" } }
 * }
 *
 * The writer must attach the immutable custom version stage UTVREV_<revision>
 * to each version and must never move/reuse that stage. AWSCURRENT selects the
 * latest revision; custom stages let every API replica fetch the exact same
 * revision during a coordinated rollout.
 */
export function createAwsSecretsManagerAdapter({
  client,
  GetSecretValueCommand,
  secretId,
} = {}) {
  if (!client || typeof client.send !== 'function' ||
      typeof GetSecretValueCommand !== 'function') {
    throw new TypeError('AWS Secrets Manager requires an SDK client and GetSecretValueCommand');
  }
  const id = validateSecretId(secretId);

  return Object.freeze({
    async readCloudSecrets(options) {
      let expectedVersion;
      if (options !== undefined) {
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            Object.getPrototypeOf(options) !== Object.prototype ||
            Object.keys(options).some(key => key !== 'version') ||
            typeof options.version !== 'string' || !VERSION.test(options.version)) {
          throw new TypeError('AWS cloud secret read options must contain one valid version');
        }
        expectedVersion = options.version;
      }

      const versionStage = expectedVersion === undefined
        ? 'AWSCURRENT'
        : awsSecretRevisionStage(expectedVersion);
      let response;
      try {
        response = await client.send(new GetSecretValueCommand({
          SecretId: id,
          VersionStage: versionStage,
        }));
      } catch {
        // AWS SDK errors can include request metadata; never forward them to callers.
        throw new Error('AWS Secrets Manager read failed');
      }
      return parseCloudSecret(decodeSecretValue(response), expectedVersion);
    },
  });
}

/**
 * Construct the AWS SDK client using its default credential provider chain.
 * Prefer an ECS task role, EC2 instance profile or workload identity. This
 * helper does not accept explicit credential values; the SDK default chain may
 * still resolve environment or shared-profile credentials if the host provides them.
 */
export async function createDefaultAwsSecretsManagerAdapter({ region, secretId } = {}) {
  if (typeof region !== 'string' || !/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/.test(region)) {
    throw new TypeError('A valid AWS region is required for Secrets Manager');
  }
  const id = validateSecretId(secretId);
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-secrets-manager');
  } catch {
    throw new Error('Install @aws-sdk/client-secrets-manager in the cloud host before using AWS Secrets Manager');
  }
  const client = new sdk.SecretsManagerClient({ region });
  const adapter = createAwsSecretsManagerAdapter({
    client,
    GetSecretValueCommand: sdk.GetSecretValueCommand,
    secretId: id,
  });
  return Object.freeze({
    readCloudSecrets: adapter.readCloudSecrets,
    close() {
      if (typeof client.destroy === 'function') client.destroy();
    },
  });
}


async function assertPublishLease(lease) {
  if (!lease || typeof lease.assertHeld !== 'function') {
    throw new Error('AWS secret publication requires an active distributed lease');
  }
  try {
    await lease.assertHeld();
  } catch {
    throw new Error('AWS secret publication lease is no longer valid');
  }
}

function sameCloudSnapshot(left, right) {
  return JSON.stringify({
    tokens: left.tokens,
    auditKeyRing: left.auditKeyRing,
    artifactKeyRing: left.artifactKeyRing,
  }) === JSON.stringify({
    tokens: right.tokens,
    auditKeyRing: right.auditKeyRing,
    artifactKeyRing: right.artifactKeyRing,
  });
}

/**
 * AWS Secrets Manager publisher.
 *
 * A durable shared publishLock is mandatory because Secrets Manager does not
 * provide a compare-and-set condition for AWSCURRENT. The lock must serialize
 * every writer for this secret across all hosts and expose assertHeld() so a
 * stale publisher cannot continue after its lease is reclaimed.
 */
export function createAwsSecretsManagerPublisher({
  client,
  GetSecretValueCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  secretId,
  publishLock,
} = {}) {
  if (!client || typeof client.send !== 'function' ||
      typeof DescribeSecretCommand !== 'function' ||
      typeof PutSecretValueCommand !== 'function') {
    throw new TypeError('AWS Secrets Manager publisher requires an SDK client, DescribeSecretCommand and PutSecretValueCommand');
  }
  if (!publishLock || typeof publishLock.withLock !== 'function') {
    throw new TypeError('AWS secret publishing requires a durable distributed publishLock');
  }
  const id = validateSecretId(secretId);
  const reader = createAwsSecretsManagerAdapter({
    client,
    GetSecretValueCommand,
    secretId: id,
  });

  return Object.freeze({
    readCloudSecrets: reader.readCloudSecrets,
    async publishCloudSecretSnapshot({
      snapshot,
      expectedCurrentVersion,
      clientRequestToken,
    } = {}) {
      if (typeof expectedCurrentVersion !== 'string' || !VERSION.test(expectedCurrentVersion)) {
        throw new TypeError('A valid expected current secret revision is required');
      }
      const nextVersion = (BigInt(expectedCurrentVersion) + 1n).toString();
      const customStage = awsSecretRevisionStage(nextVersion);
      const payload = {
        schemaVersion: 1,
        revision: nextVersion,
        tokens: snapshot?.tokens,
        auditKeyRing: snapshot?.auditKeyRing,
        artifactKeyRing: snapshot?.artifactKeyRing,
      };

      let secretString;
      try {
        secretString = JSON.stringify(payload);
      } catch {
        throw new TypeError('AWS cloud secret snapshot is not serializable');
      }
      if (typeof secretString !== 'string' ||
          Buffer.byteLength(secretString, 'utf8') < 1 ||
          Buffer.byteLength(secretString, 'utf8') > MAX_SECRET_BYTES) {
        throw new TypeError('AWS cloud secret bundle must be between 1 byte and 64 KiB');
      }
      const validated = parseCloudSecret(secretString, nextVersion);
      const requestToken = clientRequestToken ?? randomUUID().replaceAll('-', '');
      if (typeof requestToken !== 'string' || !/^[A-Za-z0-9-]{32,64}$/.test(requestToken)) {
        throw new TypeError('AWS ClientRequestToken must contain 32 to 64 safe characters');
      }

      return publishLock.withLock('aws-secrets-manager:' + id, async lease => {
        await assertPublishLease(lease);
        const current = await reader.readCloudSecrets();

        // A retry after a successful PutSecretValue is idempotent only when the
        // pinned revision contains exactly the same credential and key material.
        if (current.version === nextVersion) {
          const pinned = await reader.readCloudSecrets({ version: nextVersion });
          if (!sameCloudSnapshot(pinned, validated)) {
            throw new Error('AWS secret revision already exists with different material');
          }
          return Object.freeze({
            version: nextVersion,
            versionId: null,
            versionStages: Object.freeze(['AWSCURRENT', customStage]),
            idempotent: true,
          });
        }
        if (current.version !== expectedCurrentVersion) {
          throw new Error('AWS current secret revision changed; refusing stale publication');
        }

        await assertPublishLease(lease);
        let description;
        try {
          description = await client.send(new DescribeSecretCommand({ SecretId: id }));
        } catch {
          throw new Error('AWS secret version-stage inspection failed');
        }
        const versionStages = description?.VersionIdsToStages;
        if (!versionStages || typeof versionStages !== 'object' || Array.isArray(versionStages)) {
          throw new Error('AWS secret version-stage metadata is unavailable');
        }
        const attachedStages = Object.values(versionStages).filter(Array.isArray).flat();
        if (attachedStages.filter(stage => stage === 'AWSCURRENT').length !== 1) {
          throw new Error('AWS secret must have exactly one AWSCURRENT stage');
        }
        if (attachedStages.includes(customStage)) {
          throw new Error('AWS immutable revision stage already exists; refusing to move it');
        }

        await assertPublishLease(lease);
        let response;
        try {
          response = await client.send(new PutSecretValueCommand({
            SecretId: id,
            ClientRequestToken: requestToken,
            SecretString: secretString,
            VersionStages: ['AWSCURRENT', customStage],
          }));
        } catch {
          throw new Error('AWS Secrets Manager write failed');
        }
        await assertPublishLease(lease);

        const pinned = await reader.readCloudSecrets({ version: nextVersion });
        if (!sameCloudSnapshot(pinned, validated)) {
          throw new Error('AWS published revision failed immutable-stage verification');
        }
        const latest = await reader.readCloudSecrets();
        if (latest.version !== nextVersion) {
          throw new Error('AWS current stage did not advance to the published revision');
        }
        await assertPublishLease(lease);

        return Object.freeze({
          version: nextVersion,
          versionId: typeof response?.VersionId === 'string' ? response.VersionId : null,
          versionStages: Object.freeze(Array.isArray(response?.VersionStages)
            ? response.VersionStages.filter(stage => typeof stage === 'string')
            : ['AWSCURRENT', customStage]),
          idempotent: false,
        });
      });
    },
  });
}

/**
 * Construct an AWS SDK publisher with the SDK default credential provider chain.
 * The host must supply a durable distributed publishLock; this factory never
 * accepts static credential values.
 */
export async function createDefaultAwsSecretsManagerPublisher({
  region,
  secretId,
  publishLock,
} = {}) {
  if (typeof region !== 'string' || !/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/.test(region)) {
    throw new TypeError('A valid AWS region is required for Secrets Manager');
  }
  const id = validateSecretId(secretId);
  if (!publishLock || typeof publishLock.withLock !== 'function') {
    throw new TypeError('AWS secret publishing requires a durable distributed publishLock');
  }
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-secrets-manager');
  } catch {
    throw new Error('Install @aws-sdk/client-secrets-manager in the cloud host before using AWS Secrets Manager');
  }
  const client = new sdk.SecretsManagerClient({ region });
  const publisher = createAwsSecretsManagerPublisher({
    client,
    GetSecretValueCommand: sdk.GetSecretValueCommand,
    DescribeSecretCommand: sdk.DescribeSecretCommand,
    PutSecretValueCommand: sdk.PutSecretValueCommand,
    secretId: id,
    publishLock,
  });
  return Object.freeze({
    readCloudSecrets: publisher.readCloudSecrets,
    publishCloudSecretSnapshot: publisher.publishCloudSecretSnapshot,
    close() {
      if (typeof client.destroy === 'function') client.destroy();
    },
  });
}
