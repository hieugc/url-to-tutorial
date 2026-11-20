# cloud-certificate-postgres.mjs

[Mở module nguồn](../../../src/cloud-certificate-postgres.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validatePool

`validatePool(pool)` · [Dòng 1–5](../../../src/cloud-certificate-postgres.mjs#L1)

- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `A connect-capable PostgreSQL pool is required`.

### uuid

`uuid(value, name)` · [Dòng 7–12](../../../src/cloud-certificate-postgres.mjs#L7)

- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### safeStoreError

`safeStoreError()` · [Dòng 14–16](../../../src/cloud-certificate-postgres.mjs#L14)

- Kết quả: `new Error('Durable replica certificate storage is unavailable')`.

### mapRow

`mapRow(row)` · [Dòng 18–36](../../../src/cloud-certificate-postgres.mjs#L18)

- Lời gọi trong thân hàm: `row.fingerprint256.trim`, `row.public_key_fingerprint.trim`.
- Kết quả: `null`, `{bundleId, replicaId, serialNumber, fingerprint256, certificatePem, chainPem, keyRef, publicKeyFingerprint, notBefore, notAfter, actorId, previousBundleId, state, errorCode}`.

### transaction

`transaction(pool, operation)` · [Dòng 38–54](../../../src/cloud-certificate-postgres.mjs#L38)

- Lời gọi trong thân hàm: `pool.connect`, `client.query`, `operation`, `error.message?.startsWith`, `safeStoreError`, `client.release`.
- Kết quả: `result`.

### createPostgresCertificateStore

`createPostgresCertificateStore({ pool } = {})` · [Dòng 56–185](../../../src/cloud-certificate-postgres.mjs#L56)

- Lời gọi trong thân hàm: `validatePool`, `Object.freeze`.
- Kết quả: `{getActive, stageCertificate, activateCertificate, markFailed, markRevocationPending, markRevoked}`.

### createPostgresCertificateStore → getActive

`getActive(replicaId)` · [Dòng 59–72](../../../src/cloud-certificate-postgres.mjs#L59)

- Lời gọi trong thân hàm: `pool.query`, `safeStoreError`, `mapRow`.
- Kết quả: `mapRow(result.rows[0])`.
- Lỗi trực tiếp có thông điệp cố định: `A valid replica ID is required`, `Certificate store contains multiple active certificates`.

### createPostgresCertificateStore → stageCertificate

`stageCertificate(input)` · [Dòng 74–105](../../../src/cloud-certificate-postgres.mjs#L74)

- Lời gọi trong thân hàm: `Array.isArray`, `uuid`, `Number.isFinite`, `Date.parse`, `pool.query`, `safeStoreError`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Certificate bundle metadata is required`, `Replica certificate metadata is invalid`.

### createPostgresCertificateStore → activateCertificate

`activateCertificate(input)` · [Dòng 107–141](../../../src/cloud-certificate-postgres.mjs#L107)

- Lời gọi trong thân hàm: `uuid`, `transaction`.
- Kết quả: `transaction(…)`.
- Lỗi trực tiếp có thông điệp cố định: `A valid replica ID is required`.

### createPostgresCertificateStore → updateState

`updateState(bundleId, fromStates, state, errorCode = null)` · [Dòng 143–154](../../../src/cloud-certificate-postgres.mjs#L143)

- Lời gọi trong thân hàm: `uuid`, `pool.query`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Certificate bundle state changed or is invalid`.

### createPostgresCertificateStore → markFailed

`markFailed(input)` · [Dòng 156–162](../../../src/cloud-certificate-postgres.mjs#L156)

- Lời gọi trong thân hàm: `updateState`, `error.message?.startsWith`, `safeStoreError`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Certificate failure code is invalid`.

### createPostgresCertificateStore → markRevocationPending

`markRevocationPending(input)` · [Dòng 164–170](../../../src/cloud-certificate-postgres.mjs#L164)

- Lời gọi trong thân hàm: `updateState`, `error.message?.startsWith`, `safeStoreError`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Certificate revocation error code is invalid`.

### createPostgresCertificateStore → markRevoked

`markRevoked(input)` · [Dòng 172–175](../../../src/cloud-certificate-postgres.mjs#L172)

- Lời gọi trong thân hàm: `updateState`, `error.message?.startsWith`, `safeStoreError`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
