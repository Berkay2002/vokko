-- Slowmode: seconds between a member's messages in a channel (0 = off), and when each author last sent in a slowmode channel.
ALTER TABLE channels ADD COLUMN rate_limit_per_user INTEGER NOT NULL DEFAULT 0;
CREATE TABLE slowmode_sends (
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sent_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);
