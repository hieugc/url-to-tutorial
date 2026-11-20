# studio-server.mjs

[Mở module nguồn](../../../src/studio-server.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### json

`json(res, status, data)` · [Dòng 27–32](../../../src/studio-server.mjs#L27)

- Lời gọi trong thân hàm: `JSON.stringify`, `res.writeHead`, `Buffer.byteLength`, `res.end`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### bad

`bad(message, statusCode = 400)` · [Dòng 34–36](../../../src/studio-server.mjs#L34)

- Lời gọi trong thân hàm: `Object.assign`.
- Kết quả: `Object.assign(new Error(message), { statusCode })`.

### bodyJson

`bodyJson(req)` · [Dòng 38–54](../../../src/studio-server.mjs#L38)

- Lời gọi trong thân hàm: `String`, `bad`, `buffers.push`, `JSON.parse`, `Buffer.concat`, `Array.isArray`.
- Kết quả: `value`.
- Lỗi trực tiếp có thông điệp cố định: `Expected application/json`, `JSON body too large`, `Invalid JSON object`.

### localRequest

`localRequest(req)` · [Dòng 56–64](../../../src/studio-server.mjs#L56)

- Lời gọi trong thân hàm: `String`, `['localhost', '127.0.0.1'].includes`.
- Kết quả: `false`, `true`, `new URL(req.headers.origin).origin === 'http://' + host`.

### checkPlan

`checkPlan(input)` · [Dòng 66–77](../../../src/studio-server.mjs#L66)

- Lời gọi trong thân hàm: `Plan.safeParse`, `parsed.error.issues.map`, `validatePlanForExecution`.
- Kết quả: `{plan, valid, ready, errors, reviewIssues}`.

### stableJson

`stableJson(value)` · [Dòng 79–86](../../../src/studio-server.mjs#L79)

- Lời gọi trong thân hàm: `Array.isArray`, `value.map`, `Object.keys`, `JSON.stringify`.
- Kết quả: `'[' + value.map(stableJson).join(',') + ']'`, `'{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'`, `JSON.stringify(value)`.

### idempotencyKey

`idempotencyKey(req)` · [Dòng 88–96](../../../src/studio-server.mjs#L88)

- Lời gọi trong thân hàm: `String`, `/^[a-zA-Z0-9._:-]+$/.test`, `bad`.
- Kết quả: `null`, `key`.
- Lỗi trực tiếp có thông điệp cố định: `Idempotency-Key must be 8–128 characters (letters, numbers, . _ : -)`.

### isSafeRetryable

`isSafeRetryable(job)` · [Dòng 98–103](../../../src/studio-server.mjs#L98)

- Lời gọi trong thân hàm: `Boolean`, `['failed', 'cancelled', 'interrupted'].includes`, `['discover', 'hostinger', 'goal'].includes`.
- Kết quả: `Boolean(job?.request) && ['failed', 'cancelled', 'interrupted'].includes(job.status) && ['discover', 'hosti…`.

### publicReport

`publicReport(report)` · [Dòng 105–110](../../../src/studio-server.mjs#L105)

- Lời gọi trong thân hàm: `structuredClone`.
- Kết quả: `null`, `copy`.

### openJobArtifact

`openJobArtifact(outputRoot, jobId, filename, maxBytes)` · [Dòng 112–133](../../../src/studio-server.mjs#L112)

- Lời gọi trong thân hàm: `/^[a-z0-9.-]+$/i.test`, `path.join`, `path.resolve`, `lstat`, `directory.isDirectory`, `directory.isSymbolicLink`, `open`, `handle.stat`, `info.isFile`, `handle.close`.
- Kết quả: `{handle, info}`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid artifact identity`, `Job output directory is not a real directory`, `Artifact is not a regular file or exceeds its size limit`.

### readJobJson

`readJobJson(outputRoot, jobId, filename, maxBytes = 2 * 1024 * 1024)` · [Dòng 135–143](../../../src/studio-server.mjs#L135)

- Lời gọi trong thân hàm: `openJobArtifact`, `Buffer.alloc`, `handle.read`, `JSON.parse`, `buffer.subarray`, `handle.close`.
- Kết quả: `JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))`.
- Lỗi trực tiếp có thông điệp cố định: `Job report exceeds its size limit`.

### directoryBytesSync

`directoryBytesSync(root)` · [Dòng 145–161](../../../src/studio-server.mjs#L145)

- Lời gọi trong thân hàm: `pending.pop`, `readdirSync`, `path.join`, `lstatSync`, `info.isDirectory`, `info.isSymbolicLink`, `pending.push`.
- Kết quả: `total`.

### directoryBytes

`directoryBytes(root)` · [Dòng 163–179](../../../src/studio-server.mjs#L163)

- Lời gọi trong thân hàm: `pending.pop`, `readdir`, `path.join`, `lstat`, `info.isDirectory`, `info.isSymbolicLink`, `pending.push`.
- Kết quả: `total`.

### positiveCloudLimit

`positiveCloudLimit(value, fallback, name)` · [Dòng 181–185](../../../src/studio-server.mjs#L181)

- Lời gọi trong thân hàm: `Number.isSafeInteger`.
- Kết quả: `result`.

### nonNegativeCloudRate

`nonNegativeCloudRate(value, fallback, name)` · [Dòng 187–191](../../../src/studio-server.mjs#L187)

- Lời gọi trong thân hàm: `Number.isSafeInteger`.
- Kết quả: `result`.

### streamJobArtifact

`streamJobArtifact(res, opened, headers)` · [Dòng 193–198](../../../src/studio-server.mjs#L193)

- Lời gọi trong thân hàm: `res.writeHead`, `opened.handle.createReadStream`, `stream.on`, `stream.pipe`.
- Kết quả: `stream.pipe(res)`.

### createStudioServer

`createStudioServer({ outputRoot = path.resolve('output/studio'), exploreImpl = explore, goalImpl = createGoalGuide, hostingerImpl = createHostingerGuide, assembleImpl = assemblePages, renderImpl = render, cloudMode = false, cloudTokens = [], cloudLimits = {}, cloudAllowedHosts = [], cloudTrustedProxy = false, cloudWorker = null, cloudAuditKey = null, cloudPreflight = publicUrlPreflight, cloudPricing = {}, cloudAuditArchive = null, cloudAuditKeyRing = null, } = {})` · [Dòng 206–951](../../../src/studio-server.mjs#L206)

- Lời gọi trong thân hàm: `cloudAllowedHosts.map`, `[...allowedCloudHosts].some`, `Number.isInteger`, `Buffer.byteLength`, `positiveCloudLimit`, `nonNegativeCloudRate`, `createCloudAuth`, `store.pruneCloudSubmissions`, `Date.now`, `store.recover`, `recoveredJobs.map`, `store.hasCloudUsage`, `directoryBytesSync`, `Math.max`, `Date.parse`, `Math.ceil`, `store.finalizeCloudUsage`, `pruneHistory`, `Promise.resolve`, `Object.freeze`, `createServer`, `server.once`.
- Kết quả: `{server, jobs, store, tokenAdmin, auditAdmin}`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud mode requires an explicit list of allowed hostnames`, `Cloud mode requires an explicitly trusted TLS-terminating reverse proxy`, `Cloud mode requires filesystem O_NOFOLLOW support for tenant artifact isolation`, `Cloud mode requires an isolated-worker adapter; local browser execution is disabled`, `Cloud mode requires a stable 32-byte audit signing key or versioned key ring`, `Configure cloudAuditKey or cloudAuditKeyRing, not both`, `maxOutputBytesPerJob cannot exceed maxStorageBytesPerTenant`, `cloudAuditArchive must be a trusted append-only archive function`.

### createStudioServer → pruneHistory

`pruneHistory()` · [Dòng 287–297](../../../src/studio-server.mjs#L287)

- Lời gọi trong thân hàm: `store.expired`, `store.delete`, `store.trim`, `rmSync`, `path.join`, `path.resolve`, `jobs.delete`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### createStudioServer → inScope

`inScope(job, principal)` · [Dòng 301–304](../../../src/studio-server.mjs#L301)

- Lời gọi trong thân hàm: `Boolean`.
- Kết quả: `!cloudMode || Boolean(principal && job.tenantId === principal.tenantId && job.projectId === principal.projectId)`.

### createStudioServer → findJob

`findJob(id, principal)` · [Dòng 306–309](../../../src/studio-server.mjs#L306)

- Lời gọi trong thân hàm: `jobs.get`, `inScope`.
- Kết quả: `job && inScope(job, principal) ? job : null`.

### createStudioServer → audit

`audit(principal, action, resourceId = null, outcome = 'success', details = null)` · [Dòng 311–317](../../../src/studio-server.mjs#L311)

- Lời gọi trong thân hàm: `store.recordCloudAudit`.
- Kết quả: `void`.

### createStudioServer → operatorId

`operatorId(value)` · [Dòng 319–325](../../../src/studio-server.mjs#L319)

- Kết quả: `'operator'`, `value`.
- Lỗi trực tiếp có thông điệp cố định: `Token administration actorId must be a valid operator identifier`.

### createStudioServer → replaceCloudTokens

`replaceCloudTokens(nextTokens, { actorId } = {})` · [Dòng 327–345](../../../src/studio-server.mjs#L327)

- Lời gọi trong thân hàm: `operatorId`, `cloudAuth.tokenSnapshot`, `cloudAuth.validateTokens`, `[...before, ...after].map`, `[...tenantIds].map`, `store.recordCloudAudits`, `cloudAuth.replaceTokens`.
- Kết quả: `cloudAuth.replaceTokens(nextTokens)`.
- Lỗi trực tiếp có thông điệp cố định: `Token administration is available only in cloud mode`.

### createStudioServer → revokeCloudToken

`revokeCloudToken(tokenId, { actorId } = {})` · [Dòng 347–358](../../../src/studio-server.mjs#L347)

- Lời gọi trong thân hàm: `operatorId`, `cloudAuth.tokenSnapshot`, `store.recordCloudAudit`, `Boolean`, `cloudAuth.revokeToken`.
- Kết quả: `false`, `Boolean(cloudAuth.revokeToken(tokenId))`.
- Lỗi trực tiếp có thông điệp cố định: `Token administration is available only in cloud mode`.

### createStudioServer → revokeCloudPrincipal

`revokeCloudPrincipal(principalId, { actorId } = {})` · [Dòng 360–372](../../../src/studio-server.mjs#L360)

- Lời gọi trong thân hàm: `operatorId`, `cloudAuth.tokenSnapshot`, `existing.map`, `store.recordCloudAudits`, `[...tenantIds].map`, `cloudAuth.revokePrincipal`.
- Kết quả: `0`, `cloudAuth.revokePrincipal(principalId).length`.
- Lỗi trực tiếp có thông điệp cố định: `Token administration is available only in cloud mode`.

### createStudioServer → list

`list()` · [Dòng 375–375](../../../src/studio-server.mjs#L375)

- Lời gọi trong thân hàm: `cloudAuth.tokenSnapshot`.
- Kết quả: `cloudAuth.tokenSnapshot()`.

### createStudioServer → archiveBatch

`archiveBatch({ limit = 500 } = {})` · [Dòng 381–401](../../../src/studio-server.mjs#L381)

- Lời gọi trong thân hàm: `store.cloudAuditArchiveBatch`, `cloudAuditArchive`, `batch.events.at`, `store.commitCloudAuditArchiveCheckpoint`.
- Kết quả: `{archived, lastArchivedSequence, lastArchivedHash}`, `{archived, …}`.
- Lỗi trực tiếp có thông điệp cố định: `External append-only audit archive is not configured`, `External audit archive did not acknowledge the exact batch checkpoint`.

### createStudioServer → checkpoint

`checkpoint()` · [Dòng 402–402](../../../src/studio-server.mjs#L402)

- Lời gọi trong thân hàm: `store.cloudAuditArchiveBatch`.
- Kết quả: `store.cloudAuditArchiveBatch(1)`.

### createStudioServer → rotateSigningKey

`rotateSigningKey({ keyId, key, actorId } = {})` · [Dòng 403–406](../../../src/studio-server.mjs#L403)

- Lời gọi trong thân hàm: `store.rotateAuditSigningKey`, `operatorId`.
- Kết quả: `store.rotateAuditSigningKey({ keyId, key, actorId: operatorId(actorId) })`.
- Lỗi trực tiếp có thông điệp cố định: `Audit key administration is available only in cloud mode`.

### createStudioServer → keyMetadata

`keyMetadata()` · [Dòng 407–407](../../../src/studio-server.mjs#L407)

- Lời gọi trong thân hàm: `store.auditKeyRingMetadata`.
- Kết quả: `store.auditKeyRingMetadata()`.

### createStudioServer → cloudRequestAllowed

`cloudRequestAllowed(req)` · [Dòng 410–426](../../../src/studio-server.mjs#L410)

- Lời gọi trong thân hàm: `String`, `parsed.hostname.toLowerCase`, `allowedCloudHosts.has`, `origin.hostname.toLowerCase`.
- Kết quả: `false`, `true`.

### createStudioServer → start

`start(type, work, requestSnapshot = null, key = null, principal = null, auditAction = 'job.submitted')` · [Dòng 428–573](../../../src/studio-server.mjs#L428)

- Lời gọi trong thân hàm: `bad`, `createHash`, `stableJson`, `jobs.values`, `allJobs.filter`, `Date.now`, `store.pruneCloudSubmissions`, `store.countCloudSubmissions`, `cloudAuth.checkJobQuota`, `audit`, `randomUUID`, `structuredClone`, `path.join`, `path.resolve`, `store.saveCloudSubmission`, `store.save`, `jobs.set`, `pruneHistory`, `queue.catch`.
- Kết quả: `existing`, `job`.
- Lỗi trực tiếp có thông điệp cố định: `Authenticated tenant/project context required`, `Idempotency-Key was already used with a different request`, `Job queue is full (4 pending jobs)`, `Tenant storage budget exceeded`, `Tenant monthly job budget exceeded`.
