import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresCertificateStore } from '../src/cloud-certificate-postgres.mjs';

const connectionString = process.env.COORDINATION_DATABASE_URL;

test('PostgreSQL certificate store enforces one active certificate per replica and compare-and-swap rotation', {
  skip: !connectionString && 'Set COORDINATION_DATABASE_URL to run the PostgreSQL integration test',
}, async t => {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString, max: 2 });
  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  t.after(async () => Promise.all([poolA.end(), poolB.end(), admin.end()]));
  await admin.query(await readFile(new URL('../migrations/004-cloud-certificates.sql', import.meta.url), 'utf8'));

  const storeA = createPostgresCertificateStore({ pool: poolA });
  const storeB = createPostgresCertificateStore({ pool: poolB });
  const replicaId = 'api-' + randomUUID().slice(0, 8);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const makeBundle = (bundleId, fingerprint, serial) => ({
    bundleId, replicaId, serialNumber: serial, fingerprint256: fingerprint.repeat(64).slice(0, 64),
    certificatePem: '-----BEGIN CERTIFICATE-----\npublic-cert\n-----END CERTIFICATE-----',
    chainPem: '-----BEGIN CERTIFICATE-----\npublic-chain\n-----END CERTIFICATE-----',
    keyRef: 'kms://key/' + bundleId,
    publicKeyFingerprint: 'c'.repeat(64),
    notBefore: new Date(Date.now() - 1000).toISOString(),
    notAfter: new Date(Date.now() + 86400_000).toISOString(),
    actorId: 'security-operator',
  });

  await storeA.stageCertificate(makeBundle(firstId, 'a', '1001'));
  await storeA.activateCertificate({ replicaId, bundleId: firstId, expectedPreviousBundleId: null });
  assert.equal((await storeB.getActive(replicaId)).bundleId, firstId);

  await storeB.stageCertificate(makeBundle(secondId, 'b', '1002'));
  await assert.rejects(storeA.activateCertificate({
    replicaId, bundleId: secondId, expectedPreviousBundleId: randomUUID(),
  }), /active replica certificate changed/i);

  await storeA.activateCertificate({
    replicaId, bundleId: secondId, expectedPreviousBundleId: firstId,
  });
  assert.equal((await storeB.getActive(replicaId)).bundleId, secondId);
  await storeA.markRevocationPending({ bundleId: firstId, errorCode: 'CA_REVOCATION_UNAVAILABLE' });
  const rows = await admin.query(
    'SELECT state, key_ref FROM tutorial_replica_certificates WHERE replica_id = $1 ORDER BY created_at',
    [replicaId],
  );
  assert.deepEqual(rows.rows.map(row => row.state), ['revocation_pending', 'active']);
  assert.ok(rows.rows.every(row => row.key_ref.startsWith('kms://key/')));
  assert.equal(JSON.stringify(rows.rows).includes('PRIVATE KEY'), false);
});
