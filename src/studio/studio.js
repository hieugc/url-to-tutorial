const $ = id => document.getElementById(id);
const state = { plan: null, selected: 0, discoveryJobId: null, pages: 0, ready: false, busy: false };
const ACTIONS = new Set(['click', 'fill', 'navigate']);
const toastEl = $('toast');
let toastTimeout;

function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast visible' + (error ? ' error' : '');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toastEl.className = 'toast'; }, 4500);
}

async function api(route, body) {
  const response = await fetch(route, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Unexpected response from local Studio server'); }
  if (!response.ok) {
    const messages = data.reviewIssues || data.errors?.map(x => x.message);
    throw new Error([data.error || 'Request failed', ...(messages || [])].join('\n'));
  }
  return data;
}

function switchBusy(busy) {
  state.busy = busy;
  $('discover').disabled = busy;
  $('hostinger-guide').disabled = busy;
  $('import').disabled = busy;
  $('add').disabled = busy || !state.plan;
  $('validate').disabled = busy || !state.plan;
  $('preview').disabled = busy || !state.ready;
  $('render').disabled = busy || !state.ready;
}

function invalidate() {
  state.ready = false;
  $('preview').disabled = true;
  $('render').disabled = true;
  $('change-state').textContent = 'Unsaved / needs validation';
  $('readiness').className = 'readiness';
  $('readiness').textContent = 'Validate after editing';
  $('issues').replaceChildren();
  if (state.plan) $('json-text').value = JSON.stringify(state.plan, null, 2);
}

function updateMeta() {
  if (!state.plan) return;
  $('project-heading').textContent = state.plan.title || '(untitled)';
  $('plan-title').value = state.plan.title || '';
  $('info-language').textContent = state.plan.language || 'vi';
  $('info-viewport').textContent = (state.plan.viewport?.width || 1280) + ' × ' + (state.plan.viewport?.height || 720);
  $('info-pages').textContent = String(state.pages);
  $('count').textContent = String(state.plan.steps.length);
  $('json-text').value = JSON.stringify(state.plan, null, 2);
}

function makeButton(text, label, handler, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', handler);
  return button;
}

function renderSteps() {
  const list = $('steps');
  list.replaceChildren();
  if (!state.plan) return;
  state.plan.steps.forEach((step, index) => {
    const item = document.createElement('li');
    item.className = 'step-row' + (index === state.selected ? ' active' : '');
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'step-choose';
    choose.setAttribute('aria-current', index === state.selected ? 'step' : 'false');
    choose.addEventListener('click', () => {
      if (index !== state.selected && !commitStep()) return;
      state.selected = index;
      renderSteps();
      renderSelected();
    });
    const n = document.createElement('span');
    n.className = 'step-n';
    n.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'step-copy';
    const title = document.createElement('strong');
    title.textContent = step.title || '(untitled)';
    const meta = document.createElement('small');
    meta.textContent = (step.action || 'highlight').toUpperCase() + ' · ' +
      ((step.holdMs || 3000) / 1000) + 's' +
      (ACTIONS.has(step.action) ? (step.reviewed ? ' · reviewed' : ' · review needed') : '');
    copy.append(title, meta);
    choose.append(n, copy);
    const controls = document.createElement('div');
    controls.className = 'step-controls';
    controls.append(
      makeButton('↑', 'Move ' + step.id + ' up', () => moveStep(index, -1), index === 0),
      makeButton('↓', 'Move ' + step.id + ' down', () => moveStep(index, 1), index === state.plan.steps.length - 1),
      makeButton('×', 'Delete ' + step.id, () => deleteStep(index), state.plan.steps.length <= 1),
    );
    item.append(choose, controls);
    list.append(item);
  });
  $('count').textContent = String(state.plan.steps.length);
}

function selectValue(id, value) {
  $(id).value = value ?? '';
}
function currentTarget() {
  const step = state.plan.steps[state.selected];
  if (step.target?.css) return { type: 'css', css: step.target.css };
  if (step.target?.role) return { type: 'role', role: step.target.role, name: step.target.name };
  return { type: 'none' };
}
function actionFields() {
  const action = $('step-action').value;
  $('fill-field').hidden = action !== 'fill';
  $('navigate-field').hidden = action !== 'navigate';
  $('branch-fields').hidden = action !== 'branch';
  $('expected-field').hidden = action === 'branch' || action === 'stop';
  $('approval-box').hidden = !ACTIONS.has(action);
  $('next-id').disabled = action === 'branch' || action === 'stop';
}
function targetFields() {
  const type = $('target-type').value;
  $('css-field').hidden = type !== 'css';
  $('role-field').hidden = type !== 'role';
  $('name-field').hidden = type !== 'role';
}

function renderSelected() {
  const step = state.plan?.steps[state.selected];
  $('empty-editor').hidden = Boolean(step);
  $('step-form').hidden = !step;
  if (!step) return;
  $('step-position').textContent = 'STEP ' + (state.selected + 1) + ' / ' + state.plan.steps.length;
  selectValue('step-id', step.id);
  selectValue('step-action', step.action || 'highlight');
  selectValue('step-title', step.title);
  selectValue('step-description', step.description);
  selectValue('hold-ms', step.holdMs ?? 3000);
  selectValue('next-id', step.next);
  const target = currentTarget();
  selectValue('target-type', target.type);
  selectValue('target-css', target.css);
  selectValue('target-role', target.role || 'heading');
  selectValue('target-name', target.name);
  selectValue('fill-value', step.value);
  selectValue('navigate-url', step.url);
  selectValue('expected', step.expected?.css);
  selectValue('condition-css', step.condition?.target?.css);
  selectValue('condition-state', step.condition?.state || 'visible');
  selectValue('on-true', step.onTrue);
  selectValue('on-false', step.onFalse);
  $('reviewed').checked = Boolean(step.reviewed);
  targetFields();
  actionFields();
}

function commitStep(showToast = false) {
  if (!state.plan || $('step-form').hidden) return true;
  const form = $('step-form');
  if (!form.reportValidity()) return false;
  const old = state.plan.steps[state.selected];
  if (!old) return true;
  const action = $('step-action').value;
  const next = {
    id: old.id,
    title: $('step-title').value.trim(),
    description: $('step-description').value,
    action,
    holdMs: Number($('hold-ms').value || 3000),
    reviewed: ACTIONS.has(action) && $('reviewed').checked,
  };
  const targetType = $('target-type').value;
  if (targetType === 'css' && $('target-css').value.trim()) {
    next.target = { css: $('target-css').value.trim() };
  }
  if (targetType === 'role' && $('target-name').value.trim()) {
    next.target = { role: $('target-role').value, name: $('target-name').value.trim() };
  }
  if (action === 'fill') next.value = $('fill-value').value;
  if (action === 'navigate' && $('navigate-url').value.trim()) next.url = $('navigate-url').value.trim();
  if (action === 'branch') {
    next.condition = { target: { css: $('condition-css').value.trim() },
      state: $('condition-state').value };
    next.onTrue = $('on-true').value.trim();
    next.onFalse = $('on-false').value.trim();
  } else if (action !== 'stop' && $('next-id').value.trim()) {
    next.next = $('next-id').value.trim();
  }
  if (!['branch', 'stop'].includes(action) && $('expected').value.trim()) {
    next.expected = { css: $('expected').value.trim() };
  }
  const before = JSON.stringify(old);
  state.plan.steps[state.selected] = next;
  if (JSON.stringify(next) !== before) invalidate();
  renderSteps();
  updateMeta();
  if (showToast) toast('Step saved. Validate before preview or render.');
  return true;
}

function moveStep(index, dir) {
  if (!commitStep()) return;
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= state.plan.steps.length) return;
  const steps = state.plan.steps;
  [steps[index], steps[newIndex]] = [steps[newIndex], steps[index]];
  state.selected = state.selected === index ? newIndex :
    state.selected === newIndex ? index : state.selected;
  invalidate();
  renderSteps();
  renderSelected();
}

function deleteStep(index) {
  if (state.plan.steps.length <= 1 || !window.confirm('Delete this step?')) return;
  state.plan.steps.splice(index, 1);
  state.selected = Math.min(state.selected, state.plan.steps.length - 1);
  invalidate();
  updateMeta();
  renderSteps();
  renderSelected();
}

function loadPlan(plan, options = {}) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('Plan must contain a non-empty steps array');
  }
  state.plan = structuredClone(plan);
  state.selected = 0;
  if (options.discoveryJobId !== undefined) state.discoveryJobId = options.discoveryJobId;
  if (options.pages !== undefined) state.pages = options.pages;
  $('plan-title').disabled = false;
  $('export').disabled = false;
  $('add').disabled = false;
  $('validate').disabled = false;
  $('step-note').textContent = 'Sử dụng mũi tên để thay đổi thứ tự. Nhấn Save step trước khi chuyển bước.';
  invalidate();
  updateMeta();
  renderSteps();
  renderSelected();
}

function addStep() {
  if (!commitStep()) return;
  const id = 'step-' + crypto.randomUUID().slice(0, 8);
  const step = { id, title: 'New step', description: 'Describe this step', target: { css: 'body' },
    action: 'highlight', holdMs: 2500 };
  const endIndex = state.plan.steps.findIndex(s => s.action === 'stop');
  const index = endIndex >= 0 ? endIndex : state.plan.steps.length;
  state.plan.steps.splice(index, 0, step);
  state.selected = index;
  invalidate();
  updateMeta();
  renderSteps();
  renderSelected();
}

function updateValidation(data) {
  const list = $('issues');
  list.replaceChildren();
  const issues = [...(data.errors || []).map(x => (x.path ? x.path + ': ' : '') + x.message),
    ...(data.reviewIssues || [])];
  for (const message of issues) {
    const item = document.createElement('li');
    item.textContent = message;
    list.append(item);
  }
  state.ready = Boolean(data.ready);
  $('readiness').className = 'readiness ' + (data.ready ? 'ok' : 'bad');
  $('readiness').textContent = data.ready ? '✓ Ready to preview / render' :
    data.valid ? 'Review required · ' + issues.length + ' items' : 'Invalid plan · ' + issues.length + ' items';
  $('preview').disabled = state.busy || !state.ready;
  $('render').disabled = state.busy || !state.ready;
  $('change-state').textContent = data.ready ? 'Validated' : 'Needs corrections';
}

async function validate() {
  if (!commitStep()) return;
  switchBusy(true);
  try {
    const response = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: state.plan }),
    });
    const result = await response.json();
    // A structurally invalid plan returns 422, but its detailed errors must
    // remain visible inside the editor instead of being collapsed into a toast.
    if (response.status !== 200 && response.status !== 422) {
      throw new Error(result.error || 'Validation service unavailable');
    }
    updateValidation(result);
    toast(result.ready ? 'Plan is valid and reviewed' : 'Correct the listed validation issues');
  } catch (error) {
    state.ready = false;
    $('readiness').textContent = error.message;
    $('readiness').className = 'readiness bad';
    toast(error.message, true);
  } finally { switchBusy(false); }
}

function showJob(title, detail) {
  $('output').hidden = false;
  $('output-title').textContent = title;
  $('output-detail').textContent = detail;
  $('download').hidden = true;
}
async function awaitJob(jobId, title) {
  for (let attempt = 0; attempt < 480; attempt++) {
    const result = await api('/api/jobs/' + encodeURIComponent(jobId));
    const done = result.report?.steps?.filter(step => step.status === 'completed').length || 0;
    showJob(title + ' · ' + result.status, result.status === 'running' ?
      (done ? done + ' completed steps' : 'Opening Chromium / preparing output') : 'Job ' + jobId);
    if (result.status === 'failed') throw new Error(result.error || 'Job failed');
    if (result.status === 'completed') return result;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error('UI polling expired. The backend job may still be running.');
}

async function discover(event) {
  event.preventDefault();
  switchBusy(true);
  try {
    const url = $('url').value.trim();
    const maxPages = Number($('pages').value);
    const job = await api('/api/discover', { url, language: $('language').value, maxPages });
    const result = await awaitJob(job.jobId, 'Exploring website');
    const found = result.discovery;
    if (!found?.plan) throw new Error('Discovery returned no plan');
    const pageCount = found.plans?.length || 1;
    loadPlan(found.plan, { discoveryJobId: job.jobId, pages: pageCount });
    $('assemble').hidden = pageCount < 2;
    const screenshot = found.report?.pages?.[0]?.screenshot;
    $('preview-figure').hidden = !screenshot;
    if (screenshot) $('site-screenshot').src = '/api/jobs/' + job.jobId + '/screenshot/1';
    showJob('Discovery completed', pageCount + ' page plan(s). Edit and validate the tutorial.');
    toast('Website discovered: ' + pageCount + ' page(s)');
  } catch (error) {
    toast(error.message, true);
    showJob('Discovery failed', error.message);
  } finally { switchBusy(false); }
}

async function hostingerGuide() {
  const url = $('url').value.trim();
  if (!url) return toast('Enter a Hostinger Vietnam URL first', true);
  switchBusy(true);
  try {
    const job = await api('/api/hostinger', { url, language: $('language').value });
    const result = await awaitJob(job.jobId, 'Reading Hostinger pricing');
    if (!result.hostinger?.plan) throw new Error('No observed pricing plan available');
    const data = result.hostinger;
    loadPlan(data.plan, { discoveryJobId: null, pages: 1 });
    $('assemble').hidden = true;
    const screenshot = data.report?.screenshot;
    $('preview-figure').hidden = !screenshot;
    if (screenshot) $('site-screenshot').src = '/api/jobs/' + job.jobId + '/hostinger-screenshot';
    const warning = data.report?.warnings?.join(' | ') || 'Review current pricing and terms before publishing';
    showJob('Hostinger pricing captured', data.evidence.cards.length + ' verified plan(s). ' + warning);
    toast('Read-only Hostinger plan created from observed DOM. Validate before rendering.');
  } catch (error) {
    toast(error.message, true);
    showJob('Hostinger adapter failed', error.message);
  } finally {
    switchBusy(false);
  }
}

async function assemble() {
  if (!state.discoveryJobId) return;
  if (!commitStep()) return;
  switchBusy(true);
  try {
    const data = await api('/api/assemble', { discoveryJobId: state.discoveryJobId });
    loadPlan(data.plan);
    $('assemble').hidden = true;
    toast('Multi-page plan assembled. Review each navigate step before running.');
  } catch (error) { toast(error.message, true); }
  finally { switchBusy(false); }
}

async function execute(type) {
  if (!commitStep()) return;
  if (!state.ready) return toast('Validate before execution', true);
  const actionable = state.plan.steps.some(s => ACTIONS.has(s.action));
  if (actionable && !window.confirm('This will execute reviewed click/fill/navigate actions on the REAL target website. Continue?')) return;
  switchBusy(true);
  try {
    const job = await api('/api/' + type, {
      plan: state.plan,
      confirmedExecution: actionable,
    });
    const result = await awaitJob(job.jobId, type === 'render' ? 'Rendering MP4' : 'Previewing walkthrough');
    showJob(type === 'render' ? 'MP4 ready' : 'Preview finished',
      result.report?.video ? Math.round(result.report.video.duration) + 's · H.264 · no audio' : 'Completed');
    if (result.videoUrl) {
      $('download').href = result.videoUrl;
      $('download').hidden = false;
    }
    toast(type === 'render' ? 'Video completed' : 'Preview completed');
  } catch (error) { toast(error.message, true); showJob('Job failed', error.message); }
  finally { switchBusy(false); }
}

$('discover-form').addEventListener('submit', discover);
$('hostinger-guide').addEventListener('click', hostingerGuide);
$('step-form').addEventListener('submit', event => { event.preventDefault(); commitStep(true); });
$('target-type').addEventListener('change', targetFields);
$('step-action').addEventListener('change', actionFields);
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 512 * 1024) throw new Error('Plan JSON exceeds 512 KB');
    loadPlan(JSON.parse(await file.text()), { discoveryJobId: null, pages: 0 });
    $('assemble').hidden = true;
    $('preview-figure').hidden = true;
    toast('Imported JSON. Validate the plan.');
  } catch (error) { toast(error.message, true); }
  event.target.value = '';
});
$('export').addEventListener('click', () => {
  if (!commitStep()) return;
  const data = new Blob([JSON.stringify(state.plan, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = href;
  link.download = 'tutorial.plan.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});
$('add').addEventListener('click', addStep);
$('validate').addEventListener('click', validate);
$('preview').addEventListener('click', () => execute('preview'));
$('render').addEventListener('click', () => execute('render'));
$('assemble').addEventListener('click', assemble);
$('plan-title').addEventListener('change', event => {
  if (!state.plan) return;
  state.plan.title = event.target.value.trim();
  invalidate(); updateMeta();
});
$('apply-json').addEventListener('click', () => {
  try {
    const parsed = JSON.parse($('json-text').value);
    loadPlan(parsed);
    toast('Applied JSON. Validate before running.');
  } catch (error) { toast('Invalid JSON: ' + error.message, true); }
});
