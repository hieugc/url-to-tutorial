import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { explore, safePageLink } from '../src/discover.mjs';

const root = 'output/e2e-discovery-public';
let formSubmissions = 0;
let automaticWrites = 0;
let readOnlyPings = 0;
let websocketUpgrades = 0;
let redirectTargetUrl;
let externalOriginHits = 0;
const externalOrigin = createServer((_req, res) => {
  externalOriginHits++;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>External origin should not receive redirected navigation</h1>');
});
const server = createServer((req, res) => {
  if (req.method === 'POST') formSubmissions++;
  if (!['GET', 'HEAD'].includes(req.method)) automaticWrites++;
  if (req.url === '/read-ping') {
    readOnlyPings++;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === '/write-test') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('write was incorrectly allowed');
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: redirectTargetUrl + '/private-redirect-target' });
    return res.end();
  }
  if (req.url === '/redirect-local') {
    res.writeHead(302, { Location: '/child' });
    return res.end();
  }
  if (req.url === '/child') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><h1>Child page</h1><a href="/logout">Logout</a>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><body><main><h1>Controlled discovery fixture</h1>' +
    '<h2>Features</h2><a href="/child">Read child page</a>' +
    '<a href="https://example.org/external">External link</a>' +
    '<form><input name="email"><button type="submit">Submit</button></form>' +
    '<script>window.__clicked=0;document.querySelector("button").onclick=()=>window.__clicked++;' +
    'fetch("/read-ping").catch(()=>{});' +
    'fetch("/write-test",{method:"POST",body:"unsafe"}).catch(()=>{});' +
    'fetch("/write-test",{method:"PATCH",body:"unsafe"}).catch(()=>{});' +
    'const ws=new WebSocket("ws://"+location.host+"/write-socket");ws.onerror=()=>{};' +
    '</script>' +
    '</main></body></html>');
});
// An intercepted socket must never upgrade to the application server.
server.on('upgrade', (_req, socket) => {
  websocketUpgrades++;
  socket.destroy();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => externalOrigin.listen(0, '127.0.0.1', resolve));
redirectTargetUrl = 'http://127.0.0.1:' + externalOrigin.address().port;
try {
  const base = 'http://127.0.0.1:' + server.address().port;
  const controlled = await explore(base, { maxPages: 3, outDir: root, language: 'en' });
  assert.equal(controlled.report.status, 'completed');
  assert.ok(controlled.report.pages.length >= 1 && controlled.report.pages.length <= 3);
  assert.ok(controlled.report.pages.every(page => page.status === 200));
  assert.ok(controlled.report.pages.some(page => page.candidateCount > 0));
  assert.ok(controlled.plans.length >= 1);
  assert.equal(formSubmissions, 0, 'Discovery must never submit forms or click controls');
  assert.ok(readOnlyPings >= 1, 'Fixture JavaScript must have actually run');
  assert.ok(controlled.report.blockedHttpMutations >= 2,
    'Explorer must intercept automatic POST and PATCH before network send');
  assert.ok(controlled.report.blockedWebSockets >= 1,
    'Explorer must intercept WebSocket before the server handshake');
  assert.equal(automaticWrites, 0, 'Server must receive zero non-read HTTP methods');
  assert.equal(websocketUpgrades, 0, 'Server must receive zero WebSocket upgrades');
  await access(root + '/discovery-page-1.png');
  const saved = JSON.parse(await readFile(root + '/discovery-report.json', 'utf8'));
  assert.equal(saved.status, 'completed');
  assert.equal(safePageLink('https://example.org/external', base, new URL(base).origin), null);
  assert.equal(safePageLink(base + '/logout', base, new URL(base).origin), null);
  assert.equal(safePageLink(base + '/child?token=1', base, new URL(base).origin), null);

  const failureRoot = root + '-redirect';
  await assert.rejects(explore(base + '/redirect', {
    maxPages: 3, outDir: failureRoot, language: 'en',
  }), /Discovery failed/);
  const failed = JSON.parse(await readFile(failureRoot + '/discovery-report.json', 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.ok(failed.pages[0].error);
  assert.match(failed.pages[0].error, /Redirect refused before following target/);
  assert.equal(failed.pages[0].finalUrl, null,
    'Redirect target must never become the browser location');
  assert.equal(externalOriginHits, 0,
    'The off-origin HTTP server must receive zero requests');

  await assert.rejects(explore(base + '/redirect-local', {
    maxPages: 1, language: 'en',
  }), /Redirect refused before following target/,
  'Even same-origin redirects are refused to prevent chained external redirects');
  assert.equal(externalOriginHits, 0);
  console.log(JSON.stringify({
    result: 'PASS',
    controlledPages: controlled.report.pages.map(page => ({
      status: page.status, finalUrl: page.finalUrl, candidates: page.candidateCount,
    })),
    externalRedirect: failed.pages[0].error,
    externalOriginHits, automaticWrites, websocketUpgrades,
    blockedHttpMutations: controlled.report.blockedHttpMutations,
    blockedWebSockets: controlled.report.blockedWebSockets,
  }));
} finally {
  server.closeAllConnections();
  externalOrigin.closeAllConnections();
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => externalOrigin.close(resolve)),
  ]);
}

const publicSite = await explore('https://example.com', {
  maxPages: 3, outDir: 'output/e2e-discovery-example-com', language: 'en',
});
assert.equal(publicSite.report.status, 'completed');
assert.ok(publicSite.report.pages.length >= 1 && publicSite.report.pages.length <= 3);
assert.ok(publicSite.report.pages.every(page => page.finalUrl &&
  new URL(page.finalUrl).origin === 'https://example.com'));
assert.ok(publicSite.plans.length >= 1);
console.log(JSON.stringify({
  publicSite: 'https://example.com',
  pages: publicSite.report.pages.map(page => ({
    status: page.status, title: page.title, candidateCount: page.candidateCount,
  })),
}));
