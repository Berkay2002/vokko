//! WebSocket gateway: Hello → Identify/Resume → READY → heartbeats and dispatches (see `docs/api.md`).
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use vokko_protocol::api::{
    GatewayEvent, GatewayOp, GatewayPayload, Hello, Identify, Presence, PresenceStatus, PresenceUpdateRequest, ReadState, ReadyEvent, Resume, Snowflake,
};

use crate::auth::{random_hex, user_for_token};
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::hub::{Outgoing, ReplayOutcome, Session};
use crate::routes::relationships::{open_dms, relationships_of};
use crate::state::AppState;
use crate::store;

type Sink = SplitSink<WebSocket, Message>;
type Stream = SplitStream<WebSocket>;

pub const CLOSE_AUTH_FAILED: u16 = 4004;
pub const CLOSE_HEARTBEAT_TIMEOUT: u16 = 4009;

pub async fn upgrade(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle(state, socket))
}

fn frame(op: GatewayOp, data: Value) -> Message {
    let payload = GatewayPayload { op, d: data, s: None, t: None };
    Message::Text(serde_json::to_string(&payload).unwrap_or_default().into())
}

async fn close(sink: &mut Sink, code: u16) {
    let _ = sink.send(Message::Close(Some(CloseFrame { code, reason: "".into() }))).await;
}

async fn handle(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let hello = Hello { heartbeat_interval: state.config.heartbeat_interval_ms };
    if sink.send(frame(GatewayOp::Hello, serde_json::to_value(hello).unwrap_or_default())).await.is_err() {
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let handshake_timeout = Duration::from_millis((state.config.heartbeat_interval_ms * 2).max(5000));
    let Ok(Some((session, generation))) = tokio::time::timeout(handshake_timeout, handshake(&state, &mut sink, &mut stream, tx)).await else {
        return;
    };
    let user_id = session.user_id;
    if state.hub.connection_opened(user_id) {
        let _ = set_presence(&state, user_id, Some(PresenceStatus::Online), None).await;
    }
    run(&state, &session, &mut sink, &mut stream, &mut rx).await;
    session.detach(generation);
    if state.hub.connection_closed(user_id) {
        let _ = set_presence(&state, user_id, Some(PresenceStatus::Offline), None).await;
    }
}

/// Waits for Identify or Resume. `None` means the connection is over (bad token, socket closed).
async fn handshake(state: &AppState, sink: &mut Sink, stream: &mut Stream, tx: mpsc::UnboundedSender<Outgoing>) -> Option<(Arc<Session>, u64)> {
    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                return None;
            }
            continue;
        };
        let Ok(payload) = serde_json::from_str::<GatewayPayload>(&text) else { continue };
        match payload.op {
            GatewayOp::Identify => {
                let Ok(identify) = serde_json::from_value::<Identify>(payload.d) else {
                    close(sink, CLOSE_AUTH_FAILED).await;
                    return None;
                };
                let user_id = match user_for_token(state, &identify.token).await {
                    Ok(Some(user_id)) => user_id,
                    _ => {
                        close(sink, CLOSE_AUTH_FAILED).await;
                        return None;
                    }
                };
                let session_id = random_hex(16);
                let ready = match build_ready(state, user_id, &session_id).await {
                    Ok(ready) => ready,
                    Err(_) => {
                        close(sink, 1011).await;
                        return None;
                    }
                };
                let session = state.hub.create_session(user_id, session_id);
                let generation = session.attach(tx);
                session.dispatch("READY", GatewayEvent::Ready(Box::new(ready)).data());
                return Some((session, generation));
            }
            GatewayOp::Resume => {
                let Ok(resume) = serde_json::from_value::<Resume>(payload.d) else { continue };
                let owner = user_for_token(state, &resume.token).await.ok().flatten();
                let session = state.hub.session(&resume.session_id).filter(|session| Some(session.user_id) == owner);
                let Some(session) = session else {
                    let _ = sink.send(frame(GatewayOp::InvalidSession, Value::Bool(false))).await;
                    continue;
                };
                let generation = session.attach(tx.clone());
                match session.replay_after(resume.seq) {
                    ReplayOutcome::Replayed(_) => {
                        session.dispatch("RESUMED", GatewayEvent::Resumed.data());
                        return Some((session, generation));
                    }
                    ReplayOutcome::Gap => {
                        session.detach(generation);
                        state.hub.remove_session(&session.id);
                        let _ = sink.send(frame(GatewayOp::InvalidSession, Value::Bool(false))).await;
                    }
                }
            }
            GatewayOp::Heartbeat => {
                let _ = sink.send(frame(GatewayOp::HeartbeatAck, Value::Null)).await;
            }
            _ => {}
        }
    }
    None
}

async fn run(state: &AppState, session: &Arc<Session>, sink: &mut Sink, stream: &mut Stream, rx: &mut UnboundedReceiver<Outgoing>) {
    let period = Duration::from_millis(state.config.heartbeat_interval_ms.max(50));
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    let mut beat_since_tick = true;
    let mut missed = 0_u32;
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(payload) = serde_json::from_str::<GatewayPayload>(&text) else { continue };
                    match payload.op {
                        GatewayOp::Heartbeat => {
                            beat_since_tick = true;
                            if sink.send(frame(GatewayOp::HeartbeatAck, Value::Null)).await.is_err() {
                                break;
                            }
                        }
                        GatewayOp::PresenceUpdate => {
                            if let Ok(update) = serde_json::from_value::<PresenceUpdateRequest>(payload.d) {
                                let _ = set_presence(state, session.user_id, Some(update.status), Some(update.custom_status)).await;
                            }
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            outgoing = rx.recv() => match outgoing {
                Some(Outgoing::Text(text)) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Some(Outgoing::Close(code)) => {
                    close(sink, code).await;
                    break;
                }
                None => break,
            },
            _ = ticker.tick() => {
                if beat_since_tick {
                    missed = 0;
                    beat_since_tick = false;
                } else {
                    missed += 1;
                }
                if missed >= state.config.heartbeat_misses {
                    close(sink, CLOSE_HEARTBEAT_TIMEOUT).await;
                    break;
                }
            }
        }
    }
}

/// Stores a presence change and tells everyone who shares a guild, DM or relationship with the user.
pub async fn set_presence(state: &AppState, user_id: i64, status: Option<PresenceStatus>, custom_status: Option<Option<String>>) -> ApiResult<()> {
    let row: (String, Option<String>) = sqlx::query_as(
        "INSERT INTO presences (user_id, status, custom_status) VALUES ($1, COALESCE($2, 'online'), $3) \
         ON CONFLICT (user_id) DO UPDATE SET status = COALESCE($2, presences.status), \
           custom_status = CASE WHEN $4 THEN $3 ELSE presences.custom_status END \
         RETURNING status, custom_status",
    )
    .bind(user_id)
    .bind(status.map(PresenceStatus::as_str))
    .bind(custom_status.clone().flatten())
    .bind(custom_status.is_some())
    .fetch_one(&state.db)
    .await?;
    let presence =
        Presence { user_id: Snowflake::from(user_id), status: PresenceStatus::parse(&row.0).unwrap_or(PresenceStatus::Offline), custom_status: row.1 };
    let audience = events::user_audience(state, user_id).await?;
    state.hub.send(&audience, &GatewayEvent::PresenceUpdate(presence));
    Ok(())
}

pub async fn build_ready(state: &AppState, user_id: i64, session_id: &str) -> ApiResult<ReadyEvent> {
    let user = store::user(state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let guild_ids: Vec<(i64,)> =
        sqlx::query_as("SELECT guild_id FROM guild_members WHERE user_id = $1 ORDER BY joined_at, guild_id").bind(user_id).fetch_all(&state.db).await?;
    let mut guilds = Vec::with_capacity(guild_ids.len());
    for (guild_id,) in guild_ids {
        guilds.push(events::guild_with_state(state, guild_id, user_id).await?);
    }
    let private_channels = open_dms(state, user_id).await?;
    let relationships = relationships_of(state, user_id).await?;

    let audience = events::user_audience(state, user_id).await?;
    let presence_rows: Vec<(i64, String, Option<String>)> =
        sqlx::query_as("SELECT user_id, status, custom_status FROM presences WHERE user_id = ANY($1)").bind(&audience).fetch_all(&state.db).await?;
    let presences = presence_rows
        .into_iter()
        .map(|(id, status, custom_status)| Presence {
            user_id: Snowflake::from(id),
            status: PresenceStatus::parse(&status).unwrap_or(PresenceStatus::Offline),
            custom_status,
        })
        .collect();

    // A read state for every visible channel that has messages (a missing one reads as unread on the client).
    let mut visible: Vec<(i64, Option<i64>)> = Vec::new();
    for guild in &guilds {
        visible.extend(
            guild
                .channels
                .iter()
                .filter(|channel| channel.kind != vokko_protocol::api::ChannelType::GuildCategory)
                .map(|channel| (channel.id.db(), channel.last_message_id.map(Snowflake::db))),
        );
    }
    visible.extend(private_channels.iter().map(|channel| (channel.id.db(), channel.last_message_id.map(Snowflake::db))));
    let ids: Vec<i64> = visible.iter().map(|(id, _)| *id).collect();
    let rows: Vec<(i64, Option<i64>, i32)> =
        sqlx::query_as("SELECT channel_id, last_message_id, mention_count FROM read_states WHERE user_id = $1 AND channel_id = ANY($2)")
            .bind(user_id)
            .bind(&ids)
            .fetch_all(&state.db)
            .await?;
    let have: HashSet<i64> = rows.iter().map(|(id, _, _)| *id).collect();
    let mut read_states: Vec<ReadState> = rows
        .into_iter()
        .map(|(id, last, mentions)| ReadState {
            channel_id: Snowflake::from(id),
            last_message_id: last.map(Snowflake::from),
            mention_count: mentions.max(0) as u32,
        })
        .collect();
    for (id, last_message) in visible {
        if last_message.is_some() && !have.contains(&id) {
            read_states.push(ReadState { channel_id: Snowflake::from(id), last_message_id: None, mention_count: 0 });
        }
    }

    Ok(ReadyEvent { v: 1, user, session_id: session_id.to_owned(), guilds, private_channels, presences, read_states, relationships })
}
