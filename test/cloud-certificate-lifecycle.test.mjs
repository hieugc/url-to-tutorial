import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplicaCertificateLifecycle } from '../src/cloud-certificate-lifecycle.mjs';

const replicaId = 'api-a';
const fingerprint = 'a'.repeat(64);
const now = Date.parse('2026-11-09T10:00:00.000Z');

function createHarness({ failVerify = false, failRevoke = false, invalidCertificate = false } = {}) {
  const calls = [];
  const records = new Map();
  let active = null;
  let lockHeld = false;
  let sequence = 0;
  const keyProvider = {
    async createKeyAndCsr(input) {
      calls.push({ method: 'createKeyAndCsr', input });
      sequence++;
      return {
        keyRef: 'kms://keys/replica-' + sequence,
        csrPem: '-----BEGIN CERTIFICATE REQUEST-----\n' + 'x'.repeat(64) + '\n-----END CERTIFICATE REQUEST-----',
        publicKeyFingerprint: String(sequence).padStart(64, '0'),
      };
    },
    async destroyKey(keyRef) { calls.push({ method: 'destroyKey', keyRef }); },
  };
  const certificateAuthority = {
    async issueCertificate(input) {
      calls.push({ method: 'issueCertificate', input });
      return {
        certificatePem: '-----BEGIN CERTIFICATE-----\n' + 'y'.repeat(64) + '\n-----END CERTIFICATE-----',
        chainPem: '-----BEGIN CERTIFICATE-----\n' + 'z'.repeat(64) + '\n-----END CERTIFICATE-----',
        serialNumber: String(sequence).padStart(16, '0'),
      };
    },
    async verifyCertificateChain(input) {
      calls.push({ method: 'verifyCertificateChain', input });
      return {
        valid: true,
        replicaId: invalidCertificate ? 'other-replica' : replicaId,
        sanDns: [invalidCertificate ? 'other-replica' : replicaId],
        extendedKeyUsages: ['serverAuth', 'clientAuth'],
        publicKeyFingerprint: input.expectedPublicKeyFingerprint,
        fingerprint256: sequence === 1 ? fingerprint : 'b'.repeat(64),
        notBefore: new Date(now - 1000).toISOString(),
        notAfter: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
      };
    },
    async revokeCertificate(input) {
      calls.push({ method: 'revokeCertificate', input });
      if (failRevoke) throw Object.assign(new Error('CA backend detail'), { code: 'CA_REVOCATION_UNAVAILABLE' });
    },
  };
  const certificateStore = {
    async getActive(id) { calls.push({ method: 'getActive', id }); return active; },
    async stageCertificate(record) {
      calls.push({ method: 'stageCertificate', record });
      records.set(record.bundleId, { ...record, state: 'staged' });
    },
    async activateCertificate(input) {
      calls.push({ method: 'activateCertificate', input });
      if (input.expectedPreviousBundleId !== (active?.bundleId ?? null)) throw new Error('active certificate changed');
      if (active) records.set(active.bundleId, { ...active, state: 'superseded' });
      active = { ...records.get(input.bundleId), state: 'active' };
      records.set(input.bundleId, active);
      return active;
    },
    async markFailed(input) {
      calls.push({ method: 'markFailed', input });
      const record = records.get(input.bundleId);
      if (record) records.set(input.bundleId, { ...record, state: 'failed', errorCode: input.errorCode });
    },
    async markRevocationPending(input) {
      calls.push({ method: 'markRevocationPending', input });
      const record = records.get(input.bundleId);
      if (record) records.set(input.bundleId, { ...record, state: 'revocation_pending' });
    },
    async markRevoked(input) {
      calls.push({ method: 'markRevoked', input });
      const record = records.get(input.bundleId);
      if (record) records.set(input.bundleId, { ...record, state: 'revoked' });
    },
  };
  const replica = {
    async installCertificate(bundle) { calls.push({ method: 'installCertificate', bundle }); },
    async verifyCertificate() {
      calls.push({ method: 'verifyInstalledCertificate' });
      return { fingerprint256: failVerify ? 'f'.repeat(64) : (sequence === 1 ? fingerprint : 'b'.repeat(64)) };
    },
    async activateCertificate(input) { calls.push({ method: 'activateReplicaCertificate', input }); },
    async restoreCertificate(bundleId) { calls.push({ method: 'restoreCertificate', bundleId }); },
  };
  const service = createReplicaCertificateLifecycle({
    operatorAuthenticator: {
      async authorize(context, { action }) {
        calls.push({ method: 'authorize', actorId: context.actorId, action });
        return { actorId: context.actorId, mfaVerified: context.mfaVerified === true };
      },
    },
    keyProvider,
    certificateAuthority,
    certificateStore,
    replicaDirectory: { async get(id) { calls.push({ method: 'getReplica', id }); return replica; } },
    publishLock: {
      async withLock(resource, callback) {
        calls.push({ method: 'withLock', resource });
        if (lockHeld) throw new Error('lock overlap');
        lockHeld = true;
        try { return await callback(); } finally { lockHeld = false; }
      },
    },
    auditRecorder: { async record(event) { calls.push({ method: 'audit', event }); } },
    now: () => now,
    minimumValidityMs: 24 * 60 * 60_000,
  });
  return { service, calls, records, getActive: () => active };
}

test('issues and activates a replica certificate only after CA verification and mTLS installation verification', async () => {
  const { service, calls, getActive } = createHarness();
  const result = await service.issue(
    { actorId: 'operator-alpha', mfaVerified: true },
    replicaId,
  );
  assert.equal(result.state, 'active');
  assert.equal(result.replicaId, replicaId);
  assert.equal(getActive().keyRef, 'kms://keys/replica-1');
  assert.ok(calls.findIndex(c => c.method === 'verifyCertificateChain') <
    calls.findIndex(c => c.method === 'installCertificate'));
  assert.ok(calls.findIndex(c => c.method === 'verifyInstalledCertificate') <
    calls.findIndex(c => c.method === 'activateReplicaCertificate'));
  assert.equal(JSON.stringify(calls).includes('PRIVATE KEY'), false);
});

test('rotates with overlap and revokes the previous CA certificate only after new activation', async () => {
  const { service, calls } = createHarness();
  await service.issue({ actorId: 'operator-alpha', mfaVerified: true }, replicaId);
  calls.length = 0;
  const result = await service.rotate({ actorId: 'operator-beta', mfaVerified: true }, replicaId);
  assert.equal(result.state, 'active');
  const replicaActivate = calls.findIndex(c => c.method === 'activateReplicaCertificate');
  const storeActivate = calls.findIndex(c => c.method === 'activateCertificate');
  const revoke = calls.findIndex(c => c.method === 'revokeCertificate');
  assert.ok(replicaActivate >= 0 && storeActivate > replicaActivate && revoke > storeActivate);
});

test('preserves the active certificate and destroys the staged key when CA identity validation fails', async () => {
  const { service, calls, getActive, records } = createHarness({ invalidCertificate: true });
  await assert.rejects(service.issue(
    { actorId: 'operator-alpha', mfaVerified: true }, replicaId,
  ), /certificate identity or policy validation failed/i);
  assert.equal(getActive(), null);
  assert.ok(calls.some(c => c.method === 'destroyKey'));
  assert.equal([...records.values()][0].state, 'failed');
});

test('restores the previous certificate if the replica does not verify the staged fingerprint', async () => {
  const { service, calls, getActive } = createHarness({ failVerify: true });
  await assert.rejects(service.issue(
    { actorId: 'operator-alpha', mfaVerified: true }, replicaId,
  ), /replica certificate verification failed/i);
  assert.equal(getActive(), null);
  assert.ok(calls.some(c => c.method === 'restoreCertificate' && c.bundleId === null));
});

test('requires MFA before key generation and serializes issue/rotation by replica', async () => {
  const { service, calls } = createHarness();
  await assert.rejects(service.issue(
    { actorId: 'operator-alpha', mfaVerified: false }, replicaId,
  ), /MFA/i);
  assert.equal(calls.some(c => c.method === 'createKeyAndCsr'), false);
  await service.issue({ actorId: 'operator-alpha', mfaVerified: true }, replicaId);
  assert.ok(calls.some(c => c.method === 'withLock' && c.resource === 'certificate:api-a'));
});

test('reports previous certificate revocation as pending without rolling back the verified replacement', async () => {
  const { service } = createHarness({ failRevoke: true });
  await service.issue({ actorId: 'operator-alpha', mfaVerified: true }, replicaId);
  const result = await service.rotate({ actorId: 'operator-beta', mfaVerified: true }, replicaId);
  assert.equal(result.state, 'active');
  assert.equal(result.previousCertificateRevocationPending, true);
});
