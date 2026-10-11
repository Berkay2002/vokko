-- Accounts security review: fresh re-authentication of a session, failed second-factor attempts per account.
ALTER TABLE sessions ADD COLUMN reauth_at TIMESTAMPTZ;   -- last sign-in or re-confirmation through a linked provider

CREATE TABLE mfa_failures (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_failures_user ON mfa_failures (user_id, failed_at);
