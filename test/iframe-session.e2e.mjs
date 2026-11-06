import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { render } from '../src/render.mjs';
import { Plan, uniqueTarget } from '../src/plan.mjs';
import { launch } from '../src/browser.mjs';
import { assertSafeCapture, installPrivacy } from '../src/privacy.mjs';

async function start(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
const send = (res, html) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store' });
  res.end(html);
};

test('Cross-origin iframe targets can be uniquely located and highlighted in the parent capture', async () => {
  const child = await start((req, res) => send(res,
    '<!doctype html><html><body><h2 id="inside">Embedded product details</h2><p>Public text</p></body></html>'));
  const parent = await start((_req, res) => send(res,
    '<!doctype html><html><body><h1>Parent page</h1>' +
    '<iframe id="details" title="Product details" style="width:700px;height:260px" src="' +
    child.url + '"></iframe></body></html>'));
  const root = await mkdtemp(path.join(tmpdir(), 'utv-iframe-'));
  try {
    const plan = Plan.parse({
      schemaVersion: 1, title: 'Cross-origin iframe', url: parent.url, language: 'en',
      steps: [
        { id: 'inside', title: 'Embedded details', description: 'This heading is inside a cross-origin iframe.',
          target: { frame: { css: 'iframe#details' }, target: { css: '#inside' } },
          action: 'highlight', holdMs: 500 },
        { id: 'stop', title: 'Done', description: 'End of iframe guide.',
          action: 'stop', holdMs: 500 },
      ],
    });
    const result = await render(plan, { outDir: root });
    assert.equal(result.status, 'completed');
    assert.equal(result.executedStepCount, 2);
    await access(path.join(root, 'step-1.png'));
    const saved = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
    assert.equal(saved.status, 'completed');
  } finally {
    parent.server.closeAllConnections(); child.server.closeAllConnections();
    await Promise.all([
      new Promise(resolve => parent.server.close(resolve)),
      new Promise(resolve => child.server.close(resolve)),
    ]);
  }
});

test('Privacy scanning sees MFA controls inside a cross-origin iframe and blocks capture', async () => {
  const child = await start((_req, res) => send(res,
    '<!doctype html><html><body><input id="otp" autocomplete="one-time-code" value="123456"></body></html>'));
  const parent = await start((_req, res) => send(res,
    '<!doctype html><html><body><h1>Sign in</h1><iframe id="challenge" src="' +
    child.url + '"></iframe></body></html>'));
  let browser;
  try {
    browser = await launch();
    const context = await browser.newContext();
    await installPrivacy(context);
    const page = await context.newPage();
    await page.goto(parent.url);
    await page.frameLocator('#challenge').locator('#otp').waitFor({ state: 'visible' });
    await assert.rejects(assertSafeCapture(page), /CAPTCHA\/MFA\/OTP/);
    await context.close();
  } finally {
    await browser?.close();
    parent.server.closeAllConnections(); child.server.closeAllConnections();
    await Promise.all([
      new Promise(resolve => parent.server.close(resolve)),
      new Promise(resolve => child.server.close(resolve)),
    ]);
  }
});

test('Manual login session is transferred in memory only and requires visible confirmation', {
  skip: process.env.SKIP_HEADED_SESSION === '1',
}, async () => {
  const site = await start((_req, res) => send(res,
    '<!doctype html><html><body><main id="app"></main><script>' +
    'if(localStorage.getItem("session")==="demo-ok"){' +
    'document.querySelector("#app").innerHTML="<h1 id=authenticated>Authenticated demo</h1>";' +
    '}else{document.querySelector("#app").innerHTML=' +
    '"<input id=email><input id=password type=password><button id=login>Sign in</button>";' +
    'document.querySelector("#login").onclick=()=>localStorage.setItem("session","demo-ok");}' +
    '</script></body></html>'));
  const root = await mkdtemp(path.join(tmpdir(), 'utv-session-'));
  try {
    const plan = {
      schemaVersion: 1, title: 'Manual session', url: site.url, language: 'en',
      steps: [
        { id: 'authenticated', title: 'Signed in', description: 'Session was supplied in memory.',
          target: { css: '#authenticated' }, action: 'highlight', holdMs: 500 },
        { id: 'stop', title: 'Done', description: 'Session remains local to this render.',
          action: 'stop', holdMs: 500 },
      ],
    };
    await assert.rejects(render(plan, { outDir: path.join(root, 'headless'),
      manualLogin: true, loginPrompt: async () => {} }), /requires --headed/);
    await assert.rejects(render(plan, { outDir: path.join(root, 'missing-callback'),
      headed: true, manualLogin: true }), /confirmation callback/);

    const result = await render(plan, {
      outDir: path.join(root, 'authenticated'), headed: true, manualLogin: true,
      loginPrompt: async page => {
        await page.locator('#email').fill('demo@example.test');
        await page.locator('#password').fill('fixture-only-password');
        await page.locator('#login').click();
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.workflow.manualLogin, true);
    assert.equal(result.executedStepCount, 2);
    const report = await readFile(path.join(root, 'authenticated', 'report.json'), 'utf8');
    assert.equal(report.includes('fixture-only-password'), false);
    await assert.rejects(access(path.join(root, 'authenticated', 'storage-state.json')));
    await assert.rejects(access(path.join(root, 'authenticated', 'cookies.json')));
  } finally {
    site.server.closeAllConnections();
    await new Promise(resolve => site.server.close(resolve));
  }
});
