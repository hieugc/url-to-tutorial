-- UTV-009 break-glass dual-control approval ledger.
-- Stores action metadata only. Never persist bearer tokens, MFA assertions,
-- certificates, private keys, audit signing keys or raw provider responses.

CREATE TABLE IF NOT EXISTS tutorial_break_glass_requests (
  request_id uuid PRIMARY KEY,
  action_type text NOT NULL CHECK (action_type IN ('revoke_token', 'revoke_principal')),
  resource_id text NOT NULL CHECK (resource_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 20 AND 500),
  proposer_id text NOT NULL CHECK (proposer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$'),
  approver_id text CHECK (approver_id ~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$'),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'executing', 'completed', 'failed')),
  expires_at timestamptz NOT NULL,
  execution_token uuid,
  result_code text CHECK (result_code IS NULL OR result_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT tutorial_break_glass_distinct_operators
    CHECK (approver_id IS NULL OR approver_id <> proposer_id),
  CONSTRAINT tutorial_break_glass_execution_token_state
    CHECK ((state IN ('executing', 'completed', 'failed') AND execution_token IS NOT NULL)
        OR (state IN ('pending', 'approved') AND execution_token IS NULL))
);

CREATE INDEX IF NOT EXISTS tutorial_break_glass_expiry_idx
  ON tutorial_break_glass_requests (expires_at)
  WHERE state IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS tutorial_break_glass_created_idx
  ON tutorial_break_glass_requests (created_at DESC);
