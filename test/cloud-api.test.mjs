import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudAuth } from '../src/cloud-auth.mjs';
import { StudioJobStore } from '../src/job-store.mjs';
import { createStudioServer } from '../src/studio-server.mjs';

const tokenA = 'tenant-a-secret-token-0123456789abcdef';
const tokenB = 'tenant-b-secret-token-0123456789abcdef';
const tokens = [
  { id: 'service-a', token: tokenA, tenantId: 'tenant-a', projectIds: ['project-a', 'project-a2'] },
  { id: 'service-b', token: tokenB, tenantId: 'tenant-b', projectIds: ['project-b'] },
];

const temp = () => mkdtemp(path.join(tmpdir(), 'tutorial-cloud-api-'));

function call(origin, route, {
  method = 'GET', token, projectId, body, host = 'api.example.test', originHeader,
} = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const headers = { Host: host, 'X-Forwarded-Proto': 'https' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (projectId) headers['X-Project-ID'] = projectId;
    if (originHeader) headers.Origin = originHeader;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({
      hostname: target.hostname, port: target.port, path: route, method, headers,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

async function waitForJob(origin, id, token, projectId) {
  for (let i = 0; i < 100; i++) {
    const response = await call(origin, '/api/jobs/' + id, { token, projectId });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(response.data?.status)) return response;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for cloud job ' + id);
}

const result = {
  plan: { schemaVersion: 1, title: 'Cloud fixture', url: 'https://example.com',
    language: 'en', steps: [] },
  plans: [],
  report: { status: 'completed', pages: [] },
};

function serverOptions(outputRoot, overrides = {}) {
  return {
    outputRoot, cloudMode: true, cloudTokens: tokens,
    cloudAllowedHosts: ['api.example.test'], cloudTrustedProxy: true,
    cloudAuditKey: 'test-only-cloud-audit-signing-key-0123456789abcdef',
    cloudPreflight: async value => {
      const target = new URL(value);
      if (target.protocol !== 'https:' || ['localhost', '127.0.0.1',
        'metadata.google.internal'].includes(target.hostname) || target.hostname.endsWith('.local')) {
        throw new Error('Private or non-HTTPS destination is prohibited');
      }
      return target.href;
    },
    cloudWorker: async () => result,
    ...overrides,
  };
}

test('Cloud auth requires strong configured tokens and explicit tenant project ACLs', () => {
  assert.throws(() => createCloudAuth({ tokens: [] }), /at least one/);
  assert.throws(() => createCloudAuth({ tokens: [{ token: 12345678901234567890123456789012,
    tenantId: 'tenant-a', projectIds: ['project-a'] }] }), /32\+ character token/);
  assert.throws(() => createCloudAuth({ tokens: [{ token: tokenA,
    tenantId: 'tenant-a', projectIds: ['project-a', 'project-a'] }] }), /unique projectIds/);
  assert.throws(() => createCloudAuth({ tokens: [{ token: tokenA,
    tenantId: 'tenant-a', projectIds: ['project-a'] }] , limits: { maxJobsPerDay: 0 } }), /positive safe integer/);
});

test('Cloud API authenticates every tenant route and enforces project-scoped job access', async t => {
  assert.throws(() => createStudioServer({ cloudMode: true, cloudTokens: tokens,
    cloudAllowedHosts: ['api.example.test'], cloudWorker: async () => result }),
  /trusted TLS-terminating reverse proxy/);
  assert.throws(() => createStudioServer({ cloudMode: true, cloudTokens: tokens,
    cloudAllowedHosts: ['api.example.test'], cloudTrustedProxy: true,
    cloudWorker: async () => result }),
  /audit signing key/);
  assert.throws(() => createStudioServer({ cloudMode: true, cloudTokens: tokens,
    cloudAllowedHosts: ['api.example.test'], cloudTrustedProxy: true }),
  /isolated-worker adapter/);
  const root = await temp();
  const studio = createStudioServer(serverOptions(root));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await call(origin, '/api/health')).status, 200);
  assert.equal((await call(origin, '/api/health')).data.scope, 'cloud-api-control-plane');
  assert.equal((await call(origin, '/')).status, 401, 'Cloud API mode must not expose the local Studio UI');
  assert.equal((await call(origin, '/api/jobs')).status, 401);
  assert.equal((await call(origin, '/api/jobs', { token: 'invalid-token-which-is-long-enough-1234',
    projectId: 'project-a' })).status, 401);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-b' })).status, 403);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a',
    host: 'attacker.example.test' })).status, 403);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a',
    originHeader: 'http://api.example.test' })).status, 403);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a',
    originHeader: 'https://attacker.example.test' })).status, 403);

  const created = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1,
      tenantId: 'tenant-b', projectId: 'project-b' },
  });
  assert.equal(created.status, 202);
  const id = created.data.jobId;
  const completed = await waitForJob(origin, id, tokenA, 'project-a');
  assert.equal(completed.status, 200);
  assert.equal(completed.data.status, 'completed');

  const stored = studio.store.all().find(job => job.id === id);
  assert.equal(stored.tenantId, 'tenant-a', 'Tenant identity must come from the verified bearer token');
  assert.equal(stored.projectId, 'project-a', 'Project identity must come from the authorized header');

  const tenantHistory = await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a' });
  assert.deepEqual(tenantHistory.data.jobs.map(job => job.id), [id]);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a2' })).data.jobs.length, 0);
  assert.equal((await call(origin, '/api/jobs/' + id, { token: tokenA, projectId: 'project-a2' })).status, 404);
  assert.equal((await call(origin, '/api/jobs/' + id, { token: tokenB, projectId: 'project-b' })).status, 404);
  assert.equal((await call(origin, '/api/jobs/' + id + '/cancel', {
    method: 'POST', token: tokenB, projectId: 'project-b',
  })).status, 404);
});

test('Cloud API applies tenant-wide concurrent and rolling daily job quotas', async t => {
  const root = await temp();
  let releaseFirst;
  let signalFirst;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  let calls = 0;
  const studio = createStudioServer(serverOptions(root, {
    cloudLimits: { maxConcurrentJobsPerTenant: 1, maxJobsPerDay: 1, maxRequestsPerMinute: 30 },
    cloudWorker: async () => {
      calls++;
      if (calls === 1) {
        signalFirst();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
      return result;
    },
  }));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const first = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(first.status, 202);
  await firstStarted;

  const concurrent = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a2',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(concurrent.status, 429);
  assert.match(concurrent.data.error, /concurrent-job quota/);

  const otherTenant = await call(origin, '/api/discover', {
    method: 'POST', token: tokenB, projectId: 'project-b',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(otherTenant.status, 202, 'One tenant must not consume another tenant\'s quota');

  releaseFirst();
  assert.equal((await waitForJob(origin, first.data.jobId, tokenA, 'project-a')).data.status, 'completed');
  assert.equal((await waitForJob(origin, otherTenant.data.jobId, tokenB, 'project-b')).data.status, 'completed');

  const daily = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a2',
    body: { url: 'https://example.org', language: 'en', maxPages: 1 },
  });
  assert.equal(daily.status, 429);
  assert.match(daily.data.error, /daily-job quota/);
  assert.equal(calls, 2);
});

test('Cloud API rate-limits per tenant and emits Retry-After', async t => {
  const root = await temp();
  const studio = createStudioServer(serverOptions(root, {
    cloudLimits: { maxRequestsPerMinute: 2 },
  }));
  const origin = await listen(studio.server);
  let activeServer = studio.server;
  t.after(async () => {
    if (activeServer.listening) await new Promise(resolve => activeServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a' })).status, 200);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a2' })).status, 200);
  const limited = await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1 &&
    Number(limited.headers['retry-after']) <= 60);
  assert.equal((await call(origin, '/api/jobs', { token: tokenB, projectId: 'project-b' })).status, 200);
  await new Promise(resolve => studio.server.close(resolve));

  const restarted = createStudioServer(serverOptions(root, {
    cloudLimits: { maxRequestsPerMinute: 2 },
  }));
  const restartedOrigin = await listen(restarted.server);
  activeServer = restarted.server;
  const stillLimited = await call(restartedOrigin, '/api/jobs', {
    token: tokenA, projectId: 'project-a',
  });
  assert.equal(stillLimited.status, 429, 'Tenant request quota must survive API restart');
  assert.equal((await call(restartedOrigin, '/api/jobs', {
    token: tokenB, projectId: 'project-b',
  })).status, 200, 'Persisted request events remain tenant-isolated');
});


test('Daily tenant quota survives Studio restart in SQLite', async t => {
  const root = await temp();
  let first = createStudioServer(serverOptions(root, {
    cloudLimits: { maxJobsPerDay: 1 },
  }));
  let origin = await listen(first.server);
  const firstJob = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(firstJob.status, 202);
  assert.equal((await waitForJob(origin, firstJob.data.jobId, tokenA, 'project-a')).data.status, 'completed');
  const audit = first.store.cloudAuditEvents('tenant-a');
  assert.deepEqual(audit.map(event => event.action).sort(), ['job.completed', 'job.submitted']);
  assert.ok(audit.every(event => event.projectId === 'project-a'));
  assert.ok(audit.every(event => !JSON.stringify(event).includes(tokenA)));
  await new Promise(resolve => first.server.close(resolve));

  const second = createStudioServer(serverOptions(root, {
    cloudLimits: { maxJobsPerDay: 1 },
  }));
  origin = await listen(second.server);
  t.after(async () => {
    await new Promise(resolve => second.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const blocked = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a2',
    body: { url: 'https://example.org', language: 'en', maxPages: 1 },
  });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /daily-job quota/);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(second.store.countCloudSubmissions('tenant-a', since), 1);
});


test('Cloud API rejects non-public targets, interactive preview and mutating render plans', async t => {
  const root = await temp();
  let workerCalls = 0;
  const studio = createStudioServer(serverOptions(root, {
    cloudWorker: async () => { workerCalls++; return result; },
  }));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const submit = (route, body) => call(origin, route, {
    method: 'POST', token: tokenA, projectId: 'project-a', body,
  });
  assert.equal((await submit('/api/discover', {
    url: 'http://example.com', language: 'en', maxPages: 1,
  })).status, 422);
  assert.equal((await submit('/api/discover', {
    url: 'https://localhost', language: 'en', maxPages: 1,
  })).status, 422);
  assert.equal((await submit('/api/discover', {
    url: 'https://metadata.google.internal', language: 'en', maxPages: 1,
  })).status, 422);

  const safePlan = {
    schemaVersion: 1, title: 'Read-only cloud guide', url: 'https://example.com',
    language: 'en', steps: [
      { id: 'heading', title: 'Heading', description: 'Observe heading',
        target: { css: 'h1' }, action: 'highlight', holdMs: 500 },
      { id: 'stop', title: 'Stop', description: 'End', action: 'stop', holdMs: 500 },
    ],
  };
  assert.equal((await submit('/api/preview', { plan: safePlan })).status, 403);

  const clickPlan = {
    ...safePlan,
    steps: [
      { id: 'click', title: 'Click', description: 'Click control',
        target: { css: 'button' }, action: 'click', reviewed: true, holdMs: 500 },
      { id: 'stop', title: 'Stop', description: 'End', action: 'stop', holdMs: 500 },
    ],
  };
  assert.equal((await submit('/api/render', {
    plan: clickPlan, confirmedExecution: true,
  })).status, 403);

  const navigationPlan = {
    ...safePlan,
    steps: [
      { id: 'navigate', title: 'Navigate', description: 'Open next page',
        action: 'navigate', url: 'https://example.com/next', reviewed: true, holdMs: 500 },
      { id: 'stop', title: 'Stop', description: 'End', action: 'stop', holdMs: 500 },
    ],
  };
  assert.equal((await submit('/api/render', {
    plan: navigationPlan, confirmedExecution: true,
  })).status, 403);

  const accepted = await submit('/api/render', { plan: safePlan });
  assert.equal(accepted.status, 202);
  await waitForJob(origin, accepted.data.jobId, tokenA, 'project-a');
  assert.equal(workerCalls, 1, 'Only the read-only render reaches the isolated worker');
});


test('Cloud worker symlinks cannot make the API read host files as reports or artifacts', async t => {
  const root = await temp();
  const secret = path.join(root, 'host-secret.json');
  await writeFile(secret, JSON.stringify({ secret: 'host-only-sentinel' }));
  let reportStarted;
  let releaseReport;
  const reportReady = new Promise(resolve => { reportStarted = resolve; });
  const waitReport = new Promise(resolve => { releaseReport = resolve; });
  const studio = createStudioServer(serverOptions(root, {
    cloudWorker: async job => {
      const title = job.request.plan.title;
      if (title === 'report-symlink') {
        await symlink(secret, path.join(job.outputDir, 'report.json'));
        reportStarted();
        await waitReport;
        return { report: { status: 'completed' } };
      }
      if (title === 'video-symlink') {
        await symlink(secret, path.join(job.outputDir, 'tutorial.mp4'));
        return { video: { path: '/job/tutorial.mp4' } };
      }
      return result;
    },
  }));
  const origin = await listen(studio.server);
  t.after(async () => {
    releaseReport();
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const submit = async title => call(origin, '/api/render', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: {
      plan: {
        schemaVersion: 1, title, url: 'https://example.com', language: 'en',
        steps: [
          { id: 'heading', title: 'Heading', description: 'Observe',
            target: { css: 'h1' }, action: 'highlight', holdMs: 500 },
          { id: 'stop', title: 'Stop', description: 'End', action: 'stop', holdMs: 500 },
        ],
      },
    },
  });

  const reportJob = await submit('report-symlink');
  assert.equal(reportJob.status, 202);
  await reportReady;
  const running = await call(origin, '/api/jobs/' + reportJob.data.jobId, {
    token: tokenA, projectId: 'project-a',
  });
  assert.equal(running.status, 200);
  assert.equal(JSON.stringify(running.data).includes('host-only-sentinel'), false);
  releaseReport();
  assert.equal((await waitForJob(origin, reportJob.data.jobId, tokenA, 'project-a')).data.status, 'completed');

  const videoJob = await submit('video-symlink');
  assert.equal(videoJob.status, 202);
  assert.equal((await waitForJob(origin, videoJob.data.jobId, tokenA, 'project-a')).data.status, 'completed');
  const video = await call(origin, '/api/jobs/' + videoJob.data.jobId + '/video', {
    token: tokenA, projectId: 'project-a',
  });
  assert.equal(video.status, 404);
  assert.equal(JSON.stringify(video.data).includes('host-only-sentinel'), false);
});


test('Cloud credentials support staged rotation, individual revocation, principal revocation and expiry', () => {
  let now = Date.parse('2026-11-07T00:00:00.000Z');
  const rotatedToken = 'tenant-a-rotated-secret-0123456789abcdef';
  const auth = createCloudAuth({
    clock: () => now,
    tokens: [{
      id: 'service-a', tokenId: 'service-a-old', token: tokenA,
      tenantId: 'tenant-a', projectIds: ['project-a'],
    }],
  });
  const request = token => ({ headers: { authorization: 'Bearer ' + token } });
  assert.equal(auth.authenticate(request(tokenA)).principalId, 'service-a');

  const overlap = auth.replaceTokens([
    { id: 'service-a', tokenId: 'service-a-old', token: tokenA,
      tenantId: 'tenant-a', projectIds: ['project-a'] },
    { id: 'service-a', tokenId: 'service-a-new', token: rotatedToken,
      tenantId: 'tenant-a', projectIds: ['project-a'] },
  ]);
  assert.equal(overlap.length, 2, 'Rotation can overlap old and new credentials');
  assert.equal(auth.authenticate(request(tokenA)).principalId, 'service-a');
  assert.equal(auth.authenticate(request(rotatedToken)).principalId, 'service-a');

  assert.equal(auth.revokeToken('service-a-old').tokenId, 'service-a-old');
  assert.equal(auth.authenticate(request(tokenA)), null);
  assert.equal(auth.authenticate(request(rotatedToken)).principalId, 'service-a');
  assert.equal(auth.revokePrincipal('service-a').length, 1);
  assert.equal(auth.authenticate(request(rotatedToken)), null);
  assert.deepEqual(auth.tokenSnapshot(), []);

  auth.replaceTokens([{
    id: 'service-a', tokenId: 'service-a-expiring', token: tokenA,
    tenantId: 'tenant-a', projectIds: ['project-a'],
    expiresAt: new Date(now + 1000).toISOString(),
  }]);
  assert.equal(auth.authenticate(request(tokenA)).principalId, 'service-a');
  now += 1000;
  assert.equal(auth.authenticate(request(tokenA)), null, 'Expired tokens stop authenticating at expiry');
  assert.throws(() => auth.replaceTokens([{
    id: 'service-a', tokenId: 'service-a-expiring', token: tokenA,
    tenantId: 'tenant-a', projectIds: ['project-a'], expiresAt: 'not-a-date',
  }]), /expiresAt/);
  assert.throws(() => auth.replaceTokens([
    { id: 'service-a', tokenId: 'duplicate-id', token: tokenA,
      tenantId: 'tenant-a', projectIds: ['project-a'] },
    { id: 'service-a', tokenId: 'duplicate-id', token: rotatedToken,
      tenantId: 'tenant-a', projectIds: ['project-a'] },
  ]), /Duplicate cloud tokenId/);
  assert.throws(() => auth.replaceTokens([
    { id: 'service-a', tokenId: 'scope-one', token: tokenA,
      tenantId: 'tenant-a', projectIds: ['project-a'] },
    { id: 'service-a', tokenId: 'scope-two', token: rotatedToken,
      tenantId: 'tenant-a', projectIds: ['project-a2'] },
  ]), /same tenant and project ACL/);
});

test('Cloud token administration is in-process only, audited and secret-free', async t => {
  const root = await temp();
  const studio = createStudioServer(serverOptions(root));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const rotatedToken = 'tenant-a-rotated-secret-0123456789abcdef';
  assert.equal((await call(origin, '/api/jobs', {
    token: tokenA, projectId: 'project-a',
  })).status, 200);

  const snapshot = studio.tokenAdmin.replace([
    { id: 'service-a', tokenId: 'service-a-old', token: tokenA,
      tenantId: 'tenant-a', projectIds: ['project-a', 'project-a2'] },
    { id: 'service-a', tokenId: 'service-a-new', token: rotatedToken,
      tenantId: 'tenant-a', projectIds: ['project-a', 'project-a2'] },
    { id: 'service-b', tokenId: 'service-b-main', token: tokenB,
      tenantId: 'tenant-b', projectIds: ['project-b'] },
  ], { actorId: 'ops-user' });
  assert.equal(snapshot.length, 3);
  assert.ok(snapshot.every(entry => !('token' in entry) && !('digest' in entry)));
  assert.equal((await call(origin, '/api/jobs', {
    token: tokenA, projectId: 'project-a',
  })).status, 200, 'Old token remains valid during staged rotation');
  assert.equal((await call(origin, '/api/jobs', {
    token: rotatedToken, projectId: 'project-a',
  })).status, 200, 'New token is valid before old-token revocation');

  assert.equal(studio.tokenAdmin.revokeToken('service-a-old', {
    actorId: 'ops-user',
  }), true);
  assert.equal((await call(origin, '/api/jobs', {
    token: tokenA, projectId: 'project-a',
  })).status, 401);
  assert.equal((await call(origin, '/api/jobs', {
    token: rotatedToken, projectId: 'project-a',
  })).status, 200);

  assert.equal(studio.tokenAdmin.revokePrincipal('service-a', {
    actorId: 'ops-user',
  }), 1);
  assert.equal((await call(origin, '/api/jobs', {
    token: rotatedToken, projectId: 'project-a',
  })).status, 401);
  assert.equal((await call(origin, '/api/admin/tokens', {
    token: tokenB, projectId: 'project-b',
  })).status, 404, 'Token administration must not be exposed as a tenant HTTP route');

  const audit = studio.store.cloudAuditEvents('tenant-a');
  assert.deepEqual(audit.map(event => event.action), [
    'auth.tokens_replaced', 'auth.token_revoked', 'auth.principal_revoked',
  ]);
  assert.ok(audit.every(event => event.principalId === 'ops-user'));
  const serialized = JSON.stringify(audit);
  for (const secret of [tokenA, tokenB, rotatedToken]) assert.ok(!serialized.includes(secret));
});


test('Cloud audit HMAC chain migrates legacy rows, verifies across restart and detects tampering', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const auditKey = 'test-only-cloud-audit-signing-key-0123456789abcdef';
  const legacy = new StudioJobStore(root);
  legacy.db.exec('DROP TABLE cloud_audit_events');
  legacy.db.exec('CREATE TABLE cloud_audit_events (' +
    'event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, principal_id TEXT, ' +
    'action TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT)');
  legacy.db.exec('CREATE INDEX cloud_audit_events_tenant_time ON cloud_audit_events(tenant_id, created_at)');
  legacy.db.exec('DROP TABLE cloud_audit_state');
  legacy.db.prepare(
    'INSERT INTO cloud_audit_events (event_id, tenant_id, project_id, principal_id, action, resource_id, outcome, created_at, details) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('legacy-event-1', 'tenant-a', 'project-a', 'ops-user',
    'job.submitted', 'job-1', 'success', '2026-11-06T12:00:00.000Z', JSON.stringify({ jobType: 'discover' }));
  legacy.close();

  const signed = new StudioJobStore(root, { auditKey });
  assert.deepEqual(signed.verifyCloudAuditChain().valid, true);
  assert.equal(signed.verifyCloudAuditChain().count, 1, 'Legacy events are backfilled once');
  signed.recordCloudAudit({
    tenantId: 'tenant-a', projectId: 'project-a', principalId: 'ops-user',
    action: 'job.completed', resourceId: 'job-1', details: { status: 'completed' },
  });
  const valid = signed.verifyCloudAuditChain();
  assert.equal(valid.valid, true);
  assert.equal(valid.count, 2);
  assert.equal(signed.cloudAuditEvents('tenant-a').length, 2);
  signed.close();

  const reopened = new StudioJobStore(root, { auditKey });
  assert.equal(reopened.verifyCloudAuditChain().valid, true, 'Chain remains verifiable after restart');
  const first = reopened.db.prepare(
    'SELECT event_id AS eventId FROM cloud_audit_events ORDER BY sequence LIMIT 1',
  ).get();
  reopened.db.prepare('UPDATE cloud_audit_events SET details=? WHERE event_id=?')
    .run(JSON.stringify({ altered: true }), first.eventId);
  const tampered = reopened.verifyCloudAuditChain();
  assert.equal(tampered.valid, false);
  assert.match(tampered.reason, /signature/);
  reopened.close();

  assert.throws(() => new StudioJobStore(root, {
    auditKey: 'wrong-audit-signing-key-0123456789abcdef',
  }), /integrity verification failed/);
});

test('Cloud mode refuses to start without a stable audit signing secret', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => createStudioServer(serverOptions(root, { cloudAuditKey: null })),
    /stable 32-byte audit signing key/);
  assert.throws(() => createStudioServer(serverOptions(root, {
    cloudAuditKey: 'too-short',
  })), /stable 32-byte audit signing key/);
});

test('Cloud API audit chain verifies token and job events on the active store', async t => {
  const root = await temp();
  const studio = createStudioServer(serverOptions(root));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await call(origin, '/api/jobs', {
    token: tokenA, projectId: 'project-a',
  })).status, 200);
  assert.equal((await call(origin, '/api/jobs', {
    token: tokenA, projectId: 'project-b',
  })).status, 403);
  assert.equal(studio.store.verifyCloudAuditChain().valid, true);
  assert.equal(studio.store.cloudAuditEvents('tenant-a')[0].action, 'project.access_denied');
});


test('Cloud API meters tenant jobs and enforces a durable monthly job budget', async t => {
  const root = await temp();
  const studio = createStudioServer(serverOptions(root, {
    cloudLimits: { maxJobsPerMonth: 1, maxStorageBytesPerTenant: 4 * 1024 * 1024,
      maxOutputBytesPerJob: 1024 * 1024 },
    cloudPricing: { workerCostPerSecondMicros: 100, artifactCostPerMiBMicros: 50 },
    cloudWorker: async job => {
      await writeFile(path.join(job.outputDir, 'usage.bin'), Buffer.alloc(1024 * 1024, 7));
      return result;
    },
  }));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const first = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(first.status, 202);
  assert.equal((await waitForJob(origin, first.data.jobId, tokenA, 'project-a')).data.status, 'completed');

  const usage = await call(origin, '/api/usage', { token: tokenA, projectId: 'project-a' });
  assert.equal(usage.status, 200);
  assert.equal(usage.data.tenantId, 'tenant-a');
  assert.equal(usage.data.estimateOnly, true);
  assert.equal(usage.data.usage.jobs, 1);
  assert.equal(usage.data.usage.artifactBytes, 1024 * 1024);
  assert.equal(usage.data.usage.storageBytes, 1024 * 1024);
  assert.ok(usage.data.usage.workerMs >= 0);
  assert.equal(usage.data.usage.estimatedCostMicros, 50 + Math.ceil(usage.data.usage.workerMs / 1000) * 100);

  const blocked = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a2',
    body: { url: 'https://example.org', language: 'en', maxPages: 1 },
  });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /monthly job budget/);
  const otherTenant = await call(origin, '/api/usage', { token: tokenB, projectId: 'project-b' });
  assert.equal(otherTenant.status, 200);
  assert.equal(otherTenant.data.usage.jobs, 0);
});

test('Cloud API reserves tenant storage before admission and enforces output byte ceilings', async t => {
  const root = await temp();
  const studio = createStudioServer(serverOptions(root, {
    cloudLimits: { maxJobsPerMonth: 10, maxStorageBytesPerTenant: 1024 * 1024,
      maxOutputBytesPerJob: 1024 * 1024 },
    cloudWorker: async job => {
      await writeFile(path.join(job.outputDir, 'usage.bin'), Buffer.alloc(1024 * 1024, 9));
      return result;
    },
  }));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const first = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(first.status, 202);
  assert.equal((await waitForJob(origin, first.data.jobId, tokenA, 'project-a')).data.status, 'completed');

  const blocked = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a2',
    body: { url: 'https://example.org', language: 'en', maxPages: 1 },
  });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /storage budget/);
  const usage = await call(origin, '/api/usage', { token: tokenA, projectId: 'project-a' });
  assert.equal(usage.data.usage.storageBytes, 1024 * 1024);
  assert.equal(usage.data.usage.reservedStorageBytes, 0);
});


test('Cloud audit archive requires exact external acknowledgement and resumes from durable checkpoint', async t => {
  const root = await temp();
  const external = [];
  const archiveSink = async batch => {
    assert.equal(batch.previousSequence, external.length);
    for (const event of batch.events) external.push(event);
    const last = batch.events.at(-1);
    return { throughSequence: last.sequence, throughHash: last.eventHash };
  };
  const studio = createStudioServer(serverOptions(root, { cloudAuditArchive: archiveSink }));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const submitted = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(submitted.status, 202);
  assert.equal((await waitForJob(origin, submitted.data.jobId, tokenA, 'project-a')).data.status, 'completed');

  const first = await studio.auditAdmin.archiveBatch({ limit: 1 });
  assert.equal(first.archived, 1);
  assert.equal(first.lastArchivedSequence, 1);
  const second = await studio.auditAdmin.archiveBatch({ limit: 500 });
  assert.ok(second.archived >= 1);
  assert.equal(second.lastArchivedSequence, external.at(-1).sequence);
  assert.equal(second.lastArchivedHash, external.at(-1).eventHash);
  assert.equal(studio.store.cloudAuditArchiveBatch(500).events.length, 0);
  assert.equal(studio.store.verifyCloudAuditChain().valid, true);
});

test('Cloud audit archive refuses missing or mismatched external acknowledgement', async t => {
  const root = await temp();
  const studio = createStudioServer(serverOptions(root, {
    cloudAuditArchive: async () => ({ throughSequence: 999, throughHash: 'f'.repeat(64) }),
  }));
  const origin = await listen(studio.server);
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const request = await call(origin, '/api/discover', {
    method: 'POST', token: tokenA, projectId: 'project-a',
    body: { url: 'https://example.com', language: 'en', maxPages: 1 },
  });
  assert.equal(request.status, 202);
  assert.equal((await waitForJob(origin, request.data.jobId, tokenA, 'project-a')).data.status, 'completed');
  assert.ok(studio.store.cloudAuditEvents('tenant-a').length > 0, 'Job lifecycle must create signed audit events');
  assert.ok(studio.store.cloudAuditArchiveBatch(500).events.length > 0, 'Archive batch must include unarchived events');
  await assert.rejects(studio.auditAdmin.archiveBatch(), /did not acknowledge the exact batch checkpoint/);
  assert.equal(studio.store.cloudAuditArchiveBatch(500).previousSequence, 0);
});
