# job-store.mjs

[Mở module nguồn](../../../src/job-store.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### terminal

`terminal(job)` · [Dòng 9–9](../../../src/job-store.mjs#L9)

- Lời gọi trong thân hàm: `['completed', 'failed', 'cancelled', 'interrupted'].includes`.
- Kết quả: `['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)`.

### StudioJobStore → constructor

`constructor(outputRoot, { auditKey = null, auditKeyRing = null } = {})` · [Dòng 12–192](../../../src/job-store.mjs#L12)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.entries`, `Buffer.isBuffer`, `Buffer.from`, `createHash`, `this.auditKeys.set`, `this.auditKeys.has`, `this.auditKeys.get`, `path.resolve`, `mkdirSync`, `path.join`, `this.db.exec`, `this.db.prepare`, `auditColumns.has`, `this.initializeAuditChain`, `this.db.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Configure either auditKey or auditKeyRing, not both`, `Cloud audit key ring requires activeKeyId and a keys object`, `Cloud audit key ring entries require 16-hex IDs and string/Buffer keys`, `Cloud audit keys must contain at least 32 bytes`, `Cloud audit key ID must match the SHA-256 key fingerprint`, `Active cloud audit key is missing from the key ring`, `Cloud audit signing key must be a string or Buffer`, `Cloud audit signing key must contain at least 32 bytes`.

### StudioJobStore → save

`save(job)` · [Dòng 194–200](../../../src/job-store.mjs#L194)

- Lời gọi trong thân hàm: `this.put.run`, `JSON.stringify`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### StudioJobStore → reserveCloudStorage

`reserveCloudStorage(jobId, tenantId, bytes, budgetBytes, createdAt)` · [Dòng 202–216](../../../src/job-store.mjs#L202)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `this.storageTotalsStatement.get`, `Number`, `this.reserveCloudStorageStatement.run`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Invalid cloud storage reservation`.

### StudioJobStore → finalizeCloudUsage

`finalizeCloudUsage(job, { workerMs, artifactBytes, costMicros = 0, period, outcome } = {}, auditEvent = null)` · [Dòng 218–241](../../../src/job-store.mjs#L218)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `this.db.exec`, `this.deleteCloudStorageReservationStatement.run`, `this.insertCloudStorageStatement.run`, `this.insertCloudUsageStatement.run`, `this.insertCloudAudit`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Invalid cloud usage finalization`.

### StudioJobStore → hasCloudUsage

`hasCloudUsage(jobId)` · [Dòng 243–245](../../../src/job-store.mjs#L243)

- Lời gọi trong thân hàm: `Boolean`, `this.hasCloudUsageStatement.get`.
- Kết quả: `Boolean(this.hasCloudUsageStatement.get(jobId))`.

### StudioJobStore → cloudUsage

`cloudUsage(tenantId, period)` · [Dòng 247–255](../../../src/job-store.mjs#L247)

- Lời gọi trong thân hàm: `this.monthlyUsageStatement.get`, `this.storageTotalsStatement.get`, `Number`.
- Kết quả: `{period, jobs, workerMs, artifactBytes, costMicros, storageBytes, reservedStorageBytes}`.

### StudioJobStore → deleteCloudUsage

`deleteCloudUsage(jobId)` · [Dòng 257–268](../../../src/job-store.mjs#L257)

- Lời gọi trong thân hàm: `this.db.exec`, `this.deleteCloudStorageReservationStatement.run`, `this.deleteCloudStorageUsageStatement.run`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### StudioJobStore → saveCloudSubmission

`saveCloudSubmission(job, auditEvent = null, storage = null)` · [Dòng 270–299](../../../src/job-store.mjs#L270)

- Lời gọi trong thân hàm: `this.db.exec`, `this.put.run`, `JSON.stringify`, `this.recordCloudSubmission.run`, `this.monthlyUsageStatement.get`, `this.monthlyReservationsStatement.get`, `Number`, `this.reserveCloudStorage`, `this.insertCloudAudit`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Cloud submission requires job, tenant and project identity`.

### StudioJobStore → countCloudSubmissions

`countCloudSubmissions(tenantId, since)` · [Dòng 301–304](../../../src/job-store.mjs#L301)

- Lời gọi trong thân hàm: `this.countCloudSubmissionsStatement.get`, `Number`.
- Kết quả: `Number(result?.count || 0)`.

### StudioJobStore → pruneCloudSubmissions

`pruneCloudSubmissions(before)` · [Dòng 306–308](../../../src/job-store.mjs#L306)

- Lời gọi trong thân hàm: `this.pruneCloudSubmissionsStatement.run`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### StudioJobStore → consumeCloudRequest

`consumeCloudRequest(tenantId, now, windowMs, limit)` · [Dòng 310–336](../../../src/job-store.mjs#L310)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `this.db.exec`, `this.pruneCloudRequestsStatement.run`, `this.countCloudRequestsStatement.get`, `Number`, `Math.max`, `Math.ceil`, `this.insertCloudRequestStatement.run`, `randomUUID`.
- Kết quả: `{allowed, retryAfterSeconds}`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid durable cloud request quota arguments`.

### StudioJobStore → legacyAuditEventHash

`legacyAuditEventHash(sequence, previousHash, event)` · [Dòng 338–349](../../../src/job-store.mjs#L338)

- Lời gọi trong thân hàm: `this.auditKeys.get`, `JSON.stringify`, `createHmac`, `String`.
- Kết quả: `createHmac('sha256', key) .update(String(sequence) + '\\n' + previousHash + '\\n' + payload, 'utf8') .digest('hex')`.
- Lỗi trực tiếp có thông điệp cố định: `Legacy audit key is required to verify pre-key-ID events`.

### StudioJobStore → auditEventHash

`auditEventHash(sequence, previousHash, event)` · [Dòng 351–362](../../../src/job-store.mjs#L351)

- Lời gọi trong thân hàm: `this.auditKeys.get`, `JSON.stringify`, `createHmac`, `String`.
- Kết quả: `createHmac('sha256', key) .update(String(sequence) + '\\n' + previousHash + '\\n' + payload, 'utf8') .digest('hex')`.

### StudioJobStore → insertCloudAudit

`insertCloudAudit(event)` · [Dòng 364–396](../../../src/job-store.mjs#L364)

- Lời gọi trong thân hàm: `this.auditKeys.has`, `['success', 'denied', 'failed'].includes`, `JSON.stringify`, `Buffer.byteLength`, `Number.isFinite`, `Date.parse`, `randomUUID`, `this.auditStateStatement.get`, `Number`, `this.auditEventHash`, `this.insertCloudAuditStatement.run`, `this.updateAuditStateStatement.run`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Cloud audit signing key is not configured`, `Invalid cloud audit event`, `Cloud audit details exceed 4 KiB`, `Cloud audit createdAt must be a valid date string`.

### StudioJobStore → initializeAuditChain

`initializeAuditChain()` · [Dòng 398–468](../../../src/job-store.mjs#L398)

- Lời gọi trong thân hàm: `this.legacyAuditRowsStatement.all`, `this.auditStateStatement.get`, `this.auditRowsStatement.all`, `chainRows.filter`, `Number`, `this.auditArchiveStateStatement.get`, `Buffer.from`, `this.legacyAuditEventHash`, `timingSafeEqual`, `this.db.exec`, `this.auditEventHash`, `this.updateAuditRowStatement.run`, `this.updateAuditStateStatement.run`, `chainRows.some`, `this.verifyCloudAuditChain`.
- Kết quả: `void`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud audit integrity verification failed: chain state has no events`, `Cloud audit key-ID migration requires the external archive checkpoint to be zero`, `Cloud audit integrity verification failed: unsigned events conflict with chain state`, `Cloud audit integrity verification failed: legacy event signature mismatch`, `Cloud audit integrity verification failed: legacy checkpoint mismatch`, `Cloud audit integrity verification failed: partial or missing signatures`.

### StudioJobStore → verifyCloudAuditChain

`verifyCloudAuditChain()` · [Dòng 470–493](../../../src/job-store.mjs#L470)

- Lời gọi trong thân hàm: `this.auditRowsStatement.all`, `this.auditKeys.has`, `Buffer.from`, `this.auditEventHash`, `timingSafeEqual`, `this.auditStateStatement.get`, `Number`.
- Kết quả: `{valid, reason}`, `{valid, reason, sequence}`, `{valid, count, lastSequence, lastHash}`.

### StudioJobStore → rotateAuditSigningKey

`rotateAuditSigningKey({ keyId, key, actorId = 'operator' } = {})` · [Dòng 495–535](../../../src/job-store.mjs#L495)

- Lời gọi trong thân hàm: `this.verifyCloudAuditChain`, `Buffer.isBuffer`, `Buffer.from`, `createHash`, `this.auditKeys.get`, `timingSafeEqual`, `this.auditKeys.set`, `this.recordCloudAudit`, `this.auditKeys.delete`.
- Kết quả: `{previousKeyId, activeKeyId}`.
- Lỗi trực tiếp có thông điệp cố định: `Cannot rotate an unverified audit signing key ring`, `New audit key requires a 16-hex keyId and string/Buffer key`, `New audit signing key must contain at least 32 bytes`, `New audit key ID must match the SHA-256 key fingerprint`, `Audit signing key is already active`, `Audit key ID is already bound to a different key`, `Audit key rotation actorId is invalid`.

### StudioJobStore → auditKeyRingMetadata

`auditKeyRingMetadata()` · [Dòng 537–539](../../../src/job-store.mjs#L537)

- Lời gọi trong thân hàm: `this.auditKeys.keys`.
- Kết quả: `{activeKeyId, keyIds}`.

### StudioJobStore → recordCloudAudits

`recordCloudAudits(events)` · [Dòng 541–552](../../../src/job-store.mjs#L541)

- Lời gọi trong thân hàm: `Array.isArray`, `this.db.exec`, `this.insertCloudAudit`.
- Kết quả: `void`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud audit events must be an array`.

### StudioJobStore → recordCloudAudit

`recordCloudAudit(event)` · [Dòng 554–556](../../../src/job-store.mjs#L554)

- Lời gọi trong thân hàm: `this.recordCloudAudits`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### StudioJobStore → cloudAuditArchiveBatch

`cloudAuditArchiveBatch(limit = 500)` · [Dòng 558–588](../../../src/job-store.mjs#L558)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `this.auditArchiveStateStatement.get`, `this.verifyCloudAuditChain`, `Number`, `this.auditArchiveEventAtSequenceStatement.get`, `this.auditArchiveBatchStatement.all`, `events.at`.
- Kết quả: `{previousSequence, previousHash, events, throughSequence, throughHash}`.
- Lỗi trực tiếp có thông điệp cố định: `Audit archive batch limit must be between 1 and 5000`, `Audit archive checkpoint is ahead of the local ledger`, `Audit archive checkpoint does not match the local ledger`, `Empty audit archive checkpoint has an invalid hash`.

### StudioJobStore → commitCloudAuditArchiveCheckpoint

`commitCloudAuditArchiveCheckpoint({ expectedPreviousSequence, throughSequence, throughHash } = {})` · [Dòng 590–617](../../../src/job-store.mjs#L590)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `this.db.exec`, `this.auditArchiveStateStatement.get`, `Number`, `this.auditArchiveEventAtSequenceStatement.get`, `this.updateAuditArchiveStateStatement.run`.
- Kết quả: `{lastArchivedSequence, lastArchivedHash}`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid external audit archive checkpoint`, `Audit archive checkpoint changed concurrently; fetch a new batch`, `External archive acknowledgement does not match the local audit chain`.

### StudioJobStore → cloudAuditEvents

`cloudAuditEvents(tenantId)` · [Dòng 619–624](../../../src/job-store.mjs#L619)

- Lời gọi trong thân hàm: `this.listCloudAuditStatement.all`.
- Kết quả: `this.listCloudAuditStatement.all(tenantId).map(…)`.

### StudioJobStore → all

`all()` · [Dòng 626–631](../../../src/job-store.mjs#L626)

- Lời gọi trong thân hàm: `this.db.prepare`.
- Kết quả: `this.db.prepare('SELECT json FROM studio_jobs ORDER BY created_at, rowid') .all().map(row => JSON.parse(row.json))`.

### StudioJobStore → recover

`recover()` · [Dòng 633–644](../../../src/job-store.mjs#L633)

- Lời gọi trong thân hàm: `this.all`, `['queued', 'running'].includes`, `this.save`.
- Kết quả: `jobs`.

### StudioJobStore → delete

`delete(id)` · [Dòng 646–649](../../../src/job-store.mjs#L646)

- Lời gọi trong thân hàm: `this.deleteStatement.run`, `this.deleteCloudUsage`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### StudioJobStore → expired

`expired(now = Date.now())` · [Dòng 651–655](../../../src/job-store.mjs#L651)

- Lời gọi trong thân hàm: `this.all`.
- Kết quả: `this.all().filter(job => terminal(job) && now - Date.parse(job.finishedAt || job.createdAt) > RETENTION_MS)`.

### StudioJobStore → trim

`trim()` · [Dòng 657–662](../../../src/job-store.mjs#L657)

- Lời gọi trong thân hàm: `this.all`, `jobs.filter`, `Math.max`, `this.delete`, `excess.map`.
- Kết quả: `excess.map(({ id }) => id)`.

### StudioJobStore → close

`close()` · [Dòng 664–664](../../../src/job-store.mjs#L664)

- Lời gọi trong thân hàm: `this.db.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
