CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('admin','clinician','patient')),
  display_name text NOT NULL,
  login_name text UNIQUE,
  password_hash text,
  wx_openid text UNIQUE,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  access_hash text NOT NULL UNIQUE,
  refresh_hash text UNIQUE,
  csrf_token text,
  kind text NOT NULL CHECK (kind IN ('web','patient')),
  expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE patient_records (
  id uuid PRIMARY KEY,
  clinician_id uuid NOT NULL REFERENCES accounts(id),
  account_id uuid UNIQUE REFERENCES accounts(id),
  name text NOT NULL,
  birth_date date NOT NULL CHECK (birth_date >= '1900-01-01'),
  sex text NOT NULL DEFAULT 'unspecified' CHECK (sex IN ('male','female','unspecified')),
  phone text NOT NULL DEFAULT '',
  emergency_contact text NOT NULL DEFAULT '',
  emergency_phone text NOT NULL DEFAULT '',
  personal_notes text NOT NULL DEFAULT '',
  medical_record jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_clinician_idx ON patient_records(clinician_id,created_at DESC);
CREATE TABLE medical_record_versions (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patient_records(id),
  author_id uuid NOT NULL REFERENCES accounts(id),
  record jsonb NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(patient_id,version)
);
CREATE TABLE correction_requests (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patient_records(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE TABLE patient_invitations (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patient_records(id),
  clinician_id uuid NOT NULL REFERENCES accounts(id),
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  claimed_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE binding_requests (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL UNIQUE REFERENCES patient_invitations(id),
  patient_id uuid NOT NULL REFERENCES patient_records(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  evidence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
  verification_method text,
  reviewed_by uuid REFERENCES accounts(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX binding_one_pending_account ON binding_requests(account_id) WHERE status='pending';
CREATE UNIQUE INDEX binding_one_pending_patient ON binding_requests(patient_id) WHERE status='pending';
CREATE TABLE followup_tasks (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patient_records(id),
  clinician_id uuid NOT NULL REFERENCES accounts(id),
  title text NOT NULL DEFAULT '心衰随访',
  scheduled_at timestamptz NOT NULL,
  opens_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','submitted','reviewed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(opens_at <= scheduled_at)
);
CREATE INDEX tasks_due_idx ON followup_tasks(clinician_id,status,scheduled_at);
CREATE TABLE followup_sessions (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patient_records(id),
  clinician_id uuid NOT NULL REFERENCES accounts(id),
  task_id uuid UNIQUE REFERENCES followup_tasks(id),
  start_key text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','awaiting_confirmation','submitted','handoff','cancelled')),
  protocol_version text NOT NULL DEFAULT 'heart-failure-draft-v1',
  protocol_approved boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  state jsonb NOT NULL DEFAULT '{}',
  priority text NOT NULL DEFAULT 'routine' CHECK(priority IN ('routine','attention','urgent')),
  summary jsonb,
  patient_confirmed boolean NOT NULL DEFAULT false,
  submission_version integer,
  review_status text NOT NULL DEFAULT 'none' CHECK(review_status IN ('none','pending','reviewed')),
  feedback text,
  feedback_published boolean NOT NULL DEFAULT false,
  clinician_summary jsonb,
  reviewed_by uuid REFERENCES accounts(id),
  reviewed_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  UNIQUE(patient_id,start_key)
);
CREATE UNIQUE INDEX one_active_patient_session ON followup_sessions(patient_id) WHERE status IN ('active','paused','awaiting_confirmation');
CREATE TABLE followup_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES followup_sessions(id),
  client_message_id text NOT NULL,
  sequence integer NOT NULL,
  patient_text text NOT NULL,
  assistant_text text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'text' CHECK(source IN ('text','voice','correction')),
  supersedes_id uuid REFERENCES followup_turns(id),
  session_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
  lease_until timestamptz,
  evidence jsonb NOT NULL DEFAULT '[]',
  timing jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,client_message_id), UNIQUE(session_id,sequence)
);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES followup_sessions(id),
  turn_id uuid REFERENCES followup_turns(id),
  session_version integer NOT NULL,
  role text NOT NULL,
  provider text NOT NULL,
  model text,
  prompt_version text NOT NULL DEFAULT 'v1',
  output jsonb NOT NULL,
  elapsed_ms integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clinician_reviews (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES followup_sessions(id),
  author_id uuid NOT NULL REFERENCES accounts(id),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE background_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  session_id uuid NOT NULL REFERENCES followup_sessions(id),
  session_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','stale')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,session_id,session_version)
);
CREATE INDEX jobs_queue_idx ON background_jobs(status,available_at);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES accounts(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clinical_protocols (
  version text PRIMARY KEY,
  approved_by uuid REFERENCES accounts(id),
  approved_at timestamptz,
  approval_note text
);
INSERT INTO clinical_protocols(version) VALUES('heart-failure-draft-v1');
