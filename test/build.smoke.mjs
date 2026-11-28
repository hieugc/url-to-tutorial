import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('compiled CLI validates the bundled demo and rejects invalid plans', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'tutorial-build-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cli = path.join(root, 'dist/src/cli.mjs');
  const valid = spawnSync(process.execPath, [cli, 'validate', path.join(root, 'dist/examples/demo.plan.json')], {
    cwd: temp, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const invalidPath = path.join(temp, 'invalid.plan.json');
  const invalidPlan = JSON.parse(await readFile(path.join(root, 'dist/examples/demo.plan.json')));
  invalidPlan.url = 'file:///etc/passwd';
  await writeFile(invalidPath, JSON.stringify(invalidPlan));
  const invalid = spawnSync(process.execPath, [cli, 'validate', invalidPath], {
    cwd: temp, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout + invalid.stderr, /HTTP\(S\)/);
});

test('compiled Studio serves HTML, compiled JS and CSS with usable module paths', async t => {
  const { createStudioServer } = await import('../dist/src/studio-server.mjs');
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'tutorial-build-studio-'));
  const { server } = createStudioServer({ outputRoot });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(outputRoot, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [route, filename, type] of [
    ['/', 'index.html', 'text/html'],
    ['/studio.js', 'studio.js', 'text/javascript'],
    ['/studio.css', 'studio.css', 'text/css'],
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(await response.text(), await readFile(path.join(root, 'dist/src/studio', filename), 'utf8'));
  }
});
