import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { HttpUrl, Plan } from './plan.mjs';
import { safePageLink } from './discover.mjs';

/**
 * Convert read-only discovery plans into one cross-page walkthrough.
 * Navigation steps remain unreviewed until a person explicitly approves them.
 */
export function assemblePages(report, pagePlans) {
  if (report?.status !== 'completed') throw new Error('Discovery report must have status "completed"');
  if (!Array.isArray(report.pages) || !Array.isArray(pagePlans)) throw new Error('Discovery report and page plans are required');

  const origin = new URL(HttpUrl.parse(report.entryUrl)).origin;
  const planByUrl = new Map(pagePlans.map(plan => [plan.url, Plan.parse(plan)]));
  const pages = report.pages.filter(page => page.finalUrl && !page.error && page.candidateCount > 0);
  if (pages.length < 2) throw new Error('At least two successfully discovered pages are required to assemble a multi-page tutorial');

  const steps = [];
  for (const [index, page] of pages.entries()) {
    HttpUrl.parse(page.finalUrl);
    if (new URL(page.finalUrl).origin !== origin) throw new Error('Cross-origin pages cannot be assembled');
    const pagePlan = planByUrl.get(page.finalUrl);
    if (!pagePlan) throw new Error('Missing page plan for discovered URL: ' + page.finalUrl);
    if (pagePlan.steps.some(step => step.action !== 'highlight')) {
      throw new Error('Only read-only discovery plans can be assembled automatically');
    }

    if (index > 0) {
      const safeUrl = safePageLink(page.finalUrl, report.entryUrl, origin);
      if (!safeUrl) throw new Error('A discovered page is not eligible for safe same-origin navigation: ' + page.finalUrl);
      steps.push({
        id: 'navigate-page-' + (index + 1),
        title: 'Chuyển đến: ' + (pagePlan.title || page.title || 'Trang tiếp theo'),
        description: 'Mở trang cùng website đã được khám phá. Kiểm tra URL và nội dung trước khi duyệt bước chuyển trang này.',
        action: 'navigate',
        url: safeUrl,
        reviewed: false,
        holdMs: 1200,
      });
    }

    for (const step of pagePlan.steps) {
      steps.push({ ...step, id: 'page-' + (index + 1) + '-' + step.id });
    }
  }

  steps.push({
    id: 'finish',
    title: 'Kết thúc hướng dẫn',
    description: 'Đã hoàn tất các trang trong hướng dẫn. Không có giao dịch hoặc thay đổi dữ liệu nào được thực hiện tự động.',
    action: 'stop',
    holdMs: 2500,
  });

  return Plan.parse({
    schemaVersion: 1,
    title: 'Hướng dẫn nhiều trang — ' + (pages[0].title || 'Website'),
    url: pages[0].finalUrl,
    language: pagePlans[0].language || 'vi',
    mode: 'task',
    viewport: pagePlans[0].viewport || { width: 1280, height: 720 },
    steps,
  });
}

export async function assembleDiscovery(discoveryDir) {
  const root = path.resolve(discoveryDir);
  const report = JSON.parse(await readFile(path.join(root, 'discovery-report.json'), 'utf8'));
  const pagesDir = path.join(root, 'pages');
  const names = (await readdir(pagesDir))
    .filter(name => /^page-\d+\.plan\.json$/.test(name))
    .sort((a, b) => Number(a.match(/page-(\d+)/)[1]) - Number(b.match(/page-(\d+)/)[1]));
  const pagePlans = await Promise.all(names.map(async name =>
    JSON.parse(await readFile(path.join(pagesDir, name), 'utf8'))
  ));
  return assemblePages(report, pagePlans);
}
