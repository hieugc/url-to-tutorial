# cloud-secrets-aws.mjs

[Mở module nguồn](../../../src/cloud-secrets-aws.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validateSecretId

`validateSecretId(secretId)` · [Dòng 8–14](../../../src/cloud-secrets-aws.mjs#L8)

- Lời gọi trong thân hàm: `secretId.trim`, `/[\u0000-\u0020\u007f]/.test`.
- Kết quả: `secretId.trim()`.
- Lỗi trực tiếp có thông điệp cố định: `A valid AWS Secrets Manager secret ID or ARN is required`.

### awsSecretRevisionStage

`awsSecretRevisionStage(version)` · [Dòng 16–23](../../../src/cloud-secrets-aws.mjs#L16)

- Lời gọi trong thân hàm: `VERSION.test`.
- Kết quả: `stage`.
- Lỗi trực tiếp có thông điệp cố định: `AWS secret revision must be a canonical decimal string`, `AWS secret revision stage exceeds 256 characters`.

### decodeSecretValue

`decodeSecretValue(response)` · [Dòng 25–55](../../../src/cloud-secrets-aws.mjs#L25)

- Lời gọi trong thân hàm: `Buffer.byteLength`, `Buffer.isBuffer`, `Buffer.from`.
- Kết quả: `raw`.
- Lỗi trực tiếp có thông điệp cố định: `AWS Secrets Manager returned an invalid response`, `AWS Secrets Manager must return exactly one string or binary secret value`, `AWS cloud secret bundle must be between 1 byte and 64 KiB`, `AWS Secrets Manager returned an unsupported binary value`.

### validateAuditKeyRing

`validateAuditKeyRing(ring)` · [Dòng 57–79](../../../src/cloud-secrets-aws.mjs#L57)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.getPrototypeOf`, `Object.keys`, `keyIds.includes`, `Buffer.byteLength`, `createHash`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `AWS cloud secret bundle contains an invalid audit key ring`, `AWS cloud secret bundle is missing its active audit key`, `AWS cloud secret bundle contains an invalid audit key fingerprint`.

### parseCloudSecret

`parseCloudSecret(raw, expectedVersion)` · [Dòng 81–114](../../../src/cloud-secrets-aws.mjs#L81)

- Lời gọi trong thân hàm: `JSON.parse`, `Array.isArray`, `Object.getPrototypeOf`, `Object.keys`, `VERSION.test`, `validateAuditKeyRing`, `createCloudAuth`.
- Kết quả: `{version, tokens, auditKeyRing}`.
- Lỗi trực tiếp có thông điệp cố định: `AWS cloud secret bundle is not valid JSON`, `AWS cloud secret bundle must use schemaVersion 1 with revision, tokens and auditKeyRing`, `AWS Secrets Manager did not return the pinned secret revision`, `AWS cloud secret bundle contains an invalid bearer-token registry`.

### createAwsSecretsManagerAdapter

`createAwsSecretsManagerAdapter({ client, GetSecretValueCommand, secretId, } = {})` · [Dòng 132–172](../../../src/cloud-secrets-aws.mjs#L132)

- Lời gọi trong thân hàm: `validateSecretId`, `Object.freeze`.
- Kết quả: `{readCloudSecrets}`.
- Lỗi trực tiếp có thông điệp cố định: `AWS Secrets Manager requires an SDK client and GetSecretValueCommand`.

### createAwsSecretsManagerAdapter → readCloudSecrets

`readCloudSecrets(options)` · [Dòng 144–170](../../../src/cloud-secrets-aws.mjs#L144)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.getPrototypeOf`, `Object.keys`, `VERSION.test`, `awsSecretRevisionStage`, `client.send`, `parseCloudSecret`, `decodeSecretValue`.
- Kết quả: `parseCloudSecret(decodeSecretValue(response), expectedVersion)`.
- Lỗi trực tiếp có thông điệp cố định: `AWS cloud secret read options must contain one valid version`, `AWS Secrets Manager read failed`.

### createDefaultAwsSecretsManagerAdapter

`createDefaultAwsSecretsManagerAdapter({ region, secretId } = {})` · [Dòng 180–203](../../../src/cloud-secrets-aws.mjs#L180)

- Lời gọi trong thân hàm: `validateSecretId`, `createAwsSecretsManagerAdapter`, `Object.freeze`.
- Kết quả: `{readCloudSecrets, close}`.
- Lỗi trực tiếp có thông điệp cố định: `A valid AWS region is required for Secrets Manager`, `Install @aws-sdk/client-secrets-manager in the cloud host before using AWS Secrets Manager`.

### createDefaultAwsSecretsManagerAdapter → close

`close()` · [Dòng 199–201](../../../src/cloud-secrets-aws.mjs#L199)

- Lời gọi trong thân hàm: `client.destroy`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### assertPublishLease

`assertPublishLease(lease)` · [Dòng 206–215](../../../src/cloud-secrets-aws.mjs#L206)

- Lời gọi trong thân hàm: `lease.assertHeld`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `AWS secret publication requires an active distributed lease`, `AWS secret publication lease is no longer valid`.

### sameCloudSnapshot

`sameCloudSnapshot(left, right)` · [Dòng 217–225](../../../src/cloud-secrets-aws.mjs#L217)

- Lời gọi trong thân hàm: `JSON.stringify`.
- Kết quả: `JSON.stringify({ tokens: left.tokens, auditKeyRing: left.auditKeyRing, }) === JSON.stringify({ tokens: righ…`.

### createAwsSecretsManagerPublisher

`createAwsSecretsManagerPublisher({ client, GetSecretValueCommand, DescribeSecretCommand, PutSecretValueCommand, secretId, publishLock, } = {})` · [Dòng 235–370](../../../src/cloud-secrets-aws.mjs#L235)

- Lời gọi trong thân hàm: `validateSecretId`, `createAwsSecretsManagerAdapter`, `Object.freeze`.
- Kết quả: `{readCloudSecrets, publishCloudSecretSnapshot}`.
- Lỗi trực tiếp có thông điệp cố định: `AWS Secrets Manager publisher requires an SDK client, DescribeSecretCommand and PutSecretValueCommand`, `AWS secret publishing requires a durable distributed publishLock`.

### createAwsSecretsManagerPublisher → publishCloudSecretSnapshot

`publishCloudSecretSnapshot({ snapshot, expectedCurrentVersion, clientRequestToken, } = {})` · [Dòng 260–368](../../../src/cloud-secrets-aws.mjs#L260)

- Lời gọi trong thân hàm: `VERSION.test`, `BigInt`, `awsSecretRevisionStage`, `JSON.stringify`, `Buffer.byteLength`, `parseCloudSecret`, `randomUUID`, `publishLock.withLock`.
- Kết quả: `publishLock.withLock(…)`.
- Lỗi trực tiếp có thông điệp cố định: `A valid expected current secret revision is required`, `AWS cloud secret snapshot is not serializable`, `AWS cloud secret bundle must be between 1 byte and 64 KiB`, `AWS ClientRequestToken must contain 32 to 64 safe characters`.

### createDefaultAwsSecretsManagerPublisher

`createDefaultAwsSecretsManagerPublisher({ region, secretId, publishLock, } = {})` · [Dòng 377–411](../../../src/cloud-secrets-aws.mjs#L377)

- Lời gọi trong thân hàm: `validateSecretId`, `createAwsSecretsManagerPublisher`, `Object.freeze`.
- Kết quả: `{readCloudSecrets, publishCloudSecretSnapshot, close}`.
- Lỗi trực tiếp có thông điệp cố định: `A valid AWS region is required for Secrets Manager`, `AWS secret publishing requires a durable distributed publishLock`, `Install @aws-sdk/client-secrets-manager in the cloud host before using AWS Secrets Manager`.

### createDefaultAwsSecretsManagerPublisher → close

`close()` · [Dòng 407–409](../../../src/cloud-secrets-aws.mjs#L407)

- Lời gọi trong thân hàm: `client.destroy`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
