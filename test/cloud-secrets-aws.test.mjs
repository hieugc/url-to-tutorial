import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AWS_SECRET_REVISION_STAGE_PREFIX,
  awsSecretRevisionStage,
  createAwsSecretsManagerAdapter,
  createDefaultAwsSecretsManagerAdapter,
} from '../src/cloud-secrets-aws.mjs';

const token = 'aws-secrets-manager-token-material-0123456789abcdef';
const auditKey = 'aws-secrets-manager-audit-key-material-0123456789';
const auditKeyId = createHash('sha256').update(auditKey).digest('hex').slice(0, 16);

function bundle(revision = '42') {
  return {
    schemaVersion: 1,
    revision,
    tokens: [{
      tokenId: 'service-a-current',
      principalId: 'service-a',
      token,
      tenantId: 'tenant-a',
      projectIds: ['project-a'],
    }],
    auditKeyRing: { activeKeyId: auditKeyId, keys: { [auditKeyId]: auditKey } },
  };
}

function adapterFor(response, calls = []) {
  class GetSecretValueCommand {
    constructor(input) { this.input = input; }
  }
  const client = {
    async send(command) {
      calls.push(command.input);
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(command.input) : response;
    },
  };
  return createAwsSecretsManagerAdapter({
    client,
    GetSecretValueCommand,
    secretId: 'tutorial/cloud/runtime',
  });
}

test('maps latest AWS secret to AWSCURRENT and returns a validated cloud snapshot', async () => {
  const calls = [];
  const adapter = adapterFor({ SecretString: JSON.stringify(bundle()) }, calls);
  const snapshot = await adapter.readCloudSecrets();

  assert.deepEqual(calls, [{
    SecretId: 'tutorial/cloud/runtime',
    VersionStage: 'AWSCURRENT',
  }]);
  assert.equal(snapshot.version, '42');
  assert.equal(snapshot.tokens[0].tokenId, 'service-a-current');
  assert.equal(snapshot.auditKeyRing.activeKeyId, auditKeyId);
});

test('maps a pinned decimal revision to its immutable custom AWS version stage', async () => {
  const calls = [];
  const adapter = adapterFor({ SecretString: JSON.stringify(bundle('42')) }, calls);
  const snapshot = await adapter.readCloudSecrets({ version: '42' });

  assert.deepEqual(calls, [{
    SecretId: 'tutorial/cloud/runtime',
    VersionStage: 'UTVREV_42',
  }]);
  assert.equal(snapshot.version, '42');
});

test('rejects an AWS version stage that points to a different payload revision', async () => {
  const adapter = adapterFor({ SecretString: JSON.stringify(bundle('43')) });
  await assert.rejects(adapter.readCloudSecrets({ version: '42' }),
    /did not return the pinned secret revision/);
});

test('supports SecretBinary returned by the AWS SDK as a byte array', async () => {
  const adapter = adapterFor({ SecretBinary: new Uint8Array(Buffer.from(JSON.stringify(bundle()))) });
  const snapshot = await adapter.readCloudSecrets();
  assert.equal(snapshot.version, '42');
});

test('rejects missing, ambiguous, oversized and malformed AWS secret values', async t => {
  const cases = [
    ['missing value', {}, /exactly one string or binary/],
    ['both value types', {
      SecretString: JSON.stringify(bundle()),
      SecretBinary: Buffer.from(JSON.stringify(bundle())),
    }, /exactly one string or binary/],
    ['invalid JSON', { SecretString: '{invalid-json' }, /not valid JSON/],
    ['empty value', { SecretString: '' }, /between 1 byte and 64 KiB/],
    ['oversized value', { SecretString: 'x'.repeat(64 * 1024 + 1) }, /between 1 byte and 64 KiB/],
    ['oversized binary', { SecretBinary: new Uint8Array(64 * 1024 + 1) }, /between 1 byte and 64 KiB/],
    ['unsupported binary', { SecretBinary: 'not-a-byte-array' }, /unsupported binary/],
  ];
  for (const [name, response, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(adapterFor(response).readCloudSecrets(), expected);
    });
  }
});

test('rejects unsupported schema, extra fields and invalid secret revisions', async t => {
  const cases = [
    ['wrong schema version', { ...bundle(), schemaVersion: 2 }, /schemaVersion 1/],
    ['extra top-level field', { ...bundle(), awsAccessKeyId: 'not-allowed' }, /schemaVersion 1/],
    ['non-canonical revision', { ...bundle(), revision: '0042' }, /schemaVersion 1/],
    ['empty token list', { ...bundle(), tokens: [] }, /schemaVersion 1/],
    ['invalid audit key fingerprint', {
      ...bundle(), auditKeyRing: { activeKeyId: '0000000000000000', keys: { '0000000000000000': auditKey } },
    }, /audit key fingerprint/],
    ['missing active audit key', {
      ...bundle(), auditKeyRing: { activeKeyId: '0000000000000000', keys: { [auditKeyId]: auditKey } },
    }, /missing its active audit key/],
    ['invalid bearer token', {
      ...bundle(), tokens: [{ ...bundle().tokens[0], token: 'short' }],
    }, /invalid bearer-token registry/],
  ];
  for (const [name, value, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(adapterFor({ SecretString: JSON.stringify(value) }).readCloudSecrets(), expected);
    });
  }
});

test('validates pinned read options and AWS revision stage formatting', async () => {
  const adapter = adapterFor({ SecretString: JSON.stringify(bundle()) });
  await assert.rejects(adapter.readCloudSecrets({ version: '0042' }), /one valid version/);
  await assert.rejects(adapter.readCloudSecrets({ version: '42', unexpected: true }), /one valid version/);
  assert.equal(AWS_SECRET_REVISION_STAGE_PREFIX, 'UTVREV_');
  assert.equal(awsSecretRevisionStage('42'), 'UTVREV_42');
  assert.throws(() => awsSecretRevisionStage('0042'), /canonical decimal/);
  assert.throws(() => awsSecretRevisionStage('x'.repeat(129)), /canonical decimal/);
});

test('redacts AWS SDK provider errors and rejects invalid adapter construction', async () => {
  const adapter = adapterFor(new Error('AWS request leaked secret value ' + token));
  await assert.rejects(adapter.readCloudSecrets(), error =>
    error.message === 'AWS Secrets Manager read failed' && !error.message.includes(token));

  class GetSecretValueCommand {}
  assert.throws(() => createAwsSecretsManagerAdapter({
    client: { send() {} }, GetSecretValueCommand,
  }), /secret ID or ARN/);
  assert.throws(() => createAwsSecretsManagerAdapter({
    client: {}, GetSecretValueCommand, secretId: 'tutorial/cloud/runtime',
  }), /SDK client and GetSecretValueCommand/);
});

test('default AWS adapter validates region before loading the optional SDK', async () => {
  await assert.rejects(createDefaultAwsSecretsManagerAdapter({
    region: 'invalid-region',
    secretId: 'tutorial/cloud/runtime',
  }), /valid AWS region/);
});
