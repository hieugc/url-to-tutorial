import { z } from 'zod';

export const HttpUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Only HTTP(S) URLs without credentials are supported');

const Locator = z.union([
  z.object({ css: z.string().min(1) }).strict(),
  z.object({ role: z.enum(['heading', 'button', 'link', 'textbox', 'combobox']), name: z.string().min(1) }).strict(),
]);
const Step = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  description: z.string().max(1200),
  target: Locator.optional(),
  action: z.enum(['highlight', 'click', 'fill', 'navigate', 'stop']).default('highlight'),
  value: z.string().max(2000).optional(),
  url: HttpUrl.optional(),
  holdMs: z.number().int().min(500).max(30000).default(3000),
  // This is deliberate per-step review, not an inferred AI permission.
  reviewed: z.boolean().default(false),
  expected: Locator.optional(),
}).strict().superRefine((s, ctx) => {
  if (['highlight', 'click', 'fill'].includes(s.action) && !s.target)
    ctx.addIssue({ code: 'custom', message: `${s.action} requires target` });
  if (s.action === 'navigate' && !s.url)
    ctx.addIssue({ code: 'custom', message: 'navigate requires url' });
  if (s.action === 'fill' && s.value === undefined)
    ctx.addIssue({ code: 'custom', message: 'fill requires value' });
  if (['click', 'fill', 'navigate'].includes(s.action) && !s.reviewed)
    ctx.addIssue({ code: 'custom', message: 'Action steps must be reviewed explicitly' });
});

export const Plan = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  url: HttpUrl,
  language: z.enum(['vi', 'en']).default('vi'),
  mode: z.enum(['overview', 'task']).default('overview'),
  viewport: z.object({
    width: z.number().int().min(640).max(1920).refine(n => n % 2 === 0),
    height: z.number().int().min(360).max(1080).refine(n => n % 2 === 0),
  }).default({ width: 1280, height: 720 }),
  steps: z.array(Step).min(1).max(50),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.steps.map(s => s.id)).size !== p.steps.length)
    ctx.addIssue({ code: 'custom', message: 'Step ids must be unique' });
  const stop = p.steps.findIndex(s => s.action === 'stop');
  if (stop !== -1 && stop !== p.steps.length - 1)
    ctx.addIssue({ code: 'custom', message: 'stop must be the final step' });
});

export function locate(page, target) {
  return target.css ? page.locator(target.css) : page.getByRole(target.role, { name: target.name, exact: true });
}

export async function uniqueTarget(page, target) {
  const locator = locate(page, target);
  await locator.first().waitFor({ state: 'visible', timeout: 10000 });
  const count = await locator.count();
  if (count !== 1) throw new Error(`Ambiguous target (${count} matches): ${JSON.stringify(target)}`);
  return locator;
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
