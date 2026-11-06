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

async function showFrameStep(page, locator, step, index, total) {
  await locator.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await page.waitForTimeout(650);
  const box = await locator.boundingBox();
  if (!box) throw new Error('Iframe target has no visible bounding box');
  const title = (index + 1) + '/' + total + ' · ' + step.title;
  await page.evaluate(async ({ box, title, description }) => {
    const cursor = document.querySelector('#tutorial-cursor');
    if (cursor) {
      const from = cursor.getBoundingClientRect();
      await cursor.animate([
        { left: from.x + 'px', top: from.y + 'px' },
        { left: (box.x + Math.min(box.width / 2, 100)) + 'px',
          top: (box.y + box.height / 2) + 'px' },
      ], { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' }).finished;
    }
    document.querySelector('#tutorial-frame-overlay')?.remove();
    const root = document.createElement('div');
    root.id = 'tutorial-frame-overlay';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    const outline = document.createElement('div');
    outline.style.cssText = 'position:fixed;box-sizing:border-box;border:3px solid #16a085;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.42),0 0 0 6px rgba(22,160,133,.18);';
    outline.style.left = box.x + 'px';
    outline.style.top = box.y + 'px';
    outline.style.width = box.width + 'px';
    outline.style.height = box.height + 'px';
    const popover = document.createElement('div');
    popover.style.cssText = 'position:fixed;box-sizing:border-box;width:min(360px,calc(100vw - 24px));max-height:140px;overflow:hidden;background:#fff;color:#10243a;border-radius:14px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.24);font:16px/1.5 Arial,sans-serif;';
    popover.style.left = Math.max(12, Math.min(box.x, innerWidth - 372)) + 'px';
    popover.style.top = Math.max(12, Math.min(box.y + box.height + 12, innerHeight - 152)) + 'px';
    const heading = document.createElement('strong');
    heading.textContent = title;
    heading.style.cssText = 'display:block;font-size:18px;line-height:1.35;margin-bottom:8px;';
    const body = document.createElement('div');
    body.textContent = description;
    body.style.cssText = 'font-size:14px;line-height:1.5;';
    popover.append(heading, body);
    root.append(outline, popover);
    document.body.append(root);
  }, { box, title, description: step.description });
}

export async function showStep(page, locator, step, index, total, onVisible = undefined) {
  await installOverlay(page);
  if (locator && step.target?.frame) {
    await showFrameStep(page, locator, step, index, total);
  } else if (locator) {
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
  await page.evaluate(() => {
    document.querySelector('#tutorial-frame-overlay')?.remove();
    window.__tutorialDriver?.destroy();
  });
  await page.waitForTimeout(450);
}
