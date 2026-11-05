import { launch, ready } from './browser.mjs';
import { HttpUrl, Plan } from './plan.mjs';

// Discover only the loaded document. Never click unknown controls to explore.
export async function discover(url, { headed = false, language = 'vi' } = {}) {
  HttpUrl.parse(url);
  const browser = await launch(headed);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ready(page);
    const observed = await page.evaluate(() => {
      function cssPath(element) {
        if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1)
          return `#${CSS.escape(element.id)}`;
        const parts = [];
        let current = element;
        while (current && current !== document.body) {
          const siblings = [...current.parentElement.children].filter(e => e.tagName === current.tagName);
          parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
          current = current.parentElement;
        }
        return `body > ${parts.join(' > ')}`;
      }
      return [...document.querySelectorAll('h1,h2,main a,main button,[role="main"] a,[role="main"] button')]
        .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
        .map(e => ({ text: (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 140), css: cssPath(e) }))
        .filter(e => e.text).slice(0, 8);
    });
    if (!observed.length) throw new Error('No visible headings/controls found. Use an explicit plan for this page.');
    return Plan.parse({ schemaVersion: 1, title: await page.title() || 'Website walkthrough', url: page.url(), language, mode: 'overview',
      steps: observed.map((e, i) => ({ id: `step-${i + 1}`, title: e.text, target: { css: e.css },
        description: language === 'vi' ? `Quan sát mục “${e.text}”. Bạn có thể sửa lời hướng dẫn trong plan.json.` : `Explore “${e.text}”. Edit this guidance in plan.json.`,
        action: 'highlight', holdMs: 3000 })) });
  } finally { await browser.close(); }
}
