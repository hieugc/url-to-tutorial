import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { explore, safePageLink } from '../src/discover.mjs';

const root = 'output/e2e-discovery-public';
let formSubmissions = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST') formSubmissions++;
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: 'https://example.org/private-redirect-target' });
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
    '<script>window.__clicked=0;document.querySelector("button").onclick=()=>window.__clicked++;</script>' +
    '</main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const base = 'http://127.0.0.1:' + server.address().port;
  const controlled = await explore(base, { maxPages: 3, outDir: root, language: 'en' });
  assert.equal(controlled.report.status, 'completed');
  assert.ok(controlled.report.pages.length >= 1 && controlled.report.pages.length <= 3);
  assert.ok(controlled.report.pages.every(page => page.status === 200));
  assert.ok(controlled.report.pages.some(page => page.candidateCount > 0));
  assert.ok(controlled.plans.length >= 1);
  assert.equal(formSubmissions, 0, 'Discovery must never submit forms or click controls');
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
  assert.match(failed.pages[0].error, /BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_CLIENT|Navigation/);
  console.log(JSON.stringify({
    result: 'PASS',
    controlledPages: controlled.report.pages.map(page => ({
      status: page.status, finalUrl: page.finalUrl, candidates: page.candidateCount,
    })),
    externalRedirect: failed.pages[0].error,
  }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
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
