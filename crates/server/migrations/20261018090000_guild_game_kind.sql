-- Website games (docs/design/games-host.md section 7): `web` games run their own lobby and get a looser frame sandbox.
ALTER TABLE guild_games ADD COLUMN kind TEXT NOT NULL DEFAULT 'sdk' CHECK (kind IN ('sdk', 'web'));
