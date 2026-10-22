ALTER TABLE followup_sessions ADD COLUMN ai_review jsonb;
CREATE TABLE voice_tickets (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  auth_session_id uuid NOT NULL REFERENCES auth_sessions(id),
  session_id uuid NOT NULL REFERENCES followup_sessions(id),
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('socket','audio')),
  session_version integer NOT NULL,
  resource_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_ticket_expiry ON voice_tickets(expires_at);
