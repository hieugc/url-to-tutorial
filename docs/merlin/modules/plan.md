# plan.mjs

[Mở module nguồn](../../../src/plan.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### visit

`visit(id)` · [Dòng 101–107](../../../src/plan.mjs#L101)

- Lời gọi trong thân hàm: `reachable.has`, `reachable.add`, `indexById.get`, `visit`.
- Kết quả: `void`.

### validatePlanForExecution

`validatePlanForExecution(plan)` · [Dòng 114–122](../../../src/plan.mjs#L114)

- Lời gọi trong thân hàm: `['click', 'fill', 'navigate'].includes`, `issues.push`.
- Kết quả: `issues`.

### locate

`locate(page, target)` · [Dòng 124–129](../../../src/plan.mjs#L124)

- Lời gọi trong thân hàm: `page.frameLocator`, `root.locator`, `root.getByRole`.
- Kết quả: `locator.css ? root.locator(locator.css) : root.getByRole(locator.role, { name: locator.name, exact: true })`.

### uniqueTarget

`uniqueTarget(page, target)` · [Dòng 131–145](../../../src/plan.mjs#L131)

- Lời gọi trong thân hàm: `page.locator`, `frames.count`, `frames.isVisible`, `locate`, `locator.first`, `locator.count`, `JSON.stringify`.
- Kết quả: `locator`.

### evaluateCondition

`evaluateCondition(page, condition)` · [Dòng 147–153](../../../src/plan.mjs#L147)

- Lời gọi trong thân hàm: `locate`, `locator.count`, `JSON.stringify`, `locator.isVisible`.
- Kết quả: `condition.state === 'visible' ? visible : !visible`.

### escapeHtml

`escapeHtml(text)` · [Dòng 155–157](../../../src/plan.mjs#L155)

- Lời gọi trong thân hàm: `text.replace`.
- Kết quả: `text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))`.
