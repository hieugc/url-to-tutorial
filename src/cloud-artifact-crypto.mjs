import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const MAGIC = Buffer.from('UTVART01', 'ascii');
const HEADER_BYTES = 36;
const RECORD_OVERHEAD = 32;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MIN_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
const JOB_ID = /^[a-f0-9-]{36}$/i;

function validateJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new TypeError('Cloud artifact identity requires a UUID job ID');
  }
}

function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 1024 ||
      filename.includes('\0') || path.posix.isAbsolute(filename) ||
      path.win32.isAbsolute(filename)) {
    throw new TypeError('Cloud artifact identity requires a relative artifact path');
  }
  const normalized = filename.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('Cloud artifact identity contains an unsafe path segment');
  }
  return normalized;
}

function validateKeyRing(keyRing) {
  if (!keyRing || typeof keyRing !== 'object' || Array.isArray(keyRing) ||
      Object.getPrototypeOf(keyRing) !== Object.prototype ||
      Object.keys(keyRing).some(key => !['activeKeyId', 'keys'].includes(key)) ||
      typeof keyRing.activeKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(keyRing.activeKeyId) ||
      !keyRing.keys || typeof keyRing.keys !== 'object' || Array.isArray(keyRing.keys) ||
      Object.getPrototypeOf(keyRing.keys) !== Object.prototype) {
    throw new TypeError('A versioned cloud artifact encryption key ring is required');
  }
  const ids = Object.keys(keyRing.keys).sort();
  if (!ids.length || ids.length > 32 || !ids.includes(keyRing.activeKeyId)) {
    throw new TypeError('Cloud artifact key ring must include its active key and at most 32 keys');
  }
  const keys = new Map();
  for (const id of ids) {
    const value = keyRing.keys[id];
    if (!/^[a-f0-9]{16}$/.test(id) || typeof value !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value)) {
      throw new TypeError('Cloud artifact keys must be 32-byte lowercase hex values keyed by fingerprint');
    }
    const material = Buffer.from(value, 'hex');
    if (createHash('sha256').update(material).digest('hex').slice(0, 16) !== id) {
      throw new TypeError('Cloud artifact key fingerprint does not match its key material');
    }
    keys.set(id, material);
  }
  return { activeKeyId: keyRing.activeKeyId, keys };
}

function validateChunkSize(value) {
  if (!Number.isSafeInteger(value) || value < MIN_CHUNK_SIZE || value > MAX_CHUNK_SIZE) {
    throw new TypeError('Cloud artifact chunk size must be between 64 KiB and 4 MiB');
  }
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('Cloud artifact encryption context is required');
  }
  validateJobId(context.jobId);
  return {
    jobId: context.jobId,
    filename: validateFilename(context.filename),
  };
}

function associatedData({ jobId, filename }, chunkIndex, plainSize, keyId) {
  return Buffer.from([
    jobId, filename, String(chunkIndex), String(plainSize), keyId,
  ].join('\0'), 'utf8');
}

function createHeader(keyId, plainSize, chunkSize) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.write(keyId, 8, 16, 'ascii');
  header.writeBigUInt64BE(BigInt(plainSize), 24);
  header.writeUInt32BE(chunkSize, 32);
  return header;
}

function parseHeader(header, encryptedSize, keys, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (!Buffer.isBuffer(header) || header.length !== HEADER_BYTES ||
      !header.subarray(0, 8).equals(MAGIC)) {
    throw new Error('Cloud artifact is not encrypted with the supported format');
  }
  const keyId = header.toString('ascii', 8, 24);
  const key = keys.get(keyId);
  if (!key) throw new Error('Cloud artifact references an unknown encryption key');
  const plainSizeBig = header.readBigUInt64BE(24);
  if (plainSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Cloud artifact plaintext size is invalid');
  }
  const plainSize = Number(plainSizeBig);
  const chunkSize = header.readUInt32BE(32);
  validateChunkSize(chunkSize);
  if (plainSize > maxBytes) throw new Error('Cloud artifact exceeds its plaintext size limit');
  const chunkCount = Math.ceil(plainSize / chunkSize);
  const expectedSize = HEADER_BYTES + plainSize + chunkCount * RECORD_OVERHEAD;
  if (!Number.isSafeInteger(expectedSize) || encryptedSize !== expectedSize) {
    throw new Error('Cloud artifact encrypted length is invalid');
  }
  return { keyId, key, plainSize, chunkSize, chunkCount };
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Cloud artifact ended before its authenticated record');
    offset += bytesRead;
  }
  return buffer;
}

async function writeExactly(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new Error('Cloud artifact write made no progress');
    offset += bytesWritten;
  }
}

function encryptChunk(plain, key, context, chunkIndex, plainSize, keyId) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(context, chunkIndex, plainSize, keyId));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const record = Buffer.alloc(4 + 12 + 16);
  record.writeUInt32BE(plain.length, 0);
  nonce.copy(record, 4);
  cipher.getAuthTag().copy(record, 16);
  return Buffer.concat([record, encrypted]);
}

function decryptChunk(record, encrypted, key, context, chunkIndex, plainSize, keyId) {
  const length = record.readUInt32BE(0);
  if (length !== encrypted.length) throw new Error('Cloud artifact chunk length is invalid');
  const nonce = record.subarray(4, 16);
  const tag = record.subarray(16, 32);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData(context, chunkIndex, plainSize, keyId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error('Cloud artifact authentication failed');
  }
}

export function createCloudArtifactCipher({
  keyRing,
  chunkSize = DEFAULT_CHUNK_SIZE,
} = {}) {
  const ring = validateKeyRing(keyRing);
  validateChunkSize(chunkSize);

  function encryptBuffer(value, rawContext) {
    const context = validateContext(rawContext);
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError('Cloud artifact plaintext must be a Buffer or Uint8Array');
    }
    const plain = Buffer.from(value);
    const parts = [createHeader(ring.activeKeyId, plain.length, chunkSize)];
    let index = 0;
    for (let offset = 0; offset < plain.length; offset += chunkSize) {
      parts.push(encryptChunk(
        plain.subarray(offset, Math.min(plain.length, offset + chunkSize)),
        ring.keys.get(ring.activeKeyId), context, index++, plain.length, ring.activeKeyId,
      ));
    }
    return Buffer.concat(parts);
  }

  function decryptBuffer(value, rawContext, maxBytes = Number.MAX_SAFE_INTEGER) {
    const context = validateContext(rawContext);
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError('Cloud artifact ciphertext must be a Buffer or Uint8Array');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('Cloud artifact plaintext size limit must be a non-negative safe integer');
    }
    const encrypted = Buffer.from(value);
    const parsed = parseHeader(encrypted.subarray(0, HEADER_BYTES), encrypted.length, ring.keys, maxBytes);
    const output = [];
    let position = HEADER_BYTES;
    let remaining = parsed.plainSize;
    for (let index = 0; index < parsed.chunkCount; index++) {
      const expectedLength = Math.min(parsed.chunkSize, remaining);
      const record = encrypted.subarray(position, position + 32);
      if (record.length !== 32 || record.readUInt32BE(0) !== expectedLength) {
        throw new Error('Cloud artifact authenticated record is invalid');
      }
      position += 32;
      const ciphertext = encrypted.subarray(position, position + expectedLength);
      if (ciphertext.length !== expectedLength) throw new Error('Cloud artifact is truncated');
      position += expectedLength;
      output.push(decryptChunk(
        record, ciphertext, parsed.key, context, index, parsed.plainSize, parsed.keyId,
      ));
      remaining -= expectedLength;
    }
    if (position !== encrypted.length || remaining !== 0) {
      throw new Error('Cloud artifact contains trailing or missing data');
    }
    return Buffer.concat(output, parsed.plainSize);
  }

  async function encryptFile(filePath, context) {
    const source = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let temporaryPath;
    let destination;
    try {
      const info = await source.stat();
      if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size)) {
        throw new Error('Cloud artifact must be a single-link regular file');
      }
      if (info.size > Number.MAX_SAFE_INTEGER - HEADER_BYTES) {
        throw new Error('Cloud artifact plaintext size is invalid');
      }
      const prefix = await readExactly(source, Math.min(8, info.size), 0).catch(error => {
        if (info.size === 0) return Buffer.alloc(0);
        throw error;
      });
      if (prefix.equals(MAGIC)) {
        const header = Buffer.concat([prefix, await readExactly(source, HEADER_BYTES - prefix.length, prefix.length)]);
        const parsed = parseHeader(header, info.size, ring.keys);
        return { plaintextBytes: 0, encryptedBytes: info.size, alreadyEncrypted: true, keyId: parsed.keyId };
      }

      const relative = context.filename;
      const header = createHeader(ring.activeKeyId, info.size, chunkSize);
      temporaryPath = path.join(path.dirname(filePath), '.utv-artifact-' + randomUUID() + '.tmp');
      destination = await open(temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600);
      await writeExactly(destination, header);
      let position = 0;
      let chunkIndex = 0;
      while (position < info.size) {
        const length = Math.min(chunkSize, info.size - position);
        const plain = await readExactly(source, length, position);
        await writeExactly(destination, encryptChunk(
          plain, ring.keys.get(ring.activeKeyId),
          { jobId: context.jobId, filename: relative },
          chunkIndex++, info.size, ring.activeKeyId,
        ));
        position += length;
      }
      const after = await source.stat();
      const currentPathInfo = await lstat(filePath);
      if (after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev ||
          currentPathInfo.isSymbolicLink() || currentPathInfo.ino !== info.ino ||
          currentPathInfo.dev !== info.dev) {
        throw new Error('Cloud artifact changed while it was being encrypted');
      }
      await destination.sync();
      await destination.close();
      destination = null;
      await source.close();
      await rename(temporaryPath, filePath);
      temporaryPath = null;
      const parent = await open(path.dirname(filePath), fsConstants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      const encryptedInfo = await lstat(filePath);
      return {
        plaintextBytes: info.size,
        encryptedBytes: encryptedInfo.size,
        alreadyEncrypted: false,
        keyId: ring.activeKeyId,
      };
    } finally {
      await destination?.close().catch(() => {});
      await source.close().catch(() => {});
      if (temporaryPath) await unlink(temporaryPath).catch(() => {});
    }
  }

  async function encryptDirectory(outputRoot, jobId) {
    validateJobId(jobId);
    const root = path.resolve(outputRoot);
    let rootInfo;
    try { rootInfo = await lstat(root); }
    catch (error) { if (error.code === 'ENOENT') return { files: 0, plaintextBytes: 0, encryptedBytes: 0 }; throw error; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('Cloud artifact output root must be a real directory');
    }
    const jobDir = path.join(root, jobId);
    let jobInfo;
    try { jobInfo = await lstat(jobDir); }
    catch (error) { if (error.code === 'ENOENT') return { files: 0, plaintextBytes: 0, encryptedBytes: 0 }; throw error; }
    if (!jobInfo.isDirectory() || jobInfo.isSymbolicLink()) {
      throw new Error('Cloud artifact job output must be a real directory');
    }
    const totals = { files: 0, plaintextBytes: 0, encryptedBytes: 0 };

    async function walk(directory, relativeDirectory) {
      for (const name of await readdir(directory)) {
        const fullPath = path.join(directory, name);
        const relative = relativeDirectory ? relativeDirectory + '/' + name : name;
        if (/^\.utv-artifact-[a-f0-9-]{36}\.tmp$/.test(name)) {
          const temporary = await lstat(fullPath);
          if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1) {
            throw new Error('Cloud artifact temporary path is unsafe');
          }
          await unlink(fullPath);
          continue;
        }
        const info = await lstat(fullPath);
        if (info.isSymbolicLink()) throw new Error('Cloud artifact directory contains a symlink');
        if (info.isDirectory()) {
          await walk(fullPath, relative);
          continue;
        }
        if (!info.isFile() || info.nlink !== 1) {
          throw new Error('Cloud artifact must be a single-link regular file');
        }
        validateFilename(relative);
        const result = await encryptFile(fullPath, { jobId, filename: relative });
        totals.files++;
        totals.plaintextBytes += result.plaintextBytes;
        totals.encryptedBytes += result.encryptedBytes;
      }
    }

    await walk(jobDir, '');
    return totals;
  }

  async function openReadStream(outputRoot, jobId, filename, maxBytes = Number.MAX_SAFE_INTEGER) {
    validateJobId(jobId);
    const relative = validateFilename(filename);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('Cloud artifact plaintext size limit must be a non-negative safe integer');
    }
    const root = path.resolve(outputRoot);
    const rootInfo = await lstat(root);
    const jobDir = path.join(root, jobId);
    const jobInfo = await lstat(jobDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
        !jobInfo.isDirectory() || jobInfo.isSymbolicLink()) {
      throw new Error('Cloud artifact output directory is unsafe');
    }
    const filePath = path.join(jobDir, ...relative.split('/'));
    const file = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error('Cloud artifact must be a single-link regular file');
      }
      const header = await readExactly(file, HEADER_BYTES, 0);
      const parsed = parseHeader(header, info.size, ring.keys, maxBytes);
      const context = { jobId, filename: relative };
      async function* plaintextChunks() {
        let position = HEADER_BYTES;
        let remaining = parsed.plainSize;
        try {
          for (let index = 0; index < parsed.chunkCount; index++) {
            const expectedLength = Math.min(parsed.chunkSize, remaining);
            const record = await readExactly(file, 32, position);
            if (record.readUInt32BE(0) !== expectedLength) {
              throw new Error('Cloud artifact authenticated record is invalid');
            }
            position += 32;
            const ciphertext = await readExactly(file, expectedLength, position);
            position += expectedLength;
            yield decryptChunk(
              record, ciphertext, parsed.key, context, index, parsed.plainSize, parsed.keyId,
            );
            remaining -= expectedLength;
          }
          if (remaining !== 0 || position !== info.size) {
            throw new Error('Cloud artifact contains trailing or missing data');
          }
        } finally {
          await file.close().catch(() => {});
        }
      }
      return { stream: Readable.from(plaintextChunks()), size: parsed.plainSize };
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  }

  async function readFile(outputRoot, jobId, filename, maxBytes) {
    const opened = await openReadStream(outputRoot, jobId, filename, maxBytes);
    const chunks = [];
    let total = 0;
    for await (const chunk of opened.stream) {
      total += chunk.length;
      if (total > opened.size || total > maxBytes) {
        opened.stream.destroy();
        throw new Error('Cloud artifact exceeds its plaintext size limit');
      }
      chunks.push(chunk);
    }
    if (total !== opened.size) throw new Error('Cloud artifact plaintext length is invalid');
    return Buffer.concat(chunks, total);
  }

  return Object.freeze({
    activeKeyId: ring.activeKeyId,
    keyMetadata: () => Object.freeze({
      activeKeyId: ring.activeKeyId,
      keyIds: Object.freeze([...ring.keys.keys()].sort()),
    }),
    encryptBuffer,
    decryptBuffer,
    encryptDirectory,
    openReadStream,
    readFile,
  });
}
