import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const VERSION = /^(0|[1-9][0-9]{0,127})$/;
const ROLLOUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(name + ' is required');
  }
  return value;
}

function normalizeFingerprint(value, name = 'certificate fingerprint') {
  if (typeof value !== 'string') throw new TypeError('Invalid ' + name);
  const normalized = value.replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError('Invalid ' + name);
  return normalized;
}

function safeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.secretVersion !== 'string' || !VERSION.test(value.secretVersion) ||
      !Array.isArray(value.tokenIds) ||
      value.tokenIds.some(id => typeof id !== 'string' || !IDENTIFIER.test(id))) {
    throw new TypeError('Replica status contains invalid or unsafe metadata');
  }
  const ring = value.auditKeyRing;
  if (!ring || typeof ring !== 'object' ||
      typeof ring.activeKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(ring.activeKeyId) ||
      !Array.isArray(ring.keyIds) ||
      ring.keyIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) ||
      !ring.keyIds.includes(ring.activeKeyId)) {
    throw new TypeError('Replica status contains invalid audit key metadata');
  }
  return Object.freeze({
    secretVersion: value.secretVersion,
    tokenIds: Object.freeze([...new Set(value.tokenIds)].sort()),
    auditKeyRing: Object.freeze({
      activeKeyId: ring.activeKeyId,
      keyIds: Object.freeze([...new Set(ring.keyIds)].sort()),
    }),
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (contentType !== 'application/json') {
    throw Object.assign(new Error('Expected application/json'), { statusCode: 415 });
  }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) {
    throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw Object.assign(new Error('Expected a JSON object'), { statusCode: 400 });
  }
  return parsed;
}

function validateServerBinding(host) {
  requireText(host, 'A private replica bind host');
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    throw new TypeError('Replica RPC server must bind to an explicit private interface, not a wildcard');
  }
  return host;
}

function peerFingerprint(req) {
  const certificate = req.socket.getPeerCertificate();
  if (!req.socket.authorized || !certificate?.raw) return null;
  return normalizeFingerprint(certificate.fingerprint256);
}

/**
 * Starts a private mTLS-only replica RPC server. The caller supplies a TLS
 * CA, server identity, explicit client-certificate fingerprint allowlist,
 * and the local MFA/assertion-verifying reloadTokens capability.
 */
export function createMtlsReplicaServer({
  key,
  cert,
  ca,
  replicaId,
  allowedClientFingerprints,
  reloadTokens,
  status,
  host = '127.0.0.1',
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  requireText(key, 'TLS server private key');
  requireText(cert, 'TLS server certificate');
  requireText(ca, 'Trusted client CA');
  if (typeof replicaId !== 'string' || !IDENTIFIER.test(replicaId)) {
    throw new TypeError('A valid replica ID is required');
  }
  if (!Array.isArray(allowedClientFingerprints) || allowedClientFingerprints.length === 0) {
    throw new TypeError('An explicit client certificate fingerprint allowlist is required');
  }
  const allowed = new Set(allowedClientFingerprints.map(value => normalizeFingerprint(value)));
  if (typeof reloadTokens !== 'function' || typeof status !== 'function') {
    throw new TypeError('Replica reloadTokens and status capabilities are required');
  }
  validateServerBinding(host);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > MAX_BODY_BYTES) {
    throw new TypeError('Replica RPC body limit must be between 256 bytes and 16 KiB');
  }

  const server = https.createServer({
    key, cert, ca, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.2', maxHeaderSize: 8 * 1024,
  }, async (req, res) => {
    try {
      const fingerprint = peerFingerprint(req);
      if (!fingerprint || !allowed.has(fingerprint)) {
        return sendJson(res, 403, { error: 'Replica client certificate is not authorized' });
      }
      const url = new URL(req.url || '/', 'https://replica.internal');
      const match = url.pathname.match(/^\/internal\/replicas\/([A-Za-z0-9_.:@-]{1,128})\/(status|reload)$/);
      if (url.search || url.hash || !match || match[1] !== replicaId) {
        return sendJson(res, 404, { error: 'Unknown replica RPC route' });
      }
      if (req.method === 'GET' && match[2] === 'status') {
        const current = safeStatus(await status());
        return sendJson(res, 200, current);
      }
      if (req.method !== 'POST' || match[2] !== 'reload') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      const body = await readJson(req, maxBodyBytes);
      const keys = Object.keys(body);
      if (keys.some(key => !['assertion', 'expectedVersion', 'rolloutId', 'replicaId'].includes(key)) ||
          typeof body.assertion !== 'string' || body.assertion.length < 16 ||
          body.assertion.length > 16_384 ||
          typeof body.expectedVersion !== 'string' || !VERSION.test(body.expectedVersion) ||
          typeof body.rolloutId !== 'string' || !ROLLOUT_ID.test(body.rolloutId) ||
          body.replicaId !== replicaId) {
        return sendJson(res, 400, { error: 'Invalid replica reload request' });
      }

      await reloadTokens(body.assertion, {
        expectedVersion: body.expectedVersion,
        rolloutId: body.rolloutId,
        replicaId,
      });
      return sendJson(res, 200, safeStatus(await status()));
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) &&
        [400, 413, 415].includes(error.statusCode) ? error.statusCode : 500;
      return sendJson(res, statusCode, {
        error: statusCode === 500 ? 'Replica RPC operation failed' : error.message,
      });
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  return Object.freeze({
    server,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  });
}

/**
 * Creates an mTLS client adapter compatible with cloud-rollout replicaDirectory.
 * TLS certificate validation is mandatory; an optional SHA-256 server pin can
 * further bind the client to the expected replica endpoint.
 */
export function createMtlsReplicaClient({
  id,
  url,
  ca,
  cert,
  key,
  expectedServerFingerprint,
  timeoutMs = 10_000,
} = {}) {
  if (typeof id !== 'string' || !IDENTIFIER.test(id)) throw new TypeError('A valid replica ID is required');
  requireText(ca, 'Trusted replica server CA');
  requireText(cert, 'TLS client certificate');
  requireText(key, 'TLS client private key');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('Replica RPC timeout must be between 100 ms and 60 seconds');
  }
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new TypeError('A valid HTTPS replica URL is required'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname) ||
      isIP(endpoint.hostname) && !expectedServerFingerprint) {
    throw new TypeError('Replica RPC URL must be HTTPS without credentials/query; IP endpoints require a certificate pin');
  }
  const pin = expectedServerFingerprint === undefined
    ? null : normalizeFingerprint(expectedServerFingerprint, 'server certificate fingerprint');

  function request(method, route, payload) {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
      const req = https.request({
        protocol: 'https:',
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        method,
        path: route,
        ca, cert, key,
        servername: endpoint.hostname,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        checkServerIdentity(hostname, certificate) {
          const error = tls.checkServerIdentity(hostname, certificate);
          if (error) return error;
          if (pin && normalizeFingerprint(certificate.fingerprint256) !== pin) {
            return new Error('Replica server certificate fingerprint mismatch');
          }
          return undefined;
        },
        agent: false,
        headers: body ? {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        } : {},
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Replica RPC response exceeds size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            return reject(new Error('Replica RPC returned HTTP ' + response.statusCode));
          }
          try {
            resolve(safeStatus(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            reject(new Error('Replica RPC returned an invalid status response'));
          }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Replica RPC timed out')));
      req.on('error', error => reject(
        error.message === 'Replica server certificate fingerprint mismatch'
          ? error : new Error('Replica RPC transport failed'),
      ));
      if (body) req.write(body);
      req.end();
    });
  }

  return Object.freeze({
    id,
    status() {
      return request('GET', '/internal/replicas/' + encodeURIComponent(id) + '/status');
    },
    reloadTokens(assertion, options = {}) {
      if (typeof assertion !== 'string' || assertion.length < 16 || assertion.length > 16_384) {
        throw new TypeError('A valid signed replica assertion is required');
      }
      if (!options || typeof options !== 'object' || Array.isArray(options) ||
          options.replicaId !== id || typeof options.expectedVersion !== 'string' ||
          !VERSION.test(options.expectedVersion) ||
          typeof options.rolloutId !== 'string' || !ROLLOUT_ID.test(options.rolloutId) ||
          Object.keys(options).some(key => !['expectedVersion', 'rolloutId', 'replicaId'].includes(key))) {
        throw new TypeError('Replica reload constraints do not match this client identity');
      }
      return request('POST', '/internal/replicas/' + encodeURIComponent(id) + '/reload', {
        assertion,
        expectedVersion: options.expectedVersion,
        rolloutId: options.rolloutId,
        replicaId: id,
      });
    },
  });
}
