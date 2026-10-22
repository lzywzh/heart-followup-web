ALTER TABLE followup_turns ADD COLUMN attempt_token uuid;
ALTER TABLE background_jobs ADD COLUMN attempt_token uuid;
