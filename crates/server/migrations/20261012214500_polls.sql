-- Polls: a poll belongs to one message (same id) and dies with it. Answers are numbered 1..n per poll; votes are per user and answer.
CREATE TABLE polls (
    message_id BIGINT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    allow_multiselect BOOLEAN NOT NULL DEFAULT FALSE,
    layout_type SMALLINT NOT NULL DEFAULT 1,
    -- Votes are refused from this moment on; "End Poll Now" moves it to now().
    expiry TIMESTAMPTZ NOT NULL,
    -- Set exactly once, by whoever ends the poll first (sweep or End Poll Now); the result message is posted by that caller.
    finalized BOOLEAN NOT NULL DEFAULT FALSE
);
-- The expiry sweep only looks at open polls.
CREATE INDEX polls_open ON polls (expiry) WHERE NOT finalized;

CREATE TABLE poll_answers (
    message_id BIGINT NOT NULL REFERENCES polls (message_id) ON DELETE CASCADE,
    answer_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    emoji_id BIGINT,
    emoji_name TEXT,
    PRIMARY KEY (message_id, answer_id)
);

CREATE TABLE poll_votes (
    message_id BIGINT NOT NULL,
    answer_id INTEGER NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, answer_id, user_id),
    FOREIGN KEY (message_id, answer_id) REFERENCES poll_answers (message_id, answer_id) ON DELETE CASCADE
);
-- "Which answers did this user pick" (vote moves, me_voted).
CREATE INDEX poll_votes_user ON poll_votes (message_id, user_id);
