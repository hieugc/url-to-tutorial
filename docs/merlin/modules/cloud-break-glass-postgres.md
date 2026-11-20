# cloud-break-glass-postgres.mjs

[Mở module nguồn](../../../src/cloud-break-glass-postgres.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### requirePool

`requirePool(pool)` · [Dòng 9–13](../../../src/cloud-break-glass-postgres.mjs#L9)

- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `A query-capable PostgreSQL pool is required`.

### requireUuid

`requireUuid(value, name)` · [Dòng 15–19](../../../src/cloud-break-glass-postgres.mjs#L15)

- Lời gọi trong thân hàm: `REQUEST_ID.test`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### safeStoreError

`safeStoreError()` · [Dòng 21–23](../../../src/cloud-break-glass-postgres.mjs#L21)

- Kết quả: `new Error('Durable break-glass approval storage is unavailable')`.

### mapRow

`mapRow(row)` · [Dòng 25–38](../../../src/cloud-break-glass-postgres.mjs#L25)

- Kết quả: `null`, `{requestId, actionType, resourceId, purpose, proposerId, approverId, state, expiresAt, resultCode}`.

### createPostgresBreakGlassStore

`createPostgresBreakGlassStore({ pool } = {})` · [Dòng 40–166](../../../src/cloud-break-glass-postgres.mjs#L40)

- Lời gọi trong thân hàm: `requirePool`, `Object.freeze`.
- Kết quả: `{createRequest, getRequest, approveRequest, claimExecution, completeRequest, failRequest}`.

### createPostgresBreakGlassStore → query

`query(sql, values)` · [Dòng 43–46](../../../src/cloud-break-glass-postgres.mjs#L43)

- Lời gọi trong thân hàm: `pool.query`, `safeStoreError`.
- Kết quả: `await pool.query(sql, values)`.

### createPostgresBreakGlassStore → createRequest

`createRequest(input)` · [Dòng 48–75](../../../src/cloud-break-glass-postgres.mjs#L48)

- Lời gọi trong thân hàm: `Array.isArray`, `Object.keys`, `requireUuid`, `ACTIONS.has`, `RESOURCE_ID.test`, `input.purpose.trim`, `ACTOR_ID.test`, `Date.parse`, `Number.isFinite`, `Date.now`, `query`, `mapRow`.
- Kết quả: `mapRow(result.rows[0])`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass request metadata is invalid`, `Break-glass request expiry is invalid`.

### createPostgresBreakGlassStore → getRequest

`getRequest(requestId)` · [Dòng 77–84](../../../src/cloud-break-glass-postgres.mjs#L77)

- Lời gọi trong thân hàm: `requireUuid`, `query`, `mapRow`.
- Kết quả: `mapRow(result.rows[0])`.

### createPostgresBreakGlassStore → approveRequest

`approveRequest(input)` · [Dòng 86–106](../../../src/cloud-break-glass-postgres.mjs#L86)

- Lời gọi trong thân hàm: `Object.keys`, `requireUuid`, `ACTOR_ID.test`, `query`, `mapRow`.
- Kết quả: `mapRow(result.rows[0])`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass approval metadata is invalid`, `Break-glass approver identity is invalid`, `Break-glass request is expired, already approved or not permitted`.

### createPostgresBreakGlassStore → claimExecution

`claimExecution(input)` · [Dòng 108–130](../../../src/cloud-break-glass-postgres.mjs#L108)

- Lời gọi trong thân hàm: `Object.keys`, `requireUuid`, `ACTOR_ID.test`, `randomUUID`, `query`, `mapRow`.
- Kết quả: `{executionToken, record}`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass execution metadata is invalid`, `Break-glass executor identity is invalid`, `Break-glass request is expired, already claimed or not executable by this approver`.

### createPostgresBreakGlassStore → finish

`finish(input, state)` · [Dòng 132–156](../../../src/cloud-break-glass-postgres.mjs#L132)

- Lời gọi trong thân hàm: `Object.keys`, `requireUuid`, `ERROR_CODE.test`, `query`, `mapRow`.
- Kết quả: `mapRow(result.rows[0])`.
- Lỗi trực tiếp có thông điệp cố định: `Break-glass execution result is invalid`, `Break-glass result code is invalid`, `Break-glass execution token is invalid or already consumed`.

### createPostgresBreakGlassStore → completeRequest

`completeRequest(input)` · [Dòng 163–163](../../../src/cloud-break-glass-postgres.mjs#L163)

- Lời gọi trong thân hàm: `finish`.
- Kết quả: `finish(input, 'completed')`.

### createPostgresBreakGlassStore → failRequest

`failRequest(input)` · [Dòng 164–164](../../../src/cloud-break-glass-postgres.mjs#L164)

- Lời gọi trong thân hàm: `finish`.
- Kết quả: `finish(input, 'failed')`.
