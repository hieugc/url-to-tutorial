import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, ready } from '../browser.mjs';
import { Plan } from '../plan.mjs';

const HOSTS = new Set(['hostinger.com', 'www.hostinger.com']);
const PLAN_LABELS = [
  { key: 'premium', names: ['Premium'] },
  { key: 'single', names: ['Đơn', 'Single'] },
  { key: 'unlimited', names: ['Không giới hạn', 'Unlimited'] },
  { key: 'business', names: ['Business'] },
  { key: 'cloud', names: ['Cloud Startup'] },
];
const MAX_EVIDENCE = 1500;

/** Hostinger-specific URL gate. This is NOT a general SSRF defense. */
export function validateHostingerUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a valid Hostinger URL'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port || url.search ||
      !(url.pathname === '/vn' || url.pathname.startsWith('/vn/'))) {
    throw new Error('Only HTTPS Hostinger Vietnam pages without query parameters are accepted');
  }
  return url.href;
}

/**
 * Read visible pricing cards from the DOM; no click, fill, consent or checkout.
 * Ground every plan step in a selector that was unique when observed.
 */
export async function inspectHostingerPage(page) {
  return page.evaluate((definitions) => {
    const normal = value => (value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element || element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const cssPath = element => {
      if (element.id) {
        const byId = '#' + CSS.escape(element.id);
        if (document.querySelectorAll(byId).length === 1) return byId;
      }
      const parts = [];
      let current = element;
      while (current && current !== document.body) {
        if (!current.parentElement) return null;
        const sameTag = [...current.parentElement.children].filter(node => node.tagName === current.tagName);
        parts.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')');
        current = current.parentElement;
      }
      const selector = 'body > ' + parts.join(' > ');
      return parts.length && document.querySelectorAll(selector).length === 1 ? selector : null;
    };
    const matchesName = text => definitions.find(plan =>
      plan.names.some(name => name.toLocaleLowerCase('vi') === text.toLocaleLowerCase('vi')));
    const MONTHLY = /\b[\d][\d., ]{0,15}\s*(?:đ|₫)\s*\/\s*(?:th|tháng)\b/i;
    const RENEW = /(?:gia hạn(?:\s+với)?|renews?\s+at)[^.!?]{0,130}/i;
    const BILLING = /(?:nhận\s+\d+\s+tháng|thanh toán\s+trước|hôm nay bạn trả|today you pay|get\s+\d+\s+months)[^.!?]{0,155}/i;
    const sourceNodes = [...document.querySelectorAll(
      'h1,h2,h3,h4,h5,h6,[role="heading"],strong,b,p,span,div'
    )].slice(0, 7000);
    const candidates = [];
    for (const node of sourceNodes) {
      if (!visible(node)) continue;
      const text = normal(node.innerText);
      if (!text || text.length > 32) continue;
      const definition = matchesName(text);
      if (!definition) continue;
      // Keep only the innermost matching text node, not all ancestor divs.
      if ([...node.children].some(child => normal(child.innerText) === text)) continue;
      let current = node;
      let best = null;
      for (let depth = 0; current && depth < 9 && current !== document.body; depth++, current = current.parentElement) {
        const fullText = normal(current.innerText);
        if (fullText.length > 3600) break;
        if (!MONTHLY.test(fullText)) continue;
        const selector = cssPath(current);
        if (!selector) continue;
        const otherLabels = [...current.querySelectorAll('h2,h3,h4,[role="heading"]')]
          .filter(el => visible(el) && matchesName(normal(el.innerText)) && el !== node);
        if (otherLabels.length > 1) continue;
        const monthly = fullText.match(MONTHLY)?.[0] || null;
        const renewal = fullText.match(RENEW)?.[0] || null;
        const billing = fullText.match(BILLING)?.[0] || null;
        const hasCTA = [...current.querySelectorAll('button,a')]
          .some(el => /^(bắt đầu|chọn gói|chọn|mua ngay|start now|get started|choose plan)$/i.test(normal(el.innerText)));
        const score = (renewal ? 10 : 0) + (billing ? 8 : 0) + (hasCTA ? 4 : 0) + Math.min(fullText.length / 500, 3) - depth / 100;
        if (!best || score > best.score) {
          const lines = (current.innerText || '').split(/\n+/).map(normal).filter(Boolean);
          const feature = /(?:trang web|tên miền|lưu trữ|sao lưu|hộp thư|CDN|website|storage|backup|domain|email)/i;
          best = {
            key: definition.key, name: text, selector, monthly, billing, renewal,
            features: [...new Set(lines.filter(line => feature.test(line) && line.length < 115))].slice(0, 5),
            evidence: fullText.slice(0, 1500), score,
          };
        }
      }
      if (best) candidates.push(best);
    }
    const found = [];
    for (const definition of definitions) {
      const variants = candidates.filter(card => card.key === definition.key)
        .sort((a, b) => b.score - a.score);
      if (variants.length) {
        const { score, ...card } = variants[0];
        found.push(card);
      }
    }
    const warnings = [];
    const cookieModal = [...document.querySelectorAll('button,[role="button"]')]
      .some(el => visible(el) && /^(chấp nhận tất cả|đồng ý|accept all cookies|accept all)$/i.test(normal(el.innerText)));
    if (cookieModal) warnings.push('Cookie consent control was visible; no consent was given automatically');
    if (!found.length) warnings.push('No supported pricing cards with visible VND/month prices were found');
    if (found.some(card => !card.renewal || !card.billing)) {
      warnings.push('Some cards have no reliably extracted payment term or renewal text; do not infer missing prices');
    }
    return { title: document.title, url: location.href, cards: found, warnings };
  }, PLAN_LABELS);
}

export function hostingerPricingPlan(observed, { focus = 'Premium', language = 'vi' } = {}) {
  if (!['vi', 'en'].includes(language)) throw new Error('language must be vi or en');
  if (!Array.isArray(observed.cards) || !observed.cards.length) {
    throw new Error('Hostinger pricing cards not found: inspect evidence and screenshot, never invent a price');
  }
  const unique = observed.cards.filter(card => card.selector && card.monthly);
  if (!unique.length) throw new Error('Pricing cards are missing verified unique selectors and monthly prices');
  const focused = unique.find(card => card.name.toLowerCase() === focus.toLowerCase());
  const ordered = focused ? [focused, ...unique.filter(card => card !== focused)] : unique;
  const steps = ordered.slice(0, 5).map((card, index) => {
    const details = [
      language === 'vi' ? 'Giá niêm yết hiện thấy: ' : 'Visible listed price: ',
      card.monthly,
      '. ',
      card.billing ? card.billing + '. ' : (language === 'vi' ? 'Chưa xác nhận được tổng tiền và kỳ hạn. ' : 'Payment total/term not verified. '),
      card.renewal ? card.renewal + '. ' : (language === 'vi' ? 'Chưa xác nhận được giá gia hạn. ' : 'Renewal price not verified. '),
      card.features?.length ? (language === 'vi' ? 'Tính năng hiện thấy: ' : 'Observed features: ') + card.features.join('; ') + '. ' : '',
      language === 'vi' ? 'Kiểm tra thuế và điều kiện chính thức trước khi đặt mua.' : 'Confirm taxes and conditions before purchasing.',
    ].join('');
    return {
      id: 'plan-' + card.key,
      title: (language === 'vi' ? 'Tìm hiểu gói ' : 'Explore ') + card.name,
      description: details.slice(0, 1150),
      target: { css: card.selector },
      action: 'highlight',
      holdMs: index === 0 ? 6500 : 4500,
    };
  });
  steps.push({
    id: 'stop-before-checkout',
    title: language === 'vi' ? 'Dừng trước thanh toán' : 'Stop before checkout',
    description: language === 'vi'
      ? 'Hướng dẫn kết thúc ở bảng giá. Không tự chọn gói, đăng nhập, nhập thông tin thanh toán hoặc đặt mua.'
      : 'This guide stops at pricing. It never selects a plan, logs in, submits payment details, or purchases.',
    action: 'stop',
    holdMs: 2500,
  });
  return Plan.parse({
    schemaVersion: 1,
    title: language === 'vi' ? 'Giới thiệu các gói Hostinger' : 'Hostinger pricing overview',
    url: observed.url,
    language,
    mode: 'overview',
    steps,
  });
}

export async function createHostingerGuide(url, { headed = false, language = 'vi', outDir, focus = 'Premium' } = {}) {
  validateHostingerUrl(url);
  if (!['vi', 'en'].includes(language)) throw new Error('language must be vi or en');
  const root = outDir ? path.resolve(outDir) : null;
  if (root) await mkdir(root, { recursive: true });
  const report = {
    status: 'running',
    startedAt: new Date().toISOString(),
    requestedUrl: url,
    checkedUrls: [],
    screenshot: null,
    warnings: [],
    note: 'Read-only observation. No click, cookie consent, account login, plan selection or checkout. Prices may change.',
  };
  let browser;
  try {
    browser = await launch(headed);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: language === 'vi' ? 'vi-VN' : 'en-US' });
    const page = await context.newPage();
    const targets = [url];
    // Some home pages place pricing elsewhere; use an explicitly documented
    // same-origin read-only fallback, never a checkout or user-data page.
    if (new URL(url).pathname === '/vn') targets.push('https://www.hostinger.com/vn/web-hosting');
    let observed = null;
    for (const target of targets) {
      const item = { url: target, status: null, finalUrl: null, plans: 0 };
      report.checkedUrls.push(item);
      try {
        const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await ready(page);
        item.status = response?.status() ?? null;
        item.finalUrl = page.url();
        validateHostingerUrl(item.finalUrl);
        if (item.status >= 400) throw new Error('HTTP ' + item.status);
        for (let attempt = 0; attempt < 4; attempt++) {
          observed = await inspectHostingerPage(page);
          if (observed.cards.length) break;
          if (attempt < 3) await page.waitForTimeout(800);
        }
        item.plans = observed.cards.length;
        if (observed.cards.length) break;
        item.error = 'No visible Hostinger pricing cards at this URL';
      } catch (error) {
        item.error = error.message;
        observed = null;
      }
    }
    if (root) {
      report.screenshot = 'hostinger-pricing.png';
      await page.screenshot({ path: path.join(root, report.screenshot), fullPage: false });
    }
    if (!observed?.cards.length) throw new Error('Hostinger pricing not detected on the visited pages. See hostinger-evidence.json and screenshot.');
    report.status = 'completed';
    report.warnings = observed.warnings;
    if (!observed.cards.some(card => card.name.toLowerCase() === focus.toLowerCase())) {
      report.warnings.push('Preferred plan ' + focus + ' not observed; no specific plan is assumed');
    }
    const evidence = {
      observedAt: new Date().toISOString(), sourceUrl: observed.url,
      selectedPlan: observed.cards.find(card => card.name.toLowerCase() === focus.toLowerCase())?.name || null,
      cards: observed.cards.map(card => ({
        key: card.key, name: card.name, selector: card.selector, monthly: card.monthly,
        billing: card.billing, renewal: card.renewal, features: card.features,
        textExcerpt: card.evidence.slice(0, MAX_EVIDENCE),
      })),
      screenshot: report.screenshot, warnings: report.warnings,
    };
    const plan = hostingerPricingPlan(observed, { focus, language });
    return { plan, evidence, report };
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    if (root) await writeFile(path.join(root, 'hostinger-evidence.json'), JSON.stringify(report, null, 2));
    await browser?.close();
  }
}
