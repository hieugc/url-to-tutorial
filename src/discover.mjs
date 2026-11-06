import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, ready } from './browser.mjs';
import { HttpUrl, Plan } from './plan.mjs';
import { installPrivacy, assertSafeCapture } from './privacy.mjs';

const BLOCKED_PATH = /(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|checkout|payment|purchase|order|cart|unsubscribe|confirm|billing)(?:\/|$)/i;
const ASSET_PATH = /\.(?:pdf|zip|png|jpe?g|webp|gif|svg|mp4|mov|webm|mp3|css|js)$/i;

/**
 * Only follow ordinary same-origin page links. Never click a control or
 * follow links with query parameters during automatic discovery.
 */
export function safePageLink(href, baseUrl, origin) {
  try {
    const target = new URL(href, baseUrl);
    if (!['http:', 'https:'].includes(target.protocol) ||
        target.origin !== origin || target.username || target.password ||
        target.search || BLOCKED_PATH.test(target.pathname) ||
        ASSET_PATH.test(target.pathname)) return null;
    target.hash = '';
    return target.href;
  } catch { return null; }
}

function pagePlan(snapshot, language) {
  return Plan.parse({
    schemaVersion: 1,
    title: snapshot.title || 'Website walkthrough',
    url: snapshot.url,
    language,
    mode: 'overview',
    steps: snapshot.candidates.slice(0, 8).map((item, i) => ({
      id: 'step-' + (i + 1),
      title: item.text.slice(0, 160),
      target: { css: item.css },
      description: language === 'vi'
        ? 'Quan sát mục “' + item.text + '”. Bạn có thể sửa lời hướng dẫn trong plan.json.'
        : 'Explore “' + item.text + '”. Edit this guidance in plan.json.',
      action: 'highlight',
      holdMs: 3000,
    })),
  });
}

async function snapshotPage(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const bounds = el.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    };
    const cssPath = (element) => {
      if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
        return '#' + CSS.escape(element.id);
      }
      const parts = [];
      let current = element;
      while (current && current !== document.body) {
        if (!current.parentElement) return null;
        const siblings = [...current.parentElement.children].filter(e => e.tagName === current.tagName);
        parts.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
        current = current.parentElement;
      }
      return 'body > ' + parts.join(' > ');
    };
    const candidates = [...document.querySelectorAll(
      'h1,h2,h3,a,button,[role="button"],[role="link"],input:not([type="hidden"]),select'
    )]
      .filter(el => isVisible(el) && el.getAttribute('type') !== 'password')
      .map(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
          el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 140);
        let score = /^H[1-3]$/.test(el.tagName) ? 100 : el.tagName === 'BUTTON' ? 60 : 20;
        if (el.closest('main,[role="main"]')) score += 10;
        return { text, css: cssPath(el), score };
      })
      .filter(item => item.text && item.css)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ text, css }) => ({ text, css }));
    const links = [...document.querySelectorAll('a[href]')]
      .filter(isVisible)
      .map(el => ({
        href: el.href,
        label: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 100),
      }))
      .filter(link => link.label)
      .slice(0, 100);
    return {
      title: document.title || 'Website walkthrough',
      bodyTextLength: document.body?.innerText?.length || 0,
      candidates,
      links,
    };
  });
}

/**
 * A bounded, read-only explorer: it uses page.goto only; it never clicks,
 * submits forms, fills inputs, or automatically approves action steps.
 * Each page gets its own editable plan (cross-page replay isn't implied).
 */
export async function explore(url, { headed = false, language = 'vi', maxPages = 1, outDir, signal } = {}) {
  HttpUrl.parse(url);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) {
    throw new Error('maxPages must be an integer between 1 and 5');
  }
  if (!['vi', 'en'].includes(language)) throw new Error('language must be vi or en');
  const origin = new URL(url).origin;
  const queue = [url];
  const visited = new Set();
  const plans = [];
  const report = {
    status: 'running', startedAt: new Date().toISOString(),
    entryUrl: url, maxPages, pages: [],
    note: 'No scripted clicks/fills. HTTP mutations and WebSockets are blocked; GET/page scripts can still cause side effects. Form inputs and explicitly marked private regions are visually masked, but other visible text may remain sensitive. Use operator-controlled URLs.',
    blockedHttpMutations: 0, blockedWebSockets: 0,
  };
  if (outDir) await mkdir(outDir, { recursive: true });
  let browser, context;
  const abortHandler = () => {
    context?.close().catch(() => {});
    browser?.close().catch(() => {});
  };
  signal?.addEventListener('abort', abortHandler, { once: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('Discovery cancelled'), { name: 'AbortError' });
    browser = await launch(headed);
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }, serviceWorkers: 'block',
    });
    // Install the same document-start privacy masking used by video rendering.
    // It covers form controls and marked fields, NOT arbitrary visible page text.
    await installPrivacy(context);
    // Intercept sockets BEFORE opening a page: read-only discovery has no
    // reason to establish bidirectional WebSocket sessions.
    await context.routeWebSocket('**/*', ws => {
      report.blockedWebSockets++;
      return ws.close();
    });
    const page = await context.newPage();
    // Playwright routes only the first URL in a redirect chain. Checking page.url()
    // after goto() detects a cross-origin redirect too late: the browser may have
    // already requested it. Fail closed on ALL main-document redirects until a
    // redirect-aware isolated egress policy exists. This can reject canonical
    // URL redirects; the user must provide the destination URL directly.
    let refusedRedirect = false;
    await context.route('**/*', async route => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method().toUpperCase())) {
        // Website JavaScript can send beacons, fetch() or form POSTs even
        // without operator clicks; never forward these during discovery.
        report.blockedHttpMutations++;
        await route.abort('blockedbyclient');
        return;
      }
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
        await route.continue();
        return;
      }
      let target;
      try { target = new URL(request.url()); } catch { await route.abort('blockedbyclient'); return; }
      if (target.origin !== origin) {
        await route.abort('blockedbyclient');
        return;
      }
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
        if (response.status() >= 300 && response.status() < 400) {
          refusedRedirect = true;
          await route.abort('blockedbyclient');
          return;
        }
        await route.fulfill({ response });
      } catch (error) {
        await route.abort('failed').catch(() => {});
      }
    });
    while (queue.length && report.pages.length < maxPages) {
      if (signal?.aborted) throw Object.assign(new Error('Discovery cancelled'), { name: 'AbortError' });
      const requestedUrl = queue.shift();
      if (visited.has(requestedUrl)) continue;
      visited.add(requestedUrl);
      const entry = { requestedUrl, status: null, finalUrl: null, title: '', candidateCount: 0, candidates: [], outgoingLinks: [], screenshot: null };
      report.pages.push(entry);
      let safeToScreenshot = false;
      try {
        const response = await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await ready(page);
        entry.status = response?.status() ?? null;
        entry.finalUrl = page.url();
        if (new URL(entry.finalUrl).origin !== origin) throw new Error('Redirected to another origin');
        if (entry.status && entry.status >= 400) throw new Error('HTTP ' + entry.status);
        // Never persist a screenshot of CAPTCHA/MFA/OTP or a frame whose
        // document-start privacy guard failed to initialize.
        await assertSafeCapture(page);
        safeToScreenshot = true;
        const observed = await snapshotPage(page);
        entry.title = observed.title;
        entry.bodyTextLength = observed.bodyTextLength;
        entry.candidateCount = observed.candidates.length;
        entry.candidates = observed.candidates;
        entry.outgoingLinks = [...new Set(observed.links
          .map(link => safePageLink(link.href, entry.finalUrl, origin))
          .filter(Boolean))].slice(0, 30);
        if (outDir) {
          entry.screenshot = 'discovery-page-' + report.pages.length + '.png';
          await page.screenshot({ path: path.join(outDir, entry.screenshot), fullPage: false });
        }
        if (observed.candidates.length) {
          plans.push(pagePlan({ ...observed, url: entry.finalUrl }, language));
        } else {
          entry.error = 'No visible headings/controls found on loaded page';
        }
        for (const next of entry.outgoingLinks) {
          if (!visited.has(next) && !queue.includes(next) && queue.length < 50) queue.push(next);
        }
      } catch (error) {
        entry.error = refusedRedirect
          ? 'Redirect refused before following target; provide the final canonical URL'
          : error.message;
        if (outDir && !entry.screenshot && safeToScreenshot) {
          try {
            entry.screenshot = 'discovery-page-' + report.pages.length + '.png';
            await page.screenshot({ path: path.join(outDir, entry.screenshot) });
          } catch (screenshotError) { entry.screenshotError = screenshotError.message; }
        }
      }
      if (report.pages.length === 1 && entry.error) {
        throw new Error('Discovery failed: ' + entry.error + (outDir ? '. See ' + path.join(outDir, 'discovery-report.json') : ''));
      }
    }
    if (!plans.length) throw new Error('No eligible visible elements found across discovered pages');
    report.status = 'completed';
    report.planCount = plans.length;
    return { plan: plans[0], plans, report };
  } catch (error) {
    report.status = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
    report.error = report.status === 'cancelled' ? 'Cancelled by operator' : error.message;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    report.finishedAt = new Date().toISOString();
    if (outDir) await writeFile(path.join(outDir, 'discovery-report.json'), JSON.stringify(report, null, 2));
    await context?.close().catch(() => {});
    await browser?.close();
  }
}

// Backward-compatible API consumed by the existing E2E tests.
export async function discover(url, options = {}) {
  return (await explore(url, options)).plan;
}
