import test from 'node:test';
import assert from 'node:assert/strict';
import { Plan, HttpUrl, escapeHtml } from '../src/plan.mjs';
const base = () => ({ schemaVersion: 1, title: 'Demo', url: 'https://example.com', steps: [{ id: 'one', title: 'Hello', description: 'World', target: { css: 'h1' } }] });
test('URL input rejects local files, scripts and embedded credentials', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com']) assert.equal(HttpUrl.safeParse(url).success, false);
});
test('overview defaults to highlighting without action', () => {
  const p = Plan.parse(base()); assert.equal(p.steps[0].action, 'highlight'); assert.equal(p.steps[0].reviewed, false);
});
test('executable actions require explicit review and required data', () => {
  const p = base(); p.steps[0].action = 'fill';
  assert.equal(Plan.safeParse(p).success, false);
  p.steps[0].reviewed = true; assert.equal(Plan.safeParse(p).success, false);
  p.steps[0].value = 'demo'; assert.equal(Plan.safeParse(p).success, true);
});
test('stop is terminal and duplicate step ids fail', () => {
  const p = base(); p.steps.push({ ...p.steps[0] }); assert.equal(Plan.safeParse(p).success, false);
  p.steps[1].id = 'two'; p.steps[0].action = 'stop'; assert.equal(Plan.safeParse(p).success, false);
});
test('HTML from page or plan cannot become active popover markup', () => {
  assert.equal(escapeHtml('<img onerror="alert(1)">'), '&lt;img onerror=&quot;alert(1)&quot;&gt;');
});
test('reject unknown executable fields and unsupported resolutions', () => {
  const p = base(); p.steps[0].evaluate = 'alert(1)'; assert.equal(Plan.safeParse(p).success, false);
  delete p.steps[0].evaluate; p.viewport = { width: 1281, height: 720 }; assert.equal(Plan.safeParse(p).success, false);
});
