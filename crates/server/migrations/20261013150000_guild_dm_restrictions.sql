-- Guilds whose members (non-friends) may not DM the user: the guild menu's Privacy Settings, Discord's `restricted_guilds`.
-- Kept after leaving the guild, so the choice still holds on rejoin.
CREATE TABLE guild_dm_restrictions (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, guild_id)
);
