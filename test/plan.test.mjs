import test from 'node:test';
import assert from 'node:assert/strict';
import { Plan, HttpUrl, escapeHtml, validatePlanForExecution } from '../src/plan.mjs';

const base = () => ({
  schemaVersion: 1, title: 'Demo', url: 'https://example.com',
  steps: [{ id: 'one', title: 'Hello', description: 'World', target: { css: 'h1' } }],
});

test('URL input rejects local files, scripts and embedded credentials', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com'])
    assert.equal(HttpUrl.safeParse(url).success, false);
});

test('overview defaults to highlighting without action', () => {
  const p = Plan.parse(base());
  assert.equal(p.steps[0].action, 'highlight');
  assert.equal(p.steps[0].reviewed, false);
});

test('draft action steps parse but cannot execute until explicitly reviewed', () => {
  const p = base();
  p.steps[0].action = 'fill';
  p.steps[0].value = 'demo';
  const parsed = Plan.parse(p);
  assert.deepEqual(validatePlanForExecution(parsed), ['Step "one" (fill) must be reviewed before execution']);
  p.steps[0].reviewed = true;
  assert.deepEqual(validatePlanForExecution(Plan.parse(p)), []);
});

test('branch workflow requires existing forward-only paths and reachable steps', () => {
  const p = {
    ...base(),
    steps: [
      { id: 'check', title: 'Kiểm tra', description: 'Có giỏ hàng không?', action: 'branch',
        condition: { target: { css: '#cart' }, state: 'visible' }, onTrue: 'yes', onFalse: 'no' },
      { id: 'yes', title: 'Có giỏ hàng', description: 'Giỏ hàng đã mở.', target: { css: '#cart' }, next: 'finish' },
      { id: 'no', title: 'Chưa có giỏ hàng', description: 'Giỏ hàng chưa mở.', target: { css: '#plans' }, next: 'finish' },
      { id: 'finish', title: 'Kết thúc', description: 'Dừng.', action: 'stop' },
    ],
  };
  const parsed = Plan.parse(p);
  assert.equal(parsed.steps[0].action, 'branch');
  assert.equal(parsed.steps[0].condition.state, 'visible');

  const missing = structuredClone(p);
  missing.steps[0].onFalse = 'missing';
  assert.equal(Plan.safeParse(missing).success, false);

  const backwards = structuredClone(p);
  backwards.steps[1].next = 'check';
  assert.equal(Plan.safeParse(backwards).success, false);

  const unreachable = structuredClone(p);
  unreachable.steps[0].onFalse = 'finish';
  unreachable.steps[2].id = 'orphan';
  assert.equal(Plan.safeParse(unreachable).success, false);
});

test('stop is terminal and duplicate step ids fail', () => {
  const p = base();
  p.steps.push({ ...p.steps[0] });
  assert.equal(Plan.safeParse(p).success, false);
  p.steps[1].id = 'two';
  p.steps[0].action = 'stop';
  assert.equal(Plan.safeParse(p).success, false);
});

test('HTML from page or plan cannot become active popover markup', () => {
  assert.equal(escapeHtml('<img onerror="alert(1)">'), '&lt;img onerror=&quot;alert(1)&quot;&gt;');
});

test('reject unknown executable fields and unsupported resolutions', () => {
  const p = base();
  p.steps[0].evaluate = 'alert(1)';
  assert.equal(Plan.safeParse(p).success, false);
  delete p.steps[0].evaluate;
  p.viewport = { width: 1281, height: 720 };
  assert.equal(Plan.safeParse(p).success, false);
});
