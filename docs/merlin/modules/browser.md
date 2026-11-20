# browser.mjs

[Mở module nguồn](../../../src/browser.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### launch

`launch(headed = false)` · [Dòng 3–16](../../../src/browser.mjs#L3)

- Lời gọi trong thân hàm: `chromium.launch`.
- Kết quả: `chromium.launch(…)`.

### ready

`ready(page)` · [Dòng 18–23](../../../src/browser.mjs#L18)

- Lời gọi trong thân hàm: `page.waitForLoadState`, `page.evaluate`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
