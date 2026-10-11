-- Vokko server schema v1. Ids are snowflakes stored as BIGINT.

CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    global_name TEXT,
    avatar_path TEXT,            -- "<attachment id>/<filename>"
    banner_color TEXT,
    bio TEXT,
    bot BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY, -- SHA-256 of the 32 random token bytes
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Last known effective presence; seeded rows show up in READY before anybody connects.
CREATE TABLE presences (
    user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'offline',
    custom_status TEXT
);

CREATE TABLE guilds (
    id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_path TEXT,
    owner_id BIGINT NOT NULL REFERENCES users (id),
    system_channel_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The @everyone role has id == guild id.
CREATE TABLE roles (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color INTEGER NOT NULL DEFAULT 0,
    hoist BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0,
    permissions BIGINT NOT NULL DEFAULT 0,
    mentionable BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX roles_guild ON roles (guild_id);

CREATE TABLE guild_members (
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    nick TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_members_user ON guild_members (user_id);

CREATE TABLE member_roles (
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members (guild_id, user_id) ON DELETE CASCADE
);

-- type: 0 text, 1 DM, 2 voice, 3 group DM, 4 category
CREATE TABLE channels (
    id BIGINT PRIMARY KEY,
    kind SMALLINT NOT NULL,
    guild_id BIGINT REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT,
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    parent_id BIGINT,
    owner_id BIGINT,
    icon_path TEXT,
    last_message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channels_guild ON channels (guild_id);

CREATE TABLE channel_recipients (
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    closed BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_recipients_user ON channel_recipients (user_id);

-- target_type: 0 role, 1 member
CREATE TABLE permission_overwrites (
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL,
    target_type SMALLINT NOT NULL,
    allow BIGINT NOT NULL DEFAULT 0,
    deny BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_id)
);

-- type: 0 default, 6 pin notice, 7 join, 19 reply
CREATE TABLE messages (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES users (id),
    content TEXT NOT NULL DEFAULT '',
    kind SMALLINT NOT NULL DEFAULT 0,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    reference_message_id BIGINT,
    mention_everyone BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ
);
CREATE INDEX messages_channel ON messages (channel_id, id DESC);

CREATE TABLE message_mentions (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

CREATE TABLE message_role_mentions (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL,
    PRIMARY KEY (message_id, role_id)
);

-- message_id is NULL while the upload is pending.
CREATE TABLE attachments (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL,
    uploader_id BIGINT NOT NULL,
    message_id BIGINT REFERENCES messages (id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size BIGINT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message ON attachments (message_id);

-- emoji_id 0 = unicode emoji
CREATE TABLE reactions (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    emoji_name TEXT NOT NULL,
    emoji_id BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji_name, emoji_id)
);

CREATE TABLE read_states (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    last_message_id BIGINT,
    mention_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

-- Stored in both directions: A→B outgoing (4) with B→A incoming (3); accepted = friend (1) on both rows.
CREATE TABLE relationships (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    other_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, other_id)
);

CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    inviter_id BIGINT NOT NULL,
    max_age INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
