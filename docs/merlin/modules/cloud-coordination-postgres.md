# cloud-coordination-postgres.mjs

[Mở module nguồn](../../../src/cloud-coordination-postgres.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validateConfig

`validateConfig({ pool, leaseMs, renewIntervalMs, retryIntervalMs, acquireTimeoutMs })` · [Dòng 5–22](../../../src/cloud-coordination-postgres.mjs#L5)

- Lời gọi trong thân hàm: `Number.isSafeInteger`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `A query-capable PostgreSQL pool is required`, `renewIntervalMs must be less than half of leaseMs`.

### sleep

`sleep(ms)` · [Dòng 24–26](../../../src/cloud-coordination-postgres.mjs#L24)

- Kết quả: `new Promise(resolve => setTimeout(resolve, ms))`.

### createPostgresPublishLock

`createPostgresPublishLock({ pool, leaseMs = 30_000, renewIntervalMs = 5_000, retryIntervalMs = 100, acquireTimeoutMs = 30_000, sleepImpl = sleep, } = {})` · [Dòng 36–157](../../../src/cloud-coordination-postgres.mjs#L36)

- Lời gọi trong thân hàm: `validateConfig`, `Object.freeze`.
- Kết quả: `{withLock}`.
- Lỗi trực tiếp có thông điệp cố định: `sleepImpl must be a function`.

### createPostgresPublishLock → query

`query(sql, values)` · [Dòng 47–53](../../../src/cloud-coordination-postgres.mjs#L47)

- Lời gọi trong thân hàm: `pool.query`.
- Kết quả: `await pool.query(sql, values)`.
- Lỗi trực tiếp có thông điệp cố định: `PostgreSQL publish lock storage is unavailable`.

### createPostgresPublishLock → withLock

`withLock(resource, callback)` · [Dòng 55–154](../../../src/cloud-coordination-postgres.mjs#L55)

- Lời gọi trong thân hàm: `RESOURCE.test`, `randomUUID`, `Date.now`, `query`, `String`, `sleepImpl`, `Math.min`, `Math.max`, `setInterval`, `timer.unref`, `Object.freeze`, `lease.assertHeld`, `callback`, `clearInterval`, `pool.query`.
- Kết quả: `await callback(lease)`.
- Lỗi trực tiếp có thông điệp cố định: `A valid publish-lock resource is required`, `A publish-lock callback is required`, `Timed out waiting for the distributed publish lock`.

### createPostgresPublishLock → withLock → renew

`renew()` · [Dòng 90–109](../../../src/cloud-coordination-postgres.mjs#L90)

- Lời gọi trong thân hàm: `query`.
- Kết quả: `void`.

### createPostgresPublishLock → withLock → assertHeld

`assertHeld()` · [Dòng 116–135](../../../src/cloud-coordination-postgres.mjs#L116)

- Lời gọi trong thân hàm: `pool.query`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Distributed publish lock lease is no longer valid`.
