# cloud-worker-adapter.mjs

[Mở module nguồn](../../../src/cloud-worker-adapter.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### abortError

`abortError()` · [Dòng 10–14](../../../src/cloud-worker-adapter.mjs#L10)

- Kết quả: `error`.

### runDocker

`runDocker(dockerBin, args, { input = '', timeoutMs = 30000, maxOutputBytes = MAX_RESULT_BYTES } = {})` · [Dòng 16–54](../../../src/cloud-worker-adapter.mjs#L16)

- Kết quả: `new Promise((resolve, reject) => { const child = spawn(dockerBin, args, { shell: false, stdio: ['pipe', 'pi…`.

### runDocker → append

`append(current, chunk, limit)` · [Dòng 26–34](../../../src/cloud-worker-adapter.mjs#L26)

- Lời gọi trong thân hàm: `Buffer.concat`, `child.kill`.
- Kết quả: `current`, `next`.

### validateImage

`validateImage(image)` · [Dòng 56–61](../../../src/cloud-worker-adapter.mjs#L56)

- Lời gọi trong thân hàm: `DIGEST_IMAGE.test`.
- Kết quả: `image`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud worker image must be pinned by an immutable @sha256 digest`.

### directoryBytes

`directoryBytes(root)` · [Dòng 63–76](../../../src/cloud-worker-adapter.mjs#L63)

- Lời gọi trong thân hàm: `pending.pop`, `readdir`, `path.join`, `lstat`, `info.isDirectory`, `info.isSymbolicLink`, `pending.push`, `info.isFile`.
- Kết quả: `total`.

### reconcileOrphanedCloudNetworks

`reconcileOrphanedCloudNetworks({ dockerBin = 'docker', proxyContainer = 'url-tutorial-egress-proxy', activeJobIds, runDockerImpl = runDocker, } = {})` · [Dòng 90–198](../../../src/cloud-worker-adapter.mjs#L90)

- Lời gọi trong thân hàm: `SAFE_CONTAINER_NAME.test`, `Array.isArray`, `activeJobIds.some`, `activeJobIds.map`, `runDockerImpl`, `String`, `JOB_NETWORK.exec`, `result.skipped.push`, `name.slice`, `match[1].toLowerCase`, `active.has`, `inspect`, `details.Labels?.['tutorial.job-id']?.toLowerCase`, `Object.values`, `endpoints.some`, `afterDisconnect.Labels?.['tutorial.job-id']?.toLowerCase`, `Object.keys`, `result.removed.push`, `result.failed.push`, `Object.freeze`.
- Kết quả: `{scanned, removed, skipped, failed}`.
- Lỗi trực tiếp có thông điệp cố định: `A valid egress proxy container name is required`, `active job IDs must be UUIDs`, `runDockerImpl must be a function`, `Docker returned too many candidate job networks; refusing startup reconciliation`.

### reconcileOrphanedCloudNetworks → inspect

`inspect(name)` · [Dòng 119–132](../../../src/cloud-worker-adapter.mjs#L119)

- Lời gọi trong thân hàm: `runDockerImpl`, `JSON.parse`, `Array.isArray`.
- Kết quả: `parsed[0]`.
- Lỗi trực tiếp có thông điệp cố định: `invalid-inspect-response`.

### buildDockerWorkerRunArgs

`buildDockerWorkerRunArgs({ jobId, containerName, networkName, image, outputDir, uid, gid, memoryLimit = '2g', cpuLimit = '2', pidsLimit = 128, timeoutMs = 600000, } = {})` · [Dòng 200–249](../../../src/cloud-worker-adapter.mjs#L200)

- Lời gọi trong thân hàm: `UUID.test`, `validateImage`, `path.isAbsolute`, `outputDir.includes`, `Number.isInteger`, `Number.isSafeInteger`, `/^[1-9][0-9]*[mkg]$/i.test`, `String`.
- Kết quả: `Array (45 phần tử trong biểu thức gốc)`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid isolated worker identity`, `Worker output mount must be an absolute, comma-free path`, `Worker must run as a non-root numeric uid/gid`, `Invalid worker resource limits`.

### createDockerWorkerAdapter

`createDockerWorkerAdapter({ dockerBin = 'docker', image = process.env.TUTORIAL_WORKER_IMAGE, allowedOutputRoot, proxyContainer = 'url-tutorial-egress-proxy', memoryLimit = '2g', cpuLimit = '2', pidsLimit = 128, timeoutMs = 600000, maxOutputBytes = 1024 * 1024 * 1024, outputCheckIntervalMs = 1000, runDockerImpl = runDocker, } = {})` · [Dòng 256–454](../../../src/cloud-worker-adapter.mjs#L256)

- Lời gọi trong thân hàm: `validateImage`, `process.getuid`, `path.isAbsolute`, `Number.isSafeInteger`, `path.resolve`.
- Kết quả: `runIsolatedCloudJob`.
- Lỗi trực tiếp có thông điệp cố định: `Docker worker orchestrator must run as a non-root POSIX host user`, `allowedOutputRoot must be an absolute path matching Studio outputRoot`, `Invalid egress proxy container name`, `Invalid cloud worker output size monitor limits`, `runDockerImpl must be a function`.

### createDockerWorkerAdapter → safeDocker

`safeDocker(args)` · [Dòng 288–291](../../../src/cloud-worker-adapter.mjs#L288)

- Lời gọi trong thân hàm: `runDocker`.
- Kết quả: `await runDocker(dockerBin, args, { timeoutMs: 10000, maxOutputBytes: 64 * 1024 })`, `null`.

### createDockerWorkerAdapter → stopContainer

`stopContainer(containerName)` · [Dòng 293–301](../../../src/cloud-worker-adapter.mjs#L293)

- Lời gọi trong thân hàm: `safeDocker`.
- Kết quả: `void`.

### createDockerWorkerAdapter → runIsolatedCloudJob

`runIsolatedCloudJob(job)` · [Dòng 303–448](../../../src/cloud-worker-adapter.mjs#L303)

- Lời gọi trong thân hàm: `UUID.test`, `['discover', 'goal', 'hostinger', 'render'].includes`, `abortError`, `process.getuid`, `lstat`, `rootInfo.isDirectory`, `rootInfo.isSymbolicLink`, `outputInfo.isDirectory`, `outputInfo.isSymbolicLink`, `Promise.all`, `realpath`, `path.relative`, `relative.startsWith`, `path.isAbsolute`, `outputReal.includes`, `job.jobId.toLowerCase`, `JSON.stringify`, `Buffer.byteLength`, `Promise.resolve`, `runDocker`, `buildDockerWorkerRunArgs`, `process.getgid`, `job.signal?.addEventListener`, `Number.isSafeInteger`, `Math.min`, `setTimeout`, `monitorTimer.unref`, `JSON.parse`, `Array.isArray`, `clearTimeout`, `job.signal?.removeEventListener`, `stopContainer`, `safeDocker`.
- Kết quả: `parsed`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid isolated cloud job envelope`, `Docker worker orchestrator must run as a non-root host user`, `Cloud output root must be a real directory, not a symlink`, `Cloud job output must be an existing real directory`, `Cloud job output directory must be inside the configured output root`, `Cloud job output path cannot contain Docker mount delimiters`, `Cloud worker request exceeds 512 KiB`, `Isolated worker returned invalid JSON output`, `Isolated worker returned an invalid result`.

### createDockerWorkerAdapter → runIsolatedCloudJob → onAbort

`onAbort()` · [Dòng 351–353](../../../src/cloud-worker-adapter.mjs#L351)

- Lời gọi trong thân hàm: `stopContainer`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### createDockerWorkerAdapter → runIsolatedCloudJob → monitorOutput

`monitorOutput()` · [Dòng 380–402](../../../src/cloud-worker-adapter.mjs#L380)

- Lời gọi trong thân hàm: `directoryBytes`, `stopContainer`, `setTimeout`, `monitorTimer.unref`.
- Kết quả: `void`.

### createDockerWorkerAdapter → reconcileOrphanedNetworks

`reconcileOrphanedNetworks({ activeJobIds } = {})` · [Dòng 449–452](../../../src/cloud-worker-adapter.mjs#L449)

- Lời gọi trong thân hàm: `reconcileOrphanedCloudNetworks`.
- Kết quả: `reconcileOrphanedCloudNetworks({ dockerBin, proxyContainer, activeJobIds, runDockerImpl, })`.
