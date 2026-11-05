# Validation — 2026-11-05 (Asia/Saigon)

## Quan sát thực tế

- Node.js 24.22.1; npm 11.9.0.
- Cài dependency npm thành công. `npm test`: **6 passed, 0 failed**.
- Tải Chromium do Playwright quản lý thất bại: máy chủ tải trả dữ liệu không phải ZIP hợp lệ trong môi trường hiện tại.
- Tải FFmpeg recorder của Playwright thành công qua endpoint fallback.
- Thử E2E với Chromium hệ thống `/usr/bin/chromium`: khởi chạy bị môi trường từ chối `socket() failed: Operation not permitted`, process SIGABRT.
- Vì vậy **chưa xác minh runtime của Driver.js overlay, trình tự click, ảnh minh chứng hay MP4**. Không có video mẫu đã kiểm chứng trong gói này.
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
