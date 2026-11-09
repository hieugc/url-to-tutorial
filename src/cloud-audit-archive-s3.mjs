const EMPTY_HASH = '0'.repeat(64);
const REPLICA_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

function isMissing(error) {
  return ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(error?.name) ||
    error?.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailure(error) {
  return ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name) ||
    error?.$metadata?.httpStatusCode === 412;
}

async function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body && typeof body.transformToString === 'function') return body.transformToString();
  if (body && Symbol.asyncIterator in Object(body)) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('S3 audit archive returned an unreadable object body');
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) ||
      !Number.isSafeInteger(batch.previousSequence) || batch.previousSequence < 0 ||
      !HASH.test(batch.previousHash || '') ||
      !Array.isArray(batch.events) || batch.events.length < 1 ||
      !Number.isSafeInteger(batch.throughSequence) ||
      !HASH.test(batch.throughHash || '')) {
    throw new TypeError('Audit archive batch metadata is invalid');
  }
  let expectedSequence = batch.previousSequence + 1;
  let previousHash = batch.previousHash;
  for (const event of batch.events) {
    if (!event || event.sequence !== expectedSequence ||
        event.previousHash !== previousHash || !HASH.test(event.eventHash || '')) {
      throw new Error('Audit archive events are not a contiguous verified chain');
    }
    previousHash = event.eventHash;
    expectedSequence++;
  }
  const last = batch.events.at(-1);
  if (last.sequence !== batch.throughSequence || last.eventHash !== batch.throughHash) {
    throw new Error('Audit archive final checkpoint does not match the batch events');
  }
}

export function createS3AuditArchiveSink({
  client,
  bucket,
  prefix = 'url-to-tutorial/audit',
  replicaId,
  kmsKeyId,
  retentionDays = 365,
  commands,
  now = () => new Date().toISOString(),
} = {}) {
  if (!client || typeof client.send !== 'function') throw new TypeError('An AWS SDK v3 S3 client is required');
  if (!commands || typeof commands.GetObjectCommand !== 'function' ||
      typeof commands.PutObjectCommand !== 'function') {
    throw new TypeError('S3 GetObjectCommand and PutObjectCommand constructors are required');
  }
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new TypeError('A valid S3 bucket name is required');
  }
  if (typeof replicaId !== 'string' || !REPLICA_ID.test(replicaId)) {
    throw new TypeError('A valid replica ID is required for audit archive isolation');
  }
  if (typeof prefix !== 'string' || prefix.length > 512 ||
      prefix.split('/').some(part => part === '.' || part === '..') ||
      !/^[A-Za-z0-9][A-Za-z0-9_.!*/-]*$/.test(prefix)) {
    throw new TypeError('A valid S3 audit archive prefix is required');
  }
  if (typeof kmsKeyId !== 'string' || !kmsKeyId.trim() || kmsKeyId.length > 2048) {
    throw new TypeError('An AWS KMS key ID or ARN is required for audit archive encryption');
  }
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new TypeError('Audit archive retentionDays must be between 1 and 3650');
  }
  if (typeof now !== 'function') throw new TypeError('Audit archive clock must be a function');

  const root = [prefix.replace(/\/+$/, ''), replicaId].filter(Boolean).join('/');
  const checkpointKey = root + '/checkpoint.json';

  async function readObject(key) {
    try {
      const response = await client.send(new commands.GetObjectCommand({ Bucket: bucket, Key: key }));
      return { body: await bodyText(response.Body), etag: response.ETag };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error('S3 audit archive read failed');
    }
  }

  async function putImmutable(key, body, retainUntil) {
    try {
      await client.send(new commands.PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId, BucketKeyEnabled: true,
        ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retainUntil,
        IfNoneMatch: '*',
      }));
      return;
    } catch (error) {
      if (!isPreconditionFailure(error)) throw new Error('S3 audit archive batch write failed');
    }
    const existing = await readObject(key);
    if (!existing || existing.body !== body) {
      throw new Error('S3 immutable archive batch conflict');
    }
  }

  async function archiveBatch(batch) {
    validateBatch(batch);
    const checkpointObject = await readObject(checkpointKey);
    let checkpoint = { throughSequence: 0, throughHash: EMPTY_HASH };
    if (checkpointObject) {
      try { checkpoint = JSON.parse(checkpointObject.body); }
      catch { throw new Error('S3 audit archive checkpoint is malformed'); }
      if (!Number.isSafeInteger(checkpoint.throughSequence) || checkpoint.throughSequence < 0 ||
          !HASH.test(checkpoint.throughHash || '') || typeof checkpointObject.etag !== 'string') {
        throw new Error('S3 audit archive checkpoint is invalid');
      }
    }

    if (checkpoint.throughSequence === batch.throughSequence &&
        checkpoint.throughHash === batch.throughHash) {
      return { throughSequence: batch.throughSequence, throughHash: batch.throughHash };
    }
    if (checkpoint.throughSequence !== batch.previousSequence ||
        checkpoint.throughHash !== batch.previousHash) {
      throw new Error('S3 audit archive checkpoint does not match the batch predecessor');
    }

    const first = String(batch.events[0].sequence).padStart(20, '0');
    const last = String(batch.throughSequence).padStart(20, '0');
    const batchKey = root + '/batches/' + first + '-' + last + '-' + batch.throughHash + '.json';
    const batchBody = JSON.stringify({
      schemaVersion: 1,
      replicaId,
      previousSequence: batch.previousSequence,
      previousHash: batch.previousHash,
      throughSequence: batch.throughSequence,
      throughHash: batch.throughHash,
      events: batch.events,
    });
    const archivedAt = now();
    const archivedAtMs = Date.parse(archivedAt);
    if (!Number.isFinite(archivedAtMs)) throw new Error('Audit archive clock returned an invalid timestamp');
    const retainUntil = new Date(archivedAtMs + retentionDays * 24 * 60 * 60_000);
    await putImmutable(batchKey, batchBody, retainUntil);

    const nextCheckpoint = JSON.stringify({
      schemaVersion: 1,
      replicaId,
      throughSequence: batch.throughSequence,
      throughHash: batch.throughHash,
      batchKey,
      archivedAt,
    });
    const input = {
      Bucket: bucket,
      Key: checkpointKey,
      Body: nextCheckpoint,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId, BucketKeyEnabled: true,
      ...(checkpointObject ? { IfMatch: checkpointObject.etag } : { IfNoneMatch: '*' }),
    };
    try {
      await client.send(new commands.PutObjectCommand(input));
    } catch (error) {
      if (!isPreconditionFailure(error)) throw new Error('S3 audit archive checkpoint write failed');
      const latest = await readObject(checkpointKey);
      if (latest) {
        try {
          const value = JSON.parse(latest.body);
          if (value.throughSequence === batch.throughSequence &&
              value.throughHash === batch.throughHash) {
            return { throughSequence: batch.throughSequence, throughHash: batch.throughHash };
          }
        } catch {}
      }
      throw new Error('S3 audit archive checkpoint changed concurrently; retry from the new checkpoint');
    }
    return { throughSequence: batch.throughSequence, throughHash: batch.throughHash };
  }

  return Object.freeze({ archiveBatch, bucket, prefix: root });
}
