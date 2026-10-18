-- Server Settings > Engagement > Default Notification Settings: the level of members who set none for the server
-- (Discord's guild `default_message_notifications`: 0 all messages, 1 only mentions).
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS default_message_notifications SMALLINT NOT NULL DEFAULT 0;
