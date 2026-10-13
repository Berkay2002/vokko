-- The recent-avatars table also holds recent banners (Discord's "Recent banners"): a `kind` column and a primary key that includes it,
-- instead of a second table, so media::IN_USE and the account delete keep working through this one table.
ALTER TABLE user_avatar_history RENAME TO user_image_history;
ALTER INDEX user_avatar_history_attachment RENAME TO user_image_history_attachment;
ALTER TABLE user_image_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'avatar' CHECK (kind IN ('avatar', 'banner'));
ALTER TABLE user_image_history DROP CONSTRAINT user_avatar_history_pkey, ADD PRIMARY KEY (user_id, kind, attachment_id);

-- Each current banner is the first entry.
INSERT INTO user_image_history (user_id, kind, attachment_id)
SELECT u.id, 'banner', a.id FROM users u JOIN attachments a ON a.id::text = split_part(u.banner_path, '/', 1) WHERE u.banner_path IS NOT NULL;
