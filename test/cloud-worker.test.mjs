import test from 'node:test';
import assert from 'node:assert/strict';
import { runCloudWorkerJob, assertCloudSafePlan } from '../src/cloud-worker.mjs';

const envelope = (type, request) => ({
  jobId: 'f1f1f1f1-1111-4111-8111-111111111111',
  tenantId: 'tenant-a', projectId: 'project-a', type, request,
});
const safePlan = {
  schemaVersion: 1, title: 'Read-only', url: 'https://example.com', language: 'en',
  steps: [
    { id: 'heading', title: 'Heading', description: 'Observe',
      target: { css: 'h1' }, action: 'highlight', holdMs: 500 },
    { id: 'stop', title: 'Stop', description: 'End', action: 'stop', holdMs: 500 },
  ],
};

test('Cloud worker requires the dedicated proxy and a valid tenant/job envelope', async t => {
  const original = process.env.TUTORIAL_EGRESS_PROXY;
  t.after(() => {
    if (original === undefined) delete process.env.TUTORIAL_EGRESS_PROXY;
    else process.env.TUTORIAL_EGRESS_PROXY = original;
  });
  delete process.env.TUTORIAL_EGRESS_PROXY;
  await assert.rejects(runCloudWorkerJob(envelope('discover', {
    url: 'https://example.com', maxPages: 1, language: 'en',
  })), /dedicated egress proxy/);
  if (original === undefined) delete process.env.TUTORIAL_EGRESS_PROXY;
  else process.env.TUTORIAL_EGRESS_PROXY = original;

  process.env.TUTORIAL_EGRESS_PROXY = 'http://egress-proxy:3128';
  await assert.rejects(runCloudWorkerJob({ ...envelope('discover', {
    url: 'https://example.com', maxPages: 1, language: 'en',
  }), tenantId: '../other' }), /Invalid cloud worker job envelope/);
  await assert.rejects(runCloudWorkerJob(envelope('preview', { plan: safePlan })), /Invalid cloud worker job envelope/);
});

test('Cloud worker uses preflight before starting read-only discovery', async t => {
  const original = process.env.TUTORIAL_EGRESS_PROXY;
  process.env.TUTORIAL_EGRESS_PROXY = 'http://egress-proxy:3128';
  t.after(() => {
    if (original === undefined) delete process.env.TUTORIAL_EGRESS_PROXY;
    else process.env.TUTORIAL_EGRESS_PROXY = original;
  });
  let called = 0;
  const result = { plan: safePlan, plans: [safePlan], report: { status: 'completed' } };
  const job = await runCloudWorkerJob(envelope('discover', {
    url: 'https://example.com', maxPages: 2, language: 'en',
  }), {
    preflight: async url => {
      assert.equal(url, 'https://example.com');
      return url;
    },
    exploreImpl: async (url, options) => {
      called++;
      assert.equal(url, 'https://example.com');
      assert.equal(options.outDir, '/job');
      assert.equal(options.maxPages, 2);
      return result;
    },
  });
  assert.equal(called, 1);
  assert.equal(job, result);
});

test('Cloud worker rejects HTTP, AI and interactive actions before browser execution', async t => {
  const original = process.env.TUTORIAL_EGRESS_PROXY;
  process.env.TUTORIAL_EGRESS_PROXY = 'http://egress-proxy:3128';
  t.after(() => {
    if (original === undefined) delete process.env.TUTORIAL_EGRESS_PROXY;
    else process.env.TUTORIAL_EGRESS_PROXY = original;
  });
  let calls = 0;
  const never = async () => { calls++; throw new Error('browser must not start'); };
  await assert.rejects(runCloudWorkerJob(envelope('discover', {
    url: 'http://example.com', maxPages: 1, language: 'en',
  }), { exploreImpl: never }), /HTTPS/);
  await assert.rejects(runCloudWorkerJob(envelope('goal', {
    url: 'https://example.com', goal: 'Pricing', ai: true, language: 'en',
  }), { goalImpl: never }), /Hosted AI is disabled/);

  const clickPlan = {
    ...safePlan,
    steps: [
      { id: 'click', title: 'Click', description: 'Do not click',
        target: { css: 'button' }, action: 'click', reviewed: true, holdMs: 500 },
      { id: 'stop', title: 'Stop', description: 'End', action: 'stop', holdMs: 500 },
    ],
  };
  assert.throws(() => assertCloudSafePlan(clickPlan), /read-only/);
  await assert.rejects(runCloudWorkerJob(envelope('render', {
    plan: clickPlan, narrate: false,
  }), { renderImpl: never, preflight: async url => url }), /read-only/);
  assert.equal(calls, 0);
});

test('Cloud worker renders only validated read-only plans through the injected renderer', async t => {
  const original = process.env.TUTORIAL_EGRESS_PROXY;
  process.env.TUTORIAL_EGRESS_PROXY = 'http://egress-proxy:3128';
  t.after(() => {
    if (original === undefined) delete process.env.TUTORIAL_EGRESS_PROXY;
    else process.env.TUTORIAL_EGRESS_PROXY = original;
  });
  let received;
  const expected = { status: 'completed', video: { path: '/job/tutorial.mp4' } };
  const result = await runCloudWorkerJob(envelope('render', {
    plan: safePlan, narrate: false,
  }), {
    preflight: async url => url,
    renderImpl: async (plan, options) => {
      received = { plan, options };
      return expected;
    },
  });
  assert.equal(result, expected);
  assert.equal(received.plan.url, safePlan.url);
  assert.equal(received.options.outDir, '/job');
  assert.equal(received.options.headed, false);
  assert.equal(received.options.preview, false);
});
