import { randomUUID } from 'node:crypto';

const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['revoke_token', 'revoke_principal']);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) ||
      Object.getPrototypeOf(action) !== Object.prototype ||
      Object.keys(action).length !== 2 ||
      Object.keys(action).some(key => !['type', 'resourceId'].includes(key)) ||
      !ACTIONS.has(action.type) ||
      typeof action.resourceId !== 'string' || !RESOURCE_ID.test(action.resourceId)) {
    throw new TypeError('Break-glass action is invalid or unsupported');
  }
  return Object.freeze({ type: action.type, resourceId: action.resourceId });
}

function validatePurpose(purpose) {
  if (typeof purpose !== 'string' || purpose.trim().length < 20 ||
      purpose.trim().length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(purpose)) {
    throw new TypeError('A 20–500 character break-glass justification is required');
  }
  return purpose.trim();
}

async function authorize(operatorAuthenticator, context, action) {
  let identity;
  try {
    identity = await operatorAuthenticator.authorize(context, { action });
  } catch {
    throw new Error('Break-glass operator authorization failed');
  }
  if (!identity || identity.mfaVerified !== true ||
      typeof identity.actorId !== 'string' || !ACTOR_ID.test(identity.actorId)) {
    throw new Error('Break-glass recovery requires an MFA-verified operator');
  }
  return Object.freeze({ actorId: identity.actorId });
}

function safeRecord(record) {
  if (!record) return null;
  return Object.freeze({
    requestId: record.requestId,
    action: Object.freeze({ type: record.actionType, resourceId: record.resourceId }),
    purpose: record.purpose,
    proposerId: record.proposerId,
    approverId: record.approverId ?? null,
    state: record.state,
    expiresAt: record.expiresAt,
    resultCode: record.resultCode ?? null,
  });
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && ERROR_CODE.test(error.code)
    ? error.code : 'ACTION_EXECUTION_FAILED';
}

/**
 * Trusted host-code-only emergency workflow. There is deliberately no HTTP route.
 * A proposer and a different MFA-verified approver are required; only that
 * approver may claim the one-time execution.
 */
export function createBreakGlassRecovery({
  approvalStore,
  operatorAuthenticator,
  auditRecorder,
  actionExecutor,
  now = () => Date.now(),
  defaultTtlMs = 15 * 60_000,
} = {}) {
  for (const method of ['createRequest', 'getRequest', 'approveRequest', 'claimExecution', 'completeRequest', 'failRequest']) {
    if (!approvalStore || typeof approvalStore[method] !== 'function') {
      throw new TypeError('Break-glass approval store method is required: ' + method);
    }
  }
  if (!operatorAuthenticator || typeof operatorAuthenticator.authorize !== 'function') {
    throw new TypeError('MFA operator authenticator is required');
  }
  if (!auditRecorder || typeof auditRecorder.record !== 'function') {
    throw new TypeError('Tamper-evident audit recorder is required');
  }
  if (!actionExecutor || typeof actionExecutor.execute !== 'function') {
    throw new TypeError('Trusted break-glass action executor is required');
  }
  if (typeof now !== 'function' || !Number.isSafeInteger(defaultTtlMs) ||
      defaultTtlMs < 60_000 || defaultTtlMs > 24 * 60 * 60_000) {
    throw new TypeError('Break-glass clock or request lifetime configuration is invalid');
  }

  async function getRequest(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw new TypeError('A valid break-glass request ID is required');
    }
    return safeRecord(await approvalStore.getRequest(requestId));
  }

  async function propose(context, actionInput, purposeInput, options = {}) {
    const identity = await authorize(operatorAuthenticator, context, 'cloud.break_glass.propose');
    const action = validateAction(actionInput);
    const purpose = validatePurpose(purposeInput);
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => key !== 'ttlMs')) {
      throw new TypeError('Break-glass proposal options are invalid');
    }
    const ttlMs = options.ttlMs ?? defaultTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) {
      throw new TypeError('Break-glass request lifetime must be between 1 minute and 24 hours');
    }
    const requestId = randomUUID();
    const expiresAt = new Date(now() + ttlMs).toISOString();
    await auditRecorder.record({
      action: 'cloud.break_glass.proposed',
      actorId: identity.actorId,
      requestId,
      actionType: action.type,
      resourceId: action.resourceId,
    });
    const record = await approvalStore.createRequest({
      requestId,
      actionType: action.type,
      resourceId: action.resourceId,
      purpose,
      proposerId: identity.actorId,
      expiresAt,
    });
    return safeRecord(record);
  }

  async function approve(context, requestId) {
    const identity = await authorize(operatorAuthenticator, context, 'cloud.break_glass.approve');
    const current = await getRequest(requestId);
    if (!current || current.state !== 'pending') {
      throw new Error('Break-glass request is not awaiting approval');
    }
    if (current.proposerId === identity.actorId) {
      throw new Error('Break-glass approval requires a different operator');
    }
    if (Date.parse(current.expiresAt) <= now()) {
      throw new Error('Break-glass request has expired');
    }
    await auditRecorder.record({
      action: 'cloud.break_glass.approval_authorized',
      actorId: identity.actorId,
      requestId,
      proposerId: current.proposerId,
    });
    const record = await approvalStore.approveRequest({
      requestId,
      approverId: identity.actorId,
    });
    return safeRecord(record);
  }

  async function execute(context, requestId) {
    const identity = await authorize(operatorAuthenticator, context, 'cloud.break_glass.execute');
    const current = await getRequest(requestId);
    if (!current || current.state !== 'approved') {
      throw new Error('Break-glass request is not executable');
    }
    if (current.approverId !== identity.actorId) {
      throw new Error('Break-glass execution must be performed by the second approver');
    }
    if (Date.parse(current.expiresAt) <= now()) {
      throw new Error('Break-glass request has expired');
    }

    const claim = await approvalStore.claimExecution({
      requestId,
      executorId: identity.actorId,
    });
    try {
      await auditRecorder.record({
        action: 'cloud.break_glass.execution_started',
        actorId: identity.actorId,
        requestId,
        proposerId: current.proposerId,
      });
    } catch {
      try {
        await approvalStore.failRequest({
          requestId,
          executionToken: claim.executionToken,
          errorCode: 'AUDIT_WRITE_FAILED',
        });
      } catch {
        throw new Error('Break-glass audit failed and its outcome could not be persisted; manual review is required');
      }
      throw new Error('Break-glass execution stopped because the audit write failed');
    }

    try {
      const result = await actionExecutor.execute(current.action, {
        requestId,
        proposerId: current.proposerId,
        approverId: identity.actorId,
      });
      if (!result || result.applied !== true) {
        throw Object.assign(new Error('Break-glass action was not confirmed'), {
          code: 'ACTION_NOT_CONFIRMED',
        });
      }
      const record = await approvalStore.completeRequest({
        requestId,
        executionToken: claim.executionToken,
        resultCode: 'ACTION_APPLIED',
      });
      await auditRecorder.record({
        action: 'cloud.break_glass.completed',
        actorId: identity.actorId,
        requestId,
        resultCode: 'ACTION_APPLIED',
      });
      return safeRecord(record);
    } catch (error) {
      const errorCode = safeErrorCode(error);
      let record;
      try {
        record = await approvalStore.failRequest({
          requestId,
          executionToken: claim.executionToken,
          errorCode,
        });
      } catch {
        throw new Error('Break-glass outcome could not be durably recorded; manual review is required');
      }
      try {
        await auditRecorder.record({
          action: 'cloud.break_glass.failed',
          actorId: identity.actorId,
          requestId,
          resultCode: errorCode,
        });
      } catch {
        throw new Error('Break-glass failure audit could not be recorded; manual review is required');
      }
      return safeRecord(record);
    }
  }

  return Object.freeze({ propose, approve, execute, getRequest });
}

/** Restricts the built-in executor to the two explicitly supported tokenAdmin operations. */
export function createTokenAdminBreakGlassExecutor({ tokenAdmin } = {}) {
  if (!tokenAdmin || typeof tokenAdmin.revokeToken !== 'function' ||
      typeof tokenAdmin.revokePrincipal !== 'function') {
    throw new TypeError('Trusted token administration capability is required');
  }
  return Object.freeze({
    async execute(action, { approverId } = {}) {
      if (action?.type === 'revoke_token') {
        await tokenAdmin.revokeToken(action.resourceId, { actorId: approverId });
        return { applied: true };
      }
      if (action?.type === 'revoke_principal') {
        await tokenAdmin.revokePrincipal(action.resourceId, { actorId: approverId });
        return { applied: true };
      }
      throw new Error('Unsupported break-glass action');
    },
  });
}
