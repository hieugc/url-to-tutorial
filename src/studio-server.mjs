import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { explore } from './discover.mjs';
import { createHostingerGuide, validateHostingerUrl } from './adapters/hostinger.mjs';
import { assemblePages } from './assemble.mjs';
import { HttpUrl, Plan, validatePlanForExecution } from './plan.mjs';
import { render } from './render.mjs';

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
  hostingerImpl = createHostingerGuide,
  assembleImpl = assemblePages,
  renderImpl = render,
} = {}) {
  const jobs = new Map();
  let queue = Promise.resolve();

  function start(type, work) {
    const pending = [...jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length;
    if (pending >= MAX_PENDING) throw bad('Job queue is full (4 pending jobs)', 429);
    const id = randomUUID();
    const job = { id, type, status: 'queued', createdAt: new Date().toISOString(),
      outputDir: path.join(path.resolve(outputRoot), id), startedAt: null,
      finishedAt: null, result: null, error: null };
    jobs.set(id, job);
    for (const [key, old] of jobs) {
      if (jobs.size <= 40) break;
      if (['completed', 'failed'].includes(old.status)) jobs.delete(key);
    }
    queue = queue.catch(() => {}).then(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      try {
        await mkdir(job.outputDir, { recursive: true });
        job.result = await work(job);
        job.status = 'completed';
      } catch (error) {
        job.error = error.message || 'Job failed';
        job.status = 'failed';
      } finally {
        job.finishedAt = new Date().toISOString();
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
        return json(res, 200, { status: 'ok', scope: 'local-only' });
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
          report: publicReport(report) };
        if (job.status === 'completed' && job.type === 'discover') {
          data.discovery = { plan: job.result.plan, plans: job.result.plans, report: job.result.report };
        }
        if (job.status === 'completed' && job.type === 'hostinger') {
          data.hostinger = { plan: job.result.plan, evidence: job.result.evidence, report: job.result.report };
        }
        if (job.status === 'completed' && job.type === 'render') data.videoUrl = '/api/jobs/' + job.id + '/video';
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

      if (req.method !== 'POST') return json(res, 404, { error: 'Unknown route' });
      const body = await bodyJson(req);

      if (pathname === '/api/validate') {
        const checked = checkPlan(body.plan);
        const { plan: _plan, ...result } = checked;
        return json(res, checked.valid ? 200 : 422, result);
      }

      if (pathname === '/api/hostinger') {
        let url;
        try { url = validateHostingerUrl(body.url); }
        catch (error) { return json(res, 422, { error: error.message }); }
        const language = body.language ?? 'vi';
        if (!['vi', 'en'].includes(language)) return json(res, 422, { error: 'language must be vi or en' });
        const job = start('hostinger', current => hostingerImpl(url, {
          outDir: current.outputDir, language,
        }));
        return json(res, 202, { jobId: job.id, status: job.status });
      }

      if (pathname === '/api/discover') {
        const url = HttpUrl.safeParse(body.url);
        const maxPages = body.maxPages ?? 1;
        const language = body.language ?? 'vi';
        if (!url.success || !['vi', 'en'].includes(language) ||
            !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) {
          return json(res, 422, { error: 'Valid HTTP(S) URL, language vi/en and maxPages 1–5 required' });
        }
        const job = start('discover', current => exploreImpl(url.data, {
          outDir: current.outputDir, maxPages, language,
        }));
        return json(res, 202, { jobId: job.id, status: job.status });
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
        const job = start(preview ? 'preview' : 'render', current =>
          renderImpl(checked.plan, { outDir: current.outputDir, headed: preview, preview }));
        return json(res, 202, { jobId: job.id, status: job.status });
      }
      return json(res, 404, { error: 'Unknown route' });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || 'Server error' });
    }
  });
  return { server, jobs };
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
