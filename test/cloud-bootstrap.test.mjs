import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStudioServer } from '../src/studio-server.mjs';
import { DatabaseSync } from 'node:sqlite';
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
        archiveBatch: async ({ limit = 500 } = {}) => ({ archived: 0, limit }),
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
      cloudAuditKeyRing: { activeKeyId: '0000000000000000', keys: {} },
      cloudAllowedHosts: ['api.example.test'],
      cloudTrustedProxy: true,
      cloudWorker: async () => ({}),
    },
    createStudioServerImpl: fakeFactory(calls),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(bootstrap).sort(), ['archiveAuditBatch', 'reloadTokens', 'server', 'status']);
  assert.equal(Object.hasOwn(bootstrap, 'studio'), false);
  assert.equal(Object.hasOwn(bootstrap, 'tokenAdmin'), false);
  assert.equal(Object.hasOwn(bootstrap, 'auditAdmin'), false);
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
  assert.equal(visible.includes(createHash('sha256').update(tokenA).digest('hex')), false);
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

test('Cloud bootstrap integrates with the real Studio factory without exposing admin capabilities', async t => {
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

    // The wrapper must not expose the raw Studio object, tokenAdmin, auditAdmin
    // or the SQLite store. Verify the audit trail through the persisted database.
    assert.equal(Object.hasOwn(cloud, 'studio'), false);
    assert.equal(Object.hasOwn(cloud, 'tokenAdmin'), false);
    assert.equal(Object.hasOwn(cloud, 'auditAdmin'), false);
    await new Promise(resolve => cloud.server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve, reject) => cloud.server.close(error => error ? reject(error) : resolve()));
    await new Promise(resolve => setImmediate(resolve));

    const db = new DatabaseSync(path.join(outputRoot, 'studio-jobs.sqlite'));
    try {
      const audit = db.prepare(
        'SELECT action, principal_id AS principalId FROM cloud_audit_events WHERE tenant_id=? ORDER BY sequence',
      ).all('tenant-a');
      assert.ok(audit.some(event =>
        event.action === 'auth.tokens_replaced' && event.principalId === 'security-operator'));
      assert.equal(JSON.stringify(audit).includes(tokenB), false);
    } finally {
      db.close();
    }
  } finally {
    if (cloud.server.listening) {
      await new Promise(resolve => cloud.server.close(resolve));
    }
  }
});

test('Cloud bootstrap exposes only the narrow audit archive capability for host scheduling', async () => {
  const calls = [];
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => snapshot('1') },
    createStudioServerImpl: options => {
      const studio = fakeFactory(calls)(options);
      studio.auditAdmin.archiveBatch = async ({ limit = 500 } = {}) => {
        calls.push({ archiveLimit: limit });
        return { archived: 1, lastArchivedSequence: 1 };
      };
      return studio;
    },
  });
  assert.equal(Object.hasOwn(bootstrap, 'auditAdmin'), false);
  assert.equal(Object.hasOwn(bootstrap, 'tokenAdmin'), false);
  assert.deepEqual(await bootstrap.archiveAuditBatch({ limit: 25 }), {
    archived: 1, lastArchivedSequence: 1,
  });
  assert.deepEqual(calls.at(-1), { archiveLimit: 25 });
});

test('Cloud bootstrap exposes only the narrow audit archive capability for host scheduling', async () => {
  const calls = [];
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => snapshot('1') },
    createStudioServerImpl: options => {
      const studio = fakeFactory(calls)(options);
      studio.auditAdmin.archiveBatch = async ({ limit = 500 } = {}) => {
        calls.push({ archiveLimit: limit });
        return { archived: 1, lastArchivedSequence: 1 };
      };
      return studio;
    },
  });
  assert.equal(Object.hasOwn(bootstrap, 'auditAdmin'), false);
  assert.equal(Object.hasOwn(bootstrap, 'tokenAdmin'), false);
  assert.deepEqual(await bootstrap.archiveAuditBatch({ limit: 25 }), {
    archived: 1, lastArchivedSequence: 1,
  });
  assert.deepEqual(calls.at(-1), { archiveLimit: 25 });
});

test('Cloud bootstrap rejects an audit key whose fingerprint does not match its key ID', async () => {
  const invalid = snapshot('1', tokenA, {
    activeKeyId: '0000000000000000',
    keys: { '0000000000000000': auditKey },
  });
  let factoryCalls = 0;
  await assert.rejects(createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => invalid },
    createStudioServerImpl: () => { factoryCalls++; },
  }), /fingerprint does not match/);
  assert.equal(factoryCalls, 0);
});

test('Token reload leaves the active registry unchanged when its audit append fails', async t => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'url-tutorial-cloud-bootstrap-audit-failure-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  let current = snapshot('1');
  let rawStudio;
  const cloud = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => current },
    operatorAuthenticator: {
      authorize: async () => ({ actorId: 'security-operator', mfaVerified: true }),
    },
    serverOptions: {
      outputRoot,
      cloudAllowedHosts: ['api.example.test'],
      cloudTrustedProxy: true,
      cloudWorker: async () => ({}),
    },
    createStudioServerImpl(options) {
      rawStudio = createStudioServer(options);
      const recordCloudAudits = rawStudio.store.recordCloudAudits.bind(rawStudio.store);
      rawStudio.store.recordCloudAudits = events => {
        if (events.some(event => event.action === 'auth.tokens_replaced')) {
          throw new Error('audit storage unavailable');
        }
        return recordCloudAudits(events);
      };
      return rawStudio;
    },
  });
  try {
    current = snapshot('2', tokenB);
    current.tokens[0].tokenId = 'service-a-next';
    await assert.rejects(cloud.reloadTokens({}), /audit storage unavailable/);
    assert.equal(cloud.status().secretVersion, '1');
    assert.deepEqual(rawStudio.tokenAdmin.list().map(token => token.tokenId), ['service-a-current']);
  } finally {
    rawStudio.store.close();
  }
});

test('Cloud bootstrap redacts secret-manager and operator-authenticator failures', async () => {
  await assert.rejects(createCloudStudioFromSecretManager({
    secretManager: {
      readCloudSecrets: async () => { throw new Error('provider leaked ' + tokenA); },
    },
    createStudioServerImpl: fakeFactory(),
  }), error => error.message === 'Cloud secret manager read failed' &&
    !error.message.includes(tokenA));

  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => snapshot('1') },
    operatorAuthenticator: {
      authorize: async () => { throw new Error('operator adapter leaked ' + tokenA); },
    },
    createStudioServerImpl: fakeFactory(),
  });
  await assert.rejects(bootstrap.reloadTokens({}), error =>
    error.message === 'Cloud secret reload operator authorization failed' &&
    !error.message.includes(tokenA));
  assert.equal(bootstrap.status().secretVersion, '1');
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

test('Cloud bootstrap reconciles Docker networks after persisted jobs are recovered and before returning', async () => {
  const activeId = '22222222-2222-4222-8222-222222222222';
  const interruptedId = '33333333-3333-4333-8333-333333333333';
  const recoveredIds = [];
  const worker = async () => ({ status: 'unused' });
  worker.reconcileOrphanedNetworks = async ({ activeJobIds }) => {
    recoveredIds.push(...activeJobIds);
    return { scanned: 2, removed: [], skipped: [], failed: [] };
  };
  const studio = {
    server: { close() {} },
    jobs: new Map([
      [activeId, { id: activeId, status: 'running' }],
      [interruptedId, { id: interruptedId, status: 'interrupted' }],
    ]),
    tokenAdmin: { list: () => [{ tokenId: 'service-a-current' }] },
    auditAdmin: { keyMetadata: () => ({ activeKeyId: auditKeyId, keyIds: [auditKeyId] }) },
  };
  await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => snapshot('1') },
    serverOptions: {
      cloudAllowedHosts: ['api.example.test'],
      cloudTrustedProxy: true,
      cloudWorker: worker,
    },
    createStudioServerImpl: () => studio,
  });

  assert.deepEqual(recoveredIds, [activeId]);
});

test('Cloud bootstrap fails closed when Docker network reconciliation reports a failed network', async () => {
  let closed = false;
  const worker = async () => ({ status: 'unused' });
  worker.reconcileOrphanedNetworks = async () => ({
    scanned: 1, removed: [], skipped: [], failed: [
      { network: 'utv-job-11111111-1111-4111-8111-111111111111', reason: 'docker-reconciliation-failed' },
    ],
  });
  const studio = {
    server: { close() {} },
    jobs: new Map(),
    store: { close() { closed = true; } },
    tokenAdmin: { list: () => [{ tokenId: 'service-a-current' }] },
    auditAdmin: { keyMetadata: () => ({ activeKeyId: auditKeyId, keyIds: [auditKeyId] }) },
  };
  await assert.rejects(createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => snapshot('1') },
    serverOptions: {
      cloudAllowedHosts: ['api.example.test'],
      cloudTrustedProxy: true,
      cloudWorker: worker,
    },
    createStudioServerImpl: () => studio,
  }), /Cloud Docker network recovery failed/);
  assert.equal(closed, true);
});
