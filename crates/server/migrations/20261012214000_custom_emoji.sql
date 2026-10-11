-- Custom guild emoji. The image is an attachment row (claimed like avatars/icons) so the file store serves it.
CREATE TABLE emojis (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    animated BOOLEAN NOT NULL,
    attachment_id BIGINT NOT NULL REFERENCES attachments (id),
    uploader_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emojis_guild ON emojis (guild_id, id);

-- Roles allowed to use an emoji; none = every member.
CREATE TABLE emoji_roles (
    emoji_id BIGINT NOT NULL REFERENCES emojis (id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (emoji_id, role_id)
);
