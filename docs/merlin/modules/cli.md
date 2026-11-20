# cli.mjs

[Mở module nguồn](../../../src/cli.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### confirmManualLogin

`confirmManualLogin()` · [Dòng 26–31](../../../src/cli.mjs#L26)

- Lời gọi trong thân hàm: `createInterface`, `rl.question`, `rl.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### renderOptions

`renderOptions(preview = false)` · [Dòng 33–42](../../../src/cli.mjs#L33)

- Kết quả: `{outDir, headed, preview, manualLogin, …}`.
- Lỗi trực tiếp có thông điệp cố định: `--manual-login requires --headed`.
