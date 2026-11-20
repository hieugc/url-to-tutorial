# discover.mjs

[Mở module nguồn](../../../src/discover.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### blockedActionPath

`blockedActionPath(pathname)` · [Dòng 14–26](../../../src/discover.mjs#L14)

- Lời gọi trong thân hàm: `BLOCKED_PATH.test`, `value.includes`, `decodeURIComponent`.
- Kết quả: `true`, `false`, `BLOCKED_PATH.test(value) || value.includes('%')`.

### safePageLink

`safePageLink(href, baseUrl, origin)` · [Dòng 32–42](../../../src/discover.mjs#L32)

- Lời gọi trong thân hàm: `['http:', 'https:'].includes`, `blockedActionPath`, `ASSET_PATH.test`.
- Kết quả: `null`, `target.href`.

### pagePlan

`pagePlan(snapshot, language)` · [Dòng 44–62](../../../src/discover.mjs#L44)

- Lời gọi trong thân hàm: `Plan.parse`, `snapshot.candidates.slice`.
- Kết quả: `Plan.parse(…)`.

### snapshotPage

`snapshotPage(page)` · [Dòng 64–117](../../../src/discover.mjs#L64)

- Lời gọi trong thân hàm: `page.evaluate`.
- Kết quả: `page.evaluate(…)`.

### snapshotPage → isVisible

`isVisible(el)` · [Dòng 66–72](../../../src/discover.mjs#L66)

- Lời gọi trong thân hàm: `el.closest`, `getComputedStyle`, `el.getBoundingClientRect`.
- Kết quả: `false`, `bounds.width > 0 && bounds.height > 0`.

### snapshotPage → cssPath

`cssPath(element)` · [Dòng 73–86](../../../src/discover.mjs#L73)

- Lời gọi trong thân hàm: `document.querySelectorAll`, `CSS.escape`, `[...current.parentElement.children].filter`, `parts.unshift`, `current.tagName.toLowerCase`, `siblings.indexOf`, `parts.join`.
- Kết quả: `'#' + CSS.escape(element.id)`, `null`, `'body > ' + parts.join(' > ')`.

### explore

`explore(url, { headed = false, language = 'vi', maxPages = 1, outDir, signal } = {})` · [Dòng 124–269](../../../src/discover.mjs#L124)

- Lời gọi trong thân hàm: `HttpUrl.parse`, `Number.isInteger`, `['vi', 'en'].includes`, `mkdir`, `signal?.addEventListener`, `Object.assign`, `launch`, `browser.newContext`, `installPrivacy`, `context.routeWebSocket`, `context.newPage`, `context.route`, `queue.shift`, `visited.has`, `visited.add`, `report.pages.push`, `page.goto`, `ready`, `response?.status`, `page.url`, `assertSafeCapture`, `snapshotPage`, `observed.links .map`, `page.screenshot`, `path.join`, `plans.push`, `pagePlan`, `queue.includes`, `queue.push`, `signal?.removeEventListener`, `writeFile`, `JSON.stringify`, `context?.close`, `browser?.close`.
- Kết quả: `{plan, plans, report}`.
- Lỗi trực tiếp có thông điệp cố định: `maxPages must be an integer between 1 and 5`, `language must be vi or en`, `Redirected to another origin`, `No eligible visible elements found across discovered pages`.

### explore → abortHandler

`abortHandler()` · [Dòng 142–145](../../../src/discover.mjs#L142)

- Lời gọi trong thân hàm: `context?.close`, `browser?.close`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### discover

`discover(url, options = {})` · [Dòng 272–274](../../../src/discover.mjs#L272)

- Lời gọi trong thân hàm: `explore`.
- Kết quả: `(await explore(url, options)).plan`.
