# UTV-006 Webreel capture spike — baseline and evaluation plan

## Current state

Existing recording: Playwright Chromium + Driver.js spotlight + FFmpeg H.264. Webreel is **not integrated**. An optional file-level analysis tool, src/benchmark.mjs, reports real FFprobe frames and inter-frame intervals without pretending that a 60fps video has 60fps of real UI movement.

## Baseline command

    npm run demo -- --out output/demo-benchmark
    npm run benchmark -- output/demo-benchmark/tutorial.mp4

To compare Webreel, record an equivalent demo with the same viewport, scripts and CSS, and supply its MP4:

    npm run benchmark -- output/demo-benchmark/tutorial.mp4 output/webreel-equivalent.mp4 output/capture-compare.json

Metrics: decoded video dimensions and codec, frame count, estimated encoded FPS, median/P95/max frame gap and frame-interval standard deviation. Do **not** equate encoded FPS with smooth cursor movement or mouse-event timing.

## Decision requirements

- A/B same deterministic fixture with identical scripted actions, viewport, navigation and timing.
- Compare tooltip/cursor overlay aesthetics, layout shift, missed click highlights and transitions by human review.
- On MacBook record CPU %, peak RSS, browser processes and elapsed time using Activity Monitor or Instruments. FFprobe-only output does not measure those.
- Webreel may use its own headless Chrome/FFmpeg binaries; determine startup overhead and duplication before adding it to the npm lockfile.
- If Webreel cannot preserve Driver.js overlays and precise popover timestamps across navigation, keep current pipeline and use Webreel only for isolated marketing demos.

Status: **baseline analyzer implemented, actual Webreel A/B and MacBook performance not verified.** Keep UTV-006 open.
