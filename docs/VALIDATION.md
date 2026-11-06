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


## Conditional workflow + continuous multi-page video — CI PASS

- Workflow run: https://github.com/hieugc/url-to-tutorial/actions/runs/42030003927
- Commit tested: `e442d92bb5802e9ceb5c574ada0d4884c82c5f35`.
- Unit tests: **7/7 PASS**. E2E: **PASS** on GitHub Actions Chromium.
- E2E exercised both IF/ELSE outcomes, the unreviewed-action execution gate, and discovery/assembly/render across two same-origin pages.
- Continuous multi-page output: **H.264, 1280×720, 54.64 seconds, no audio**. Demo output: **H.264, 1280×720, 25.64 seconds, no audio**.
- Branch evidence: visible condition selected `cart-found`; missing element selected `cart-missing`.
- [Artifact tutorial-evidence](https://github.com/hieugc/url-to-tutorial/actions/runs/42030003927/artifacts/13415996726) contains screenshots, reports and MP4 files; retention 7 days, expires 2026-11-12.
- This is runtime verification on the GitHub runner. It is not yet a manual visual review of the complete MP4, MacBook M3 verification, or a Hostinger production-site test.


## UTV-003 Studio Editor — CI verification (2026-11-06)

- PR: https://github.com/hieugc/url-to-tutorial/pull/14, squash-merged to main at `6e6833dd6dd51e70c6e507f6277ba1842de11918`.
- Verified source commit: `8cdd0aa916989114022cd998b6061d75e84f73a4`.
- GitHub Actions run: https://github.com/hieugc/url-to-tutorial/actions/runs/42176184031 — **PASS** for `npm test`, `npm run test:e2e`, and `npm run test:studio:e2e`.
- Artifact: https://github.com/hieugc/url-to-tutorial/actions/runs/42176184031/artifacts/13483621170, contains the Studio Chromium screenshot `output/e2e-studio/studio-editor.png` plus fixture recordings.
- E2E: input URL, discover, edit step, show structural validation errors, explicitly approve an action, validate, render-job API and MP4 download.
- Limitations of the test: Studio E2E uses isolated stub discovery/render to validate UI orchestration; the separate pipeline E2E executes real Chromium/FFmpeg on local fixture. This is **not** a real Hostinger workflow, nor a manual MacBook screenshot/video visual inspection. See issue #5 for remaining manual QA.


## UTV-002 Hostinger pricing adapter — implementation pending CI (2026-11-06)

- Source: `src/adapters/hostinger.mjs`; command: `npm run tutorial -- hostinger 'https://www.hostinger.com/vn#pricing' --out output/hostinger-pricing`.
- Read-only extraction from observed DOM and evidence with screenshot; no purchase clicks, login, or checkout.
- Unit tests: official host allowlist, rejection of lookalike domains, missing term/renewal not filled with assumed prices.
- Chromium fixture E2E: 3 simulated tiers, selector verification, cookie warning, changed DOM fallback failure, H.264 video, zero purchase requests.
- **CI and actual production-site verification must be reported separately.** Real Hostinger response may differ by promotion, language, geography and cookie modal. No claim of production video QA yet.


### UTV-002 — Verified fixture + live Hostinger smoke (2026-11-06)

- Fixture CI: https://github.com/hieugc/url-to-tutorial/actions/runs/42185921205 — PASS: `npm test`, `npm run test:e2e`, `npm run test:studio:e2e`, `npm run test:hostinger:e2e`.
- Fixture artifact: https://github.com/hieugc/url-to-tutorial/actions/runs/42185921205/artifacts/13487567775. Confirms Hostinger-like DOM extraction, selector uniqueness, cookie warning, price parsing with thousands separators, no purchase requests and rendered H.264 fixture.
- **Live smoke on real URL**: https://github.com/hieugc/url-to-tutorial/actions/runs/42186344248 — PASS on GitHub-hosted Ubuntu Chromium. `hostinger` → `validate` → `render` all succeeded.
- Live observed 4 pricing tiers (Premium, Đơn, Không giới hạn, Cloud Startup), plus a terminal `stop-before-checkout` step. Live MP4: H.264 1280×720, 37.16 s, no audio. All 5 runtime steps completed.
- Live screenshot, JSON DOM evidence, plan, per-step screenshots, runtime report and MP4: https://github.com/hieugc/url-to-tutorial/actions/runs/42186344248/artifacts/13488320183 (7-day retention).
- Still pending: manual **visual** review of exported live video and pricing excerpts, full responsive/mobile check, and user MacBook M3 QA. GitHub runner IP/location and promotions may differ from user's local browser. No purchase/checkout or login was automated.


## UTV-004 goal-grounded planner — initial implementation pending CI (2026-11-06)

- Implementation: `src/goal-planner.mjs`, CLI `goal <url> --goal '...' [--ai]`, Studio `POST /api/goal` and source-goal UI.
- Unit tests: evidence-bound IDs, non-matching goals fail-closed, no selectors sent to model, fake Responses API JSON schema, hallucinated/duplicate IDs rejected.
- Chromium fixture E2E: anonymous public demo, goal selection, read-only plan, H.264 render, zero checkout requests.
- AI provider requires `OPENAI_API_KEY` and sends public UI labels to API; **no live billable model call has been made in CI**.
- Existing UTV-004 issue remains OPEN until source-grounding QA, live model test and user acceptance.


### UTV-004 — Mock AI and Chromium E2E CI PASS; merged (2026-11-06)

- PR #16: https://github.com/hieugc/url-to-tutorial/pull/16, squash-merged to main as `8476d2e57babe160d48cac6e21568eedc86845d3`.
- Successful branch CI on source-containing commit `16b6b000`: https://github.com/hieugc/url-to-tutorial/actions/runs/42187732082. All stages PASS: unit, old pipeline, Studio, Hostinger, and goal-planner Chromium E2E.
- Artifact: https://github.com/hieugc/url-to-tutorial/actions/runs/42187732082/artifacts/13488651393, contains fixture H.264 output, screenshot/evidence and regression outputs.
- API verification uses a **fake fetch response** for Structured Outputs. No live OpenAI API key was configured, no billable model call was made, and no claim of model quality or production performance is established.
- Remaining acceptance: manual MacBook review, actual model-backed API test with authorized key, and privacy/prompt-injection evaluation on trusted websites. Issue #6 stays OPEN.


## Batch UTV-005–009 — candidate build (2026-11-06)

This batch is **not VERIFIED until a single full GitHub Actions run reaches SUCCESS**. It includes:

- UTV-005: locally installed eSpeak NG for VI/EN narration; FFprobe measured audio duration; dynamic hold padding; runtime narration timestamps; FFmpeg H.264/AAC output; SRT/VTT. Unit and VI/EN Chromium E2E with FFprobe are included.
- UTV-007: experimental Node 22+ built-in SQLite stores bounded job history; interrupted running jobs are not auto-replayed. Queued cancel and safe read-only retry only. Test covers restart, queued cancel and plaintext fill redaction.
- UTV-008: document-start form text masking, explicit selector redaction, OTP/CAPTCHA stop, new private browser context for every render. Chromium E2E verifies dynamic field masking and safe stop.
- UTV-006: FFprobe baseline frame-spacing statistics and optional supplied A/B comparison. No Webreel runtime integration yet.
- UTV-009: non-production public URL/DNS guard and threat-model documentation. NO public Cloud API, tenant login, billing, or full SSRF protection.

**Still OPEN even after CI:** manual MacBook visual/audio QA (listening to both VI/EN outputs), real Webreel capture, graceful in-flight browser cancellation, real authenticated session consent/iframe handling, production cloud security validation. Do not mark those requirements DONE from fixture tests alone.

Unit tests: `npm test`. Browser tests: `npm run test:e2e`, `npm run test:studio:e2e`, `npm run test:hostinger:e2e`, `npm run test:goal:e2e`, `npm run test:narration:e2e`, `npm run test:privacy:e2e`. Baseline analysis: `npm run benchmark -- output/e2e-demo/tutorial.mp4`.
