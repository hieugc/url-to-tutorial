import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function boot(root) {
  const child = fork(new URL('./fixtures/recovery-worker.mjs', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  try {
    const [{ port }] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    return { child, origin: 'http://127.0.0.1:' + port };
  } catch (error) {
    await kill(child);
    throw new Error('Recovery worker did not boot: ' + logs, { cause: error });
  }
}

async function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

async function post(origin, route, body, key) {
  const response = await fetch(origin + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('SIGKILL recovery preserves deduplication and never replays running or queued actions', {
  timeout: 20000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-crash-'));
  let worker;
  t.after(async () => { await kill(worker?.child); await rm(root, { recursive: true, force: true }); });
  worker = await boot(root);
  const plan = {
    schemaVersion: 1, title: 'Crash recovery', url: 'https://example.com', language: 'en',
    steps: [{ id: 'click', title: 'Click', description: 'Reviewed fixture action',
      action: 'click', target: { css: '#demo' }, holdMs: 500, reviewed: true }],
  };
  const body = { plan, confirmedExecution: true };
  const running = await post(worker.origin, '/api/render', body, 'crash-render-001');
  assert.equal(running.status, 202);
  for (let i = 0; i < 100; i++) {
    try { if ((await readFile(path.join(root, 'executions.txt'), 'utf8')).length) break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.equal(await readFile(path.join(root, 'executions.txt'), 'utf8'), 'render started\n');
  const queued = await post(worker.origin, '/api/discover', { url: 'https://example.com' }, 'crash-discover-001');
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, 'queued');
  await kill(worker.child);
  worker = await boot(root);
  for (const id of [running.body.jobId, queued.body.jobId]) {
    const recovered = await (await fetch(worker.origin + '/api/jobs/' + id)).json();
    assert.equal(recovered.status, 'interrupted');
  }
  const duplicate = await post(worker.origin, '/api/render', body, 'crash-render-001');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.jobId, running.body.jobId);
  assert.equal(duplicate.body.status, 'interrupted');
  assert.equal(duplicate.body.deduplicated, true);
  const conflict = await post(worker.origin, '/api/render', {
    ...body, plan: { ...plan, title: 'Different request' },
  }, 'crash-render-001');
  assert.equal(conflict.status, 409);
  assert.equal((await post(worker.origin, '/api/jobs/' + running.body.jobId + '/retry', {})).status, 409);
  assert.equal(await readFile(path.join(root, 'executions.txt'), 'utf8'), 'render started\n');
  // A retry may be requested without Content-Type or JSON payload.
  const retriedResponse = await fetch(worker.origin + '/api/jobs/' + queued.body.jobId + '/retry', {
    method: 'POST', headers: { 'Idempotency-Key': 'crash-retry-001' },
  });
  const retried = { status: retriedResponse.status, body: await retriedResponse.json() };
  assert.equal(retried.status, 202);
  for (let i = 0; i < 100; i++) {
    const current = await (await fetch(worker.origin + '/api/jobs/' + retried.body.jobId)).json();
    if (current.status === 'completed') break;
    await delay(20);
  }
  assert.equal(await readFile(path.join(root, 'executions.txt'), 'utf8'), 'render started\ndiscover started\n');
});
