import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDockerWorkerRunArgs, createDockerWorkerAdapter, directoryBytes } from '../src/cloud-worker-adapter.mjs';

const jobId = 'f1f1f1f1-1111-4111-8111-111111111111';
const image = 'ghcr.io/hieugc/url-to-tutorial-worker@sha256:' + 'a'.repeat(64);

test('Docker worker run is non-root, read-only, resource-limited and mounts only job output', () => {
  const args = buildDockerWorkerRunArgs({
    jobId, containerName: 'utv-worker-' + jobId, networkName: 'utv-job-' + jobId,
    image, outputDir: '/srv/tutorial/output/job-1', uid: 10001, gid: 10001,
  });
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges:true'));
  assert.ok(args.includes('--network'));
  assert.ok(args.includes('utv-job-' + jobId));
  assert.ok(args.includes('--pids-limit=128'));
  assert.ok(args.includes('--memory=2g'));
  assert.ok(args.includes('--shm-size=256m'));
  assert.ok(args.includes('--cpus=2'));
  assert.ok(args.includes('10001:10001'));
  assert.ok(args.some(arg => arg.startsWith('type=bind,src=/srv/tutorial/output/job-1,dst=/job,rw')));
  assert.equal(args.filter(arg => arg.startsWith('type=bind,')).length, 1);
  assert.equal(args.some(arg => arg.includes('docker.sock')), false);
  assert.equal(args.includes('--privileged'), false);
  assert.equal(args.includes('--network=host'), false);
});

test('Docker worker requires an immutable image digest and safe mount identity', () => {
  assert.throws(() => buildDockerWorkerRunArgs({
    jobId, containerName: 'utv-worker-' + jobId, networkName: 'utv-job-' + jobId,
    image: 'worker:latest', outputDir: '/srv/job', uid: 1000, gid: 1000,
  }), /pinned by an immutable/);
  assert.throws(() => buildDockerWorkerRunArgs({
    jobId, containerName: 'utv-worker-' + jobId, networkName: 'utv-job-' + jobId,
    image, outputDir: '/srv/job,evil', uid: 1000, gid: 1000,
  }), /absolute, comma-free/);
  assert.throws(() => buildDockerWorkerRunArgs({
    jobId, containerName: 'utv-worker-' + jobId, networkName: 'utv-job-' + jobId,
    image, outputDir: '/srv/job', uid: 0, gid: 0,
  }), /non-root/);
});

test('Docker adapter creates one internal network, attaches only proxy, runs a one-shot worker and cleans up', async t => {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    t.skip('Requires a non-root host process to match production worker ownership');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'tutorial-docker-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, jobId);
  const log = path.join(root, 'docker-calls.jsonl');
  const originalLog = process.env.FAKE_DOCKER_LOG;
  t.after(() => {
    if (originalLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = originalLog;
  });
  await import('node:fs/promises').then(fs => fs.mkdir(output));
  const fakeDocker = path.join(root, 'docker-fake.mjs');
  const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
let input = '';
const record = () => fs.appendFileSync(log, JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'run') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    record();
    process.stdout.write(JSON.stringify({ status: 'completed', worker: 'fixture' }));
  });
} else {
  record();
  if (args[0] === 'network' && args[1] === 'create') process.stdout.write('network-id\\n');
}
`;
  await writeFile(fakeDocker, fakeSource);
  await chmod(fakeDocker, 0o755);
  process.env.FAKE_DOCKER_LOG = log;
  const adapter = createDockerWorkerAdapter({
    dockerBin: fakeDocker, image, allowedOutputRoot: root,
  });
  const controller = new AbortController();
  const result = await adapter({
    jobId, tenantId: 'tenant-a', projectId: 'project-a', type: 'discover',
    request: { url: 'https://example.com', maxPages: 1, language: 'en' },
    outputDir: output, signal: controller.signal,
  });
  delete process.env.FAKE_DOCKER_LOG;
  assert.deepEqual(result, { status: 'completed', worker: 'fixture' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const create = calls.find(call => call.args[0] === 'network' && call.args[1] === 'create');
  const connect = calls.find(call => call.args[0] === 'network' && call.args[1] === 'connect');
  const run = calls.find(call => call.args[0] === 'run');
  const disconnect = calls.find(call => call.args[0] === 'network' && call.args[1] === 'disconnect');
  const removeNetwork = calls.find(call => call.args[0] === 'network' && call.args[1] === 'rm');
  assert.ok(create.args.includes('--internal'));
  assert.ok(connect.args.includes('--alias'));
  assert.ok(connect.args.includes('egress-proxy'));
  assert.ok(run.args.includes('--read-only'));
  assert.ok(run.args.includes('--cap-drop=ALL'));
  const outputReal = await realpath(output);
  assert.ok(run.args.some(arg => arg.startsWith('type=bind,src=' + outputReal + ',dst=/job,rw')));
  assert.deepEqual(JSON.parse(run.input).request, {
    url: 'https://example.com', maxPages: 1, language: 'en',
  });
  assert.ok(disconnect);
  assert.ok(removeNetwork);
  assert.equal(calls.some(call => call.args.some(arg => arg.includes('docker.sock'))), false);
});


test('Worker output byte accounting does not follow symlinks outside the job directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutorial-output-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'job');
  await import('node:fs/promises').then(fs => fs.mkdir(output));
  const outside = path.join(root, 'outside-secret.bin');
  await writeFile(outside, Buffer.alloc(4096));
  await writeFile(path.join(output, 'render.mp4'), Buffer.alloc(128));
  await symlink(outside, path.join(output, 'linked-secret.bin'));
  const bytes = await directoryBytes(output);
  assert.ok(bytes < 4096, 'symlink target bytes must never be counted or followed');
  assert.ok(bytes >= 128, 'regular worker output files must be counted');
});
