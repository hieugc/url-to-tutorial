# cloud-bootstrap.mjs

[Mở module nguồn](../../../src/cloud-bootstrap.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validateSecretSnapshot

`validateSecretSnapshot(snapshot)` · [Dòng 6–21](../../../src/cloud-bootstrap.mjs#L6)

- Lời gọi trong thân hàm: `Array.isArray`.
- Kết quả: `snapshot`.
- Lỗi trực tiếp có thông điệp cố định: `Secret manager must return a non-empty versioned cloud secret snapshot`, `Secret manager snapshot must contain at least one cloud token`, `Secret manager snapshot must contain a versioned audit key ring`.

### digestTokens

`digestTokens(tokens)` · [Dòng 23–38](../../../src/cloud-bootstrap.mjs#L23)

- Lời gọi trong thân hàm: `tokens.map`, `createHash`, `JSON.stringify`.
- Kết quả: `createHash('sha256').update(JSON.stringify(normalized)).digest('hex')`.

### auditKeyRingMetadata

`auditKeyRingMetadata(ring)` · [Dòng 40–66](../../../src/cloud-bootstrap.mjs#L40)

- Lời gọi trong thân hàm: `Object.keys`, `keyIds.includes`, `Buffer.isBuffer`, `Buffer.from`, `createHash`, `JSON.stringify`, `keyIds.map`, `Object.freeze`.
- Kết quả: `{activeKeyId, keyIds, keyMaterialDigest}`.
- Lỗi trực tiếp có thông điệp cố định: `Secret manager audit key ring does not include its active key`, `Secret manager audit key entries must use 16-hex IDs and string/Buffer keys`, `Secret manager audit key fingerprint does not match its key material`.

### readCloudSecrets

`readCloudSecrets(secretManager, options)` · [Dòng 68–77](../../../src/cloud-bootstrap.mjs#L68)

- Lời gọi trong thân hàm: `secretManager.readCloudSecrets`.
- Kết quả: `options === undefined ? await secretManager.readCloudSecrets() : await secretManager.readCloudSecrets(options)`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud secret manager read failed`.

### authorizeOperator

`authorizeOperator(operatorAuthenticator, context, action, constraints = {})` · [Dòng 79–94](../../../src/cloud-bootstrap.mjs#L79)

- Lời gọi trong thân hàm: `operatorAuthenticator.authorize`, `OPERATOR_ID.test`.
- Kết quả: `identity.actorId`.
- Lỗi trực tiếp có thông điệp cố định: `An authenticated operator workflow is required for cloud secret reload`, `Cloud secret reload operator authorization failed`, `Cloud secret reload requires an MFA-verified operator identity`.

### createCloudStudioFromSecretManager

`createCloudStudioFromSecretManager({ secretManager, operatorAuthenticator, serverOptions = {}, createStudioServerImpl = createStudioServer, } = {})` · [Dòng 103–256](../../../src/cloud-bootstrap.mjs#L103)

- Lời gọi trong thân hàm: `Array.isArray`, `validateSecretSnapshot`, `readCloudSecrets`, `digestTokens`, `auditKeyRingMetadata`, `createStudioServerImpl`, `studio.auditAdmin.keyMetadata`, `JSON.stringify`, `[...liveKeyRing.keyIds].sort`, `studio.store?.close`, `studio.jobs.values`, `reconcileNetworks`, `studio.tokenAdmin.list`, `Object.freeze`.
- Kết quả: `{server, status, reloadTokens, archiveAuditBatch}`.
- Lỗi trực tiếp có thông điệp cố định: `A secret manager with readCloudSecrets() is required`, `Cloud server options must be an object`, `createStudioServerImpl must be a function`, `Cloud server factory did not return the trusted token/audit administration capabilities`, `Cloud server audit key ring does not match the secret manager snapshot`, `Cloud Studio did not expose its recovered job inventory`, `Docker network reconciliation was incomplete`, `Cloud Docker network recovery failed; refusing to start the Cloud API`.

### createCloudStudioFromSecretManager → status

`status()` · [Dòng 168–175](../../../src/cloud-bootstrap.mjs#L168)

- Lời gọi trong thân hàm: `Object.freeze`, `tokenMetadata.map`, `studio.auditAdmin.keyMetadata`.
- Kết quả: `{secretVersion, tokenCount, tokenIds, auditKeyRing}`.

### createCloudStudioFromSecretManager → reloadTokens

`reloadTokens(context, options = {})` · [Dòng 177–243](../../../src/cloud-bootstrap.mjs#L177)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.getPrototypeOf`, `Object.keys`, `authorizeOperator`, `validateSecretSnapshot`, `readCloudSecrets`, `BigInt`, `auditKeyRingMetadata`, `JSON.stringify`, `[...nextRing.keyIds].sort`, `digestTokens`, `studio.tokenAdmin.replace`, `status`.
- Kết quả: `status()`.
- Lỗi trực tiếp có thông điệp cố định: `A cloud credential reload is already in progress`, `Cloud credential reload options are invalid`, `A valid pinned secret version is required`, `A valid credential rollout ID is required`, `A valid credential replica ID is required`, `Secret manager did not return the pinned credential revision`, `Secret manager returned an older snapshot revision; refusing credential rollback`, `Audit key ring changes require the separate staged key-rotation workflow`, `Secret manager changed credentials without advancing the snapshot version`.
