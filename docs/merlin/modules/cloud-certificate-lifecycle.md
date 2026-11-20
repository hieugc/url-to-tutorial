# cloud-certificate-lifecycle.mjs

[Mở module nguồn](../../../src/cloud-certificate-lifecycle.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### safeErrorCode

`safeErrorCode(error)` · [Dòng 11–14](../../../src/cloud-certificate-lifecycle.mjs#L11)

- Kết quả: `typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'CERTIFICATE_LI…`.

### authorize

`authorize(authenticator, context, action)` · [Dòng 16–25](../../../src/cloud-certificate-lifecycle.mjs#L16)

- Lời gọi trong thân hàm: `authenticator.authorize`, `ACTOR_ID.test`, `Object.freeze`.
- Kết quả: `{actorId}`.
- Lỗi trực tiếp có thông điệp cố định: `Certificate operator authorization failed`, `Certificate lifecycle requires an MFA-verified operator`.

### validateVerification

`validateVerification(verified, { replicaId, publicKeyFingerprint, now, minimumValidityMs })` · [Dòng 27–55](../../../src/cloud-certificate-lifecycle.mjs#L27)

- Lời gọi trong thân hàm: `Date.parse`, `Array.isArray`, `verified.extendedKeyUsages.includes`, `FINGERPRINT.test`, `SERIAL.test`, `Number.isFinite`, `Object.assign`, `Object.freeze`.
- Kết quả: `{replicaId, fingerprint256, serialNumber, notBefore, notAfter, sanDns, extendedKeyUsages}`.

### createReplicaCertificateLifecycle

`createReplicaCertificateLifecycle({ operatorAuthenticator, keyProvider, certificateAuthority, certificateStore, replicaDirectory, publishLock, auditRecorder, now = () => Date.now(), defaultTtlMs = 30 * 24 * 60 * 60_000, minimumValidityMs = 24 * 60 * 60_000, } = {})` · [Dòng 57–373](../../../src/cloud-certificate-lifecycle.mjs#L57)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `Object.freeze`.
- Kết quả: `{issue, rotate}`.
- Lỗi trực tiếp có thông điệp cố định: `MFA certificate operator authenticator is required`, `Non-exportable replica key provider is required`, `Private certificate authority adapter is required`, `Replica certificate directory is required`, `A shared distributed certificate lock is required`, `Tamper-evident certificate audit recorder is required`, `Certificate validity configuration is invalid`.

### createReplicaCertificateLifecycle → provision

`provision(context, replicaId, { rotate, ttlMs = defaultTtlMs } = {})` · [Dòng 102–367](../../../src/cloud-certificate-lifecycle.mjs#L102)

- Lời gọi trong thân hàm: `REPLICA_ID.test`, `Number.isSafeInteger`, `authorize`, `publishLock.withLock`.
- Kết quả: `publishLock.withLock(…)`.
- Lỗi trực tiếp có thông điệp cố định: `A valid replica ID is required`, `Certificate TTL must be between 1 hour and 90 days`.

### createReplicaCertificateLifecycle → provision → assertLockHeld

`assertLockHeld()` · [Dòng 115–115](../../../src/cloud-certificate-lifecycle.mjs#L115)

- Lời gọi trong thân hàm: `lease.assertHeld`.
- Kết quả: `lease.assertHeld()`.

### createReplicaCertificateLifecycle → issue

`issue(context, replicaId, options)` · [Dòng 370–370](../../../src/cloud-certificate-lifecycle.mjs#L370)

- Lời gọi trong thân hàm: `provision`.
- Kết quả: `provision(context, replicaId, { ...options, rotate: false })`.

### createReplicaCertificateLifecycle → rotate

`rotate(context, replicaId, options)` · [Dòng 371–371](../../../src/cloud-certificate-lifecycle.mjs#L371)

- Lời gọi trong thân hàm: `provision`.
- Kết quả: `provision(context, replicaId, { ...options, rotate: true })`.

### createStudioCertificateAuditRecorder

`createStudioCertificateAuditRecorder({ store } = {})` · [Dòng 377–424](../../../src/cloud-certificate-lifecycle.mjs#L377)

- Lời gọi trong thân hàm: `Object.freeze`.
- Kết quả: `{record}`.
- Lỗi trực tiếp có thông điệp cố định: `Studio cloud audit store is required`.

### createStudioCertificateAuditRecorder → record

`record(event)` · [Dòng 391–422](../../../src/cloud-certificate-lifecycle.mjs#L391)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.keys`, `allowedActions.has`, `ACTOR_ID.test`, `REPLICA_ID.test`, `uuidPattern.test`, `FINGERPRINT.test`, `store.recordCloudAudit`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Certificate audit event is invalid`.
