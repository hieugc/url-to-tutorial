import test from 'node:test';
import assert from 'node:assert/strict';
import { createBreakGlassRecovery, createStudioBreakGlassAuditRecorder, createTokenAdminBreakGlassExecutor } from '../src/cloud-break-glass.mjs';

function createHarness({ failAction = false, failExecutionAudit = false } = {}) {
  const records = new Map();
  const audits = [];
  const executions = [];
  const authorizeCalls = [];
  const store = {
    async createRequest(input) {
      if (records.has(input.requestId)) throw new Error('duplicate request');
      const record = { ...input, state: 'pending', approverId: null };
      records.set(input.requestId, record);
      return structuredClone(record);
    },
    async getRequest(id) {
      return records.has(id) ? structuredClone(records.get(id)) : null;
    },
    async approveRequest({ requestId, approverId }) {
      const record = records.get(requestId);
      if (!record || record.state !== 'pending' || record.proposerId === approverId) {
        throw new Error('Break-glass approval is not permitted');
      }
      record.state = 'approved';
      record.approverId = approverId;
      return structuredClone(record);
    },
    async claimExecution({ requestId, executorId }) {
      const record = records.get(requestId);
      if (!record || record.state !== 'approved' || record.approverId !== executorId) {
        throw new Error('Break-glass request is not executable');
      }
      record.state = 'executing';
      record.executionToken = 'one-time-execution-token-123456';
      return { executionToken: record.executionToken, record: structuredClone(record) };
    },
    async completeRequest({ requestId, executionToken, resultCode }) {
      const record = records.get(requestId);
      if (!record || record.state !== 'executing' || record.executionToken !== executionToken) {
        throw new Error('Break-glass execution lease is invalid');
      }
      record.state = 'completed';
      record.resultCode = resultCode;
      return structuredClone(record);
    },
    async failRequest({ requestId, executionToken, errorCode }) {
      const record = records.get(requestId);
      if (!record || record.state !== 'executing' || record.executionToken !== executionToken) {
        throw new Error('Break-glass execution lease is invalid');
      }
      record.state = 'failed';
      record.resultCode = errorCode;
      return structuredClone(record);
    },
  };
  const service = createBreakGlassRecovery({
    approvalStore: store,
    operatorAuthenticator: {
      async authorize(context, { action }) {
        authorizeCalls.push({ actorId: context.actorId, action });
        return { actorId: context.actorId, mfaVerified: context.mfaVerified === true };
      },
    },
    auditRecorder: {
      async record(event) {
        audits.push(structuredClone(event));
        if (failExecutionAudit && event.action === 'cloud.break_glass.execution_started') {
          throw new Error('private audit backend detail');
        }
      },
    },
    actionExecutor: {
      async execute(action) {
        executions.push(structuredClone(action));
        if (failAction) throw Object.assign(new Error('sensitive provider detail'), { code: 'ACTION_EXECUTION_FAILED' });
        return { applied: true };
      },
    },
    now: () => Date.parse('2026-11-09T09:00:00.000Z'),
  });
  return { service, records, audits, executions, authorizeCalls };
}

test('break-glass audit adapter appends only safe metadata to the signed platform chain', async () => {
  const events = [];
  const auditRecorder = createStudioBreakGlassAuditRecorder({
    store: { recordCloudAudit: event => events.push(structuredClone(event)) },
  });
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  await auditRecorder.record({
    action: 'cloud.break_glass.execution_started',
    actorId: 'operator-beta',
    requestId,
    actionType: 'revoke_token',
    resourceId: 'service-a-current',
    proposerId: 'operator-alpha',
  });
  assert.deepEqual(events[0], {
    tenantId: 'platform',
    principalId: 'operator-beta',
    action: 'cloud.break_glass.execution_started',
    resourceId: 'service-a-current',
    outcome: 'success',
    details: {
      requestId,
      actionType: 'revoke_token',
      proposerId: 'operator-alpha',
    },
  });
  await assert.rejects(auditRecorder.record({
    action: 'cloud.break_glass.execution_started',
    actorId: 'operator-beta',
    requestId,
    rawToken: 'must-not-be-accepted',
  }), /audit event is invalid/i);
});

test('trusted break-glass executor exposes only token and principal revocation', async () => {
  const calls = [];
  const executor = createTokenAdminBreakGlassExecutor({
    tokenAdmin: {
      async revokeToken(id, options) { calls.push({ action: 'token', id, options }); return true; },
      async revokePrincipal(id, options) { calls.push({ action: 'principal', id, options }); return 1; },
    },
  });
  await executor.execute({ type: 'revoke_token', resourceId: 'token-12345678' }, { approverId: 'operator-beta' });
  await executor.execute({ type: 'revoke_principal', resourceId: 'principal-12345678' }, { approverId: 'operator-beta' });
  assert.deepEqual(calls.map(call => call.action), ['token', 'principal']);
  await assert.rejects(executor.execute({ type: 'shell', resourceId: 'anything' }, { approverId: 'operator-beta' }), /unsupported/i);
});

test('break-glass requires two distinct MFA-verified operators and a one-time approver execution', async () => {
  const { service, records, audits, executions } = createHarness();
  const proposal = await service.propose(
    { actorId: 'operator-alpha', mfaVerified: true },
    { type: 'revoke_token', resourceId: 'service-a-current' },
    'Emergency revocation after confirmed credential exposure',
  );
  assert.equal(proposal.state, 'pending');
  assert.equal(records.size, 1);

  await assert.rejects(service.approve(
    { actorId: 'operator-alpha', mfaVerified: true },
    proposal.requestId,
  ), /different operator/i);

  const approved = await service.approve(
    { actorId: 'operator-beta', mfaVerified: true },
    proposal.requestId,
  );
  assert.equal(approved.state, 'approved');
  assert.equal(approved.proposerId, 'operator-alpha');
  assert.equal(approved.approverId, 'operator-beta');

  await assert.rejects(service.execute(
    { actorId: 'operator-alpha', mfaVerified: true },
    proposal.requestId,
  ), /approver/i);

  const completed = await service.execute(
    { actorId: 'operator-beta', mfaVerified: true },
    proposal.requestId,
  );
  assert.equal(completed.state, 'completed');
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0], {
    type: 'revoke_token',
    resourceId: 'service-a-current',
  });

  await assert.rejects(service.execute(
    { actorId: 'operator-beta', mfaVerified: true },
    proposal.requestId,
  ), /not executable|already/i);
  assert.ok(audits.some(event => event.action === 'cloud.break_glass.proposed'));
  assert.ok(audits.some(event => event.action === 'cloud.break_glass.approval_authorized'));
  assert.ok(audits.some(event => event.action === 'cloud.break_glass.execution_started'));
  assert.ok(audits.some(event => event.action === 'cloud.break_glass.completed'));
});

test('break-glass rejects missing MFA, malformed actions and short justifications', async () => {
  const { service, records } = createHarness();
  await assert.rejects(service.propose(
    { actorId: 'operator-alpha', mfaVerified: false },
    { type: 'revoke_token', resourceId: 'service-a-current' },
    'Emergency revocation after confirmed credential exposure',
  ), /MFA/i);
  await assert.rejects(service.propose(
    { actorId: 'operator-alpha', mfaVerified: true },
    { type: 'shell', resourceId: 'anything' },
    'Emergency revocation after confirmed credential exposure',
  ), /action/i);
  await assert.rejects(service.propose(
    { actorId: 'operator-alpha', mfaVerified: true },
    { type: 'revoke_token', resourceId: 'service-a-current', command: 'rm -rf /' },
    'Emergency revocation after confirmed credential exposure',
  ), /action/i);
  await assert.rejects(service.propose(
    { actorId: 'operator-alpha', mfaVerified: true },
    { type: 'revoke_token', resourceId: 'service-a-current' },
    'urgent',
  ), /justification/i);
  assert.equal(records.size, 0);
});

test('break-glass does not execute an emergency action when the execution-start audit write fails', async () => {
  const { service, records, executions } = createHarness({ failExecutionAudit: true });
  const proposal = await service.propose(
    { actorId: 'operator-alpha', mfaVerified: true },
    { type: 'revoke_token', resourceId: 'service-a-current' },
    'Emergency revocation after confirmed credential exposure',
  );
  await service.approve({ actorId: 'operator-beta', mfaVerified: true }, proposal.requestId);
  await assert.rejects(service.execute(
    { actorId: 'operator-beta', mfaVerified: true },
    proposal.requestId,
  ), /audit write failed/i);
  assert.equal(executions.length, 0);
  assert.equal(records.get(proposal.requestId).state, 'failed');
  assert.equal(records.get(proposal.requestId).resultCode, 'AUDIT_WRITE_FAILED');
});

test('break-glass action failures are durably marked and expose only safe error codes', async () => {
  const { service, records } = createHarness({ failAction: true });
  const proposal = await service.propose(
    { actorId: 'operator-alpha', mfaVerified: true },
    { type: 'revoke_principal', resourceId: 'service-a' },
    'Emergency disablement after confirmed principal compromise',
  );
  await service.approve({ actorId: 'operator-beta', mfaVerified: true }, proposal.requestId);
  const completed = await service.execute(
    { actorId: 'operator-beta', mfaVerified: true },
    proposal.requestId,
  );
  assert.equal(completed.state, 'failed');
  assert.match(completed.resultCode, /^[A-Z][A-Z0-9_]{0,63}$/);
  assert.equal(JSON.stringify(records.get(proposal.requestId)).includes('stack'), false);
});
