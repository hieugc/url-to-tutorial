# Tận dụng repo có sẵn

Đọc nguồn ngày 2026-11-05 (Asia/Saigon). Thông tin dưới đây từ README/license của tác giả, không đồng nghĩa đã chạy thử các repo upstream.

| Repo | Khớp yêu cầu | Khoảng thiếu | Giấy phép công bố |
|---|---|---|---|
| [MLgentDev/playwright-tests-as-tutorials](https://github.com/MLgentDev/playwright-tests-as-tutorials) | Playwright test → Driver.js highlight; Web Speech hoặc edge-tts; FFmpeg ghép audio | Chưa có URL → hiểu nghiệp vụ → kịch bản/editor phổ quát | Apache-2.0 |
| [vercel-labs/webreel](https://github.com/vercel-labs/webreel) | JSON steps → browser video; cursor animation, keystroke overlays, MP4; preview và re-composite | Driver.js injection và narration cần adapter riêng; dự án tự ghi là Labs experiment | Apache-2.0 |
| [HDRUK/web-application-tutorial-recorder](https://github.com/HDRUK/web-application-tutorial-recorder) | Electron/React/Express; ghi hành trình, sửa narration text, lưu JSON, replay và MP4 | README mô tả narration overlay, không suy diễn có TTS đầy đủ; selector động/iframe/upload còn hạn chế | MIT |

## Quyết định

1. Dùng package Driver.js, Playwright, FFmpeg trực tiếp cho core nhỏ có thể kiểm thử. Không fork cả ba ứng dụng rồi ghép hệ thống build/UI khác nhau.
2. Dùng `playwright-tests-as-tutorials` làm mẫu thiết kế gần nhất cho overlay + audio adapter. Nếu copy mã tương lai: giữ Apache LICENSE/NOTICE theo nội dung thực tế, ghi rõ thay đổi.
3. Thử webreel như renderer V2 nếu ưu tiên chuyển động mượt; cần một spike chứng minh có thể inject Driver.js trước/giữa các bước. Không khẳng định README đã cung cấp hook này.
4. Nếu ưu tiên GUI nhanh hơn automation, đánh giá fork Tutorial Recorder MIT thay vì tự viết Electron. Core hiện tại vẫn dùng manifest chuẩn hóa riêng để không khóa vào UI.
5. TTS có thể thử [edge-tts](https://github.com/rany2/edge-tts) cho prototype; thư viện cộng đồng không phải cam kết SLA của Azure. Sản phẩm thương mại nên có adapter dịch vụ TTS chính thức và kiểm tra điều khoản/giá hiện hành trước khi chọn.

## Nguồn chính

- https://driverjs.com/ và https://driverjs.com/docs/configuration
- https://playwright.dev/docs/videos
- https://github.com/MLgentDev/playwright-tests-as-tutorials/blob/main/README.md
- https://github.com/vercel-labs/webreel/blob/main/README.md
- https://github.com/HDRUK/web-application-tutorial-recorder
- https://github.com/HDRUK/web-application-tutorial-recorder/blob/main/LICENSE

Driver.js MIT; Playwright Apache-2.0. FFmpeg licensing phụ thuộc build/codecs; phân phối binary có libx264 cần kiểm tra nghĩa vụ GPL. Repo này gọi FFmpeg được cài riêng, không kèm binary. Mã mới chưa cấp license phát hành công khai (`UNLICENSED`); không thay đổi license của dependency.
