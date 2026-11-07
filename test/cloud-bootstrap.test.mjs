import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCloudStudioFromSecretManager } from '../src/cloud-bootstrap.mjs';

const tokenA = 'bootstrap-tenant-a-token-0123456789abcdef';
const tokenB = 'bootstrap-tenant-a-token-rotated-0123456789';
const auditKey = 'bootstrap-audit-signing-key-material-0123456789';
const auditKeyId = createHash('sha256').update(auditKey).digest('hex').slice(0, 16);

function snapshot(version, token = tokenA, ring = {
  activeKeyId: auditKeyId,
  keys: { [auditKeyId]: auditKey },
}) {
  return {
    version,
    tokens: [{
      tokenId: 'service-a-current',
      principalId: 'service-a',
      token,
      tenantId: 'tenant-a',
      projectIds: ['project-a'],
    }],
    auditKeyRing: ring,
  };
}

function fakeFactory(calls = []) {
  return options => {
    calls.push(options);
    let activeTokens = options.cloudTokens.map(({ token, ...safe }) => safe);
    const auditEvents = [];
    return {
      server: { close() {} },
      tokenAdmin: {
        list: () => activeTokens.map(token => ({ ...token, projectIds: [...token.projectIds] })),
        replace: (tokens, { actorId } = {}) => {
          auditEvents.push({ action: 'auth.tokens_replaced', actorId });
          activeTokens = tokens.map(({ token, ...safe }) => safe);
          return activeTokens.map(token => ({ ...token, projectIds: [...token.projectIds] }));
        },
      },
      auditAdmin: {
        keyMetadata: () => ({
          activeKeyId: options.cloudAuditKeyRing.activeKeyId,
          keyIds: Object.keys(options.cloudAuditKeyRing.keys).sort(),
        }),
      },
      auditEvents,
    };
  };
}

test('Cloud bootstrap reads versioned secrets and forces cloud credentials into server configuration', async () => {
  const calls = [];
  const secrets = snapshot('1');
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => secrets },
    serverOptions: {
      cloudMode: false,
      cloudTokens: [{ token: 'must-not-win-override' }],
      cloudAuditKey: 'must-not-win-override',
      cloudAllowedHosts: ['api.example.test'],
      cloudTrustedProxy: true,
      cloudWorker: async () => ({}),
    },
    createStudioServerImpl: fakeFactory(calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cloudMode, true);
  assert.deepEqual(calls[0].cloudTokens, secrets.tokens);
  assert.equal(calls[0].cloudAuditKey, null);
  assert.deepEqual(calls[0].cloudAuditKeyRing, secrets.auditKeyRing);
  assert.deepEqual(bootstrap.status(), {
    secretVersion: '1',
    tokenCount: 1,
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: auditKeyId, keyIds: [auditKeyId] },
  });
  const visible = JSON.stringify(bootstrap.status());
  assert.equal(visible.includes(tokenA), false);
  assert.equal(visible.includes(auditKey), false);
});

test('Token reload requires MFA-verified operator and audits replacement before reporting success', async () => {
  let current = snapshot('1');
  const auditEvents = [];
  const studioFactory = options => {
    let tokens = options.cloudTokens.map(({ token, ...safe }) => safe);
    return {
      server: { close() {} },
      tokenAdmin: {
        list: () => tokens,
        replace: (next, { actorId } = {}) => {
          auditEvents.push({ action: 'auth.tokens_replaced', actorId });
          tokens = next.map(({ token, ...safe }) => safe);
          return tokens;
        },
      },
      auditAdmin: { keyMetadata: () => ({
        activeKeyId: auditKeyId, keyIds: [auditKeyId],
      }) },
    };
  };
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async (_context, { action }) => {
        assert.equal(action, 'cloud.credentials.reload');
        return { actorId: 'security-operator', mfaVerified: true };
      },
    },
    createStudioServerImpl: studioFactory,
  });

  current = snapshot('2', tokenB);
  const result = await bootstrap.reloadTokens({ sessionId: 'trusted-session' });
  assert.equal(result.secretVersion, '2');
  assert.deepEqual(result.tokenIds, ['service-a-current']);
  assert.deepEqual(auditEvents, [{
    action: 'auth.tokens_replaced', actorId: 'security-operator',
  }]);
  assert.equal(JSON.stringify(result).includes(tokenB), false);
});

test('Token reload rejects missing MFA and does not read or mutate credentials', async () => {
  let reads = 0;
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => { reads++; return snapshot('1'); } },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: false }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  await assert.rejects(bootstrap.reloadTokens({}), /MFA-verified operator/);
  assert.equal(reads, 1, 'Unauthorized reload must not fetch the secret snapshot');
  assert.equal(bootstrap.status().secretVersion, '1');
});

test('Token reload rejects changed credentials without a new secret version', async () => {
  let current = snapshot('1');
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: true }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  current = snapshot('1', tokenB);
  await assert.rejects(bootstrap.reloadTokens({}), /without advancing the snapshot version/);
  assert.equal(bootstrap.status().secretVersion, '1');
  assert.deepEqual(bootstrap.status().tokenIds, ['service-a-current']);
});

test('Token reload rejects rollback to an older provider revision', async () => {
  let current = snapshot('1');
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: true }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  current = snapshot('3', tokenB);
  await bootstrap.reloadTokens({});
  current = snapshot('2', tokenA);
  await assert.rejects(bootstrap.reloadTokens({}), /older snapshot revision/);
  assert.equal(bootstrap.status().secretVersion, '3');
});

test('Concurrent token reloads are serialized to prevent stale snapshots overwriting newer credentials', async () => {
  let reads = 0;
  let resolveNext;
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: {
      readCloudSecrets: async () => {
        reads++;
        if (reads === 1) return snapshot('1');
        return new Promise(resolve => { resolveNext = resolve; });
      },
    },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: true }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  const first = bootstrap.reloadTokens({});
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(bootstrap.reloadTokens({}), /already in progress/);
  resolveNext(snapshot('2', tokenB));
  const result = await first;
  assert.equal(result.secretVersion, '2');
  assert.equal(reads, 2);
});

test('Token reload refuses to change audit keys outside the staged rotation workflow', async () => {
  const nextKey = 'bootstrap-next-audit-signing-key-material-0123456789';
  const nextId = createHash('sha256').update(nextKey).digest('hex').slice(0, 16);
  let current = snapshot('1');
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: true }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  current = snapshot('2', tokenB, {
    activeKeyId: auditKeyId,
    keys: { [auditKeyId]: auditKey, [nextId]: nextKey },
  });
  await assert.rejects(bootstrap.reloadTokens({}), /separate staged key-rotation workflow/);
  assert.equal(bootstrap.status().secretVersion, '1');
});

test('Cloud bootstrap integrates with the real Studio factory and records MFA token reload', async t => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'url-tutorial-cloud-bootstrap-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  let current = snapshot('1');
  const cloud = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'security-operator', mfaVerified: true }),
    },
    serverOptions: {
      outputRoot,
      cloudAllowedHosts: ['api.example.test'],
      cloudTrustedProxy: true,
      cloudWorker: async () => ({ status: 'not-used-by-bootstrap-test' }),
    },
  });
  try {
    assert.equal(cloud.status().tokenCount, 1);
    current = snapshot('2', tokenB);
    const status = await cloud.reloadTokens({ session: 'mfa-verified' });
    assert.equal(status.secretVersion, '2');
    const audit = cloud.studio.store.cloudAuditEvents('tenant-a');
    assert.ok(audit.some(event =>
      event.action === 'auth.tokens_replaced' && event.principalId === 'security-operator'));
    assert.equal(JSON.stringify(audit).includes(tokenB), false);
  } finally {
    cloud.studio.store.close();
  }
});

test('Cloud bootstrap fails closed when the secret manager is missing or returns invalid data', async () => {
  await assert.rejects(createCloudStudioFromSecretManager({}), /readCloudSecrets/);
  let factoryCalls = 0;
  await assert.rejects(createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => ({ version: '1', tokens: [] }) },
    createStudioServerImpl: () => { factoryCalls++; },
  }), /at least one cloud token/);
  assert.equal(factoryCalls, 0);
});
