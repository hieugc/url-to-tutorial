import { randomUUID } from 'node:crypto';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const ACTIONS = new Set(['revoke_token', 'revoke_principal']);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function requirePool(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A query-capable PostgreSQL pool is required');
  }
}

function requireUuid(value, name) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new TypeError('A valid ' + name + ' is required');
  }
}

function safeStoreError() {
  return new Error('Durable break-glass approval storage is unavailable');
}

function mapRow(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    actionType: row.action_type,
    resourceId: row.resource_id,
    purpose: row.purpose,
    proposerId: row.proposer_id,
    approverId: row.approver_id,
    state: row.state,
    expiresAt: new Date(row.expires_at).toISOString(),
    resultCode: row.result_code,
  };
}

export function createPostgresBreakGlassStore({ pool } = {}) {
  requirePool(pool);

  async function query(sql, values) {
    try { return await pool.query(sql, values); }
    catch { throw safeStoreError(); }
  }

  async function createRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['requestId', 'actionType', 'resourceId', 'purpose', 'proposerId', 'expiresAt'].includes(key))) {
      throw new TypeError('Break-glass request metadata is invalid');
    }
    requireUuid(input.requestId, 'break-glass request ID');
    if (!ACTIONS.has(input.actionType) ||
        typeof input.resourceId !== 'string' || !RESOURCE_ID.test(input.resourceId) ||
        typeof input.purpose !== 'string' || input.purpose.trim().length < 20 ||
        input.purpose.trim().length > 500 ||
        typeof input.proposerId !== 'string' || !ACTOR_ID.test(input.proposerId)) {
      throw new TypeError('Break-glass request metadata is invalid');
    }
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
        expiresAt > Date.now() + 24 * 60 * 60_000) {
      throw new TypeError('Break-glass request expiry is invalid');
    }
    const result = await query(
      `INSERT INTO tutorial_break_glass_requests
        (request_id, action_type, resource_id, purpose, proposer_id, state, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, 'pending', $6::timestamptz)
       RETURNING *`,
      [input.requestId, input.actionType, input.resourceId, input.purpose.trim(),
        input.proposerId, new Date(expiresAt).toISOString()],
    );
    return mapRow(result.rows[0]);
  }

  async function getRequest(requestId) {
    requireUuid(requestId, 'break-glass request ID');
    const result = await query(
      'SELECT * FROM tutorial_break_glass_requests WHERE request_id = $1::uuid',
      [requestId],
    );
    return mapRow(result.rows[0]);
  }

  async function approveRequest(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['requestId', 'approverId'].includes(key))) {
      throw new TypeError('Break-glass approval metadata is invalid');
    }
    requireUuid(input.requestId, 'break-glass request ID');
    if (typeof input.approverId !== 'string' || !ACTOR_ID.test(input.approverId)) {
      throw new TypeError('Break-glass approver identity is invalid');
    }
    const result = await query(
      `UPDATE tutorial_break_glass_requests
          SET state = 'approved', approver_id = $2, updated_at = clock_timestamp()
        WHERE request_id = $1::uuid AND state = 'pending'
          AND proposer_id <> $2 AND expires_at > clock_timestamp()
        RETURNING *`,
      [input.requestId, input.approverId],
    );
    if (result.rowCount !== 1) {
      throw new Error('Break-glass request is expired, already approved or not permitted');
    }
    return mapRow(result.rows[0]);
  }

  async function claimExecution(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['requestId', 'executorId'].includes(key))) {
      throw new TypeError('Break-glass execution metadata is invalid');
    }
    requireUuid(input.requestId, 'break-glass request ID');
    if (typeof input.executorId !== 'string' || !ACTOR_ID.test(input.executorId)) {
      throw new TypeError('Break-glass executor identity is invalid');
    }
    const executionToken = randomUUID();
    const result = await query(
      `UPDATE tutorial_break_glass_requests
          SET state = 'executing', execution_token = $3::uuid,
              updated_at = clock_timestamp()
        WHERE request_id = $1::uuid AND state = 'approved'
          AND approver_id = $2 AND expires_at > clock_timestamp()
        RETURNING *`,
      [input.requestId, input.executorId, executionToken],
    );
    if (result.rowCount !== 1) {
      throw new Error('Break-glass request is expired, already claimed or not executable by this approver');
    }
    return { executionToken, record: mapRow(result.rows[0]) };
  }

  async function finish(input, state) {
    const fields = state === 'completed' ? ['requestId', 'executionToken', 'resultCode']
      : ['requestId', 'executionToken', 'errorCode'];
    if (!input || typeof input !== 'object' ||
        Object.keys(input).some(key => !fields.includes(key))) {
      throw new TypeError('Break-glass execution result is invalid');
    }
    requireUuid(input.requestId, 'break-glass request ID');
    requireUuid(input.executionToken, 'break-glass execution token');
    const resultCode = state === 'completed' ? input.resultCode : input.errorCode;
    if (typeof resultCode !== 'string' || !ERROR_CODE.test(resultCode)) {
      throw new TypeError('Break-glass result code is invalid');
    }
    const result = await query(
      `UPDATE tutorial_break_glass_requests
          SET state = $3, result_code = $4, updated_at = clock_timestamp(),
              completed_at = clock_timestamp()
        WHERE request_id = $1::uuid AND state = 'executing'
          AND execution_token = $2::uuid
        RETURNING *`,
      [input.requestId, input.executionToken, state, resultCode],
    );
    if (result.rowCount !== 1) throw new Error('Break-glass execution token is invalid or already consumed');
    return mapRow(result.rows[0]);
  }

  return Object.freeze({
    createRequest,
    getRequest,
    approveRequest,
    claimExecution,
    completeRequest: input => finish(input, 'completed'),
    failRequest: input => finish(input, 'failed'),
  });
}
