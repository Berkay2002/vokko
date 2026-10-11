-- Synced user settings (one JSON blob per user with an optimistic-concurrency version) and the data-export throttle.
CREATE TABLE user_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    version BIGINT NOT NULL DEFAULT 0,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Last successful GET /users/@me/export (one per 24 h).
    last_export_at TIMESTAMPTZ
);
