import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresBreakGlassStore } from '../src/cloud-break-glass-postgres.mjs';

const connectionString = process.env.COORDINATION_DATABASE_URL;

test('PostgreSQL break-glass store enforces distinct approval, expiry and one-time execution', {
  skip: !connectionString && 'Set COORDINATION_DATABASE_URL to run the PostgreSQL integration test',
}, async t => {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString, max: 2 });
  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  t.after(async () => Promise.all([poolA.end(), poolB.end(), admin.end()]));

  const migration = await readFile(new URL('../migrations/003-cloud-break-glass.sql', import.meta.url), 'utf8');
  await admin.query(migration);

  const storeA = createPostgresBreakGlassStore({ pool: poolA });
  const storeB = createPostgresBreakGlassStore({ pool: poolB });
  const requestId = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  const proposal = await storeA.createRequest({
    requestId,
    actionType: 'revoke_token',
    resourceId: 'service-a-current',
    purpose: 'Emergency revocation after confirmed credential exposure',
    proposerId: 'operator-alpha',
    expiresAt,
  });
  assert.equal(proposal.state, 'pending');
  await assert.rejects(storeB.approveRequest({
    requestId, approverId: 'operator-alpha',
  }), /different operator|not permitted/i);

  const approved = await storeB.approveRequest({
    requestId, approverId: 'operator-beta',
  });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.proposerId, 'operator-alpha');
  assert.equal(approved.approverId, 'operator-beta');

  await assert.rejects(storeA.approveRequest({
    requestId, approverId: 'operator-gamma',
  }), /pending|not permitted/i);

  await assert.rejects(storeA.claimExecution({
    requestId, executorId: 'operator-alpha',
  }), /approver|not executable/i);
  const claim = await storeB.claimExecution({
    requestId, executorId: 'operator-beta',
  });
  assert.ok(claim.executionToken.length >= 16);
  await assert.rejects(storeA.claimExecution({
    requestId, executorId: 'operator-beta',
  }), /approved|not executable/i);

  const completed = await storeA.completeRequest({
    requestId, executionToken: claim.executionToken, resultCode: 'ACTION_APPLIED',
  });
  assert.equal(completed.state, 'completed');
  assert.equal((await storeB.getRequest(requestId)).state, 'completed');

  const expiredId = randomUUID();
  await storeA.createRequest({
    requestId: expiredId,
    actionType: 'revoke_principal',
    resourceId: 'service-a',
    purpose: 'Emergency disablement after confirmed principal compromise',
    proposerId: 'operator-alpha',
    expiresAt,
  });
  await admin.query(
    "UPDATE tutorial_break_glass_requests SET expires_at = clock_timestamp() - interval '1 second' WHERE request_id = $1::uuid",
    [expiredId],
  );
  await assert.rejects(storeB.approveRequest({
    requestId: expiredId, approverId: 'operator-beta',
  }), /expired|not permitted/i);

  const failedId = randomUUID();
  await storeA.createRequest({
    requestId: failedId,
    actionType: 'revoke_token',
    resourceId: 'service-b-current',
    purpose: 'Emergency revocation after confirmed credential exposure',
    proposerId: 'operator-alpha',
    expiresAt,
  });
  await storeA.approveRequest({ requestId: failedId, approverId: 'operator-beta' });
  const failedClaim = await storeA.claimExecution({ requestId: failedId, executorId: 'operator-beta' });
  const failed = await storeB.failRequest({
    requestId: failedId,
    executionToken: failedClaim.executionToken,
    errorCode: 'ACTION_EXECUTION_FAILED',
  });
  assert.equal(failed.state, 'failed');

  const rows = await admin.query(
    'SELECT request_id, action_type, resource_id, proposer_id, approver_id, state FROM tutorial_break_glass_requests WHERE request_id = ANY($1::uuid[])',
    [[requestId, expiredId, failedId]],
  );
  assert.equal(rows.rowCount, 3);
  assert.equal(JSON.stringify(rows.rows).includes('secret'), false);
});
