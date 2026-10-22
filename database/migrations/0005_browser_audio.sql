CREATE TABLE browser_audio_requests (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES followup_sessions(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  client_message_id text NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0),
  payload_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('processing','completed','failed')),
  attempt_token uuid NOT NULL,
  lease_until timestamptz,
  transcript text,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,client_message_id)
);
CREATE INDEX browser_audio_active_idx ON browser_audio_requests(session_id,status);
