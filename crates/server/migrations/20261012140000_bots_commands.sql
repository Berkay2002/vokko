-- Applications (bots), application commands, interactions, webhooks and ephemeral interaction messages.

-- An application owns a bot user with the same id (users.bot = TRUE, no password). Its token lives in `sessions` like a user's,
-- but it is only accepted with the `Bot ` prefix (and user tokens only without it).
CREATE TABLE applications (
    id BIGINT PRIMARY KEY REFERENCES users (id),
    owner_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_path TEXT,
    bot_public BOOLEAN NOT NULL DEFAULT TRUE,
    install_permissions BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX applications_owner ON applications (owner_id);

-- Who added a bot to a guild and the role made for it (the membership itself is a guild_members row).
CREATE TABLE guild_integrations (
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    application_id BIGINT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
    added_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    role_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, application_id)
);

-- kind: 1 CHAT_INPUT, 2 USER, 3 MESSAGE. guild_id NULL = global command.
CREATE TABLE application_commands (
    id BIGINT PRIMARY KEY,
    application_id BIGINT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
    guild_id BIGINT REFERENCES guilds (id) ON DELETE CASCADE,
    kind SMALLINT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    options JSONB NOT NULL DEFAULT '[]',
    default_member_permissions BIGINT,
    dm_permission BOOLEAN NOT NULL DEFAULT TRUE,
    version BIGINT NOT NULL
);
CREATE UNIQUE INDEX application_commands_name ON application_commands (application_id, COALESCE(guild_id, 0), kind, name);
CREATE INDEX application_commands_guild ON application_commands (guild_id) WHERE guild_id IS NOT NULL;

-- One run of a command. The token (sent to the bot once) is stored as SHA-256. `responded` flips on the callback;
-- `original_message_id` is the response message (in `messages`, or in `ephemeral_messages` when `original_ephemeral`).
CREATE TABLE interactions (
    id BIGINT PRIMARY KEY,
    application_id BIGINT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    kind SMALLINT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    guild_id BIGINT,
    command_id BIGINT NOT NULL,
    command_name TEXT NOT NULL,
    command_type SMALLINT NOT NULL,
    target_id BIGINT,
    nonce TEXT,
    responded BOOLEAN NOT NULL DEFAULT FALSE,
    original_message_id BIGINT,
    original_ephemeral BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX interactions_created ON interactions (created_at);

-- Incoming webhooks. Each has a hidden users row with the same id (bot = TRUE, no password) so its messages keep a real author_id.
CREATE TABLE webhooks (
    id BIGINT PRIMARY KEY REFERENCES users (id),
    kind SMALLINT NOT NULL DEFAULT 1,
    guild_id BIGINT REFERENCES guilds (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    avatar_path TEXT,
    token TEXT NOT NULL,
    creator_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    application_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_channel ON webhooks (channel_id);
CREATE INDEX webhooks_guild ON webhooks (guild_id);

-- Webhook and interaction messages: the identity shown instead of the author's profile, and who ran the command.
ALTER TABLE messages
    ADD COLUMN webhook_id BIGINT,
    ADD COLUMN application_id BIGINT,
    ADD COLUMN webhook_name TEXT,
    ADD COLUMN webhook_avatar TEXT,
    ADD COLUMN interaction_metadata JSONB;

-- Ephemeral interaction messages live only here, visible to `recipient_id` alone; `payload` is the wire `Message`.
CREATE TABLE ephemeral_messages (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    recipient_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    interaction_id BIGINT,
    application_id BIGINT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ephemeral_messages_channel ON ephemeral_messages (channel_id, recipient_id, id DESC);
