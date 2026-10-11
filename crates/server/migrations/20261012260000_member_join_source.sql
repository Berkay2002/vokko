-- Members page: how a member joined. Set when an invite is accepted; rows from before stay NULL / 0 and read as "Unknown".
-- join_source_type uses Discord's values (0 unspecified, 5 invite).
ALTER TABLE guild_members ADD COLUMN source_invite_code TEXT;
ALTER TABLE guild_members ADD COLUMN inviter_id BIGINT;
ALTER TABLE guild_members ADD COLUMN join_source_type SMALLINT NOT NULL DEFAULT 0;

-- members-search: the default sort (member since) and the join-method filter, both within one guild.
CREATE INDEX guild_members_joined ON guild_members (guild_id, joined_at, user_id);
CREATE INDEX guild_members_invite ON guild_members (guild_id, source_invite_code) WHERE source_invite_code IS NOT NULL;
