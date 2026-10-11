//! The voice-state table and its lifecycle (docs/design/voice.md §1.2, §1.5, §1.6).
//!
//! States live in memory, keyed by user id (one voice connection per user), and are rebuilt from LiveKit on start. A state is
//! bound to the gateway session that sent op 4; every new binding gets a new voice `session_id`, which LiveKit carries back in
//! the participant metadata, so late or duplicated webhooks of an older binding never touch a newer one. Every token also carries
//! a fresh nonce: when a binding gets a new token (a client reconnecting), only LiveKit events of the latest token count, so the
//! old connection leaving never ends the state, whichever order the webhooks arrive in.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{ADMINISTRATOR, CONNECT, MOVE_MEMBERS, PRIORITY_SPEAKER, SPEAK, STREAM, USE_VAD, VIEW_CHANNEL};
use vokko_protocol::api::{
    CALL_PARTICIPANT_MAX, ChannelType, GatewayEvent, Snowflake, VoiceConnectFailed, VoiceConnectFailure, VoiceServerUpdate, VoiceState, VoiceStateUpdateCommand,
};

use super::livekit::{Participant, RoomService};
use super::token::{self, Claims};
use super::{room_channel, room_name, unix_now};
use crate::access;
use crate::auth::random_hex;
use crate::config::LiveKitConfig;
use crate::hub::Session;
use crate::state::AppState;
use crate::store::{self, ChannelRow, iso};

/// What every recipient may do in a DM / group DM call (no permission bits in DMs, no Nitro gates).
pub const DM_CALL_PERMISSIONS: u64 = VIEW_CHANNEL | CONNECT | SPEAK | STREAM | USE_VAD;

#[derive(Clone, Debug)]
pub struct VoiceEntry {
    pub guild_id: Option<i64>,
    pub channel_id: i64,
    pub user_id: i64,
    /// Voice session id, also in the LiveKit participant metadata.
    pub session_id: String,
    /// Nonce of the latest token issued for this binding (participant metadata `token`).
    pub token_nonce: String,
    /// When the binding or its latest token was handed out (orphan sweeps spare young bindings).
    pub issued_at: Instant,
    /// Gateway session that owns the state; `None` for a state rebuilt from LiveKit that no client has claimed yet.
    pub gateway_session: Option<String>,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_video: bool,
    pub self_stream: bool,
    pub suppress: bool,
    /// LiveKit reported the participant (webhook or reconciliation).
    pub connected: bool,
    pub connected_at: OffsetDateTime,
    /// Rebuilt from LiveKit at this moment and not claimed by an op 4 since.
    pub unbound_since: Option<Instant>,
}

impl VoiceEntry {
    pub fn to_api(&self, left: bool) -> VoiceState {
        VoiceState {
            guild_id: self.guild_id.map(Snowflake::from),
            channel_id: (!left).then(|| Snowflake::from(self.channel_id)),
            user_id: Snowflake::from(self.user_id),
            member: None,
            session_id: self.session_id.clone(),
            deaf: false,
            mute: false,
            self_deaf: self.self_deaf,
            self_mute: self.self_mute,
            self_video: self.self_video,
            self_stream: self.self_stream,
            suppress: self.suppress,
            request_to_speak_timestamp: None,
            connected_at: iso(self.connected_at),
        }
    }
}

/// How long a fresh binding (or reissued token) is spared by the orphan sweep: LiveKit may still list the previous connection.
const ISSUE_GRACE: Duration = Duration::from_secs(15);

pub struct Voice {
    pub rooms: Arc<dyn RoomService>,
    states: Mutex<HashMap<i64, VoiceEntry>>,
    /// One async lock per user: op 4 handling and every removal (state + LiveKit `RemoveParticipant`) run under it, so a
    /// removal by identity can never land after a newer binding of the same user was handed out. Entries go away with their
    /// last guard.
    users: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    /// Joins hold it shared from their access check to their insert; evictions (channel/guild delete, member removal) hold it
    /// exclusively, so a join that passed its checks before an eviction cannot insert a state after it.
    admission: tokio::sync::RwLock<()>,
    /// DM and group DM calls riding on these states.
    pub calls: super::calls::Calls,
}

/// A user's serial lock; dropping it forgets the per-user mutex once nobody else holds or waits for it.
pub struct UserSerial<'a> {
    voice: &'a Voice,
    user_id: i64,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Drop for UserSerial<'_> {
    fn drop(&mut self) {
        self.guard.take();
        let mut users = lock(&self.voice.users);
        // Only the map's own handle left: no holder, no waiter.
        if users.get(&self.user_id).is_some_and(|mutex| Arc::strong_count(mutex) == 1) {
            users.remove(&self.user_id);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Voice {
    pub fn new(rooms: Arc<dyn RoomService>) -> Self {
        Self {
            rooms,
            states: Mutex::new(HashMap::new()),
            users: Mutex::new(HashMap::new()),
            admission: tokio::sync::RwLock::new(()),
            calls: Default::default(),
        }
    }

    async fn user_lock(&self, user_id: i64) -> UserSerial<'_> {
        let mutex = lock(&self.users).entry(user_id).or_default().clone();
        let guard = mutex.lock_owned().await;
        UserSerial { voice: self, user_id, guard: Some(guard) }
    }

    /// Per-user locks currently allocated (tests check they are pruned).
    pub fn serial_entries(&self) -> usize {
        lock(&self.users).len()
    }

    pub fn get(&self, user_id: i64) -> Option<VoiceEntry> {
        lock(&self.states).get(&user_id).cloned()
    }

    pub fn all(&self) -> Vec<VoiceEntry> {
        lock(&self.states).values().cloned().collect()
    }

    /// Wire states of the given channels (READY / GUILD_CREATE), oldest first.
    pub fn states_in(&self, channel_ids: &HashSet<i64>) -> Vec<VoiceState> {
        let mut entries: Vec<VoiceEntry> = lock(&self.states).values().filter(|entry| channel_ids.contains(&entry.channel_id)).cloned().collect();
        entries.sort_by_key(|entry| (entry.connected_at, entry.user_id));
        entries.iter().map(|entry| entry.to_api(false)).collect()
    }

    /// Removes the user's state if `matches` holds for it.
    fn remove_if(&self, user_id: i64, matches: impl FnOnce(&VoiceEntry) -> bool) -> Option<VoiceEntry> {
        let mut states = lock(&self.states);
        if states.get(&user_id).is_some_and(matches) { states.remove(&user_id) } else { None }
    }

    fn update_if(&self, user_id: i64, change: impl FnOnce(&mut VoiceEntry) -> bool) -> Option<VoiceEntry> {
        let mut states = lock(&self.states);
        let entry = states.get_mut(&user_id)?;
        change(entry).then(|| entry.clone())
    }
}

fn fail(session: &Session, command: &VoiceStateUpdateCommand, channel_id: Snowflake, reason: VoiceConnectFailure) {
    let event = GatewayEvent::VoiceConnectFailed(VoiceConnectFailed { guild_id: command.guild_id, channel_id, reason });
    session.dispatch(event.name(), event.data());
}

/// Op 4 from `session`: join, move, re-bind, toggle self mute/deafen, or leave (`channel_id: null`).
pub async fn handle_command(state: &AppState, session: &Arc<Session>, command: VoiceStateUpdateCommand) {
    let user_id = session.user_id;
    let _admitted = state.voice.admission.read().await;
    let _serial = state.voice.user_lock(user_id).await;
    let Some(target) = command.channel_id else {
        // A device that lost its state to another device cannot disconnect the newer one.
        let removed = state.voice.remove_if(user_id, |entry| entry.gateway_session.as_deref().is_none_or(|owner| owner == session.id));
        if let Some(entry) = removed {
            forget_participant(state, &entry).await;
            broadcast(state, &entry, true).await;
        }
        return;
    };
    let Some(livekit) = state.config.livekit.clone() else {
        return fail(session, &command, target, VoiceConnectFailure::MediaUnavailable);
    };
    let channel_id = target.db();
    let row = match store::channel_row(state, channel_id).await {
        Ok(Some(row)) if row.channel_type() == ChannelType::GuildVoice || row.is_dm() => row,
        _ => return fail(session, &command, target, VoiceConnectFailure::MissingPermissions),
    };
    let admitted = if row.is_dm() { admit_dm(state, user_id, &row).await } else { admit_guild(state, user_id, &row).await };
    let (guild_id, permissions) = match admitted {
        Ok(admitted) => admitted,
        Err(reason) => return fail(session, &command, target, reason),
    };

    // The same gateway session in the same channel: a self mute/deafen toggle (no new token), or, when nothing changes, a
    // client reconnecting to LiveKit, which gets a fresh token for the same binding.
    let mut changed = false;
    let same = state.voice.update_if(user_id, |entry| {
        if entry.channel_id != channel_id || entry.gateway_session.as_deref() != Some(session.id.as_str()) {
            return false;
        }
        let (self_mute, self_deaf) = (command.self_mute || command.self_deaf, command.self_deaf);
        changed = (entry.self_mute, entry.self_deaf) != (self_mute, self_deaf);
        entry.self_mute = self_mute;
        entry.self_deaf = self_deaf;
        true
    });
    if let Some(entry) = same {
        if changed {
            broadcast(state, &entry, false).await;
            return;
        }
        // Reconnect: a new token (new nonce) for the same session; the old connection's events stop counting.
        let nonce = random_hex(8);
        let Some(token) = mint(state, &livekit, user_id, permissions, channel_id, &entry.session_id, &nonce).await else {
            return fail(session, &command, target, VoiceConnectFailure::MediaUnavailable);
        };
        let reissued = state.voice.update_if(user_id, |current| {
            let matches = current.session_id == entry.session_id;
            if matches {
                current.token_nonce = nonce.clone();
                current.issued_at = Instant::now();
                current.connected = false;
            }
            matches
        });
        if reissued.is_some() {
            send_server_update(session, guild_id, target, &livekit.url, token, &entry.session_id);
            spawn_connect_timeout(state.clone(), user_id, entry.session_id.clone(), nonce);
        }
        return;
    }

    let (user_limit, limited) = if row.is_dm() {
        (CALL_PARTICIPANT_MAX as u32, true)
    } else {
        let (_, user_limit) = super::channel_settings(row.bitrate, row.user_limit);
        (user_limit, user_limit > 0 && permissions & MOVE_MEMBERS == 0)
    };

    let session_id = random_hex(16);
    let nonce = random_hex(8);
    let Some(livekit_token) = mint(state, &livekit, user_id, permissions, channel_id, &session_id, &nonce).await else {
        return fail(session, &command, target, VoiceConnectFailure::MediaUnavailable);
    };
    let entry = VoiceEntry {
        guild_id,
        channel_id,
        user_id,
        session_id: session_id.clone(),
        token_nonce: nonce.clone(),
        issued_at: Instant::now(),
        gateway_session: Some(session.id.clone()),
        self_mute: command.self_mute || command.self_deaf,
        self_deaf: command.self_deaf,
        self_video: false,
        self_stream: false,
        suppress: permissions & SPEAK == 0,
        connected: false,
        connected_at: OffsetDateTime::now_utc(),
        unbound_since: None,
    };
    // The limit check and the insert share one lock, so concurrent joins cannot both take the last slot.
    let previous = {
        let mut states = lock(&state.voice.states);
        let inside = states.values().filter(|other| other.channel_id == channel_id && other.user_id != user_id).count();
        if limited && inside >= user_limit as usize {
            drop(states);
            return fail(session, &command, target, VoiceConnectFailure::ChannelFull);
        }
        states.insert(user_id, entry.clone())
    };

    send_server_update(session, guild_id, target, &livekit.url, livekit_token, &session_id);
    if row.is_dm() {
        // Starts the call (CALL_CREATE, ringing) or adds us to it.
        super::calls::joined(state, &row, user_id).await;
    }
    let viewers = broadcast(state, &entry, false).await;
    if let Some(previous) = previous.filter(|previous| previous.channel_id != channel_id) {
        // Moved: leave the old room, and tell whoever could only see the old channel.
        forget_participant(state, &previous).await;
        if let Ok(Some(old_row)) = store::channel_row(state, previous.channel_id).await
            && let Ok(old_viewers) = access::channel_viewers(state, &old_row).await
        {
            let viewers: HashSet<i64> = viewers.into_iter().collect();
            let only_old: Vec<i64> = old_viewers.into_iter().filter(|viewer| !viewers.contains(viewer)).collect();
            state.hub.send(&only_old, &GatewayEvent::VoiceStateUpdate(Box::new(previous.to_api(true))));
        }
        release_channel(state, previous.channel_id).await;
    }
    spawn_connect_timeout(state.clone(), user_id, session_id, nonce);
}

/// Guild voice: the channel's permissions need VIEW_CHANNEL + CONNECT, and a timed-out member stays out.
async fn admit_guild(state: &AppState, user_id: i64, row: &ChannelRow) -> Result<(Option<i64>, u64), VoiceConnectFailure> {
    let guild_id = row.guild_id.ok_or(VoiceConnectFailure::MissingPermissions)?;
    let guild = access::guild_access(state, user_id, guild_id).await.map_err(|_| VoiceConnectFailure::MissingPermissions)?;
    if guild.timed_out && guild.owner_id != user_id && guild.permissions & ADMINISTRATOR == 0 {
        return Err(VoiceConnectFailure::TimedOut);
    }
    match access::channel_access(state, user_id, row.id).await {
        Ok(channel) if channel.permissions & (VIEW_CHANNEL | CONNECT) == VIEW_CHANNEL | CONNECT => Ok((Some(guild_id), channel.permissions)),
        _ => Err(VoiceConnectFailure::MissingPermissions),
    }
}

/// DM call: recipients only; a block in either direction closes a 1:1 DM's call like its messages.
async fn admit_dm(state: &AppState, user_id: i64, row: &ChannelRow) -> Result<(Option<i64>, u64), VoiceConnectFailure> {
    access::channel_access(state, user_id, row.id).await.map_err(|_| VoiceConnectFailure::MissingPermissions)?;
    if row.channel_type() == ChannelType::Dm {
        let others: Vec<i64> = access::channel_viewers(state, row).await.unwrap_or_default().into_iter().filter(|id| *id != user_id).collect();
        match super::calls::blocked_with(state, user_id, &others).await {
            Ok(blocked) if blocked.is_empty() => {}
            Ok(_) => return Err(VoiceConnectFailure::Blocked),
            Err(_) => return Err(VoiceConnectFailure::MissingPermissions),
        }
    }
    Ok((None, DM_CALL_PERMISSIONS))
}

/// A LiveKit token for `session_id`'s binding in the channel, grants from `permissions`.
async fn mint(state: &AppState, livekit: &LiveKitConfig, user_id: i64, permissions: u64, channel_id: i64, session_id: &str, nonce: &str) -> Option<String> {
    let display_name = match store::user(state, user_id).await {
        Ok(Some(user)) => user.global_name.unwrap_or(user.username),
        _ => String::new(),
    };
    let mut attributes = Map::new();
    if permissions & PRIORITY_SPEAKER != 0 {
        attributes.insert("vokko.priority".to_owned(), Value::from("1"));
    }
    if permissions & USE_VAD == 0 {
        attributes.insert("vokko.vad".to_owned(), Value::from("0"));
    }
    let now = unix_now();
    let claims = Claims {
        iss: livekit.api_key.clone(),
        sub: user_id.to_string(),
        nbf: now,
        exp: now + token::TOKEN_TTL_SECS,
        name: display_name,
        metadata: json!({"session_id": session_id, "token": nonce}).to_string(),
        attributes,
        video: Some(token::media_grant(&room_name(channel_id), permissions)),
        sha256: None,
    };
    token::sign(&livekit.api_secret, &claims)
}

fn send_server_update(session: &Session, guild_id: Option<i64>, channel_id: Snowflake, endpoint: &str, token: String, session_id: &str) {
    let event = GatewayEvent::VoiceServerUpdate(VoiceServerUpdate {
        guild_id: guild_id.map(Snowflake::from),
        channel_id,
        endpoint: endpoint.to_owned(),
        token,
        session_id: session_id.to_owned(),
    });
    session.dispatch(event.name(), event.data());
}

/// No `participant_joined` for this token in time: the client never made it to LiveKit.
fn spawn_connect_timeout(state: AppState, user_id: i64, session_id: String, nonce: String) {
    tokio::spawn(async move {
        tokio::time::sleep(state.config.voice_connect_timeout).await;
        let _serial = state.voice.user_lock(user_id).await;
        if let Some(entry) = state.voice.remove_if(user_id, |entry| entry.session_id == session_id && entry.token_nonce == nonce && !entry.connected) {
            forget_participant(&state, &entry).await;
            broadcast(&state, &entry, true).await;
        }
    });
}

/// The gateway session `gateway_session` detached; if it is still gone after the grace period (no resume, no op 4 from a new
/// session), its voice state ends.
pub fn gateway_detached(state: &AppState, gateway_session: String) {
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(state.config.voice_gateway_grace).await;
        let still_gone = match state.hub.session(&gateway_session) {
            Some(session) => session.detached_for().is_some_and(|gone| gone >= state.config.voice_gateway_grace),
            None => true,
        };
        if !still_gone {
            return;
        }
        let owned: Vec<i64> = state
            .voice
            .all()
            .into_iter()
            .filter(|entry| entry.gateway_session.as_deref() == Some(gateway_session.as_str()))
            .map(|entry| entry.user_id)
            .collect();
        for user_id in owned {
            let _serial = state.voice.user_lock(user_id).await;
            if let Some(entry) = state.voice.remove_if(user_id, |entry| entry.gateway_session.as_deref() == Some(gateway_session.as_str())) {
                forget_participant(&state, &entry).await;
                broadcast(&state, &entry, true).await;
            }
        }
    });
}

/// Removal from the LiveKit room, awaited under the user's lock (see `Voice::users`). Best effort: a failed call is logged
/// and the room's participant is removed by the next reconciliation or its stale `participant_joined`.
async fn forget_participant(state: &AppState, entry: &VoiceEntry) {
    if let Err(error) = state.voice.rooms.remove_participant(&room_name(entry.channel_id), &entry.user_id.to_string()).await {
        tracing::warn!("voice: {error}");
    }
}

/// Exclusive admission: no join is between its access check and its insert while this is held.
pub type Eviction<'a> = tokio::sync::RwLockWriteGuard<'a, ()>;

/// Ends every state `select` picks: LiveKit removal plus `channel_id: null` to whoever can still see the channel. The caller
/// holds `Eviction`, so in-flight joins have finished and later ones see the change.
async fn evict(state: &AppState, select: impl Fn(&VoiceEntry) -> bool) {
    let users: Vec<i64> = state.voice.all().into_iter().filter(|entry| select(entry)).map(|entry| entry.user_id).collect();
    for user_id in users {
        let _serial = state.voice.user_lock(user_id).await;
        if let Some(entry) = state.voice.remove_if(user_id, &select) {
            forget_participant(state, &entry).await;
            broadcast(state, &entry, true).await;
        }
    }
}

/// Call before deleting the channel row and keep the returned guard until the row is gone, so no join slips in between.
#[must_use = "hold the guard until the channel row is deleted"]
pub async fn channel_deleted(state: &AppState, channel_id: i64) -> Eviction<'_> {
    let guard = state.voice.admission.write().await;
    evict(state, |entry| entry.channel_id == channel_id).await;
    guard
}

/// Like `channel_deleted`, for a whole guild.
#[must_use = "hold the guard until the guild row is deleted"]
pub async fn guild_deleted(state: &AppState, guild_id: i64) -> Eviction<'_> {
    let guard = state.voice.admission.write().await;
    evict(state, |entry| entry.guild_id == Some(guild_id)).await;
    guard
}

/// Left, kicked or banned (after the member row is gone): no voice in that guild any more.
pub async fn member_removed(state: &AppState, guild_id: i64, user_id: i64) {
    let _guard = state.voice.admission.write().await;
    evict(state, |entry| entry.user_id == user_id && entry.guild_id == Some(guild_id)).await;
}

/// A recipient left the group DM `channel_id`: out of its call, and no longer rung. Keep the returned guard until the recipient
/// row is deleted, so the leaver cannot rejoin the call in between.
#[must_use = "hold the guard until the recipient row is deleted"]
pub async fn dm_recipient_removed(state: &AppState, channel_id: i64, user_id: i64) -> Eviction<'_> {
    let guard = state.voice.admission.write().await;
    evict(state, |entry| entry.user_id == user_id && entry.channel_id == channel_id).await;
    super::calls::recipient_removed(state, channel_id, user_id).await;
    guard
}

/// VOICE_STATE_UPDATE to everyone who can see the channel (`left`: with `channel_id: null`). Returns the receivers.
pub(crate) async fn broadcast(state: &AppState, entry: &VoiceEntry, left: bool) -> Vec<i64> {
    let Ok(Some(row)) = store::channel_row(state, entry.channel_id).await else { return Vec::new() };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return Vec::new() };
    let mut payload = entry.to_api(left);
    if let Some(guild_id) = entry.guild_id {
        payload.member = store::member(state, guild_id, entry.user_id).await.ok().flatten();
    }
    state.hub.send(&viewers, &GatewayEvent::VoiceStateUpdate(Box::new(payload)));
    if left {
        release_channel(state, entry.channel_id).await;
    }
    viewers
}

/// The last person left `channel_id`: its voice status goes (VOICE_CHANNEL_STATUS_UPDATE with `null`), a DM call ends.
async fn release_channel(state: &AppState, channel_id: i64) {
    if state.voice.all().iter().any(|entry| entry.channel_id == channel_id) {
        return;
    }
    super::calls::release(state, channel_id).await;
    let cleared: Result<Option<(Option<i64>,)>, _> =
        sqlx::query_as("UPDATE channels SET voice_status = NULL WHERE id = $1 AND voice_status IS NOT NULL RETURNING guild_id")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await;
    if let Ok(Some((Some(guild_id),))) = cleared {
        super::status::announce(state, channel_id, guild_id, None).await;
    }
}

/// Whether `user_id` is in voice in `channel_id`.
pub fn in_channel(state: &AppState, user_id: i64, channel_id: i64) -> bool {
    state.voice.get(user_id).is_some_and(|entry| entry.channel_id == channel_id)
}

/// LiveKit's view of a participant agrees with `entry`'s binding (any token of it).
fn same_binding(entry: &VoiceEntry, participant: &Participant) -> bool {
    participant.user_id() == Some(entry.user_id) && participant.session_id().as_deref() == Some(entry.session_id.as_str())
}

/// ... and comes from the binding's latest token.
fn latest_token(entry: &VoiceEntry, participant: &Participant) -> bool {
    same_binding(entry, participant) && participant.token_nonce() == entry.token_nonce
}

/// Startup: rebuilds the table from LiveKit's rooms without emitting anything; restored states wait for their clients to
/// re-send op 4 (`voice_gateway_grace`), see `reconcile`.
pub async fn restore(state: &AppState) {
    let rooms = match state.voice.rooms.list_rooms().await {
        Ok(rooms) => rooms,
        Err(error) => {
            tracing::warn!("voice: cannot restore states: {error}");
            return;
        }
    };
    for room in rooms {
        let Some(channel_id) = room_channel(&room) else { continue };
        let Ok(Some(row)) = store::channel_row(state, channel_id).await else { continue };
        let Ok(participants) = state.voice.rooms.list_participants(&room).await else { continue };
        for participant in participants {
            let (Some(user_id), Some(session_id)) = (participant.user_id(), participant.session_id()) else { continue };
            let entry = VoiceEntry {
                guild_id: row.guild_id,
                channel_id,
                user_id,
                session_id,
                token_nonce: participant.token_nonce(),
                issued_at: Instant::now(),
                gateway_session: None,
                self_mute: participant.mic_muted(),
                self_deaf: false,
                self_video: participant.camera(),
                self_stream: participant.screen_share(),
                suppress: false,
                connected: true,
                connected_at: OffsetDateTime::now_utc(),
                unbound_since: Some(Instant::now()),
            };
            lock(&state.voice.states).entry(user_id).or_insert(entry);
        }
    }
}

/// One reconciliation pass: restored states nobody claimed within the grace period end; states LiveKit no longer lists end;
/// states it lists become connected; and LiveKit participants in `v<id>` rooms that match no state are removed (a failed
/// `RemoveParticipant` after a kick, a delete or a restart), sparing users whose binding is younger than `ISSUE_GRACE`.
pub async fn reconcile(state: &AppState) {
    let grace = state.config.voice_gateway_grace;
    for entry in state.voice.all().into_iter().filter(|entry| entry.unbound_since.is_some_and(|since| since.elapsed() >= grace)) {
        let _serial = state.voice.user_lock(entry.user_id).await;
        if let Some(entry) = state.voice.remove_if(entry.user_id, |current| current.session_id == entry.session_id && current.gateway_session.is_none()) {
            forget_participant(state, &entry).await;
            broadcast(state, &entry, true).await;
        }
    }
    let mut channels: HashSet<i64> = state.voice.all().iter().map(|entry| entry.channel_id).collect();
    match state.voice.rooms.list_rooms().await {
        Ok(rooms) => channels.extend(rooms.iter().filter_map(|room| room_channel(room))),
        Err(error) => tracing::warn!("voice: reconcile cannot list rooms: {error}"),
    }
    for channel_id in channels {
        let room = room_name(channel_id);
        let Ok(participants) = state.voice.rooms.list_participants(&room).await else { continue };
        for entry in state.voice.all().into_iter().filter(|entry| entry.channel_id == channel_id) {
            let present = participants.iter().any(|participant| same_binding(&entry, participant));
            if present && !entry.connected {
                state.voice.update_if(entry.user_id, |current| {
                    let matches = current.session_id == entry.session_id;
                    current.connected |= matches;
                    matches
                });
            } else if !present && entry.connected {
                let _serial = state.voice.user_lock(entry.user_id).await;
                if let Some(gone) = state.voice.remove_if(entry.user_id, |current| current.session_id == entry.session_id && current.connected) {
                    broadcast(state, &gone, true).await;
                }
            }
        }
        for participant in &participants {
            let Some(user_id) = participant.user_id() else { continue };
            let _serial = state.voice.user_lock(user_id).await;
            // Removal is by identity: never while the user holds any state in this room, or a young binding anywhere.
            let keep = state.voice.get(user_id).is_some_and(|entry| entry.channel_id == channel_id || entry.issued_at.elapsed() < ISSUE_GRACE);
            if !keep && let Err(error) = state.voice.rooms.remove_participant(&room, &participant.identity).await {
                tracing::warn!("voice: {error}");
            }
        }
    }
}

/// Restores from LiveKit, then reconciles every `voice_reconcile_interval`. Does nothing when voice is off.
pub fn spawn_tasks(state: AppState) {
    if state.config.livekit.is_none() {
        // No voice: no call can still be going on.
        tokio::spawn(async move { super::calls::recover(&state).await });
        return;
    }
    tokio::spawn(async move {
        restore(&state).await;
        super::calls::recover(&state).await;
        let period = state.config.voice_reconcile_interval;
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            ticker.tick().await;
            reconcile(&state).await;
        }
    });
}

/// Webhook effects, keyed by the participant's binding (see `webhook`).
pub(crate) async fn participant_joined(state: &AppState, channel_id: i64, participant: &Participant) {
    let Some(user_id) = participant.user_id() else { return };
    let _serial = state.voice.user_lock(user_id).await;
    let marked = state.voice.update_if(user_id, |entry| {
        let matches = entry.channel_id == channel_id && latest_token(entry, participant);
        entry.connected |= matches;
        matches
    });
    if marked.is_none() && state.voice.get(user_id).is_none_or(|entry| entry.channel_id != channel_id) {
        // Nobody granted this participant a place in this room any more (left, moved, timed out): remove it.
        if let Err(error) = state.voice.rooms.remove_participant(&room_name(channel_id), &user_id.to_string()).await {
            tracing::warn!("voice: {error}");
        }
    }
}

pub(crate) async fn participant_left(state: &AppState, channel_id: i64, participant: &Participant, created_at: Option<i64>) {
    let Some(user_id) = participant.user_id() else { return };
    let _serial = state.voice.user_lock(user_id).await;
    let removed = state.voice.remove_if(user_id, |entry| {
        let stale = created_at.is_some_and(|at| at < entry.connected_at.unix_timestamp());
        entry.channel_id == channel_id && latest_token(entry, participant) && !stale
    });
    if let Some(entry) = removed {
        broadcast(state, &entry, true).await;
    }
}

pub(crate) async fn track_changed(state: &AppState, channel_id: i64, participant: &Participant, source: &str, published: bool) {
    let Some(user_id) = participant.user_id() else { return };
    let changed = state.voice.update_if(user_id, |entry| {
        if entry.channel_id != channel_id || !same_binding(entry, participant) {
            return false;
        }
        let flag = if source.eq_ignore_ascii_case("CAMERA") {
            &mut entry.self_video
        } else if source.eq_ignore_ascii_case("SCREEN_SHARE") {
            &mut entry.self_stream
        } else {
            return false;
        };
        let changed = *flag != published;
        *flag = published;
        changed
    });
    if let Some(entry) = changed {
        broadcast(state, &entry, false).await;
    }
}

pub(crate) async fn room_finished(state: &AppState, channel_id: i64) {
    for entry in state.voice.all().into_iter().filter(|entry| entry.channel_id == channel_id && entry.connected) {
        let _serial = state.voice.user_lock(entry.user_id).await;
        if let Some(gone) = state.voice.remove_if(entry.user_id, |current| current.session_id == entry.session_id) {
            broadcast(state, &gone, true).await;
        }
    }
}
