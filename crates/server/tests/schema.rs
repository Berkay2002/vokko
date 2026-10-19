#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Schema invariants checked against the migrated test database.
mod common;

use common::TestApp;

/// Every foreign key into `messages` or `channels` needs a full (not partial) index that leads with its column: otherwise each deleted message
/// or channel (a channel or guild purge cascades to all of them) seq-scans the referencing table.
#[tokio::test]
async fn foreign_keys_to_messages_and_channels_are_indexed() {
    let app = TestApp::new().await;
    let unindexed: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.conrelid::regclass::text, a.attname::text
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid IN ('messages'::regclass, 'channels'::regclass)
           AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NULL)
         ORDER BY 1, 2",
    )
    .fetch_all(&app.state.db)
    .await
    .expect("foreign keys");
    // The guild's own channel settings and automod alert channels: a handful of rows per guild, scanning them is free.
    let small = [("automod_rules", "alert_channel_id"), ("guilds", "public_updates_channel_id"), ("guilds", "rules_channel_id")];
    let unindexed: Vec<_> = unindexed.into_iter().filter(|(table, column)| !small.contains(&(table.as_str(), column.as_str()))).collect();
    assert!(unindexed.is_empty(), "foreign keys without an index: {unindexed:?}");
}
