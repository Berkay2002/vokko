-- AutoMod rule types beyond keywords (spam, keyword presets, mention spam) and the alert / timeout actions.
-- `trigger_type` already exists (default 1 = KEYWORD). Each action type appears at most once per rule, so it is a column.
ALTER TABLE automod_rules
    ADD COLUMN presets SMALLINT[] NOT NULL DEFAULT '{}',
    ADD COLUMN mention_total_limit SMALLINT,
    ADD COLUMN block_message BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN alert_channel_id BIGINT REFERENCES channels (id) ON DELETE SET NULL,
    ADD COLUMN timeout_seconds INT;
