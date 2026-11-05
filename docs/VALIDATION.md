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
