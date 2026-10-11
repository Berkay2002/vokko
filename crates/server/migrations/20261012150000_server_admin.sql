-- Server admin parity: role icons, safety setup, audit log, AutoMod keyword rules.

ALTER TABLE roles ADD COLUMN unicode_emoji TEXT;

ALTER TABLE guilds ADD COLUMN verification_level SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN explicit_content_filter SMALLINT NOT NULL DEFAULT 0;

-- One row per audited action. `changes` and `options` hold the wire JSON (AuditLogChange[] / AuditEntryInfo).
CREATE TABLE audit_log_entries (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id BIGINT,
    target_id TEXT,
    action_type SMALLINT NOT NULL,
    changes JSONB,
    options JSONB,
    reason TEXT
);
CREATE INDEX audit_log_entries_guild ON audit_log_entries (guild_id, id DESC);

CREATE TABLE automod_rules (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    creator_id BIGINT NOT NULL,
    trigger_type SMALLINT NOT NULL DEFAULT 1,
    keyword_filter TEXT[] NOT NULL DEFAULT '{}',
    allow_list TEXT[] NOT NULL DEFAULT '{}',
    custom_message TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    exempt_roles BIGINT[] NOT NULL DEFAULT '{}',
    exempt_channels BIGINT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX automod_rules_guild ON automod_rules (guild_id);
