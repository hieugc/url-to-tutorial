import test from 'node:test';
import assert from 'node:assert/strict';
import { createS3AuditArchiveSink } from '../src/cloud-audit-archive-s3.mjs';
import { createAuditArchiveScheduler } from '../src/cloud-audit-archive-scheduler.mjs';

class GetObjectCommand { constructor(input) { this.input = input; } }
class PutObjectCommand { constructor(input) { this.input = input; } }

class FakeS3 {
  constructor() { this.objects = new Map(); this.nextEtag = 1; this.putInputs = []; }
  async send(command) {
    const { Bucket, Key } = command.input;
    const id = Bucket + '/' + Key;
    if (command instanceof GetObjectCommand) {
      const row = this.objects.get(id);
      if (!row) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { ETag: row.etag, Body: { async transformToString() { return row.body; } } };
    }
    if (command instanceof PutObjectCommand) {
      this.putInputs.push(command.input);
      const current = this.objects.get(id);
      if (command.input.IfNoneMatch === '*' && current) {
        throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      }
      if (command.input.IfMatch && current?.etag !== command.input.IfMatch) {
        throw Object.assign(new Error('etag changed'), { name: 'PreconditionFailed' });
      }
      if (command.input.IfMatch && !current) {
        throw Object.assign(new Error('missing etag'), { name: 'PreconditionFailed' });
      }
      const etag = '"etag-' + this.nextEtag++ + '"';
      this.objects.set(id, { etag, body: command.input.Body });
      return { ETag: etag };
    }
    throw new Error('Unexpected S3 command');
  }
}

const emptyHash = '0'.repeat(64);
function batch({ previousSequence = 0, previousHash = emptyHash, sequences = [1, 2] } = {}) {
  let previousEventHash = previousHash;
  const events = sequences.map(sequence => {
    const eventHash = sequence.toString(16).padStart(64, '0');
    const event = { sequence, previousHash: previousEventHash, eventHash, action: 'job.completed' };
    previousEventHash = eventHash;
    return event;
  });
  return {
    previousSequence,
    previousHash,
    events,
    throughSequence: events.at(-1).sequence,
    throughHash: events.at(-1).eventHash,
  };
}

function sinkFor(client) {
  return createS3AuditArchiveSink({
    client,
    bucket: 'audit-archive-test',
    prefix: 'cloud/audit',
    replicaId: 'api-a',
    kmsKeyId: 'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-1234-1234-123456789012',
    retentionDays: 365,
    commands: { GetObjectCommand, PutObjectCommand },
  });
}

test('S3 audit archive appends immutable batch and advances checkpoint with exact acknowledgement', async () => {
  const client = new FakeS3();
  const sink = sinkFor(client);
  const result = await sink.archiveBatch(batch());
  assert.equal(result.throughSequence, 2);
  assert.equal(result.throughHash, batch().throughHash);
  assert.equal(client.objects.size, 3);
  const batchPut = [...client.objects.keys()].find(key => key.includes('/batches/'));
  assert.ok(batchPut);
  const immutablePut = client.putInputs.find(input => input.Key.includes('/batches/'));
  assert.equal(immutablePut.ServerSideEncryption, 'aws:kms');
  assert.equal(immutablePut.ObjectLockMode, 'COMPLIANCE');
  assert.ok(immutablePut.ObjectLockRetainUntilDate instanceof Date);

  const checkpoint = JSON.parse(client.objects.get(
    'audit-archive-test/cloud/audit/api-a/checkpoint.json',
  ).body);
  assert.equal(checkpoint.throughSequence, 2);
});

test('S3 audit archive retry is idempotent and does not rewrite immutable objects', async () => {
  const client = new FakeS3();
  const sink = sinkFor(client);
  const value = batch();
  const first = await sink.archiveBatch(value);
  const second = await sink.archiveBatch(value);
  assert.deepEqual(second, first);
  assert.equal(client.nextEtag, 4);
});

test('S3 audit archive refuses a batch that does not extend the external checkpoint', async () => {
  const client = new FakeS3();
  const sink = sinkFor(client);
  await sink.archiveBatch(batch());
  await assert.rejects(sink.archiveBatch(batch({
    previousSequence: 1,
    previousHash: 'f'.repeat(64),
    sequences: [2],
  })), /checkpoint does not match/i);
});

test('S3 audit archive rejects gaps and a mismatched final hash before writing', async () => {
  const client = new FakeS3();
  const sink = sinkFor(client);
  const value = batch({ sequences: [1, 3] });
  await assert.rejects(sink.archiveBatch(value), /contiguous/i);
  assert.equal(client.objects.size, 0);
  const wrongHash = batch();
  wrongHash.throughHash = 'f'.repeat(64);
  await assert.rejects(sink.archiveBatch(wrongHash), /final checkpoint/i);
});

test('S3 audit archive refuses to overwrite an existing batch key with different content', async () => {
  const client = new FakeS3();
  const sink = sinkFor(client);
  await sink.archiveBatch(batch());
  const conflicting = batch();
  conflicting.events[0].action = 'tampered';
  await assert.rejects(sink.archiveBatch(conflicting), /immutable archive batch conflict/i);
});

test('S3 archive requires KMS encryption and bounded compliance retention configuration', () => {
  const base = {
    client: new FakeS3(), bucket: 'audit-archive-test', replicaId: 'api-a',
    commands: { GetObjectCommand, PutObjectCommand },
  };
  assert.throws(() => createS3AuditArchiveSink(base), /KMS key/i);
  assert.throws(() => createS3AuditArchiveSink({
    ...base, kmsKeyId: 'alias/audit-key', retentionDays: 0,
  }), /retentionDays/i);
});

test('archive scheduler drains bounded batches and stops when the archive is caught up', async () => {
  const sizes = [2, 2, 0];
  const scheduler = createAuditArchiveScheduler({
    batchLimit: 2,
    maxBatchesPerRun: 5,
    archiveBatch: async () => ({ archived: sizes.shift() }),
  });
  const result = await scheduler.runOnce();
  assert.equal(result.batches, 3);
  assert.equal(result.archived, 4);
  assert.equal(sizes.length, 0);
});

test('archive scheduler coalesces overlapping runs and never executes concurrent archive loops', async () => {
  let release;
  let active = 0;
  let maximum = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const scheduler = createAuditArchiveScheduler({
    archiveBatch: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return { archived: 0 };
    },
  });
  const first = scheduler.runOnce();
  const second = scheduler.runOnce();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
});

test('archive scheduler validates bounds and reports scheduled failures without crashing the timer', async () => {
  assert.throws(() => createAuditArchiveScheduler({ archiveBatch: async () => {}, intervalMs: 1 }), /interval/i);
  const errors = [];
  const scheduler = createAuditArchiveScheduler({
    archiveBatch: async () => { throw new Error('archive offline'); },
    onError: error => errors.push(error.message),
  });
  await scheduler.tick();
  assert.deepEqual(errors, ['archive offline']);
});
