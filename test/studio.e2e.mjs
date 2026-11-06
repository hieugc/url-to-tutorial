import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudioServer } from '../src/studio-server.mjs';

const root = path.resolve('output/e2e-studio');
const starterPlan = {
  schemaVersion: 1, title: 'Studio test', language: 'vi', mode: 'overview',
  url: 'https://example.com', viewport: { width: 1280, height: 720 },
  steps: [
    { id: 'intro', title: 'Intro', description: 'Original description',
      target: { css: 'h1' }, action: 'highlight', holdMs: 1000 },
    { id: 'finish', title: 'Finish', description: 'Stop here', action: 'stop', holdMs: 1000 },
  ],
};
const { server } = createStudioServer({
  outputRoot: root,
  exploreImpl: async (_url, { outDir }) => {
    await writeFile(path.join(outDir, 'discovery-page-1.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6sAAAAABJRU5ErkJggg==', 'base64'));
    return {
      plan: starterPlan,
      plans: [starterPlan],
      report: {
        status: 'completed', entryUrl: starterPlan.url,
        pages: [{ finalUrl: starterPlan.url, title: 'Studio test', candidateCount: 1,
          screenshot: 'discovery-page-1.png' }],
      },
    };
  },
  hostingerImpl: async (_url, { outDir }) => {
    await writeFile(path.join(outDir, 'hostinger-pricing.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6sAAAAABJRU5ErkJggg==', 'base64'));
    return {
      plan: {
        ...starterPlan,
        title: 'Hostinger pricing guide',
        url: 'https://www.hostinger.com/vn#pricing',
        steps: [
          { id: 'premium', title: 'Tìm hiểu gói Premium', description: 'Giá từ DOM, không click',
            action: 'highlight', target: { css: 'body' }, holdMs: 1000 },
          { id: 'safe-stop', title: 'Dừng trước thanh toán', description: 'Không mua hàng',
            action: 'stop', holdMs: 1000 },
        ],
      },
      evidence: { cards: [{ name: 'Premium', monthly: '41.900 đ/th' }] },
      report: { status: 'completed', screenshot: 'hostinger-pricing.png', warnings: [] },
    };
  },
  renderImpl: async (_plan, { outDir, preview }) => {
    if (!preview) await writeFile(path.join(outDir, 'tutorial.mp4'), Buffer.from('test fixture video'));
    return { status: 'completed', steps: [{ id: 'intro', status: 'completed' }],
      ...(!preview ? { video: { path: path.join(outDir, 'tutorial.mp4'),
        width: 1280, height: 720, codec: 'h264', duration: 2 } } : {}) };
  },
});
await mkdir(root, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1450, height: 950 }, acceptDownloads: true });
  const uncaught = [];
  page.on('pageerror', error => uncaught.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Website URL').fill('https://example.com');
  await page.getByRole('button', { name: /Explore website/ }).click();
  await page.getByText('Intro', { exact: true }).waitFor();
  await page.locator('#step-title').fill('Getting started');
  await page.locator('#step-description').fill('Edited in the Studio UI');
  await page.getByRole('button', { name: 'Save step' }).click();

  // Invalid structure must show concrete errors in the Readiness panel.
  await page.locator('#target-type').selectOption('none');
  await page.getByRole('button', { name: 'Save step' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await page.getByText(/Invalid plan/).waitFor();
  assert.ok(await page.locator('#issues li').count() > 0);

  // Set a reviewed action and verify the explicit execution confirmation.
  await page.locator('#target-type').selectOption('css');
  await page.locator('#target-css').fill('h1');
  await page.locator('#step-action').selectOption('navigate');
  await page.locator('#navigate-url').fill('https://example.com/demo');
  await page.locator('#reviewed').check();
  await page.getByRole('button', { name: 'Save step' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await page.getByText('Ready to preview / render').waitFor();
  await page.screenshot({ path: path.join(root, 'studio-editor.png'), fullPage: true });

  page.on('dialog', dialog => dialog.accept());
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Render MP4/ }).click();
  const downloadButton = page.getByRole('link', { name: /Download MP4/ });
  await downloadButton.waitFor();
  await downloadButton.click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'tutorial.mp4');
  await page.getByLabel('Website URL').fill('https://www.hostinger.com/vn#pricing');
  await page.getByRole('button', { name: /Create Hostinger pricing guide/ }).click();
  await page.getByText('Tìm hiểu gói Premium', { exact: true }).waitFor();
  assert.equal(await page.locator('#step-action').inputValue(), 'highlight');
  await page.locator('#site-screenshot').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(root, 'studio-hostinger.png'), fullPage: true });
  assert.deepEqual(uncaught, []);
  console.log(JSON.stringify({ result: 'PASS', pageTitle: await page.title(),
    output: 'output/e2e-studio/studio-editor.png', download: download.suggestedFilename() }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
