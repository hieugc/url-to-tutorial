# URL to Tutorial

Nhập URL → tạo kịch bản chỉnh sửa được → Driver.js spotlight → video MP4.

MVP local-first cho hướng dẫn sử dụng website, bắt nguồn từ bài toán quay video hướng dẫn mua hosting. Có demo hosting giả lập, không giao dịch thật. **Đã có Studio local và goal planner; chưa phải SaaS AI production hoàn chỉnh.**

## Batch UTV-005–009 — narration, persistence and safety

**UTV-005 – Offline voiceover + subtitles.** Use [eSpeak NG](https://github.com/espeak-ng/espeak-ng) voices (Vietnamese: `vi`, English: `en`), with durations measured from actual WAV files using FFprobe. FFmpeg mixes AAC narration into H.264 MP4 and writes `tutorial.srt` / `tutorial.vtt` synchronized to actual executed steps, including IF/ELSE paths. Each step has a 30-second maximum to prevent silently clipped voice recordings.

Install on macOS: `brew install espeak-ng ffmpeg`. Ubuntu: `sudo apt-get install espeak-ng ffmpeg`. eSpeak NG voices can sound robotic. Its source and bundled voice resources have GPL and other licensing requirements; review [upstream licensing](https://github.com/espeak-ng/espeak-ng) before redistributing binaries or voice data. This app calls the locally installed executable and does not bundle voice files.

```bash
npm run tutorial -- render output/my-guide/plan.json --narrate --out output/narrated-guide
npm run demo -- --narrate --out output/narrated-demo
```

Studio has **TTS VI/EN + subtitles** beside Render MP4 and separate MP4/SRT/VTT download links. The existing plan remains editable and unchanged. No cloud TTS API key or GPU is needed.

**UTV-007 – SQLite job history.** `output/studio/studio-jobs.sqlite` stores job status and redacted plan snapshots. A Studio restart marks unfinished jobs `interrupted` and **never** replays browser actions. `GET /api/jobs` lists history. `POST /api/jobs/:id/cancel` cancels queued jobs and cooperatively stops running browser/encoder jobs. `POST /api/jobs/:id/retry` permits only failed/cancelled/interrupted read-only discovery, Hostinger or **offline** goal jobs. Running cancellation is persisted after the worker unwinds. Terminal metadata and artifacts are pruned together at startup and job lifecycle checkpoints (15 days / 40 stored jobs); active jobs are never trimmed. There is no background cleanup timer. Values from `fill` actions are redacted from saved snapshots; do not place secrets in any source plan.

**UTV-008 – Privacy baseline.** Each render uses an isolated fresh browser context. A document-start script masks displayed form values (input/textarea/select/contenteditable) and hides `[data-sensitive]` / `[data-private]` regions. The plan can provide up to 20 CSS `redactSelectors`. A visible CAPTCHA/MFA/OTP challenge halts capture. Explicit cross-origin iframe targets are supported; popups remain unsupported. This does **not** certify arbitrary authenticated sites as private: ordinary page text outside marked regions may remain visible.

**UTV-006 – File-level capture benchmark.** FFprobe measures actual decoded-frame timestamps, FPS and inter-frame jitter on an existing video:

```bash
npm run benchmark -- output/e2e-demo/tutorial.mp4
# Optional A/B after recording the same fixture separately with Webreel:
npm run benchmark -- output/playwright.mp4 output/webreel.mp4 output/comparison.json
```

An optional Webreel A/B harness is described below. File metrics do not establish true browser-rendering FPS or Mac CPU/RAM use; visual and hardware acceptance remain open.

**UTV-009 – Cloud API not enabled.** `src/cloud-egress.mjs` has a public URL/DNS preflight helper and tests but is **not** a complete SSRF defense. Redirects, browser subrequests and DNS rebinding require real network egress isolation in a separate worker. Current Studio only binds to 127.0.0.1 without public auth, tenant isolation or billing. **Do not expose it on the internet.** See [security design](docs/CLOUD-SECURITY.md).

## Follow-up implementation — cancellation, iframe and authenticated walkthroughs

### Cooperative cancellation + idempotency

- `POST /api/jobs/:id/cancel` cancels queued jobs immediately and signals running render, preview, discovery, goal and Hostinger jobs to stop. Browser contexts close and spawned FFmpeg/eSpeak processes receive SIGTERM, then SIGKILL after 2 seconds if needed.
- A running job reports `cancelRequested: true` until the worker has unwound and persisted `cancelled`.
- Job submissions accept `Idempotency-Key` (8–128 safe characters). Repeating the same key and payload returns the original job; reusing a key for different input returns HTTP 409. Keys and request hashes are retained with the bounded SQLite job history.
- A hard process kill still recovers as `interrupted`; no browser action is replayed automatically.

### Cross-origin iframe targets

Plans may explicitly address one visible iframe and a unique element inside it:

```json
{
  "target": {
    "frame": { "css": "iframe#details" },
    "target": { "css": "#product-heading" }
  }
}
```

The renderer verifies that the iframe selector matches exactly one visible frame. It draws the spotlight/popover in the top document using the iframe element's main-page bounding box. Privacy masking and OTP/MFA/CAPTCHA detection inspect all attached frames, including cross-origin frames. Popups/new tabs remain unsupported.

### Explicit manual login (CLI only)

For a walkthrough that requires a user account, use a visible browser and sign in yourself:

```bash
npm run tutorial -- render output/my-guide/plan.json --headed --manual-login --out output/my-guide-authenticated
```

The login context has no video recording. After the user confirms in the terminal, Playwright transfers browser storage state **in memory only** to a fresh recording context. The session is not exported to JSON, written to the job database or reused across jobs. The user must log in again for a later run. If an OTP/MFA/CAPTCHA challenge remains after confirmation, capture stops. The Studio UI does not currently expose manual login; use the CLI.

### Webreel A/B capture

`npm run test:webreel:e2e` downloads Webreel CLI v0.1.4 ephemerally with `npx`, reuses installed Playwright Chromium and system FFmpeg, records the same local fixture at 1280×720, and compares its output with the Playwright/Driver.js video using FFprobe. Results and both videos are written to `output/webreel-ab/`. Webreel is not a default runtime dependency or replacement renderer; its cursor/HUD differs from Driver.js, so a human visual comparison remains required. Upstream: [vercel-labs/webreel](https://github.com/vercel-labs/webreel) (Apache-2.0).

### Discovery safety

Discovery blocks cross-origin main-frame navigation and redirects at the browser routing layer, in addition to same-origin link filtering. The public smoke test checks `https://example.com` and a redirect-to-external failure fixture. It never clicks controls or submits forms.

The GitHub Actions workflow now runs Linux Chromium/FFmpeg, Xvfb-backed manual-session/iframe tests, Webreel A/B, public discovery and a separate macOS compatibility job. A GitHub macOS runner is **not** the user's M3 MacBook; local visual review, M3 CPU/RAM and audio listening remain human acceptance items.

## Studio Editor (local-only, v0.2)

Bản Studio có giao diện trình duyệt để khám phá trang web, chỉnh sửa và sắp xếp các bước, thêm action `highlight`, `click`, `fill`, `navigate`, `branch`, `stop`; import/export plan JSON; validate; preview và render MP4.

```bash
npm ci
npx playwright install chromium
brew install ffmpeg  # macOS, nếu chưa cài
npm run studio
# Mở http://127.0.0.1:4173
```

Studio chạy trên `127.0.0.1:4173`; không expose qua public internet, tunnel hoặc reverse proxy. Nhập **URL đáng tin cậy**: phiên bản local chưa có sandbox mạng ngăn SSRF/private IP, không dùng để mở cho người khác gửi URL tự do. Các bước có tác động cần đánh dấu `reviewed: true` **và** xác nhận lại trước preview/render. Preview vẫn thực thi action thật! Hệ thống không tự thực hiện mua hàng, thanh toán hay đăng ký. Không dùng mật khẩu, thông tin thẻ hoặc dữ liệu nhạy cảm thật trong plan/video.

Tính năng hiện có: form editor, thay đổi thứ tự bằng nút ↑/↓, JSON nâng cao, danh sách lỗi schema/review, xem ảnh snapshot sau discover, job status, link tải MP4. Nếu chuyển thứ tự làm sai luồng branch, validator sẽ báo lỗi. Lịch sử job lưu bằng SQLite qua nhiều phiên; khi restart, job chưa xong chuyển thành interrupted và không tự thực thi lại action. Trình duyệt mới mở trên máy (preview headed) cần môi trường desktop. Đã có goal planner, TTS VI/EN, hủy job đang chạy và lịch sử job. Chưa có drag-and-drop trực tiếp, project workspace nhiều phiên hoặc cloud multiuser.

## Goal-based Guide Planner — offline và AI chọn bước (bản nháp)

Planner nhận URL và mục tiêu bằng VI/EN. Sau `discover`, hệ thống thu thập **ID, nhãn và selector quan sát được**, tối đa 20 candidates đầu tiên của trang hiện tại; tạo kế hoạch spotlight/stop, không click/fill/navigate và không tự chọn mua gói.

```bash
# Hoạt động không cần API hoặc GPU local: từ khóa khớp nhãn DOM
npm run tutorial -- goal https://driverjs.com --goal 'Giới thiệu Driver.js' --out output/goal-offline

# Tùy chọn AI (dữ liệu nhãn UI public sẽ được gửi tới OpenAI API)
# Cung cấp OPENAI_API_KEY bằng biến môi trường của shell, không commit key.
npm run tutorial -- goal https://driverjs.com --goal 'Giới thiệu nút bắt đầu' --ai --out output/goal-ai
```

Trong Studio, điền **Mục tiêu hướng dẫn**, chọn AI nếu muốn, bấm **Generate goal draft**. Nếu chọn AI, server cần `OPENAI_API_KEY`. Mặc định model dùng `OPENAI_MODEL` hoặc `gpt-6-luna`; đổi qua biến môi trường nếu cần. API key chỉ đọc trên server, không đưa vào JSON plan hay client.

**Ràng buộc:** LLM chỉ trả về danh sách `candidate-ID` từ bằng chứng DOM; hệ thống dựng lại selector/description từ evidence được quan sát và từ chối ID không tồn tại, duplicate hoặc danh sách rỗng. Website là dữ liệu không tin cậy, không phải lệnh. Chế độ AI gửi **nhãn text của các control/heading** và mục tiêu tới nhà cung cấp API; tránh dùng trên site chứa thông tin riêng tư. Không có workflow click nhiều trang tự động ở giai đoạn này. Nếu DOM không đủ thông tin, planner báo thiếu bằng chứng thay vì bịa.

Kết quả: `plan.json`, `goal-evidence.json`, `discovery-report.json`, `discovery-page-1.png`. Xem plan, validate và render như pipeline hiện có. Khả năng phù hợp mục tiêu và chuyển từ highlight thành task workflow còn cần QA bổ sung.

## Hostinger Adapter — giới thiệu bảng giá không mua hàng

Có thể tạo **kịch bản giới thiệu các gói Hostinger** theo DOM đang hiển thị, không hardcode giá và không tự bấm nút mua. Adapter chỉ nhận URL HTTPS thuộc `hostinger.com` hoặc `www.hostinger.com` với đường dẫn `/vn` và không có query string.

```bash
npm run tutorial -- hostinger 'https://www.hostinger.com/vn#pricing' --out output/hostinger-pricing
npm run tutorial -- validate output/hostinger-pricing/plan.json
npm run tutorial -- render output/hostinger-pricing/plan.json --out output/hostinger-render
open output/hostinger-render/tutorial.mp4
```

Sau lệnh đầu sẽ có `plan.json`, `hostinger-evidence.json`, `hostinger-pricing.png`. Ảnh chụp tập trung vào gói Premium (nếu quan sát được); báo cáo ghi tên gói, giá tháng, thông tin thanh toán, giá gia hạn, tính năng và selector thực tế. Nếu không trích được một thông số, plan **không tự đoán** và có cảnh báo. Nếu bảng giá không có trong trang chủ, adapter thử đọc trang `/vn/web-hosting` **cùng nhà cung cấp**, ghi rõ URL trong evidence. Không click, không nhận cookie, không đăng nhập, không sang checkout.

Trong Studio tại `http://127.0.0.1:4173`, nhập URL Hostinger rồi bấm **Create Hostinger pricing guide**. Chỉnh sửa plan, Validate, Preview hoặc Render. Kiểm tra lại giá, tổng tiền trước VAT, kỳ hạn và gia hạn trước khi chia sẻ video. Site production có thể thay đổi DOM, cookie banner hoặc chặn browser tự động; trường hợp đó adapter dừng và lưu bằng chứng để xử lý thủ công, không hứa hỗ trợ mọi phiên bản.

**Tình trạng:** Code adapter + fixture testing không thay thế kiểm thử Hostinger production thật. Không dùng giá trong fixture làm dữ liệu tư vấn thực tế.

## Chạy nhanh

Yêu cầu: Node.js 22+, FFmpeg/ffprobe, Chromium của Playwright. Trên macOS: `brew install node ffmpeg` nếu chưa có.

```bash
npm ci
npx playwright install chromium
npm run demo

# Một URL → video tổng quan (không cần API AI)
npm run tutorial -- run https://driverjs.com --out output/driver-overview

# Tách lập kịch bản và render
npm run tutorial -- discover https://driverjs.com --out output/my-guide
# Sửa output/my-guide/plan.json: tiêu đề, lời hướng dẫn, selector, thời gian, thứ tự.
npm run tutorial -- validate output/my-guide/plan.json
npm run tutorial -- preview output/my-guide/plan.json --out output/preview-01
npm run tutorial -- render output/my-guide/plan.json --out output/render-01
```

`--headed` mở cửa sổ trình duyệt. `preview` chạy có giao diện nhưng không encode video. `CHROMIUM_PATH` chỉ định Chromium đã cài sẵn khi cần; vẫn cần FFmpeg recorder của Playwright (`npx playwright install ffmpeg`).

Mỗi lần chạy nên dùng thư mục output mới. Kết quả: `tutorial.mp4`, `report.json`, ảnh `step-N.png`, bản ghi WebM trong `raw/`. Lệnh `discover` và `run` còn xuất `plan.json` và `discovery-report.json` (HTTP status, URL cuối, title, số lượng phần tử, selectors, ảnh `discovery-page-N.png`). Nếu không tìm thấy phần tử, báo lỗi nhưng vẫn lưu evidence để chẩn đoán. Video mặc định không có âm thanh; dùng `--narrate` để thêm TTS VI/EN và phụ đề. Ảnh/video ghi nội dung đang hiển thị: chỉ dùng dữ liệu demo nếu sẽ chia sẻ.

## Hai chế độ

| Chế độ | Hiện có | Giới hạn |
|---|---|---|
| Overview — chỉ nhập URL | Tìm tối đa 8 tiêu đề/nút/link trên trang đầu, sinh kịch bản spotlight, xuất MP4 | Lời hướng dẫn theo mẫu; chưa hiểu mục tiêu nghiệp vụ; nhiều trang cần discover --max-pages rồi assemble |
| Task — URL + kịch bản | Highlight, click, fill, navigate, IF/ELSE branch, next/jump và kiểm tra phần tử kỳ vọng | Bạn viết/sửa JSON; click/fill/navigate phải được duyệt; chưa tự sinh workflow bằng AI |

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
| [webreel](https://github.com/vercel-labs/webreel) | Ứng viên nâng cấp capture, cursor, keystroke overlay | Có harness A/B riêng; chưa thay thế renderer mặc định |
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
- Hỗ trợ tài liệu chính, iframe chỉ định rõ và đăng nhập thủ công qua CLI; chưa hỗ trợ popup, file upload hoặc nhiều tab. Gặp CAPTCHA/MFA thì dừng. Site CSP chặn injection thì báo lỗi; không hạ bảo mật của site.
- Có chuyển động con trỏ và cuộn mượt, nhưng Playwright video không phải trình render timeline cố định 60 fps. Không biến video 25 fps thành “60 fps thật” bằng cách chỉ đổi thông số encode.
- Hiện đã có Studio HTTP cục bộ, goal planner offline/optional AI, TTS VI/EN, SQLite job history và hủy queued/running job; chưa có SaaS multi-tenant hoặc GUI timeline hoàn chỉnh.
- CLI được chạy trên máy cá nhân với URL do người vận hành tin cậy. Không expose CLI thành dịch vụ công khai nhận URL tùy ý; cloud worker cần cách ly mạng/SSRF/credentials trước.

Xem [kiến trúc và API dự kiến](docs/ARCHITECTURE.md), [đánh giá repo có sẵn](docs/REUSE.md), [backlog](docs/BACKLOG.md) và [kết quả kiểm tra](docs/VALIDATION.md).

## Khám phá nhiều trang — bản read-only

```bash
npm run tutorial -- discover https://driverjs.com --max-pages 3 --out output/driver-multipage
```

`--max-pages` nhận số nguyên 1–5 (mặc định 1). Explorer chỉ mở liên kết trang cùng origin qua GET; không click, fill, submit form, mở trang có query string, hoặc đi vào các đường dẫn thanh toán/đặt hàng/đăng xuất/xóa. Mỗi trang hợp lệ có một plan riêng trong `output/.../pages/page-N.plan.json`; `plan.json` ở gốc là plan của trang đầu tiên. Có thể ghép các page plan thành một video liên trang bằng lệnh `assemble` bên dưới. Mỗi bước `navigate` được tạo ở trạng thái chưa duyệt; phải kiểm tra URL và đặt `reviewed: true` trước khi preview/render. Một link GET vẫn có thể gây thay đổi trên website thiết kế không đúng chuẩn, vì vậy chỉ khám phá URL tin cậy; screenshot có thể chứa dữ liệu riêng tư.

Nếu trang không có heading/control, kiểm tra `discovery-report.json` và `discovery-page-1.png` trước khi thử website khác. `https://example.com` không được coi là fixture kiểm thử ổn định.


## Workflow có điều kiện

Plan hỗ trợ bước `branch` với điều kiện phần tử `visible` hoặc `hidden`, hai đích `onTrue` / `onFalse`, và trường `next` để hội tụ hai nhánh. Mọi cạnh workflow phải đi về phía trước; vòng lặp và bước không thể tới bị từ chối để tránh kịch bản chạy vô hạn hoặc chứa bước chết.

```json
{
  "id": "check-cart",
  "title": "Kiểm tra giỏ hàng",
  "description": "Giỏ hàng có xuất hiện sau khi chọn gói không?",
  "action": "branch",
  "condition": { "target": { "css": "#cart-title" }, "state": "visible" },
  "onTrue": "cart-opened",
  "onFalse": "cart-missing"
}
```

## Ghép video nhiều trang

```bash
npm run tutorial -- discover https://driverjs.com --max-pages 3 --out output/site-discovery
npm run tutorial -- assemble output/site-discovery --out output/site-guide
# Mở output/site-guide/plan.json và kiểm tra từng URL navigate.
# Chỉ đặt reviewed: true sau khi đã duyệt từng bước navigate.
npm run tutorial -- validate output/site-guide/plan.json
npm run tutorial -- preview output/site-guide/plan.json --out output/site-preview
npm run tutorial -- render output/site-guide/plan.json --out output/site-video
```

Lệnh `assemble` tạo một plan dùng cùng browser page và cùng recording session, nên các trang được nối vào một MP4. Chỉ page cùng origin từ báo cáo discovery thành công mới được đưa vào. Đây vẫn là read-only page navigation; không tự click link hoặc submit form trong lúc khám phá.
