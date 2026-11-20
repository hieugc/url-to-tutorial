# egress-proxy-cli.mjs

[Mở module nguồn](../../../src/egress-proxy-cli.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### shutdown

`shutdown()` · [Dòng 16–18](../../../src/egress-proxy-cli.mjs#L16)

- Lời gọi trong thân hàm: `server.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
