# cloud-audit-archive-s3.mjs

[Mở module nguồn](../../../src/cloud-audit-archive-s3.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### isMissing

`isMissing(error)` · [Dòng 5–8](../../../src/cloud-audit-archive-s3.mjs#L5)

- Lời gọi trong thân hàm: `['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes`.
- Kết quả: `['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(error?.name) || error?.$metadata?.httpStatusCode === 404`.

### isPreconditionFailure

`isPreconditionFailure(error)` · [Dòng 10–13](../../../src/cloud-audit-archive-s3.mjs#L10)

- Lời gọi trong thân hàm: `['PreconditionFailed', 'ConditionalRequestConflict'].includes`.
- Kết quả: `['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name) || error?.$metadata?.httpStatusC…`.

### bodyText

`bodyText(body)` · [Dòng 15–24](../../../src/cloud-audit-archive-s3.mjs#L15)

- Lời gọi trong thân hàm: `body.transformToString`, `Object`, `chunks.push`, `Buffer.from`, `Buffer.concat`.
- Kết quả: `body`, `body.transformToString()`, `Buffer.concat(chunks).toString('utf8')`.
- Lỗi trực tiếp có thông điệp cố định: `S3 audit archive returned an unreadable object body`.

### validateBatch

`validateBatch(batch)` · [Dòng 26–49](../../../src/cloud-audit-archive-s3.mjs#L26)

- Lời gọi trong thân hàm: `Array.isArray`, `Number.isSafeInteger`, `HASH.test`, `batch.events.at`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Audit archive batch metadata is invalid`, `Audit archive events are not a contiguous verified chain`, `Audit archive final checkpoint does not match the batch events`.

### createS3AuditArchiveSink

`createS3AuditArchiveSink({ client, bucket, prefix = 'url-to-tutorial/audit', replicaId, kmsKeyId, retentionDays = 365, commands, now = () => new Date().toISOString(), } = {})` · [Dòng 51–234](../../../src/cloud-audit-archive-s3.mjs#L51)

- Lời gọi trong thân hàm: `REPLICA_ID.test`, `prefix.split`, `/^[A-Za-z0-9][A-Za-z0-9_.!*/-]*$/.test`, `kmsKeyId.trim`, `Number.isSafeInteger`, `prefix.replace`, `Object.freeze`.
- Kết quả: `{archiveBatch, bucket, prefix}`.
- Lỗi trực tiếp có thông điệp cố định: `An AWS SDK v3 S3 client is required`, `S3 GetObjectCommand and PutObjectCommand constructors are required`, `A valid S3 bucket name is required`, `A valid replica ID is required for audit archive isolation`, `A valid S3 audit archive prefix is required`, `An AWS KMS key ID or ARN is required for audit archive encryption`, `Audit archive retentionDays must be between 1 and 3650`, `Audit archive clock must be a function`.

### createS3AuditArchiveSink → readObject

`readObject(key)` · [Dòng 88–96](../../../src/cloud-audit-archive-s3.mjs#L88)

- Lời gọi trong thân hàm: `client.send`, `bodyText`, `isMissing`.
- Kết quả: `{body, etag}`, `null`.
- Lỗi trực tiếp có thông điệp cố định: `S3 audit archive read failed`.

### createS3AuditArchiveSink → putImmutable

`putImmutable(key, body, retainUntil)` · [Dòng 98–114](../../../src/cloud-audit-archive-s3.mjs#L98)

- Lời gọi trong thân hàm: `client.send`, `isPreconditionFailure`, `readObject`.
- Kết quả: `void`.
- Lỗi trực tiếp có thông điệp cố định: `S3 audit archive batch write failed`, `S3 immutable archive batch conflict`.

### createS3AuditArchiveSink → archiveBatch

`archiveBatch(batch)` · [Dòng 116–231](../../../src/cloud-audit-archive-s3.mjs#L116)

- Lời gọi trong thân hàm: `validateBatch`, `readObject`, `JSON.parse`, `Number.isSafeInteger`, `HASH.test`, `checkpoint.checkpointHistoryKey.startsWith`, `history.batchKey.startsWith`, `String`, `JSON.stringify`, `now`, `Date.parse`, `Number.isFinite`, `putImmutable`, `client.send`, `isPreconditionFailure`.
- Kết quả: `{throughSequence, throughHash}`.
- Lỗi trực tiếp có thông điệp cố định: `S3 audit archive checkpoint is malformed`, `S3 audit archive checkpoint is invalid`, `S3 audit archive checkpoint history is missing`, `mismatch`, `batch missing`, `batch checkpoint mismatch`, `S3 audit archive checkpoint history is invalid`, `S3 audit archive checkpoint does not match the batch predecessor`, `Audit archive clock returned an invalid timestamp`, `S3 immutable archive batch conflict`, `S3 audit archive checkpoint write failed`, `S3 audit archive checkpoint changed concurrently; retry from the new checkpoint`.
