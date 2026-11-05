import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { discover } from '../src/discover.mjs';
import { render } from '../src/render.mjs';
const html = await readFile(new URL('../examples/demo.html', import.meta.url));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const discovered = await discover(url);
  assert.ok(discovered.steps.length >= 3);
  assert.ok(discovered.steps.every(s => s.action === 'highlight'));
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
  // Missing and ambiguous elements must fail instead of yielding a misleading video.
  for (const target of [{ css: '#missing' }, { css: 'button' }]) {
    await assert.rejects(render({ ...plan, steps: [{ ...plan.steps[0], target, holdMs: 500 }] }, { outDir: 'output/e2e-failure' }));
    const report = JSON.parse(await readFile('output/e2e-failure/report.json', 'utf8'));
    assert.equal(report.status, 'failed');
  }
  console.log(JSON.stringify({ result: 'PASS', discoveredSteps: discovered.steps.length, video: result.video }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
