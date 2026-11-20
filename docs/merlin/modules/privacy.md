# privacy.mjs

[Mở module nguồn](../../../src/privacy.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### privacyBoot

`privacyBoot({ selectors = [] } = {})` · [Dòng 6–65](../../../src/privacy.mjs#L6)

- Lời gọi trong thân hàm: `Array.isArray`, `document.createElement`, `install`, `document.addEventListener`, `startObserver`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### privacyBoot → hide

`hide(element)` · [Dòng 8–21](../../../src/privacy.mjs#L8)

- Lời gọi trong thân hàm: `element.matches`, `element.style.setProperty`, `element.setAttribute`.
- Kết quả: `void`.

### privacyBoot → scan

`scan()` · [Dòng 22–35](../../../src/privacy.mjs#L22)

- Lời gọi trong thân hàm: `document.querySelectorAll`, `hide`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### privacyBoot → install

`install()` · [Dòng 46–50](../../../src/privacy.mjs#L46)

- Lời gọi trong thân hàm: `document.documentElement.append`, `scan`.
- Kết quả: `void`.

### privacyBoot → startObserver

`startObserver()` · [Dòng 57–62](../../../src/privacy.mjs#L57)

- Lời gọi trong thân hàm: `watcher.observe`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### installPrivacy

`installPrivacy(context, selectors = [])` · [Dòng 67–73](../../../src/privacy.mjs#L67)

- Lời gọi trong thân hàm: `Array.isArray`, `selectors.some`, `context.addInitScript`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `redactSelectors must contain at most 20 non-empty CSS selectors`.

### assertSafeCapture

`assertSafeCapture(page)` · [Dòng 75–109](../../../src/privacy.mjs#L75)

- Lời gọi trong thân hàm: `page.frames`, `frame.evaluate`, `frame.isDetached`, `frame.url`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### assertSafeCapture → visible

`visible(el)` · [Dòng 84–90](../../../src/privacy.mjs#L84)

- Lời gọi trong thân hàm: `getComputedStyle`, `el.getBoundingClientRect`.
- Kết quả: `false`, `style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0`.
