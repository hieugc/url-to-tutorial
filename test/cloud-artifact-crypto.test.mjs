import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, stat, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudArtifactCipher } from '../src/cloud-artifact-crypto.mjs';

const jobId = '11111111-1111-4111-8111-111111111111';
const otherJobId = '22222222-2222-4222-8222-222222222222';

function keyRing(materials, activeIndex = materials.length - 1) {
  const keys = Object.create(null);
  for (const material of materials) {
    const bytes = Buffer.isBuffer(material) ? material : Buffer.from(material, 'hex');
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    keys[id] = bytes.toString('hex');
  }
  const ids = Object.keys(keys);
  return { activeKeyId: ids[activeIndex], keys };
}

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const oldRing = keyRing([oldKey]);
const rotatedRing = keyRing([oldKey, newKey]);
const temp = () => mkdtemp(path.join(tmpdir(), 'utv-cloud-artifacts-'));

test('cloud artifact encryption round-trips binary buffers across authenticated chunks', () => {
  const cipher = createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 64 * 1024 });
  const source = randomBytes(180_123);
  const encrypted = cipher.encryptBuffer(source, { jobId, filename: 'result.bin' });
  assert.notDeepEqual(encrypted, source);
  assert.equal(cipher.decryptBuffer(encrypted, { jobId, filename: 'result.bin' }).compare(source), 0);
});

test('cloud artifact encryption handles empty files and exact chunk boundaries', () => {
  const cipher = createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 64 * 1024 });
  for (const source of [Buffer.alloc(0), randomBytes(64 * 1024), randomBytes(128 * 1024)]) {
    const encrypted = cipher.encryptBuffer(source, { jobId, filename: 'boundary.bin' });
    assert.equal(cipher.decryptBuffer(encrypted, { jobId, filename: 'boundary.bin' }).compare(source), 0);
  }
});

test('cloud artifact ciphertext is bound to the job and relative artifact path', () => {
  const cipher = createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 64 * 1024 });
  const encrypted = cipher.encryptBuffer(Buffer.from('tenant-private-result'), {
    jobId, filename: 'report.json',
  });
  assert.throws(() => cipher.decryptBuffer(encrypted, {
    jobId: otherJobId, filename: 'report.json',
  }), /authentication|decrypt/i);
  assert.throws(() => cipher.decryptBuffer(encrypted, {
    jobId, filename: 'other.json',
  }), /authentication|decrypt/i);
});

test('cloud artifact decryption rejects tampered ciphertext and unknown key IDs', () => {
  const cipher = createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 64 * 1024 });
  const encrypted = cipher.encryptBuffer(randomBytes(100), { jobId, filename: 'tamper.bin' });
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => cipher.decryptBuffer(tampered, {
    jobId, filename: 'tamper.bin',
  }), /authentication|decrypt/i);

  const noOldKey = createCloudArtifactCipher({ keyRing: rotatedRing, chunkSize: 64 * 1024 });
  const header = Buffer.from(encrypted);
  header.write('0000000000000000', 8, 16, 'ascii');
  assert.throws(() => noOldKey.decryptBuffer(header, {
    jobId, filename: 'tamper.bin',
  }), /unknown|key/i);
});

test('cloud artifact directory encryption is atomic, recursive, idempotent and stream-readable', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cipher = createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 64 * 1024 });
  const jobDir = path.join(root, jobId);
  await mkdir(path.join(jobDir, 'screenshots'), { recursive: true });
  const video = randomBytes(210_000);
  const report = Buffer.from(JSON.stringify({ status: 'completed', title: 'private report' }));
  await writeFile(path.join(jobDir, 'tutorial.mp4'), video);
  await writeFile(path.join(jobDir, 'screenshots', 'step-1.png'), randomBytes(12_000));
  await writeFile(path.join(jobDir, 'report.json'), report);

  const first = await cipher.encryptDirectory(root, jobId);
  assert.equal(first.files, 3);
  assert.ok(first.encryptedBytes > first.plaintextBytes);
  const disk = await readFile(path.join(jobDir, 'tutorial.mp4'));
  assert.notDeepEqual(disk, video);
  assert.equal(disk.includes(video.subarray(0, 64)), false);

  const second = await cipher.encryptDirectory(root, jobId);
  assert.deepEqual(second, { files: 3, plaintextBytes: 0, encryptedBytes: first.encryptedBytes });

  const opened = await cipher.openReadStream(root, jobId, 'tutorial.mp4', 300_000);
  assert.equal(opened.size, video.length);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).compare(video), 0);

  assert.equal((await cipher.readFile(root, jobId, 'report.json', 4096)).compare(report), 0);
});

test('cloud artifact encryption refuses symlinks and hard-linked files', async t => {
  const root = await temp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cipher = createCloudArtifactCipher({ keyRing: oldRing });
  const jobDir = path.join(root, jobId);
  await mkdir(jobDir);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'must not be followed');
  await symlink(outside, path.join(jobDir, 'link.txt'));
  await assert.rejects(cipher.encryptDirectory(root, jobId), /symlink|regular file/i);

  await rm(path.join(jobDir, 'link.txt'));
  await link(outside, path.join(jobDir, 'hardlink.txt'));
  await assert.rejects(cipher.encryptDirectory(root, jobId), /hard link|link count/i);
});

test('cloud artifact key rotation retains old decryption keys and encrypts new files with the active key', () => {
  const oldCipher = createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 64 * 1024 });
  const oldCiphertext = oldCipher.encryptBuffer(Buffer.from('before rotation'), {
    jobId, filename: 'before.txt',
  });
  const rotatedCipher = createCloudArtifactCipher({ keyRing: rotatedRing, chunkSize: 64 * 1024 });
  assert.equal(rotatedCipher.decryptBuffer(oldCiphertext, {
    jobId, filename: 'before.txt',
  }).toString(), 'before rotation');

  const newCiphertext = rotatedCipher.encryptBuffer(Buffer.from('after rotation'), {
    jobId, filename: 'after.txt',
  });
  assert.equal(newCiphertext.toString('ascii', 8, 24), rotatedRing.activeKeyId);
  assert.equal(rotatedCipher.decryptBuffer(newCiphertext, {
    jobId, filename: 'after.txt',
  }).toString(), 'after rotation');
});

test('cloud artifact APIs validate key material, identities and plaintext size limits', () => {
  assert.throws(() => createCloudArtifactCipher({ keyRing: { activeKeyId: '0000000000000000', keys: {} } }), /key ring/i);
  assert.throws(() => createCloudArtifactCipher({ keyRing: oldRing, chunkSize: 1 }), /chunk size/i);
  const cipher = createCloudArtifactCipher({ keyRing: oldRing });
  assert.throws(() => cipher.encryptBuffer(Buffer.from('x'), { jobId: '../escape', filename: 'file' }), /identity/i);
  const encrypted = cipher.encryptBuffer(Buffer.from('too large'), { jobId, filename: 'file' });
  assert.throws(() => cipher.decryptBuffer(encrypted, { jobId, filename: 'file', maxBytes: 2 }), /size limit/i);
});
