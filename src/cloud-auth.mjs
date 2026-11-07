import { createHash, timingSafeEqual } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(name + ' must be a positive safe integer');
  }
  return resolved;
}

/**
 * Small bearer-token control plane for a future cloud deployment.
 * Store only SHA-256 token digests in memory; provide raw tokens via a secret
 * manager/environment at process startup. This is not a network sandbox.
 */
export function createCloudAuth({ tokens, limits = {}, clock = Date.now } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new TypeError('Cloud mode requires at least one configured bearer token');
  }

  const configuredLimits = Object.freeze({
    maxRequestsPerMinute: positiveInteger(limits.maxRequestsPerMinute, 60, 'maxRequestsPerMinute'),
    maxConcurrentJobsPerTenant: positiveInteger(
      limits.maxConcurrentJobsPerTenant, 2, 'maxConcurrentJobsPerTenant'),
    maxJobsPerDay: positiveInteger(limits.maxJobsPerDay, 50, 'maxJobsPerDay'),
  });

  const principals = new Map();
  for (const entry of tokens) {
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string' || !TOKEN.test(entry.token) ||
        !ID.test(entry.tenantId || '') || !Array.isArray(entry.projectIds) ||
        entry.projectIds.length === 0 ||
        !entry.projectIds.every(id => typeof id === 'string' && ID.test(id)) ||
        new Set(entry.projectIds).size !== entry.projectIds.length) {
      throw new TypeError('Each cloud token requires a 32+ character token, tenantId and unique projectIds');
    }
    const digest = createHash('sha256').update(entry.token, 'utf8').digest();
    const key = digest.toString('hex');
    if (principals.has(key)) throw new TypeError('Duplicate cloud bearer token');
    principals.set(key, Object.freeze({
      principalId: typeof entry.id === 'string' && ID.test(entry.id)
        ? entry.id : key.slice(0, 16),
      tenantId: entry.tenantId,
      projectIds: Object.freeze([...entry.projectIds]),
    }));
  }

  const requests = new Map();

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(header);
    if (!match) return null;
    const candidate = createHash('sha256').update(match[1], 'utf8').digest();
    let authenticated = null;
    // Compare every configured digest to avoid leaking which token matched.
    for (const [hex, principal] of principals) {
      const expected = Buffer.from(hex, 'hex');
      if (timingSafeEqual(candidate, expected)) authenticated = principal;
    }
    return authenticated;
  }

  function authorizeProject(principal, projectId) {
    if (!principal || typeof projectId !== 'string' || !ID.test(projectId) ||
        !principal.projectIds.includes(projectId)) return null;
    return Object.freeze({
      principalId: principal.principalId,
      tenantId: principal.tenantId,
      projectId,
    });
  }

  function consumeRequest(principal, store = null) {
    const now = clock();
    if (store && typeof store.consumeCloudRequest === 'function') {
      return store.consumeCloudRequest(
        principal.tenantId, now, WINDOW_MS, configuredLimits.maxRequestsPerMinute,
      );
    }
    const recent = (requests.get(principal.tenantId) || [])
      .filter(timestamp => now - timestamp < WINDOW_MS);
    if (recent.length >= configuredLimits.maxRequestsPerMinute) {
      requests.set(principal.tenantId, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)),
      };
    }
    recent.push(now);
    requests.set(principal.tenantId, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function checkJobQuota(jobs, principal, now = clock(), persistedDailyCount = null) {
    const tenantJobs = jobs.filter(job => job.tenantId === principal.tenantId);
    const pending = tenantJobs.filter(job => ['queued', 'running'].includes(job.status)).length;
    if (pending >= configuredLimits.maxConcurrentJobsPerTenant) {
      return { allowed: false, reason: 'Tenant concurrent-job quota exceeded' };
    }
    const cutoff = now - DAY_MS;
    const recent = Number.isSafeInteger(persistedDailyCount) && persistedDailyCount >= 0
      ? persistedDailyCount
      : tenantJobs.filter(job => {
        const created = Date.parse(job.createdAt || '');
        return Number.isFinite(created) && created >= cutoff;
      }).length;
    if (recent >= configuredLimits.maxJobsPerDay) {
      return { allowed: false, reason: 'Tenant daily-job quota exceeded' };
    }
    return { allowed: true, reason: null };
  }

  return Object.freeze({
    limits: configuredLimits,
    authenticate,
    authorizeProject,
    consumeRequest,
    checkJobQuota,
  });
}
