import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAwsSecretsManagerPublisher } from '../src/cloud-secrets-aws.mjs';

const tokenA = 'aws-publisher-current-token-material-0123456789abcdef';
const tokenB = 'aws-publisher-next-token-material-0123456789abcdef';
const auditKey = 'aws-publisher-audit-signing-key-material-0123456789';
const auditKeyId = createHash('sha256').update(auditKey).digest('hex').slice(0, 16);

function snapshot(revision, token) {
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

function fakeLock({ loseAt } = {}) {
  let held = false;
  let assertions = 0;
  return {
    async withLock(resource, callback) {
      assert.equal(resource, 'aws-secrets-manager:tutorial/cloud/runtime');
      if (held) throw new Error('already locked');
      held = true;
      try {
        return await callback({
          async assertHeld() {
            assertions++;
            if (!held || assertions === loseAt) throw new Error('lease lost');
          },
        });
      } finally {
        held = false;
      }
    },
    get assertions() { return assertions; },
  };
}

function fakeAws(initial = snapshot('41', tokenA), options = {}) {
  const versions = new Map([[initial.revision, initial]]);
  const stages = new Map([
    ['AWSCURRENT', initial.revision],
    ['UTVREV_' + initial.revision, initial.revision],
  ]);
  const calls = [];
  class GetSecretValueCommand {
    constructor(input) { this.input = input; }
  }
  class DescribeSecretCommand {
    constructor(input) { this.input = input; }
  }
  class PutSecretValueCommand {
    constructor(input) { this.input = input; }
  }
  const client = {
    async send(command) {
      calls.push(command.input);
      if (command instanceof GetSecretValueCommand) {
        const revision = stages.get(command.input.VersionStage);
        if (!revision) throw new Error('stage missing');
        return {
          SecretString: JSON.stringify(versions.get(revision)),
          VersionId: 'aws-version-' + revision,
          VersionStages: [...stages.entries()]
            .filter(([, value]) => value === revision)
            .map(([stage]) => stage),
        };
      }
      if (command instanceof DescribeSecretCommand) {
        const versionIdsToStages = {};
        for (const [stage, revision] of stages.entries()) {
          const versionId = 'aws-version-' + revision;
          versionIdsToStages[versionId] ??= [];
          versionIdsToStages[versionId].push(stage);
        }
        return { VersionIdsToStages: versionIdsToStages };
      }
      if (command instanceof PutSecretValueCommand) {
        if (options.putError) throw new Error('AWS leaked ' + tokenB);
        const payload = JSON.parse(command.input.SecretString);
        const revision = payload.revision;
        if (versions.has(revision)) {
          throw new Error('version already exists');
        }
        versions.set(revision, payload);
        if (options.omitCustomStage !== true) {
          stages.set('UTVREV_' + revision, revision);
        }
        if (options.omitCurrentStage !== true) {
          stages.set('AWSCURRENT', revision);
        }
        return {
          VersionId: 'aws-version-' + revision,
          VersionStages: command.input.VersionStages,
        };
      }
      throw new Error('unknown AWS command');
    },
  };
  const publisher = createAwsSecretsManagerPublisher({
    client,
    GetSecretValueCommand,
    DescribeSecretCommand,
    PutSecretValueCommand,
    secretId: 'tutorial/cloud/runtime',
    publishLock: options.publishLock ?? fakeLock(),
  });
  return { publisher, calls, versions, stages };
}

test('publishes the next immutable revision and assigns AWSCURRENT plus UTVREV stage', async () => {
  const { publisher, calls, stages } = fakeAws();
  const result = await publisher.publishCloudSecretSnapshot({
    snapshot: { tokens: snapshot('0', tokenB).tokens, auditKeyRing: snapshot('0', tokenB).auditKeyRing },
    expectedCurrentVersion: '41',
  });

  assert.equal(result.version, '42');
  assert.equal(result.versionId, 'aws-version-42');
  assert.equal(result.idempotent, false);
  assert.deepEqual(stages.get('AWSCURRENT'), '42');
  assert.deepEqual(stages.get('UTVREV_42'), '42');
  const put = calls.find(call => call.SecretString);
  assert.deepEqual(put.VersionStages, ['AWSCURRENT', 'UTVREV_42']);
  assert.equal(put.ClientRequestToken.length, 32);
  assert.equal((await publisher.readCloudSecrets()).version, '42');
  assert.equal((await publisher.readCloudSecrets({ version: '42' })).version, '42');
});

test('retries idempotently when the exact next revision was already published', async () => {
  const { publisher, calls } = fakeAws();
  const next = snapshot('0', tokenB);
  const input = {
    snapshot: { tokens: next.tokens, auditKeyRing: next.auditKeyRing },
    expectedCurrentVersion: '41',
    clientRequestToken: '0123456789abcdef0123456789abcdef',
  };
  const first = await publisher.publishCloudSecretSnapshot(input);
  const second = await publisher.publishCloudSecretSnapshot(input);
  assert.equal(first.version, '42');
  assert.equal(first.idempotent, false);
  assert.equal(second.version, '42');
  assert.equal(second.idempotent, true);
  assert.equal(calls.filter(call => call.SecretString).length, 1);
});

test('rejects a stale expected current revision before writing', async () => {
  const current = snapshot('43', tokenA);
  const { publisher, calls } = fakeAws(current);
  await assert.rejects(publisher.publishCloudSecretSnapshot({
    snapshot: { tokens: snapshot('0', tokenB).tokens, auditKeyRing: snapshot('0', tokenB).auditKeyRing },
    expectedCurrentVersion: '41',
  }), /current secret revision changed/);
  assert.equal(calls.some(call => call.SecretString), false);
});

test('rejects invalid snapshot material before contacting PutSecretValue', async () => {
  const { publisher, calls } = fakeAws();
  await assert.rejects(publisher.publishCloudSecretSnapshot({
    snapshot: {
      tokens: [{ tokenId: 'bad', principalId: 'bad', token: 'short' }],
      auditKeyRing: { activeKeyId: auditKeyId, keys: { [auditKeyId]: auditKey } },
    },
    expectedCurrentVersion: '41',
  }), /invalid bearer-token registry|invalid audit key ring/);
  assert.equal(calls.some(call => call.SecretString), false);
});

test('requires a durable publish lock and verifies the lease before writing', async () => {
  const { publisher } = fakeAws();
  assert.ok(publisher);

  assert.throws(() => createAwsSecretsManagerPublisher({
    client: { send() {} },
    GetSecretValueCommand: class {},
    DescribeSecretCommand: class {},
    PutSecretValueCommand: class {},
    secretId: 'tutorial/cloud/runtime',
  }), /durable distributed publishLock/);

  const lock = fakeLock({ loseAt: 2 });
  const { publisher: leasePublisher, calls } = fakeAws(snapshot('41', tokenA), { publishLock: lock });
  await assert.rejects(leasePublisher.publishCloudSecretSnapshot({
    snapshot: { tokens: snapshot('0', tokenB).tokens, auditKeyRing: snapshot('0', tokenB).auditKeyRing },
    expectedCurrentVersion: '41',
  }), /lease is no longer valid/);
  assert.equal(calls.some(call => call.SecretString), false);
});

test('redacts AWS PutSecretValue errors', async () => {
  const { publisher } = fakeAws(snapshot('41', tokenA), { putError: true });
  await assert.rejects(publisher.publishCloudSecretSnapshot({
    snapshot: { tokens: snapshot('0', tokenB).tokens, auditKeyRing: snapshot('0', tokenB).auditKeyRing },
    expectedCurrentVersion: '41',
  }), error => error.message === 'AWS Secrets Manager write failed' &&
    !error.message.includes(tokenB));
});

test('rejects a successful PutSecretValue response if AWSCURRENT did not advance', async () => {
  const { publisher } = fakeAws(snapshot('41', tokenA), { omitCurrentStage: true });
  await assert.rejects(publisher.publishCloudSecretSnapshot({
    snapshot: { tokens: snapshot('0', tokenB).tokens, auditKeyRing: snapshot('0', tokenB).auditKeyRing },
    expectedCurrentVersion: '41',
  }), /current stage did not advance/);
});
