import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { render } from '../src/render.mjs';
import { command } from '../src/render.mjs';
import { inspectVideo, compareCaptures } from '../src/benchmark.mjs';

const html = '<!doctype html><html><head><meta charset="utf-8"><title>Capture A/B Fixture</title>' +
  '<style>body{font:20px Arial;margin:48px;background:#f4f7fb;color:#13243a}' +
  'section{margin:30px 0;padding:24px;border:1px solid #ccd7e4;border-radius:12px;background:white}' +
  'h1{font-size:36px}h2{font-size:28px}</style></head><body>' +
  '<main><h1 id="intro">Product overview</h1><p>Same local fixture for Playwright and Webreel.</p>' +
  '<section id="features"><h2>Features</h2><p>Fast setup, clear steps, and a safe read-only demo.</p></section>' +
  '</main></body></html>';

const root = path.resolve('output/webreel-ab');
await mkdir(root, { recursive: true });
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = 'http://127.0.0.1:' + server.address().port;
  const plan = {
    schemaVersion: 1, title: 'A/B fixture', url, language: 'en',
    viewport: { width: 1280, height: 720 },
    steps: [
      { id: 'intro', title: 'Product overview', description: 'Overview section on the shared fixture.',
        target: { css: '#intro' }, action: 'highlight', holdMs: 1500 },
      { id: 'features', title: 'Features', description: 'Feature section on the shared fixture.',
        target: { css: '#features' }, action: 'highlight', holdMs: 1500 },
      { id: 'stop', title: 'Done', description: 'End of capture.',
        action: 'stop', holdMs: 500 },
    ],
  };
  const playwrightDir = path.join(root, 'playwright');
  const baseline = await render(plan, { outDir: playwrightDir });
  const webreelOutput = path.join(root, 'webreel.mp4');
  const configPath = path.join(root, 'webreel.config.json');
  const config = {
    videos: {
      sameFixture: {
        url, output: webreelOutput, viewport: { width: 1280, height: 720 },
        fps: 30, waitFor: '#intro', defaultDelay: 500,
        steps: [
          { action: 'pause', ms: 500 },
          { action: 'moveTo', selector: '#intro', delay: 1000 },
          { action: 'pause', ms: 1500 },
          { action: 'moveTo', selector: '#features', delay: 1000 },
          { action: 'pause', ms: 1500 },
        ],
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  // Keep Webreel optional: it is a separate renderer under test, not part of
  // the default tutorial pipeline or a runtime dependency. The pinned CLI
  // Use the same installed browser and system FFmpeg as the baseline. Webreel's
  // downloaded FFmpeg can fail before producing its raw MP4 (then the CLI only
  // reports ENOENT at rename). Do not implicitly download a second toolchain.
  process.env.CHROME_PATH ||= process.env.CHROMIUM_PATH || chromium.executablePath();
  process.env.FFMPEG_PATH ||= (await command('which', ['ffmpeg'])).trim();
  await writeFile(path.join(root, 'toolchain.json'), JSON.stringify({
    chrome: process.env.CHROME_PATH, ffmpeg: process.env.FFMPEG_PATH,
    ffmpegVersion: (await command(process.env.FFMPEG_PATH, ['-version'])).split('\n')[0],
  }, null, 2));
  const cliLog = await command('npx', ['--yes', 'webreel@0.1.4', 'record', '--config', configPath]);
  await writeFile(path.join(root, 'webreel.log'), cliLog);

  const a = await inspectVideo(baseline.video.path);
  const b = await inspectVideo(webreelOutput);
  const comparison = {
    fixture: url, generatedAt: new Date().toISOString(),
    playwright: a, webreel: b,
    comparison: compareCaptures(a, b),
    visualReviewRequired: true,
    notes: [
      'Both recordings used the same local HTML fixture and 1280x720 viewport.',
      'The Playwright capture includes Driver.js spotlight/popover; Webreel uses its own cursor/HUD.',
      'Frame interval statistics are file-level metrics, not a proof of browser animation smoothness.',
      'Webreel remains optional until MacBook Apple Silicon compatibility and visual review pass.',
    ],
  };
  await writeFile(path.join(root, 'capture-comparison.json'), JSON.stringify(comparison, null, 2));
  await readFile(webreelOutput);
  assert.equal(a.width, 1280);
  assert.equal(a.height, 720);
  assert.equal(b.width, 1280);
  assert.equal(b.height, 720);
  assert.ok(a.measuredFps > 0 && b.measuredFps > 0);
  console.log(JSON.stringify(comparison));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
