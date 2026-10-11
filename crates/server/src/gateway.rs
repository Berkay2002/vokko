//! WebSocket gateway: Hello → Identify/Resume → READY → heartbeats and dispatches (see `docs/api.md`).
//!
//! Hardening: frames are capped at 16 KiB, every socket write has a timeout, outgoing events go through a bounded queue
//! (see `hub`), op 3 is limited per session, Identify per user, and unidentified sockets per client address.
use std::collections::{HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use vokko_protocol::api::{
    Activity, GatewayEvent, GatewayOp, GatewayPayload, Hello, Identify, PresenceUpdateRequest, ReadState, ReadyEvent, Resume, Snowflake,
    VoiceStateUpdateCommand,
};

use crate::auth::{hash_token, random_hex, user_for_token};
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::hub::{Link, LinkReceiver, ResumeOutcome, Session};
use crate::net::client_ip;
use crate::presence;
use crate::routes::relationships::{open_dms, relationships_of};
use crate::state::AppState;
use crate::store;
use crate::voice;

type Sink = SplitSink<WebSocket, Message>;
type Stream = SplitStream<WebSocket>;

pub const CLOSE_DECODE_ERROR: u16 = 4002;
pub const CLOSE_AUTH_FAILED: u16 = 4004;
pub const CLOSE_RATE_LIMITED: u16 = 4008;
pub const CLOSE_HEARTBEAT_TIMEOUT: u16 = 4009;
const CLOSE_INTERNAL_ERROR: u16 = 1011;

/// Largest message or frame a client may send.
pub const MAX_CLIENT_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_CUSTOM_STATUS_CHARS: usize = 128;
/// Presence updates (op 3) allowed per session per window.
const PRESENCE_UPDATES: usize = 5;
const PRESENCE_WINDOW: Duration = Duration::from_secs(60);
/// Voice state updates (op 4, mute toggles included) allowed per session per window.
const VOICE_UPDATES: usize = 30;
const VOICE_WINDOW: Duration = Duration::from_secs(60);

/// A reserved pre-auth socket of one client address, released on drop.
struct PreauthSlot {
    state: AppState,
    ip: IpAddr,
}

impl Drop for PreauthSlot {
    fn drop(&mut self) {
        self.state.hub.preauth_release(self.ip);
    }
}

pub async fn upgrade(State(state): State<AppState>, ws: WebSocketUpgrade, request: Request) -> Response {
    let ip = client_ip(request.extensions(), request.headers(), state.config.trust_proxy);
    if state.hub.preauth_acquire(ip, state.config.max_preauth_per_ip).is_none() {
        return (StatusCode::TOO_MANY_REQUESTS, "Too many gateway connections.").into_response();
    }
    let slot = PreauthSlot { state: state.clone(), ip };
    ws.max_message_size(MAX_CLIENT_MESSAGE_BYTES).max_frame_size(MAX_CLIENT_MESSAGE_BYTES).on_upgrade(move |socket| handle(state, socket, slot))
}

fn frame(op: GatewayOp, data: Value) -> Message {
    let payload = GatewayPayload { op, d: data, s: None, t: None };
    Message::Text(serde_json::to_string(&payload).unwrap_or_default().into())
}

/// The socket's write half; no write may block the task for longer than `limit`.
struct Writer {
    sink: Sink,
    limit: Duration,
}

impl Writer {
    /// False when the socket is gone or too slow.
    async fn send(&mut self, message: Message) -> bool {
        matches!(tokio::time::timeout(self.limit, self.sink.send(message)).await, Ok(Ok(())))
    }

    async fn frame(&mut self, op: GatewayOp, data: Value) -> bool {
        self.send(frame(op, data)).await
    }

    async fn close(&mut self, code: u16) {
        self.send(Message::Close(Some(CloseFrame { code, reason: "".into() }))).await;
    }

    /// Completes the client's close handshake so it sees a clean 1000.
    async fn finish(&mut self) {
        let _ = tokio::time::timeout(self.limit, self.sink.close()).await;
    }
}

async fn handle(state: AppState, socket: WebSocket, slot: PreauthSlot) {
    let (sink, mut stream) = socket.split();
    let mut writer = Writer { sink, limit: state.config.write_timeout };
    let hello = Hello { heartbeat_interval: state.config.heartbeat_interval_ms };
    if !writer.frame(GatewayOp::Hello, serde_json::to_value(hello).unwrap_or_default()).await {
        return;
    }
    let (link, mut receiver) = state.hub.new_link();
    let Ok(Some((session, generation))) = tokio::time::timeout(state.config.handshake_timeout, handshake(&state, &mut writer, &mut stream, link)).await else {
        return;
    };
    drop(slot);
    let user_id = session.user_id;
    if state.hub.connection_opened(user_id) {
        let _ = presence::connected(&state, user_id).await;
    }
    run(&state, &session, &mut writer, &mut stream, &mut receiver).await;
    let detached = session.detach(generation);
    if detached {
        voice::state::gateway_detached(&state, session.id.clone());
    }
    // The activity belongs to the connection that reported it: when that one goes (even while other sessions stay), it goes too.
    let remaining = if detached { state.hub.clear_session_activities(user_id, &session.id) } else { None };
    if state.hub.connection_closed(user_id) {
        let _ = presence::disconnected(&state, user_id).await;
        if let Err(error) = crate::routes::invites::remove_temporary_memberships(&state, user_id).await {
            tracing::warn!("removing temporary memberships failed: {error:?}");
        }
    } else if let Some(shown) = remaining {
        let _ = presence::update(&state, user_id, None, None, Some(shown), true).await;
    }
}

/// Waits for Identify or Resume. `None` means the connection is over (bad token, socket closed).
async fn handshake(state: &AppState, writer: &mut Writer, stream: &mut Stream, link: Link) -> Option<(Arc<Session>, u64)> {
    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                writer.finish().await;
                return None;
            }
            continue;
        };
        let Ok(payload) = serde_json::from_str::<GatewayPayload>(&text) else { continue };
        match payload.op {
            GatewayOp::Identify => {
                let Ok(identify) = serde_json::from_value::<Identify>(payload.d) else {
                    writer.close(CLOSE_AUTH_FAILED).await;
                    return None;
                };
                let user_id = match user_for_token(state, &identify.token).await {
                    Ok(Some(user_id)) => user_id,
                    _ => {
                        writer.close(CLOSE_AUTH_FAILED).await;
                        return None;
                    }
                };
                if !state.hub.allow_identify(user_id, state.config.identify_per_minute) {
                    writer.close(CLOSE_RATE_LIMITED).await;
                    return None;
                }
                let session_id = random_hex(16);
                let ready = match build_ready(state, user_id, &session_id).await {
                    Ok(ready) => ready,
                    Err(_) => {
                        writer.close(CLOSE_INTERNAL_ERROR).await;
                        return None;
                    }
                };
                let (session, generation) =
                    state.hub.open_session(user_id, session_id, hash_token(&identify.token), link, GatewayEvent::Ready(Box::new(ready)).data());
                return Some((session, generation));
            }
            GatewayOp::Resume => {
                let Ok(resume) = serde_json::from_value::<Resume>(payload.d) else { continue };
                let owner = user_for_token(state, &resume.token).await.ok().flatten();
                let session = state.hub.session(&resume.session_id).filter(|session| Some(session.user_id) == owner);
                let Some(session) = session else {
                    if !writer.frame(GatewayOp::InvalidSession, Value::Bool(false)).await {
                        return None;
                    }
                    continue;
                };
                // Gap check, attach, replay and the RESUMED frame happen under one session lock (see `Session::resume`).
                match session.resume(link.clone(), resume.seq, ("RESUMED", GatewayEvent::Resumed.data())) {
                    ResumeOutcome::Resumed { generation, .. } => return Some((session, generation)),
                    ResumeOutcome::Gap => {
                        state.hub.remove_session(&session.id);
                        if !writer.frame(GatewayOp::InvalidSession, Value::Bool(false)).await {
                            return None;
                        }
                    }
                }
            }
            GatewayOp::Heartbeat => {
                let acked = writer.frame(GatewayOp::HeartbeatAck, Value::Null).await;
                if !acked {
                    return None;
                }
            }
            _ => {}
        }
    }
    None
}

/// At most `limit` events per `window`.
struct Allowance {
    limit: usize,
    window: Duration,
    times: VecDeque<Instant>,
}

impl Allowance {
    fn new(limit: usize, window: Duration) -> Self {
        Self { limit, window, times: VecDeque::new() }
    }

    fn allow(&mut self, now: Instant) -> bool {
        while self.times.front().is_some_and(|first| now.saturating_duration_since(*first) >= self.window) {
            self.times.pop_front();
        }
        if self.times.len() >= self.limit {
            return false;
        }
        self.times.push_back(now);
        true
    }
}

async fn run(state: &AppState, session: &Arc<Session>, writer: &mut Writer, stream: &mut Stream, receiver: &mut LinkReceiver) {
    let period = Duration::from_millis(state.config.heartbeat_interval_ms.max(50));
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    let mut beat_since_tick = true;
    let mut missed = 0_u32;
    let mut presence_updates = Allowance::new(PRESENCE_UPDATES, PRESENCE_WINDOW);
    let mut voice_updates = Allowance::new(VOICE_UPDATES, VOICE_WINDOW);
    loop {
        tokio::select! {
            code = receiver.signal.wait() => {
                writer.close(code).await;
                break;
            }
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(payload) = serde_json::from_str::<GatewayPayload>(&text) else { continue };
                    match payload.op {
                        GatewayOp::Heartbeat => {
                            beat_since_tick = true;
                            if !writer.frame(GatewayOp::HeartbeatAck, Value::Null).await {
                                break;
                            }
                        }
                        GatewayOp::PresenceUpdate => {
                            let Ok(update) = serde_json::from_value::<PresenceUpdateRequest>(payload.d) else { continue };
                            if update.custom_status.as_ref().is_some_and(|text| text.chars().count() > MAX_CUSTOM_STATUS_CHARS) {
                                writer.close(CLOSE_DECODE_ERROR).await;
                                break;
                            }
                            if update.activities.as_deref().is_some_and(|list| !Activity::list_is_valid(list)) {
                                writer.close(CLOSE_DECODE_ERROR).await;
                                break;
                            }
                            if !presence_updates.allow(Instant::now()) {
                                writer.close(CLOSE_RATE_LIMITED).await;
                                break;
                            }
                            // Activities are kept per session: this session's list replaces its own, never another session's.
                            let activities = update.activities.map(|list| state.hub.set_session_activities(session.user_id, &session.id, list));
                            let _ = presence::update(state, session.user_id, Some(update.status), Some(update.custom_status), activities, true).await;
                        }
                        GatewayOp::VoiceStateUpdate => {
                            let Ok(command) = serde_json::from_value::<VoiceStateUpdateCommand>(payload.d) else { continue };
                            if !voice_updates.allow(Instant::now()) {
                                writer.close(CLOSE_RATE_LIMITED).await;
                                break;
                            }
                            voice::handle_command(state, session, command).await;
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) => {
                    writer.finish().await;
                    break;
                }
                Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            queued = receiver.queue.recv() => match queued {
                Some(text) => {
                    if !writer.send(Message::Text(text.into())).await {
                        break;
                    }
                }
                None => {
                    // the hub dropped its end: either a close was requested (the code is set first) or the session is gone
                    if let Some(code) = receiver.signal.fired() {
                        writer.close(code).await;
                    }
                    break;
                }
            },
            _ = ticker.tick() => {
                if beat_since_tick {
                    missed = 0;
                    beat_since_tick = false;
                } else {
                    missed += 1;
                }
                if missed >= state.config.heartbeat_misses {
                    writer.close(CLOSE_HEARTBEAT_TIMEOUT).await;
                    break;
                }
            }
        }
    }
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
    let presences = presence::presences_for(state, user_id, &audience).await?;

    // A read state for every visible channel that has messages (a missing one reads as unread on the client).
    let mut visible: Vec<(i64, Option<i64>)> = Vec::new();
    for guild in &guilds {
        visible.extend(
            guild
                .channels
                .iter()
                .chain(&guild.threads)
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

    let guild_layout = crate::routes::guild_layout::load(state, user_id).await?;
    Ok(ReadyEvent {
        v: 1,
        user,
        session_id: session_id.to_owned(),
        guilds,
        private_channels,
        presences,
        read_states,
        relationships,
        guild_layout,
        media: voice::media_config(&state.config),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_allowance_is_a_sliding_window() {
        let mut allowance = Allowance::new(2, Duration::from_secs(60));
        let start = Instant::now();
        assert!(allowance.allow(start) && allowance.allow(start + Duration::from_secs(1)));
        assert!(!allowance.allow(start + Duration::from_secs(2)));
        assert!(allowance.allow(start + Duration::from_secs(61)), "the first one left the window");
    }
}
