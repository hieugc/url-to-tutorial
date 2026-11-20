# benchmark.mjs

[Mở module nguồn](../../../src/benchmark.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### percentile

`percentile(sorted, percentile)` · [Dòng 4–9](../../../src/benchmark.mjs#L4)

- Lời gọi trong thân hàm: `Math.floor`, `Math.ceil`.
- Kết quả: `0`, `sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)`.

### summarizeFrameTimes

`summarizeFrameTimes(times)` · [Dòng 11–27](../../../src/benchmark.mjs#L11)

- Lời gọi trong thân hàm: `times.filter`, `frames.slice`, `intervals.reduce`, `Number`, `percentile`, `Math.max`, `Math.sqrt`.
- Kết quả: `{frameCount, measuredFps, intervalP50Ms, intervalP95Ms, intervalMaxMs, intervalJitterStdDevMs}`.
- Lỗi trực tiếp có thông điệp cố định: `At least two decoded video frame timestamps are required`, `Frame timestamps are non-increasing or invalid`.

### inspectVideo

`inspectVideo(file, commandImpl = command)` · [Dòng 29–47](../../../src/benchmark.mjs#L29)

- Lời gọi trong thân hàm: `JSON.parse`, `commandImpl`, `meta.streams?.find`, `Number`, `Boolean`, `meta.streams.some`, `summarizeFrameTimes`.
- Kết quả: `{file, codec, width, height, durationSec, audio, …}`.

### compareCaptures

`compareCaptures(baseline, candidate)` · [Dòng 49–61](../../../src/benchmark.mjs#L49)

- Kết quả: `{status, note}`, `{status, baselineFps, candidateFps, baselineJitterMs, candidateJitterMs, note}`.
