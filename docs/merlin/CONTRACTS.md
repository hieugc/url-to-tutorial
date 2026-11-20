# Hợp đồng dùng chung cho Merlin

## Runtime và thứ tự ưu tiên

Source dùng ECMAScript modules, Node ≥22 theo package.json. Dùng một bản Node 22 có `node:sqlite` như CI, Chromium của Playwright 1.64.1, Driver.js 1.10.2 và Zod 4.1.12. FFmpeg/ffprobe và eSpeak NG là chương trình hệ thống. Webreel là dependency thử nghiệm của harness. Phiên bản tái lập nằm trong [package-lock.json](../../package-lock.json) và [CI](../../.github/workflows/ci.yml).

Với mỗi thay đổi, đọc schema và hàm mà caller đang gọi, đối chiếu fixture/test, rồi mới dùng tài liệu kiến trúc đích. JS object/factory là contract của đa số module. `StudioJobStore` là class có state và phương thức thực. Tên model viết hoa trong blueprint có thể chỉ shape JSON ở ranh giới hàm, không yêu cầu thêm class, bảng dữ liệu hoặc lớp repository.

## Manifest Plan v1

Dữ liệu nhập từ CLI, Studio và generator đều đi qua [plan.mjs](../../src/plan.mjs). Dấu ? chỉ trường có thể vắng. Số thời gian trong manifest tính bằng ms. Khi ghi artifact, giữ UTF-8 và tên field camelCase.

| Model | Trường | Kiểu và quy tắc |
|---|---|---|
| Plan | schemaVersion, title, url | literal 1, string ≥1, HTTP(S) URL không có credential. Cloud áp thêm public HTTPS. |
| Plan | language, mode | vi/en mặc định vi; overview/task mặc định overview. |
| Plan | viewport | {width,height}. Width nguyên chẵn 640–1920, height nguyên chẵn 360–1080. Mặc định 1280×720. |
| Plan | steps, redactSelectors? | 1–50 Step. Tối đa 20 selector, mỗi selector 1–200 ký tự. Chỉ nhận selector redact do người vận hành cấp. |
| Step | id, title, description | id nonempty, unique trong Plan; title 1–160; description bắt buộc, tối đa 1200, được rỗng. |
| Step | action, holdMs, reviewed | action mặc định highlight, holdMs nguyên 500–30000 mặc định 3000, reviewed boolean mặc định false. |
| Step | target?, expected? | Cùng kiểu Target. target chọn đối tượng trước action; expected kiểm trạng thái sau action bằng uniqueTarget. |
| Step | value?, url?, next? | value string tối đa 2000, cho phép rỗng khi fill để xóa text; url theo HttpUrl; next là step id phía sau. |
| Step | condition?, onTrue?, onFalse? | Condition {target,state}, state mặc định visible; cả hai id nhánh phải có trong plan và đứng phía sau. |
| Target | css hoặc role + name | Chọn đúng một shape strict. CSS nonempty; role trong heading/button/link/textbox/combobox, name nonempty được resolve với exact:true. |
| FrameTarget | frame, target | frame:{css} và target là Locator css/role+name ở trong frame; một cấp. |
| Plan, Step | field ngoài schema | Plan/Step/locator/condition dùng strict; validate input trước đọc browser. |

| Action | Yêu cầu tại schema/runtime | Bước tiếp |
|---|---|---|
| highlight | target, spotlight, chỉ quan sát | next hoặc bước kề |
| click | target + reviewed, gọi locator.click | expected nếu có, rồi next/kề |
| fill | target + value + reviewed, dùng dữ liệu demo | expected nếu có, rồi next/kề |
| navigate | url + reviewed; assemble tự động sinh đích đã khám phá cùng origin. Manifest local nhập tay dùng quy tắc URL của schema. | ghi navigatedTo, rồi next/kề |
| branch | condition + onTrue + onFalse, không dùng next | chọn đúng một cạnh theo visible/hidden |
| stop | nếu có phải ở cuối, không dùng next | dừng; một overview chỉ highlight có thể kết thúc khi hết mảng |

Ví dụ hợp lệ để kiểm schema offline, dùng URL fixture đang phục vụ khi test browser:

```json
{"schemaVersion":1,"title":"Giới thiệu bảng gói","url":"https://example.com/","steps":[{"id":"pricing","title":"Bảng gói","description":"Quan sát các lựa chọn.","target":{"css":"#pricing"}},{"id":"finish","title":"Kết thúc","description":"","action":"stop"}]}
```

## HTTP của Studio

Base local mặc định http://127.0.0.1:4173. Body POST là object JSON, Content-Type application/json, kích thước tối đa 512 KiB. Lỗi parser 400, body quá lớn 413, sai media type 415. Với submit async, key tùy chọn truyền bằng header Idempotency-Key; ký tự chữ/số hoặc . _ : -, dài 8–128. Queue hiện tối đa 4 queued+running, thực thi 1 job tại một thời điểm trên instance.

| Method và route | Body / tham số | Phản hồi và người dùng kết quả |
|---|---|---|
| GET /api/health | Không body | 200 {status,scope,persistence,cloudApiEnabled}. |
| POST /api/discover | {url,language?,maxPages?} | 202 {jobId,status,deduplicated}; poll lấy discovery.plan, plans, report. |
| POST /api/goal | {url,goal,language?,ai?} | Submit async; 422 input không hợp lệ. Khi completed đọc goal.plan, evidence, report. |
| POST /api/hostinger | {url,language?} | Submit async; khi completed đọc hostinger.plan, evidence, report. |
| POST /api/assemble | {discoveryJobId} | 200 {plan}; 409 khi job nguồn chưa hoàn tất, sai loại hoặc không có trong scope. |
| POST /api/validate | {plan} | 200/422 {valid,ready,errors,reviewIssues}; lỗi path có thể rỗng với ràng buộc toàn plan. |
| POST /api/preview hoặc /api/render | {plan,confirmedExecution?,narrate?} | 422 schema, 409 thiếu review/xác nhận, 202 submit mới, 200 dedup. Preview chạy action đã duyệt; narrate chỉ áp dụng render. |
| GET /api/jobs, /api/jobs/:id | UUID từ server | {jobs:[…]} mới nhất trước hoặc JobDetail; unknown 404. |
| POST /api/jobs/:id/cancel | {} | queued trả 200 cancelled, running trả 202 cancelling; poll để thấy terminal. |
| POST /api/jobs/:id/retry | {} | Với job đủ điều kiện, {jobId,status,retriedFrom,deduplicated}; job không đủ điều kiện 409. |
| GET /api/jobs/:id/video, /subtitles.srt, /subtitles.vtt | Hai suffix subtitles nối sau /api/jobs/:id | Trả bytes từ artifact trong scope, link lấy từ JobDetail. |
| GET /api/jobs/:id/screenshot/:page, /hostinger-screenshot, /goal-screenshot | Suffix gắn vào job tương ứng | image/png khi có evidence; 404 khi chưa có hoặc file không hợp lệ. |
| GET /api/usage | Cloud, Authorization: Bearer và X-Project-Id theo ACL | Usage tenant, budgets và đơn giá ước tính. |

Ví dụ chuỗi trao đổi cho một lần render local. Chuỗi bắt đầu từ plan không chứa thao tác cần confirm. Sau POST /api/validate trả ready=true, POST /api/render với {"plan":…,"narrate":false}, lưu jobId từ response, poll GET /api/jobs/{id}. Chỉ khi status=completed mới mở videoUrl. Nếu phục hồi trả interrupted, hiển thị trạng thái dừng; xem failed/cancelled/interrupted và retryable trong history. Ở cloud, xác thực/giới hạn có thể chặn trước khi xử lý body.

## Trình bày

| Bề mặt | Quy cách |
|---|---|
| Studio | HTML/CSS/ES module local. Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif. CSS khai báo stack; trên Mac thiếu Inter dùng system fallback. JSON editor ui-monospace, monospace. |
| Màu nền và chữ | --bg #f3f6f7, --paper #fff, --ink #1c303d, --muted #72808a, --line #e0e8eb, --navy #12293a. |
| Điều khiển | --teal #087c75, --teal-dark #056d66, --mint #eaf6f3, --warn #9b6c25, --error #b23d40. Outline focus-visible 3px #48bbae offset 3px. |
| Kích thước hiện hành | Header cao 64px. Workspace rộng tối đa 1500px. Card bo 13px. Label form 11px/730, hint 10px, nút chính 11px/750 cao tối thiểu 38px. Hero clamp(27px,3vw,39px). |
| Overlay trong video | Driver.js local, Arial 22px title và 17px body, chữ #10243a, nền trắng, cursor #16a085. Overlay iframe xem UTV-008. |
| Bàn phím/hiển thị | Dùng label/for, button thật, keyboard reorder, focus-visible, trạng thái có chữ, aria-live, prefers-reduced-motion. Test wrap, zoom và mobile; xem [CSS](../../src/studio/studio.css) để lấy chính xác từng selector. |

