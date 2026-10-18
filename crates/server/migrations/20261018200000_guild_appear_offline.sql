-- Guilds where the user appears offline (the guild menu's Privacy Settings): members who share only such guilds with the
-- user see them offline and get no typing from them there. Kept after leaving the guild, so the choice holds on rejoin.
CREATE TABLE guild_appear_offline (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, guild_id)
);
