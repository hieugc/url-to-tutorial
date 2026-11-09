import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioJobStore } from '../src/job-store.mjs';
import { createCloudArtifactCipher } from '../src/cloud-artifact-crypto.mjs';

const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = randomBytes(32);
const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
const cipher = createCloudArtifactCipher({
  keyRing: { activeKeyId: keyId, keys: { [keyId]: key.toString('hex') } },
  chunkSize: 64 * 1024,
});
const temp = () => mkdtemp(path.join(tmpdir(), 'utv-cloud-job-record-'));

function job(overrides = {}) {
  return {
    id: jobId,
    type: 'render',
    status: 'completed',
    createdAt: '2026-11-09T00:00:00.000Z',
    finishedAt: '2026-11-09T00:01:00.000Z',
    tenantId: 'tenant-private',
    projectId: 'project-private',
    request: { goal: 'private customer objective' },
    result: { report: { title: 'private report payload' } },
    outputDir: '/private/output/path',
    ...overrides,
  };
}

test('cloud job snapshots are encrypted in SQLite and transparently decrypted after restart', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StudioJobStore(root, { artifactCipher: cipher });
  store.save(job());

  const raw = store.db.prepare('SELECT json FROM studio_jobs WHERE id=?').get(jobId).json;
  const envelope = JSON.parse(raw);
  assert.equal(envelope.storageFormat, 'utv-cloud-job-record-v1');
  assert.equal(JSON.stringify(envelope).includes('tenant-private'), false);
  assert.equal(JSON.stringify(envelope).includes('private customer objective'), false);
  assert.equal(JSON.stringify(envelope).includes('private report payload'), false);
  store.close();

  const restarted = new StudioJobStore(root, { artifactCipher: cipher });
  try {
    const restored = restarted.all()[0];
    assert.equal(restored.tenantId, 'tenant-private');
    assert.equal(restored.request.goal, 'private customer objective');
    assert.equal(restored.result.report.title, 'private report payload');
  } finally { restarted.close(); }
});

test('cloud submission transaction stores its job snapshot encrypted', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StudioJobStore(root, { artifactCipher: cipher });
  try {
    store.saveCloudSubmission(job({ status: 'queued', result: null }), null, null);
    const raw = JSON.parse(store.db.prepare('SELECT json FROM studio_jobs WHERE id=?').get(jobId).json);
    assert.equal(raw.storageFormat, 'utv-cloud-job-record-v1');
    assert.equal(JSON.stringify(raw).includes('tenant-private'), false);
    assert.equal(store.all()[0].request.goal, 'private customer objective');
  } finally { store.close(); }
});

test('cloud job snapshots fail closed when encrypted data is tampered', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StudioJobStore(root, { artifactCipher: cipher });
  try {
    store.save(job());
    const raw = JSON.parse(store.db.prepare('SELECT json FROM studio_jobs WHERE id=?').get(jobId).json);
    const encrypted = Buffer.from(raw.payload, 'base64');
    encrypted[encrypted.length - 1] ^= 0x01;
    raw.payload = encrypted.toString('base64');
    store.db.prepare('UPDATE studio_jobs SET json=? WHERE id=?').run(JSON.stringify(raw), jobId);
    assert.throws(() => store.all(), /authentication/i);
  } finally { store.close(); }
});

test('cloud startup can migrate legacy plaintext job rows by re-saving them', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new StudioJobStore(root);
  legacy.save(job());
  legacy.close();

  const migrated = new StudioJobStore(root, { artifactCipher: cipher });
  try {
    const restored = migrated.all()[0];
    assert.equal(restored.request.goal, 'private customer objective');
    migrated.save(restored);
    const raw = JSON.parse(migrated.db.prepare('SELECT json FROM studio_jobs WHERE id=?').get(jobId).json);
    assert.equal(raw.storageFormat, 'utv-cloud-job-record-v1');
    assert.equal(JSON.stringify(raw).includes('private report payload'), false);
  } finally { migrated.close(); }
});
