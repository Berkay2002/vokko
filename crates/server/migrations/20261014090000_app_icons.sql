-- App icons for Playing activities: the server's own 64x64 PNG re-encode of an upload, keyed by the SHA-256 of those bytes.
CREATE TABLE app_icons (
    hash TEXT PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
    png BYTEA NOT NULL,
    uploader_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_icons_uploader ON app_icons (uploader_id);
