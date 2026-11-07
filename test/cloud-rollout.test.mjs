import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runCloudCredentialRollout } from '../src/cloud-rollout.mjs';
import { createCloudStudioFromSecretManager } from '../src/cloud-bootstrap.mjs';

const tokenA = 'multi-replica-tenant-token-material-0123456789';
const tokenB = 'multi-replica-tenant-token-rotated-0123456789';
const auditKey = 'multi-replica-audit-signing-key-material-0123456789';
const auditKeyId = createHash('sha256').update(auditKey).digest('hex').slice(0, 16);

function snapshot(version = '2', token = tokenB) {
  return {
    version,
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

function createStore() {
  const records = new Map();
  const leases = new Map();
  let leaseSequence = 0;
  let completedVersion = '0';
  const calls = [];
  const issueLease = id => {
    const leaseToken = 'rollout-fencing-token-' + (++leaseSequence);
    leases.set(id, leaseToken);
    return { leaseToken };
  };
  const assertLease = input => {
    if (!input.leaseToken || leases.get(input.rolloutId) !== input.leaseToken) {
      throw new Error('stale rollout fencing token');
    }
  };
  return {
    calls,
    records,
    async beginRollout(input) {
      calls.push({ method: 'beginRollout', input });
      const active = [...records.values()].find(record =>
        ['in_progress', 'partial'].includes(record.state));
      if (active) throw new Error('another rollout is active');
      if (BigInt(input.targetVersion) < BigInt(completedVersion)) {
        throw new Error('version rollback');
      }
      if (records.has(input.rolloutId)) throw new Error('duplicate rollout');
      records.set(input.rolloutId, {
        ...input,
        state: 'in_progress',
        acknowledgedReplicaIds: [],
        acknowledgements: {},
        failures: {},
      });
      return issueLease(input.rolloutId);
    },
    async getRollout(id) {
      const record = records.get(id);
      return record ? structuredClone(record) : null;
    },
    async resumeRollout(input) {
      calls.push({ method: 'resumeRollout', input });
      const record = records.get(input.rolloutId);
      if (!record || record.state !== 'partial') throw new Error('resume not allowed');
      record.state = 'in_progress';
      return issueLease(input.rolloutId);
    },
    async recordReplicaAck(input) {
      assertLease(input);
      calls.push({ method: 'recordReplicaAck', input });
      const record = records.get(input.rolloutId);
      record.acknowledgements[input.replicaId] = {
        targetVersion: input.targetVersion,
        tokenIds: [...input.tokenIds],
        auditKeyRing: structuredClone(input.auditKeyRing),
        actorId: input.actorId,
      };
      record.acknowledgedReplicaIds = Object.keys(record.acknowledgements).sort();
      delete record.failures[input.replicaId];
    },
    async recordReplicaFailure(input) {
      assertLease(input);
      calls.push({ method: 'recordReplicaFailure', input });
      const record = records.get(input.rolloutId);
      delete record.acknowledgements[input.replicaId];
      record.acknowledgedReplicaIds = Object.keys(record.acknowledgements).sort();
      record.failures[input.replicaId] = input.errorCode;
    },
    async markPartialRollout(input) {
      assertLease(input);
      calls.push({ method: 'markPartialRollout', input });
      const record = records.get(input.rolloutId);
      record.state = 'partial';
      record.acknowledgedReplicaIds = [...input.acknowledgedReplicaIds];
      record.failedReplicaIds = [...input.failedReplicaIds];
      leases.delete(input.rolloutId);
    },
    async completeRollout(input) {
      assertLease(input);
      calls.push({ method: 'completeRollout', input });
      const record = records.get(input.rolloutId);
      if (JSON.stringify(record.acknowledgedReplicaIds) !== JSON.stringify([...input.replicaIds])) {
        throw new Error('not all replicas acknowledged');
      }
      record.state = 'completed';
      completedVersion = input.targetVersion;
      leases.delete(input.rolloutId);
    },
  };
}

function createOperatorAuthenticator() {
  const calls = [];
  return {
    calls,
    async authorize(_context, options) {
      calls.push({ method: 'authorize', options });
      return { actorId: 'security-operator', mfaVerified: true };
    },
    async createReplicaAssertion(identity, claims) {
      calls.push({ method: 'createReplicaAssertion', actorId: identity.actorId, claims });
      return 'signed-short-lived-replica-assertion-' + claims.replicaId;
    },
  };
}

function createReplicas(ids, initialVersion = '1', { failOnce = [] } = {}) {
  const state = new Map(ids.map(id => [id, {
    secretVersion: initialVersion,
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: auditKeyId, keyIds: [auditKeyId] },
  }]));
  const attempts = new Map();
  const calls = [];
  const replicas = ids.map(id => ({
    id,
    async reloadTokens(assertion, options) {
      calls.push({ method: 'reloadTokens', id, assertion, options });
      assert.match(assertion, /signed-short-lived-replica-assertion-/);
      assert.equal(options.expectedVersion, '2');
      assert.equal(options.replicaId, id);
      const count = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, count);
      if (failOnce.includes(id) && count === 1) {
        throw Object.assign(new Error('internal transport detail must not be persisted'), {
          code: 'REPLICA_UNAVAILABLE',
        });
      }
      state.set(id, {
        secretVersion: options.expectedVersion,
        tokenIds: ['service-a-current'],
        auditKeyRing: { activeKeyId: auditKeyId, keyIds: [auditKeyId] },
      });
    },
    async status() {
      calls.push({ method: 'status', id });
      return structuredClone(state.get(id));
    },
  }));
  return { replicas, state, attempts, calls };
}

test('rolls the same pinned credential version to every replica and records secret-free acknowledgements', async () => {
  const store = createStore();
  const operator = createOperatorAuthenticator();
  const { replicas, calls: replicaCalls } = createReplicas(['api-a', 'api-b', 'api-c']);
  const reads = [];
  const result = await runCloudCredentialRollout({
    secretManager: {
      async readCloudSecrets(options) {
        reads.push(options);
        return snapshot();
      },
    },
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas },
    rolloutStore: store,
    context: { session: 'mfa-verified' },
    concurrency: 2,
  });

  assert.equal(result.state, 'completed');
  assert.equal(result.targetVersion, '2');
  assert.deepEqual(result.acknowledgedReplicaIds, ['api-a', 'api-b', 'api-c']);
  assert.deepEqual(result.failedReplicaIds, []);
  assert.deepEqual(reads, [undefined]);
  assert.equal(operator.calls.filter(call => call.method === 'createReplicaAssertion').length, 3);
  assert.ok(replicaCalls.filter(call => call.method === 'reloadTokens')
    .every(call => call.options.expectedVersion === '2'));
  assert.equal(store.calls.filter(call => call.method === 'completeRollout').length, 1);

  const persisted = JSON.stringify([...store.records.values()]);
  assert.equal(persisted.includes(tokenA), false);
  assert.equal(persisted.includes(tokenB), false);
  assert.equal(persisted.includes(auditKey), false);
  assert.equal(persisted.includes('signed-short-lived-replica-assertion'), false);
});

test('partial rollout is resumable against the same immutable secret version without reloading acknowledged replicas', async () => {
  const store = createStore();
  const operator = createOperatorAuthenticator();
  const { replicas, attempts } = createReplicas(['api-a', 'api-b'], '1', { failOnce: ['api-b'] });
  const reads = [];
  const secretManager = {
    async readCloudSecrets(options) {
      reads.push(options);
      return snapshot('2');
    },
  };
  const first = await runCloudCredentialRollout({
    secretManager,
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas },
    rolloutStore: store,
    context: { session: 'mfa-verified' },
  });

  assert.equal(first.state, 'partial');
  assert.deepEqual(first.acknowledgedReplicaIds, ['api-a']);
  assert.deepEqual(first.failedReplicaIds, ['api-b']);
  const rolloutId = first.rolloutId;
  assert.equal(attempts.get('api-a'), 1);
  assert.equal(attempts.get('api-b'), 1);

  const second = await runCloudCredentialRollout({
    secretManager,
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas },
    rolloutStore: store,
    context: { session: 'mfa-verified-again' },
    rolloutId,
  });

  assert.equal(second.state, 'completed');
  assert.deepEqual(second.acknowledgedReplicaIds, ['api-a', 'api-b']);
  assert.equal(attempts.get('api-a'), 1, 'already-acknowledged replica is checked, not reloaded');
  assert.equal(attempts.get('api-b'), 2, 'only the failed replica is retried');
  assert.equal(store.calls.filter(call => call.method === 'resumeRollout').length, 1);
  assert.deepEqual(reads, [undefined, { version: '2' }]);
});

test('resume refuses a provider that returns changed material for the pinned version', async () => {
  const store = createStore();
  const operator = createOperatorAuthenticator();
  const { replicas } = createReplicas(['api-a', 'api-b'], '1', { failOnce: ['api-b'] });
  const secretManager = {
    async readCloudSecrets(options) {
      return options?.version ? snapshot('2', tokenA) : snapshot('2', tokenB);
    },
  };
  const first = await runCloudCredentialRollout({
    secretManager, operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas }, rolloutStore: store,
    context: {},
  });
  assert.equal(first.state, 'partial');
  await assert.rejects(runCloudCredentialRollout({
    secretManager, operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas }, rolloutStore: store,
    context: {}, rolloutId: first.rolloutId,
  }), /Pinned secret revision no longer matches/);
});

test('rollout requires MFA and a signed per-replica assertion before any replica is changed', async () => {
  const store = createStore();
  let listed = false;
  const operator = {
    async authorize() { return { actorId: 'operator-1', mfaVerified: false }; },
    async createReplicaAssertion() { throw new Error('must not be called'); },
  };
  await assert.rejects(runCloudCredentialRollout({
    secretManager: { readCloudSecrets: async () => snapshot() },
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => { listed = true; return []; } },
    rolloutStore: store,
    context: {},
  }), /MFA-verified operator/);
  assert.equal(listed, false);
  assert.equal(store.records.size, 0);
});

test('rollout rejects replica inventory changes during resume', async () => {
  const store = createStore();
  const operator = createOperatorAuthenticator();
  const { replicas } = createReplicas(['api-a', 'api-b'], '1', { failOnce: ['api-b'] });
  const first = await runCloudCredentialRollout({
    secretManager: { readCloudSecrets: async () => snapshot() },
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas },
    rolloutStore: store,
    context: {},
  });
  assert.equal(first.state, 'partial');
  await assert.rejects(runCloudCredentialRollout({
    secretManager: { readCloudSecrets: async () => snapshot('2') },
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => [...replicas, {
      id: 'api-c', reloadTokens: async () => {}, status: async () => ({}),
    }] },
    rolloutStore: store,
    context: {},
    rolloutId: first.rolloutId,
  }), /Replica inventory changed/);
});

test('rollout fails closed when a replica reports a different version after reload', async () => {
  const store = createStore();
  const operator = createOperatorAuthenticator();
  const { replicas } = createReplicas(['api-a']);
  replicas[0].reloadTokens = async () => {};
  replicas[0].status = async () => ({
    secretVersion: '1',
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: auditKeyId, keyIds: [auditKeyId] },
  });
  const result = await runCloudCredentialRollout({
    secretManager: { readCloudSecrets: async () => snapshot() },
    operatorAuthenticator: operator,
    replicaDirectory: { list: async () => replicas },
    rolloutStore: store,
    context: {},
  });
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.failedReplicaIds, ['api-a']);
  assert.equal(store.calls.find(call => call.method === 'recordReplicaFailure')
    .input.errorCode, 'REPLICA_VERSION_MISMATCH');
});

test('replica bootstrap reload pins the requested immutable provider version', async () => {
  const reads = [];
  let current = snapshot('1', tokenA);
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: {
      async readCloudSecrets(options) {
        reads.push(options);
        return current;
      },
    },
    operatorAuthenticator: {
      async authorize(_context, constraints) {
        assert.equal(constraints.action, 'cloud.credentials.reload');
        assert.equal(constraints.expectedVersion, '2');
        assert.equal(constraints.rolloutId, 'rollout_12345678');
        assert.equal(constraints.replicaId, 'api-a');
        return { actorId: 'security-operator', mfaVerified: true };
      },
    },
    createStudioServerImpl(options) {
      let tokens = options.cloudTokens.map(({ token, ...safe }) => safe);
      return {
        server: {},
        tokenAdmin: {
          list: () => tokens,
          replace(next) {
            tokens = next.map(({ token, ...safe }) => safe);
            return tokens;
          },
        },
        auditAdmin: {
          keyMetadata: () => ({ activeKeyId: auditKeyId, keyIds: [auditKeyId] }),
        },
      };
    },
  });

  current = snapshot('2', tokenB);
  const result = await bootstrap.reloadTokens('signed-operator-assertion', {
    expectedVersion: '2',
    rolloutId: 'rollout_12345678',
    replicaId: 'api-a',
  });
  assert.equal(result.secretVersion, '2');
  assert.deepEqual(reads, [undefined, { version: '2' }]);
});

test('replica bootstrap rejects a secret provider that ignores the pinned version', async () => {
  let current = snapshot('1', tokenA);
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      async authorize() { return { actorId: 'security-operator', mfaVerified: true }; },
    },
    createStudioServerImpl(options) {
      let tokens = options.cloudTokens.map(({ token, ...safe }) => safe);
      return {
        server: {},
        tokenAdmin: {
          list: () => tokens,
          replace(next) { tokens = next.map(({ token, ...safe }) => safe); return tokens; },
        },
        auditAdmin: {
          keyMetadata: () => ({ activeKeyId: auditKeyId, keyIds: [auditKeyId] }),
        },
      };
    },
  });
  current = snapshot('3', tokenB);
  await assert.rejects(bootstrap.reloadTokens('signed-assertion', {
    expectedVersion: '2',
    rolloutId: 'rollout_12345678',
  }), /did not return the pinned credential revision/);
  assert.equal(bootstrap.status().secretVersion, '1');
});
