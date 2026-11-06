import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createStudioServer } from '../../src/studio-server.mjs';

// Real HTTP server + SQLite in a killable process. Only the external browser
// work is replaced; its observable start is recorded so replay is detectable.
const root = process.argv[2];
const { server } = createStudioServer({
  outputRoot: root,
  renderImpl: async (_plan, { signal }) => {
    await appendFile(path.join(root, 'executions.txt'), 'render started\n');
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(
        Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
      ), { once: true });
    });
  },
  exploreImpl: async () => {
    await appendFile(path.join(root, 'executions.txt'), 'discover started\n');
    return { report: { pages: [] }, plans: [] };
  },
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
