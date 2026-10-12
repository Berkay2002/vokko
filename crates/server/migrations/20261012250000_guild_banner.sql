-- Server banner: a claimed upload (`<attachment id>/<key>/<filename>`), served like the icon.
ALTER TABLE guilds ADD COLUMN banner_path TEXT;
