-- Automatic crash and error reports from the client (JS errors, unhandled rejections, desktop panics). No user id, message text
-- or other personal data: version, OS, the route with ids replaced, and the scrubbed stack. Read with psql (docs/self-hosting.md
-- "Crash reports"); rows older than 30 days are deleted by the server.
CREATE TABLE crash_reports (
    id BIGINT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL,
    app_version TEXT NOT NULL,
    os TEXT NOT NULL,
    route TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT NOT NULL
);
CREATE INDEX crash_reports_created ON crash_reports (created_at DESC);
