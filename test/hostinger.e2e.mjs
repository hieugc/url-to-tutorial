import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { inspectHostingerPage, hostingerPricingPlan } from '../src/adapters/hostinger.mjs';
import { render } from '../src/render.mjs';

const outDir = path.resolve('output/e2e-hostinger');
await mkdir(outDir, { recursive: true });
let purchaseRequests = 0;

const html = [
  '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Hostinger pricing fixture</title>',
  '<style>body{font-family:Arial,sans-serif;margin:0;background:#f5f6fa;color:#202c50}',
  'main{max-width:1100px;margin:0 auto;padding:40px}h1{font-size:32px}',
  '#pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin:40px auto}',
  'article{min-height:370px;padding:26px;border-radius:18px;background:#fff;box-shadow:0 2px 15px #0001}',
  'h3{font-size:24px}.price{font-size:26px;color:#5c22ce;font-weight:bold}',
  '.term{color:#536079}button{background:#673de6;border:0;color:white;padding:12px 22px;border-radius:8px}',
  '</style></head><body><header><p>Hostinger Demo</p></header><main><h1>Chọn gói web hosting</h1>',
  '<section id="pricing">',
  '<article id="single-card"><h3>Đơn</h3><p class="price">19.900 đ/th</p>',
  '<p class="term">Nhận 48 tháng với giá 955.200đ. Gia hạn với 80.900đ/th.</p>',
  '<ul><li>1 trang web</li><li>10 GB lưu trữ SSD</li></ul>',
  '<button type="button" onclick="fetch(&quot;/purchase&quot;)">Bắt đầu</button></article>',
  '<article id="premium-card"><h3>Premium</h3><p class="price">41.900 đ/th</p>',
  '<p class="term">Nhận 48 tháng với giá 2.011.200đ. Gia hạn với 125.900đ/th.</p>',
  '<ul><li>3 trang web</li><li>20 GB lưu trữ SSD</li></ul>',
  '<button type="button" onclick="fetch(&quot;/purchase&quot;)">Bắt đầu</button></article>',
  '<article id="cloud-card"><h3>Cloud Startup</h3><p class="price">167.900 đ/th</p>',
  '<p class="term">Nhận 48 tháng với giá 8.059.200đ. Gia hạn với 447.900đ/th.</p>',
  '<ul><li>100 GB lưu trữ NVMe</li><li>Sao lưu hàng ngày</li></ul>',
  '<button type="button" onclick="fetch(&quot;/purchase&quot;)">Bắt đầu</button></article>',
  '<article id="hidden-fake" hidden><h3>Premium</h3><p>0 đ/th</p></article>',
  '</section><div><button id="cookie-btn" type="button">Chấp nhận tất cả</button></div>',
  '</main></body></html>',
].join('\n');

const server = createServer((req, res) => {
  if (req.url === '/purchase') { purchaseRequests++; res.writeHead(200); res.end('purchase'); return; }
  if (req.url === '/changed') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Changed page</title><main><h2>New plans coming soon</h2></main>');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/#pricing';

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url);

  const observed = await inspectHostingerPage(page);
  assert.deepEqual(observed.cards.map(card => card.name), ['Premium', 'Đơn', 'Cloud Startup']);
  assert.ok(observed.cards.every(card => card.selector && card.monthly));
  assert.match(observed.cards.find(card => card.name === 'Premium').billing, /2\.011\.200/);
  assert.match(observed.cards.find(card => card.name === 'Premium').renewal, /125\.900/);
  assert.ok(observed.warnings.some(warning => /Cookie consent/.test(warning)));
  const plan = hostingerPricingPlan(observed, { focus: 'Premium' });
  assert.equal(plan.steps[0].target.css, '#premium-card');
  assert.equal(plan.steps.at(-1).action, 'stop');
  assert.equal(plan.steps.some(step => ['click', 'fill', 'navigate'].includes(step.action)), false);

  await page.locator(plan.steps[0].target.css).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, 'hostinger-pricing-fixture.png') });
  await writeFile(path.join(outDir, 'fixture-evidence.json'), JSON.stringify({
    title: observed.title, url: observed.url, cards: observed.cards, warnings: observed.warnings,
  }, null, 2));

  const short = { ...plan, steps: [
    { ...plan.steps[0], holdMs: 2000 },
    { ...plan.steps.at(-1), holdMs: 1000 },
  ] };
  const result = await render(short, { outDir: path.join(outDir, 'video') });
  assert.equal(result.status, 'completed');
  assert.equal(result.video.codec, 'h264');
  assert.equal(result.video.width, 1280);
  assert.equal(result.steps.at(-1).id, 'stop-before-checkout');
  assert.equal(purchaseRequests, 0);

  await page.goto('http://127.0.0.1:' + server.address().port + '/changed');
  const changed = await inspectHostingerPage(page);
  assert.equal(changed.cards.length, 0);
  assert.throws(() => hostingerPricingPlan(changed), /not found/);
  console.log(JSON.stringify({
    result: 'PASS', observedPlans: observed.cards.map(card => card.name),
    purchaseRequests, video: result.video,
    screenshot: path.join(outDir, 'hostinger-pricing-fixture.png'),
  }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
