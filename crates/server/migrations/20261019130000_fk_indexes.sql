-- Postgres does not index referencing columns, so deleting a message or channel scanned these tables once per deleted row
-- (a channel or guild purge cascades to every message in it). Plain CREATE INDEX: sqlx runs each migration in a transaction.
CREATE INDEX bookmarks_message ON bookmarks (message_id);
CREATE INDEX reminders_message ON reminders (message_id);
CREATE INDEX mention_dismissals_message ON mention_dismissals (message_id);
CREATE INDEX read_states_channel ON read_states (channel_id);
CREATE INDEX interactions_channel ON interactions (channel_id);
CREATE INDEX scheduled_events_channel ON scheduled_events (channel_id);
-- message_calls_ongoing is partial (ongoing calls only), so it does not serve the cascade.
CREATE INDEX message_calls_channel ON message_calls (channel_id);
