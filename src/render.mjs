import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launch, ready } from './browser.mjs';
import { Plan, uniqueTarget, evaluateCondition, validatePlanForExecution } from './plan.mjs';
import { showStep, hideStep } from './overlay.mjs';

export function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(program + ' exited ' + code + ': ' + stderr)));
  });
}

export async function render(input, { outDir, headed = false, preview = false } = {}) {
  const plan = Plan.parse(input);
  const reviewIssues = validatePlanForExecution(plan);
  if (reviewIssues.length) throw new Error('Plan is structurally valid but needs review before execution:\n- ' + reviewIssues.join('\n- '));
  if (!outDir) throw new Error('outDir is required');
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  try {
    await access(path.join(root, 'tutorial.mp4'));
    throw new Error('Output already contains tutorial.mp4; choose a new --out directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!preview) await command('ffmpeg', ['-version']);
  const report = {
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: [],
    preview,
    workflow: { stepCount: plan.steps.length, branching: plan.steps.some(step => step.action === 'branch') },
  };
  const saveReport = () => writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await saveReport();
  let browser, context, video;
  try {
    browser = await launch(headed || preview);
    context = await browser.newContext({
      viewport: plan.viewport,
      locale: plan.language === 'vi' ? 'vi-VN' : 'en-US',
      ...(!preview ? { recordVideo: { dir: path.join(root, 'raw'), size: plan.viewport } } : {}),
    });
    const page = await context.newPage();
    video = page.video();
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

    const indexById = new Map(plan.steps.map((step, index) => [step.id, index]));
    let currentIndex = 0;
    let executionCount = 0;
    while (currentIndex < plan.steps.length) {
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

      const locator = step.target ? await uniqueTarget(page, step.target) : undefined;
      await showStep(page, locator, step, currentIndex, plan.steps.length);
      await page.screenshot({ path: path.join(root, 'step-' + report.steps.length + '.png') });
      await hideStep(page);

      if (step.action === 'click') await locator.click({ timeout: 10000 });
      if (step.action === 'fill') await locator.fill(step.value, { timeout: 10000 });
      if (step.action === 'navigate') {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        entry.navigatedTo = page.url();
      }
      await ready(page);
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
      const raw = await video.path();
      const output = path.join(root, 'tutorial.mp4');
      await command('ffmpeg', ['-y', '-i', raw, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
      const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
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
    report.status = 'failed';
    report.error = error.message;
    const last = report.steps.at(-1);
    if (last && last.status === 'running') last.status = 'failed';
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    await saveReport();
  }
}
