# render.mjs

[Mở module nguồn](../../../src/render.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### throwIfAborted

`throwIfAborted(signal)` · [Dòng 9–15](../../../src/render.mjs#L9)

- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### command

`command(program, args, { signal } = {})` · [Dòng 17–50](../../../src/render.mjs#L17)

- Kết quả: `new Promise((resolve, reject) => { if (signal?.aborted) { const error = new Error('Operation cancelled by o…`.

### command → cleanup

`cleanup()` · [Dòng 27–30](../../../src/render.mjs#L27)

- Lời gọi trong thân hàm: `signal?.removeEventListener`, `clearTimeout`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### command → abort

`abort()` · [Dòng 31–35](../../../src/render.mjs#L31)

- Lời gọi trong thân hàm: `child.kill`, `setTimeout`, `killTimer.unref`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### render

`render(input, { outDir, headed = false, preview = false, signal, manualLogin = false, loginPrompt, } = {})` · [Dòng 52–234](../../../src/render.mjs#L52)

- Lời gọi trong thân hàm: `Plan.parse`, `validatePlanForExecution`, `reviewIssues.join`, `throwIfAborted`, `path.resolve`, `mkdir`, `access`, `path.join`, `command`, `plan.steps.some`, `saveReport`, `signal?.addEventListener`, `launch`, `browser.newContext`, `installPrivacy`, `loginContext.newPage`, `loginPage.goto`, `ready`, `loginPrompt`, `loginContext.storageState`, `loginContext.close`, `context.newPage`, `page.video`, `context.on`, `page.goto`, `assertSafeCapture`, `plan.steps.map`, `report.steps.push`, `uniqueTarget`, `showStep`, `page.screenshot`, `hideStep`, `locator.click`, `locator.fill`, `page.url`, `indexById.get`, `evaluateCondition`, `context.close`, `browser.close`, `video.path`, `JSON.parse`, `probe.streams.find`, `Number`, `report.steps.at`, `signal?.removeEventListener`, `loginContext?.close`, `context?.close`, `browser?.close`.
- Kết quả: `report`.
- Lỗi trực tiếp có thông điệp cố định: `outDir is required`, `Manual login requires --headed so the user can complete authentication visibly`, `Manual login requires an interactive confirmation callback`, `Output already contains tutorial.mp4; choose a new --out directory`, `Workflow exceeded its forward-only execution limit`, `New-tab navigation is not supported by this MVP`, `Encoded video failed verification`.

### render → saveReport

`saveReport()` · [Dòng 77–77](../../../src/render.mjs#L77)

- Lời gọi trong thân hàm: `writeFile`, `path.join`, `JSON.stringify`.
- Kết quả: `writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))`.

### render → abortHandler

`abortHandler()` · [Dòng 80–84](../../../src/render.mjs#L80)

- Lời gọi trong thân hàm: `context?.close`, `loginContext?.close`, `browser?.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
