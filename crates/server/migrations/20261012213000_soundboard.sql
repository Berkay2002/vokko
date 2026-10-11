-- Soundboard sounds and entrance sounds (docs/api.md "Soundboard and entrance sounds").

-- The audio file is a claimed attachment (`attachments.sound_asset`), served by the normal attachment route.
CREATE TABLE soundboard_sounds (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    volume DOUBLE PRECISION NOT NULL DEFAULT 1,
    emoji_id BIGINT,
    emoji_name TEXT,
    attachment_id BIGINT NOT NULL,
    asset_path TEXT NOT NULL,          -- "<attachment id>/<key>/<filename>"
    duration_ms INTEGER NOT NULL,
    creator_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX soundboard_sounds_guild ON soundboard_sounds (guild_id, id);

ALTER TABLE attachments ADD COLUMN sound_asset BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per user and scope: `scope_guild_id` 0 = global (every guild without its own).
-- `source_guild_id` NULL = a default sound. A deleted sound simply stops resolving.
CREATE TABLE entrance_sounds (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope_guild_id BIGINT NOT NULL,
    sound_id BIGINT NOT NULL,
    source_guild_id BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope_guild_id)
);

-- Free external sounds: an existing guild's @everyone role (id = guild id) that may use the soundboard (USE_SOUNDBOARD, bit 42)
-- gets USE_EXTERNAL_SOUNDS (bit 45) too; a guild that turned the soundboard off for everyone stays off.
UPDATE roles SET permissions = permissions | (1::bigint << 45) WHERE id = guild_id AND permissions & (1::bigint << 42) <> 0;
