-- Invite settings and per-user client settings (server folders and rail order).
ALTER TABLE invites ADD COLUMN temporary BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX invites_guild ON invites (guild_id);
CREATE INDEX invites_channel ON invites (channel_id);
-- Invites of channels that no longer exist lead nowhere.
DELETE FROM invites i WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = i.channel_id);

-- Joined through a temporary invite: removed when the user's last gateway connection closes, unless they have a role then.
ALTER TABLE guild_members ADD COLUMN temporary BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE user_guild_layout (
    user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    -- [{id, name, color, guild_ids}] exactly as the API shape (ids as strings).
    guild_folders TEXT NOT NULL DEFAULT '[]',
    guild_positions BIGINT[] NOT NULL DEFAULT '{}'
);
