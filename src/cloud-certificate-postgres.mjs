function validatePool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A connect-capable PostgreSQL pool is required');
  }
}

function uuid(value, name) {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('A valid ' + name + ' is required');
  }
}

function safeStoreError() {
  return new Error('Durable replica certificate storage is unavailable');
}

function mapRow(row) {
  if (!row) return null;
  return {
    bundleId: row.bundle_id,
    replicaId: row.replica_id,
    serialNumber: row.serial_number,
    fingerprint256: row.fingerprint256.trim(),
    certificatePem: row.certificate_pem,
    chainPem: row.chain_pem,
    keyRef: row.key_ref,
    publicKeyFingerprint: row.public_key_fingerprint.trim(),
    notBefore: new Date(row.not_before).toISOString(),
    notAfter: new Date(row.not_after).toISOString(),
    actorId: row.actor_id,
    previousBundleId: row.previous_bundle_id,
    state: row.state,
    errorCode: row.error_code,
  };
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error.message?.startsWith('Active replica certificate changed') ||
        error.message?.startsWith('Staged replica certificate is missing') ||
        error.message?.startsWith('Certificate bundle state')) throw error;
    throw safeStoreError();
  } finally {
    client.release();
  }
}

export function createPostgresCertificateStore({ pool } = {}) {
  validatePool(pool);

  async function getActive(replicaId) {
    if (typeof replicaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(replicaId)) {
      throw new TypeError('A valid replica ID is required');
    }
    let result;
    try {
      result = await pool.query(
        "SELECT * FROM tutorial_replica_certificates WHERE replica_id = $1 AND state = 'active'",
        [replicaId],
      );
    } catch { throw safeStoreError(); }
    if (result.rowCount > 1) throw new Error('Certificate store contains multiple active certificates');
    return mapRow(result.rows[0]);
  }

  async function stageCertificate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Certificate bundle metadata is required');
    uuid(input.bundleId, 'certificate bundle ID');
    if (input.previousBundleId !== undefined && input.previousBundleId !== null) {
      uuid(input.previousBundleId, 'previous certificate bundle ID');
    }
    if (typeof input.replicaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.replicaId) ||
        typeof input.serialNumber !== 'string' || !/^[A-Fa-f0-9]{1,64}$/.test(input.serialNumber) ||
        typeof input.fingerprint256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint256) ||
        typeof input.certificatePem !== 'string' || input.certificatePem.length < 64 || input.certificatePem.length > 65_536 ||
        typeof input.chainPem !== 'string' || input.chainPem.length < 64 || input.chainPem.length > 262_144 ||
        typeof input.keyRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,255}$/.test(input.keyRef) ||
        typeof input.publicKeyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.publicKeyFingerprint) ||
        typeof input.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/.test(input.actorId) ||
        !Number.isFinite(Date.parse(input.notBefore)) || !Number.isFinite(Date.parse(input.notAfter)) ||
        Date.parse(input.notAfter) <= Date.parse(input.notBefore)) {
      throw new TypeError('Replica certificate metadata is invalid');
    }
    try {
      await pool.query(
        `INSERT INTO tutorial_replica_certificates
          (bundle_id, replica_id, serial_number, fingerprint256, certificate_pem,
           chain_pem, key_ref, public_key_fingerprint, not_before, not_after,
           actor_id, previous_bundle_id, state)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz,
                 $10::timestamptz, $11, $12::uuid, 'staged')`,
        [input.bundleId, input.replicaId, input.serialNumber, input.fingerprint256,
          input.certificatePem, input.chainPem, input.keyRef, input.publicKeyFingerprint,
          input.notBefore, input.notAfter, input.actorId, input.previousBundleId ?? null],
      );
    } catch { throw safeStoreError(); }
  }

  async function activateCertificate(input) {
    uuid(input?.bundleId, 'certificate bundle ID');
    if (input.expectedPreviousBundleId !== null) {
      uuid(input.expectedPreviousBundleId, 'expected previous certificate bundle ID');
    }
    if (typeof input.replicaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.replicaId)) {
      throw new TypeError('A valid replica ID is required');
    }
    return transaction(pool, async client => {
      const current = await client.query(
        "SELECT bundle_id FROM tutorial_replica_certificates WHERE replica_id = $1 AND state = 'active' FOR UPDATE",
        [input.replicaId],
      );
      const currentId = current.rows[0]?.bundle_id ?? null;
      if (currentId !== input.expectedPreviousBundleId) {
        throw new Error('Active replica certificate changed before activation');
      }
      const staged = await client.query(
        "SELECT * FROM tutorial_replica_certificates WHERE bundle_id = $1::uuid AND replica_id = $2 AND state = 'staged' FOR UPDATE",
        [input.bundleId, input.replicaId],
      );
      if (staged.rowCount !== 1) throw new Error('Staged replica certificate is missing or already consumed');
      if (currentId) {
        await client.query(
          "UPDATE tutorial_replica_certificates SET state = 'superseded', updated_at = clock_timestamp() WHERE bundle_id = $1::uuid AND state = 'active'",
          [currentId],
        );
      }
      const updated = await client.query(
        "UPDATE tutorial_replica_certificates SET state = 'active', updated_at = clock_timestamp() WHERE bundle_id = $1::uuid RETURNING *",
        [input.bundleId],
      );
      return mapRow(updated.rows[0]);
    });
  }

  async function updateState(bundleId, fromStates, state, errorCode = null) {
    uuid(bundleId, 'certificate bundle ID');
    const result = await pool.query(
      `UPDATE tutorial_replica_certificates
          SET state = $3, error_code = $4, updated_at = clock_timestamp(),
              revoked_at = CASE WHEN $3 = 'revoked' THEN clock_timestamp() ELSE revoked_at END
        WHERE bundle_id = $1::uuid AND state = ANY($2::text[])
        RETURNING bundle_id`,
      [bundleId, fromStates, state, errorCode],
    );
    if (result.rowCount !== 1) throw new Error('Certificate bundle state changed or is invalid');
  }

  async function markFailed(input) {
    if (typeof input?.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)) {
      throw new TypeError('Certificate failure code is invalid');
    }
    try { await updateState(input.bundleId, ['staged'], 'failed', input.errorCode); }
    catch (error) { if (error.message?.startsWith('Certificate bundle')) throw error; throw safeStoreError(); }
  }

  async function markRevocationPending(input) {
    if (typeof input?.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)) {
      throw new TypeError('Certificate revocation error code is invalid');
    }
    try { await updateState(input.bundleId, ['superseded'], 'revocation_pending', input.errorCode); }
    catch (error) { if (error.message?.startsWith('Certificate bundle')) throw error; throw safeStoreError(); }
  }

  async function markRevoked(input) {
    try { await updateState(input.bundleId, ['superseded', 'revocation_pending'], 'revoked'); }
    catch (error) { if (error.message?.startsWith('Certificate bundle')) throw error; throw safeStoreError(); }
  }

  return Object.freeze({
    getActive,
    stageCertificate,
    activateCertificate,
    markFailed,
    markRevocationPending,
    markRevoked,
  });
}
