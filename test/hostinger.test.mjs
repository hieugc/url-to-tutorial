import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHostingerUrl, hostingerPricingPlan } from '../src/adapters/hostinger.mjs';
import { Plan } from '../src/plan.mjs';

test('Hostinger adapter accepts only official Vietnamese HTTPS pages', () => {
  assert.equal(validateHostingerUrl('https://www.hostinger.com/vn#pricing'), 'https://www.hostinger.com/vn#pricing');
  assert.equal(validateHostingerUrl('https://hostinger.com/vn/web-hosting'), 'https://hostinger.com/vn/web-hosting');
  for (const url of [
    'http://www.hostinger.com/vn',
    'https://hostinger.com.evil.test/vn',
    'https://hostinger.com@evil.test/vn',
    'https://www.hostinger.com:9999/vn',
    'https://www.hostinger.com/en/pricing',
    'https://www.hostinger.com/vn?token=abc',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => validateHostingerUrl(url));
  }
});

test('Hostinger plan only repeats observed values, and never clicks or purchases', () => {
  const observed = {
    url: 'https://www.hostinger.com/vn#pricing',
    cards: [
      {
        key: 'single', name: 'Đơn',
        selector: '#single', monthly: '19.900 đ/th',
        billing: 'Nhận 48 tháng với giá 955.200đ',
        renewal: 'Gia hạn với 80.900đ/th',
        features: ['1 trang web', '10 GB lưu trữ SSD'],
      },
      {
        key: 'premium', name: 'Premium',
        selector: '#premium', monthly: '41.900 đ/th',
        billing: 'Nhận 48 tháng với giá 2.011.200đ',
        renewal: 'Gia hạn với 125.900đ/th',
        features: ['3 trang web', '20 GB lưu trữ SSD'],
      },
    ],
  };
  const plan = hostingerPricingPlan(observed);
  assert.equal(Plan.safeParse(plan).success, true);
  assert.equal(plan.steps[0].target.css, '#premium');
  assert.match(plan.steps[0].description, /41\.900 đ\/th/);
  assert.match(plan.steps[0].description, /2\.011\.200/);
  assert.match(plan.steps[0].description, /125\.900/);
  assert.equal(plan.steps.at(-1).action, 'stop');
  assert.ok(plan.steps.every(step => step.action === 'highlight' || step.action === 'stop'));
  assert.ok(plan.steps.every(step => !step.reviewed));
  assert.ok(!plan.steps.some(step => step.url || step.value));
});

test('Hostinger plan does not invent missing term or renewal values', () => {
  const plan = hostingerPricingPlan({
    url: 'https://www.hostinger.com/vn#pricing',
    cards: [{ key: 'premium', name: 'Premium', selector: '#premium', monthly: '39.000 đ/th', features: [] }],
  });
  assert.match(plan.steps[0].description, /Chưa xác nhận được tổng tiền/);
  assert.match(plan.steps[0].description, /Chưa xác nhận được giá gia hạn/);
  assert.ok(!/125\.900|2\.011\.200/.test(plan.steps[0].description));
  assert.throws(() => hostingerPricingPlan({ url: 'https://www.hostinger.com/vn', cards: [] }), /not found/);
});
