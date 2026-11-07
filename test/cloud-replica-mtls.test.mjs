import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createMtlsReplicaClient, createMtlsReplicaServer } from '../src/cloud-replica-mtls.mjs';

async function certificates(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tutorial-mtls-replica-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  await writeFile(path.join(dir, 'server.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  await writeFile(path.join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n');
  await writeFile(path.join(dir, 'other-client.ext'), 'extendedKeyUsage=clientAuth\n');
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-subj','/CN=Replica Test CA','-days','2']);
  for (const name of ['server','client','other-client']) {
    run(['req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);
    run(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
      '-out',name+'.crt','-days','2','-extfile',name==='server'?'server.ext':name+'.ext']);
  }
  const read = name => readFile(path.join(dir,name),'utf8');
  const clientCert = await read('client.crt');
  return {
    ca: await read('ca.crt'),
    serverKey: await read('server.key'),
    serverCert: await read('server.crt'),
    clientKey: await read('client.key'),
    clientCert,
    otherClientKey: await read('other-client.key'),
    otherClientCert: await read('other-client.crt'),
    clientFingerprint: new X509Certificate(clientCert).fingerprint256,
  };
}

const initialStatus = () => ({
  secretVersion: '41',
  tokenIds: ['service-a-current'],
  auditKeyRing: { activeKeyId: '0123456789abcdef', keyIds: ['0123456789abcdef'] },
});

test('mTLS replica client reads sanitized status and reloads only the pinned version', async t => {
  const cert = await certificates(t);
  let current = initialStatus();
  const calls = [];
  const server = createMtlsReplicaServer({
    ...{ key: cert.serverKey, cert: cert.serverCert, ca: cert.ca },
    replicaId: 'api-replica-1',
    allowedClientFingerprints: [cert.clientFingerprint],
    async reloadTokens(assertion, constraints) {
      calls.push({ assertion, constraints });
      assert.equal(assertion, 'signed-operator-assertion-0123456789');
      current = { ...current, secretVersion: constraints.expectedVersion, tokenIds: ['service-a-next'] };
    },
    status: () => ({ ...current, secretToken: 'must-never-leave-replica' }),
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = createMtlsReplicaClient({
    id: 'api-replica-1',
    url: 'https://localhost:' + address.port,
    ca: cert.ca,
    cert: cert.clientCert,
    key: cert.clientKey,
  });

  const before = await client.status();
  assert.equal(before.secretVersion, '41');
  assert.equal('secretToken' in before, false);
  const after = await client.reloadTokens('signed-operator-assertion-0123456789', {
    expectedVersion: '42',
    rolloutId: 'rollout-20261107',
    replicaId: 'api-replica-1',
  });
  assert.equal(after.secretVersion, '42');
  assert.deepEqual(after.tokenIds, ['service-a-next']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].constraints, {
    expectedVersion: '42', rolloutId: 'rollout-20261107', replicaId: 'api-replica-1',
  });
});

test('mTLS server rejects a CA-trusted but non-allowlisted client certificate', async t => {
  const cert = await certificates(t);
  const server = createMtlsReplicaServer({
    key: cert.serverKey, cert: cert.serverCert, ca: cert.ca,
    replicaId: 'api-replica-1',
    allowedClientFingerprints: [cert.clientFingerprint],
    reloadTokens: async () => {},
    status: initialStatus,
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = createMtlsReplicaClient({
    id: 'api-replica-1',
    url: 'https://localhost:' + address.port,
    ca: cert.ca,
    cert: cert.otherClientCert,
    key: cert.otherClientKey,
  });
  await assert.rejects(client.status(), /HTTP 403/);
});

test('client rejects mismatched replica constraints before network access', async () => {
  const client = createMtlsReplicaClient({
    id: 'api-replica-1', url: 'https://localhost:4443',
    ca: 'ca', cert: 'cert', key: 'key',
  });
  assert.throws(() => client.reloadTokens('signed-operator-assertion-0123456789', {
    expectedVersion: '42', rolloutId: 'rollout-20261107', replicaId: 'api-replica-2',
  }), /do not match this client identity/);
});

test('client requires a trusted server certificate and optional exact fingerprint pin', async t => {
  const cert = await certificates(t);
  const server = createMtlsReplicaServer({
    key: cert.serverKey, cert: cert.serverCert, ca: cert.ca,
    replicaId: 'api-replica-1',
    allowedClientFingerprints: [cert.clientFingerprint],
    reloadTokens: async () => {},
    status: initialStatus,
  });
  const address = await server.listen();
  t.after(() => server.close());
  const pinnedWrong = createMtlsReplicaClient({
    id: 'api-replica-1', url: 'https://localhost:' + address.port,
    ca: cert.ca, cert: cert.clientCert, key: cert.clientKey,
    expectedServerFingerprint: '0'.repeat(64),
  });
  await assert.rejects(pinnedWrong.status(), /fingerprint mismatch/);
  const untrusted = createMtlsReplicaClient({
    id: 'api-replica-1', url: 'https://localhost:' + address.port,
    ca: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----',
    cert: cert.clientCert, key: cert.clientKey,
  });
  await assert.rejects(untrusted.status(), /transport failed/);
});

test('server rejects malformed reload bodies, wrong replica IDs and wildcard binds', async t => {
  const cert = await certificates(t);
  assert.throws(() => createMtlsReplicaServer({
    key: cert.serverKey, cert: cert.serverCert, ca: cert.ca,
    replicaId: 'api-replica-1', allowedClientFingerprints: [cert.clientFingerprint],
    reloadTokens: async () => {}, status: initialStatus, host: '0.0.0.0',
  }), /explicit private interface/);
  assert.throws(() => createMtlsReplicaServer({
    key: cert.serverKey, cert: cert.serverCert, ca: cert.ca,
    replicaId: 'api-replica-1', allowedClientFingerprints: [],
    reloadTokens: async () => {}, status: initialStatus,
  }), /fingerprint allowlist/);
});
