import { z } from 'zod';

export const HttpUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Only HTTP(S) URLs without credentials are supported');

const Locator = z.union([
  z.object({ css: z.string().min(1) }).strict(),
  z.object({ role: z.enum(['heading', 'button', 'link', 'textbox', 'combobox']), name: z.string().min(1) }).strict(),
]);
const FrameTarget = z.object({
  frame: z.object({ css: z.string().min(1) }).strict(),
  target: Locator,
}).strict();
const Target = z.union([Locator, FrameTarget]);
const BranchCondition = z.object({
  target: Target,
  state: z.enum(['visible', 'hidden']).default('visible'),
}).strict();

const Step = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  description: z.string().max(1200),
  target: Target.optional(),
  action: z.enum(['highlight', 'click', 'fill', 'navigate', 'branch', 'stop']).default('highlight'),
  value: z.string().max(2000).optional(),
  url: HttpUrl.optional(),
  holdMs: z.number().int().min(500).max(30000).default(3000),
  // Approval is checked at execution time so generated plans can remain drafts.
  reviewed: z.boolean().default(false),
  expected: Target.optional(),
  condition: BranchCondition.optional(),
  onTrue: z.string().min(1).optional(),
  onFalse: z.string().min(1).optional(),
  next: z.string().min(1).optional(),
}).strict().superRefine((s, ctx) => {
  if (['highlight', 'click', 'fill'].includes(s.action) && !s.target)
    ctx.addIssue({ code: 'custom', message: s.action + ' requires target' });
  if (s.action === 'navigate' && !s.url)
    ctx.addIssue({ code: 'custom', message: 'navigate requires url' });
  if (s.action === 'fill' && s.value === undefined)
    ctx.addIssue({ code: 'custom', message: 'fill requires value' });

  if (s.action === 'branch') {
    if (!s.condition) ctx.addIssue({ code: 'custom', message: 'branch requires condition' });
    if (!s.onTrue) ctx.addIssue({ code: 'custom', message: 'branch requires onTrue step id' });
    if (!s.onFalse) ctx.addIssue({ code: 'custom', message: 'branch requires onFalse step id' });
    if (s.next) ctx.addIssue({ code: 'custom', message: 'branch uses onTrue/onFalse, not next' });
    if (s.url || s.value !== undefined) ctx.addIssue({ code: 'custom', message: 'branch cannot navigate or fill' });
  } else if (s.condition || s.onTrue || s.onFalse) {
    ctx.addIssue({ code: 'custom', message: 'condition/onTrue/onFalse are only valid on branch steps' });
  }
  if (s.action === 'stop' && s.next)
    ctx.addIssue({ code: 'custom', message: 'stop cannot have a next step' });
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
  // Locally supplied selectors to hide sensitive page fragments before video
  // recording. These are NEVER generated automatically by an LLM.
  redactSelectors: z.array(z.string().min(1).max(200)).max(20).optional(),
}).strict().superRefine((p, ctx) => {
  const ids = p.steps.map(s => s.id);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: 'custom', message: 'Step ids must be unique' });

  const stop = p.steps.findIndex(s => s.action === 'stop');
  if (stop !== -1 && stop !== p.steps.length - 1)
    ctx.addIssue({ code: 'custom', message: 'stop must be the final step' });

  const indexById = new Map(ids.map((id, index) => [id, index]));
  const edges = p.steps.map((step, index) => {
    const refs = step.action === 'branch'
      ? [step.onTrue, step.onFalse].filter(Boolean)
      : step.next ? [step.next]
        : step.action === 'stop' || index === p.steps.length - 1 ? []
          : [p.steps[index + 1].id];
    for (const ref of refs) {
      if (!indexById.has(ref)) {
        ctx.addIssue({ code: 'custom', message: 'Step "' + step.id + '" references missing step "' + ref + '"' });
      } else if (indexById.get(ref) <= index) {
        ctx.addIssue({ code: 'custom', message: 'Workflow edges must move forward: "' + step.id + '" → "' + ref + '"' });
      }
    }
    return refs;
  });

  // Forward-only edges prevent accidental infinite loops and make the plan deterministic.
  const reachable = new Set();
  const visit = id => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const index = indexById.get(id);
    if (index === undefined) return;
    for (const nextId of edges[index]) visit(nextId);
  };
  if (ids.length) visit(ids[0]);
  for (const id of ids) {
    if (!reachable.has(id)) ctx.addIssue({ code: 'custom', message: 'Unreachable step: "' + id + '"' });
  }
});

export function validatePlanForExecution(plan) {
  const issues = [];
  for (const step of plan.steps) {
    if (['click', 'fill', 'navigate'].includes(step.action) && !step.reviewed) {
      issues.push('Step "' + step.id + '" (' + step.action + ') must be reviewed before execution');
    }
  }
  return issues;
}

export function locate(page, target) {
  const root = target.frame ? page.frameLocator(target.frame.css) : page;
  const locator = target.frame ? target.target : target;
  return locator.css ? root.locator(locator.css) :
    root.getByRole(locator.role, { name: locator.name, exact: true });
}

export async function uniqueTarget(page, target) {
  if (target.frame) {
    const frames = page.locator(target.frame.css);
    const frameCount = await frames.count();
    if (frameCount !== 1) {
      throw new Error('Iframe selector must match exactly one frame (' + frameCount + ' matches): ' + target.frame.css);
    }
    if (!await frames.isVisible()) throw new Error('Target iframe is not visible: ' + target.frame.css);
  }
  const locator = locate(page, target);
  await locator.first().waitFor({ state: 'visible', timeout: 10000 });
  const count = await locator.count();
  if (count !== 1) throw new Error('Ambiguous target (' + count + ' matches): ' + JSON.stringify(target));
  return locator;
}

export async function evaluateCondition(page, condition) {
  const locator = locate(page, condition.target);
  const count = await locator.count();
  if (count > 1) throw new Error('Ambiguous branch condition (' + count + ' matches): ' + JSON.stringify(condition.target));
  const visible = count === 1 && await locator.isVisible();
  return condition.state === 'visible' ? visible : !visible;
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
