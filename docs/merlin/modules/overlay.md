# overlay.mjs

[Mở module nguồn](../../../src/overlay.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### installOverlay

`installOverlay(page)` · [Dòng 10–19](../../../src/overlay.mjs#L10)

- Lời gọi trong thân hàm: `page.evaluate`, `page.addScriptTag`, `page.addStyleTag`.
- Kết quả: `void`.

### showFrameStep

`showFrameStep(page, locator, step, index, total)` · [Dòng 21–61](../../../src/overlay.mjs#L21)

- Lời gọi trong thân hàm: `locator.evaluate`, `page.waitForTimeout`, `locator.boundingBox`, `page.evaluate`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Iframe target has no visible bounding box`.

### showStep

`showStep(page, locator, step, index, total, onVisible = undefined)` · [Dòng 63–89](../../../src/overlay.mjs#L63)

- Lời gọi trong thân hàm: `installOverlay`, `showFrameStep`, `locator.evaluate`, `page.waitForTimeout`, `locator.boundingBox`, `page.evaluate`, `Math.min`, `escapeHtml`, `onVisible`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Target has no visible bounding box`.

### hideStep

`hideStep(page)` · [Dòng 91–97](../../../src/overlay.mjs#L91)

- Lời gọi trong thân hàm: `page.evaluate`, `page.waitForTimeout`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
