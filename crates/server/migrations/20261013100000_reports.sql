-- Reports of messages and members (MOD-009). A DM message report has no guild (kept for the instance operator).
-- No foreign keys on users, channels or messages: a report outlives the message (it keeps a snapshot) and the accounts.
CREATE TABLE reports (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT REFERENCES guilds (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('message', 'user')),
    reporter_id BIGINT NOT NULL,
    target_user_id BIGINT NOT NULL,
    channel_id BIGINT,
    message_id BIGINT,
    message_content TEXT,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_by BIGINT,
    closed_at TIMESTAMPTZ
);
CREATE INDEX reports_guild ON reports (guild_id, status, id DESC);
-- One open report per reporter and target: reporting it again returns the open one.
CREATE UNIQUE INDEX reports_open_message ON reports (reporter_id, message_id) WHERE status = 'open' AND target_type = 'message';
CREATE UNIQUE INDEX reports_open_member ON reports (reporter_id, guild_id, target_user_id) WHERE status = 'open' AND target_type = 'user';
