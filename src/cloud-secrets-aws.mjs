import { createHash } from 'node:crypto';
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
  if (hasString) {
    raw = response.SecretString;
  } else if (Buffer.isBuffer(response.SecretBinary) ||
      response.SecretBinary instanceof Uint8Array ||
      response.SecretBinary instanceof ArrayBuffer) {
    raw = Buffer.from(response.SecretBinary).toString('utf8');
  } else {
    throw new Error('AWS Secrets Manager returned an unsupported binary value');
  }
  const size = Buffer.byteLength(raw, 'utf8');
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
        !['schemaVersion', 'revision', 'tokens', 'auditKeyRing'].includes(key)) ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.revision !== 'string' || !VERSION.test(parsed.revision) ||
      !Array.isArray(parsed.tokens) || parsed.tokens.length === 0) {
    throw new TypeError('AWS cloud secret bundle must use schemaVersion 1 with revision, tokens and auditKeyRing');
  }
  if (expectedVersion !== undefined && parsed.revision !== expectedVersion) {
    throw new Error('AWS Secrets Manager did not return the pinned secret revision');
  }

  validateAuditKeyRing(parsed.auditKeyRing);
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
 *   "auditKeyRing": { "activeKeyId": "...", "keys": { "...": "..." } }
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
 * Prefer an ECS task role, EC2 instance profile or workload identity. Static
 * access keys are intentionally not accepted by this helper.
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
