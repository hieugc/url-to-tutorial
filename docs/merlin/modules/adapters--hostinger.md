# adapters/hostinger.mjs

[Mở module nguồn](../../../src/adapters/hostinger.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### validateHostingerUrl

`validateHostingerUrl(input)` · [Dòng 17–26](../../../src/adapters/hostinger.mjs#L17)

- Lời gọi trong thân hàm: `HOSTS.has`, `url.hostname.toLowerCase`, `url.pathname.startsWith`.
- Kết quả: `url.href`.
- Lỗi trực tiếp có thông điệp cố định: `Enter a valid Hostinger URL`, `Only HTTPS Hostinger Vietnam pages without query parameters are accepted`.

### inspectHostingerPage

`inspectHostingerPage(page)` · [Dòng 32–132](../../../src/adapters/hostinger.mjs#L32)

- Lời gọi trong thân hàm: `page.evaluate`.
- Kết quả: `page.evaluate(…)`.

### inspectHostingerPage → normal

`normal(value)` · [Dòng 34–34](../../../src/adapters/hostinger.mjs#L34)

- Kết quả: `(value || '').replace(/\s+/g, ' ').trim()`.

### inspectHostingerPage → visible

`visible(element)` · [Dòng 35–41](../../../src/adapters/hostinger.mjs#L35)

- Lời gọi trong thân hàm: `element.closest`, `getComputedStyle`, `element.getBoundingClientRect`.
- Kết quả: `false`, `rect.width > 0 && rect.height > 0`.

### inspectHostingerPage → cssPath

`cssPath(element)` · [Dòng 42–57](../../../src/adapters/hostinger.mjs#L42)

- Lời gọi trong thân hàm: `CSS.escape`, `document.querySelectorAll`, `[...current.parentElement.children].filter`, `parts.unshift`, `current.tagName.toLowerCase`, `sameTag.indexOf`, `parts.join`.
- Kết quả: `byId`, `null`, `parts.length && document.querySelectorAll(selector).length === 1 ? selector : null`.

### inspectHostingerPage → matchesName

`matchesName(text)` · [Dòng 58–59](../../../src/adapters/hostinger.mjs#L58)

- Lời gọi trong thân hàm: `definitions.find`.
- Kết quả: `definitions.find(plan => plan.names.some(name => name.toLocaleLowerCase('vi') === text.toLocaleLowerCase('vi')))`.

### inspectHostingerPage → phrase

`phrase(text, start)` · [Dòng 65–71](../../../src/adapters/hostinger.mjs#L65)

- Lời gọi trong thân hàm: `text.search`, `text.slice`, `fragment.search`, `fragment.slice`.
- Kết quả: `null`, `(end < 0 ? fragment : fragment.slice(0, end)).trim().slice(0, 160)`.

### hostingerPricingPlan

`hostingerPricingPlan(observed, { focus = 'Premium', language = 'vi' } = {})` · [Dòng 134–179](../../../src/adapters/hostinger.mjs#L134)

- Lời gọi trong thân hàm: `['vi', 'en'].includes`, `Array.isArray`, `observed.cards.filter`, `unique.find`, `unique.filter`, `ordered.slice`, `steps.push`, `Plan.parse`.
- Kết quả: `Plan.parse(…)`.
- Lỗi trực tiếp có thông điệp cố định: `language must be vi or en`, `Hostinger pricing cards not found: inspect evidence and screenshot, never invent a price`, `Pricing cards are missing verified unique selectors and monthly prices`.

### createHostingerGuide

`createHostingerGuide(url, { headed = false, language = 'vi', outDir, focus = 'Premium', signal, } = {})` · [Dòng 181–286](../../../src/adapters/hostinger.mjs#L181)

- Lời gọi trong thân hàm: `validateHostingerUrl`, `['vi', 'en'].includes`, `path.resolve`, `mkdir`, `signal?.addEventListener`, `Object.assign`, `launch`, `browser.newContext`, `context.newPage`, `context.route`, `targets.push`, `report.checkedUrls.push`, `page.goto`, `ready`, `response?.status`, `page.url`, `inspectHostingerPage`, `page.waitForTimeout`, `observed?.cards?.find`, `page.locator`, `report.warnings.push`, `page.screenshot`, `path.join`, `observed.cards.some`, `observed.cards.find`, `observed.cards.map`, `hostingerPricingPlan`, `signal?.removeEventListener`, `writeFile`, `JSON.stringify`, `context?.close`, `browser?.close`.
- Kết quả: `{plan, evidence, report}`.
- Lỗi trực tiếp có thông điệp cố định: `language must be vi or en`, `Hostinger pricing not detected on the visited pages. See hostinger-evidence.json and screenshot.`.

### createHostingerGuide → abortHandler

`abortHandler()` · [Dòng 199–202](../../../src/adapters/hostinger.mjs#L199)

- Lời gọi trong thân hàm: `context?.close`, `browser?.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
