# Báo cáo thực thi Merlin UTV-001 đến UTV-011

**Ngày chạy:** 2026-11-20
**Môi trường:** macOS arm64, Node.js 22.23.5 (đã ghim PATH từ nvm). Node mặc định 26.10.0 không khởi chạy được do thiếu `libsimdjson.34.dylib`.
**Baseline:** `main` ban đầu và `origin/main` cùng ở `dbd833352407ee1a89d4d5da57702c723fd31b53`.
**Commit mới trong lượt này:** `7ddd20e0b9e6048211b4a0739999a23a4f290e97` — `fix(UTV-003): show actual video codec and audio metadata`. Đã push fast-forward lên `origin/main`.
**CI commit mới:** [GitHub Actions run 44669282003](https://github.com/hieugc/url-to-tutorial/actions/runs/44669282003) ở trạng thái `pending` khi ghi báo cáo; chưa có kết luận CI.

## Tóm tắt kết quả

Không task nào được đánh dấu DONE chỉ dựa trên code tồn tại hoặc unit test. UTV-003 có một thay đổi đã kiểm chứng cục bộ và push, nhưng vẫn PARTIAL do CI chưa hoàn tất và yêu cầu visual QA MacBook M3 chưa chạy. UTV-009 bị BLOCKED: branch encryption chưa merge, kiểm thử branch có failures/time-out, Docker build bị credential helper chặn, và acceptance staging/security độc lập chưa có. Các task khác PARTIAL vì thiếu một hoặc nhiều gate người dùng/hạ tầng (M3, review video/audio, live API key, site/staging).

## Bảng trạng thái 11 task

| Task | Trạng thái | Commit/SHA | Test evidence trong lượt này | Gate/artefact còn mở |
|---|---|---|---|---|
| UTV-001 | PARTIAL | Không có commit mới; baseline `dbd8333` | `npm run test:e2e` PASS; đầu ra multipage và demo H.264 1280×720; `npm test` 174 pass | M3 playback, CPU/RAM, review video và CI trên SHA mới. Artifact: `output/e2e-multipage/`, `output/e2e-demo/`. |
| UTV-002 | PARTIAL | `b3e5516` pushed; unique output dir in Hostinger harness | `npm run test:hostinger:e2e` PASS; Premium/Đơn/Cloud Startup, H.264 1280×720, purchaseRequests=0. | Live review, M3, CI run 44670570556 queued. |
| UTV-003 | PARTIAL | `7ddd20e0b9e6048211b4a0739999a23a4f290e97` — pushed to `main` | `npm run test:studio:e2e` PASS; locator `#video-codec` = `h264`, `#video-audio` = `None`, `#video-metadata` visible; `npm test` 174 pass; `git diff --cached --check` pass trước commit | CI run 44669282003 pending; visual/accessibility/mobile QA và M3 review chưa làm. Artifact: `output/e2e-studio/studio-editor.png`, download `tutorial.mp4`. |
| UTV-004 | PARTIAL | Không có commit mới; baseline `dbd8333` | Goal planner tests trong `npm test` pass; `npm run test:goal:e2e` PASS, checkout requests = 0, video H.264 | Live hosted AI có phí cần API key/ủy quyền; relevance/privacy review còn mở. Artifact: `output/e2e-goal-video/tutorial.mp4`. |
| UTV-005 | PARTIAL | Local working tree, Node 22.23.5 | `npm run test:narration:e2e` PASS for Vietnamese and English H.264/AAC with two clips and SRT/VTT captions. | Human listening and M3 A/V sync acceptance remain open. Artifacts: `output/e2e-narration/vi/` and `output/e2e-narration/en/`. |
| UTV-006 | PARTIAL | `5e846ac` pushed; unique output dir in Webreel harness | `npm run test:webreel:e2e` PASS: Playwright 25 fps and Webreel 30 fps, H.264 1280×720; compatibility patch SHA256-guarded. | Visual comparison thủ công, CPU/RAM trên M3, Apple Silicon compatibility; CI 44670570556 queued. Artifact: UUID path under `output/webreel-ab-*`. |
| UTV-007 | PARTIAL | Không có commit mới; baseline `dbd8333` | Persistence/recovery tests trong `npm test` pass; bốn PostgreSQL integration tests chạy thật PASS 4/4 (chi tiết bên dưới). | Test process crash/restart xuyên task, retention và M3; chờ CI xác nhận trên commit mới. |
| UTV-008 | PARTIAL | Không có commit mới; baseline `dbd8333`; thay đổi local `privacy.mjs` và `test/privacy.e2e.mjs` được giữ | `npm run test:privacy:e2e` PASS (maskCount 9, MFA stop, H.264); `npm run test:iframe-session:e2e` 4/4 PASS; `npm run test:discovery-public:e2e` xác nhận MFA screenshot bị chặn. | Authenticated real-site/manual session review và M3. Artifact privacy nằm trong thư mục UUID `output/e2e-privacy-c7b3ac3c-003b-4d44-94ba-56291b89d523/`. |
| UTV-009 | BLOCKED | Branch chưa merge: `origin/feat/utv-009-cloud-artifact-encryption` @ `b4b8c0d8fc5d71c1de8c172c804d902aebc67197`; **không có commit lên main** | Branch test candidate: batch 69 cases có 5 FAIL (bao gồm 503 thay vì quota/submit và job failed thay vì completed), sau đó timeout 300s. `npm run test:cloud:docker` không build được do `docker-credential-desktop` thiếu. Không coi branch suite xanh: test selected ở main đạt 69/69 nhưng không bao gồm đầy đủ branch diff. | Soát/sửa branch failures và chạy suite đầy đủ; Docker Linux/credential, staging TLS/identity/KMS/tenant, independent SSRF/security review, restore/rotation. Cloud API giữ disabled/not deployed. |
| UTV-010 | PARTIAL | Không có commit mới; baseline `dbd8333`; thay đổi local `discover.mjs` được giữ | `npm run test:e2e` multipage PASS; `npm run test:discovery-public:e2e` PASS: external redirect target không bị truy cập, 0 automatic writes, 2 mutations blocked, MFA screenshot blocked, public example.com 200. | Mở rộng live-site coverage và human review evidence/ảnh; CI mới pending. Artifact video `output/e2e-multipage/tutorial.mp4`. |
| UTV-011 | PARTIAL | Không có commit mới; baseline `dbd8333` | `npm run test:e2e` xác nhận true/false branch outcomes và multipage H.264 MP4. | Review hình/video transition, M3 và CI trên pushed SHA. Artifact `output/e2e-multipage/tutorial.mp4`. |

## Lệnh và kết quả kiểm thử

- `npm test` (Node 22.23.5): **174 pass, 0 fail, 4 skipped**. Bốn skip do thiếu `COORDINATION_DATABASE_URL` trong lượt chạy mặc định.
- PostgreSQL coordination, rollout, break-glass, certificate integration tests: **4/4 pass** khi cung cấp URL tới PostgreSQL 17 container đã chạy sẵn. `pg` được cài transient bằng `npm install --no-save --package-lock=false pg@8.16.3`; không chỉnh package manifest/lockfile.
- `npm run test:e2e`: PASS.
- `npm run test:studio:e2e`: PASS, bao gồm locator codec/audio mới.
- `npm run test:privacy:e2e`: PASS sau khi sửa harness dùng output dir UUID; artifact cũ không bị xóa.
- `npm run test:iframe-session:e2e`: 4/4 PASS.
- `npm run test:discovery-public:e2e`: PASS.
- `npm run test:goal:e2e`: PASS.
- `npm run test:webreel:e2e`: PASS, UUID-isolated outputs, cần review thủ công theo ghi chú benchmark.
- `npm run test:hostinger:e2e`: PASS, UUID-isolated outputs, zero purchase requests.
- `npm run test:narration:e2e`: PASS locally for VI/EN after confirming Homebrew `espeak-ng`; both AAC audio streams, timed captions and output files were verified.
- `npm run test:cloud:docker`: BLOCKED — Docker credential helper `docker-credential-desktop` không tồn tại trong PATH.
- Encryption branch suite: 5 failure, lệnh batch timeout tại 300 giây; không được tính pass.

## Branch encryption / UTV-009

Đã tìm thấy và đối chiếu `origin/feat/utv-009-cloud-artifact-encryption` (35 commit chưa có trong main, 12 file thay đổi ở diff thống kê ban đầu). Đã chạy một phần test trong detached worktree riêng `/private/tmp/url-to-tutorial-utv009`; không chuyển branch trong main worktree và không đụng các local modifications. Kết quả test thất bại như ghi trên nên **không tích hợp/merge**. Đây là quyết định an toàn: thay đổi mã hóa artifacts và SQLite jobs cần chạy sạch full suite, DB migration/legacy plaintext compaction tests, Docker và security/staging gates trước.

Không bật Cloud API production. Không tạo deployment, không đưa secrets/key vào report.

## Local changes được bảo tồn

Năm file source/test local có từ trước được giữ lại, không reset/clean/xóa:

- `src/adapters/hostinger.mjs`
- `src/discover.mjs`
- `src/privacy.mjs`
- `src/render.mjs`
- `test/privacy.e2e.mjs`

Trong lượt này các output E2E được chuyển sang UUID-unique để tránh đè artifact cũ và tuân thủ renderer no-overwrite; privacy E2E xác nhận guard readiness. `docs/BACKLOG.md`, `docs/VALIDATION.md` và report này đã được cập nhật nhưng chưa commit. Không thay đổi dependency manifest/lockfile. GitHub Issues #3–#13 vẫn OPEN. Unit suite: 174 pass, 0 fail, 4 PostgreSQL skips ở lệnh chung (bốn integration test đã pass trong run CI 44671762184). E2E hiện PASS: general, Studio, Hostinger fixture, goal, narration VI/EN, privacy, iframe/session 4/4, discovery-public/example.com, Webreel A/B. `test:cloud:docker` vẫn bị chặn local trước build bởi thiếu `docker-credential-desktop`; CI run 44671762184 chạy cloud Docker E2E thành công.

## Kết luận

Đã trực tiếp đối chiếu README, đủ 11 task blueprint, CONTRACTS và code/tests; sửa Studio codec/audio label hard-code, bổ sung locators/regression E2E; sửa tính lặp lại của privacy E2E; thực thi các test sẵn có; kiểm tra encryption branch và các blocker; cập nhật backlog/validation; commit/push phần UTV-003 đủ scope. Không thể hoàn tất cả 11 task ở mức DONE trung thực trong lượt này do gates được nêu. Cần xử lý các blocker và acceptance còn mở rồi cập nhật report/trạng thái tiếp theo.


## Follow-up — self-hosted CI and continued regression (2026-11-20)

- Converted the CI, PostgreSQL, macOS regression, Hostinger smoke and branch-cleanup workflows to labels `[self-hosted, macOS, ARM64]`, verified against online GitHub runner `hieu`. Commit `3e06d0ac3c1f3d15bdb93cb1c7e32de71655d93d` is pushed to `main`.
- CI run [44671762184](https://github.com/hieugc/url-to-tutorial/actions/runs/44671762184) **SUCCESS** on the self-hosted macOS ARM64 runner: `verify`, `postgres-coordination`, `macos-regression` and gated branch consolidation all passed. Dedicated PostgreSQL integration suite passed, and both Chromium/macOS regression suites, narration, Docker cloud E2E, Webreel and artifact upload steps passed.
- Re-ran `npm test` with Node.js 22.23.5: 174 passed, 0 failed, 4 PostgreSQL tests skipped in the generic unit command; the workflow has a dedicated PostgreSQL job to execute those four integration tests.
- `git diff --check` passes. Local `espeak-ng` is available and narration E2E passes. Local Docker cloud E2E fails before build because the Docker configuration invokes missing `docker-credential-desktop`; the corresponding CI job passed.
- Remaining working-tree edits were preserved and not staged in this commit. Issues #3–#13 remain open; no external human/M3/security acceptance was fabricated.
