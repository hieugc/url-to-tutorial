# cloud-rollout.mjs

[Mở module nguồn](../../../src/cloud-rollout.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### requireFunction

`requireFunction(value, name)` · [Dòng 7–11](../../../src/cloud-rollout.mjs#L7)

- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### hash

`hash(value)` · [Dòng 13–15](../../../src/cloud-rollout.mjs#L13)

- Lời gọi trong thân hàm: `createHash`.
- Kết quả: `createHash('sha256').update(value).digest('hex')`.

### inspectSnapshot

`inspectSnapshot(snapshot)` · [Dòng 17–92](../../../src/cloud-rollout.mjs#L17)

- Lời gọi trong thân hàm: `Array.isArray`, `VERSION.test`, `IDENTIFIER.test`, `tokenIds.push`, `normalizedTokens.push`, `[...token.projectIds].sort`, `tokenIds.sort`, `normalizedTokens.sort`, `Object.keys`, `keyIds.includes`, `Buffer.isBuffer`, `Buffer.from`, `hash`, `keyFingerprints.push`, `Object.freeze`, `JSON.stringify`.
- Kết quả: `{version, tokenIds, auditKeyRing, snapshotDigest}`.
- Lỗi trực tiếp có thông điệp cố định: `Secret manager returned an invalid versioned credential snapshot`, `Secret manager returned an invalid credential entry`, `Secret manager returned an invalid credential identity`, `Secret manager returned duplicate credential IDs`, `Secret manager returned an invalid audit signing-key ring`, `Secret manager audit key ring is missing its active key`, `Secret manager returned an invalid audit signing key`, `Secret manager audit signing-key fingerprint mismatch`.

### readSnapshot

`readSnapshot(secretManager, version)` · [Dòng 94–102](../../../src/cloud-rollout.mjs#L94)

- Lời gọi trong thân hàm: `secretManager.readCloudSecrets`.
- Kết quả: `await secretManager.readCloudSecrets( version === undefined ? undefined : { version }, )`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud secret manager read failed`.

### authorize

`authorize(operatorAuthenticator, context, action)` · [Dòng 104–116](../../../src/cloud-rollout.mjs#L104)

- Lời gọi trong thân hàm: `operatorAuthenticator.authorize`, `OPERATOR_ID.test`, `Object.freeze`.
- Kết quả: `{actorId, mfaVerified}`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud credential rollout authorization failed`, `Cloud credential rollout requires an MFA-verified operator`.

### validateReplicaList

`validateReplicaList(replicas)` · [Dòng 118–135](../../../src/cloud-rollout.mjs#L118)

- Lời gọi trong thân hàm: `Array.isArray`, `IDENTIFIER.test`, `ids.push`, `[...replicas].sort`.
- Kết quả: `[...replicas].sort((a, b) => a.id.localeCompare(b.id))`.
- Lỗi trực tiếp có thông điệp cố định: `No cloud API replicas are registered for credential rollout`, `Replica directory returned an invalid replica adapter`, `Replica directory returned duplicate replica IDs`.

### normalizeRecord

`normalizeRecord(record, rolloutId)` · [Dòng 137–161](../../../src/cloud-rollout.mjs#L137)

- Lời gọi trong thân hàm: `VERSION.test`, `String`, `Array.isArray`, `['in_progress', 'partial'].includes`, `record.replicaIds.some`, `acknowledged.some`, `[...record.replicaIds].sort`.
- Kết quả: `{…, targetVersion, replicaIds, acknowledgedReplicaIds}`.
- Lỗi trực tiếp có thông điệp cố định: `Credential rollout record is missing or is not resumable`, `Credential rollout record metadata is invalid`, `Credential rollout record contains an unknown replica acknowledgement`.

### statusMatches

`statusMatches(status, snapshot)` · [Dòng 163–173](../../../src/cloud-rollout.mjs#L163)

- Lời gọi trong thân hàm: `Array.isArray`, `JSON.stringify`, `[...status.tokenIds].sort`, `Boolean`, `[...ring.keyIds].sort`.
- Kết quả: `false`, `Boolean(…)`.

### safeErrorCode

`safeErrorCode(error)` · [Dòng 175–178](../../../src/cloud-rollout.mjs#L175)

- Kết quả: `/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'REPLICA_OPERATION_FAILED'`.

### mapLimit

`mapLimit(items, limit, worker)` · [Dòng 180–192](../../../src/cloud-rollout.mjs#L180)

- Lời gọi trong thân hàm: `Array.from`, `Math.min`, `Promise.all`.
- Kết quả: `results`.

### validateStore

`validateStore(store)` · [Dòng 194–199](../../../src/cloud-rollout.mjs#L194)

- Lời gọi trong thân hàm: `requireFunction`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### validateLease

`validateLease(result)` · [Dòng 201–207](../../../src/cloud-rollout.mjs#L201)

- Kết quả: `result.leaseToken`.
- Lỗi trực tiếp có thông điệp cố định: `Durable rollout store did not issue a valid fencing token`.

### runCloudCredentialRollout

`runCloudCredentialRollout({ secretManager, operatorAuthenticator, replicaDirectory, rolloutStore, context, rolloutId, concurrency = 4, now = () => Date.now(), } = {})` · [Dòng 221–489](../../../src/cloud-rollout.mjs#L221)

- Lời gọi trong thân hàm: `requireFunction`, `validateStore`, `Number.isInteger`, `normalizeRecord`, `rolloutStore.getRollout`, `authorize`, `readSnapshot`, `inspectSnapshot`, `validateReplicaList`, `replicaDirectory.list`, `replicas.map`, `JSON.stringify`, `randomUUID`, `validateLease`, `rolloutStore.beginRollout`, `rolloutStore.resumeRollout`, `Promise.resolve`, `Number.isSafeInteger`, `setInterval`, `renewalTimer.unref`, `mapLimit`, `clearInterval`, `assertLeaseAvailable`, `failures.map`, `completed .filter`, `rolloutStore.markPartialRollout`, `Object.freeze`, `rolloutStore.completeRollout`.
- Kết quả: `{rolloutId, state, targetVersion, totalReplicas, acknowledgedReplicaIds, failedReplicaIds}`.
- Lỗi trực tiếp có thông điệp cố định: `Credential rollout concurrency must be an integer from 1 to 32`, `now must be a function`, `A valid rollout ID is required when resuming`, `Credential rollout cannot be resumed`, `Pinned secret revision no longer matches the recorded rollout; refusing resume`, `Cloud API replica inventory is unavailable or invalid`, `Replica inventory changed; start a new rollout instead of resuming`, `Credential rollout could not acquire its durable rollout record`, `Credential rollout is already leased or cannot be resumed`, `Credential rollout record could not be read after initialization`, `Credential rollout record does not match the pinned secret revision and replica set`, `Partial credential rollout state could not be persisted`, `Credential rollout acknowledgements are complete but finalization failed`.

### runCloudCredentialRollout → assertLeaseAvailable

`assertLeaseAvailable()` · [Dòng 327–333](../../../src/cloud-rollout.mjs#L327)

- Lời gọi trong thân hàm: `Object.assign`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
