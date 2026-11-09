import { randomUUID } from 'node:crypto';

const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;
const REPLICA_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KEY_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,255}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const SERIAL = /^[a-f0-9]{1,64}$/i;
const PEM_CERT = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;
const PEM_CSR = /^-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/;

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'CERTIFICATE_LIFECYCLE_FAILED';
}

async function authorize(authenticator, context, action) {
  let identity;
  try { identity = await authenticator.authorize(context, { action }); }
  catch { throw new Error('Certificate operator authorization failed'); }
  if (!identity || identity.mfaVerified !== true ||
      typeof identity.actorId !== 'string' || !ACTOR_ID.test(identity.actorId)) {
    throw new Error('Certificate lifecycle requires an MFA-verified operator');
  }
  return Object.freeze({ actorId: identity.actorId });
}

function validateVerification(verified, { replicaId, publicKeyFingerprint, now, minimumValidityMs }) {
  const notBefore = Date.parse(verified?.notBefore);
  const notAfter = Date.parse(verified?.notAfter);
  if (!verified || verified.valid !== true ||
      verified.replicaId !== replicaId ||
      !Array.isArray(verified.sanDns) || verified.sanDns.length !== 1 ||
      verified.sanDns[0] !== replicaId ||
      !Array.isArray(verified.extendedKeyUsages) ||
      !verified.extendedKeyUsages.includes('serverAuth') ||
      !verified.extendedKeyUsages.includes('clientAuth') ||
      verified.publicKeyFingerprint !== publicKeyFingerprint ||
      typeof verified.fingerprint256 !== 'string' || !FINGERPRINT.test(verified.fingerprint256) ||
      typeof verified.serialNumber !== 'string' || !SERIAL.test(verified.serialNumber) ||
      !Number.isFinite(notBefore) || !Number.isFinite(notAfter) ||
      notBefore > now + 5 * 60_000 || notAfter < now + minimumValidityMs) {
    throw Object.assign(new Error('Issued certificate identity or policy validation failed'), {
      code: 'CERTIFICATE_POLICY_REJECTED',
    });
  }
  return Object.freeze({
    replicaId,
    fingerprint256: verified.fingerprint256,
    serialNumber: verified.serialNumber,
    notBefore: new Date(notBefore).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
    sanDns: Object.freeze([...verified.sanDns]),
    extendedKeyUsages: Object.freeze([...verified.extendedKeyUsages]),
  });
}

export function createReplicaCertificateLifecycle({
  operatorAuthenticator,
  keyProvider,
  certificateAuthority,
  certificateStore,
  replicaDirectory,
  publishLock,
  auditRecorder,
  now = () => Date.now(),
  defaultTtlMs = 30 * 24 * 60 * 60_000,
  minimumValidityMs = 24 * 60 * 60_000,
} = {}) {
  if (!operatorAuthenticator || typeof operatorAuthenticator.authorize !== 'function') {
    throw new TypeError('MFA certificate operator authenticator is required');
  }
  if (!keyProvider || typeof keyProvider.createKeyAndCsr !== 'function' ||
      typeof keyProvider.destroyKey !== 'function') {
    throw new TypeError('Non-exportable replica key provider is required');
  }
  if (!certificateAuthority ||
      typeof certificateAuthority.issueCertificate !== 'function' ||
      typeof certificateAuthority.verifyCertificateChain !== 'function' ||
      typeof certificateAuthority.revokeCertificate !== 'function') {
    throw new TypeError('Private certificate authority adapter is required');
  }
  for (const method of ['getActive', 'stageCertificate', 'activateCertificate', 'markFailed', 'markRevocationPending', 'markRevoked']) {
    if (!certificateStore || typeof certificateStore[method] !== 'function') {
      throw new TypeError('Certificate store method is required: ' + method);
    }
  }
  if (!replicaDirectory || typeof replicaDirectory.get !== 'function') {
    throw new TypeError('Replica certificate directory is required');
  }
  if (!publishLock || typeof publishLock.withLock !== 'function') {
    throw new TypeError('A shared distributed certificate lock is required');
  }
  if (!auditRecorder || typeof auditRecorder.record !== 'function') {
    throw new TypeError('Tamper-evident certificate audit recorder is required');
  }
  if (typeof now !== 'function' ||
      !Number.isSafeInteger(defaultTtlMs) || defaultTtlMs < 60 * 60_000 || defaultTtlMs > 90 * 24 * 60 * 60_000 ||
      !Number.isSafeInteger(minimumValidityMs) || minimumValidityMs < 60 * 60_000) {
    throw new TypeError('Certificate validity configuration is invalid');
  }

  async function provision(context, replicaId, { rotate, ttlMs = defaultTtlMs } = {}) {
    if (typeof replicaId !== 'string' || !REPLICA_ID.test(replicaId)) {
      throw new TypeError('A valid replica ID is required');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60 * 60_000 || ttlMs > 90 * 24 * 60 * 60_000) {
      throw new TypeError('Certificate TTL must be between 1 hour and 90 days');
    }
    const identity = await authorize(operatorAuthenticator, context,
      rotate ? 'cloud.certificates.rotate' : 'cloud.certificates.issue');
    return publishLock.withLock('certificate:' + replicaId, async () => {
      const previous = await certificateStore.getActive(replicaId);
      if (!rotate && previous) throw new Error('Replica already has an active certificate; use rotate');
      if (rotate && !previous) throw new Error('Cannot rotate a replica without an active certificate');

      const bundleId = randomUUID();
      let keyMaterial;
      let staged = false;
      let replica;
      let installed = false;
      let activated = false;
      try {
        await auditRecorder.record({
          action: rotate ? 'cloud.certificate.rotation_started' : 'cloud.certificate.issue_started',
          actorId: identity.actorId, replicaId, bundleId,
          previousBundleId: previous?.bundleId ?? null,
        });

        keyMaterial = await keyProvider.createKeyAndCsr({
          replicaId,
          commonName: replicaId,
          sanDns: [replicaId],
          keyAlgorithm: 'ECDSA_P256',
        });
        if (!keyMaterial || typeof keyMaterial.keyRef !== 'string' || !KEY_REF.test(keyMaterial.keyRef) ||
            typeof keyMaterial.csrPem !== 'string' || keyMaterial.csrPem.length > 65_536 ||
            !PEM_CSR.test(keyMaterial.csrPem) ||
            typeof keyMaterial.publicKeyFingerprint !== 'string' ||
            !FINGERPRINT.test(keyMaterial.publicKeyFingerprint)) {
          throw Object.assign(new Error('Key provider returned invalid CSR metadata'), {
            code: 'CERTIFICATE_KEY_PROVIDER_INVALID',
          });
        }

        const issued = await certificateAuthority.issueCertificate({
          csrPem: keyMaterial.csrPem,
          replicaId,
          sanDns: [replicaId],
          extendedKeyUsages: ['serverAuth', 'clientAuth'],
          notAfter: new Date(now() + ttlMs).toISOString(),
          idempotencyKey: bundleId,
        });
        if (!issued || typeof issued.certificatePem !== 'string' ||
            !PEM_CERT.test(issued.certificatePem) || issued.certificatePem.length > 65_536 ||
            typeof issued.chainPem !== 'string' || !PEM_CERT.test(issued.chainPem) ||
            issued.chainPem.length > 262_144) {
          throw Object.assign(new Error('Certificate authority returned an invalid certificate bundle'), {
            code: 'CERTIFICATE_AUTHORITY_INVALID',
          });
        }

        const verified = await certificateAuthority.verifyCertificateChain({
          certificatePem: issued.certificatePem,
          chainPem: issued.chainPem,
          expectedReplicaId: replicaId,
          expectedPublicKeyFingerprint: keyMaterial.publicKeyFingerprint,
          requiredExtendedKeyUsages: ['serverAuth', 'clientAuth'],
        });
        const metadata = validateVerification(verified, {
          replicaId,
          publicKeyFingerprint: keyMaterial.publicKeyFingerprint,
          now: now(),
          minimumValidityMs,
        });

        const record = {
          bundleId,
          replicaId,
          serialNumber: metadata.serialNumber,
          fingerprint256: metadata.fingerprint256,
          certificatePem: issued.certificatePem,
          chainPem: issued.chainPem,
          keyRef: keyMaterial.keyRef,
          publicKeyFingerprint: keyMaterial.publicKeyFingerprint,
          notBefore: metadata.notBefore,
          notAfter: metadata.notAfter,
          actorId: identity.actorId,
          previousBundleId: previous?.bundleId ?? null,
        };
        await certificateStore.stageCertificate(record);
        staged = true;

        replica = await replicaDirectory.get(replicaId);
        if (!replica || typeof replica.installCertificate !== 'function' ||
            typeof replica.verifyCertificate !== 'function' ||
            typeof replica.activateCertificate !== 'function' ||
            typeof replica.restoreCertificate !== 'function') {
          throw Object.assign(new Error('Replica certificate adapter is incomplete'), {
            code: 'REPLICA_CERTIFICATE_ADAPTER_INVALID',
          });
        }
        await replica.installCertificate({
          bundleId,
          certificatePem: issued.certificatePem,
          chainPem: issued.chainPem,
          keyRef: keyMaterial.keyRef,
          fingerprint256: metadata.fingerprint256,
        });
        installed = true;

        const observed = await replica.verifyCertificate({
          bundleId,
          expectedFingerprint256: metadata.fingerprint256,
        });
        if (!observed || observed.fingerprint256 !== metadata.fingerprint256) {
          throw Object.assign(new Error('Replica certificate verification failed'), {
            code: 'REPLICA_CERTIFICATE_VERIFY_FAILED',
          });
        }

        await auditRecorder.record({
          action: 'cloud.certificate.activation_authorized',
          actorId: identity.actorId,
          replicaId,
          bundleId,
          fingerprint256: metadata.fingerprint256,
          previousBundleId: previous?.bundleId ?? null,
        });
        await replica.activateCertificate({
          bundleId,
          previousBundleId: previous?.bundleId ?? null,
        });
        const active = await certificateStore.activateCertificate({
          replicaId,
          bundleId,
          expectedPreviousBundleId: previous?.bundleId ?? null,
        });
        activated = true;

        let previousCertificateRevocationPending = false;
        let previousKeyCleanupPending = false;
        if (previous) {
          try {
            await certificateAuthority.revokeCertificate({
              serialNumber: previous.serialNumber,
              reason: 'superseded',
              idempotencyKey: bundleId + ':revoke:' + previous.serialNumber,
            });
            await certificateStore.markRevoked({ bundleId: previous.bundleId });
            try { await keyProvider.destroyKey(previous.keyRef); }
            catch { previousKeyCleanupPending = true; }
          } catch {
            previousCertificateRevocationPending = true;
            try {
              await certificateStore.markRevocationPending({
                bundleId: previous.bundleId,
                errorCode: 'CA_REVOCATION_UNAVAILABLE',
              });
              await auditRecorder.record({
                action: 'cloud.certificate.revocation_pending',
                actorId: identity.actorId,
                replicaId,
                bundleId: previous.bundleId,
                resultCode: 'CA_REVOCATION_UNAVAILABLE',
              });
            } catch {
              throw new Error('New certificate is active but previous-certificate revocation state needs manual review');
            }
          }
        }

        await auditRecorder.record({
          action: 'cloud.certificate.activated',
          actorId: identity.actorId,
          replicaId,
          bundleId,
          fingerprint256: metadata.fingerprint256,
          previousBundleId: previous?.bundleId ?? null,
        });
        return Object.freeze({
          bundleId,
          replicaId,
          state: 'active',
          fingerprint256: metadata.fingerprint256,
          serialNumber: metadata.serialNumber,
          notAfter: metadata.notAfter,
          previousCertificateRevocationPending,
          previousKeyCleanupPending,
          keyRef: keyMaterial.keyRef,
          activeRecord: active,
        });
      } catch (error) {
        if (activated) {
          throw new Error('Certificate activation completed but a follow-up control failed; manual review is required');
        }
        if (installed && replica) {
          try { await replica.restoreCertificate(previous?.bundleId ?? null); }
          catch {
            throw new Error('Certificate installation failed and previous replica certificate restoration needs manual review');
          }
        }
        if (staged) {
          try {
            await certificateStore.markFailed({ bundleId, errorCode: safeErrorCode(error) });
          } catch {
            throw new Error('Failed certificate state could not be durably recorded; manual review is required');
          }
        }
        if (keyMaterial?.keyRef) {
          try { await keyProvider.destroyKey(keyMaterial.keyRef); }
          catch {
            throw new Error('Failed certificate key cleanup needs manual review');
          }
        }
        try {
          await auditRecorder.record({
            action: 'cloud.certificate.failed',
            actorId: identity.actorId,
            replicaId,
            bundleId,
            resultCode: safeErrorCode(error),
          });
        } catch {
          throw new Error('Certificate failure audit could not be recorded; manual review is required');
        }
        throw new Error(rotate
          ? 'Certificate rotation failed; previous certificate remains active'
          : 'Certificate issuance failed; no new certificate was activated');
      }
    });
  }

  return Object.freeze({
    issue: (context, replicaId, options) => provision(context, replicaId, { ...options, rotate: false }),
    rotate: (context, replicaId, options) => provision(context, replicaId, { ...options, rotate: true }),
  });
}
