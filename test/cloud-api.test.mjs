import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
    const headers = { Host: host };
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
    cloudAllowedHosts: ['api.example.test'],
    exploreImpl: async () => result,
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
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = createStudioServer(serverOptions(root));
  const origin = await listen(studio.server);
  t.after(() => new Promise(resolve => studio.server.close(resolve)));

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
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseFirst;
  let signalFirst;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  let calls = 0;
  const studio = createStudioServer(serverOptions(root, {
    cloudLimits: { maxConcurrentJobsPerTenant: 1, maxJobsPerDay: 1, maxRequestsPerMinute: 30 },
    exploreImpl: async () => {
      calls++;
      if (calls === 1) {
        signalFirst();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
      return result;
    },
  }));
  const origin = await listen(studio.server);
  t.after(() => new Promise(resolve => studio.server.close(resolve)));

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
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = createStudioServer(serverOptions(root, {
    cloudLimits: { maxRequestsPerMinute: 2 },
  }));
  const origin = await listen(studio.server);
  t.after(() => new Promise(resolve => studio.server.close(resolve)));

  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a' })).status, 200);
  assert.equal((await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a2' })).status, 200);
  const limited = await call(origin, '/api/jobs', { token: tokenA, projectId: 'project-a' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await call(origin, '/api/jobs', { token: tokenB, projectId: 'project-b' })).status, 200);
});
