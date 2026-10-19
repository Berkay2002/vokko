-- Wrong current passwords on sensitive account routes, counted per account like mfa_failures (account::me::confirm_password).
CREATE TABLE password_failures (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_failures_user ON password_failures (user_id, failed_at);
