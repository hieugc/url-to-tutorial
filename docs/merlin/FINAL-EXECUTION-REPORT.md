# Báo cáo thực thi Merlin UTV-001 đến UTV-011

**Ngày chạy:** 2026-11-20
**Môi trường:** macOS arm64, Node.js 22.23.5 (đã ghim PATH từ nvm). Node mặc định 26.10.0 không khởi chạy được do thiếu `libsimdjson.34.dylib`.
**Baseline:** `main` ban đầu và `origin/main` cùng ở `dbd833352407ee1a89d4d5da57702c723fd31b53`.
**Main hiện tại:** `104865936147c8cb0d6dd774f69e8959079d4658` (`origin/main`). Các commit UTV-003 và CI/harness fixes đã được push.
**CI mới nhất đã xác minh:** [GitHub Actions run 44677496161](https://github.com/hieugc/url-to-tutorial/actions/runs/44677496161) — SUCCESS, gồm verify, macOS regression, PostgreSQL coordination và branch consolidation. Runs cũ 44669282003/44670570556 bị hủy; không dùng làm bằng chứng thành công.

## Tóm tắt kết quả

Không task nào được đánh dấu DONE chỉ dựa trên code tồn tại hoặc unit test. UTV-003 có một thay đổi đã kiểm chứng cục bộ và push, nhưng vẫn PARTIAL do CI chưa hoàn tất và yêu cầu visual QA MacBook M3 chưa chạy. UTV-009 bị BLOCKED: branch encryption chưa merge, kiểm thử branch có failures/time-out, Docker build bị credential helper chặn, và acceptance staging/security độc lập chưa có. Các task khác PARTIAL vì thiếu một hoặc nhiều gate người dùng/hạ tầng (M3, review video/audio, live API key, site/staging).

## Bảng trạng thái 11 task

| Task | Trạng thái | Commit/SHA | Test evidence trong lượt này | Gate/artefact còn mở |
|---|---|---|---|---|
| UTV-001 | PARTIAL | Không có commit mới; main `1048659` | `npm run test:e2e` PASS trên Node 22.23.5; multipage và demo H.264 1280×720; CI 44677496161 SUCCESS | M3 playback, CPU/RAM và human review video còn mở. Artifacts UUID dưới `output/e2e-multipage-*` và `output/e2e-demo-*`. |
| UTV-002 | PARTIAL | `b3e5516` pushed; unique output dir in Hostinger harness | `npm run test:hostinger:e2e` PASS; Premium/Đơn/Cloud Startup, H.264 1280×720, purchaseRequests=0; CI 44677496161 SUCCESS. | Manual current live-site video review and M3 acceptance remain open. |
| UTV-003 | PARTIAL | `7ddd20e0b9e6048211b4a0739999a23a4f290e97` — pushed to `main` | Studio E2E locators/assertions PASS; full CI 44677496161 SUCCESS | Visual/accessibility/mobile QA và M3 review chưa làm. Artifact: `output/e2e-studio/studio-editor.png`. |
| UTV-004 | PARTIAL | Không có commit mới; baseline `dbd8333` | Goal planner tests trong `npm test` pass; `npm run test:goal:e2e` PASS, checkout requests = 0, video H.264 | Live hosted AI có phí cần API key/ủy quyền; relevance/privacy review còn mở. Artifact: `output/e2e-goal-video/tutorial.mp4`. |
| UTV-005 | PARTIAL | Local harness fix pending commit | Narration E2E PASS in CI 44677496161 and locally after UUID-isolating output: VI 9.44s, EN 10.36s, H.264/AAC, two clips, SRT/VTT. | Human listening and M3 A/V sync acceptance remain open. Latest local artifacts: `output/e2e-narration-c311ff19-8d47-4b76-9bf0-e6d328b3d987/`. |
| UTV-006 | PARTIAL | `5e846ac` pushed | Local Webreel A/B and CI 44677496161 PASS: Playwright measured 25 fps, Webreel 30 fps, H.264 1280×720; compatibility patch SHA256-guarded. | Human visual comparison, CPU/RAM trên M3, Apple Silicon compatibility; artifact: `output/webreel-ab-207823fa-4883-408c-8e0e-627a72533fd2/`. |
| UTV-007 | PARTIAL | Main `1048659`; no task-specific new code in this follow-up | Persistence/recovery tests in `npm test` PASS; PostgreSQL integration tests PASS 4/4 in CI 44677496161. | Remaining M3 acceptance; process crash/restart and retention evidence is documented in VALIDATION.md. |
| UTV-008 | PARTIAL | Main `1048659`; earlier privacy/session implementation is in CI | `npm run test:privacy:e2e` PASS locally (maskCount 9, MFA stop, H.264); `npm run test:iframe-session:e2e` 4/4 PASS locally and in CI 44677496161; discovery-public confirms MFA screenshot blocked. | Authenticated real-site/manual session review and M3. Latest privacy artifact: `output/e2e-privacy-6810a3ad-4fb8-4fba-bab5-8268021bccad/`. |
| UTV-009 | BLOCKED | Branch chưa merge: `origin/feat/utv-009-cloud-artifact-encryption` @ `b4b8c0d8fc5d71c1de8c172c804d902aebc67197`; **không có commit lên main** | Branch test candidate: batch 69 cases có 5 FAIL (bao gồm 503 thay vì quota/submit và job failed thay vì completed), sau đó timeout 300s. Mainline cloud Docker E2E PASS in CI 44677496161, but that does not validate the encryption branch. | Remediate branch failures and run full suite; independent staging/security, tenant/egress, KMS, restore/rotation acceptance. Cloud API stays disabled/not deployed. |
| UTV-010 | PARTIAL | Main `1048659`; discovery safeguards included in successful CI | `npm run test:e2e` multipage PASS; `npm run test:discovery-public:e2e` PASS locally and in CI 44677496161: external redirect target not reached, 0 automatic writes, mutations/WebSockets blocked, MFA screenshot blocked, example.com 200. | Broader live-site coverage and human evidence/image review remain open. Latest artifacts use UUID output directories. |
| UTV-011 | PARTIAL | Main `1048659` | `npm run test:e2e` confirms true/false branch outcomes and multipage H.264; CI 44677496161 SUCCESS. | Human visual transition review and M3 remain open. Latest artifacts use UUID output directories. |

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
- `npm run test:narration:e2e`: PASS locally after UUID-isolating its output directories (initial attempt failed safely because old output files already existed); VI/EN AAC streams, timed captions and output files verified. CI 44677496161 also passed narration before the local harness follow-up.
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
- CI 44677496161: all jobs SUCCESS on main SHA `104865936147c8cb0d6dd774f69e8959079d4658`; includes `npm test`, all configured E2E suites, Docker cloud E2E, macOS regression and PostgreSQL job.
- Follow-up local run on Node 22.23.5 found narration E2E output-directory reuse; updated `test/narration.e2e.mjs` to use a UUID-isolated root and reran it successfully for VI/EN. Privacy, iframe/session, discovery-public and Webreel A/B also passed afterward. This local harness-only edit is not yet covered by CI.
- `npm test` on this checkout: 174 passed, 0 failed, 4 PostgreSQL skips (dedicated CI PostgreSQL job passed). Issues #3–#13 remain open; human M3/visual/audio, live authorized AI, authenticated-site and independent cloud security/staging acceptance have not been fabricated. UTV-009 stays BLOCKED and Cloud API remains disabled.


## Exact-HEAD CI follow-up (2026-11-20)

- Reran CI for `8faa984137005114c41e2f4a12b96fa1e1c45805`; run [44694492183](https://github.com/hieugc/url-to-tutorial/actions/runs/44694492183) completed **SUCCESS** across verify, PostgreSQL coordination, macOS regression and gated consolidation.
- Verify passed unit, Docker cloud, pipeline, Studio, Hostinger, goal, narration, privacy, iframe/session, discovery-public and Webreel tests and artifact upload. Dedicated PostgreSQL job passed and stopped its isolated container.
- Backlog/validation references updated to this run. No open issue was closed: M3/human review and independent Cloud security/staging acceptance are still outstanding; Cloud API stays disabled.


## UTV-009 branch follow-up (2026-11-20)

- Pushed fixture and assertion corrections to `feat/utv-009-cloud-artifact-encryption` as `3b5d188f28aa0dfb9ca5aaaf6657bf1e6b972654`; changes cover artifact-protection startup on restart, ciphertext storage overhead within existing physical caps, required test key rings, and hard-link error wording.
- Full branch `npm test` on Node 22.23.5: **192 passed, 0 failed, 4 PostgreSQL tests skipped**. GitHub Actions [44797625970](https://github.com/hieugc/url-to-tutorial/actions/runs/44797625970) completed **SUCCESS** across verify, macOS regression and PostgreSQL coordination.
- Pushed documentation reconciliation on main as `594709ca222d9d8978679d47ad54e6f99146962a`; main’s corresponding run 44797090240 was queued at last check.
- UTV-009 remains BLOCKED: no PR, merge, deployment or independent security acceptance. Cloud API remains disabled; no issue was closed.
