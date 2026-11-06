import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { launch, ready } from '../src/browser.mjs';
import { installPrivacy, assertSafeCapture } from '../src/privacy.mjs';
import { render } from '../src/render.mjs';

const html = (challenge = '') => [
  '<!doctype html><html lang="vi"><meta charset="utf-8"><title>Privacy fixture</title>',
  '<main><h1>Private settings tour</h1>',
  '<input id="name" value="SECRET_USER" aria-label="Name">',
  '<input id="card" autocomplete="cc-number" value="4242424242424242">',
  '<textarea id="notes">PRIVATE_NOTE</textarea>',
  '<div id="user-info" data-sensitive="true">PRIVATE_ADDRESS</div>',
  '<p id="private-note">A custom protected note</p>',
  challenge,
  '</main><script>setTimeout(() => {',
  'const newField = document.createElement("input");newField.id = "dynamic";',
  'newField.value = "DYNAMIC_SECRET";document.querySelector("main").append(newField);',
  '}, 75)</script></html>',
].join('');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html(req.url === '/mfa' ?
    '<input type="text" autocomplete="one-time-code" value="123456">' : ''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await installPrivacy(context, ['#private-note']);
  const page = await context.newPage();
  await page.goto(url);
  await ready(page);
  await page.waitForTimeout(130);
  await assertSafeCapture(page);
  for (const selector of ['#name', '#card', '#notes', '#dynamic']) {
    const style = await page.locator(selector).evaluate(el => ({
      visibility: getComputedStyle(el).visibility,
      color: getComputedStyle(el).color,
    }));
    assert.equal(style.visibility, 'visible', selector + ' must remain actionable');
    assert.match(style.color, /rgba\(0, 0, 0, 0\)/, selector + ' text must be masked');
  }
  for (const selector of ['#user-info', '#private-note']) {
    const visibility = await page.locator(selector).evaluate(el => getComputedStyle(el).visibility);
    assert.equal(visibility, 'hidden', selector + ' must be hidden before capture');
  }
  await page.goto(url + '/mfa');
  await ready(page);
  await assert.rejects(assertSafeCapture(page), /CAPTCHA\/MFA\/OTP/);
  await context.close();
  await browser.close();
  browser = null;

  const plan = {
    schemaVersion: 1, title: 'Privacy E2E', url,
    redactSelectors: ['#private-note'],
    steps: [
      { id: 'public', title: 'Read-only public heading', description: 'Do not show private inputs',
        target: { css: 'h1' }, action: 'highlight', holdMs: 500 },
      { id: 'finish', title: 'Stop', description: 'End of safe walkthrough',
        action: 'stop', holdMs: 500 },
    ],
  };
  const rendered = await render(plan, { outDir: 'output/e2e-privacy' });
  assert.equal(rendered.status, 'completed');
  assert.equal(rendered.video.codec, 'h264');
  await access('output/e2e-privacy/step-1.png');
  console.log(JSON.stringify({ result: 'PASS', maskCount: 6, mfaStop: true, video: rendered.video }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
