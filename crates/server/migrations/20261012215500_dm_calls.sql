-- DM and group DM calls: the call record behind a type 3 message. `ended_at` NULL = the call is ongoing (or the server stopped
-- before it ended; startup ends calls nobody is left in).
CREATE TABLE message_calls (
    message_id BIGINT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    participants BIGINT[] NOT NULL DEFAULT '{}',
    region TEXT,
    ended_at TIMESTAMPTZ
);
-- At most one ongoing call per channel.
CREATE UNIQUE INDEX message_calls_ongoing ON message_calls (channel_id) WHERE ended_at IS NULL;
