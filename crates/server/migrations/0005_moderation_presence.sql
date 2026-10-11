-- Bans: a banned user cannot rejoin through an invite until unbanned.
CREATE TABLE guild_bans (
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason TEXT,
    banned_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);

-- The status the user chose (online, idle, dnd, invisible); `status` stays what others see right now.
ALTER TABLE presences ADD COLUMN preferred TEXT NOT NULL DEFAULT 'online';
UPDATE presences SET preferred = status WHERE status IN ('idle', 'dnd');
