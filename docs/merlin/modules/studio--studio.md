# studio/studio.js

[Mở module nguồn](../../../src/studio/studio.js). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### $

`$(id)` · [Dòng 1–1](../../../src/studio/studio.js#L1)

- Lời gọi trong thân hàm: `document.getElementById`.
- Kết quả: `document.getElementById(id)`.

### toast

`toast(message, error = false)` · [Dòng 8–13](../../../src/studio/studio.js#L8)

- Lời gọi trong thân hàm: `clearTimeout`, `setTimeout`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### api

`api(route, body)` · [Dòng 15–29](../../../src/studio/studio.js#L15)

- Lời gọi trong thân hàm: `fetch`, `JSON.stringify`, `response.json`, `data.errors?.map`.
- Kết quả: `data`.
- Lỗi trực tiếp có thông điệp cố định: `Unexpected response from local Studio server`.

### switchBusy

`switchBusy(busy)` · [Dòng 31–41](../../../src/studio/studio.js#L31)

- Lời gọi trong thân hàm: `$`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### invalidate

`invalidate()` · [Dòng 43–52](../../../src/studio/studio.js#L43)

- Lời gọi trong thân hàm: `$`, `JSON.stringify`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### updateMeta

`updateMeta()` · [Dòng 54–63](../../../src/studio/studio.js#L54)

- Lời gọi trong thân hàm: `$`, `String`, `JSON.stringify`.
- Kết quả: `void`.

### makeButton

`makeButton(text, label, handler, disabled = false)` · [Dòng 65–75](../../../src/studio/studio.js#L65)

- Lời gọi trong thân hàm: `document.createElement`, `button.setAttribute`, `button.addEventListener`.
- Kết quả: `button`.

### renderSteps

`renderSteps()` · [Dòng 77–154](../../../src/studio/studio.js#L77)

- Lời gọi trong thân hàm: `$`, `list.replaceChildren`, `state.plan.steps.forEach`, `String`.
- Kết quả: `void`.

### selectValue

`selectValue(id, value)` · [Dòng 156–158](../../../src/studio/studio.js#L156)

- Lời gọi trong thân hàm: `$`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### currentTarget

`currentTarget()` · [Dòng 159–164](../../../src/studio/studio.js#L159)

- Kết quả: `{type, css}`, `{type, role, name}`, `{type}`.

### actionFields

`actionFields()` · [Dòng 165–173](../../../src/studio/studio.js#L165)

- Lời gọi trong thân hàm: `$`, `ACTIONS.has`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### targetFields

`targetFields()` · [Dòng 174–179](../../../src/studio/studio.js#L174)

- Lời gọi trong thân hàm: `$`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### renderSelected

`renderSelected()` · [Dòng 181–208](../../../src/studio/studio.js#L181)

- Lời gọi trong thân hàm: `$`, `Boolean`, `selectValue`, `currentTarget`, `targetFields`, `actionFields`.
- Kết quả: `void`.

### commitStep

`commitStep(showToast = false)` · [Dòng 210–252](../../../src/studio/studio.js#L210)

- Lời gọi trong thân hàm: `$`, `form.reportValidity`, `Number`, `ACTIONS.has`, `['branch', 'stop'].includes`, `JSON.stringify`, `invalidate`, `renderSteps`, `updateMeta`, `toast`.
- Kết quả: `true`, `false`.

### reorderStep

`reorderStep(from, to)` · [Dòng 254–269](../../../src/studio/studio.js#L254)

- Lời gọi trong thân hàm: `commitStep`, `steps.splice`, `steps.findIndex`, `invalidate`, `renderSteps`, `renderSelected`.
- Kết quả: `void`.

### moveStep

`moveStep(index, dir)` · [Dòng 271–273](../../../src/studio/studio.js#L271)

- Lời gọi trong thân hàm: `reorderStep`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### deleteStep

`deleteStep(index)` · [Dòng 275–283](../../../src/studio/studio.js#L275)

- Lời gọi trong thân hàm: `window.confirm`, `state.plan.steps.splice`, `Math.min`, `invalidate`, `updateMeta`, `renderSteps`, `renderSelected`.
- Kết quả: `void`.

### loadPlan

`loadPlan(plan, options = {})` · [Dòng 285–303](../../../src/studio/studio.js#L285)

- Lời gọi trong thân hàm: `Array.isArray`, `structuredClone`, `$`, `invalidate`, `updateMeta`, `renderSteps`, `renderSelected`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Plan must contain a non-empty steps array`.

### addStep

`addStep()` · [Dòng 305–318](../../../src/studio/studio.js#L305)

- Lời gọi trong thân hàm: `commitStep`, `crypto.randomUUID`, `state.plan.steps.findIndex`, `state.plan.steps.splice`, `invalidate`, `updateMeta`, `renderSteps`, `renderSelected`.
- Kết quả: `void`.

### updateValidation

`updateValidation(data)` · [Dòng 320–337](../../../src/studio/studio.js#L320)

- Lời gọi trong thân hàm: `$`, `list.replaceChildren`, `document.createElement`, `list.append`, `Boolean`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### validate

`validate()` · [Dòng 339–362](../../../src/studio/studio.js#L339)

- Lời gọi trong thân hàm: `commitStep`, `switchBusy`, `fetch`, `JSON.stringify`, `response.json`, `updateValidation`, `toast`, `$`.
- Kết quả: `void`.

### showJob

`showJob(title, detail)` · [Dòng 364–372](../../../src/studio/studio.js#L364)

- Lời gọi trong thân hàm: `$`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### awaitJob

`awaitJob(jobId, title)` · [Dòng 373–408](../../../src/studio/studio.js#L373)

- Lời gọi trong thân hàm: `$`, `api`, `encodeURIComponent`, `result.report?.steps?.filter`, `showJob`, `refreshJobHistory`.
- Kết quả: `result`.
- Lỗi trực tiếp có thông điệp cố định: `UI polling expired. The backend job may still be running.`.

### cancelActiveJob

`cancelActiveJob()` · [Dòng 409–421](../../../src/studio/studio.js#L409)

- Lời gọi trong thân hàm: `$`, `api`, `encodeURIComponent`, `showJob`, `toast`.
- Kết quả: `void`.

### refreshJobHistory

`refreshJobHistory()` · [Dòng 425–470](../../../src/studio/studio.js#L425)

- Lời gọi trong thân hàm: `api`, `$`, `list.replaceChildren`, `Array.isArray`, `document.createElement`, `list.append`, `Number.isNaN`, `date.getTime`, `date.toLocaleString`, `[time, job.error].filter`, `summary.append`, `open.setAttribute`, `open.addEventListener`, `actions.append`, `retry.setAttribute`, `retry.addEventListener`, `item.append`.
- Kết quả: `void`.

### openStoredJob

`openStoredJob(id)` · [Dòng 472–508](../../../src/studio/studio.js#L472)

- Lời gọi trong thân hàm: `toast`, `api`, `encodeURIComponent`, `window.confirm`, `loadPlan`, `$`, `Boolean`, `showJob`.
- Kết quả: `toast('Finish the active job before opening saved history', true)`, `void`.

### retryStoredJob

`retryStoredJob(id)` · [Dòng 510–528](../../../src/studio/studio.js#L510)

- Lời gọi trong thân hàm: `toast`, `window.confirm`, `switchBusy`, `api`, `encodeURIComponent`, `awaitJob`, `showJob`, `refreshJobHistory`, `openStoredJob`.
- Kết quả: `toast('Finish the active job before retrying history', true)`, `void`.

### discover

`discover(event)` · [Dòng 530–552](../../../src/studio/studio.js#L530)

- Lời gọi trong thân hàm: `event.preventDefault`, `switchBusy`, `$`, `Number`, `api`, `awaitJob`, `loadPlan`, `showJob`, `toast`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.
- Lỗi trực tiếp có thông điệp cố định: `Discovery returned no plan`.

### goalGuide

`goalGuide()` · [Dòng 554–578](../../../src/studio/studio.js#L554)

- Lời gọi trong thân hàm: `$`, `toast`, `switchBusy`, `api`, `awaitJob`, `loadPlan`, `showJob`.
- Kết quả: `toast('Enter a website URL and specific goal', true)`.
- Lỗi trực tiếp có thông điệp cố định: `Goal planner did not return an editable plan`.

### hostingerGuide

`hostingerGuide()` · [Dòng 580–603](../../../src/studio/studio.js#L580)

- Lời gọi trong thân hàm: `$`, `toast`, `switchBusy`, `api`, `awaitJob`, `loadPlan`, `data.report?.warnings?.join`, `showJob`.
- Kết quả: `toast('Enter a Hostinger Vietnam URL first', true)`.
- Lỗi trực tiếp có thông điệp cố định: `No observed pricing plan available`.

### assemble

`assemble()` · [Dòng 605–616](../../../src/studio/studio.js#L605)

- Lời gọi trong thân hàm: `commitStep`, `switchBusy`, `api`, `loadPlan`, `$`, `toast`.
- Kết quả: `void`.

### execute

`execute(type)` · [Dòng 618–646](../../../src/studio/studio.js#L618)

- Lời gọi trong thân hàm: `commitStep`, `toast`, `state.plan.steps.some`, `window.confirm`, `switchBusy`, `api`, `$`, `awaitJob`, `showJob`, `Math.round`.
- Kết quả: `void`, `toast('Validate before execution', true)`.
