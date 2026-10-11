-- Threads, forum channels and announcement follows. Threads are channels (kind 10 announcement thread, 11 public, 12 private) whose
-- parent_id is the text / announcement / forum channel; a thread started from a message (or a forum post) reuses the message id.
ALTER TABLE channels
    ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN locked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN invitable BOOLEAN NOT NULL DEFAULT TRUE,
    -- Threads: minutes of inactivity before the sweep archives it. Text, announcement and forum channels: the default for new threads.
    ADD COLUMN auto_archive_duration INTEGER,
    ADD COLUMN default_auto_archive_duration INTEGER,
    -- When `archived` last changed, and the inactivity clock (reset by every message and by unarchiving).
    ADD COLUMN archive_timestamp TIMESTAMPTZ,
    ADD COLUMN last_activity_at TIMESTAMPTZ,
    -- Channel flags: 1 << 1 PINNED (forum post), 1 << 4 REQUIRE_TAG (forum).
    ADD COLUMN flags INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN applied_tags BIGINT[] NOT NULL DEFAULT '{}',
    ADD COLUMN default_reaction_emoji_id BIGINT,
    ADD COLUMN default_reaction_emoji_name TEXT,
    ADD COLUMN default_sort_order INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN default_forum_layout INTEGER NOT NULL DEFAULT 1;

-- Threads of a parent, newest first (lists, search, parent deletion).
CREATE INDEX channels_threads ON channels (parent_id, id DESC) WHERE kind IN (10, 11, 12);
-- The auto-archive sweep only looks at open threads.
CREATE INDEX channels_open_threads ON channels (last_activity_at) WHERE kind IN (10, 11, 12) AND NOT archived;

CREATE TABLE forum_tags (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    moderated BOOLEAN NOT NULL DEFAULT FALSE,
    emoji_id BIGINT,
    emoji_name TEXT,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX forum_tags_channel ON forum_tags (channel_id, position);

CREATE TABLE thread_members (
    thread_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    flags INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX thread_members_user ON thread_members (user_id);

-- A follow delivers the published messages of an announcement channel (source) into another channel (target).
CREATE TABLE channel_follows (
    id BIGINT PRIMARY KEY,
    source_channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    target_channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    created_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_channel_id, target_channel_id)
);
CREATE INDEX channel_follows_target ON channel_follows (target_channel_id);

-- A message reference can point into another channel: the starter message of a thread (the parent channel), the system message
-- announcing a thread (the thread) and a published copy (the source message's channel and guild). NULL = the message's own channel.
ALTER TABLE messages
    ADD COLUMN reference_channel_id BIGINT,
    ADD COLUMN reference_guild_id BIGINT;
