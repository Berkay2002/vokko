-- Accounts step 3: TOTP two-factor, backup codes, login tickets, session device info.
ALTER TABLE users ADD COLUMN mfa_secret TEXT;          -- base32 TOTP secret; NULL = two-factor off
ALTER TABLE users ADD COLUMN mfa_last_step BIGINT;     -- last accepted 30 s step, so a code is never accepted twice

CREATE TABLE mfa_backup_codes (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash BYTEA NOT NULL,                          -- SHA-256 of user id + code
    position SMALLINT NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, code_hash)
);

-- Password checked, second factor pending.
CREATE TABLE mfa_tickets (
    ticket_hash BYTEA PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE sessions ADD COLUMN client_os TEXT;
ALTER TABLE sessions ADD COLUMN client_platform TEXT;
ALTER TABLE sessions ADD COLUMN last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
