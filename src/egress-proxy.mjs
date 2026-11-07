import { createServer, connect as tcpConnect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { isBlockedIp } from './cloud-egress.mjs';

const HEADER_END = Buffer.from('\r\n\r\n');
const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.internal', '.test', '.invalid', '.example',
  '.onion', '.home.arpa',
];

function response(socket, status, reason, message) {
  if (socket.destroyed) return;
  const body = message + '\n';
  socket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}

function publicHostname(input) {
  if (typeof input !== 'string' || !input || input.endsWith('.') ||
      input.includes('%') || input.includes('@') || input.includes('/') ||
      input.includes('[') || input.includes(']')) return null;
  if (isIP(input)) return null; // IP literals are deliberately not accepted.
  const host = domainToASCII(input.toLowerCase());
  if (!host || host.length > 253 || !host.includes('.')) return null;
  const labels = host.split('.');
  if (labels.some(label => !label || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) return null;
  return host;
}

function parseConnectRequest(raw) {
  const lines = raw.split('\r\n');
  const first = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift() || '');
  if (!first) return { error: [405, 'Method Not Allowed', 'Only HTTPS CONNECT is supported'] };

  const authority = /^([^:]+):([0-9]{1,5})$/.exec(first[1]);
  if (!authority) return { error: [400, 'Bad Request', 'Invalid CONNECT authority'] };
  const host = publicHostname(authority[1]);
  const port = Number(authority[2]);
  if (!host || !Number.isInteger(port) || port !== 443) {
    return { error: [403, 'Forbidden', 'Only public HTTPS destinations on port 443 are allowed'] };
  }

  const headers = new Map();
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) return { error: [400, 'Bad Request', 'Folded headers are not supported'] };
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
    if (!match) return { error: [400, 'Bad Request', 'Malformed proxy header'] };
    const key = match[1].toLowerCase();
    if (headers.has(key)) return { error: [400, 'Bad Request', 'Duplicate proxy header'] };
    headers.set(key, match[2].trim());
  }
  const hostHeader = headers.get('host');
  if (!hostHeader || ![host, host + ':443'].includes(hostHeader.toLowerCase())) {
    return { error: [400, 'Bad Request', 'Host header must match CONNECT authority'] };
  }
  if (Number(headers.get('content-length') || 0) > 0 || headers.has('transfer-encoding') ||
      headers.has('upgrade')) {
    return { error: [400, 'Bad Request', 'CONNECT request bodies and upgrades are not supported'] };
  }
  return { host, port };
}

/**
 * A strict HTTPS CONNECT proxy. It resolves each hostname once, rejects the
 * entire answer set if any address is non-public, and connects directly to the
 * selected resolved IP (never resolving the hostname a second time). Browser
 * redirects, frames and subresources must all traverse this proxy.
 *
 * This proxy is only a network boundary when workers are attached to an
 * internal-only network that has no other internet route.
 */
export function createEgressProxyServer({
  resolve = lookup,
  connect = tcpConnect,
  blockedIp = isBlockedIp,
  maxConnections = 64,
  maxHeaderBytes = 8192,
  connectTimeoutMs = 10000,
  idleTimeoutMs = 120000,
} = {}) {
  for (const [name, value] of Object.entries({
    maxConnections, maxHeaderBytes, connectTimeoutMs, idleTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + ' must be a positive safe integer');
  }

  const clients = new Set();
  const upstreams = new Set();
  const server = createServer(client => {
    if (clients.size >= maxConnections) {
      response(client, 503, 'Service Unavailable', 'Proxy connection limit reached');
      return;
    }
    clients.add(client);
    client.setNoDelay(true);
    client.setTimeout(connectTimeoutMs, () => client.destroy());
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));

    let received = Buffer.alloc(0);
    let parsing = true;
    const onHeader = chunk => {
      if (!parsing) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > maxHeaderBytes) {
        parsing = false;
        client.removeListener('data', onHeader);
        response(client, 431, 'Request Header Fields Too Large', 'Proxy request headers are too large');
        return;
      }
      const end = received.indexOf(HEADER_END);
      if (end < 0) return;
      parsing = false;
      client.removeListener('data', onHeader);
      client.pause();
      const raw = received.subarray(0, end).toString('latin1');
      const remainder = received.subarray(end + HEADER_END.length);
      const request = parseConnectRequest(raw);
      if (request.error) {
        response(client, ...request.error);
        return;
      }

      void (async () => {
        let addresses;
        try {
          addresses = await resolve(request.host, { all: true, verbatim: true });
        } catch {
          response(client, 502, 'Bad Gateway', 'Destination DNS resolution failed');
          return;
        }
        if (client.destroyed) return;
        if (!Array.isArray(addresses) || !addresses.length ||
            addresses.some(record => !record?.address || blockedIp(record.address))) {
          response(client, 403, 'Forbidden', 'Destination resolved to a private or reserved address');
          return;
        }

        // Prefer IPv4 for common Docker bridge deployments, but pin the exact
        // address selected from this one validated DNS response.
        const selected = addresses.find(record => isIP(record.address) === 4) || addresses[0];
        const upstream = connect({
          host: selected.address,
          port: request.port,
          ...(isIP(selected.address) ? { family: isIP(selected.address) } : {}),
        });
        upstreams.add(upstream);
        upstream.setNoDelay(true);
        let established = false;
        upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('Egress connection timed out')));
        upstream.on('error', () => {
          if (!established && !client.destroyed) {
            response(client, 502, 'Bad Gateway', 'Destination connection failed');
          }
        });
        upstream.once('close', () => {
          upstreams.delete(upstream);
          if (established && !client.destroyed) client.end();
        });
        client.once('close', () => upstream.destroy());

        upstream.once('connect', () => {
          established = true;
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          client.setTimeout(idleTimeoutMs, () => client.destroy());
          upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
          client.write('HTTP/1.1 200 Connection Established\r\n' +
            'Proxy-Agent: url-to-tutorial-egress\r\n\r\n');
          if (remainder.length) upstream.write(remainder);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
      })().catch(() => response(client, 502, 'Bad Gateway', 'Egress proxy failed'));
    };
    client.on('data', onHeader);
  });

  const closeServer = server.close.bind(server);
  server.close = callback => {
    for (const socket of clients) socket.destroy();
    for (const socket of upstreams) socket.destroy();
    return closeServer(callback);
  };
  return server;
}
