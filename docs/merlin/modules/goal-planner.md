# goal-planner.mjs

[Mở module nguồn](../../../src/goal-planner.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### unsafeCandidateLabel

`unsafeCandidateLabel(text)` · [Dòng 19–23](../../../src/goal-planner.mjs#L19)

- Lời gọi trong thân hàm: `BLOCKED_TEXT.test`, `INSTRUCTION_TEXT.test`, `EMAIL_VALUE.test`, `LONG_NUMBER.test`.
- Kết quả: `true`, `BLOCKED_TEXT.test(text) || INSTRUCTION_TEXT.test(text) || EMAIL_VALUE.test(text) || LONG_NUMBER.test(text)`.

### normalizedText

`normalizedText(text)` · [Dòng 25–28](../../../src/goal-planner.mjs#L25)

- Lời gọi trong thân hàm: `String`.
- Kết quả: `String(text).toLocaleLowerCase('vi').normalize('NFD') .replace(/[\u0300-\u036f]/g, '')`.

### clean

`clean(text, max = 160)` · [Dòng 30–32](../../../src/goal-planner.mjs#L30)

- Lời gọi trong thân hàm: `String`.
- Kết quả: `String(text || '').replace(/\s+/g, ' ').trim().slice(0, max)`.

### tokens

`tokens(text)` · [Dòng 33–37](../../../src/goal-planner.mjs#L33)

- Lời gọi trong thân hàm: `normalizedText`, `clean`.
- Kết quả: `normalizedText(clean(text, 500)) .split(/[^a-z0-9]+/) .filter(word => word.length >= 3 && !STOP_WORDS.has(word))`.

### candidatesFromDiscovery

`candidatesFromDiscovery(discovery)` · [Dòng 39–54](../../../src/goal-planner.mjs#L39)

- Lời gọi trong thân hàm: `pages.find`, `first.candidates.slice`, `clean`, `unsafeCandidateLabel`, `seen.has`, `seen.add`, `result.push`.
- Kết quả: `{url, title, candidates}`.
- Lỗi trực tiếp có thông điệp cố định: `Insufficient DOM evidence: discovery did not find visible elements`, `No safe, visible DOM candidates available for this goal`.

### selectOffline

`selectOffline(goal, candidates)` · [Dòng 56–66](../../../src/goal-planner.mjs#L56)

- Lời gọi trong thân hàm: `tokens`, `candidates.map`, `scored.slice`.
- Kết quả: `{selectedIds, reason}`.
- Lỗi trực tiếp có thông điệp cố định: `Goal is too vague. Add a concrete feature or page name`, `Insufficient evidence: no observed element matches the requested goal`.

### verifySelection

`verifySelection(selectedIds, candidates)` · [Dòng 68–84](../../../src/goal-planner.mjs#L68)

- Lời gọi trong thân hàm: `Array.isArray`, `candidates.map`, `available.has`, `seen.has`, `seen.add`, `selected.push`, `available.get`.
- Kết quả: `selected`.
- Lỗi trực tiếp có thông điệp cố định: `Planner must select between 1 and 6 observed candidate IDs`, `Planner referenced a candidate ID that was not in observed DOM evidence`, `Planner returned a duplicate candidate ID`.

### verifyGoalRelevance

`verifyGoalRelevance(goal, selected)` · [Dòng 90–100](../../../src/goal-planner.mjs#L90)

- Lời gọi trong thân hàm: `tokens`, `normalizedText`, `[...wanted].some`.
- Kết quả: `selected`.
- Lỗi trực tiếp có thông điệp cố định: `Goal is too vague. Add a concrete feature or page name`, `Insufficient evidence: model-selected DOM candidate is unrelated to the goal`.

### selectWithOpenAI

`selectWithOpenAI(goal, candidates, { apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-6-luna', fetchImpl = fetch, signal, } = {})` · [Dòng 107–177](../../../src/goal-planner.mjs#L107)

- Lời gọi trong thân hàm: `Array.isArray`, `candidates.some`, `fetchImpl`, `AbortSignal.timeout`, `JSON.stringify`, `clean`, `candidates.map`, `response.json`, `raw.output?.flatMap`, `JSON.parse`, `verifyGoalRelevance`, `verifySelection`.
- Kết quả: `{selectedIds, reason, model}`.
- Lỗi trực tiếp có thông điệp cố định: `OPENAI_API_KEY is required for --ai; use offline mode without it`, `Invalid model identifier`, `Sensitive or untrusted instruction-like DOM labels cannot be sent to AI`, `LLM response did not complete`, `LLM returned invalid structured JSON`, `LLM selection schema mismatch`.

### goalPlanFromSelection

`goalPlanFromSelection({ url, title = 'Website', goal, language = 'vi', candidates, selection, })` · [Dòng 179–214](../../../src/goal-planner.mjs#L179)

- Lời gọi trong thân hàm: `['vi', 'en'].includes`, `goal.trim`, `verifyGoalRelevance`, `verifySelection`, `picked.map`, `steps.push`, `Plan.parse`, `clean`.
- Kết quả: `Plan.parse(…)`.
- Lỗi trực tiếp có thông điệp cố định: `language must be vi or en`, `A specific goal of 4–400 characters is required`.

### createGoalGuide

`createGoalGuide(url, { goal, outDir, language = 'vi', ai = false, exploreImpl = explore, selectImpl = selectWithOpenAI, signal, } = {})` · [Dòng 216–260](../../../src/goal-planner.mjs#L216)

- Lời gọi trong thân hàm: `goal.trim`, `path.resolve`, `mkdir`, `clean`, `exploreImpl`, `candidatesFromDiscovery`, `Object.assign`, `selectImpl`, `selectOffline`, `goalPlanFromSelection`, `writeFile`, `path.join`, `JSON.stringify`.
- Kết quả: `{plan, evidence, report}`.
- Lỗi trực tiếp có thông điệp cố định: `Enter a specific goal (4–400 characters)`.
