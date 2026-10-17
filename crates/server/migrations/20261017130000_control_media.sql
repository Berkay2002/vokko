-- Control Media (docs/design/bot-control.md section 3.5): Vokko's permission bit 60 lets members pause, seek, skip, stop and reorder
-- Watch Together, Stremio and Spotify. It is on @everyone by default, so every existing @everyone role (id = guild id) gains it;
-- other roles and overwrites stay as they are. No audit log entry: it changes no effective permission.
UPDATE roles SET permissions = permissions | 1152921504606846976 WHERE id = guild_id;
