import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const secrets = snapshot('secret-version-1');
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
    secretVersion: 'secret-version-1',
    tokenCount: 1,
    tokenIds: ['service-a-current'],
    auditKeyRing: { activeKeyId: auditKeyId, keyIds: [auditKeyId] },
  });
  const visible = JSON.stringify(bootstrap.status());
  assert.equal(visible.includes(tokenA), false);
  assert.equal(visible.includes(auditKey), false);
});

test('Token reload requires MFA-verified operator and audits replacement before reporting success', async () => {
  let current = snapshot('secret-version-1');
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

  current = snapshot('secret-version-2', tokenB);
  const result = await bootstrap.reloadTokens({ sessionId: 'trusted-session' });
  assert.equal(result.secretVersion, 'secret-version-2');
  assert.deepEqual(result.tokenIds, ['service-a-current']);
  assert.deepEqual(auditEvents, [{
    action: 'auth.tokens_replaced', actorId: 'security-operator',
  }]);
  assert.equal(JSON.stringify(result).includes(tokenB), false);
});

test('Token reload rejects missing MFA and does not read or mutate credentials', async () => {
  let reads = 0;
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => { reads++; return snapshot('v1'); } },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: false }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  await assert.rejects(bootstrap.reloadTokens({}), /MFA-verified operator/);
  assert.equal(reads, 1, 'Unauthorized reload must not fetch the secret snapshot');
  assert.equal(bootstrap.status().secretVersion, 'v1');
});

test('Token reload rejects changed credentials without a new secret version', async () => {
  let current = snapshot('same-version');
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: true }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  current = snapshot('same-version', tokenB);
  await assert.rejects(bootstrap.reloadTokens({}), /without advancing the snapshot version/);
  assert.equal(bootstrap.status().secretVersion, 'same-version');
  assert.deepEqual(bootstrap.status().tokenIds, ['service-a-current']);
});

test('Token reload refuses to change audit keys outside the staged rotation workflow', async () => {
  const nextKey = 'bootstrap-next-audit-signing-key-material-0123456789';
  const nextId = createHash('sha256').update(nextKey).digest('hex').slice(0, 16);
  let current = snapshot('v1');
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'operator-1', mfaVerified: true }),
    },
    createStudioServerImpl: fakeFactory(),
  });
  current = snapshot('v2', tokenB, {
    activeKeyId: auditKeyId,
    keys: { [auditKeyId]: auditKey, [nextId]: nextKey },
  });
  await assert.rejects(bootstrap.reloadTokens({}), /separate staged key-rotation workflow/);
  assert.equal(bootstrap.status().secretVersion, 'v1');
});

test('Cloud bootstrap fails closed when the secret manager is missing or returns invalid data', async () => {
  await assert.rejects(createCloudStudioFromSecretManager({}), /readCloudSecrets/);
  let factoryCalls = 0;
  await assert.rejects(createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => ({ version: 'v1', tokens: [] }) },
    createStudioServerImpl: () => { factoryCalls++; },
  }), /at least one cloud token/);
  assert.equal(factoryCalls, 0);
});
