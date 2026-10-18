-- Inbox > Mentions: messages a user removed from their recent mentions (Discord's DELETE /users/@me/mentions/{message_id}).
CREATE TABLE mention_dismissals (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
);
