-- UTV-009 shared coordination state.
-- Apply once to the PostgreSQL database shared by all trusted control-plane hosts.
-- Never place bearer tokens, audit signing keys, MFA sessions or replica assertions here.

CREATE TABLE IF NOT EXISTS tutorial_publish_locks (
  resource text PRIMARY KEY,
  owner_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tutorial_publish_locks_resource_length
    CHECK (length(resource) BETWEEN 1 AND 512)
);

CREATE INDEX IF NOT EXISTS tutorial_publish_locks_expiry_idx
  ON tutorial_publish_locks (expires_at);
