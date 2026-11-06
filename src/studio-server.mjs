import { createServer } from 'node:http';
import { createReadStream, rmSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
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

function publicReport(report) {
  if (!report) return null;
  const copy = structuredClone(report);
  if (copy.video) delete copy.video.path;
  return copy;
}

/**
 * Studio is deliberately local-only and single-worker. URLs are trusted inputs
 * controlled by the operator; do not expose this process to an untrusted network.
 * Production egress isolation, durable jobs and login are separate tasks.
 */
export function createStudioServer({
  outputRoot = path.resolve('output/studio'),
  exploreImpl = explore,
  goalImpl = createGoalGuide,
  hostingerImpl = createHostingerGuide,
  assembleImpl = assemblePages,
  renderImpl = render,
} = {}) {
  const store = new StudioJobStore(outputRoot);
  const jobs = new Map(store.recover().map(job => [job.id, job]));
  // Bounded retention; path is derived from server-issued UUID only.
  for (const expired of store.expired()) {
    if (/^[a-f0-9-]{36}$/i.test(expired.id)) {
      rmSync(path.join(path.resolve(outputRoot), expired.id), { recursive: true, force: true });
      jobs.delete(expired.id);
      store.delete(expired.id);
    }
  }
  let queue = Promise.resolve();

  function start(type, work, requestSnapshot = null, key = null) {
    const requestHash = createHash('sha256')
      .update(type + '\n' + stableJson(requestSnapshot))
      .digest('hex');
    if (key) {
      const existing = [...jobs.values()].find(job => job.idempotencyKey === key);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw bad('Idempotency-Key was already used with a different request', 409);
        }
        existing._deduplicated = true;
        return existing;
      }
    }
    const pending = [...jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length;
    if (pending >= MAX_PENDING) throw bad('Job queue is full (4 pending jobs)', 429);
    const id = randomUUID();
    // Persist plans for diagnostics, but never persist plaintext fill values.
    const request = requestSnapshot ? structuredClone(requestSnapshot) : null;
    if (request?.plan?.steps) {
      for (const step of request.plan.steps) if (step.action === 'fill') step.value = '[redacted]';
    }
    const job = { id, type, status: 'queued', createdAt: new Date().toISOString(),
      outputDir: path.join(path.resolve(outputRoot), id), startedAt: null,
      finishedAt: null, result: null, error: null, request,
      idempotencyKey: key, requestHash, cancelRequested: false,
      abortController: new AbortController() };
    store.save(job);
    jobs.set(id, job);
    for (const [key, old] of jobs) {
      if (jobs.size <= 40) break;
      if (['completed', 'failed'].includes(old.status)) jobs.delete(key);
    }
    queue = queue.catch(() => {}).then(async () => {
      if (job.status === 'cancelled') return;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      store.save(job);
      try {
        await mkdir(job.outputDir, { recursive: true });
        job.result = await work(job, job.abortController.signal);
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
        store.trim();
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
    if (!localRequest(req)) return json(res, 403, { error: 'Local loopback requests only' });
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    try {
      if (req.method === 'GET' && assets.has(pathname)) {
        const [filename, type] = assets.get(pathname);
        const data = await readFile(path.join(publicDir, filename));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
        return res.end(data);
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { status: 'ok', scope: 'local-only', persistence: 'sqlite' });
      }
      if (req.method === 'GET' && pathname === '/api/jobs') {
        return json(res, 200, {
          jobs: [...jobs.values()].slice(-40).reverse().map(job => ({
            id: job.id, type: job.type, status: job.status, createdAt: job.createdAt,
            finishedAt: job.finishedAt, error: job.error, cancelRequested: job.cancelRequested === true,
          })),
        });
      }

      const jobPath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})$/i);
      if (req.method === 'GET' && jobPath) {
        const job = jobs.get(jobPath[1]);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        let report = job.result?.report || job.result;
        if (!report && job.status === 'running' && job.type !== 'discover') {
          try { report = JSON.parse(await readFile(path.join(job.outputDir, 'report.json'), 'utf8')); }
          catch { /* not yet written */ }
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
        const job = jobs.get(videoPath[1]);
        if (!job || job.status !== 'completed' || job.type !== 'render') {
          return json(res, 404, { error: 'Video is not ready' });
        }
        const file = path.join(job.outputDir, 'tutorial.mp4');
        let info;
        try { info = await stat(file); }
        catch { return json(res, 404, { error: 'MP4 missing' }); }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': info.size,
          'Content-Disposition': 'attachment; filename="tutorial.mp4"', 'Cache-Control': 'no-store' });
        return createReadStream(file).pipe(res);
      }

      const subtitlesPath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/subtitles\.(srt|vtt)$/i);
      if (req.method === 'GET' && subtitlesPath) {
        const job = jobs.get(subtitlesPath[1]);
        if (!job || job.type !== 'render' || job.status !== 'completed' ||
            !job.result?.video?.narration) {
          return json(res, 404, { error: 'Narrated subtitles unavailable' });
        }
        const ext = subtitlesPath[2].toLowerCase();
        const file = path.join(job.outputDir, 'tutorial.' + ext);
        let info;
        try { info = await stat(file); }
        catch { return json(res, 404, { error: 'Subtitle file missing' }); }
        res.writeHead(200, {
          'Content-Type': ext === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
          'Content-Length': info.size,
          'Content-Disposition': 'attachment; filename="tutorial.' + ext + '"',
          'Cache-Control': 'no-store',
        });
        return createReadStream(file).pipe(res);
      }

      const imagePath = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/screenshot\/([1-5])$/i);
      if (req.method === 'GET' && imagePath) {
        const job = jobs.get(imagePath[1]);
        const index = Number(imagePath[2]);
        if (!job || job.type !== 'discover' || job.status !== 'completed' ||
            !job.result.report.pages[index - 1]?.screenshot) {
          return json(res, 404, { error: 'Screenshot not found' });
        }
        const file = path.join(job.outputDir, 'discovery-page-' + index + '.png');
        let info;
        try { info = await stat(file); }
        catch { return json(res, 404, { error: 'Screenshot missing' }); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
        return createReadStream(file).pipe(res);
      }

      const pricingImage = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/hostinger-screenshot$/i);
      if (req.method === 'GET' && pricingImage) {
        const job = jobs.get(pricingImage[1]);
        if (!job || job.type !== 'hostinger' || job.status !== 'completed' || !job.result.report.screenshot) {
          return json(res, 404, { error: 'Hostinger pricing screenshot not found' });
        }
        const file = path.join(job.outputDir, 'hostinger-pricing.png');
        let info;
        try { info = await stat(file); }
        catch { return json(res, 404, { error: 'Pricing screenshot missing' }); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
        return createReadStream(file).pipe(res);
      }

      const goalScreenshot = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/goal-screenshot$/i);
      if (req.method === 'GET' && goalScreenshot) {
        const job = jobs.get(goalScreenshot[1]);
        if (!job || job.type !== 'goal' || job.status !== 'completed') {
          return json(res, 404, { error: 'Goal screenshot not found' });
        }
        const file = path.join(job.outputDir, 'discovery-page-1.png');
        let info;
        try { info = await stat(file); }
        catch { return json(res, 404, { error: 'Goal screenshot missing' }); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
        return createReadStream(file).pipe(res);
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'Unknown route' });
      const body = await bodyJson(req);
      const requestKey = idempotencyKey(req);

      const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/i);
      if (cancelMatch) {
        const job = jobs.get(cancelMatch[1]);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        if (job.status === 'queued') {
          job.abortController?.abort();
          job.status = 'cancelled';
          job.error = 'Cancelled before execution';
          job.finishedAt = new Date().toISOString();
          store.save(job);
          return json(res, 200, { id: job.id, status: job.status });
        }
        if (job.status === 'running' && ['render', 'preview', 'discover', 'goal', 'hostinger'].includes(job.type)) {
          job.cancelRequested = true;
          job.abortController?.abort();
          store.save(job);
          return json(res, 202, { id: job.id, status: 'cancelling' });
        }
        return json(res, 409, { error: 'This job type cannot yet be cooperatively cancelled while running' });
      }

      const retryMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/retry$/i);
      if (retryMatch) {
        const source = jobs.get(retryMatch[1]);
        if (!source) return json(res, 404, { error: 'Unknown job' });
        if (!['failed', 'cancelled', 'interrupted'].includes(source.status)) {
          return json(res, 409, { error: 'Only interrupted or failed read-only jobs can be retried' });
        }
        const request = source.request;
        if (!request || !['discover', 'hostinger', 'goal'].includes(source.type) ||
            (source.type === 'goal' && request.ai)) {
          return json(res, 409, { error: 'Retry is disabled for browser actions, paid AI calls and unknown job inputs' });
        }
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
        }, request, requestKey);
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
        if (!url.success || goal.length < 4 || goal.length > 400 || !['vi', 'en'].includes(language)) {
          return json(res, 422, { error: 'Valid URL, specific goal (4–400 characters), and language vi/en required' });
        }
        const job = start('goal', (current, signal) => goalImpl(url.data, {
          goal, ai, language, outDir: current.outputDir, signal,
        }), { url: url.data, goal, ai, language }, requestKey);
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
        const job = start('hostinger', (current, signal) => hostingerImpl(url, {
          outDir: current.outputDir, language, signal,
        }), { url, language }, requestKey);
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
        const job = start('discover', (current, signal) => exploreImpl(url.data, {
          outDir: current.outputDir, maxPages, language, signal,
        }), { url: url.data, maxPages, language }, requestKey);
        return json(res, job._deduplicated ? 200 : 202, {
          jobId: job.id, status: job.status, deduplicated: job._deduplicated === true,
        });
      }

      if (pathname === '/api/assemble') {
        const job = jobs.get(String(body.discoveryJobId || ''));
        if (!job || job.type !== 'discover' || job.status !== 'completed') {
          return json(res, 409, { error: 'Complete a discovery job first' });
        }
        return json(res, 200, { plan: assembleImpl(job.result.report, job.result.plans) });
      }

      if (pathname === '/api/preview' || pathname === '/api/render') {
        const checked = checkPlan(body.plan);
        if (!checked.valid) return json(res, 422, { errors: checked.errors, error: 'Invalid plan' });
        if (!checked.ready) {
          return json(res, 409, { error: 'Action steps require review', reviewIssues: checked.reviewIssues });
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
          { plan: checked.plan, narrate }, requestKey);
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
