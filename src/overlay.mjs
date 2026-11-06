import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml } from './plan.mjs';
const require = createRequire(import.meta.url);
const driverDir = path.dirname(require.resolve('driver.js'));
const script = await readFile(path.join(driverDir, 'driver.js.iife.js'), 'utf8');
const css = await readFile(path.join(driverDir, 'driver.css'), 'utf8');

export async function installOverlay(page) {
  if (await page.evaluate(() => !!window.__tutorialDriver)) return;
  await page.addScriptTag({ content: script });
  await page.addStyleTag({ content: `${css}\n.driver-popover{font-family:Arial,sans-serif!important;max-width:360px!important;border-radius:16px!important;padding:24px!important;background:#fff!important;color:#10243a!important}.driver-popover-title{font-size:22px!important;line-height:1.3!important}.driver-popover-description{font-size:17px!important;line-height:1.6!important}#tutorial-cursor{position:fixed;left:36px;top:36px;width:20px;height:20px;border:3px solid white;border-radius:50%;background:#16a085;box-shadow:0 0 0 6px #16a08544;z-index:2147483647;pointer-events:none}` });
  await page.evaluate(() => {
    window.__tutorialDriver = window.driver.js.driver({ animate: true, smoothScroll: false, allowClose: false,
      overlayOpacity: 0.6, stagePadding: 12, stageRadius: 10, showButtons: [], disableActiveInteraction: true });
    const cursor = document.createElement('div'); cursor.id = 'tutorial-cursor'; document.body.append(cursor);
  });
}

export async function showStep(page, locator, step, index, total, onVisible = undefined) {
  await installOverlay(page);
  if (locator) {
    await locator.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    // Explicit presentation pacing, not a replacement for element readiness.
    await page.waitForTimeout(650);
    const box = await locator.boundingBox();
    if (!box) throw new Error('Target has no visible bounding box');
    await page.evaluate(async ({ x, y }) => {
      const cursor = document.querySelector('#tutorial-cursor');
      const from = cursor.getBoundingClientRect();
      await cursor.animate([{ left: `${from.x}px`, top: `${from.y}px` }, { left: `${x}px`, top: `${y}px` }],
        { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' }).finished;
    }, { x: box.x + Math.min(box.width / 2, 100), y: box.y + box.height / 2 });
    await locator.evaluate((el, popover) => window.__tutorialDriver.highlight({ element: el, popover }), {
      title: `${index + 1}/${total} · ${escapeHtml(step.title)}`, description: escapeHtml(step.description), side: 'bottom', align: 'start',
    });
  } else {
    await page.evaluate(popover => window.__tutorialDriver.highlight({ popover }), {
      title: escapeHtml(step.title), description: escapeHtml(step.description),
    });
  }
  if (onVisible) await onVisible();
  await page.waitForTimeout(step.holdMs);
}

export async function hideStep(page) {
  await page.evaluate(() => window.__tutorialDriver?.destroy());
  await page.waitForTimeout(450);
}
