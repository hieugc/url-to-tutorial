import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { discover, explore, safePageLink } from '../src/discover.mjs';
import { render } from '../src/render.mjs';

const html = (await readFile(new URL('../examples/demo.html', import.meta.url), 'utf8'))
  .replace('</main>', '<a href="/guide">Xem hướng dẫn</a></main>');
const secondPage = '<!doctype html><html lang="vi"><title>Trang hướng dẫn</title><main><h1>Hướng dẫn chi tiết</h1><button>Tiếp tục</button></main></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/guide') res.end(secondPage);
  else if (req.url === '/empty') res.end('<html><body><div>Nothing here</div></body></html>');
  else res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = 'http://127.0.0.1:' + server.address().port;
  const discovered = await discover(url);
  assert.ok(discovered.steps.length >= 3);
  assert.ok(discovered.steps.every(s => s.action === 'highlight'));

  // Read-only, bounded traversal of a second page with evidence for each page.
  const expanded = await explore(url, { maxPages: 2, outDir: 'output/e2e-discovery' });
  assert.equal(expanded.report.status, 'completed');
  assert.equal(expanded.report.pages.length, 2);
  assert.equal(expanded.plans.length, 2);
  assert.ok(expanded.report.pages[1].finalUrl.endsWith('/guide'));
  await access('output/e2e-discovery/discovery-report.json');
  await access('output/e2e-discovery/discovery-page-1.png');
  await access('output/e2e-discovery/discovery-page-2.png');
  assert.equal(safePageLink('https://example.org/', url, new URL(url).origin), null);
  assert.equal(safePageLink('/checkout', url, new URL(url).origin), null);
  assert.equal(safePageLink('/search?q=hi', url, new URL(url).origin), null);

  // A zero-element page must fail with a diagnostic report, not ENOENT.
  await assert.rejects(explore(url + '/empty', { outDir: 'output/e2e-empty' }), /Discovery failed/);
  const diagnostic = JSON.parse(await readFile('output/e2e-empty/discovery-report.json', 'utf8'));
  assert.equal(diagnostic.status, 'failed');
  assert.equal(diagnostic.pages[0].candidateCount, 0);
  await access('output/e2e-empty/discovery-page-1.png');

  const overview = await render({ ...discovered, steps: discovered.steps.slice(0, 2).map(s => ({ ...s, holdMs: 500 })) }, { outDir: 'output/e2e-overview' });
  assert.equal(overview.status, 'completed');
  const plan = JSON.parse(await readFile(new URL('../examples/demo.plan.json', import.meta.url), 'utf8'));
  plan.url = url;
  const result = await render(plan, { outDir: 'output/e2e-demo' });
  assert.equal(result.status, 'completed');
  assert.equal(result.video.codec, 'h264');
  assert.equal(result.video.width, 1280);
  assert.ok(result.video.duration > 10);
  assert.ok(result.steps.every(s => s.status === 'completed'));
  for (const target of [{ css: '#missing' }, { css: 'button' }]) {
    await assert.rejects(render({ ...plan, steps: [{ ...plan.steps[0], target, holdMs: 500 }] }, { outDir: 'output/e2e-failure' }));
    const report = JSON.parse(await readFile('output/e2e-failure/report.json', 'utf8'));
    assert.equal(report.status, 'failed');
  }
  console.log(JSON.stringify({ result: 'PASS', discoveredSteps: discovered.steps.length, pages: expanded.report.pages.length, video: result.video }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
