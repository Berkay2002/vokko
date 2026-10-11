-- Stage channels (type 13): at most one live stage instance per channel; deleting the channel ends it.
CREATE TABLE stage_instances (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL UNIQUE REFERENCES channels (id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    privacy_level SMALLINT NOT NULL DEFAULT 2
);
CREATE INDEX stage_instances_guild ON stage_instances (guild_id);
-- Server mute / deafen (MUTE_MEMBERS / DEAFEN_MEMBERS): kept across voice leave and rejoin.
ALTER TABLE guild_members ADD COLUMN mute BOOLEAN NOT NULL DEFAULT false, ADD COLUMN deaf BOOLEAN NOT NULL DEFAULT false;
