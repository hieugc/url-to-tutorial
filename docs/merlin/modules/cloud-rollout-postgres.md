# cloud-rollout-postgres.mjs

[Mở module nguồn](../../../src/cloud-rollout-postgres.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validatePool

`validatePool(pool)` · [Dòng 10–14](../../../src/cloud-rollout-postgres.mjs#L10)

- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `A connect-capable PostgreSQL pool is required`.

### validateLeaseMs

`validateLeaseMs(leaseMs)` · [Dòng 16–20](../../../src/cloud-rollout-postgres.mjs#L16)

- Lời gọi trong thân hàm: `Number.isSafeInteger`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `leaseMs must be between 1 second and 30 minutes`.

### validateReplicaIds

`validateReplicaIds(replicaIds, { allowEmpty = false } = {})` · [Dòng 22–29](../../../src/cloud-rollout-postgres.mjs#L22)

- Lời gọi trong thân hàm: `Array.isArray`, `replicaIds.some`, `[...replicaIds].sort`.
- Kết quả: `[...replicaIds].sort()`.
- Lỗi trực tiếp có thông điệp cố định: `A unique non-empty replica ID list is required`.

### parseLeaseToken

`parseLeaseToken(token)` · [Dòng 31–38](../../../src/cloud-rollout-postgres.mjs#L31)

- Lời gọi trong thân hàm: `token.match`.
- Kết quả: `{ownerId, fencingToken}`.
- Lỗi trực tiếp có thông điệp cố định: `Rollout lease token is invalid`.

### assertInput

`assertInput(input, fields)` · [Dòng 40–45](../../../src/cloud-rollout-postgres.mjs#L40)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.keys`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Rollout store input is invalid`.

### transaction

`transaction(pool, operation)` · [Dòng 47–66](../../../src/cloud-rollout-postgres.mjs#L47)

- Lời gọi trong thân hàm: `pool.connect`, `client.query`, `operation`, `client.release`.
- Kết quả: `result`.
- Lỗi trực tiếp có thông điệp cố định: `Another credential rollout is already active`, `Rollout store rejected invalid metadata`.

### safeStoreError

`safeStoreError()` · [Dòng 68–70](../../../src/cloud-rollout-postgres.mjs#L68)

- Kết quả: `new Error('Durable credential rollout storage is unavailable')`.

### requireLease

`requireLease(client, input, lease)` · [Dòng 72–84](../../../src/cloud-rollout-postgres.mjs#L72)

- Lời gọi trong thân hàm: `client.query`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Rollout lease expired or fencing token no longer owns the record`.

### createPostgresRolloutStore

`createPostgresRolloutStore({ pool, leaseMs = 300_000 } = {})` · [Dòng 86–355](../../../src/cloud-rollout-postgres.mjs#L86)

- Lời gọi trong thân hàm: `validatePool`, `validateLeaseMs`, `Object.freeze`, `Math.max`, `Math.floor`.
- Kết quả: `{beginRollout, getRollout, resumeRollout, renewRollout, renewIntervalMs, recordReplicaAck, recordReplicaFailure, markPartialRollout, completeRollout}`.

### createPostgresRolloutStore → run

`run(operation)` · [Dòng 90–100](../../../src/cloud-rollout-postgres.mjs#L90)

- Lời gọi trong thân hàm: `transaction`, `error.message?.startsWith`, `safeStoreError`.
- Kết quả: `await transaction(pool, operation)`.

### createPostgresRolloutStore → beginRollout

`beginRollout(input)` · [Dòng 102–130](../../../src/cloud-rollout-postgres.mjs#L102)

- Lời gọi trong thân hàm: `assertInput`, `ROLLOUT_ID.test`, `VERSION.test`, `DIGEST.test`, `ACTOR_ID.test`, `validateReplicaIds`, `randomUUID`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Rollout metadata is invalid`.

### createPostgresRolloutStore → getRollout

`getRollout(rolloutId)` · [Dòng 132–160](../../../src/cloud-rollout-postgres.mjs#L132)

- Lời gọi trong thân hàm: `ROLLOUT_ID.test`, `pool.query`, `safeStoreError`, `row.snapshot_digest.trim`, `Object.keys`.
- Kết quả: `null`, `{rolloutId, targetVersion, snapshotDigest, actorId, replicaIds, state, acknowledgedReplicaIds, acknowledgements, failures, failedReplicaIds}`.
- Lỗi trực tiếp có thông điệp cố định: `A valid rollout ID is required`.

### createPostgresRolloutStore → resumeRollout

`resumeRollout(input)` · [Dòng 162–185](../../../src/cloud-rollout-postgres.mjs#L162)

- Lời gọi trong thân hàm: `assertInput`, `ROLLOUT_ID.test`, `ACTOR_ID.test`, `randomUUID`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Rollout resume identity is invalid`.

### createPostgresRolloutStore → renewRollout

`renewRollout(input)` · [Dòng 187–207](../../../src/cloud-rollout-postgres.mjs#L187)

- Lời gọi trong thân hàm: `assertInput`, `ROLLOUT_ID.test`, `parseLeaseToken`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `A valid rollout ID is required`.

### createPostgresRolloutStore → recordReplicaAck

`recordReplicaAck(input)` · [Dòng 209–241](../../../src/cloud-rollout-postgres.mjs#L209)

- Lời gọi trong thân hàm: `assertInput`, `parseLeaseToken`, `REPLICA_ID.test`, `VERSION.test`, `ACTOR_ID.test`, `Array.isArray`, `input.tokenIds.some`, `input.auditKeyRing.keyIds.some`, `input.auditKeyRing.keyIds.includes`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Replica acknowledgement metadata is invalid`.

### createPostgresRolloutStore → recordReplicaFailure

`recordReplicaFailure(input)` · [Dòng 243–267](../../../src/cloud-rollout-postgres.mjs#L243)

- Lời gọi trong thân hàm: `assertInput`, `parseLeaseToken`, `REPLICA_ID.test`, `VERSION.test`, `ACTOR_ID.test`, `ERROR_CODE.test`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Replica failure metadata is invalid`.

### createPostgresRolloutStore → markPartialRollout

`markPartialRollout(input)` · [Dòng 269–300](../../../src/cloud-rollout-postgres.mjs#L269)

- Lời gọi trong thân hàm: `assertInput`, `parseLeaseToken`, `validateReplicaIds`, `VERSION.test`, `ACTOR_ID.test`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Partial rollout metadata is invalid`.

### createPostgresRolloutStore → completeRollout

`completeRollout(input)` · [Dòng 302–342](../../../src/cloud-rollout-postgres.mjs#L302)

- Lời gọi trong thân hàm: `assertInput`, `parseLeaseToken`, `validateReplicaIds`, `VERSION.test`, `ACTOR_ID.test`, `run`.
- Kết quả: `run(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Rollout completion metadata is invalid`.
