-- Profile board widgets (favourite game, games I like). The validated, normalised value as JSON:
-- {"favorite_game": {"name", "image_path", "reason", "tags"}, "games_i_like": [{"name", "image_path"}]}
-- where `image_path` is "<attachment id>/<key>/<filename>" like avatar_path. NULL = no widgets.
ALTER TABLE users ADD COLUMN widgets JSONB;
