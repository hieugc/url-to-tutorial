import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../src/studio-server.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'studio-api-'));
const landingPlan = {
  schemaVersion: 1, title: 'Sample guide', url: 'https://sample.test',
  language: 'vi', mode: 'overview', viewport: { width: 1280, height: 720 },
  steps: [{ id: 'intro', title: 'Giới thiệu', description: 'Hướng dẫn trang mẫu',
    action: 'highlight', target: { css: 'body' }, holdMs: 1000 }],
};
const secondPlan = {
  ...landingPlan, title: 'Second page', url: 'https://sample.test/guide',
  steps: [{ id: 'detail', title: 'Next page', description: 'Trang thứ hai',
    action: 'highlight', target: { css: 'h1' }, holdMs: 1000 }],
};
const report = {
  status: 'completed', entryUrl: landingPlan.url,
  pages: [
    { finalUrl: landingPlan.url, title: landingPlan.title, candidateCount: 1, screenshot: 'discovery-page-1.png' },
    { finalUrl: secondPlan.url, title: secondPlan.title, candidateCount: 1, screenshot: 'discovery-page-2.png' },
  ],
};
let flakyAttempts = 0;
let renderImplCalls = 0;
const { server } = createStudioServer({
  outputRoot: root,
  exploreImpl: async (url, { outDir }) => {
    if (url === 'https://sample.test/flaky' && ++flakyAttempts === 1) {
      throw new Error('Controlled discovery failure');
    }
    await writeFile(path.join(outDir, 'discovery-page-1.png'), Buffer.from([137, 80, 78, 71]));
    return { plan: landingPlan, plans: [landingPlan, secondPlan], report };
  },
  goalImpl: async (_url, { outDir, ai }) => {
    if (ai) throw new Error('Controlled paid-model failure');
    await writeFile(path.join(outDir, 'discovery-page-1.png'), Buffer.from([137, 80, 78, 71]));
    return {
      plan: { ...landingPlan, title: 'Goal-based guide' },
      evidence: { selectedIds: ['candidate-1'], candidates: [
        { id: 'candidate-1', text: 'Guide overview', css: 'body' },
      ] },
      report: { status: 'completed', provider: 'offline-keyword' },
    };
  },
  hostingerImpl: async (_url, { outDir }) => {
    await writeFile(path.join(outDir, 'hostinger-pricing.png'), Buffer.from([137, 80, 78, 71]));
    return {
      plan: { ...landingPlan, url: 'https://www.hostinger.com/vn#pricing' },
      evidence: { cards: [{ name: 'Premium', monthly: '41.900 đ/th', selector: '#premium' }] },
      report: { status: 'completed', screenshot: 'hostinger-pricing.png', warnings: [] },
    };
  },
  assembleImpl: () => ({
    ...landingPlan, steps: [
      landingPlan.steps[0],
      { id: 'page2', title: 'Next page', description: 'Move to next page',
        action: 'navigate', url: secondPlan.url, reviewed: false, holdMs: 1500 },
      { ...secondPlan.steps[0], id: 'detail' },
    ],
  }),
  renderImpl: async (_plan, { outDir, preview }) => {
    renderImplCalls++;
    const video = { codec: 'h264', width: 1280, height: 720, duration: 2, path: path.join(outDir, 'tutorial.mp4') };
    if (!preview) await writeFile(video.path, Buffer.from('fake MP4 API test fixture'));
    return { status: 'completed', steps: [{ id: 'intro', status: 'completed' }],
      ...(!preview ? { video } : {}) };
  },
});

let origin;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

const post = (route, value, extra = {}) => fetch(origin + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(value),
});
async function poll(id) {
  for (let i = 0; i < 80; i++) {
    const response = await fetch(origin + '/api/jobs/' + id);
    const data = await response.json();
    if (['completed', 'failed'].includes(data.status)) return data;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out polling Studio job');
}

test('Studio serves its HTML and restricts requests to localhost origin', async () => {
  const response = await fetch(origin + '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Website source/);
  assert.match(html, /step-form/);
  const css = await fetch(origin + '/studio.css');
  assert.equal(css.status, 200);
  const js = await fetch(origin + '/studio.js');
  assert.equal(js.status, 200);

  const denied = await post('/api/discover', { url: 'https://sample.test' }, { Origin: 'https://evil.test' });
  assert.equal(denied.status, 403);
  // fetch() normalizes the Host header, so send a raw HTTP request instead.
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port,
      path: '/api/health', headers: { Host: 'evil.test' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHostStatus, 403);
  const notFound = await fetch(origin + '/../../src/plan.mjs');
  assert.equal(notFound.status, 404);
});

test('Studio validates schema and review gate', async () => {
  const invalid = await post('/api/validate', { plan: { ...landingPlan, steps: [] } });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).valid, false);
  const valid = await post('/api/validate', { plan: landingPlan });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).ready, true);
  const notReviewed = { ...landingPlan, steps: [
    { id: 'go', title: 'Go to page', description: '', url: secondPlan.url,
      action: 'navigate', holdMs: 1000 },
  ] };
  assert.equal((await post('/api/render', { plan: notReviewed })).status, 409);
  const reviewed = {
    ...notReviewed, steps: [{ ...notReviewed.steps[0], reviewed: true }],
  };
  assert.equal((await post('/api/preview', { plan: reviewed })).status, 409);
});

test('Studio queues discovery, retrieves screenshot, assembles and downloads video', async () => {
  const discover = await post('/api/discover', { url: landingPlan.url, maxPages: 2 });
  assert.equal(discover.status, 202);
  const { jobId } = await discover.json();
  const result = await poll(jobId);
  assert.equal(result.status, 'completed');
  assert.equal(result.discovery.plans.length, 2);
  assert.equal(result.discovery.report.pages.length, 2);
  const image = await fetch(origin + '/api/jobs/' + jobId + '/screenshot/1');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const assembled = await post('/api/assemble', { discoveryJobId: jobId });
  assert.equal(assembled.status, 200);
  assert.equal((await assembled.json()).plan.steps[1].reviewed, false);
  const renderRequest = await post('/api/render', { plan: landingPlan });
  assert.equal(renderRequest.status, 202);
  const renderJob = await poll((await renderRequest.json()).jobId);
  assert.equal(renderJob.status, 'completed');
  assert.ok(renderImplCalls > 0, 'the injected render implementation was never invoked for this job');
  assert.ok(renderJob.report, 'completed render job omitted its result: ' + JSON.stringify(renderJob));
  assert.match(renderJob.videoUrl, /\/video$/);
  assert.equal(renderJob.report.video.codec, 'h264');
  assert.equal('path' in renderJob.report.video, false);
  const video = await fetch(origin + renderJob.videoUrl);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.match(await video.text(), /fake MP4 API test/);
});

test('Studio Hostinger adapter rejects untrusted URLs and serves only observed read-only guide', async () => {
  const bad = await post('/api/hostinger', { url: 'https://hostinger.com.evil.test/vn' });
  assert.equal(bad.status, 422);
  const created = await post('/api/hostinger', { url: 'https://www.hostinger.com/vn#pricing', language: 'vi' });
  assert.equal(created.status, 202);
  const job = await poll((await created.json()).jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.hostinger.plan.steps[0].action, 'highlight');
  assert.equal(job.hostinger.evidence.cards[0].monthly, '41.900 đ/th');
  const screenshot = await fetch(origin + '/api/jobs/' + job.id + '/hostinger-screenshot');
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.equal((await post('/api/validate', { plan: job.hostinger.plan })).status, 200);
});

test('Studio goal planner enforces input length and serves grounded draft', async () => {
  assert.equal((await post('/api/goal', { url: 'https://example.com', goal: 'a' })).status, 422);
  const started = await post('/api/goal', {
    url: 'https://example.com', goal: 'Guide overview', ai: false, language: 'vi',
  });
  assert.equal(started.status, 202);
  const result = await poll((await started.json()).jobId);
  assert.equal(result.status, 'completed');
  assert.equal(result.goal.plan.steps[0].action, 'highlight');
  assert.deepEqual(result.goal.evidence.selectedIds, ['candidate-1']);
  const screenshot = await fetch(origin + '/api/jobs/' + result.id + '/goal-screenshot');
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
});


test('History exposes only server-approved retries and never retries paid AI or render jobs', async () => {
  const failedRequest = await post('/api/discover', {
    url: 'https://sample.test/flaky', maxPages: 1, language: 'vi',
  });
  assert.equal(failedRequest.status, 202);
  const failedId = (await failedRequest.json()).jobId;
  const failed = await poll(failedId);
  assert.equal(failed.status, 'failed');

  const paidRequest = await post('/api/goal', {
    url: 'https://example.com', goal: 'Premium hosting', language: 'vi', ai: true,
  });
  assert.equal(paidRequest.status, 202);
  const paidId = (await paidRequest.json()).jobId;
  assert.equal((await poll(paidId)).status, 'failed');

  const history = await (await fetch(origin + '/api/jobs')).json();
  const safe = history.jobs.find(job => job.id === failedId);
  const paid = history.jobs.find(job => job.id === paidId);
  assert.equal(safe.status, 'failed');
  assert.equal(safe.retryable, true);
  assert.equal(paid.retryable, false);
  assert.ok(history.jobs.some(job => job.type === 'render' && job.retryable === false));
  assert.ok(history.jobs.every(job => !('request' in job) && !('plan' in job)),
    'Public history must never expose persisted plan or request payloads');

  const rejected = await post('/api/jobs/' + paidId + '/retry', {});
  assert.equal(rejected.status, 409);
  assert.equal(flakyAttempts, 1, 'No retry may happen automatically');

  const retriedResponse = await fetch(origin + '/api/jobs/' + failedId + '/retry', {
    method: 'POST',
  });
  assert.equal(retriedResponse.status, 202);
  const retried = await poll((await retriedResponse.json()).jobId);
  assert.equal(retried.status, 'completed');
  assert.equal(flakyAttempts, 2);
  assert.equal(retried.discovery.plan.title, landingPlan.title);
});
