//! Spotify sessions (docs/design/spotify-bot.md sections 4.2, 5 and 8): at most one in-memory session on the whole server, shaped
//! like a Stremio session. The server owns the state (queue, history, loop, who added what) and tells the native bot what to
//! play with `PUT {bot}/session` (re-sent as a lease); the bot reports back at `POST /internal/spotify/bot`.
//! `PUT|PATCH|GET|DELETE /channels/{id}/spotify`, `POST /channels/{id}/spotify/listener-token` and SPOTIFY_UPDATE.
use std::collections::HashSet;
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use axum::{Json, Router};
use serde::Deserialize;
use vokko_protocol::api::{
    GatewayEvent, SPOTIFY_EVENT_QUEUE_MAX, SPOTIFY_QUEUE_MAX, Snowflake, SpotifyListenerToken, SpotifyLoop, SpotifyPatchRequest, SpotifyQueueEntry,
    SpotifyReply, SpotifyStartRequest, SpotifyState, SpotifyStatus, SpotifyTrack, SpotifyUpdate,
};

use super::token::{self, Claims, VideoGrant};
use super::watch::{CONTROL_BURST, CONTROL_PER_SECOND, require_in_voice};
use super::{unix_millis, unix_now};
use crate::access;
use crate::auth::{AuthUser, random_hex};
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::spotify::bot::{BotError, Desired, secrets_match};
use crate::spotify::queue::{Back, Leave, Queue};
use crate::spotify::{Active, Kind, active, catalog_error, parse_uri};
use crate::state::AppState;
use crate::store;
use crate::stremio::{limit, lock};

const BOT_TOKEN_TTL_SECS: i64 = 12 * 60 * 60;
const LISTENER_TOKEN_TTL_SECS: i64 = 6 * 60 * 60;
/// Fixed texts: nothing the bot or Spotify says reaches the state.
const NEEDS_LOGIN: &str = "Spotify needs the server owner to sign in again";
const LOST_CONNECTION: &str = "Spotify lost its connection.";
const SKIPPED: &str = "Skipped an unavailable track";
/// Playlist pages read to fill a queue (100 items each) and the most tracks an album can hold.
const FILL_PAGES: u32 = 3;
const PAGE_ITEMS: u32 = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/spotify", put(start).patch(control).get(read).delete(stop))
        .route("/channels/{id}/spotify/listener-token", post(listener_token))
}

pub struct Session {
    channel_id: i64,
    /// The media LiveKit room of this session: `spotify-<channel_id>-<random>`, new for every session.
    room: String,
    started_by: i64,
    queue: Queue,
    status: SpotifyStatus,
    error: Option<&'static str>,
    notice: Option<(&'static str, Instant)>,
    playing: bool,
    position_ms: u64,
    updated_at_ms: i64,
    /// The newest change; the bot echoes the newest it has applied.
    seq: u64,
    /// `seq` of the change that loaded the current track: older `ended` and `error` events describe an earlier play.
    track_seq: u64,
    /// `seq` of the last change that moved the position (track, pause, resume, seek): older `position` events are stale.
    steer_seq: u64,
    token: String,
    paused_since: Option<Instant>,
    /// Nothing is left to play since then.
    idle_since: Option<Instant>,
    error_since: Option<Instant>,
    /// The track was sent again once after an `io` error.
    retried: bool,
    /// The bot has to be sent the desired state again (a `PUT` failed).
    dirty: bool,
    last_put: Instant,
    bot_down_since: Option<Instant>,
}

/// What a change leaves to do outside the lock.
struct Change {
    /// The state for SPOTIFY_UPDATE (queue cut to 50) and for the HTTP reply (the whole queue).
    event: SpotifyState,
    reply: SpotifyState,
    desired: Option<Desired>,
    stop_bot: bool,
}

impl Session {
    fn view(&self, full: bool) -> SpotifyState {
        let shown = if full { SPOTIFY_QUEUE_MAX } else { SPOTIFY_EVENT_QUEUE_MAX };
        SpotifyState {
            status: self.status,
            error: self.error.map(str::to_owned),
            notice: self.notice.map(|(text, _)| text.to_owned()),
            track: self.queue.current.clone(),
            playing: self.playing,
            position_ms: self.position_ms,
            updated_at_ms: self.updated_at_ms,
            loop_mode: self.queue.loop_mode,
            queue: self
                .queue
                .entries
                .iter()
                .take(shown)
                .map(|entry| SpotifyQueueEntry { qid: entry.qid.clone(), track: entry.track.clone(), added_by: Snowflake::from(entry.added_by) })
                .collect(),
            queue_len: self.queue.entries.len() as u32,
            can_previous: self.queue.can_previous(),
            started_by: Snowflake::from(self.started_by),
            bot_identity: bot_identity(self.channel_id),
        }
    }

    /// Where the track is right now.
    fn here(&self, now_ms: i64) -> u64 {
        let moved = if self.playing { (now_ms - self.updated_at_ms).max(0) as u64 } else { 0 };
        let position = self.position_ms + moved;
        match self.queue.current.as_ref().map(|track| track.duration_ms) {
            Some(duration) if duration > 0 => position.min(duration),
            _ => position,
        }
    }

    fn bump(&mut self, state: &AppState) {
        self.seq = state.spotify.next_seq();
    }

    fn sync_status(&mut self) {
        if matches!(self.status, SpotifyStatus::Error | SpotifyStatus::Starting | SpotifyStatus::Loading) {
            return;
        }
        self.status = if self.playing && self.queue.current.is_some() { SpotifyStatus::Playing } else { SpotifyStatus::Paused };
    }

    /// The current track was just replaced (play now, skip, previous, the end of the last one): it starts from the top.
    fn new_track(&mut self, state: &AppState, now_ms: i64) {
        self.bump(state);
        self.track_seq = self.seq;
        self.steer_seq = self.seq;
        self.status = SpotifyStatus::Loading;
        self.error = None;
        self.playing = true;
        self.position_ms = 0;
        self.updated_at_ms = now_ms;
        self.paused_since = None;
        self.idle_since = None;
        self.error_since = None;
        self.retried = false;
        self.dirty = false;
        self.bot_down_since = None;
    }

    /// Nothing is left to play: the bot is let go and the session waits for the next `queue_add` or `PUT`.
    fn go_idle(&mut self, state: &AppState, now_ms: i64) -> bool {
        self.bump(state);
        self.track_seq = self.seq;
        self.steer_seq = self.seq;
        self.status = SpotifyStatus::Paused;
        self.error = None;
        self.playing = false;
        self.position_ms = 0;
        self.updated_at_ms = now_ms;
        self.paused_since = None;
        self.idle_since = Some(Instant::now());
        self.dirty = false;
        true
    }

    /// The new position and playing flag of a play, pause or seek.
    fn steer(&mut self, state: &AppState, playing: Option<bool>, position_ms: Option<u64>, now_ms: i64) {
        self.position_ms = position_ms.unwrap_or_else(|| self.here(now_ms));
        self.playing = playing.unwrap_or(self.playing);
        self.updated_at_ms = now_ms;
        self.bump(state);
        self.steer_seq = self.seq;
        self.paused_since = if self.playing { None } else { self.paused_since.or(Some(Instant::now())) };
        self.sync_status();
    }

    /// The track ended, was skipped or cannot be played: the next one starts, or the session goes idle.
    fn leave(&mut self, state: &AppState, how: Leave, now_ms: i64) -> bool {
        if self.queue.advance(how).is_some() {
            self.new_track(state, now_ms);
            false
        } else {
            self.go_idle(state, now_ms)
        }
    }

    /// Shows `text` for a moment (the sweep clears it).
    fn note(&mut self, text: &'static str) {
        self.notice = Some((text, Instant::now()));
    }

    /// The session stops being played: the tile shows `text` until the hold runs out.
    fn fail(&mut self, state: &AppState, text: &'static str, now_ms: i64) {
        self.bump(state);
        self.status = SpotifyStatus::Error;
        self.error = Some(text);
        self.playing = false;
        self.position_ms = self.here(now_ms);
        self.updated_at_ms = now_ms;
        self.error_since = Some(Instant::now());
        self.paused_since = None;
        self.dirty = false;
    }

    fn desired(&self, state: &AppState, now_ms: i64) -> Option<Desired> {
        let cfg = state.config.spotify.as_ref()?;
        if self.status == SpotifyStatus::Error {
            return None;
        }
        let track = self.queue.current.as_ref()?;
        Some(Desired {
            channel_id: self.channel_id.to_string(),
            livekit_url: cfg.bot_media_url.clone(),
            token: self.token.clone(),
            track: track.uri.clone(),
            next: self.queue.upcoming().map(|next| next.uri.clone()),
            position_ms: self.here(now_ms),
            playing: self.playing,
            seq: self.seq,
        })
    }

    fn change(&self, state: &AppState, now_ms: i64, stop_bot: bool) -> Change {
        Change { event: self.view(false), reply: self.view(true), desired: self.desired(state, now_ms), stop_bot }
    }
}

pub fn bot_identity(channel_id: i64) -> String {
    format!("bot:spotify:{channel_id}")
}

fn new_room(channel_id: i64) -> String {
    format!("spotify-{channel_id}-{}", random_hex(8))
}

/// The bot's token: it publishes one `screen_share_audio` source into the session's room and nothing else (no video, no
/// subscribing, no data).
fn bot_token(state: &AppState, channel_id: i64, room: &str) -> Option<String> {
    let cfg = state.config.spotify.as_ref()?;
    let now = unix_now();
    let claims = Claims {
        iss: cfg.media_api_key.clone(),
        sub: bot_identity(channel_id),
        nbf: now - 10,
        exp: now + BOT_TOKEN_TTL_SECS,
        name: "Spotify".to_owned(),
        metadata: serde_json::json!({"bot": "spotify", "channel_id": channel_id.to_string()}).to_string(),
        video: Some(VideoGrant {
            room: Some(room.to_owned()),
            room_join: true,
            can_publish: true,
            can_publish_sources: vec!["screen_share_audio".to_owned()],
            can_subscribe: false,
            can_publish_data: false,
            ..VideoGrant::default()
        }),
        ..Claims::default()
    };
    token::sign(cfg.media_api_secret.expose(), &claims)
}

fn bot_failed(error: BotError) -> ApiErr {
    match error {
        BotError::Busy => ApiErr::invalid("bot", "The Spotify bot is busy with other calls."),
        BotError::Rejected(_) | BotError::Down => ApiErr::invalid("bot", "The Spotify bot is not available."),
    }
}

fn nothing_playing() -> ApiErr {
    ApiErr::conflict(40033, "Nothing is playing in this channel.")
}

// ---- one media activity per channel, one session per server ----

/// Whether Spotify plays in `channel_id`.
pub(crate) fn playing_in(state: &AppState, channel_id: i64) -> bool {
    lock(&state.spotify.session).as_ref().is_some_and(|session| session.channel_id == channel_id)
}

/// 409 for a Stremio `PUT` in a channel where Spotify plays.
pub(crate) fn blocks_stremio() -> ApiErr {
    ApiErr::new(StatusCode::CONFLICT, 40034, "Another media activity is running in this channel. Stop Spotify first.")
}

/// 409 40035 for a `PUT` while the house account plays in another channel. The message names that channel and who started it
/// only if the caller can see the channel.
async fn busy_elsewhere(state: &AppState, user_id: i64, other: i64, started_by: i64) -> ApiErr {
    let generic = || ApiErr::new(StatusCode::CONFLICT, 40035, "Spotify is already playing in another call.");
    let Ok(Some(row)) = store::channel_row(state, other).await else { return generic() };
    let Some(guild_id) = row.guild_id.filter(|_| !row.is_dm()) else { return generic() };
    let visible = access::viewable_channels(state, user_id, &[other]).await.is_ok_and(|ids| ids.contains(&other));
    if !visible {
        return generic();
    }
    let guild = store::guild(state, guild_id).await.ok().flatten().map(|guild| guild.name);
    let starter = store::user(state, started_by).await.ok().flatten().map(|user| user.global_name.unwrap_or(user.username));
    match (row.name.as_deref(), guild, starter) {
        (Some(channel), Some(guild), Some(starter)) => {
            ApiErr::new(StatusCode::CONFLICT, 40035, &format!("Spotify is already playing in #{channel} on {guild} (started by {starter})"))
        }
        _ => generic(),
    }
}

// ---- reading ----

/// The channel's session, for a late joiner and `Call`.
pub fn state_of(state: &AppState, channel_id: i64) -> Option<SpotifyState> {
    lock(&state.spotify.session).as_ref().filter(|session| session.channel_id == channel_id).map(|session| session.view(false))
}

/// The session if it is in one of the given channels (READY / GUILD_CREATE): at most one entry.
pub fn states_in(state: &AppState, channel_ids: &HashSet<i64>) -> Vec<SpotifyUpdate> {
    lock(&state.spotify.session)
        .as_ref()
        .filter(|session| channel_ids.contains(&session.channel_id))
        .map(|session| SpotifyUpdate { channel_id: Snowflake::from(session.channel_id), state: Some(session.view(false)) })
        .into_iter()
        .collect()
}

/// SPOTIFY_UPDATE to everyone who can see the channel (`state: null` = the session ended).
async fn announce(state: &AppState, channel_id: i64, session: Option<SpotifyState>) {
    let Ok(Some(row)) = store::channel_row(state, channel_id).await else { return };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return };
    state.hub.send(&viewers, &GatewayEvent::SpotifyUpdate(SpotifyUpdate { channel_id: Snowflake::from(channel_id), state: session }));
}

async fn read(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<SpotifyState>> {
    active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    let view = lock(&state.spotify.session).as_ref().filter(|session| session.channel_id == channel_id).map(|session| session.view(true));
    view.map(Json).ok_or_else(nothing_playing)
}

// ---- finding the tracks behind a URI ----

/// The tracks a URI stands for, in play order: one for a track, an album's, the first `max` of a playlist's.
async fn tracks_of(active: &Active<'_>, kind: Kind, id: &str, max: usize) -> ApiResult<Vec<SpotifyTrack>> {
    let found = match kind {
        Kind::Track => vec![active.catalog.track(id).await.map_err(catalog_error)?],
        Kind::Album => active.catalog.album(id).await.map_err(catalog_error)?.tracks,
        Kind::Playlist => {
            let mut tracks = Vec::new();
            for page in 0..FILL_PAGES {
                let offset = page * PAGE_ITEMS;
                let page = crate::spotify::playlist_page(active, id, offset).await.map_err(catalog_error)?;
                tracks.extend(page.tracks);
                if tracks.len() >= max || page.total <= offset + PAGE_ITEMS {
                    break;
                }
            }
            tracks
        }
        Kind::Artist => return Err(ApiErr::invalid("uri", "Pick a track, an album or a playlist.")),
    };
    Ok(found.into_iter().take(max).collect())
}

fn uri_of(field: &str, text: &str) -> ApiResult<(Kind, String)> {
    parse_uri(text).ok_or_else(|| ApiErr::invalid(field, "Must be a Spotify URI like spotify:track:<22 characters>."))
}

// ---- routes ----

async fn start(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SpotifyStartRequest>,
) -> ApiResult<Response> {
    let active = active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    let (kind, item) = uri_of("uri", &body.uri)?;
    if kind == Kind::Artist {
        return Err(ApiErr::invalid("uri", "Pick a track, an album or a playlist."));
    }
    limit(&state, "spotify-play", user_id, 3.0, 3.0 / 60.0)?;
    if lock(&state.stremio.sessions).contains_key(&channel_id) {
        return Err(ApiErr::new(StatusCode::CONFLICT, 40034, "Another media activity is running in this channel. Stop the movie first."));
    }
    let elsewhere =
        lock(&state.spotify.session).as_ref().filter(|session| session.channel_id != channel_id).map(|session| (session.channel_id, session.started_by));
    if let Some((other, started_by)) = elsewhere {
        return Err(busy_elsewhere(&state, user_id, other, started_by).await);
    }
    let mut tracks = tracks_of(&active, kind, &item, SPOTIFY_QUEUE_MAX + 1).await?;
    if tracks.is_empty() {
        return Err(ApiErr::invalid("uri", "There is nothing to play in that."));
    }
    let first = tracks.remove(0);
    let now = unix_millis();
    let (reply, change, fresh, left_out) = {
        // Lock order is Stremio's sessions, then Spotify's slot (the same in Stremio's start): no movie can start between this check and the insert.
        let stremio = lock(&state.stremio.sessions);
        if stremio.contains_key(&channel_id) {
            return Err(ApiErr::new(StatusCode::CONFLICT, 40034, "Another media activity is running in this channel. Stop the movie first."));
        }
        let mut slot = lock(&state.spotify.session);
        if slot.as_ref().is_some_and(|session| session.channel_id != channel_id) {
            return Err(ApiErr::new(StatusCode::CONFLICT, 40035, "Spotify is already playing in another call."));
        }
        let fresh = slot.is_none();
        let session = slot.get_or_insert_with(|| {
            let room = new_room(channel_id);
            Session {
                channel_id,
                token: bot_token(&state, channel_id, &room).unwrap_or_default(),
                room,
                started_by: user_id,
                queue: Queue::default(),
                status: SpotifyStatus::Starting,
                error: None,
                notice: None,
                playing: true,
                position_ms: 0,
                updated_at_ms: now,
                seq: 0,
                track_seq: 0,
                steer_seq: 0,
                paused_since: None,
                idle_since: None,
                error_since: None,
                retried: false,
                dirty: false,
                last_put: Instant::now(),
                bot_down_since: None,
            }
        });
        if session.token.is_empty() {
            *slot = None;
            return Err(ApiErr::internal());
        }
        let left_out = session.queue.play_now(first, tracks, user_id);
        session.new_track(&state, now);
        if fresh {
            session.status = SpotifyStatus::Starting;
        }
        session.notice = None;
        (session.view(true), session.change(&state, now, false), fresh, left_out as u32)
    };
    let Some(desired) = change.desired else { return Err(ApiErr::internal()) };
    let seq = desired.seq;
    if let Err(error) = active.bot.put(&desired).await {
        if fresh {
            // Nothing was announced yet: the session never existed.
            let survives = {
                let mut slot = lock(&state.spotify.session);
                // Only this channel's session counts: it may have ended meanwhile and another channel started its own.
                match slot.as_mut().filter(|session| session.channel_id == channel_id) {
                    Some(session) if session.seq == seq => {
                        *slot = None;
                        false
                    }
                    Some(session) => {
                        // Someone controlled it meanwhile: it lives on and is sent again by the sweep.
                        session.dirty = true;
                        session.bot_down_since.get_or_insert_with(Instant::now);
                        true
                    }
                    None => false,
                }
            };
            if !survives {
                return Err(bot_failed(error));
            }
            let reply = Json(SpotifyReply { state: reply, left_out }).into_response();
            announce(&state, channel_id, Some(change.event)).await;
            return Ok(reply);
        }
        // A running session keeps its place; the sweep sends the track again until the bot answers or the grace runs out.
        touch(&state, channel_id, |session| {
            session.dirty = true;
            session.bot_down_since.get_or_insert_with(Instant::now);
        });
    } else {
        touch(&state, channel_id, |session| session.last_put = Instant::now());
    }
    announce(&state, channel_id, Some(change.event)).await;
    Ok(Json(SpotifyReply { state: reply, left_out }).into_response())
}

fn touch(state: &AppState, channel_id: i64, change: impl FnOnce(&mut Session)) {
    if let Some(session) = lock(&state.spotify.session).as_mut().filter(|session| session.channel_id == channel_id) {
        change(session);
    }
}

/// What a PATCH does, once it is known to be exactly one thing and well formed.
enum Op {
    Playing(bool),
    Position(u64),
    Skip,
    Previous,
    Loop(SpotifyLoop),
    Shuffle,
    Add { kind: Kind, id: String, next: bool },
    Remove(String),
    Move(String, usize),
    Clear,
}

fn one_op(body: SpotifyPatchRequest) -> ApiResult<Op> {
    let flag = |field: &str, value: Option<bool>| match value {
        Some(true) => Ok(true),
        Some(false) => Err(ApiErr::invalid(field, "Must be true.")),
        None => Ok(false),
    };
    let mut ops: Vec<Op> = Vec::new();
    if let Some(playing) = body.playing {
        ops.push(Op::Playing(playing));
    }
    if let Some(position) = body.position_ms {
        ops.push(Op::Position(position));
    }
    if flag("skip", body.skip)? {
        ops.push(Op::Skip);
    }
    if flag("previous", body.previous)? {
        ops.push(Op::Previous);
    }
    if let Some(mode) = body.loop_mode {
        ops.push(Op::Loop(mode));
    }
    if flag("shuffle", body.shuffle)? {
        ops.push(Op::Shuffle);
    }
    if let Some(add) = body.queue_add {
        let (kind, id) = uri_of("queue_add", &add.uri)?;
        if kind == Kind::Artist {
            return Err(ApiErr::invalid("queue_add", "Pick a track, an album or a playlist."));
        }
        ops.push(Op::Add { kind, id, next: add.next });
    }
    if let Some(qid) = body.queue_remove {
        ops.push(Op::Remove(qid));
    }
    if let Some(moved) = body.queue_move {
        ops.push(Op::Move(moved.qid, moved.to));
    }
    if flag("queue_clear", body.queue_clear)? {
        ops.push(Op::Clear);
    }
    match (ops.pop(), ops.is_empty()) {
        (Some(op), true) => Ok(op),
        _ => Err(ApiErr::invalid(
            "body",
            "Send exactly one of playing, position_ms, skip, previous, loop, shuffle, queue_add, queue_remove, queue_move, queue_clear.",
        )),
    }
}

async fn control(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SpotifyPatchRequest>,
) -> ApiResult<Response> {
    let active = active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    let op = one_op(body)?;
    limit(&state, "watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND)?;
    // The tracks of a queue_add are found before the session is locked.
    let added = match &op {
        Op::Add { kind, id, .. } => {
            if *kind != Kind::Track {
                limit(&state, "spotify-bulk", user_id, 5.0, 5.0 / 60.0)?;
            }
            Some(tracks_of(&active, *kind, id, SPOTIFY_QUEUE_MAX).await?)
        }
        _ => None,
    };
    let now = unix_millis();
    let (change, left_out) = {
        let mut slot = lock(&state.spotify.session);
        let session = slot.as_mut().filter(|session| session.channel_id == channel_id).ok_or_else(nothing_playing)?;
        let mut left_out = 0;
        let mut stop_bot = false;
        match op {
            Op::Playing(playing) => {
                if session.queue.current.is_some() {
                    session.steer(&state, Some(playing), None, now);
                }
            }
            Op::Position(position) => {
                let duration = session.queue.current.as_ref().map(|track| track.duration_ms).ok_or_else(nothing_playing)?;
                if position > duration {
                    return Err(ApiErr::invalid("position_ms", &format!("Must be between 0 and {duration} for this track.")));
                }
                session.steer(&state, None, Some(position), now);
            }
            Op::Skip => stop_bot = session.leave(&state, Leave::Skipped, now),
            Op::Previous => match session.queue.previous(session.here(now)) {
                Back::Played => session.new_track(&state, now),
                // A restart is a seek to the top that also resumes.
                Back::Restart if session.queue.current.is_some() => session.steer(&state, Some(true), Some(0), now),
                Back::Restart => {}
            },
            Op::Loop(mode) => {
                session.queue.loop_mode = mode;
                session.bump(&state);
            }
            Op::Shuffle => {
                session.queue.shuffle();
                session.bump(&state);
            }
            Op::Add { next, .. } => {
                left_out = session.queue.add(added.unwrap_or_default(), user_id, next);
                if session.queue.current.is_none() && session.queue.advance(Leave::Skipped).is_some() {
                    session.new_track(&state, now);
                } else {
                    session.bump(&state);
                }
            }
            Op::Remove(qid) => {
                if !session.queue.remove(&qid) {
                    return Err(ApiErr::invalid("queue_remove", "No such queue entry."));
                }
                session.bump(&state);
            }
            Op::Move(qid, to) => {
                if !session.queue.move_to(&qid, to) {
                    return Err(ApiErr::invalid("queue_move", "No such queue entry."));
                }
                session.bump(&state);
            }
            Op::Clear => {
                session.queue.entries.clear();
                session.bump(&state);
            }
        }
        (session.change(&state, now, stop_bot), left_out as u32)
    };
    let reply = Json(SpotifyReply { state: change.reply.clone(), left_out }).into_response();
    settle(&state, &active, channel_id, change).await;
    Ok(reply)
}

/// The bot already plays what the state says (it just reported so): tell the clients only.
fn announce_only(change: Change) -> Change {
    Change { desired: None, ..change }
}

/// Tells the bot (stop, or the desired state) and everyone watching what a change left.
async fn settle(state: &AppState, active: &Active<'_>, channel_id: i64, change: Change) {
    if change.stop_bot {
        let _ = active.bot.delete().await;
    }
    if let Some(desired) = &change.desired {
        match active.bot.put(desired).await {
            Ok(()) => touch(state, channel_id, |session| {
                session.last_put = Instant::now();
                session.dirty = false;
                session.bot_down_since = None;
            }),
            // The lease task sends it again every tick until the bot answers or the grace runs out.
            Err(_) => touch(state, channel_id, |session| {
                session.dirty = true;
                session.bot_down_since.get_or_insert_with(Instant::now);
            }),
        }
    }
    announce(state, channel_id, Some(change.event)).await;
}

async fn stop(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Response> {
    active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    limit(&state, "watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND)?;
    end(&state, channel_id).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// A subscribe-only token for the media room, for someone who is in the call (the same check as the controls) while a session runs.
async fn listener_token(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<SpotifyListenerToken>> {
    let active = active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    limit(&state, "watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND)?;
    let room = lock(&state.spotify.session).as_ref().filter(|session| session.channel_id == channel_id).map(|session| session.room.clone());
    let room = room.ok_or_else(nothing_playing)?;
    let token = super::stremio::media_viewer_token(&active.cfg.media_api_key, active.cfg.media_api_secret.expose(), &room, user_id, LISTENER_TOKEN_TTL_SECS)
        .ok_or_else(ApiErr::internal)?;
    Ok(Json(SpotifyListenerToken { url: active.cfg.media_url.clone(), token }))
}

// ---- lifecycle ----

/// Ends the channel's session, if any: the bot drops it and everyone who can see the channel hears.
pub(crate) async fn end(state: &AppState, channel_id: i64) {
    let session = {
        let mut slot = lock(&state.spotify.session);
        if slot.as_ref().is_some_and(|session| session.channel_id == channel_id) { slot.take() } else { None }
    };
    let Some(session) = session else { return };
    if let Some(bot) = &state.spotify.bot {
        let bot = bot.clone();
        let rooms = state.spotify.media_rooms();
        let room = session.room;
        tokio::spawn(async move {
            let _ = bot.delete().await;
            // Closing the room disconnects the listeners still in it; their tokens name a room that never comes back.
            let _ = rooms.delete_room(&room).await;
        });
    }
    announce(state, channel_id, None).await;
}

/// Removes everyone from the session's media room whose listener identity (`viewer:<user_id>:<hex>`) belongs to someone who is not
/// in the call. Run when a person leaves or loses access, and on every tick (a token can join again until it expires).
pub(crate) async fn remove_strangers(state: &AppState) {
    let Some((channel_id, room)) = lock(&state.spotify.session).as_ref().map(|session| (session.channel_id, session.room.clone())) else { return };
    let rooms = state.spotify.media_rooms();
    let Ok(inside) = rooms.list_participants(&room).await else { return };
    for participant in inside {
        let user_id = participant.identity.strip_prefix("viewer:").and_then(|rest| rest.split(':').next()).and_then(|id| id.parse::<i64>().ok());
        if user_id.is_some_and(|user_id| !super::state::in_channel(state, user_id, channel_id)) {
            let _ = rooms.remove_participant(&room, &participant.identity).await;
        }
    }
}

/// A person left the call (or was removed from it): their listener connections go.
pub(crate) fn user_left(state: &AppState, channel_id: i64) {
    if playing_in(state, channel_id) {
        let state = state.clone();
        tokio::spawn(async move { remove_strangers(&state).await });
    }
}

// ---- the bot's events ----

#[derive(Debug, Deserialize)]
pub struct BotEvent {
    channel_id: String,
    event: String,
    #[serde(default)]
    track: Option<String>,
    #[serde(default)]
    position_ms: u64,
    #[serde(default)]
    seq: u64,
    /// One of `unavailable`, `auth`, `io`; anything else counts as `io`. Never shown.
    #[serde(default)]
    reason: Option<String>,
}

/// `POST /internal/spotify/bot` (never behind Caddy): the bot reports `started`, `position` (every 5 s), `ended` and `error`.
pub async fn bot_event(State(state): State<AppState>, headers: HeaderMap, Json(event): Json<BotEvent>) -> StatusCode {
    let Ok(active) = active(&state) else { return StatusCode::NOT_FOUND };
    let given = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).unwrap_or("");
    if !secrets_match(given.as_bytes(), active.cfg.bot_secret.expose().as_bytes()) {
        return StatusCode::UNAUTHORIZED;
    }
    // An event for a session that is gone is not an error (the bot retries everything but `position` on a failure).
    let Some(channel_id) = event.channel_id.parse::<i64>().ok() else { return StatusCode::NO_CONTENT };
    let now = unix_millis();
    let change = {
        let mut slot = lock(&state.spotify.session);
        let Some(session) = slot.as_mut().filter(|session| session.channel_id == channel_id) else { return StatusCode::NO_CONTENT };
        let current = session.queue.current.as_ref().map(|track| track.uri.as_str());
        // Events about a track that is not the current one, or older than the change that loaded it, describe the past.
        if session.status == SpotifyStatus::Error || current.is_none() || current != event.track.as_deref() {
            return StatusCode::NO_CONTENT;
        }
        let waiting = matches!(session.status, SpotifyStatus::Starting | SpotifyStatus::Loading);
        match event.event.as_str() {
            "started" if waiting => {
                session.status = SpotifyStatus::Playing;
                session.position_ms = event.position_ms;
                session.updated_at_ms = now;
                session.bot_down_since = None;
                session.sync_status();
                Some(announce_only(session.change(&state, now, false)))
            }
            // Positions are not announced: clients extrapolate. They only correct the server's idea of where the bot is.
            "position" if event.seq >= session.steer_seq => {
                session.position_ms = event.position_ms;
                session.updated_at_ms = now;
                session.bot_down_since = None;
                if waiting {
                    session.status = SpotifyStatus::Playing;
                    session.sync_status();
                    Some(announce_only(session.change(&state, now, false)))
                } else {
                    None
                }
            }
            "ended" if event.seq >= session.track_seq => {
                let stop_bot = session.leave(&state, Leave::Ended, now);
                Some(session.change(&state, now, stop_bot))
            }
            "error" if event.seq >= session.track_seq => match event.reason.as_deref() {
                Some("unavailable") => {
                    let stop_bot = session.leave(&state, Leave::Unavailable, now);
                    session.note(SKIPPED);
                    Some(session.change(&state, now, stop_bot))
                }
                Some("auth") => {
                    session.fail(&state, NEEDS_LOGIN, now);
                    Some(session.change(&state, now, true))
                }
                _ if !session.retried => {
                    // Once more from where it stopped.
                    session.retried = true;
                    session.position_ms = event.position_ms;
                    session.updated_at_ms = now;
                    session.bump(&state);
                    session.steer_seq = session.seq;
                    Some(session.change(&state, now, false))
                }
                _ => {
                    session.fail(&state, LOST_CONNECTION, now);
                    Some(session.change(&state, now, true))
                }
            },
            _ => None,
        }
    };
    if let Some(change) = change {
        settle(&state, &active, channel_id, change).await;
    }
    StatusCode::NO_CONTENT
}

// ---- background work ----

/// At startup the bot is told to drop whatever it still plays (the session is in memory only), then every `tick` the session is
/// checked: a pause, an idle spell or an error that lasted too long ends it, the notice expires, and the bot gets the desired
/// state again as a lease (or as soon as a `PUT` failed), because it drops a session not renewed for 150 s.
pub fn spawn_tasks(state: AppState) {
    let Some(bot) = state.spotify.bot.clone() else { return };
    tokio::spawn(async move {
        for _ in 0..5 {
            if bot.delete().await.is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
    tokio::spawn(async move {
        let Some(tick) = state.config.spotify.as_ref().map(|cfg| cfg.tick) else { return };
        let mut ticker = tokio::time::interval(tick);
        loop {
            ticker.tick().await;
            sweep(&state).await;
        }
    });
}

async fn sweep(state: &AppState) {
    let (Some(cfg), Some(bot)) = (&state.config.spotify, &state.spotify.bot) else { return };
    let now = unix_millis();
    let mut stop = None;
    let mut resend = None;
    let mut expired = None;
    {
        let mut slot = lock(&state.spotify.session);
        let Some(session) = slot.as_mut() else { return };
        let paused_too_long = session.paused_since.is_some_and(|since| since.elapsed() >= cfg.pause_timeout);
        let idle_too_long = session.idle_since.is_some_and(|since| since.elapsed() >= cfg.empty_timeout);
        let errored_too_long = session.error_since.is_some_and(|since| since.elapsed() >= cfg.error_hold);
        // The bot has been unreachable (or refusing) for as long as an error stays on the tile.
        let bot_gone = session.bot_down_since.is_some_and(|since| since.elapsed() >= cfg.error_hold);
        if paused_too_long || idle_too_long || errored_too_long || bot_gone {
            stop = Some(session.channel_id);
        } else {
            if session.notice.is_some_and(|(_, since)| since.elapsed() >= cfg.notice_ttl) {
                session.notice = None;
                expired = Some((session.channel_id, session.view(false)));
            }
            if (session.dirty || session.last_put.elapsed() >= cfg.lease_interval)
                && let Some(desired) = session.desired(state, now)
            {
                resend = Some((session.channel_id, desired));
            }
        }
    }
    if let Some(channel_id) = stop {
        end(state, channel_id).await;
        return;
    }
    if let Some((channel_id, view)) = expired {
        announce(state, channel_id, Some(view)).await;
    }
    // A listener token outlives the person's place in the call (6 h), so who is in the media room is checked against who is in voice.
    remove_strangers(state).await;
    if let Some((channel_id, desired)) = resend {
        let sent = bot.put(&desired).await.is_ok();
        touch(state, channel_id, |session| {
            if sent {
                session.last_put = Instant::now();
                session.dirty = false;
                session.bot_down_since = None;
            } else {
                session.dirty = true;
                session.bot_down_since.get_or_insert_with(Instant::now);
            }
        });
    }
}
