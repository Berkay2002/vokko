//! DM and group DM calls (docs/api.md "DM calls", docs/design/voice.md §4.2).
//!
//! A DM channel is a voice-capable channel: op 4 into it goes through `state::handle_command` like guild voice, and the first
//! join starts the call here. A call is a type 3 message plus a `message_calls` row (participants, `ended_at`) and an in-memory
//! entry (ringing, region). Every change runs under one lifecycle lock: calls are rare, and it keeps "first join creates the
//! call" and "last leave ends it" from racing.
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{patch, post};
use vokko_protocol::api::{Call, CallDelete, CallRingRequest, CallUpdate, EditCallRequest, GatewayEvent, MessageDelete, MessageType, Snowflake};

use crate::access::{self, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::hub::Session;
use crate::routes::messages::{self, Draft, Resolved};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

#[derive(Clone, Debug)]
struct CallEntry {
    message_id: i64,
    region: Option<String>,
    /// Ringing users → the ring generation their timeout belongs to (a re-ring restarts the timeout).
    ringing: HashMap<i64, u64>,
    participants: Vec<i64>,
}

#[derive(Default)]
pub struct Calls {
    calls: Mutex<HashMap<i64, CallEntry>>,
    generation: Mutex<u64>,
    lifecycle: tokio::sync::Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Calls {
    fn get(&self, channel_id: i64) -> Option<CallEntry> {
        lock(&self.calls).get(&channel_id).cloned()
    }

    fn next_generation(&self) -> u64 {
        let mut generation = lock(&self.generation);
        *generation += 1;
        *generation
    }

    /// Whether a call is going on in `channel_id`.
    pub fn ongoing(&self, channel_id: i64) -> bool {
        lock(&self.calls).contains_key(&channel_id)
    }

    /// Users being rung in `channel_id` (tests and diagnostics).
    pub fn ringing(&self, channel_id: i64) -> Vec<i64> {
        let mut ids: Vec<i64> = self.get(channel_id).map(|call| call.ringing.into_keys().collect()).unwrap_or_default();
        ids.sort_unstable();
        ids
    }
}

fn sorted_ringing(entry: &CallEntry) -> Vec<Snowflake> {
    let mut ids: Vec<i64> = entry.ringing.keys().copied().collect();
    ids.sort_unstable();
    ids.into_iter().map(Snowflake::from).collect()
}

fn call_object(state: &AppState, channel_id: i64, entry: &CallEntry) -> Call {
    Call {
        channel_id: Snowflake::from(channel_id),
        message_id: Snowflake::from(entry.message_id),
        region: entry.region.clone(),
        ringing: sorted_ringing(entry),
        voice_states: state.voice.states_in(&HashSet::from([channel_id])),
        watch_together: state.voice.watch_get(channel_id),
        stremio: crate::voice::stremio::states_in(state, &HashSet::from([channel_id])),
    }
}

async fn recipients(state: &AppState, channel_id: i64) -> Vec<i64> {
    let rows: Result<Vec<(i64,)>, _> =
        sqlx::query_as("SELECT user_id FROM channel_recipients WHERE channel_id = $1 ORDER BY user_id").bind(channel_id).fetch_all(&state.db).await;
    rows.map(|rows| rows.into_iter().map(|(id,)| id).collect()).unwrap_or_default()
}

async fn announce_update(state: &AppState, channel_id: i64, entry: &CallEntry) {
    let event = GatewayEvent::CallUpdate(CallUpdate {
        channel_id: Snowflake::from(channel_id),
        message_id: Snowflake::from(entry.message_id),
        region: entry.region.clone(),
        ringing: sorted_ringing(entry),
    });
    state.hub.send(&recipients(state, channel_id).await, &event);
}

/// Users among `others` with a block in either direction with `user_id` (the DM message rule: no ringing if you couldn't
/// message them).
pub async fn blocked_with(state: &AppState, user_id: i64, others: &[i64]) -> ApiResult<HashSet<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT CASE WHEN user_id = $1 THEN other_id ELSE user_id END FROM relationships \
         WHERE kind = 2 AND ((user_id = $1 AND other_id = ANY($2)) OR (other_id = $1 AND user_id = ANY($2)))",
    )
    .bind(user_id)
    .bind(others)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Starts ringing `users` (fresh 3-minute timeouts). The caller holds the lifecycle lock and announces the update.
fn ring(state: &AppState, channel_id: i64, users: &[i64]) -> Option<CallEntry> {
    let mut calls = lock(&state.voice.calls.calls);
    let entry = calls.get_mut(&channel_id)?;
    for &user in users {
        let generation = state.voice.calls.next_generation();
        entry.ringing.insert(user, generation);
        spawn_ring_timeout(state.clone(), channel_id, entry.message_id, user, generation);
    }
    Some(entry.clone())
}

fn spawn_ring_timeout(state: AppState, channel_id: i64, message_id: i64, user_id: i64, generation: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(state.config.call_ring_timeout).await;
        let _guard = state.voice.calls.lifecycle.lock().await;
        let stopped = {
            let mut calls = lock(&state.voice.calls.calls);
            match calls.get_mut(&channel_id) {
                Some(entry) if entry.message_id == message_id && entry.ringing.get(&user_id) == Some(&generation) => {
                    entry.ringing.remove(&user_id);
                    Some(entry.clone())
                }
                _ => None,
            }
        };
        if let Some(entry) = stopped {
            announce_update(&state, channel_id, &entry).await;
        }
    });
}

/// `user_id` got a voice state in the DM `channel`: start the call (type 3 message, CALL_CREATE ringing everyone else who can
/// be messaged) or add them to the ongoing one. Idempotent for a re-bind.
pub async fn joined(state: &AppState, channel: &ChannelRow, user_id: i64) {
    let _guard = state.voice.calls.lifecycle.lock().await;
    if let Some(entry) = state.voice.calls.get(channel.id) {
        let (added, stopped) = {
            let mut calls = lock(&state.voice.calls.calls);
            let Some(current) = calls.get_mut(&channel.id) else { return };
            let added = !current.participants.contains(&user_id);
            if added {
                current.participants.push(user_id);
            }
            (added, current.ringing.remove(&user_id).is_some().then(|| current.clone()))
        };
        if added {
            let stored =
                sqlx::query("UPDATE message_calls SET participants = array_append(participants, $2) WHERE message_id = $1 AND NOT ($2 = ANY(participants))")
                    .bind(entry.message_id)
                    .bind(user_id)
                    .execute(&state.db)
                    .await;
            if let Err(error) = stored {
                tracing::warn!("calls: participant not stored: {error}");
            }
            let _ = messages::broadcast_update(state, channel, entry.message_id).await;
        }
        if let Some(entry) = stopped {
            announce_update(state, channel.id, &entry).await;
        }
        return;
    }
    if let Err(error) = start(state, channel, user_id).await {
        tracing::warn!("calls: cannot start a call in {}: {error:?}", channel.id);
    }
}

async fn start(state: &AppState, channel: &ChannelRow, user_id: i64) -> ApiResult<()> {
    // An open row the in-memory map does not know about (restart race, a failed end write): adopt it instead of a second call.
    let open: Option<(i64, Vec<i64>, Option<String>)> =
        sqlx::query_as("SELECT message_id, participants, region FROM message_calls WHERE channel_id = $1 AND ended_at IS NULL")
            .bind(channel.id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((message_id, mut participants, region)) = open {
        if !participants.contains(&user_id) {
            sqlx::query("UPDATE message_calls SET participants = array_append(participants, $2) WHERE message_id = $1 AND NOT ($2 = ANY(participants))")
                .bind(message_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
            participants.push(user_id);
            let _ = messages::broadcast_update(state, channel, message_id).await;
        }
        let entry = CallEntry { message_id, region, ringing: HashMap::new(), participants };
        lock(&state.voice.calls.calls).insert(channel.id, entry.clone());
        let event = GatewayEvent::CallCreate(Box::new(call_object(state, channel.id, &entry)));
        state.hub.send(&recipients(state, channel.id).await, &event);
        return Ok(());
    }
    let others: Vec<i64> = recipients(state, channel.id).await.into_iter().filter(|id| *id != user_id).collect();
    let blocked = blocked_with(state, user_id, &others).await?;
    let ring_list: Vec<i64> = others.iter().copied().filter(|id| !blocked.contains(id) && !super::state::in_channel(state, *id, channel.id)).collect();
    let draft = Draft {
        content: String::new(),
        kind: MessageType::Call,
        reference: None,
        attachments: Vec::new(),
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    };
    // MESSAGE_CREATE goes out before the row below exists; a call message without a row reads as "just started by its author".
    let view = messages::insert_message(state, channel, user_id, draft).await?;
    let message_id = view.message.id.db();
    let inserted = sqlx::query("INSERT INTO message_calls (message_id, channel_id, participants) VALUES ($1, $2, ARRAY[$3]::bigint[])")
        .bind(message_id)
        .bind(channel.id)
        .bind(user_id)
        .execute(&state.db)
        .await;
    if let Err(error) = inserted {
        discard_message(state, channel, message_id).await;
        return Err(error.into());
    }
    let entry = CallEntry { message_id, region: None, ringing: HashMap::new(), participants: vec![user_id] };
    lock(&state.voice.calls.calls).insert(channel.id, entry);
    let entry = ring(state, channel.id, &ring_list).ok_or_else(ApiErr::internal)?;
    let event = GatewayEvent::CallCreate(Box::new(call_object(state, channel.id, &entry)));
    state.hub.send(&recipients(state, channel.id).await, &event);
    Ok(())
}

/// Removes the type 3 message of a call that could not be stored (MESSAGE_CREATE already went out).
async fn discard_message(state: &AppState, channel: &ChannelRow, message_id: i64) {
    let viewers = access::channel_viewers(state, channel).await.unwrap_or_default();
    if let Err(error) = sqlx::query("DELETE FROM messages WHERE id = $1").bind(message_id).execute(&state.db).await {
        tracing::warn!("calls: orphan call message {message_id} not removed: {error}");
        return;
    }
    let _ = sqlx::query("UPDATE channels SET last_message_id = (SELECT max(id) FROM messages WHERE channel_id = $1) WHERE id = $1 AND last_message_id = $2")
        .bind(channel.id)
        .bind(message_id)
        .execute(&state.db)
        .await;
    let event = GatewayEvent::MessageDelete(MessageDelete {
        id: Snowflake::from(message_id),
        channel_id: Snowflake::from(channel.id),
        guild_id: channel.guild_id.map(Snowflake::from),
    });
    state.hub.send(&viewers, &event);
}

/// Nobody is left in `channel_id`'s voice: its call (if any) ends: `ended_timestamp` written (MESSAGE_UPDATE), CALL_DELETE.
pub async fn release(state: &AppState, channel_id: i64) {
    if !state.voice.calls.ongoing(channel_id) {
        return;
    }
    let _guard = state.voice.calls.lifecycle.lock().await;
    if state.voice.all().iter().any(|entry| entry.channel_id == channel_id) {
        return;
    }
    let Some(entry) = lock(&state.voice.calls.calls).remove(&channel_id) else { return };
    end_stored(state, channel_id, entry.message_id).await;
}

async fn end_stored(state: &AppState, channel_id: i64, message_id: i64) {
    let ended = sqlx::query("UPDATE message_calls SET ended_at = now() WHERE message_id = $1 AND ended_at IS NULL").bind(message_id).execute(&state.db).await;
    if let Err(error) = ended {
        tracing::warn!("calls: end not stored: {error}");
    }
    if let Ok(Some(row)) = store::channel_row(state, channel_id).await {
        let _ = messages::broadcast_update(state, &row, message_id).await;
    }
    state.hub.send(&recipients(state, channel_id).await, &GatewayEvent::CallDelete(CallDelete { channel_id: Snowflake::from(channel_id) }));
}

/// A recipient left the group DM: they are no longer rung (their voice state is evicted by `state::dm_recipient_removed`).
pub async fn recipient_removed(state: &AppState, channel_id: i64, user_id: i64) {
    let _guard = state.voice.calls.lifecycle.lock().await;
    let stopped = {
        let mut calls = lock(&state.voice.calls.calls);
        calls.get_mut(&channel_id).and_then(|entry| entry.ringing.remove(&user_id).is_some().then(|| entry.clone()))
    };
    if let Some(entry) = stopped {
        announce_update(state, channel_id, &entry).await;
    }
}

/// Right after READY: CALL_CREATE for every ongoing call in the user's DMs.
pub async fn send_active(state: &AppState, session: &Session) {
    let channel_ids: Vec<i64> = lock(&state.voice.calls.calls).keys().copied().collect();
    if channel_ids.is_empty() {
        return;
    }
    let mine: Result<Vec<(i64,)>, _> = sqlx::query_as("SELECT channel_id FROM channel_recipients WHERE user_id = $1 AND channel_id = ANY($2)")
        .bind(session.user_id)
        .bind(&channel_ids)
        .fetch_all(&state.db)
        .await;
    for (channel_id,) in mine.unwrap_or_default() {
        if let Some(entry) = state.voice.calls.get(channel_id) {
            let event = GatewayEvent::CallCreate(Box::new(call_object(state, channel_id, &entry)));
            session.dispatch(event.name(), event.data());
        }
    }
}

/// Startup (after the voice states were restored from LiveKit): ongoing calls come back without ringing; calls nobody is in any
/// more end now.
pub async fn recover(state: &AppState) {
    type OpenCall = (i64, i64, Vec<i64>, Option<String>);
    let rows: Result<Vec<OpenCall>, _> =
        sqlx::query_as("SELECT message_id, channel_id, participants, region FROM message_calls WHERE ended_at IS NULL").fetch_all(&state.db).await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!("calls: cannot recover: {error}");
            return;
        }
    };
    let _guard = state.voice.calls.lifecycle.lock().await;
    for (message_id, channel_id, participants, region) in rows {
        if lock(&state.voice.calls.calls).contains_key(&channel_id) {
            continue;
        }
        if state.voice.all().iter().any(|entry| entry.channel_id == channel_id) {
            lock(&state.voice.calls.calls).insert(channel_id, CallEntry { message_id, region, ringing: HashMap::new(), participants });
        } else {
            end_stored(state, channel_id, message_id).await;
        }
    }
}

// ---- REST ----

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/call", patch(edit_call))
        .route("/channels/{id}/call/ring", post(ring_call))
        .route("/channels/{id}/call/stop-ringing", post(stop_ringing))
}

/// The DM `id` as seen by `user_id` (403 50001 when not a recipient, 400 for other channel types).
async fn dm_channel(state: &AppState, user_id: i64, id: &str) -> ApiResult<ChannelRow> {
    let id = parse_id(id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(state, user_id, id).await?;
    if !access.is_dm() {
        return Err(ApiErr::invalid("channel_id", "Only DMs and group DMs have calls."));
    }
    Ok(access.channel)
}

/// `recipients` of a request, checked against the DM's recipients (400 50035 for anyone else).
async fn requested(state: &AppState, channel_id: i64, list: &[Snowflake]) -> ApiResult<Vec<i64>> {
    let members: HashSet<i64> =
        access::channel_viewers(state, &store::channel_row(state, channel_id).await?.ok_or_else(ApiErr::unknown_channel)?).await?.into_iter().collect();
    let mut ids: Vec<i64> = list.iter().map(|id| id.db()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.iter().any(|id| !members.contains(id)) {
        return Err(ApiErr::invalid("recipients", "Every recipient must be in this channel."));
    }
    Ok(ids)
}

async fn ring_call(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CallRingRequest>,
) -> ApiResult<StatusCode> {
    let channel = dm_channel(&state, user_id, &id).await?;
    let explicit = body.recipients;
    let _guard = state.voice.calls.lifecycle.lock().await;
    if !state.voice.calls.ongoing(channel.id) {
        return Err(ApiErr::invalid("channel_id", "There is no call in this channel."));
    }
    if !super::state::in_channel(&state, user_id, channel.id) {
        return Err(ApiErr::missing_permissions());
    }
    let candidates: Vec<i64> = match &explicit {
        Some(list) => requested(&state, channel.id, list).await?,
        None => recipients(&state, channel.id).await,
    };
    let candidates: Vec<i64> = candidates.into_iter().filter(|id| *id != user_id).collect();
    let blocked = blocked_with(&state, user_id, &candidates).await?;
    let one_to_one = channel.channel_type() == vokko_protocol::api::ChannelType::Dm;
    if !blocked.is_empty() && (one_to_one || explicit.is_some()) {
        return Err(ApiErr::cannot_message_user());
    }
    // A 1:1 ring is a DM too: the other side's DM privacy has to allow the caller.
    if one_to_one {
        for other in &candidates {
            if !crate::routes::guild_privacy::may_dm(&state, user_id, *other).await? {
                return Err(ApiErr::cannot_message_user());
            }
        }
    }
    let users: Vec<i64> = candidates.into_iter().filter(|id| !blocked.contains(id) && !super::state::in_channel(&state, *id, channel.id)).collect();
    if users.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(entry) = ring(&state, channel.id, &users) {
        announce_update(&state, channel.id, &entry).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_ringing(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CallRingRequest>,
) -> ApiResult<StatusCode> {
    let channel = dm_channel(&state, user_id, &id).await?;
    let users = match body.recipients {
        Some(list) => requested(&state, channel.id, &list).await?,
        None => vec![user_id],
    };
    if users.iter().any(|id| *id != user_id) && !super::state::in_channel(&state, user_id, channel.id) {
        return Err(ApiErr::missing_permissions());
    }
    let _guard = state.voice.calls.lifecycle.lock().await;
    let stopped = {
        let mut calls = lock(&state.voice.calls.calls);
        calls.get_mut(&channel.id).and_then(|entry| {
            let before = entry.ringing.len();
            entry.ringing.retain(|id, _| !users.contains(id));
            (entry.ringing.len() != before).then(|| entry.clone())
        })
    };
    if let Some(entry) = stopped {
        announce_update(&state, channel.id, &entry).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

fn valid_region(region: &str) -> bool {
    (1..=32).contains(&region.len()) && region.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

async fn edit_call(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditCallRequest>,
) -> ApiResult<StatusCode> {
    let channel = dm_channel(&state, user_id, &id).await?;
    if body.region.as_deref().is_some_and(|region| !valid_region(region)) {
        return Err(ApiErr::invalid("region", "Must be null or 1-32 characters of a-z, 0-9 and -."));
    }
    let _guard = state.voice.calls.lifecycle.lock().await;
    let updated = {
        let mut calls = lock(&state.voice.calls.calls);
        calls.get_mut(&channel.id).map(|entry| {
            entry.region = body.region.clone();
            entry.clone()
        })
    };
    let Some(entry) = updated else { return Err(ApiErr::invalid("channel_id", "There is no call in this channel.")) };
    sqlx::query("UPDATE message_calls SET region = $2 WHERE message_id = $1").bind(entry.message_id).bind(&entry.region).execute(&state.db).await?;
    announce_update(&state, channel.id, &entry).await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions() {
        assert!(valid_region("rotterdam") && valid_region("us-west-2"));
        assert!(!valid_region("") && !valid_region("EU") && !valid_region("a b") && !valid_region(&"a".repeat(33)));
    }
}
