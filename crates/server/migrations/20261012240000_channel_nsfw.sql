-- Age-restricted ("NSFW") flag on guild text, announcement, forum and voice channels.
ALTER TABLE channels ADD COLUMN nsfw BOOLEAN NOT NULL DEFAULT FALSE;
