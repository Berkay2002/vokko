-- Community features: scheduled events, onboarding, friend suggestions.

-- GuildMember.flags (DID_REJOIN 1, COMPLETED_ONBOARDING 2, BYPASSES_VERIFICATION 4, STARTED_ONBOARDING 8).
ALTER TABLE guild_members ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;

-- status: 1 scheduled, 2 active, 3 completed, 4 canceled. entity_type: 1 stage, 2 voice, 3 external.
-- `recurrence` is the JSON of the recurrence rule as the client sent it (validated), or NULL.
CREATE TABLE scheduled_events (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    channel_id BIGINT REFERENCES channels (id) ON DELETE SET NULL,
    creator_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    status SMALLINT NOT NULL DEFAULT 1,
    entity_type SMALLINT NOT NULL,
    location TEXT,
    image_path TEXT,
    recurrence TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_events_guild ON scheduled_events (guild_id, starts_at, id);

-- An upload serving as an event cover belongs to its event alone: avatars, icons and banners refuse it, and only these rows are
-- deleted along with the event.
ALTER TABLE attachments ADD COLUMN event_cover BOOLEAN NOT NULL DEFAULT FALSE;

-- "Interested". Rows follow the membership: leaving, kicks and bans remove them.
CREATE TABLE scheduled_event_users (
    event_id BIGINT NOT NULL REFERENCES scheduled_events (id) ON DELETE CASCADE,
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members (guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX scheduled_event_users_member ON scheduled_event_users (guild_id, user_id);

-- One row per guild once somebody configures onboarding. `rules` is a JSON array of strings, NULL = no rules screen.
CREATE TABLE guild_onboarding (
    guild_id BIGINT PRIMARY KEY REFERENCES guilds (id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mode SMALLINT NOT NULL DEFAULT 0,
    default_channel_ids BIGINT[] NOT NULL DEFAULT '{}',
    rules_description TEXT,
    rules TEXT
);

-- kind: 0 multiple choice, 1 dropdown.
CREATE TABLE onboarding_prompts (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind SMALLINT NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    single_select BOOLEAN NOT NULL DEFAULT FALSE,
    required BOOLEAN NOT NULL DEFAULT FALSE,
    in_onboarding BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX onboarding_prompts_guild ON onboarding_prompts (guild_id, position);

-- channel_ids / role_ids are plain arrays: ids of deleted channels or roles are dropped when the option is read.
CREATE TABLE onboarding_options (
    id BIGINT PRIMARY KEY,
    prompt_id BIGINT NOT NULL REFERENCES onboarding_prompts (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    emoji_name TEXT,
    emoji_id BIGINT,
    channel_ids BIGINT[] NOT NULL DEFAULT '{}',
    role_ids BIGINT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX onboarding_options_prompt ON onboarding_options (prompt_id, position);

CREATE TABLE member_onboarding_answers (
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    option_id BIGINT NOT NULL REFERENCES onboarding_options (id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, option_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members (guild_id, user_id) ON DELETE CASCADE
);

-- Roles that onboarding itself added to a member. Answers can change and options can be edited, so what to take away again
-- when an answer is dropped is remembered here, not derived from the options. Roles a member held before are never listed.
CREATE TABLE member_onboarding_roles (
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members (guild_id, user_id) ON DELETE CASCADE
);

-- Friend suggestions: one switch for seeing suggestions and for being suggested, plus per-user dismissals.
ALTER TABLE users ADD COLUMN friend_suggestions BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE friend_suggestion_dismissals (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    other_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, other_id)
);
