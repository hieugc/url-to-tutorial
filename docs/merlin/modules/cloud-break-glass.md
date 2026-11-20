# cloud-break-glass.mjs

[Mở module nguồn](../../../src/cloud-break-glass.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validateAction

`validateAction(action)` · [Dòng 9–19](../../../src/cloud-break-glass.mjs#L9)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.getPrototypeOf`, `Object.keys`, `ACTIONS.has`, `RESOURCE_ID.test`, `Object.freeze`.
- Kết quả: `{type, resourceId}`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass action is invalid or unsupported`.

### validatePurpose

`validatePurpose(purpose)` · [Dòng 21–27](../../../src/cloud-break-glass.mjs#L21)

- Lời gọi trong thân hàm: `purpose.trim`, `/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test`.
- Kết quả: `purpose.trim()`.
- Lỗi trực tiếp có thông điệp cố định: `A 20–500 character break-glass justification is required`.

### authorize

`authorize(operatorAuthenticator, context, action)` · [Dòng 29–41](../../../src/cloud-break-glass.mjs#L29)

- Lời gọi trong thân hàm: `operatorAuthenticator.authorize`, `ACTOR_ID.test`, `Object.freeze`.
- Kết quả: `{actorId}`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass operator authorization failed`, `Break-glass recovery requires an MFA-verified operator`.

### safeRecord

`safeRecord(record)` · [Dòng 43–55](../../../src/cloud-break-glass.mjs#L43)

- Lời gọi trong thân hàm: `Object.freeze`.
- Kết quả: `null`, `{requestId, action, purpose, proposerId, approverId, state, expiresAt, resultCode}`.

### safeErrorCode

`safeErrorCode(error)` · [Dòng 57–60](../../../src/cloud-break-glass.mjs#L57)

- Lời gọi trong thân hàm: `ERROR_CODE.test`.
- Kết quả: `typeof error?.code === 'string' && ERROR_CODE.test(error.code) ? error.code : 'ACTION_EXECUTION_FAILED'`.

### createBreakGlassRecovery

`createBreakGlassRecovery({ approvalStore, operatorAuthenticator, auditRecorder, actionExecutor, now = () => Date.now(), defaultTtlMs = 15 * 60_000, } = {})` · [Dòng 67–245](../../../src/cloud-break-glass.mjs#L67)

- Lời gọi trong thân hàm: `Number.isSafeInteger`, `Object.freeze`.
- Kết quả: `{propose, approve, execute, getRequest}`.
- Lỗi trực tiếp có thông điệp cố định: `MFA operator authenticator is required`, `Tamper-evident audit recorder is required`, `Trusted break-glass action executor is required`, `Break-glass clock or request lifetime configuration is invalid`.

### createBreakGlassRecovery → getRequest

`getRequest(requestId)` · [Dòng 94–99](../../../src/cloud-break-glass.mjs#L94)

- Lời gọi trong thân hàm: `REQUEST_ID.test`, `safeRecord`, `approvalStore.getRequest`.
- Kết quả: `safeRecord(await approvalStore.getRequest(requestId))`.
- Lỗi trực tiếp có thông điệp cố định: `A valid break-glass request ID is required`.

### createBreakGlassRecovery → propose

`propose(context, actionInput, purposeInput, options = {})` · [Dòng 101–131](../../../src/cloud-break-glass.mjs#L101)

- Lời gọi trong thân hàm: `authorize`, `validateAction`, `validatePurpose`, `Array.isArray`, `Object.keys`, `Number.isSafeInteger`, `randomUUID`, `now`, `auditRecorder.record`, `approvalStore.createRequest`, `safeRecord`.
- Kết quả: `safeRecord(record)`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass proposal options are invalid`, `Break-glass request lifetime must be between 1 minute and 24 hours`.

### createBreakGlassRecovery → approve

`approve(context, requestId)` · [Dòng 133–156](../../../src/cloud-break-glass.mjs#L133)

- Lời gọi trong thân hàm: `authorize`, `getRequest`, `Date.parse`, `now`, `auditRecorder.record`, `approvalStore.approveRequest`, `safeRecord`.
- Kết quả: `safeRecord(record)`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass request is not awaiting approval`, `Break-glass approval requires a different operator`, `Break-glass request has expired`.

### createBreakGlassRecovery → execute

`execute(context, requestId)` · [Dòng 158–242](../../../src/cloud-break-glass.mjs#L158)

- Lời gọi trong thân hàm: `authorize`, `getRequest`, `Date.parse`, `now`, `approvalStore.claimExecution`, `auditRecorder.record`, `approvalStore.failRequest`, `actionExecutor.execute`, `Object.assign`, `approvalStore.completeRequest`, `safeRecord`, `safeErrorCode`.
- Kết quả: `safeRecord(record)`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass request is not executable`, `Break-glass execution must be performed by the second approver`, `Break-glass request has expired`, `Break-glass audit failed and its outcome could not be persisted; manual review is required`, `Break-glass execution stopped because the audit write failed`, `Break-glass outcome could not be durably recorded; manual review is required`, `Break-glass failure audit could not be recorded; manual review is required`.

### createTokenAdminBreakGlassExecutor

`createTokenAdminBreakGlassExecutor({ tokenAdmin } = {})` · [Dòng 248–266](../../../src/cloud-break-glass.mjs#L248)

- Lời gọi trong thân hàm: `Object.freeze`.
- Kết quả: `{execute}`.
- Lỗi trực tiếp có thông điệp cố định: `Trusted token administration capability is required`.

### createTokenAdminBreakGlassExecutor → execute

`execute(action, { approverId } = {})` · [Dòng 254–264](../../../src/cloud-break-glass.mjs#L254)

- Lời gọi trong thân hàm: `tokenAdmin.revokeToken`, `tokenAdmin.revokePrincipal`.
- Kết quả: `{applied}`.
- Lỗi trực tiếp có thông điệp cố định: `Unsupported break-glass action`.

### createStudioBreakGlassAuditRecorder

`createStudioBreakGlassAuditRecorder({ store } = {})` · [Dòng 269–314](../../../src/cloud-break-glass.mjs#L269)

- Lời gọi trong thân hàm: `Object.freeze`.
- Kết quả: `{record}`.
- Lỗi trực tiếp có thông điệp cố định: `Studio cloud audit store is required`.

### createStudioBreakGlassAuditRecorder → record

`record(event)` · [Dòng 281–312](../../../src/cloud-break-glass.mjs#L281)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.keys`, `allowedActions.has`, `ACTOR_ID.test`, `REQUEST_ID.test`, `ACTIONS.has`, `RESOURCE_ID.test`, `ERROR_CODE.test`, `store.recordCloudAudit`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass audit event is invalid`.
