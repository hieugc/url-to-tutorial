# Bàn giao kỹ thuật cho Merlin

Bắt đầu ở bảng dưới đây theo thứ tự của [backlog gốc](../BACKLOG.md). Mỗi phiếu có cam kết, tình trạng ghi trong snapshot, owner trong source, input/process/output, model, UI, mã giả, đầu việc và bằng chứng nghiệm thu. Mã giả hướng dẫn các thay đổi đề xuất. Catalog của từng phiếu trỏ đến thân hàm thực và số dòng trong ZIP. Đọc “Kiến trúc và phạm vi thi công” trước khi dùng mã giả để tránh triển khai lại chức năng đã có.

| Thứ tự | Task | Giao cho Merlin | Điểm nghiệm thu |
|---|---|---|---|
| 1 | [UTV-001](tasks/UTV-001.md) | CLI, spotlight và video H.264 | Playback và CPU/RAM trên M3 |
| 2 | [UTV-002](tasks/UTV-002.md) | Adapter bảng giá Hostinger Việt Nam | Đối chiếu giá live và xem video |
| 3 | [UTV-010](tasks/UTV-010.md) | Discovery nhiều trang và bằng chứng DOM | Egress/read-only và chẩn đoán từng trang |
| 4 | [UTV-011](tasks/UTV-011.md) | Workflow IF/ELSE và ghép video nhiều trang | Cả hai nhánh và điểm chuyển trang trên video |
| 5 | [UTV-003](tasks/UTV-003.md) | Studio editor local và hợp đồng HTTP | Round-trip locator, history, desktop/mobile |
| 6 | [UTV-004](tasks/UTV-004.md) | Planner theo mục tiêu, có bằng chứng DOM | Grounding và lượt hosted có phép |
| 7 | [UTV-005](tasks/UTV-005.md) | TTS tiếng Việt/Anh, timeline và phụ đề | Nghe VI/EN với phụ đề trên video |
| 8 | [UTV-006](tasks/UTV-006.md) | Spike Webreel và quyết định renderer | A/B có navigation, đo trên M3 |
| 9 | [UTV-007](tasks/UTV-007.md) | SQLite, tiến độ, hủy và khôi phục job | Hard kill, dedup, retention và số lần tác động |
| 10 | [UTV-008](tasks/UTV-008.md) | Phiên đăng nhập, che dữ liệu và iframe | Session headed, mask trong iframe và dọn artifact |
| 11 | [UTV-009](tasks/UTV-009.md) | Cloud API, worker cách ly và vận hành | Staging, phụ thuộc hạ tầng và review độc lập |

## Khi hai task dùng chung một hàm

- UTV-001 sở hữu vòng render và report. UTV-011 sở hữu đồ thị và navigate của plan ghép. UTV-005 đọc timestamp renderer để mux và tạo cue. UTV-008 sở hữu bảo vệ capture và target iframe. Mọi thay đổi vào render cần chạy các regression liên quan.
- UTV-010 sở hữu evidence của explorer. UTV-004 chỉ chọn trên tập candidate đã quan sát. UTV-002 sở hữu pricing adapter đặc thù, dùng lại guard của UTV-008 khi chụp. Thứ tự backlog có thể dùng với guard hiện hữu trước khi bổ sung readiness.
- UTV-003 sở hữu form và API mà form tiêu thụ. UTV-007 sở hữu persistence, hủy/retry và thứ tự chuyển trạng thái. UTV-009 dùng queue/DB hiện hữu với scope tenant và worker riêng.
- Dùng [hợp đồng chung](CONTRACTS.md) khi chỉnh model hoặc route. Chạy các lệnh từ root repo sau khi giải nén. Để chạy bộ local như CI trên macOS cần Node 22 hỗ trợ node:sqlite, `npm ci`, `npx playwright install chromium`, FFmpeg/ffprobe và espeak-ng. Dùng một thư mục output mới cho mỗi lượt render; runtime bảo vệ tutorial.mp4 đã có.

## Prompt giao nguyên gói

> Mở docs/merlin/README.md và docs/BACKLOG.md. Làm từng task theo thứ tự trong bảng. Mỗi lượt, đọc toàn bộ phiếu task, hợp đồng chung, hàm nguồn và test liên quan. Kiểm tra baseline trước khi sửa. Triển khai phần thiếu qua đúng entry point, giữ tương thích Plan v1 và dữ liệu đã có; lấy tên hàm thật từ catalog. Chạy các ca nghiệm thu, ghi kết quả thực tế cho đúng phiên bản code. Cập nhật dòng backlog và bằng chứng sau từng task. Khi task cần máy M3, API key tính phí hoặc staging mà môi trường hiện tại chưa có, ghi rõ gate đang chờ và tiếp tục phần độc lập. Chỉ ghi DONE khi đủ bằng chứng của chính task đó.

## Mẫu ghi nhận kết quả từng task

| Trường | Nội dung Merlin điền |
|---|---|
| Task / bản code | ID, commit hoặc checksum source, ngày chạy, OS/architecture và versions runtime |
| Đã kiểm / đã sửa | File, class hoặc hàm, điều kiện lỗi đã tái hiện, hành vi sau sửa |
| Regression | Lệnh đã thực thi, outcome PASS/FAIL/SKIP và lý do skip |
| Artifact | Đường dẫn report/ảnh/MP4/subtitle trong job hoặc CI artifact; timecode cho lỗi hình/tiếng |
| Kết luận | PASS khi đủ bằng chứng; PARTIAL hoặc BLOCKED kèm điều kiện còn thiếu và người/môi trường cần xác nhận |

Trạng thái chép từ repo là lịch sử của snapshot. Các chỉ số profile, CI mới, smoke live, chất lượng nghe/nhìn và deployment phải do lượt thi công ghi nhận. Bản bàn giao này bổ sung đặc tả, chưa thực hiện những lượt nghiệm thu đó.
