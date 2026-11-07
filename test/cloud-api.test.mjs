import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudAuth } from '../src/cloud-auth.mjs';
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
  t.after(async () => {
    await new Promise(resolve => studio.server.close(resolve));
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
  t.after(async () => {
    await new Promise(resolve => restarted.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
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
