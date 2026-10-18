-- Per-user notification settings for each guild (guild_id 0 = DMs): Discord's user guild settings, stored whole as JSON.
CREATE TABLE user_guild_settings (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    guild_id BIGINT NOT NULL,
    settings JSONB NOT NULL,
    PRIMARY KEY (user_id, guild_id)
);
