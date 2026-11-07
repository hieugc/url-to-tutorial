import { spawn } from 'node:child_process';
import { lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[a-f0-9-]{36}$/i;
const DIGEST_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:~-]*@sha256:[a-f0-9]{64}$/i;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

function abortError() {
  const error = new Error('Cloud worker cancelled');
  error.name = 'AbortError';
  return error;
}

function runDocker(dockerBin, args, { input = '', timeoutMs = 30000, maxOutputBytes = MAX_RESULT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const append = (current, chunk, limit) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > limit) {
        overflow = true;
        child.kill('SIGKILL');
        return current;
      }
      return next;
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk, maxOutputBytes); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk, 64 * 1024); });
    child.stdin.on('error', () => {});
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (overflow) {
        reject(new Error('Docker command exceeded its output or time limit'));
      } else if (code !== 0) {
        reject(new Error('Docker command failed (' + code + '): ' + stderr.toString('utf8').slice(-12000)));
      } else {
        resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      }
    });
    child.stdin.end(input);
  });
}

function validateImage(image) {
  if (typeof image !== 'string' || !DIGEST_IMAGE.test(image)) {
    throw new TypeError('Cloud worker image must be pinned by an immutable @sha256 digest');
  }
  return image;
}

export async function directoryBytes(root) {
  const pending = [root];
  let total = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (info.isDirectory() && !info.isSymbolicLink()) pending.push(file);
      else if (info.isFile() || info.isSymbolicLink()) total += info.size;
    }
  }
  return total;
}

export function buildDockerWorkerRunArgs({
  jobId, containerName, networkName, image, outputDir, uid, gid,
  memoryLimit = '2g', cpuLimit = '2', pidsLimit = 128, timeoutMs = 600000,
} = {}) {
  if (!UUID.test(jobId || '') || containerName !== 'utv-worker-' + jobId ||
      networkName !== 'utv-job-' + jobId) throw new TypeError('Invalid isolated worker identity');
  validateImage(image);
  if (!path.isAbsolute(outputDir || '') || outputDir.includes(',') ||
      outputDir.includes('\n') || outputDir.includes('\r')) {
    throw new TypeError('Worker output mount must be an absolute, comma-free path');
  }
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new TypeError('Worker must run as a non-root numeric uid/gid');
  }
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 16 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000 ||
      !/^[1-9][0-9]*[mkg]$/i.test(memoryLimit) ||
      !/^(?:[0-9]+(?:\.[0-9]+)?)$/.test(String(cpuLimit))) {
    throw new TypeError('Invalid worker resource limits');
  }
  return [
    'run', '--rm', '--init', '--interactive', '--pull=never',
    '--name', containerName,
    '--label', 'app=url-to-tutorial',
    '--label', 'tutorial.job-id=' + jobId,
    '--network', networkName,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=' + pidsLimit,
    '--memory=' + memoryLimit,
    '--memory-swap=' + memoryLimit,
    '--shm-size=256m',
    '--cpus=' + cpuLimit,
    '--ulimit', 'nofile=1024:1024',
    '--user', uid + ':' + gid,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,uid=' + uid + ',gid=' + gid,
    '--mount', 'type=bind,src=' + outputDir + ',dst=/job,rw',
    '--env', 'HOME=/tmp',
    '--env', 'TMPDIR=/tmp',
    '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    '--env', 'TUTORIAL_EGRESS_PROXY=http://egress-proxy:3128',
    '--env', 'TUTORIAL_WORKER_TIMEOUT_MS=' + timeoutMs,
    '--workdir=/app',
    '--hostname=worker',
    '--stop-timeout=2',
    image,
    'node', 'src/cloud-worker.mjs',
  ];
}

/**
 * Launches one disposable container and one internal-only Docker network per
 * job. The only peer on that network is the dedicated egress proxy. The API
 * process needs trusted Docker-daemon access; the worker never receives it.
 */
export function createDockerWorkerAdapter({
  dockerBin = 'docker',
  image = process.env.TUTORIAL_WORKER_IMAGE,
  allowedOutputRoot,
  proxyContainer = 'url-tutorial-egress-proxy',
  memoryLimit = '2g',
  cpuLimit = '2',
  pidsLimit = 128,
  timeoutMs = 600000,
  maxOutputBytes = 1024 * 1024 * 1024,
  outputCheckIntervalMs = 1000,
} = {}) {
  validateImage(image);
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function' ||
      process.getuid() === 0) {
    throw new Error('Docker worker orchestrator must run as a non-root POSIX host user');
  }
  if (typeof allowedOutputRoot !== 'string' || !path.isAbsolute(allowedOutputRoot)) {
    throw new TypeError('allowedOutputRoot must be an absolute path matching Studio outputRoot');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(proxyContainer)) {
    throw new TypeError('Invalid egress proxy container name');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 * 1024 ||
      !Number.isSafeInteger(outputCheckIntervalMs) || outputCheckIntervalMs < 100 ||
      outputCheckIntervalMs > 10000) {
    throw new TypeError('Invalid cloud worker output size monitor limits');
  }
  const rootPath = path.resolve(allowedOutputRoot);

  async function safeDocker(args) {
    try { return await runDocker(dockerBin, args, { timeoutMs: 10000, maxOutputBytes: 64 * 1024 }); }
    catch { return null; }
  }

  async function stopContainer(containerName) {
    // The abort can arrive while docker run is still creating the container.
    // Retry briefly so a cancellation cannot leave a detached browser worker.
    for (let attempt = 0; attempt < 8; attempt++) {
      const stopped = await safeDocker(['stop', '--time', '2', containerName]);
      if (stopped) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return async function runIsolatedCloudJob(job) {
    if (!job || !UUID.test(job.jobId || '') ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(job.tenantId || '') ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(job.projectId || '') ||
        !['discover', 'goal', 'hostinger', 'render'].includes(job.type) ||
        !job.request || typeof job.request !== 'object') {
      throw new TypeError('Invalid isolated cloud job envelope');
    }
    if (job.signal?.aborted) throw abortError();
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function' ||
        process.getuid() === 0) {
      throw new Error('Docker worker orchestrator must run as a non-root host user');
    }

    const rootInfo = await lstat(rootPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('Cloud output root must be a real directory, not a symlink');
    }
    const outputInfo = await lstat(job.outputDir);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
      throw new Error('Cloud job output must be an existing real directory');
    }
    const [rootReal, outputReal] = await Promise.all([realpath(rootPath), realpath(job.outputDir)]);
    const relative = path.relative(rootReal, outputReal);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Cloud job output directory must be inside the configured output root');
    }
    if (outputReal.includes(',') || outputReal.includes('\n') || outputReal.includes('\r')) {
      throw new Error('Cloud job output path cannot contain Docker mount delimiters');
    }

    const jobId = job.jobId.toLowerCase();
    const networkName = 'utv-job-' + jobId;
    const containerName = 'utv-worker-' + jobId;
    const envelope = JSON.stringify({
      jobId, tenantId: job.tenantId, projectId: job.projectId,
      type: job.type, request: job.request,
    });
    if (Buffer.byteLength(envelope) > MAX_ENVELOPE_BYTES) {
      throw new Error('Cloud worker request exceeds 512 KiB');
    }

    let networkCreated = false;
    let stopPromise = null;
    let monitorTimer = null;
    let monitorStopped = false;
    let monitorError = null;
    let monitorPromise = Promise.resolve();
    const onAbort = () => {
      if (!stopPromise) stopPromise = stopContainer(containerName);
    };
    try {
      if (job.signal?.aborted) throw abortError();
      await runDocker(dockerBin, [
        'network', 'create', '--internal', '--driver', 'bridge',
        '--label', 'app=url-to-tutorial',
        '--label', 'tutorial.job-id=' + jobId,
        networkName,
      ], { timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
      networkCreated = true;
      if (job.signal?.aborted) throw abortError();

      await runDocker(dockerBin, [
        'network', 'connect', '--alias', 'egress-proxy', networkName, proxyContainer,
      ], { timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
      if (job.signal?.aborted) throw abortError();

      const args = buildDockerWorkerRunArgs({
        jobId, containerName, networkName, image, outputDir: outputReal,
        uid: process.getuid(), gid: process.getgid(),
        memoryLimit, cpuLimit, pidsLimit, timeoutMs,
      });
      job.signal?.addEventListener('abort', onAbort, { once: true });
      if (job.signal?.aborted) throw abortError();

      const monitorOutput = async () => {
        if (monitorStopped || monitorError) return;
        try {
          const bytes = await directoryBytes(outputReal);
          if (bytes > maxOutputBytes) {
            monitorError = new Error('Cloud worker output exceeded the configured byte limit');
            if (!stopPromise) stopPromise = stopContainer(containerName);
            await stopPromise;
            return;
          }
        } catch (error) {
          monitorError = new Error('Unable to verify cloud worker output size: ' + error.message);
          if (!stopPromise) stopPromise = stopContainer(containerName);
          await stopPromise;
          return;
        }
        if (!monitorStopped && !monitorError) {
          monitorTimer = setTimeout(() => {
            monitorPromise = monitorOutput();
          }, outputCheckIntervalMs);
          monitorTimer.unref?.();
        }
      };
      monitorTimer = setTimeout(() => {
        monitorPromise = monitorOutput();
      }, outputCheckIntervalMs);
      monitorTimer.unref?.();

      let result;
      try {
        result = await runDocker(dockerBin, args, {
          input: envelope, timeoutMs: timeoutMs + 30000, maxOutputBytes: MAX_RESULT_BYTES,
        });
      } catch (error) {
        if (monitorError) throw monitorError;
        throw error;
      }
      if (monitorError) throw monitorError;
      if (job.signal?.aborted) throw abortError();
      let parsed;
      try { parsed = JSON.parse(result.stdout); }
      catch { throw new Error('Isolated worker returned invalid JSON output'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Isolated worker returned an invalid result');
      }
      return parsed;
    } catch (error) {
      if (job.signal?.aborted) throw abortError();
      throw error;
    } finally {
      monitorStopped = true;
      if (monitorTimer) clearTimeout(monitorTimer);
      await monitorPromise;
      job.signal?.removeEventListener('abort', onAbort);
      if (job.signal?.aborted) {
        if (!stopPromise) stopPromise = stopContainer(containerName);
        await stopPromise;
      }
      await safeDocker(['rm', '-f', containerName]);
      if (networkCreated) {
        await safeDocker(['network', 'disconnect', '--force', networkName, proxyContainer]);
        const removed = await safeDocker(['network', 'rm', networkName]);
        if (!removed) {
          throw new Error('Failed to remove isolated worker network ' + networkName +
            '; verify Docker daemon state and remove the labeled network before accepting more jobs');
        }
      }
    }
  };
}
