# cloud-worker.mjs

[Mở module nguồn](../../../src/cloud-worker.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### abortError

`abortError(message = 'Cloud worker cancelled')` · [Dòng 16–20](../../../src/cloud-worker.mjs#L16)

- Kết quả: `error`.

### assertCloudSafePlan

`assertCloudSafePlan(input)` · [Dòng 22–33](../../../src/cloud-worker.mjs#L22)

- Lời gọi trong thân hàm: `Plan.parse`, `validatePlanForExecution`, `reviewIssues.join`, `plan.steps.filter`.
- Kết quả: `plan`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud worker currently permits read-only highlight/branch/stop steps only`.

### assertPublicTarget

`assertPublicTarget(url, preflight = publicUrlPreflight)` · [Dòng 35–38](../../../src/cloud-worker.mjs#L35)

- Lời gọi trong thân hàm: `HttpUrl.parse`, `preflight`.
- Kết quả: `preflight(url)`.

### runCloudWorkerJob

`runCloudWorkerJob(payload, { signal, exploreImpl = explore, goalImpl = createGoalGuide, hostingerImpl = createHostingerGuide, renderImpl = render, narrateImpl = renderNarrated, preflight = publicUrlPreflight, } = {})` · [Dòng 40–85](../../../src/cloud-worker.mjs#L40)

- Lời gọi trong thân hàm: `JOB_ID.test`, `ID.test`, `JOB_TYPES.has`, `Array.isArray`, `abortError`, `assertPublicTarget`, `exploreImpl`, `goalImpl`, `hostingerImpl`, `assertCloudSafePlan`, `narrateImpl`, `renderImpl`.
- Kết quả: `exploreImpl(url, { outDir: OUTPUT_DIR, maxPages: request.maxPages, language: request.language, signal, })`, `goalImpl(url, { goal: request.goal, ai: false, outDir: OUTPUT_DIR, language: request.language, signal, })`, `hostingerImpl(url, { outDir: OUTPUT_DIR, language: request.language, signal })`, `narrateImpl(plan, { outDir: OUTPUT_DIR, headed: false, preview: false, signal })`, `renderImpl(plan, { outDir: OUTPUT_DIR, headed: false, preview: false, signal })`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid cloud worker job envelope`, `Cloud worker must use the dedicated egress proxy`, `Hosted AI is disabled in cloud workers`.

### readInput

`readInput(stream)` · [Dòng 87–96](../../../src/cloud-worker.mjs#L87)

- Lời gọi trong thân hàm: `chunks.push`, `JSON.parse`, `Buffer.concat`.
- Kết quả: `JSON.parse(Buffer.concat(chunks).toString('utf8'))`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud worker input exceeds 512 KiB`.

### main

`main()` · [Dòng 98–118](../../../src/cloud-worker.mjs#L98)

- Lời gọi trong thân hàm: `Number`, `Number.isSafeInteger`, `setTimeout`, `process.once`, `readInput`, `runCloudWorkerJob`, `abortError`, `process.stdout.write`, `JSON.stringify`, `clearTimeout`, `process.removeListener`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `TUTORIAL_WORKER_TIMEOUT_MS must be between 1000 and 900000`.

### main → stop

`stop()` · [Dòng 105–105](../../../src/cloud-worker.mjs#L105)

- Lời gọi trong thân hàm: `controller.abort`.
- Kết quả: `controller.abort()`.
