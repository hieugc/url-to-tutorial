import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { command, render } from '../src/render.mjs';
import { createStudioServer } from '../src/studio-server.mjs';

const plan = {
  schemaVersion: 1, title: 'Cancelable job', url: 'https://example.com', language: 'en',
  steps: [
    { id: 'intro', title: 'Intro', description: 'Read-only step',
      target: { css: 'h1' }, action: 'highlight', holdMs: 500 },
    { id: 'stop', title: 'Done', description: 'End', action: 'stop', holdMs: 500 },
  ],
};
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
const post = (origin, body, key) => fetch(origin + '/api/render', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
});
async function waitFor(origin, id, status) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(origin + '/api/jobs/' + id);
    const job = await response.json();
    if (job.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for ' + status);
}

test('Command kills an in-flight child process when its AbortSignal fires', async () => {
  const controller = new AbortController();
  const work = command(process.execPath, [
    '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
  ], { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(work, error => error.name === 'AbortError');
});

test('Running render job supports cooperative cancellation and persists terminal state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'utv-cancel-running-'));
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  const { server } = createStudioServer({
    outputRoot: root,
    renderImpl: async (_plan, { signal }) => {
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('browser context closed'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
  });
  const origin = await listen(server);
  try {
    const created = await post(origin, { plan });
    assert.equal(created.status, 202);
    const id = (await created.json()).jobId;
    await didStart;
    // Browser API clients may send POST without a JSON body.
    const response = await fetch(origin + '/api/jobs/' + id + '/cancel', {
      method: 'POST',
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'cancelling');
    const finished = await waitFor(origin, id, 'cancelled');
    assert.equal(finished.cancelRequested, true);
    assert.equal(finished.error, 'Cancelled by operator');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Actual Chromium render stops on AbortSignal and writes a cancelled report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'utv-render-abort-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body><h1>Long-running fixture</h1></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  const longPlan = {
    ...plan, url,
    steps: [
      { id: 'long', title: 'Wait', description: 'This step is intentionally long.',
        target: { css: 'h1' }, action: 'highlight', holdMs: 30000 },
      { id: 'stop', title: 'Done', description: 'Never reached.',
        action: 'stop', holdMs: 500 },
    ],
  };
  try {
    const rendering = render(longPlan, { outDir: root, signal: controller.signal });
    const rejected = assert.rejects(rendering, error => error.name === 'AbortError');
    let stepStarted = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
        if (report.steps?.length) {
          stepStarted = true;
          controller.abort();
          break;
        }
      } catch { /* report has not been created yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!controller.signal.aborted) controller.abort();
    await rejected;
    const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
    assert.equal(report.status, 'cancelled');
    assert.equal(stepStarted, true, 'The render must have started a browser step before cancellation');
    assert.equal(report.steps.at(-1).status, 'cancelled');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Idempotency key returns the same job and rejects changed payloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'utv-idempotency-'));
  let release;
  let calls = 0;
  const { server } = createStudioServer({
    outputRoot: root,
    renderImpl: async () => {
      calls++;
      await new Promise(resolve => { release = resolve; });
      return { status: 'completed', steps: [] };
    },
  });
  const origin = await listen(server);
  try {
    const first = await post(origin, { plan }, 'render-job-0001');
    assert.equal(first.status, 202);
    const id = (await first.json()).jobId;
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof release, 'function');

    const duplicate = await post(origin, { plan }, 'render-job-0001');
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.jobId, id);
    assert.equal(duplicateBody.deduplicated, true);
    assert.equal(calls, 1);

    const changedPlan = { ...plan, title: 'Different request' };
    const conflict = await post(origin, { plan: changedPlan }, 'render-job-0001');
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /different request/);
    release();
    await waitFor(origin, id, 'completed');
  } finally {
    release?.();
    await new Promise(resolve => server.close(resolve));
  }
});
