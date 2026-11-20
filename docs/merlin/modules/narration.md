# narration.mjs

[Mở module nguồn](../../../src/narration.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### milliseconds

`milliseconds(seconds)` · [Dòng 6–10](../../../src/narration.mjs#L6)

- Lời gọi trong thân hàm: `Number`, `Number.isFinite`, `Math.round`.
- Kết quả: `Math.round(n * 1000)`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid audio duration from ffprobe`.

### subtitleTime

`subtitleTime(ms, vtt = false)` · [Dòng 12–21](../../../src/narration.mjs#L12)

- Lời gọi trong thân hàm: `Number.isFinite`, `Math.floor`, `[hrs, mins, secs].map`, `String`.
- Kết quả: `[hrs, mins, secs].map(n => String(n).padStart(2, '0')).join(':') + (vtt ? '.' : ',') + String(milli).padSta…`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid subtitle timestamp`.

### subtitleFiles

`subtitleFiles(items)` · [Dòng 23–33](../../../src/narration.mjs#L23)

- Lời gọi trong thân hàm: `items.entries`, `item.text.replace`, `subtitleTime`.
- Kết quả: `{srt, vtt}`.

### espeakSynth

`espeakSynth(text, language, destination, { signal } = {})` · [Dòng 35–45](../../../src/narration.mjs#L35)

- Lời gọi trong thân hàm: `['vi', 'en'].includes`, `command`, `milliseconds`.
- Kết quả: `durationMs`.
- Lỗi trực tiếp có thông điệp cố định: `Unsupported narration language`, `espeak-ng returned an empty audio clip`.

### prepareNarration

`prepareNarration(planInput, root, synth = espeakSynth, { signal } = {})` · [Dòng 47–73](../../../src/narration.mjs#L47)

- Lời gọi trong thân hàm: `Plan.parse`, `path.join`, `mkdir`, `plan.steps.entries`, `Object.assign`, `synth`, `Number.isFinite`, `Math.max`, `Math.ceil`, `clips.set`, `steps.push`.
- Kết quả: `{plan, clips}`.

### renderNarrated

`renderNarrated(planInput, { outDir, headed = false, preview = false, synth = espeakSynth, renderImpl = render, commandImpl = command, signal, manualLogin = false, loginPrompt, } = {})` · [Dòng 80–156](../../../src/narration.mjs#L80)

- Lời gọi trong thân hàm: `path.resolve`, `prepareNarration`, `renderImpl`, `milliseconds`, `Date.parse`, `Number.isFinite`, `clips.get`, `Math.max`, `entries.push`, `Math.min`, `subtitleFiles`, `writeFile`, `path.join`, `args.push`, `entries.map`, `filters.push`, `filters.join`, `String`, `commandImpl`, `JSON.parse`, `probe.streams?.find`, `rename`, `JSON.stringify`, `rm`.
- Kết quả: `report`.
- Lỗi trực tiếp có thông điệp cố định: `outDir is required for narration`, `Narrated preview is not supported; render the MP4 or preview without TTS`, `Renderer did not provide media path or capture start timestamp`, `Renderer capture timestamp is invalid`, `Narrated video failed AAC/H.264 verification`.
