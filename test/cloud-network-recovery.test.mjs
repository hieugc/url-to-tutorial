import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOrphanedCloudNetworks } from '../src/cloud-worker-adapter.mjs';

const orphanId = '11111111-1111-4111-8111-111111111111';
const activeId = '22222222-2222-4222-8222-222222222222';
const workerId = '33333333-3333-4333-8333-333333333333';

function network(id, containers = {}) {
  return {
    Name: 'utv-job-' + id,
    Driver: 'bridge',
    Internal: true,
    Labels: { app: 'url-to-tutorial', 'tutorial.job-id': id },
    Containers: containers,
  };
}

function fakeDocker(networks) {
  const calls = [];
  return {
    calls,
    async run(_dockerBin, args) {
      calls.push(args);
      if (args[0] === 'network' && args[1] === 'ls') {
        return { stdout: networks.map(item => item.Name).join('\n') + '\n' };
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        const item = networks.find(value => value.Name === args[2]);
        return { stdout: JSON.stringify([item]) };
      }
      if (args[0] === 'network' && args[1] === 'disconnect') {
        const item = networks.find(value => value.Name === args[4]);
        if (item) item.Containers = {};
        return { stdout: '' };
      }
      if (args[0] === 'network' && args[1] === 'rm') return { stdout: '' };
      throw new Error('Unexpected Docker command');
    },
  };
}

test('reconciliation removes only an orphaned internal job network after detaching its proxy', async () => {
  const fixture = fakeDocker([
    network(orphanId, { proxy: { Name: 'url-tutorial-egress-proxy' } }),
  ]);
  const result = await reconcileOrphanedCloudNetworks({
    dockerBin: 'docker',
    proxyContainer: 'url-tutorial-egress-proxy',
    runDockerImpl: fixture.run,
  });

  assert.deepEqual(result.removed, ['utv-job-' + orphanId]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.ok(fixture.calls.some(args =>
    args[0] === 'network' && args[1] === 'disconnect' &&
    args.includes('utv-job-' + orphanId) && args.includes('url-tutorial-egress-proxy')));
  assert.ok(fixture.calls.some(args =>
    args[0] === 'network' && args[1] === 'rm' && args.includes('utv-job-' + orphanId)));
});

test('reconciliation leaves active jobs and networks with non-proxy containers untouched', async () => {
  const fixture = fakeDocker([
    network(activeId, { proxy: { Name: 'url-tutorial-egress-proxy' } }),
    network(workerId, {
      proxy: { Name: 'url-tutorial-egress-proxy' },
      worker: { Name: 'utv-worker-' + workerId },
    }),
  ]);
  const result = await reconcileOrphanedCloudNetworks({
    activeJobIds: [activeId],
    runDockerImpl: fixture.run,
  });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, [
    { network: 'utv-job-' + activeId, reason: 'job-active' },
    { network: 'utv-job-' + workerId, reason: 'non-proxy-container-attached' },
  ]);
  assert.equal(fixture.calls.some(args => args[0] === 'network' && args[1] === 'rm'), false);
  assert.equal(fixture.calls.some(args => args[0] === 'network' && args[1] === 'disconnect'), false);
});

test('reconciliation refuses networks without the exact app labels and internal bridge boundary', async () => {
  const unsafe = network(orphanId, { proxy: { Name: 'url-tutorial-egress-proxy' } });
  unsafe.Internal = false;
  const result = await reconcileOrphanedCloudNetworks({
    runDockerImpl: fakeDocker([unsafe]).run,
  });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, [
    { network: 'utv-job-' + orphanId, reason: 'network-not-owned-or-not-internal' },
  ]);
});

test('reconciliation validates job IDs before invoking Docker', async () => {
  const fixture = fakeDocker([]);
  await assert.rejects(
    reconcileOrphanedCloudNetworks({ activeJobIds: ['../../host'], runDockerImpl: fixture.run }),
    /active job IDs must be UUIDs/,
  );
  assert.deepEqual(fixture.calls, []);
});
