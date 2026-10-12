-- Server Settings > Access: age-restricted server (Discord nsfw_level, only 0 and 3 are settable) and the rules channel.
ALTER TABLE guilds ADD COLUMN nsfw_level SMALLINT NOT NULL DEFAULT 0;
-- The foreign key clears it when the channel goes, even if a PATCH races the channel delete.
ALTER TABLE guilds ADD COLUMN rules_channel_id BIGINT REFERENCES channels (id) ON DELETE SET NULL;
