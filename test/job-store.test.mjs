import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioJobStore } from '../src/job-store.mjs';
import { createStudioServer } from '../src/studio-server.mjs';

const base = {
  schemaVersion: 1, title: 'Stored plan', url: 'https://example.com', language: 'vi',
  steps: [{ id: 'one', title: 'Hello', description: 'World',
    target: { css: '#field' }, action: 'fill', value: 'private-value',
    holdMs: 500, reviewed: true }],
};

const temp = () => mkdtemp(path.join(tmpdir(), 'studio-sqlite-'));
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
const post = (origin, route, value) => fetch(origin + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
async function done(origin, id) {
  for (let i = 0; i < 90; i++) {
    const r = await fetch(origin + '/api/jobs/' + id);
    const x = await r.json();
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(x.status)) return x;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for job ' + id);
}

test('SQLite persists state and marks running jobs interrupted on restart', async () => {
  const root = await temp();
  const store = new StudioJobStore(root);
  const sample = { id: '00000000-0000-4000-8000-000000000001', type: 'render',
    status: 'running', createdAt: new Date().toISOString(), result: null, error: null,
    request: { plan: { title: 'test' } } };
  store.save(sample);
  store.close();
  const { server } = createStudioServer({ outputRoot: root });
  const origin = await listen(server);
  try {
    const response = await fetch(origin + '/api/jobs/' + sample.id);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.status, 'interrupted');
    assert.match(snapshot.error, /not resumed automatically/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Queued jobs may cancel and read-only discovery may retry; render never auto retries', async () => {
  const root = await temp();
  let release;
  let calls = 0;
  const { server } = createStudioServer({
    outputRoot: root,
    exploreImpl: async () => {
      calls++;
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      return { plan: { ...base, steps: [{ id: 'hi', title: 'Intro',
        description: '', target: { css: 'h1' }, action: 'highlight', holdMs: 500 }] },
        plans: [], report: { pages: [] } };
    },
    renderImpl: async () => ({ status: 'completed', steps: [] }),
  });
  const origin = await listen(server);
  try {
    const first = await post(origin, '/api/discover', { url: 'https://example.com' });
    assert.equal(first.status, 202);
    const firstId = (await first.json()).jobId;
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof release, 'function');
    const second = await post(origin, '/api/discover', { url: 'https://example.com' });
    const secondId = (await second.json()).jobId;
    const cancel = await post(origin, '/api/jobs/' + secondId + '/cancel', {});
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).status, 'cancelled');
    release();
    assert.equal((await done(origin, firstId)).status, 'completed');
    assert.equal((await done(origin, secondId)).status, 'cancelled');
    assert.equal(calls, 1);
    const retry = await post(origin, '/api/jobs/' + secondId + '/retry', {});
    assert.equal(retry.status, 202);
    assert.equal((await done(origin, (await retry.json()).jobId)).status, 'completed');
    assert.equal(calls, 2);

    const render = await post(origin, '/api/render', { plan: base, confirmedExecution: true });
    const renderId = (await render.json()).jobId;
    assert.equal((await done(origin, renderId)).status, 'completed');
    assert.equal((await post(origin, '/api/jobs/' + renderId + '/retry', {})).status, 409);
    const history = await fetch(origin + '/api/jobs');
    assert.equal(history.status, 200);
    assert.ok((await history.json()).jobs.length >= 4);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const persisted = new StudioJobStore(root);
  try {
    const saved = persisted.all().find(job => job.type === 'render');
    assert.equal(saved.request.plan.steps[0].value, '[redacted]');
  } finally { persisted.close(); }
});

test('Retention sees expired rows beyond the newest 40 and never trims active work', async t => {
  const root = await temp();
  const store = new StudioJobStore(root);
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  const old = '2020-01-01T00:00:00.000Z';
  store.save({ id: 'active', status: 'running', createdAt: old });
  store.save({ id: 'expired', status: 'completed', createdAt: old, finishedAt: old });
  for (let i = 0; i < 42; i++) {
    store.save({ id: 'terminal-' + i, status: i % 2 ? 'cancelled' : 'interrupted',
      createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  }
  assert.equal(store.all().length, 44);
  assert.deepEqual(store.expired().map(job => job.id), ['expired']);
  const removed = store.trim();
  assert.equal(removed.length, 4);
  assert.ok(removed.includes('expired'));
  assert.ok(!removed.includes('active'));
  assert.equal(store.all().length, 40);
  assert.equal(store.all().find(job => job.id === 'active').status, 'running');
});

test('Studio removes expired and trimmed artifacts using UUID paths only', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedFile = path.join(root, 'keep.txt');
  await writeFile(protectedFile, 'Do not remove a stored arbitrary outputDir');
  const store = new StudioJobStore(root);
  const ids = [];
  for (let i = 0; i < 43; i++) {
    const id = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
    ids.push(id);
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'tutorial.mp4'), 'fixture');
    const when = i === 0 ? '2020-01-01T00:00:00.000Z' : new Date().toISOString();
    store.save({ id, status: i % 2 ? 'cancelled' : 'interrupted', createdAt: when,
      finishedAt: when, outputDir: protectedFile });
  }
  store.close();
  const studio = createStudioServer({ outputRoot: root });
  await listen(studio.server);
  try {
    assert.equal(studio.jobs.size, 40);
    assert.equal(studio.store.all().length, 40);
    for (const id of ids.slice(0, 3)) {
      await assert.rejects(access(path.join(root, id)), { code: 'ENOENT' });
      assert.ok(!studio.jobs.has(id));
    }
    await access(path.join(root, ids.at(-1), 'tutorial.mp4'));
    await access(protectedFile);
  } finally {
    await new Promise(resolve => studio.server.close(resolve));
  }
});


test('Completed plans and MP4 remain recoverable after a Studio process restart without replay', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  let discovers = 0;
  let renders = 0;
  const savedPlan = {
    ...base, title: 'Persisted read-only guide', steps: [{
      id: 'intro', title: 'Observed heading', description: 'Public fixture',
      action: 'highlight', target: { css: 'h1' }, holdMs: 500,
    }],
  };
  const first = createStudioServer({
    outputRoot: root,
    exploreImpl: async () => {
      discovers++;
      return {
        plan: savedPlan, plans: [savedPlan],
        report: { status: 'completed', pages: [{ title: 'Public fixture', finalUrl: base.url }] },
      };
    },
    renderImpl: async (_plan, { outDir }) => {
      renders++;
      const video = path.join(outDir, 'tutorial.mp4');
      await writeFile(video, 'persisted MP4 fixture');
      return {
        status: 'completed', steps: [],
        video: { path: video, codec: 'h264', width: 1280, height: 720, duration: 1 },
      };
    },
  });
  const origin = await listen(first.server);
  let discoveredId;
  let renderedId;
  try {
    const discoverRequest = await post(origin, '/api/discover', {
      url: base.url, language: 'en', maxPages: 1,
    });
    assert.equal(discoverRequest.status, 202);
    discoveredId = (await discoverRequest.json()).jobId;
    assert.equal((await done(origin, discoveredId)).status, 'completed');

    const renderRequest = await post(origin, '/api/render', {
      plan: savedPlan, confirmedExecution: false,
    });
    assert.equal(renderRequest.status, 202);
    renderedId = (await renderRequest.json()).jobId;
    assert.equal((await done(origin, renderedId)).status, 'completed');
  } finally {
    await new Promise(resolve => first.server.close(resolve));
  }
  assert.equal(discovers, 1);
  assert.equal(renders, 1);

  // The second instance has NO working renderer/discoverer. Accessing history
  // must be a pure read; no browser operation can restart by accident.
  const restored = createStudioServer({
    outputRoot: root,
    exploreImpl: async () => { throw new Error('Unapproved discovery replay after restart'); },
    renderImpl: async () => { throw new Error('Unapproved render replay after restart'); },
  });
  const secondOrigin = await listen(restored.server);
  try {
    const history = await (await fetch(secondOrigin + '/api/jobs')).json();
    for (const id of [discoveredId, renderedId]) {
      const item = history.jobs.find(job => job.id === id);
      assert.equal(item?.status, 'completed');
      assert.equal(item.retryable, false);
      assert.ok(!('request' in item), 'History must not expose persisted request data');
    }
    const discovery = await (await fetch(secondOrigin + '/api/jobs/' + discoveredId)).json();
    assert.equal(discovery.discovery.plan.title, savedPlan.title);
    assert.equal(discovery.discovery.plan.steps[0].action, 'highlight');

    const render = await (await fetch(secondOrigin + '/api/jobs/' + renderedId)).json();
    assert.equal(render.videoUrl, '/api/jobs/' + renderedId + '/video');
    assert.equal(render.report.video.codec, 'h264');
    assert.equal('path' in render.report.video, false);
    const downloaded = await fetch(secondOrigin + render.videoUrl);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'persisted MP4 fixture');
    assert.equal((await post(secondOrigin, '/api/jobs/' + renderedId + '/retry', {})).status, 409);
    assert.equal(discovers, 1);
    assert.equal(renders, 1);
  } finally {
    await new Promise(resolve => restored.server.close(resolve));
  }
});
