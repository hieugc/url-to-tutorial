import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
async function modules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? modules(path.join(directory, entry.name))
    : entry.name.endsWith('.mjs') ? [path.join(directory, entry.name)] : []))).flat();
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
// Preserve module boundaries, import.meta.url, worker paths and Playwright's
// serializable page.evaluate callbacks. Runtime packages stay external.
await build({
  absWorkingDir: root,
  entryPoints: await modules(path.join(root, 'src')),
  outbase: 'src', outdir: 'dist/src', outExtension: { '.js': '.mjs' },
  bundle: false, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: true, minify: false,
});
await build({
  absWorkingDir: root,
  entryPoints: ['src/studio/studio.js', 'src/studio/studio.css'],
  outdir: 'dist/src/studio', bundle: true, platform: 'browser',
  target: 'es2022', minify: true,
});
await cp(path.join(root, 'src/studio/index.html'), path.join(dist, 'src/studio/index.html'));
for (const item of ['examples', 'migrations', 'schemas', 'types', 'package.json', 'package-lock.json']) {
  await cp(path.join(root, item), path.join(dist, item), { recursive: true });
}
await writeFile(path.join(dist, 'README.md'), `# url-to-tutorial runtime build

Requires Node.js 22+, FFmpeg, and Chromium (plus espeak-ng for narration).
Install runtime dependencies here with \`npm ci --omit=dev\`, then
\`npx playwright install chromium\`.

Run \`npm run studio\`, \`npm run tutorial -- validate examples/demo.plan.json\`,
or \`npm run demo\`. Development/generation scripts run from the source checkout.
`);
console.log('Built Node modules, Studio assets and runtime resources in dist/');
