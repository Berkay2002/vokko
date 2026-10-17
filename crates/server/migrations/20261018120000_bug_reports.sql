-- "Report a problem" from the client: the user's text, app version, OS and a scrubbed tail of the client log.
-- Read with psql (docs/self-hosting.md "Problem reports"); rows older than 30 days are deleted by the server.
CREATE TABLE bug_reports (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    description TEXT NOT NULL,
    app_version TEXT NOT NULL,
    os TEXT NOT NULL,
    logs TEXT NOT NULL
);
CREATE INDEX bug_reports_created ON bug_reports (created_at DESC);
