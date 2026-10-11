-- Accounts step 1: date of birth, email verification (pending_email holds a requested change until it is verified).
ALTER TABLE users ADD COLUMN date_of_birth DATE;
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN pending_email TEXT;

-- Emailed single-use tokens (purpose 'verify' or 'reset'), SHA-256 of the 32 random bytes.
CREATE TABLE email_tokens (
    token_hash BYTEA PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);
