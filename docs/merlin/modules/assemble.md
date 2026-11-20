# assemble.mjs

[Mở module nguồn](../../../src/assemble.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### assemblePages

`assemblePages(report, pagePlans)` · [Dòng 10–65](../../../src/assemble.mjs#L10)

- Lời gọi trong thân hàm: `Array.isArray`, `HttpUrl.parse`, `pagePlans.map`, `report.pages.filter`, `pages.entries`, `planByUrl.get`, `pagePlan.steps.some`, `safePageLink`, `steps.push`, `Plan.parse`.
- Kết quả: `Plan.parse(…)`.
- Lỗi trực tiếp có thông điệp cố định: `Discovery report must have status "completed"`, `Discovery report and page plans are required`, `At least two successfully discovered pages are required to assemble a multi-page tutorial`, `Cross-origin pages cannot be assembled`, `Only read-only discovery plans can be assembled automatically`.

### assembleDiscovery

`assembleDiscovery(discoveryDir)` · [Dòng 67–78](../../../src/assemble.mjs#L67)

- Lời gọi trong thân hàm: `path.resolve`, `JSON.parse`, `readFile`, `path.join`, `readdir`, `Promise.all`, `names.map`, `assemblePages`.
- Kết quả: `assemblePages(report, pagePlans)`.
