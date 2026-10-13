-- The last 6 avatars each user set (Discord's "Recent avatars"). Rows are trimmed to 6 per user when an avatar is saved; a listed
-- upload counts as in use (media::IN_USE), so the pending-upload cleanup never deletes its file.
CREATE TABLE user_avatar_history (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    attachment_id BIGINT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
    used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, attachment_id)
);
CREATE INDEX user_avatar_history_attachment ON user_avatar_history (attachment_id);

-- Each current avatar is the first entry.
INSERT INTO user_avatar_history (user_id, attachment_id)
SELECT u.id, a.id FROM users u JOIN attachments a ON a.id::text = split_part(u.avatar_path, '/', 1) WHERE u.avatar_path IS NOT NULL;
