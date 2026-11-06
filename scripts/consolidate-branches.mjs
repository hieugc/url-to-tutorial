import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export function consolidateBranches(manifest, { apply = false, cwd = process.cwd() } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const branches = Object.entries(manifest);
  for (const [branch, sha] of branches) {
    if (!branch.startsWith('feat/') || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid audited branch');
    git('check-ref-format', 'refs/heads/' + branch);
  }
  // Read exact remote heads and fetch main; an audited head must be reachable
  // from the actual remote main before deletion, not merely a local candidate.
  git('fetch', 'origin', 'main');
  const refs = new Map(git('ls-remote', '--heads', 'origin').split('\n')
    .filter(Boolean).map(line => { const [sha, ref] = line.split('\t'); return [ref, sha]; }));
  const pending = branches.filter(([branch, sha]) => {
    const ref = 'refs/heads/' + branch;
    if (!refs.has(ref)) return false;
    if (refs.get(ref) !== sha) throw new Error('Branch changed since audit; keep ' + branch);
    try { git('merge-base', '--is-ancestor', sha, 'FETCH_HEAD'); }
    catch { throw new Error('Branch history is not in remote main; keep ' + branch); }
    return true;
  });
  if (apply && pending.length) {
    // Atomic deletion + exact leases also reject changes made after ls-remote.
    git('push', '--atomic', ...pending.map(([branch, sha]) =>
      '--force-with-lease=refs/heads/' + branch + ':' + sha), 'origin',
    ...pending.map(([branch]) => ':refs/heads/' + branch));
  }
  return { applied: apply, branches: pending.map(([branch]) => branch) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const manifestPath = fileURLToPath(new URL('../docs/branch-consolidation.json', import.meta.url));
  console.log(JSON.stringify(consolidateBranches(JSON.parse(readFileSync(manifestPath, 'utf8')), {
    apply: process.argv.includes('--apply'),
  }), null, 2));
}
