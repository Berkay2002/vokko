-- Website games (docs/design/games-host.md section 7): `web` games run their own lobby and get a looser frame sandbox.
-- IF NOT EXISTS: dev databases that ran this file under its first number (20261017130000) already have the column.
ALTER TABLE guild_games ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sdk' CHECK (kind IN ('sdk', 'web'));
