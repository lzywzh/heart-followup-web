ALTER TABLE accounts
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN credential_version integer NOT NULL DEFAULT 0 CHECK (credential_version >= 0);
ALTER TABLE auth_sessions
  ADD COLUMN credential_version integer NOT NULL DEFAULT 0 CHECK (credential_version >= 0);
