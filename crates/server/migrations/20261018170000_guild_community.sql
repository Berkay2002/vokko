-- Server Settings > Enable Community: the COMMUNITY feature flag and the channel Discord posts community updates to.
ALTER TABLE guilds ADD COLUMN community BOOLEAN NOT NULL DEFAULT false;
-- The foreign key clears it when the channel goes, even if a PATCH races the channel delete.
ALTER TABLE guilds ADD COLUMN public_updates_channel_id BIGINT REFERENCES channels (id) ON DELETE SET NULL;
