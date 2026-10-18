-- One template per guild (like Discord). `source` is the serialized_source_guild JSON taken at create or the last sync.
CREATE TABLE guild_templates (
    code TEXT PRIMARY KEY,
    guild_id BIGINT NOT NULL UNIQUE REFERENCES guilds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    creator_id BIGINT NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
