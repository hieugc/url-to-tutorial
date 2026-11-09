-- UTV-009 replica certificate metadata. Private keys are held by an external
-- KMS/HSM-backed key provider; this table stores only opaque key references.

CREATE TABLE IF NOT EXISTS tutorial_replica_certificates (
  bundle_id uuid PRIMARY KEY,
  replica_id text NOT NULL CHECK (replica_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  serial_number text NOT NULL CHECK (serial_number ~ '^[A-Fa-f0-9]{1,64}$'),
  fingerprint256 char(64) NOT NULL CHECK (fingerprint256 ~ '^[a-f0-9]{64}$'),
  certificate_pem text NOT NULL CHECK (length(certificate_pem) BETWEEN 64 AND 65536),
  chain_pem text NOT NULL CHECK (length(chain_pem) BETWEEN 64 AND 262144),
  key_ref text NOT NULL CHECK (key_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,255}$'),
  public_key_fingerprint char(64) NOT NULL CHECK (public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$'),
  previous_bundle_id uuid,
  state text NOT NULL CHECK (state IN ('staged', 'active', 'superseded', 'failed', 'revocation_pending', 'revoked')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT tutorial_replica_certificate_validity CHECK (not_after > not_before)
);

CREATE UNIQUE INDEX IF NOT EXISTS tutorial_replica_certificates_one_active_idx
  ON tutorial_replica_certificates (replica_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS tutorial_replica_certificates_expiry_idx
  ON tutorial_replica_certificates (not_after)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS tutorial_replica_certificates_replica_history_idx
  ON tutorial_replica_certificates (replica_id, created_at DESC);
