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

function compileTokenRegistry(entries, { allowEmpty = false } = {}) {
  if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0)) {
    throw new TypeError('Cloud mode requires at least one configured bearer token');
  }
  const registry = new Map();
  const tokenIds = new Set();
  const principalScopes = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string' || !TOKEN.test(entry.token) ||
        !ID.test(entry.tenantId || '') || !Array.isArray(entry.projectIds) ||
        entry.projectIds.length === 0 ||
        !entry.projectIds.every(id => typeof id === 'string' && ID.test(id)) ||
        new Set(entry.projectIds).size !== entry.projectIds.length) {
      throw new TypeError('Each cloud token requires a 32+ character token, tenantId and unique projectIds');
    }
    const digest = createHash('sha256').update(entry.token, 'utf8').digest();
    const key = digest.toString('hex');
    if (registry.has(key)) throw new TypeError('Duplicate cloud bearer token');

    const principalId = entry.principalId ?? entry.id ?? key.slice(0, 16);
    const tokenId = entry.tokenId ?? key.slice(0, 16);
    if (!ID.test(principalId) || !ID.test(tokenId)) {
      throw new TypeError('Cloud token principalId and tokenId must be valid identifiers');
    }
    if (tokenIds.has(tokenId)) throw new TypeError('Duplicate cloud tokenId');
    const projectIds = [...entry.projectIds].sort();
    const scope = JSON.stringify({ tenantId: entry.tenantId, projectIds });
    if (principalScopes.has(principalId) && principalScopes.get(principalId) !== scope) {
      throw new TypeError('All credentials for a principal must share the same tenant and project ACL');
    }
    principalScopes.set(principalId, scope);
    let expiresAt = null;
    let expiresAtMs = null;
    if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
      if (typeof entry.expiresAt !== 'string' || !Number.isFinite(Date.parse(entry.expiresAt))) {
        throw new TypeError('Cloud token expiresAt must be a valid ISO date string');
      }
      expiresAtMs = Date.parse(entry.expiresAt);
      expiresAt = new Date(expiresAtMs).toISOString();
    }
    tokenIds.add(tokenId);
    registry.set(key, Object.freeze({
      tokenId, principalId, tenantId: entry.tenantId,
      projectIds: Object.freeze([...entry.projectIds]),
      expiresAt, expiresAtMs,
    }));
  }
  return registry;
}

function safeTokenSnapshot(registry) {
  return Object.freeze([...registry.values()]
    .map(({ tokenId, principalId, tenantId, projectIds, expiresAt }) => Object.freeze({
      tokenId, principalId, tenantId, projectIds: [...projectIds], expiresAt,
    }))
    .sort((a, b) => a.tokenId.localeCompare(b.tokenId)));
}

/**
 * Bearer-token control plane for a future cloud deployment.
 * Raw credentials are accepted only from trusted process code (normally a
 * secret manager). The registry retains only SHA-256 digests. No HTTP token
 * administration endpoint is provided by this module.
 */
export function createCloudAuth({ tokens, limits = {}, clock = Date.now } = {}) {
  let principals = compileTokenRegistry(tokens);

  const configuredLimits = Object.freeze({
    maxRequestsPerMinute: positiveInteger(limits.maxRequestsPerMinute, 60, 'maxRequestsPerMinute'),
    maxConcurrentJobsPerTenant: positiveInteger(
      limits.maxConcurrentJobsPerTenant, 2, 'maxConcurrentJobsPerTenant'),
    maxJobsPerDay: positiveInteger(limits.maxJobsPerDay, 50, 'maxJobsPerDay'),
  });

  const requests = new Map();

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(header);
    if (!match) return null;
    const candidate = createHash('sha256').update(match[1], 'utf8').digest();
    const now = clock();
    let authenticated = null;
    // Compare every configured digest to avoid leaking which token matched.
    for (const [hex, principal] of principals) {
      const expected = Buffer.from(hex, 'hex');
      if (timingSafeEqual(candidate, expected) &&
          (principal.expiresAtMs === null || now < principal.expiresAtMs)) {
        authenticated = principal;
      }
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

  function replaceTokens(nextTokens) {
    const next = compileTokenRegistry(nextTokens, { allowEmpty: true });
    principals = next;
    return safeTokenSnapshot(principals);
  }

  function revokeToken(tokenId) {
    if (typeof tokenId !== 'string' || !ID.test(tokenId)) return null;
    for (const [digest, principal] of principals) {
      if (principal.tokenId === tokenId) {
        principals.delete(digest);
        return safeTokenSnapshot(new Map([[digest, principal]])).at(0);
      }
    }
    return null;
  }

  function revokePrincipal(principalId) {
    if (typeof principalId !== 'string' || !ID.test(principalId)) return [];
    const revoked = [];
    for (const [digest, principal] of principals) {
      if (principal.principalId === principalId) {
        revoked.push(principal);
        principals.delete(digest);
      }
    }
    return safeTokenSnapshot(new Map(revoked.map((principal, index) => [String(index), principal])));
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
    tokenSnapshot: () => safeTokenSnapshot(principals),
    validateTokens: nextTokens => safeTokenSnapshot(compileTokenRegistry(nextTokens, { allowEmpty: true })),
    replaceTokens,
    revokeToken,
    revokePrincipal,
  });
}
