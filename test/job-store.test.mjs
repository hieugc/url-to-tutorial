import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
