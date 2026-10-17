-- A guild's game catalog (docs/design/games-host.md section 4): web games its members can start in a call. The server validates
-- every field; the checks here only back up the shape.
CREATE TABLE guild_games (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    url TEXT NOT NULL CHECK (octet_length(url) <= 512),
    icon TEXT CHECK (octet_length(icon) <= 16),
    min_players SMALLINT NOT NULL CHECK (min_players BETWEEN 1 AND 16),
    max_players SMALLINT NOT NULL CHECK (max_players BETWEEN min_players AND 16),
    aspect TEXT NOT NULL DEFAULT '16:9' CHECK (aspect IN ('16:9', '4:3', '1:1', 'fill')),
    creator_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_games_guild ON guild_games (guild_id, id);
