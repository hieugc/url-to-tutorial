# Backlog theo thứ tự

| ID | Hạng mục | Tiêu chí nghiệm thu | Trạng thái |
|---|---|---|---|
| [UTV-001](https://github.com/hieugc/url-to-tutorial/issues/3) | CLI core + Driver.js + MP4 | Fixture URL → plan → video H.264, ảnh các bước, báo lỗi selector | Implemented; xem VALIDATION.md |
| [UTV-002](https://github.com/hieugc/url-to-tutorial/issues/4) | Hostinger adapter | Chạy trên site thật, ghi DOM evidence, không bấm thanh toán, duyệt video | Chưa làm |
| [UTV-010](https://github.com/hieugc/url-to-tutorial/issues/12) | Discovery evidence + multi-page read-only | Status HTTP, screenshot, plan riêng mỗi trang, giới hạn và an toàn điều hướng | CI PASS; local QA pending |
| [UTV-011](https://github.com/hieugc/url-to-tutorial/issues/13) | Conditional workflow + multi-page assembly | IF/ELSE visible/hidden, forward-only graph, review gate, one continuous MP4 | CI PASS; local QA pending |
| [UTV-003](https://github.com/hieugc/url-to-tutorial/issues/5) | Studio editor | Nhập URL, sửa/reorder steps, preview, download MP4 | Implemented on feature branch; CI/browser QA pending |
| [UTV-004](https://github.com/hieugc/url-to-tutorial/issues/6) | AI planner có mục tiêu | JSON grounded trong observed DOM; phát hiện task không đủ dữ liệu | Chưa làm |
| [UTV-005](https://github.com/hieugc/url-to-tutorial/issues/7) | TTS VI/EN + SRT | Audio không bị cắt, không lệch cảnh; kiểm tra bằng video thật | Chưa làm |
| [UTV-006](https://github.com/hieugc/url-to-tutorial/issues/8) | Spike webreel | Driver.js qua navigation, cursor mượt, so sánh video với V1 | Chưa làm |
| [UTV-007](https://github.com/hieugc/url-to-tutorial/issues/9) | Job persistence | Progress, cancel, retry/resume không lặp tác động | Chưa làm |
| [UTV-008](https://github.com/hieugc/url-to-tutorial/issues/10) | Login/privacy/iframe | Che dữ liệu trước capture, session riêng, adapter iframe rõ ràng | Chưa làm |
| [UTV-009](https://github.com/hieugc/url-to-tutorial/issues/11) | Cloud API | Auth, isolation, SSRF/egress policy, quota, storage lifecycle | Chưa làm |

Không đánh dấu DONE dựa vào build hoặc file tồn tại. Mỗi mục liên quan browser/video cần bằng chứng runtime và quan sát hình/video. Backlog được theo dõi qua [GitHub Issues](https://github.com/hieugc/url-to-tutorial/issues). Chỉ đóng issue khi đã đáp ứng đủ tiêu chí nghiệm thu và có bằng chứng kiểm thử; các vấn đề QA MacBook được giữ OPEN dù CI đã PASS.
