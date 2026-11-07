import { createServer } from 'node:http';
import { constants as fsConstants, rmSync } from 'node:fs';
import { mkdir, readFile, lstat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { explore } from './discover.mjs';
import { createGoalGuide } from './goal-planner.mjs';
import { createHostingerGuide, validateHostingerUrl } from './adapters/hostinger.mjs';
import { assemblePages } from './assemble.mjs';
import { HttpUrl, Plan, validatePlanForExecution } from './plan.mjs';
import { render } from './render.mjs';
import { renderNarrated } from './narration.mjs';
import { StudioJobStore } from './job-store.mjs';
import { createCloudAuth } from './cloud-auth.mjs';
import { publicUrlPreflight } from './cloud-egress.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'studio');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/studio.js', ['studio.js', 'text/javascript; charset=utf-8']],
]);
const MAX_BYTES = 512 * 1024;
const MAX_PENDING = 4;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function bodyJson(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    throw bad('Expected application/json', 415);
  }
  let count = 0;
  const buffers = [];
  for await (const buf of req) {
    count += buf.length;
    if (count > MAX_BYTES) throw bad('JSON body too large', 413);
    buffers.push(buf);
  }
  try {
    const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw bad('Invalid JSON object'); }
}

function localRequest(req) {
  const host = String(req.headers.host || '');
  let hostname;
  try { hostname = new URL('http://' + host).hostname; } catch { return false; }
  if (!['localhost', '127.0.0.1'].includes(hostname)) return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).origin === 'http://' + host; }
  catch { return false; }
}

function checkPlan(input) {
  const parsed = Plan.safeParse(input);
  if (!parsed.success) {
    return {
      plan: null, valid: false, ready: false,
      errors: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
      reviewIssues: [],
    };
  }
  const reviewIssues = validatePlanForExecution(parsed.data);
  return { plan: parsed.data, valid: true, ready: reviewIssues.length === 0, errors: [], reviewIssues };
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function idempotencyKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return null;
  const key = String(raw).trim();
  if (key.length < 8 || key.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(key)) {
    throw bad('Idempotency-Key must be 8–128 characters (letters, numbers, . _ : -)', 400);
  }
  return key;
}

function isSafeRetryable(job) {
  return Boolean(job?.request) &&
    ['failed', 'cancelled', 'interrupted'].includes(job.status) &&
    ['discover', 'hostinger', 'goal'].includes(job.type) &&
    !(job.type === 'goal' && job.request.ai === true);
}

function publicReport(report) {
  if (!report) return null;
  const copy = structuredClone(report);
  if (copy.video) delete copy.video.path;
  return copy;
}

async function openJobArtifact(outputRoot, jobId, filename, maxBytes) {
  if (!/^[a-f0-9-]{36}$/i.test(jobId) || !/^[a-z0-9.-]+$/i.test(filename) || filename === '.' || filename === '..') {
    throw new Error('Invalid artifact identity');
  }
  const jobDir = path.join(path.resolve(outputRoot), jobId);
  const directory = await lstat(jobDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Job output directory is not a real directory');
  }
  const file = path.join(jobDir, filename);
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error('Artifact is not a regular file or exceeds its size limit');
    }
    return { handle, info };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readJobJson(outputRoot, jobId, filename, maxBytes = 2 * 1024 * 1024) {
  const { handle } = await openJobArtifact(outputRoot, jobId, filename, maxBytes);
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('Job report exceeds its size limit');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

function streamJobArtifact(res, opened, headers) {
  res.writeHead(200, headers);
  const stream = opened.handle.createReadStream();
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
}

/**
 * Default Studio mode is local-only and single-worker; URLs are operator-controlled.
 * The opt-in cloud control plane requires bearer/project auth, a trusted TLS proxy,
 * and an injected isolated-worker adapter. It is not a production deployment recipe:
 * actual worker network isolation and egress enforcement remain external release gates.
 */
export function createStudioServer({
  outputRoot = path.resolve('output/studio'),
  exploreImpl = explore,
  goalImpl = createGoalGuide,
  hostingerImpl = createHostingerGuide,
  assembleImpl = assemblePages,
  renderImpl = render,
  cloudMode = false,
  cloudTokens = [],
  cloudLimits = {},
  cloudAllowedHosts = [],
  cloudTrustedProxy = false,
  cloudWorker = null,
  cloudPreflight = publicUrlPreflight,
} = {}) {
  const allowedCloudHosts = new Set(cloudAllowedHosts.map(host => String(host).trim().toLowerCase()));
  if (cloudMode && (!allowedCloudHosts.size ||
      [...allowedCloudHosts].some(host => !/^(?=.{1,253}$)[a-z0-9.-]+$/.test(host)))) {
    throw new TypeError('Cloud mode requires an explicit list of allowed hostnames');
  }
  if (cloudMode && cloudTrustedProxy !== true) {
    throw new TypeError('Cloud mode requires an explicitly trusted TLS-terminating reverse proxy');
  }
  if (cloudMode && !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new TypeError('Cloud mode requires filesystem O_NOFOLLOW support for tenant artifact isolation');
  }
  if (cloudMode && typeof cloudWorker !== 'function') {
    throw new TypeError('Cloud mode requires an isolated-worker adapter; local browser execution is disabled');
  }
  const cloudAuth = cloudMode ? createCloudAuth({ tokens: cloudTokens, limits: cloudLimits }) : null;
  const store = new StudioJobStore(outputRoot);
  if (cloudMode) {
    store.pruneCloudSubmissions(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  }
  const jobs = new Map(store.recover().map(job => [job.id, job]));
  function pruneHistory() {
    const expiredIds = store.expired().map(job => job.id);
    for (const id of expiredIds) store.delete(id);
    for (const id of [...expiredIds, ...store.trim()]) {
      // Never trust a persisted outputDir when removing files.
      if (/^[a-f0-9-]{36}$/i.test(id)) {
        rmSync(path.join(path.resolve(outputRoot), id), { recursive: true, force: true });
      }
      jobs.delete(id);
    }
  }
  pruneHistory();
  let queue = Promise.resolve();

  function inScope(job, principal) {
    return !cloudMode || Boolean(principal && job.tenantId === principal.tenantId &&
      job.projectId === principal.projectId);
  }

  function findJob(id, principal) {
    const job = jobs.get(id);
    return job && inScope(job, principal) ? job : null;
  }

  function audit(principal, action, resourceId = null, outcome = 'success', details = null) {
    if (!cloudMode || !principal) return;
    store.recordCloudAudit({
      tenantId: principal.tenantId, projectId: principal.projectId,
      principalId: principal.principalId, action, resourceId, outcome, details,
    });
  }

  function cloudRequestAllowed(req) {
    let host;
    try {
      const parsed = new URL('http://' + String(req.headers.host || ''));
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
      host = parsed.hostname.toLowerCase();
    } catch { return false; }
    if (!allowedCloudHosts.has(host) || req.headers['x-forwarded-proto'] !== 'https') return false;
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.protocol !== 'https:' || origin.hostname.toLowerCase() !== host ||
            origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
      } catch { return false; }
    }
    return true;
  }

  function start(type, work, requestSnapshot = null, key = null, principal = null,
    auditAction = 'job.submitted') {
    if (cloudMode && (!principal?.tenantId || !principal?.projectId)) {
      throw bad('Authenticated tenant/project context required', 401);
    }
    const scope = cloudMode ? principal.tenantId + '\n' + principal.projectId + '\n' : '';
    const requestHash = createHash('sha256')
      .update(type + '\n' + scope + stableJson(requestSnapshot))
      .digest('hex');
    if (key) {
      const existing = [...jobs.values()].find(job => job.idempotencyKey === key && inScope(job, principal));
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw bad('Idempotency-Key was already used with a different request', 409);
        }
        existing._deduplicated = true;
        return existing;
      }
    }
    const allJobs = [...jobs.values()];
    const pending = allJobs.filter(job => ['queued', 'running'].includes(job.status)).length;
    if (pending >= MAX_PENDING) throw bad('Job queue is full (4 pending jobs)', 429);
    if (cloudMode) {
      const now = Date.now();
      const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      store.pruneCloudSubmissions(cutoff);
      const dailyCount = store.countCloudSubmissions(principal.tenantId, cutoff);
      const quota = cloudAuth.checkJobQuota(allJobs, principal, now, dailyCount);
      if (!quota.allowed) {
        audit(principal, 'quota.job_denied', null, 'denied', { jobType: type, reason: quota.reason });
        throw bad(quota.reason, 429);
      }
    }
    const id = randomUUID();
    // Persist plans for diagnostics, but never persist plaintext fill values.
    const request = requestSnapshot ? structuredClone(requestSnapshot) : null;
    if (request?.plan?.steps) {
      for (const step of request.plan.steps) if (step.action === 'fill') step.value = '[redacted]';
    }
    const job = { id, type, status: 'queued', createdAt: new Date().toISOString(),
      outputDir: path.join(path.resolve(outputRoot), id), startedAt: null,
      finishedAt: null, result: null, error: null, request,
      ...(cloudMode ? { tenantId: principal.tenantId, projectId: principal.projectId } : {}),
      idempotencyKey: key, requestHash, cancelRequested: false,
      abortController: new AbortController() };
    if (cloudMode) {
      store.saveCloudSubmission(job, {
        tenantId: principal.tenantId, projectId: principal.projectId,
        principalId: principal.principalId, action: auditAction,
        resourceId: id, details: { jobType: type },
      });
    } else store.save(job);
    jobs.set(id, job);
    pruneHistory();
    queue = queue.catch(() => {}).then(async () => {
      if (job.status === 'cancelled') return;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      store.save(job);
      try {
        await mkdir(job.outputDir, { recursive: true });
        job.result = cloudMode
          ? await cloudWorker({
            jobId: job.id, tenantId: job.tenantId, projectId: job.projectId,
            type: job.type, request: requestSnapshot ? structuredClone(requestSnapshot) : null,
            outputDir: job.outputDir, signal: job.abortController.signal,
          })
          : await work(job, job.abortController.signal);
        if (job.abortController.signal.aborted) {
          job.status = 'cancelled';
          job.error = 'Cancelled by operator';
        } else {
          job.status = 'completed';
        }
      } catch (error) {
        const cancelled = job.abortController.signal.aborted || error.name === 'AbortError';
        job.error = cancelled ? 'Cancelled by operator' : (error.message || 'Job failed');
        job.status = cancelled ? 'cancelled' : 'failed';
      } finally {
        job.finishedAt = new Date().toISOString();
        store.save(job);
        if (cloudMode) {
          audit({ tenantId: job.tenantId, projectId: job.projectId, principalId: principal?.principalId },
            job.status === 'completed' ? 'job.completed' : job.status === 'cancelled' ? 'job.cancelled' : 'job.failed',
            job.id, job.status === 'failed' ? 'failed' : 'success', { jobType: job.type });
        }
        pruneHistory();
      }
    });
    return job;
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (cloudMode ? !cloudRequestAllowed(req) : !localRequest(req)) {
      return json(res, 403, { error: cloudMode ? 'Host or Origin is not allowed' : 'Local loopback requests only' });
    }
    let principal = null;
    if (cloudMode && pathname !== '/api/health') {
      const authenticated = cloudAuth.authenticate(req);
      if (!authenticated) return json(res, 401, { error: 'Bearer authentication required' });
      principal = cloudAuth.authorizeProject(authenticated, req.headers['x-project-id']);
      if (!principal) {
        store.recordCloudAudit({
          tenantId: authenticated.tenantId, principalId: authenticated.principalId,
          action: 'project.access_denied', outcome: 'denied',
        });
        return json(res, 403, { error: 'Project access denied' });
      }
      const rate = cloudAuth.consumeRequest(principal, store);
      if (!rate.allowed) {
        audit(principal, 'quota.request_denied', null, 'denied', { retryAfterSeconds: rate.retryAfterSeconds });
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        return json(res, 429, { error: 'Tenant request rate limit exceeded' });
      }
    }
    try {
      if (req.method === 'GET' && assets.has(pathname)) {
        if (cloudMode) return json(res, 404, { error: 'Studio UI is disabled in cloud API mode' });
        const [filename, type] = assets.get(pathname);
        const data = await readFile(path.join(publicDir, filename));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
        return res.end(data);
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { status: 'ok', scope: cloudMode ? 'cloud-api-control-plane' : 'local-only',
          persistence: 'sqlite', cloudApiEnabled: cloudMode });
      }
      if (req.method === 'GET' && pathname === '/api/jobs') {
        return json(res, 200, {
          jobs: [...jobs.values()].filter(job => inScope(job, principal)).slice(-40).reverse().map(job => ({
            id: job.id, type: job.type, status: job.status, createdAt: job.createdAt,
            finishedAt: job.finishedAt, error: job.error, cancelRequested: job.cancelRequested === true,
            retryable: isSafeRetryable(job),
          })),
        });
      }

      const jobPath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})$/i);
      if (req.method === 'GET' && jobPath) {
        const job = findJob(jobPath[1], principal);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        let report = job.result?.report || job.result;
        if (!report && job.status === 'running' && job.type !== 'discover') {
          try { report = await readJobJson(outputRoot, job.id, 'report.json'); }
          catch { /* missing, symlinked, oversized or not yet written */ }
        }
        const data = { id: job.id, type: job.type, status: job.status,
          startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
          cancelRequested: job.cancelRequested === true,
          report: publicReport(report) };
        if (job.status === 'completed' && job.type === 'discover') {
          data.discovery = { plan: job.result.plan, plans: job.result.plans, report: job.result.report };
        }
        if (job.status === 'completed' && job.type === 'goal') {
          data.goal = { plan: job.result.plan, evidence: job.result.evidence, report: job.result.report };
        }
        if (job.status === 'completed' && job.type === 'hostinger') {
          data.hostinger = { plan: job.result.plan, evidence: job.result.evidence, report: job.result.report };
        }
        if (job.status === 'completed' && job.type === 'render') {
          data.videoUrl = '/api/jobs/' + job.id + '/video';
          if (job.result?.video?.narration) {
            data.subtitleUrls = {
              srt: '/api/jobs/' + job.id + '/subtitles.srt',
              vtt: '/api/jobs/' + job.id + '/subtitles.vtt',
            };
          }
        }
        return json(res, 200, data);
      }

      const videoPath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/video$/i);
      if (req.method === 'GET' && videoPath) {
        const job = findJob(videoPath[1], principal);
        if (!job || job.status !== 'completed' || job.type !== 'render') {
          return json(res, 404, { error: 'Video is not ready' });
        }
        let opened;
        try { opened = await openJobArtifact(outputRoot, job.id, 'tutorial.mp4', 1024 * 1024 * 1024); }
        catch { return json(res, 404, { error: 'MP4 missing or unsafe' }); }
        return streamJobArtifact(res, opened, { 'Content-Type': 'video/mp4', 'Content-Length': opened.info.size,
          'Content-Disposition': 'attachment; filename="tutorial.mp4"', 'Cache-Control': 'no-store' });
      }

      const subtitlesPath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/subtitles\.(srt|vtt)$/i);
      if (req.method === 'GET' && subtitlesPath) {
        const job = findJob(subtitlesPath[1], principal);
        if (!job || job.type !== 'render' || job.status !== 'completed' ||
            !job.result?.video?.narration) {
          return json(res, 404, { error: 'Narrated subtitles unavailable' });
        }
        const ext = subtitlesPath[2].toLowerCase();
        let opened;
        try { opened = await openJobArtifact(outputRoot, job.id, 'tutorial.' + ext, 1024 * 1024); }
        catch { return json(res, 404, { error: 'Subtitle file missing or unsafe' }); }
        return streamJobArtifact(res, opened, {
          'Content-Type': ext === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
          'Content-Length': opened.info.size,
          'Content-Disposition': 'attachment; filename="tutorial.' + ext + '"',
          'Cache-Control': 'no-store',
        });
      }

      const imagePath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/screenshot\/([1-5])$/i);
      if (req.method === 'GET' && imagePath) {
        const job = findJob(imagePath[1], principal);
        const index = Number(imagePath[2]);
        if (!job || job.type !== 'discover' || job.status !== 'completed' ||
            !job.result.report.pages[index - 1]?.screenshot) {
          return json(res, 404, { error: 'Screenshot not found' });
        }
        let opened;
        try { opened = await openJobArtifact(outputRoot, job.id, 'discovery-page-' + index + '.png', 32 * 1024 * 1024); }
        catch { return json(res, 404, { error: 'Screenshot missing or unsafe' }); }
        return streamJobArtifact(res, opened, { 'Content-Type': 'image/png',
          'Content-Length': opened.info.size, 'Cache-Control': 'no-store' });
      }

      const pricingImage = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/hostinger-screenshot$/i);
      if (req.method === 'GET' && pricingImage) {
        const job = findJob(pricingImage[1], principal);
        if (!job || job.type !== 'hostinger' || job.status !== 'completed' || !job.result.report.screenshot) {
          return json(res, 404, { error: 'Hostinger pricing screenshot not found' });
        }
        let opened;
        try { opened = await openJobArtifact(outputRoot, job.id, 'hostinger-pricing.png', 32 * 1024 * 1024); }
        catch { return json(res, 404, { error: 'Pricing screenshot missing or unsafe' }); }
        return streamJobArtifact(res, opened, { 'Content-Type': 'image/png',
          'Content-Length': opened.info.size, 'Cache-Control': 'no-store' });
      }

      const goalScreenshot = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/goal-screenshot$/i);
      if (req.method === 'GET' && goalScreenshot) {
        const job = findJob(goalScreenshot[1], principal);
        if (!job || job.type !== 'goal' || job.status !== 'completed') {
          return json(res, 404, { error: 'Goal screenshot not found' });
        }
        let opened;
        try { opened = await openJobArtifact(outputRoot, job.id, 'discovery-page-1.png', 32 * 1024 * 1024); }
        catch { return json(res, 404, { error: 'Goal screenshot missing or unsafe' }); }
        return streamJobArtifact(res, opened, { 'Content-Type': 'image/png',
          'Content-Length': opened.info.size, 'Cache-Control': 'no-store' });
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'Unknown route' });
      // Cancel and retry are control operations: the job ID is in the path and
      // there is no required JSON payload. Keep accepting the legacy {} body
      // sent by Studio, but also support a plain POST with no Content-Type.
      const jobControl = /^\/api\/jobs\/[a-f0-9-]{36}\/(?:cancel|retry)$/i.test(pathname);
      const body = jobControl && !req.headers['content-type'] ? {} : await bodyJson(req);
      const requestKey = idempotencyKey(req);

      const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/i);
      if (cancelMatch) {
        const job = findJob(cancelMatch[1], principal);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        if (job.status === 'queued') {
          job.abortController?.abort();
          job.status = 'cancelled';
          job.error = 'Cancelled before execution';
          job.finishedAt = new Date().toISOString();
          store.save(job);
          audit(principal, 'job.cancelled', job.id, 'success', { jobType: job.type, phase: 'queued' });
          pruneHistory();
          return json(res, 200, { id: job.id, status: job.status });
        }
        if (job.status === 'running' && ['render', 'preview', 'discover', 'goal', 'hostinger'].includes(job.type)) {
          job.cancelRequested = true;
          job.abortController?.abort();
          store.save(job);
          audit(principal, 'job.cancel_requested', job.id, 'success', { jobType: job.type });
          return json(res, 202, { id: job.id, status: 'cancelling' });
        }
        return json(res, 409, { error: 'This job type cannot yet be cooperatively cancelled while running' });
      }

      const retryMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/retry$/i);
      if (retryMatch) {
        const source = findJob(retryMatch[1], principal);
        if (!source) return json(res, 404, { error: 'Unknown job' });
        if (!isSafeRetryable(source)) {
          return json(res, 409, { error: 'Retry allowed only for failed/cancelled/interrupted read-only jobs; not paid AI or browser actions' });
        }
        const request = source.request;
        const job = start(source.type, (current, signal) => {
          if (source.type === 'discover') return exploreImpl(request.url, {
            outDir: current.outputDir, maxPages: request.maxPages, language: request.language, signal,
          });
          if (source.type === 'hostinger') return hostingerImpl(request.url, {
            outDir: current.outputDir, language: request.language, signal,
          });
          return goalImpl(request.url, {
            outDir: current.outputDir, goal: request.goal, ai: false, language: request.language, signal,
          });
        }, request, requestKey, principal, 'job.retry_submitted');
        return json(res, job._deduplicated ? 200 : 202, {
          jobId: job.id, status: job.status, retriedFrom: source.id,
          deduplicated: job._deduplicated === true,
        });
      }

      if (pathname === '/api/validate') {
        const checked = checkPlan(body.plan);
        const { plan: _plan, ...result } = checked;
        return json(res, checked.valid ? 200 : 422, result);
      }

      if (pathname === '/api/goal') {
        const url = HttpUrl.safeParse(body.url);
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        const language = body.language ?? 'vi';
        const ai = body.ai === true;
        if (cloudMode && ai) return json(res, 403, { error: 'Hosted AI is disabled in cloud mode until billing and cost controls are configured' });
        if (!url.success || goal.length < 4 || goal.length > 400 || !['vi', 'en'].includes(language)) {
          return json(res, 422, { error: 'Valid URL, specific goal (4–400 characters), and language vi/en required' });
        }
        if (cloudMode) {
          try { await cloudPreflight(url.data); }
          catch (error) { return json(res, 422, { error: error.message }); }
        }
        const job = start('goal', (current, signal) => goalImpl(url.data, {
          goal, ai, language, outDir: current.outputDir, signal,
        }), { url: url.data, goal, ai, language }, requestKey, principal);
        return json(res, job._deduplicated ? 200 : 202, {
          jobId: job.id, status: job.status, deduplicated: job._deduplicated === true,
        });
      }

      if (pathname === '/api/hostinger') {
        let url;
        try { url = validateHostingerUrl(body.url); }
        catch (error) { return json(res, 422, { error: error.message }); }
        const language = body.language ?? 'vi';
        if (!['vi', 'en'].includes(language)) return json(res, 422, { error: 'language must be vi or en' });
        if (cloudMode) {
          try { await cloudPreflight(url); }
          catch (error) { return json(res, 422, { error: error.message }); }
        }
        const job = start('hostinger', (current, signal) => hostingerImpl(url, {
          outDir: current.outputDir, language, signal,
        }), { url, language }, requestKey, principal);
        return json(res, job._deduplicated ? 200 : 202, {
          jobId: job.id, status: job.status, deduplicated: job._deduplicated === true,
        });
      }

      if (pathname === '/api/discover') {
        const url = HttpUrl.safeParse(body.url);
        const maxPages = body.maxPages ?? 1;
        const language = body.language ?? 'vi';
        if (!url.success || !['vi', 'en'].includes(language) ||
            !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) {
          return json(res, 422, { error: 'Valid HTTP(S) URL, language vi/en and maxPages 1–5 required' });
        }
        if (cloudMode) {
          try { await cloudPreflight(url.data); }
          catch (error) { return json(res, 422, { error: error.message }); }
        }
        const job = start('discover', (current, signal) => exploreImpl(url.data, {
          outDir: current.outputDir, maxPages, language, signal,
        }), { url: url.data, maxPages, language }, requestKey, principal);
        return json(res, job._deduplicated ? 200 : 202, {
          jobId: job.id, status: job.status, deduplicated: job._deduplicated === true,
        });
      }

      if (pathname === '/api/assemble') {
        const job = findJob(String(body.discoveryJobId || ''), principal);
        if (!job || job.type !== 'discover' || job.status !== 'completed') {
          return json(res, 409, { error: 'Complete a discovery job first' });
        }
        return json(res, 200, { plan: assembleImpl(job.result.report, job.result.plans) });
      }

      if (pathname === '/api/preview' || pathname === '/api/render') {
        if (cloudMode && pathname === '/api/preview') {
          return json(res, 403, { error: 'Interactive preview is disabled in cloud workers' });
        }
        const checked = checkPlan(body.plan);
        if (!checked.valid) return json(res, 422, { errors: checked.errors, error: 'Invalid plan' });
        if (!checked.ready) {
          return json(res, 409, { error: 'Action steps require review', reviewIssues: checked.reviewIssues });
        }
        if (cloudMode && checked.plan.steps.some(step =>
          !['highlight', 'branch', 'stop'].includes(step.action))) {
          return json(res, 403, { error: 'Cloud render permits read-only highlight/branch/stop steps only' });
        }
        if (cloudMode) {
          try { await cloudPreflight(checked.plan.url); }
          catch (error) { return json(res, 422, { error: error.message }); }
        }
        const actionable = checked.plan.steps.some(step => ['click', 'fill', 'navigate'].includes(step.action));
        if (actionable && body.confirmedExecution !== true) {
          return json(res, 409, { error: 'Explicit confirmation required to execute website actions' });
        }
        const preview = pathname === '/api/preview';
        const narrate = body.narrate === true && !preview;
        const renderer = narrate ? renderNarrated : renderImpl;
        const job = start(preview ? 'preview' : 'render', (current, signal) =>
          renderer(checked.plan, { outDir: current.outputDir, headed: preview, preview, signal }),
          { plan: checked.plan, narrate }, requestKey, principal);
        return json(res, job._deduplicated ? 200 : 202, {
          jobId: job.id, status: job.status, deduplicated: job._deduplicated === true,
        });
      }
      return json(res, 404, { error: 'Unknown route' });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || 'Server error' });
    }
  });
  server.once('close', () => {
    for (const job of jobs.values()) {
      if (job.status === 'queued') {
        job.abortController?.abort();
        job.status = 'cancelled';
        job.error = 'Studio stopped before the job started';
        job.finishedAt = new Date().toISOString();
        store.save(job);
      } else if (job.status === 'running') {
        job.cancelRequested = true;
        job.abortController?.abort();
        store.save(job);
      }
    }
    // Keep SQLite open until cooperative workers have unwound and persisted
    // their terminal state. A hard process kill is recovered as interrupted.
    queue.finally(() => store.close());
  });
  return { server, jobs, store };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--port');
  const port = index >= 0 ? Number(process.argv[index + 1]) : Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Invalid port');
    process.exitCode = 1;
  } else {
    const { server } = createStudioServer();
    server.listen(port, '127.0.0.1', () => {
      console.log('Studio ready: http://127.0.0.1:' + port);
      console.log('Local-only. Do not expose this service on a public interface.');
    });
  }
}
