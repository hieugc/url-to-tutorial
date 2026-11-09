import { randomUUID } from 'node:crypto';

const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,511}$/;

function validateConfig({ pool, leaseMs, renewIntervalMs, retryIntervalMs, acquireTimeoutMs }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A query-capable PostgreSQL pool is required');
  }
  for (const [name, value, min, max] of [
    ['leaseMs', leaseMs, 100, 300_000],
    ['renewIntervalMs', renewIntervalMs, 10, 100_000],
    ['retryIntervalMs', retryIntervalMs, 5, 10_000],
    ['acquireTimeoutMs', acquireTimeoutMs, 100, 600_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(name + ' is outside the supported range');
    }
  }
  if (renewIntervalMs >= leaseMs / 2) {
    throw new TypeError('renewIntervalMs must be less than half of leaseMs');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * PostgreSQL-backed lease lock shared by every API/publisher host using the
 * same database. The monotonically increasing fencing token changes whenever
 * an expired lease is reclaimed. The callback must call lease.assertHeld()
 * immediately before every irreversible external side effect.
 *
 * Run migrations/001-cloud-coordination.sql before constructing this adapter.
 */
export function createPostgresPublishLock({
  pool,
  leaseMs = 30_000,
  renewIntervalMs = 5_000,
  retryIntervalMs = 100,
  acquireTimeoutMs = 30_000,
  sleepImpl = sleep,
} = {}) {
  validateConfig({ pool, leaseMs, renewIntervalMs, retryIntervalMs, acquireTimeoutMs });
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');

  async function query(sql, values) {
    try {
      return await pool.query(sql, values);
    } catch {
      throw new Error('PostgreSQL publish lock storage is unavailable');
    }
  }

  async function withLock(resource, callback) {
    if (typeof resource !== 'string' || !RESOURCE.test(resource)) {
      throw new TypeError('A valid publish-lock resource is required');
    }
    if (typeof callback !== 'function') throw new TypeError('A publish-lock callback is required');

    const ownerId = randomUUID();
    const deadline = Date.now() + acquireTimeoutMs;
    let fencingToken;

    while (fencingToken === undefined) {
      const result = await query(
        `INSERT INTO tutorial_publish_locks
          (resource, owner_id, fencing_token, expires_at)
         VALUES ($1, $2::uuid, 1, clock_timestamp() + ($3 * interval '1 millisecond'))
         ON CONFLICT (resource) DO UPDATE
           SET owner_id = EXCLUDED.owner_id,
               fencing_token = tutorial_publish_locks.fencing_token + 1,
               expires_at = EXCLUDED.expires_at
         WHERE tutorial_publish_locks.expires_at <= clock_timestamp()
         RETURNING fencing_token`,
        [resource, ownerId, leaseMs],
      );
      if (result.rows?.length === 1) {
        fencingToken = String(result.rows[0].fencing_token);
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the distributed publish lock');
      }
      await sleepImpl(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
    }

    let lost = false;
    let renewing = false;
    const renew = async () => {
      if (lost || renewing) return;
      renewing = true;
      try {
        const result = await query(
          `UPDATE tutorial_publish_locks
              SET expires_at = clock_timestamp() + ($4 * interval '1 millisecond')
            WHERE resource = $1 AND owner_id = $2::uuid
              AND fencing_token = $3::bigint
              AND expires_at > clock_timestamp()
            RETURNING fencing_token`,
          [resource, ownerId, fencingToken, leaseMs],
        );
        if (result.rows?.length !== 1) lost = true;
      } catch {
        lost = true;
      } finally {
        renewing = false;
      }
    };

    const timer = setInterval(() => { void renew(); }, renewIntervalMs);
    timer.unref?.();

    const lease = Object.freeze({
      fencingToken,
      async assertHeld() {
        if (lost) throw new Error('Distributed publish lock lease is no longer valid');
        let result;
        try {
          result = await pool.query(
            `SELECT fencing_token FROM tutorial_publish_locks
              WHERE resource = $1 AND owner_id = $2::uuid
                AND fencing_token = $3::bigint
                AND expires_at > clock_timestamp()`,
            [resource, ownerId, fencingToken],
          );
        } catch {
          lost = true;
          throw new Error('Distributed publish lock lease is no longer valid');
        }
        if (result.rows?.length !== 1) {
          lost = true;
          throw new Error('Distributed publish lock lease is no longer valid');
        }
      },
    });

    try {
      await lease.assertHeld();
      return await callback(lease);
    } finally {
      clearInterval(timer);
      try {
        await pool.query(
          `DELETE FROM tutorial_publish_locks
            WHERE resource = $1 AND owner_id = $2::uuid
              AND fencing_token = $3::bigint`,
          [resource, ownerId, fencingToken],
        );
      } catch {
        // The lease expires automatically if release cannot reach PostgreSQL.
      }
    }
  }

  return Object.freeze({ withLock });
}
