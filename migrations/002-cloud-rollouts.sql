-- UTV-009 durable multi-replica credential rollout state.
-- Stores only revision/digest, replica IDs, acknowledgement metadata and safe error codes.
-- Never persist bearer tokens, audit key bytes, MFA assertions or certificates here.

CREATE TABLE IF NOT EXISTS tutorial_rollout_control (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  current_version text NOT NULL DEFAULT '0'
    CHECK (current_version ~ '^(0|[1-9][0-9]{0,127})$'),
  current_rollout_id text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO tutorial_rollout_control (singleton_id, current_version)
VALUES (1, '0')
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tutorial_credential_rollouts (
  rollout_id text PRIMARY KEY
    CHECK (rollout_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
  target_version text NOT NULL
    CHECK (target_version ~ '^(0|[1-9][0-9]{0,127})$'),
  snapshot_digest char(64) NOT NULL
    CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL
    CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$'),
  replica_ids jsonb NOT NULL
    CHECK (jsonb_typeof(replica_ids) = 'array' AND jsonb_array_length(replica_ids) > 0),
  state text NOT NULL CHECK (state IN ('in_progress', 'partial', 'completed')),
  acknowledged jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(acknowledged) = 'object'),
  failures jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(failures) = 'object'),
  failed_replica_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(failed_replica_ids) = 'array'),
  lease_owner uuid,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS tutorial_credential_rollouts_single_active_idx
  ON tutorial_credential_rollouts ((1))
  WHERE state IN ('in_progress', 'partial');

CREATE INDEX IF NOT EXISTS tutorial_credential_rollouts_updated_idx
  ON tutorial_credential_rollouts (updated_at DESC);
