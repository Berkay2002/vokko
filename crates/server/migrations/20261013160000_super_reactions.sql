-- Super (burst) reactions: a user may add an emoji once as a normal reaction and once as a burst. No weekly burst limit in Vokko.
ALTER TABLE reactions ADD COLUMN burst BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reactions DROP CONSTRAINT reactions_pkey;
ALTER TABLE reactions ADD PRIMARY KEY (message_id, user_id, emoji_name, emoji_id, burst);

-- Remaining profile perks: nameplate and display name style (font, effect, one or two RGB colours), ids into the client's open set.
ALTER TABLE users
    ADD COLUMN nameplate TEXT,
    ADD COLUMN name_font TEXT,          -- name_font, name_effect and name_colors are set together or not at all
    ADD COLUMN name_effect TEXT,
    ADD COLUMN name_colors INTEGER[];
