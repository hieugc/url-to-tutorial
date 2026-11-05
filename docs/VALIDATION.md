# Validation — 2026-11-05 (Asia/Saigon)

## Kiểm thử GitHub Actions — PASS

- [Workflow run #1](https://github.com/hieugc/url-to-tutorial/actions/runs/41965697347) hoàn thành thành công ngày 2026-11-05.
- Commit mã nguồn đã kiểm thử: `e156da99a0811b636ae1b7dd774ef53c286d151f`.
- Unit tests: **6/6 PASS**. E2E: **PASS** trên Chromium của GitHub runner.
- Discovery nhận được 7 bước từ fixture; kiểm tra render tổng quan, click mở giỏ hàng, stop, selector thiếu và selector trùng đều đạt.
- Video demo: **H.264, 1280×720, 20,48 giây, không âm thanh**.
- [Artifact tutorial-evidence](https://github.com/hieugc/url-to-tutorial/actions/runs/41965697347/artifacts/13388045048) chứa video, report và ảnh từng bước; giữ 7 ngày, hết hạn 2026-11-12.
- Đã xem ảnh bước 3 và 4 từ artifact: spotlight đúng nút chọn gói và giỏ hàng; callout tiếng Việt hiển thị rõ. Chưa đánh giá chuyển động của toàn bộ video bằng mắt.
- Đây là fixture demo, không chứng minh tương thích Hostinger thật hoặc mọi URL. Chưa benchmark độ mượt trên MacBook.

## Quan sát local trước khi có CI

- Node.js 24.22.1; npm 11.9.0.
- Cài dependency npm thành công. `npm test`: **6 passed, 0 failed**.
- Tải Chromium do Playwright quản lý thất bại: máy chủ tải trả dữ liệu không phải ZIP hợp lệ trong môi trường hiện tại.
- Tải FFmpeg recorder của Playwright thành công qua endpoint fallback.
- Thử E2E với Chromium hệ thống `/usr/bin/chromium`: khởi chạy bị môi trường từ chối `socket() failed: Operation not permitted`, process SIGABRT.
- Trong môi trường local ở lần thử trước, chưa xác minh runtime của Driver.js overlay, trình tự click, ảnh minh chứng hay MP4; kết quả CI bên trên đã bổ sung kiểm tra runtime trên runner. Không có video mẫu đã kiểm chứng trong gói này.
- Chưa chạy thử trên MacBook M3 của người dùng hoặc website Hostinger thật.
- GitHub Actions có cấu hình; xem tab Actions của repository để kiểm tra từng run. Kết quả kiểm thử local ở trên không thay thế kết quả CI.

## Kiểm tra tiếp trên máy có browser hoạt động

```bash
npm ci
npx playwright install chromium
npm test
npm run test:e2e
npm run demo
```

Kiểm tra `output/e2e-demo/tutorial.mp4` bằng mắt: tiếng Việt đúng dấu, focus đúng phần tử, không bị popover che nội dung cần đọc, cursor/scroll đủ mượt, giỏ hàng hiện sau click và kết thúc trước thanh toán. Chỉ sau đó mới đánh dấu UTV-001 runtime-verified.

## Repository

Repository do chủ dự án tạo: https://github.com/hieugc/url-to-tutorial (public).
Mã nguồn không bao gồm node_modules, output chứa dữ liệu website, session đăng nhập, token hoặc binary bên thứ ba.


## Conditional workflow + continuous multi-page video — CI PASS

- Workflow run: https://github.com/hieugc/url-to-tutorial/actions/runs/42030003927
- Commit tested: `e442d92bb5802e9ceb5c574ada0d4884c82c5f35`.
- Unit tests: **7/7 PASS**. E2E: **PASS** on GitHub Actions Chromium.
- E2E exercised both IF/ELSE outcomes, the unreviewed-action execution gate, and discovery/assembly/render across two same-origin pages.
- Continuous multi-page output: **H.264, 1280×720, 54.64 seconds, no audio**. Demo output: **H.264, 1280×720, 25.64 seconds, no audio**.
- Branch evidence: visible condition selected `cart-found`; missing element selected `cart-missing`.
- [Artifact tutorial-evidence](https://github.com/hieugc/url-to-tutorial/actions/runs/42030003927/artifacts/13415996726) contains screenshots, reports and MP4 files; retention 7 days, expires 2026-11-12.
- This is runtime verification on the GitHub runner. It is not yet a manual visual review of the complete MP4, MacBook M3 verification, or a Hostinger production-site test.
