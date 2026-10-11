-- Profile perks (free for everyone): banner, pronouns, theme colours, decoration, effect, server tag adoption.
ALTER TABLE users
    ADD COLUMN banner_path TEXT,            -- "<attachment id>/<key>/<filename>" like avatar_path
    ADD COLUMN pronouns TEXT,
    ADD COLUMN theme_primary INTEGER,       -- RGB int; both theme columns are set together or not at all
    ADD COLUMN theme_accent INTEGER,
    ADD COLUMN avatar_decoration TEXT,      -- id in the client's open asset set
    ADD COLUMN profile_effect TEXT,
    -- The server tag the user shows; only reported while they are still a member and the guild still has a tag.
    ADD COLUMN primary_guild_id BIGINT REFERENCES guilds (id) ON DELETE SET NULL;

-- Server tag (all four tag columns together) and server profile theme (primary + accent, optional preset id).
ALTER TABLE guilds
    ADD COLUMN tag TEXT,
    ADD COLUMN tag_badge TEXT,
    ADD COLUMN tag_color_primary INTEGER,
    ADD COLUMN tag_color_secondary INTEGER,
    ADD COLUMN theme_preset TEXT,
    ADD COLUMN theme_primary INTEGER,
    ADD COLUMN theme_accent INTEGER;

-- Per-server member profile; NULL = use the user's own.
ALTER TABLE guild_members
    ADD COLUMN avatar_path TEXT,
    ADD COLUMN banner_path TEXT,
    ADD COLUMN bio TEXT,
    ADD COLUMN pronouns TEXT,
    ADD COLUMN theme_primary INTEGER,
    ADD COLUMN theme_accent INTEGER;

CREATE INDEX users_primary_guild ON users (primary_guild_id) WHERE primary_guild_id IS NOT NULL;
