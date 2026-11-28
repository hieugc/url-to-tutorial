import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { Plan, validatePlanForExecution } from '../src/plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (script, args, cwd = root) => spawnSync(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', timeout: 30_000,
});
const plop = path.join(root, 'node_modules/plop/bin/plop.js');

test('generated schemas reflect input defaults and parsed output requirements', async () => {
  for (const [io, stem] of [['input', 'tutorial-plan.input'], ['output', 'tutorial-plan']]) {
    const schema = JSON.parse(await readFile(path.join(root, 'schemas', stem + '.schema.json')));
    const { title, description, ...structure } = schema;
    assert.deepEqual(structure, z.toJSONSchema(Plan, { io, target: 'draft-7' }));
    assert.equal(schema.required.includes('language'), io === 'output');
    assert.equal(schema.properties.steps.items.required.includes('reviewed'), io === 'output');
  }
  const plan = JSON.parse(await readFile(path.join(root, 'examples/demo.plan.json')));
  assert.ok(Plan.safeParse(plan).success);
  assert.equal(Plan.safeParse({ ...plan, url: 'https://user:secret@example.com' }).success, false);
  assert.equal(Plan.safeParse({ ...plan, viewport: { width: 1279, height: 720 } }).success, false);
  const click = Plan.parse({ ...plan, steps: [{
    id: 'click', title: 'Click', description: '', action: 'click', target: { css: '#button' },
  }] });
  assert.equal(validatePlanForExecution(click).length, 1);
});

test('codegen check fails for stale files without rewriting them', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'tutorial-codegen-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const item of ['scripts', 'src', 'schemas', 'types']) {
    await cp(path.join(root, item), path.join(temp, item), { recursive: true });
  }
  await symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  const script = path.join(temp, 'scripts/codegen.mjs');
  const generated = path.join(temp, 'schemas/tutorial-plan.schema.json');
  const clean = run(script, ['--check'], temp);
  assert.equal(clean.status, 0, clean.stderr);
  await writeFile(generated, '{}\n');
  const stale = run(script, ['--check'], temp);
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /stale/);
  assert.equal(await readFile(generated, 'utf8'), '{}\n');
  assert.equal(run(script, [], temp).status, 0);
  assert.equal(run(script, ['--check'], temp).status, 0);
});

test('adapter generator produces runnable tests and refuses unsafe names or overwrites', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'tutorial-plop-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, 'src'), { recursive: true });
  await cp(path.join(root, 'src/plan.mjs'), path.join(temp, 'src/plan.mjs'));
  await symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  const args = ['--plopfile', path.join(root, 'plopfile.mjs'), '--dest', temp, 'adapter'];
  const generated = run(plop, [...args, 'sample-site']);
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const adapterPath = path.join(temp, 'src/adapters/sample-site.mjs');
  const original = await readFile(adapterPath, 'utf8');
  const tests = run('--test', [path.join(temp, 'test/sample-site.test.mjs')], temp);
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  const repeated = run(plop, [...args, 'sample-site', '--force']);
  assert.notEqual(repeated.status, 0);
  assert.equal(await readFile(adapterPath, 'utf8'), original);
  const unsafe = run(plop, [...args, '../escape']);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stdout + unsafe.stderr, /kebab-case/);
});
