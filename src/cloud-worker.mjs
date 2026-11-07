import { explore } from './discover.mjs';
import { createGoalGuide } from './goal-planner.mjs';
import { createHostingerGuide } from './adapters/hostinger.mjs';
import { render } from './render.mjs';
import { renderNarrated } from './narration.mjs';
import { HttpUrl, Plan, validatePlanForExecution } from './plan.mjs';
import { publicUrlPreflight } from './cloud-egress.mjs';
import { pathToFileURL } from 'node:url';

const JOB_ID = /^[a-f0-9-]{36}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const JOB_TYPES = new Set(['discover', 'goal', 'hostinger', 'render']);
const MAX_INPUT_BYTES = 512 * 1024;
const OUTPUT_DIR = '/job';

function abortError(message = 'Cloud worker cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function assertCloudSafePlan(input) {
  const plan = Plan.parse(input);
  const reviewIssues = validatePlanForExecution(plan);
  if (reviewIssues.length) {
    throw new Error('Plan requires review before cloud execution: ' + reviewIssues.join('; '));
  }
  const unsafe = plan.steps.filter(step => !['highlight', 'branch', 'stop'].includes(step.action));
  if (unsafe.length) {
    throw new Error('Cloud worker currently permits read-only highlight/branch/stop steps only');
  }
  return plan;
}

async function assertPublicTarget(url, preflight = publicUrlPreflight) {
  HttpUrl.parse(url);
  return preflight(url);
}

export async function runCloudWorkerJob(payload, {
  signal,
  exploreImpl = explore,
  goalImpl = createGoalGuide,
  hostingerImpl = createHostingerGuide,
  renderImpl = render,
  narrateImpl = renderNarrated,
  preflight = publicUrlPreflight,
} = {}) {
  if (!payload || typeof payload !== 'object' || !JOB_ID.test(payload.jobId || '') ||
      !ID.test(payload.tenantId || '') || !ID.test(payload.projectId || '') ||
      !JOB_TYPES.has(payload.type) || !payload.request || typeof payload.request !== 'object') {
    throw new Error('Invalid cloud worker job envelope');
  }
  if (!process.env.TUTORIAL_EGRESS_PROXY ||
      process.env.TUTORIAL_EGRESS_PROXY !== 'http://egress-proxy:3128') {
    throw new Error('Cloud worker must use the dedicated egress proxy');
  }
  const request = payload.request;
  if (signal?.aborted) throw abortError();

  if (payload.type === 'discover') {
    const url = await assertPublicTarget(request.url, preflight);
    return exploreImpl(url, {
      outDir: OUTPUT_DIR, maxPages: request.maxPages, language: request.language, signal,
    });
  }
  if (payload.type === 'goal') {
    if (request.ai === true) throw new Error('Hosted AI is disabled in cloud workers');
    const url = await assertPublicTarget(request.url);
    return goalImpl(url, {
      goal: request.goal, ai: false, outDir: OUTPUT_DIR, language: request.language, signal,
    });
  }
  if (payload.type === 'hostinger') {
    const url = await assertPublicTarget(request.url);
    return hostingerImpl(url, { outDir: OUTPUT_DIR, language: request.language, signal });
  }

  const plan = assertCloudSafePlan(request.plan);
  await assertPublicTarget(plan.url, preflight);
  if (request.narrate === true) {
    return narrateImpl(plan, { outDir: OUTPUT_DIR, headed: false, preview: false, signal });
  }
  return renderImpl(plan, { outDir: OUTPUT_DIR, headed: false, preview: false, signal });
}

async function readInput(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Cloud worker input exceeds 512 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const timeoutMs = Number(process.env.TUTORIAL_WORKER_TIMEOUT_MS || 600000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
    throw new Error('TUTORIAL_WORKER_TIMEOUT_MS must be between 1000 and 900000');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const payload = await readInput(process.stdin);
    const result = await runCloudWorkerJob(payload, { signal: controller.signal });
    if (controller.signal.aborted) throw abortError();
    process.stdout.write(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write((error?.name === 'AbortError' ? 'Cloud worker cancelled' : error?.message || 'Cloud worker failed') + '\n');
    process.exitCode = 1;
  });
}

export { assertCloudSafePlan };
