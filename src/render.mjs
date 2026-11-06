import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launch, ready } from './browser.mjs';
import { Plan, uniqueTarget, evaluateCondition, validatePlanForExecution } from './plan.mjs';
import { showStep, hideStep } from './overlay.mjs';
import { installPrivacy, assertSafeCapture } from './privacy.mjs';

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Operation cancelled by operator');
    error.name = 'AbortError';
    throw error;
  }
}

export function command(program, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Operation cancelled by operator');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', killTimer;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    };
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) {
        const error = new Error('Operation cancelled by operator');
        error.name = 'AbortError';
        reject(error);
      } else if (code === 0) resolve(stdout);
      else reject(new Error(program + ' exited ' + code + ': ' + stderr + '\n' + stdout.slice(-12000)));
    });
  });
}

export async function render(input, {
  outDir, headed = false, preview = false, signal,
  manualLogin = false, loginPrompt,
} = {}) {
  const plan = Plan.parse(input);
  const reviewIssues = validatePlanForExecution(plan);
  if (reviewIssues.length) throw new Error('Plan is structurally valid but needs review before execution:\n- ' + reviewIssues.join('\n- '));
  if (!outDir) throw new Error('outDir is required');
  if (manualLogin && !headed) throw new Error('Manual login requires --headed so the user can complete authentication visibly');
  if (manualLogin && typeof loginPrompt !== 'function') throw new Error('Manual login requires an interactive confirmation callback');
  throwIfAborted(signal);
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  try {
    await access(path.join(root, 'tutorial.mp4'));
    throw new Error('Output already contains tutorial.mp4; choose a new --out directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!preview) await command('ffmpeg', ['-version'], { signal });
  const report = {
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: [],
    preview,
    workflow: { stepCount: plan.steps.length, branching: plan.steps.some(step => step.action === 'branch'), manualLogin },
  };
  const saveReport = () => writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await saveReport();
  let browser, context, loginContext, video;
  const abortHandler = () => {
    context?.close().catch(() => {});
    loginContext?.close().catch(() => {});
    browser?.close().catch(() => {});
  };
  signal?.addEventListener('abort', abortHandler, { once: true });
  try {
    throwIfAborted(signal);
    browser = await launch(headed || preview || manualLogin);
    throwIfAborted(signal);
    let storageState;
    if (manualLogin) {
      // The user authenticates in a visible, non-recording context. Storage
      // state is transferred in memory only to the isolated recording context.
      loginContext = await browser.newContext({ viewport: plan.viewport,
        locale: plan.language === 'vi' ? 'vi-VN' : 'en-US' });
      await installPrivacy(loginContext, plan.redactSelectors || []);
      const loginPage = await loginContext.newPage();
      await loginPage.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await ready(loginPage);
      await loginPrompt(loginPage);
      throwIfAborted(signal);
      storageState = await loginContext.storageState();
      await loginContext.close();
      loginContext = undefined;
    }
    context = await browser.newContext({
      viewport: plan.viewport,
      locale: plan.language === 'vi' ? 'vi-VN' : 'en-US',
      ...(storageState ? { storageState } : {}),
      ...(!preview ? { recordVideo: { dir: path.join(root, 'raw'), size: plan.viewport } } : {}),
    });
    // A fresh incognito browser context is created for every render job.
    // Privacy scripts execute before DOM paint, not merely before screenshots.
    await installPrivacy(context, plan.redactSelectors || []);
    throwIfAborted(signal);
    const page = await context.newPage();
    video = page.video();
    report.recordingStartedAt = new Date().toISOString();
    await saveReport();
    // Extra tabs are unsupported; don't silently produce an incorrect walkthrough.
    let popup = false;
    context.on('page', newPage => {
      if (newPage !== page) {
        popup = true;
        newPage.close().catch(() => {});
      }
    });
    await page.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ready(page);
    throwIfAborted(signal);
    await assertSafeCapture(page);

    const indexById = new Map(plan.steps.map((step, index) => [step.id, index]));
    let currentIndex = 0;
    let executionCount = 0;
    while (currentIndex < plan.steps.length) {
      throwIfAborted(signal);
      if (++executionCount > plan.steps.length) throw new Error('Workflow exceeded its forward-only execution limit');
      const step = plan.steps[currentIndex];
      const entry = {
        id: step.id,
        action: step.action,
        status: 'running',
        startedAt: new Date().toISOString(),
        planIndex: currentIndex,
      };
      report.steps.push(entry);
      await saveReport();

      await assertSafeCapture(page);
      const locator = step.target ? await uniqueTarget(page, step.target) : undefined;
      await showStep(page, locator, step, currentIndex, plan.steps.length, async () => {
        entry.narrationStartAt = new Date().toISOString();
        await saveReport();
      });
      await page.screenshot({ path: path.join(root, 'step-' + report.steps.length + '.png') });
      await hideStep(page);

      if (step.action === 'click') await locator.click({ timeout: 10000 });
      if (step.action === 'fill') await locator.fill(step.value, { timeout: 10000 });
      if (step.action === 'navigate') {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        entry.navigatedTo = page.url();
      }
      await ready(page);
      await assertSafeCapture(page);
      if (popup) throw new Error('New-tab navigation is not supported by this MVP');
      if (step.expected) await uniqueTarget(page, step.expected);

      let nextIndex = step.next ? indexById.get(step.next) : currentIndex + 1;
      if (step.action === 'branch') {
        const matched = await evaluateCondition(page, step.condition);
        const nextStepId = matched ? step.onTrue : step.onFalse;
        entry.branchDecision = {
          condition: step.condition,
          matched,
          nextStepId,
        };
        nextIndex = indexById.get(nextStepId);
      }

      entry.status = 'completed';
      entry.finishedAt = new Date().toISOString();
      await saveReport();
      if (step.action === 'stop') break;
      currentIndex = nextIndex;
    }

    await context.close();
    context = undefined;
    await browser.close();
    browser = undefined;
    if (!preview) {
      throwIfAborted(signal);
      const raw = await video.path();
      const output = path.join(root, 'tutorial.mp4');
      await command('ffmpeg', ['-y', '-i', raw, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { signal });
      const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { signal }));
      const stream = probe.streams.find(s => s.codec_type === 'video');
      if (!stream || stream.codec_name !== 'h264' || stream.width !== plan.viewport.width || stream.height !== plan.viewport.height || Number(probe.format.duration) <= 0)
        throw new Error('Encoded video failed verification');
      report.video = {
        path: output,
        width: stream.width,
        height: stream.height,
        duration: Number(probe.format.duration),
        codec: stream.codec_name,
        audio: false,
      };
    }
    report.status = 'completed';
    report.executedStepCount = report.steps.length;
    return report;
  } catch (error) {
    const cancelled = signal?.aborted || error.name === 'AbortError';
    report.status = cancelled ? 'cancelled' : 'failed';
    report.error = cancelled ? 'Cancelled by operator' : error.message;
    const last = report.steps.at(-1);
    if (last && last.status === 'running') last.status = cancelled ? 'cancelled' : 'failed';
    if (cancelled) {
      const aborted = new Error('Operation cancelled by operator');
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    await loginContext?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    await saveReport();
  }
}
