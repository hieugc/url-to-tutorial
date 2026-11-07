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


test('Reviewed fill and click actions work inside a cross-origin iframe while field values stay masked', async () => {
  let parentLoads = 0;
  let childLoads = 0;
  let clickCount = 0;
  const maskSnapshots = [];
  const child = await start((req, res) => {
    if (req.url.startsWith('/mask-check?')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      maskSnapshots.push({
        redacted: url.searchParams.get('redacted'),
        color: url.searchParams.get('color'),
        placeholderColor: url.searchParams.get('placeholderColor'),
        placeholderOpacity: url.searchParams.get('placeholderOpacity'),
      });
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/clicked') {
      clickCount++;
      res.writeHead(204).end();
      return;
    }
    if (req.url !== '/') {
      res.writeHead(204).end();
      return;
    }
    childLoads++;
    send(res, '<!doctype html><html><body>' +
      '<input id="secret" type="text" autocomplete="email" placeholder="PRIVATE_IFRAME_PLACEHOLDER">' +
      '<button id="confirm" type="button">Save details</button>' +
      '<p id="result">Not saved</p>' +
      '<script>' +
      'const field=document.querySelector("#secret");' +
      'const recordMask=()=>{' +
      'const style=getComputedStyle(field);const placeholder=getComputedStyle(field,"::placeholder");' +
      'const query=new URLSearchParams({' +
      'redacted:String(field.hasAttribute("data-tutorial-redacted")),' +
      'color:style.color,placeholderColor:placeholder.color,placeholderOpacity:placeholder.opacity});' +
      'fetch("/mask-check?"+query.toString(),{cache:"no-store"});};' +
      'document.addEventListener("DOMContentLoaded",recordMask,{once:true});' +
      'field.addEventListener("input",recordMask);' +
      'document.querySelector("#confirm").addEventListener("click",()=>{' +
      'document.querySelector("#result").textContent="Saved safely";fetch("/clicked");});' +
      '</script></body></html>');
  });
  const parent = await start((req, res) => {
    if (req.url !== '/') {
      res.writeHead(204).end();
      return;
    }
    parentLoads++;
    send(res, '<!doctype html><html><body><h1>Parent application</h1>' +
      '<iframe id="details" title="Cross-origin details" ' +
      'style="width:700px;height:260px;border:0" src="' + child.url + '"></iframe>' +
      '</body></html>');
  });
  const root = await mkdtemp(path.join(tmpdir(), 'utv-iframe-actions-'));
  const secret = 'PRIVATE_IFRAME_VALUE_MUST_NOT_APPEAR';
  const frame = { frame: { css: 'iframe#details' } };

  try {
    const unreviewed = {
      schemaVersion: 1, title: 'Unreviewed iframe action', url: parent.url, language: 'en',
      steps: [
        { id: 'click', title: 'Save', description: 'This action is not approved.',
          target: { ...frame, target: { css: '#confirm' } },
          action: 'click', reviewed: false, holdMs: 500 },
        { id: 'stop', title: 'Done', description: 'Stop.', action: 'stop', holdMs: 500 },
      ],
    };
    await assert.rejects(
      render(unreviewed, { outDir: path.join(root, 'unreviewed') }),
      /must be reviewed before execution/,
    );
    assert.equal(parentLoads, 0, 'Unreviewed iframe actions must fail before opening the site');
    assert.equal(childLoads, 0);
    assert.equal(clickCount, 0);

    const plan = Plan.parse({
      schemaVersion: 1, title: 'Reviewed cross-origin iframe actions',
      url: parent.url, language: 'en',
      steps: [
        { id: 'fill', title: 'Enter details', description: 'Fill the explicitly approved field.',
          target: { ...frame, target: { css: '#secret' } },
          action: 'fill', value: secret, reviewed: true, holdMs: 500 },
        { id: 'click', title: 'Save details', description: 'Click the explicitly approved button.',
          target: { ...frame, target: { role: 'button', name: 'Save details' } },
          action: 'click', reviewed: true, holdMs: 500 },
        { id: 'result', title: 'Confirm saved', description: 'The embedded page confirms the action.',
          target: { ...frame, target: { css: '#result' } },
          action: 'highlight', holdMs: 500 },
        { id: 'stop', title: 'Done', description: 'End of the embedded workflow.',
          action: 'stop', holdMs: 500 },
      ],
    });
    const result = await render(plan, { outDir: path.join(root, 'reviewed') });
    assert.equal(result.status, 'completed');
    assert.equal(result.executedStepCount, 4);
    assert.equal(result.video.codec, 'h264');
    assert.equal(parentLoads, 1);
    assert.equal(childLoads, 1);
    assert.equal(clickCount, 1, 'The reviewed click must reach the embedded fixture exactly once');

    // Wait for the fixture's asynchronous privacy telemetry to reach the server.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(maskSnapshots.length >= 2, 'Mask state must be checked before and after filling');
    for (const snapshot of maskSnapshots) {
      assert.equal(snapshot.redacted, 'true', 'The field must carry the privacy marker inside the iframe');
      assert.match(snapshot.color, /rgba\(0, 0, 0, 0\)/, 'Input text must be transparent');
      assert.match(snapshot.placeholderColor, /rgba\(0, 0, 0, 0\)/, 'Placeholder text must be transparent');
      assert.equal(snapshot.placeholderOpacity, '0');
    }

    await access(path.join(root, 'reviewed', 'step-2.png'));
    await access(path.join(root, 'reviewed', 'tutorial.mp4'));
    const report = await readFile(path.join(root, 'reviewed', 'report.json'), 'utf8');
    assert.equal(report.includes(secret), false, 'Filled values must never enter the public render report');
    assert.equal(report.includes('PRIVATE_IFRAME_PLACEHOLDER'), false);
  } finally {
    parent.server.closeAllConnections(); child.server.closeAllConnections();
    await Promise.all([
      new Promise(resolve => parent.server.close(resolve)),
      new Promise(resolve => child.server.close(resolve)),
    ]);
  }
});
