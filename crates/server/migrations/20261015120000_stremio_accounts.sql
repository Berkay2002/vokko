-- A user's linked Stremio account. Only the authKey is stored (never the password), sealed with XChaCha20-Poly1305 under
-- VOKKO_SECRETS_KEY; the associated data is "stremio:" || user_id, so a row copied to another user does not open.
CREATE TABLE stremio_accounts (
    user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_key_enc BYTEA NOT NULL,
    key_version  SMALLINT NOT NULL DEFAULT 1,
    linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
