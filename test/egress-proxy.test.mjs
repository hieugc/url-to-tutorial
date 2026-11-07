import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createEgressProxyServer } from '../src/egress-proxy.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  for (const socket of server._connections ? [] : []) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function request(port, raw, { maxBytes = 16384 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for proxy response'));
    }, 3000);
    socket.on('connect', () => socket.write(raw));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > maxBytes) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('Proxy response exceeded test limit'));
      }
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(data.toString('latin1'));
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('Egress proxy accepts only strict HTTPS CONNECT authorities', async t => {
  let dnsCalls = 0;
  const proxy = createEgressProxyServer({
    resolve: async () => { dnsCalls++; return [{ address: '8.8.8.8' }]; },
    connect: () => { throw new Error('must not connect'); },
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));

  const cases = [
    ['GET https://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n', '405 Method Not Allowed'],
    ['CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\n\r\n', '403 Forbidden'],
    ['CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n', '403 Forbidden'],
    ['CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n', '403 Forbidden'],
    ['CONNECT example.com:443 HTTP/1.1\r\nHost: attacker.example:443\r\n\r\n', '400 Bad Request'],
    ['CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nContent-Length: 1\r\n\r\n', '400 Bad Request'],
  ];
  for (const [raw, expected] of cases) {
    const result = await request(port, raw);
    assert.match(result, new RegExp(expected.replaceAll(' ', ' ')));
  }
  assert.equal(dnsCalls, 0, 'Malformed or disallowed requests must be rejected before DNS');
});

test('Egress proxy rejects the entire DNS answer set if any address is private', async t => {
  let connectCalls = 0;
  const proxy = createEgressProxyServer({
    resolve: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
    connect: () => { connectCalls++; throw new Error('must not connect'); },
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));

  const result = await request(port,
    'CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n');
  assert.match(result, /403 Forbidden/);
  assert.match(result, /private or reserved/);
  assert.equal(connectCalls, 0);
});

test('Egress proxy pins the single validated DNS answer and relays CONNECT bytes', async t => {
  const upstream = net.createServer(socket => {
    socket.on('data', chunk => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  let dnsCalls = 0;
  const connectedAddresses = [];
  const proxy = createEgressProxyServer({
    resolve: async () => {
      dnsCalls++;
      // A hypothetical second DNS lookup would now return a private address.
      return [{ address: dnsCalls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    },
    connect: options => {
      connectedAddresses.push(options.host);
      // The injected transport redirects the test socket to a local echo server;
      // the proxy itself is still required to pass the resolved/pinned public IP.
      return net.connect({ host: '127.0.0.1', port: upstreamPort });
    },
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));

  const client = net.connect(port, '127.0.0.1');
  t.after(() => client.destroy());
  const received = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('Timed out waiting for tunnel echo')), 3000);
    client.once('connect', () => client.write(
      'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nhello',
    ));
    client.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(Buffer.from('echo:hello'))) {
        clearTimeout(timer);
        resolve(buffer.toString('latin1'));
      }
    });
    client.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.match(received, /200 Connection Established/);
  assert.match(received, /echo:hello/);
  assert.equal(dnsCalls, 1, 'Hostname must be resolved exactly once per tunnel');
  assert.deepEqual(connectedAddresses, ['93.184.216.34'], 'Socket must connect to the validated IP, not hostname');
});

test('Egress proxy rejects oversized headers before resolving a destination', async t => {
  let dnsCalls = 0;
  const proxy = createEgressProxyServer({
    maxHeaderBytes: 256,
    resolve: async () => { dnsCalls++; return [{ address: '8.8.8.8' }]; },
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  const result = await request(port,
    'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nX-Large: ' +
    'x'.repeat(400) + '\r\n\r\n');
  assert.match(result, /431 Request Header Fields Too Large/);
  assert.equal(dnsCalls, 0);
});
