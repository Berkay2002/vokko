-- Guild stickers, GIF favourites, forwards (snapshots), bookmarks and reminders.

-- The image is a claimed attachment (`attachments.sticker_asset`), so it is served by the normal attachment route.
CREATE TABLE stickers (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    tags TEXT NOT NULL,
    format SMALLINT NOT NULL,
    attachment_id BIGINT NOT NULL,
    asset_path TEXT NOT NULL,          -- "<attachment id>/<key>/<filename>"
    creator_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stickers_guild ON stickers (guild_id, id);

-- A message keeps a copy of what it needs, so it survives the sticker being deleted (the file is kept while referenced).
CREATE TABLE message_stickers (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    sticker_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    format SMALLINT NOT NULL,
    attachment_id BIGINT NOT NULL,
    asset_path TEXT NOT NULL,
    -- TRUE for the stickers inside a forward's snapshot: they keep the file alive but are not the message's own sticker_items.
    snapshot BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (message_id, position)
);
CREATE INDEX message_stickers_attachment ON message_stickers (attachment_id);

ALTER TABLE attachments ADD COLUMN sticker_asset BOOLEAN NOT NULL DEFAULT FALSE;
-- Files copied for a forward: they belong to the forwarded message but are listed in its snapshot, not in `attachments`.
ALTER TABLE attachments ADD COLUMN snapshot BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE messages ADD COLUMN forward_channel_id BIGINT;
ALTER TABLE messages ADD COLUMN forward_message_id BIGINT;
ALTER TABLE messages ADD COLUMN forward_guild_id BIGINT;
ALTER TABLE messages ADD COLUMN snapshot JSONB;      -- `MessageSnapshot`

CREATE TABLE gif_favorites (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    gif_id TEXT NOT NULL,
    data JSONB NOT NULL,                              -- the whole `Gif`
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, gif_id)
);
CREATE INDEX gif_favorites_user ON gif_favorites (user_id, created_at DESC);

CREATE TABLE bookmarks (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX bookmarks_user ON bookmarks (user_id, created_at DESC);

CREATE TABLE reminders (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    remind_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    UNIQUE (user_id, message_id)
);
CREATE INDEX reminders_due ON reminders (remind_at) WHERE delivered_at IS NULL;
CREATE INDEX reminders_user ON reminders (user_id, remind_at);
