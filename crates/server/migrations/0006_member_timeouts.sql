-- A running communication timeout survives leaving or being kicked: it is stored here and restored when the user rejoins.
CREATE TABLE guild_timeouts (
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
