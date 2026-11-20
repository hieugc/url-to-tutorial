# cloud-audit-archive-scheduler.mjs

[Mở module nguồn](../../../src/cloud-audit-archive-scheduler.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### positiveInteger

`positiveInteger(value, min, max, name)` · [Dòng 1–5](../../../src/cloud-audit-archive-scheduler.mjs#L1)

- Lời gọi trong thân hàm: `Number.isSafeInteger`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### createAuditArchiveScheduler

`createAuditArchiveScheduler({ archiveBatch, batchLimit = 500, intervalMs = 60_000, maxBatchesPerRun = 10, onError = () => {}, } = {})` · [Dòng 7–67](../../../src/cloud-audit-archive-scheduler.mjs#L7)

- Lời gọi trong thân hàm: `positiveInteger`, `Object.freeze`.
- Kết quả: `{start, stop, runOnce, tick, running}`.
- Lỗi trực tiếp có thông điệp cố định: `An audit archive batch function is required`, `onError must be a function`.

### createAuditArchiveScheduler → runOnce

`runOnce()` · [Dòng 23–43](../../../src/cloud-audit-archive-scheduler.mjs#L23)

- Kết quả: `inFlight`.

### createAuditArchiveScheduler → tick

`tick()` · [Dòng 45–51](../../../src/cloud-audit-archive-scheduler.mjs#L45)

- Lời gọi trong thân hàm: `runOnce`, `onError`.
- Kết quả: `await runOnce()`, `null`.

### createAuditArchiveScheduler → start

`start()` · [Dòng 53–58](../../../src/cloud-audit-archive-scheduler.mjs#L53)

- Lời gọi trong thân hàm: `Object.freeze`, `setInterval`, `timer.unref`.
- Kết quả: `{stop, runOnce, tick}`.

### createAuditArchiveScheduler → stop

`stop()` · [Dòng 60–64](../../../src/cloud-audit-archive-scheduler.mjs#L60)

- Lời gọi trong thân hàm: `clearInterval`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### createAuditArchiveScheduler → running

`running()` · [Dòng 66–66](../../../src/cloud-audit-archive-scheduler.mjs#L66)

- Kết quả: `timer !== null`.
