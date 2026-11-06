import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createGoalGuide } from '../src/goal-planner.mjs';
import { Plan } from '../src/plan.mjs';
import { render } from '../src/render.mjs';

const pageHtml = [
  '<!doctype html><html lang="vi"><title>Goal planner fixture</title>',
  '<style>body{font:18px sans-serif;margin:0;background:#f6faf8}',
  'main{margin:40px auto;max-width:900px;padding:30px}',
  'h1,h2,button{padding:14px;border-radius:12px;background:#fff}</style>',
  '<main><h1>Premium hosting</h1><h2>Chọn gói Premium hosting</h2>',
  '<p>Thông tin về gói dịch vụ và tài nguyên</p>',
  '<button type="button" id="buy">Mua ngay</button></main>',
  '</html>',
].join('');
let requestsToCheckout = 0;
const server = createServer((req, res) => {
  if (req.url?.includes('checkout')) requestsToCheckout++;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(pageHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const { plan, evidence } = await createGoalGuide(base, {
    goal: 'Giới thiệu Premium hosting',
    language: 'vi',
    outDir: 'output/e2e-goal',
  });
  Plan.parse(plan);
  assert.ok(plan.steps.length > 1);
  assert.ok(evidence.selectedIds.length > 0);
  assert.ok(plan.steps.every(s => ['highlight', 'stop'].includes(s.action)));
  assert.equal(plan.steps.at(-1).action, 'stop');
  const short = {
    ...plan,
    steps: plan.steps.map(step => ({ ...step, holdMs: 500 })),
  };
  const result = await render(short, { outDir: 'output/e2e-goal-video' });
  assert.equal(result.status, 'completed');
  assert.equal(result.video.codec, 'h264');
  assert.equal(result.video.width, 1280);
  assert.equal(requestsToCheckout, 0);
  await readFile('output/e2e-goal/goal-evidence.json', 'utf8');
  await readFile('output/e2e-goal/discovery-page-1.png');
  console.log(JSON.stringify({
    status: 'PASS', selected: evidence.selectedIds,
    requestsToCheckout, video: result.video,
  }, null, 2));

  await assert.rejects(
    createGoalGuide(base, { goal: 'Kubernetes cluster', outDir: 'output/e2e-goal-unmatched' }),
    /Insufficient evidence/,
  );
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
