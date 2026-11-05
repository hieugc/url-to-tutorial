# URL to Tutorial

Nhập URL → tạo kịch bản chỉnh sửa được → Driver.js spotlight → video MP4.

MVP local-first cho hướng dẫn sử dụng website, bắt nguồn từ bài toán quay video hướng dẫn mua hosting. Có demo hosting giả lập, không giao dịch thật. **Đây là CLI MVP, chưa phải studio AI hoàn chỉnh.**

## Chạy nhanh

Yêu cầu: Node.js 22+, FFmpeg/ffprobe, Chromium của Playwright. Trên macOS: `brew install node ffmpeg` nếu chưa có.

```bash
npm ci
npx playwright install chromium
npm run demo

# Một URL → video tổng quan (không cần API AI)
npm run tutorial -- run https://driverjs.com --out output/driver-overview

# Tách lập kịch bản và render
npm run tutorial -- discover https://example.com --out output/my-guide
# Sửa output/my-guide/plan.json: tiêu đề, lời hướng dẫn, selector, thời gian, thứ tự.
npm run tutorial -- validate output/my-guide/plan.json
npm run tutorial -- preview output/my-guide/plan.json --out output/preview-01
npm run tutorial -- render output/my-guide/plan.json --out output/render-01
```

`--headed` mở cửa sổ trình duyệt. `preview` chạy có giao diện nhưng không encode video. `CHROMIUM_PATH` chỉ định Chromium đã cài sẵn khi cần; vẫn cần FFmpeg recorder của Playwright (`npx playwright install ffmpeg`).

Mỗi lần chạy nên dùng thư mục output mới. Kết quả: `tutorial.mp4`, `report.json`, ảnh `step-N.png`, bản ghi WebM trong `raw/`. Lệnh `discover` và `run` còn xuất `plan.json`. Video MVP không có âm thanh. Ảnh/video ghi nội dung đang hiển thị: chỉ dùng dữ liệu demo nếu sẽ chia sẻ.

## Hai chế độ

| Chế độ | Hiện có | Giới hạn |
|---|---|---|
| Overview — chỉ nhập URL | Tìm tối đa 8 tiêu đề/nút/link đang hiển thị, sinh kịch bản spotlight, xuất MP4 | Lời hướng dẫn theo mẫu; không hiểu mục tiêu nghiệp vụ; không tự khám phá nhiều trang |
| Task — URL + kịch bản | Highlight, click, fill, navigate, stop; kiểm tra phần tử kỳ vọng sau thao tác | Bạn viết/sửa JSON; bước có tác động phải đặt `reviewed: true`; không tự sinh workflow bằng AI |

Ví dụ một bước thao tác:

```json
{
  "id": "choose-plan",
  "title": "Chọn gói phù hợp",
  "description": "Kiểm tra tài nguyên và điều kiện trước khi chọn.",
  "target": { "role": "button", "name": "Chọn Premium" },
  "action": "click",
  "reviewed": true,
  "expected": { "css": "#cart-title" },
  "holdMs": 3000
}
```

`reviewed` là xác nhận do tác giả kịch bản đặt, không phải bộ phát hiện giao dịch. Một `click` được duyệt vẫn có thể gây tác động thật. Với hướng dẫn mua hosting, kịch bản phải kết thúc bằng `stop` **trước nút thanh toán/xác nhận mua**. Không nhập tài khoản/thẻ thật vào plan. Bản demo không phải Hostinger thật; không có selector Hostinger nào được tuyên bố đã xác minh.

## Công nghệ được chọn

| Thành phần | Vai trò | Tình trạng |
|---|---|---|
| [Driver.js](https://github.com/kamranahmedse/driver.js) | Spotlight, popover, animation | Đã tích hợp trực tiếp từ npm, nạp local, không phụ thuộc CDN lúc render |
| [Playwright](https://github.com/microsoft/playwright) | Chromium, đọc DOM, locator, thao tác, ghi hình | Đã tích hợp |
| [FFmpeg](https://ffmpeg.org/) | Chuyển WebM → H.264 MP4, faststart; ffprobe kiểm tra file | Đã tích hợp qua process, không dùng shell để ghép lệnh |
| [Zod](https://github.com/colinhacks/zod) | Schema và kiểm tra kịch bản | Đã tích hợp |
| [playwright-tests-as-tutorials](https://github.com/MLgentDev/playwright-tests-as-tutorials) | Tham khảo Driver.js + Playwright + ghép giọng đọc | Đã đọc README; không fork/copy mã |
| [webreel](https://github.com/vercel-labs/webreel) | Ứng viên nâng cấp capture, cursor, keystroke overlay | Chưa tích hợp; cần thử adapter Driver.js trước |
| [web-application-tutorial-recorder](https://github.com/HDRUK/web-application-tutorial-recorder) | Tham khảo editor ghi/chỉnh/replay hành trình | Chưa tích hợp |

Không cần .NET/PostgreSQL/Redis để chứng minh pipeline đầu tiên. Node dùng cùng hệ sinh thái browser, Driver.js và các repo tham khảo. Có thể đặt API ASP.NET Core bên ngoài worker nếu sau này gắn vào hạ tầng hiện có.

## Kiểm thử

```bash
npm test
npm run test:e2e
```

E2E khởi chạy website fixture cục bộ, kiểm tra URL discovery → render, click làm hiện giỏ hàng, stop, codec/kích thước/thời lượng MP4, selector thiếu và selector trùng phải báo thất bại. GitHub Actions đã có cấu hình chạy kiểm thử và lưu evidence; không mặc định coi CI đã chạy thành công khi chưa có workflow run.

## Giới hạn cần biết

- Website đổi DOM có thể làm selector tự sinh không còn đúng. Dùng role + tên chính xác hoặc id ổn định cho kịch bản quan trọng; không tự chọn phần tử đầu tiên nếu selector trùng.
- Chỉ tài liệu chính, chưa hỗ trợ iframe, popup, session đăng nhập, CAPTCHA, file upload và nhiều tab. Site CSP chặn injection thì báo lỗi; không hạ bảo mật của site.
- Có chuyển động con trỏ và cuộn mượt, nhưng Playwright video không phải trình render timeline cố định 60 fps. Không biến video 25 fps thành “60 fps thật” bằng cách chỉ đổi thông số encode.
- Hiện chưa có AI planner, giọng đọc, phụ đề SRT, timeline editor, queue/resume/cancel, API HTTP hay SaaS multi-tenant.
- CLI được chạy trên máy cá nhân với URL do người vận hành tin cậy. Không expose CLI thành dịch vụ công khai nhận URL tùy ý; cloud worker cần cách ly mạng/SSRF/credentials trước.

Xem [kiến trúc và API dự kiến](docs/ARCHITECTURE.md), [đánh giá repo có sẵn](docs/REUSE.md), [backlog](docs/BACKLOG.md) và [kết quả kiểm tra](docs/VALIDATION.md).
