-- Accounts security review, round 2.
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;      -- when the current address was verified
UPDATE users SET email_verified_at = now() WHERE email_verified;
ALTER TABLE mfa_failures ADD COLUMN id BIGSERIAL PRIMARY KEY;    -- attempts are recorded first, then removed when right
