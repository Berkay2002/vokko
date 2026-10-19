-- When an emailed token went out, for the one-mail-a-minute cooldown on verification resends and password resets
-- (it was derived from expires_at minus the TTL before).
ALTER TABLE email_tokens ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
