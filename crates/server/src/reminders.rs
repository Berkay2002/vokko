//! Reminders and bookmarks: shared loading and the periodic delivery task.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sqlx::FromRow;
use time::OffsetDateTime;
use vokko_protocol::api::permissions::READ_MESSAGE_HISTORY;
use vokko_protocol::api::{GatewayEvent, Message, Reminder, Snowflake};

use crate::access::channel_access;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::store::{self, MESSAGE_SELECT, MessageRow};

/// Channels among `channel_ids` where `user_id` can see the channel and read its history right now.
pub async fn readable_channels(state: &AppState, user_id: i64, channel_ids: &[i64]) -> ApiResult<HashSet<i64>> {
    let mut readable = HashSet::new();
    let mut unique = channel_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    for channel in unique {
        if let Ok(access) = channel_access(state, user_id, channel).await
            && access.permissions & READ_MESSAGE_HISTORY != 0
        {
            readable.insert(channel);
        }
    }
    Ok(readable)
}

/// The given messages as `user_id` sees them; messages in channels they cannot read are left out.
pub async fn readable_messages(state: &AppState, user_id: i64, message_ids: &[i64]) -> ApiResult<HashMap<i64, Message>> {
    let rows: Vec<MessageRow> = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = ANY($1)")).bind(message_ids).fetch_all(&state.db).await?;
    let channels: Vec<i64> = rows.iter().map(|row| row.channel_id).collect();
    let readable = readable_channels(state, user_id, &channels).await?;
    let rows: Vec<MessageRow> = rows.into_iter().filter(|row| readable.contains(&row.channel_id)).collect();
    Ok(store::load_messages(state, rows, Some(user_id)).await?.into_iter().map(|view| (view.message.id.db(), view.message)).collect())
}

#[derive(FromRow)]
pub struct ReminderRow {
    pub id: i64,
    pub user_id: i64,
    pub message_id: i64,
    pub channel_id: i64,
    pub guild_id: Option<i64>,
    pub remind_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub delivered_at: Option<OffsetDateTime>,
}

pub const REMINDER_COLS: &str = "r.id, r.user_id, r.message_id, r.channel_id, (SELECT c.guild_id FROM channels c WHERE c.id = r.channel_id) AS guild_id, \
     r.remind_at, r.created_at, r.delivered_at";

/// Wire reminders for their owner `user_id`.
pub async fn hydrate(state: &AppState, user_id: i64, rows: Vec<ReminderRow>) -> ApiResult<Vec<Reminder>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.message_id).collect();
    let mut messages = readable_messages(state, user_id, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| Reminder {
            id: Snowflake::from(row.id),
            channel_id: Snowflake::from(row.channel_id),
            message_id: Snowflake::from(row.message_id),
            guild_id: row.guild_id.map(Snowflake::from),
            remind_at: store::iso(row.remind_at),
            created_at: store::iso(row.created_at),
            delivered_at: row.delivered_at.map(store::iso),
            message: messages.remove(&row.message_id),
        })
        .collect())
}

/// Marks every due reminder delivered (exactly once, even with several server processes) and sends REMINDER_DUE to its owner.
pub async fn deliver_due(state: &AppState) -> ApiResult<usize> {
    let rows: Vec<ReminderRow> =
        sqlx::query_as(&format!("UPDATE reminders r SET delivered_at = now() WHERE r.delivered_at IS NULL AND r.remind_at <= now() RETURNING {REMINDER_COLS}"))
            .fetch_all(&state.db)
            .await?;
    let count = rows.len();
    for row in rows {
        let user_id = row.user_id;
        // One reminder that cannot be loaded must not stop the others: it stays delivered and listed, only its live notice is skipped.
        match hydrate(state, user_id, vec![row]).await {
            Ok(reminders) => {
                for reminder in reminders {
                    state.hub.send(&[user_id], &GatewayEvent::ReminderDue(Box::new(reminder)));
                }
            }
            Err(error) => tracing::warn!("reminder notice for user {user_id} skipped: {}", error.body.message),
        }
    }
    Ok(count)
}

/// Delivery every `config.reminder_poll`, plus a sweep of unreferenced sticker files about every 10 minutes; ends with the runtime.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(state.config.reminder_poll);
        let sweep_every = (Duration::from_secs(600).as_millis() / state.config.reminder_poll.as_millis().max(1)).max(1) as u64;
        let mut ticks = 0_u64;
        loop {
            interval.tick().await;
            if let Err(error) = deliver_due(&state).await {
                tracing::warn!("reminder delivery failed: {}", error.body.message);
            }
            ticks += 1;
            if ticks.is_multiple_of(sweep_every) {
                crate::stickers::sweep_assets(&state).await;
                crate::soundboard::sweep_assets(&state).await;
            }
        }
    });
}
