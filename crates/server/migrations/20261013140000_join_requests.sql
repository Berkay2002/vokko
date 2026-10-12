-- Apply to Join: a guild's join mode (0 invite only, 1 apply), its member verification form and the join requests.
ALTER TABLE guilds ADD COLUMN join_mode SMALLINT NOT NULL DEFAULT 0;
CREATE TABLE guild_member_verification (
    guild_id BIGINT PRIMARY KEY REFERENCES guilds (id) ON DELETE CASCADE,
    description TEXT,
    form_fields JSONB NOT NULL
);
-- One request per user and guild; reapplying replaces the row. invite_code and inviter_id are copied from the invite used
-- (no foreign keys: the invite may expire or be revoked while the request waits).
CREATE TABLE guild_join_requests (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED')),
    form_responses JSONB NOT NULL,
    invite_code TEXT,
    inviter_id BIGINT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actioned_at TIMESTAMPTZ,
    actioned_by BIGINT,
    UNIQUE (guild_id, user_id)
);
CREATE INDEX guild_join_requests_list ON guild_join_requests (guild_id, status, id DESC);
