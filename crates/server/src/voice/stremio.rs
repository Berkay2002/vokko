//! Stremio sessions (docs/design/stremio-bot.md sections 3.3, 4.4 and 8): one in-memory session per voice channel or DM call, shaped
//! like Watch Together. The server owns the state and every secret and tells the native bot what to do with
//! `PUT /sessions/{channel}` (re-sent as a lease); the bot reports back at `POST /internal/stremio/bot`.
//! `PUT|PATCH|DELETE /channels/{id}/stremio`, `POST /channels/{id}/stremio/viewer-token` and STREMIO_UPDATE.
use std::collections::{BTreeMap, HashSet};
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use vokko_protocol::api::{
    GatewayEvent, MediaControl, STREMIO_POSITION_MAX_MS, STREMIO_QUEUE_MAX, STREMIO_QUEUE_PER_USER, STREMIO_TRACKS_MAX, Snowflake, StremioAddonSubtitle,
    StremioAddonSubtitles, StremioAudioTrack, StremioCues, StremioItem, StremioPatchRequest, StremioQueueItem, StremioStartRequest, StremioState,
    StremioStatus, StremioSubtitleKind, StremioSubtitleTrack, StremioUpdate, StremioViewerToken,
};
use vokko_protocol::cues;

use super::token::{self, Claims, VideoGrant};
use super::watch::{CONTROL_BURST, CONTROL_PER_SECOND, require_in_voice};
use super::{control, unix_millis, unix_now};
use crate::access;
use crate::auth::{AuthUser, random_hex};
use crate::crypto::Secret;
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::state::AppState;
use crate::store;
use crate::stremio::addons::{self, language_code};
use crate::stremio::bot::{BotError, Desired, secrets_match};
use crate::stremio::library::{self, Finished};
use crate::stremio::rank::{Candidate, Source};
use crate::stremio::{Active, Listed, TitleInfo, active, limit, lock, user_addons};

/// Bot token and viewer token lifetimes.
const BOT_TOKEN_TTL_SECS: i64 = 12 * 60 * 60;
const VIEWER_TOKEN_TTL_SECS: i64 = 6 * 60 * 60;
/// Shown on the tile when playback failed. Never the bot's own message: ffmpeg errors can carry the media URL.
const PLAYBACK_FAILED: &str = "Playback failed.";
/// Subtitle files listed per request, the size of one file and the cues kept of it.
const MAX_ADDON_SUBTITLES: usize = 200;
const MAX_SUBTITLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CUES: usize = 5000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/stremio", put(start).patch(control).delete(stop))
        .route("/channels/{id}/stremio/viewer-token", post(viewer_token))
        .route("/channels/{id}/stremio/subtitles", get(addon_subtitles))
        .route("/channels/{id}/stremio/subtitles/{sid}", get(addon_cues))
}

/// A stream waiting in the Up next queue. It was resolved from the account of `added_by` when they listed it.
#[derive(Clone)]
struct Queued {
    candidate: Candidate,
    info: TitleInfo,
    added_by: i64,
}

pub struct Session {
    /// The media LiveKit room of this session: `stremio-<channel_id>-<random>`, new for every session, so a token from an earlier
    /// session (or one that outlived its holder's place in the call) is no use against the next one in the same channel.
    room: String,
    item: StremioItem,
    status: StremioStatus,
    error: Option<String>,
    playing: bool,
    position_ms: u64,
    updated_at_ms: i64,
    duration_ms: Option<u64>,
    started_by: i64,
    /// Host, who added the current item, and the skip vote.
    control: MediaControl,
    queue: Vec<Queued>,
    /// The stream being played: the candidate (for a re-resolve) and what the bot was given.
    candidate: Candidate,
    media: Secret,
    headers: BTreeMap<String, String>,
    token: String,
    /// Changes with every new item; events and slow resolves that belong to an older one are dropped.
    generation: u64,
    /// `(type, video id)` of the playing item, for asking addons about subtitles.
    video: Option<(String, String)>,
    /// What the bot found in the file (empty until it reports, and for every new item).
    audio_tracks: Vec<StremioAudioTrack>,
    subtitle_tracks: Vec<StremioSubtitleTrack>,
    audio: Option<u32>,
    burned: Option<u32>,
    /// The last item start, seek, pause or resume: bot events this soon afterwards describe the previous situation.
    changed: Instant,
    paused_since: Option<Instant>,
    error_since: Option<Instant>,
    /// The item was re-resolved once after an error.
    retried: bool,
    /// The bot has to be sent the desired state again (a `PUT` failed).
    dirty: bool,
    last_put: Instant,
    bot_down_since: Option<Instant>,
    /// Who started the current item and where it began, for the write-back to their Stremio library (`stremio::library`).
    tracked: Option<Tracked>,
}

/// The item being played as the library write-back needs it.
struct Tracked {
    /// The user who started this item (the PUT caller, or whoever queued it), not the session's `started_by`.
    owner: i64,
    info: TitleInfo,
    began_ms: u64,
    /// Someone else moved the playhead: where it ends up is not what the owner watched, so nothing is saved for this item.
    foreign_seek: bool,
    /// When the item started (unix ms): a library entry changed, or an account linked, after this is not what the item began with.
    started_ms: i64,
    /// Where the video was when its owner left the call; what was watched after that is not theirs to save.
    owner_left_at: Option<u64>,
}

/// The bot reports every 5 s; a silent bot is not assumed to have kept playing for longer than two reports when the item is saved.
const MAX_DRIFT_MS: u64 = 10_000;

/// `position_ms` moved on by the time since `updated_at_ms` (at most `max_drift`), while `playing`.
fn extrapolate(position_ms: u64, updated_at_ms: i64, playing: bool, now_ms: i64, max_drift: u64) -> u64 {
    let moved = if playing { ((now_ms - updated_at_ms).max(0) as u64).min(max_drift) } else { 0 };
    position_ms + moved
}

impl Session {
    fn view(&self, channel_id: i64) -> StremioState {
        StremioState {
            item: self.item.clone(),
            status: self.status,
            error: self.error.clone(),
            playing: self.playing,
            position_ms: self.position_ms,
            updated_at_ms: self.updated_at_ms,
            duration_ms: self.duration_ms,
            started_by: Snowflake::from(self.started_by),
            bot_identity: bot_identity(channel_id),
            control: self.control.clone(),
            audio_tracks: self.audio_tracks.clone(),
            audio: self.audio,
            subtitle_tracks: self.subtitle_tracks.clone(),
            burned_subtitle: self.burned,
            queue: self
                .queue
                .iter()
                .map(|queued| StremioQueueItem {
                    title: queued.info.title.clone(),
                    subtitle: queued.info.subtitle.clone(),
                    poster: queued.info.poster.clone(),
                    label: queued.candidate.label.clone(),
                    added_by: Snowflake::from(queued.added_by),
                })
                .collect(),
        }
    }

    /// Notes who started the current item (call right after `begin`) and, for a resume, where it starts.
    fn track(&mut self, info: &TitleInfo, owner: i64, began_ms: u64) {
        self.tracked = Some(Tracked { owner, info: info.clone(), began_ms, foreign_seek: false, started_ms: unix_millis(), owner_left_at: None });
        control::new_item(&mut self.control, Some(owner));
        self.position_ms = began_ms;
    }

    /// The current item as it stands now (or, with `ended`, where the bot said it ended), for the starter's library; each item is
    /// taken once. `None` when the bot never reported a duration (it never played).
    fn take_finished(&mut self, ended: Option<u64>, now_ms: i64) -> Option<Finished> {
        let duration_ms = self.duration_ms?;
        let tracked = self.tracked.take().filter(|tracked| !tracked.foreign_seek)?;
        let position_ms = match ended {
            Some(reported) => library::ended_position(reported, duration_ms),
            None => self.drifted(now_ms, MAX_DRIFT_MS),
        };
        let (kind, video_id) = tracked.info.video?;
        Some(Finished {
            owner: tracked.owner,
            kind,
            video_id,
            name: tracked.info.title,
            poster: tracked.info.poster,
            position_ms: tracked.owner_left_at.map_or(position_ms, |left| position_ms.min(left)),
            duration_ms,
            began_ms: tracked.began_ms,
            started_ms: tracked.started_ms,
        })
    }

    /// Where the video is right now.
    fn here(&self, now_ms: i64) -> u64 {
        self.drifted(now_ms, u64::MAX)
    }

    /// `here`, but with at most `max_drift` of playing counted since the last time the position was set (a report or a steer).
    fn drifted(&self, now_ms: i64, max_drift: u64) -> u64 {
        let position = extrapolate(self.position_ms, self.updated_at_ms, self.playing, now_ms, max_drift);
        self.duration_ms.map_or(position, |duration| position.min(duration))
    }

    fn sync_status(&mut self) {
        if self.status != StremioStatus::Error {
            self.status = if !self.playing {
                StremioStatus::Paused
            } else if self.status == StremioStatus::Starting {
                StremioStatus::Starting
            } else {
                StremioStatus::Playing
            };
        }
    }

    /// Starts `candidate` as the session's item (a new session, a replaced item or the next one in the queue).
    fn begin(&mut self, info: &TitleInfo, candidate: Candidate, media: Secret, headers: BTreeMap<String, String>, generation: u64, token: String) {
        self.item = StremioItem { title: info.title.clone(), subtitle: info.subtitle.clone(), poster: info.poster.clone(), label: candidate.label.clone() };
        self.candidate = candidate;
        self.media = media;
        self.headers = headers;
        self.status = StremioStatus::Starting;
        self.error = None;
        self.playing = true;
        self.position_ms = 0;
        self.updated_at_ms = unix_millis();
        self.duration_ms = None;
        self.generation = generation;
        self.video = info.video.clone();
        self.audio_tracks.clear();
        self.subtitle_tracks.clear();
        self.audio = None;
        self.burned = None;
        self.token = token;
        self.changed = Instant::now();
        self.paused_since = None;
        self.error_since = None;
        self.retried = false;
        self.dirty = false;
        self.bot_down_since = None;
    }

    /// The new position, playing flag and `changed`/`paused_since` bookkeeping of a play, pause or seek.
    fn steer(&mut self, playing: Option<bool>, position_ms: Option<u64>, now_ms: i64) {
        self.position_ms = position_ms.unwrap_or_else(|| self.here(now_ms));
        self.playing = playing.unwrap_or(self.playing);
        self.updated_at_ms = now_ms;
        self.changed = Instant::now();
        self.paused_since = if self.playing { None } else { self.paused_since.or(Some(Instant::now())) };
        self.sync_status();
    }

    fn desired(&self, state: &AppState, now_ms: i64) -> Option<Desired> {
        let cfg = state.config.stremio.as_ref()?;
        Some(Desired {
            livekit_url: cfg.bot_media_url.clone(),
            token: self.token.clone(),
            media_url: self.media.expose().to_owned(),
            headers: self.headers.clone(),
            position_ms: self.here(now_ms),
            playing: self.playing,
            max_height: cfg.max_height,
            bitrate: cfg.bitrate_kbps,
            generation: self.generation,
            audio: self.audio,
            burned_subtitle: self.burned,
            tracks_known: !self.audio_tracks.is_empty() || !self.subtitle_tracks.is_empty(),
        })
    }
}

pub fn bot_identity(channel_id: i64) -> String {
    format!("bot:stremio:{channel_id}")
}

/// A fresh media LiveKit room name for a new session.
fn new_room(channel_id: i64) -> String {
    format!("stremio-{channel_id}-{}", random_hex(8))
}

/// The bot's token: it publishes the two screen-share sources into the session's room and the text subtitle cues as data (no
/// subscribing). Viewers cannot publish data.
fn bot_token(state: &AppState, channel_id: i64, room: &str) -> Option<String> {
    let cfg = state.config.stremio.as_ref()?;
    let now = unix_now();
    let claims = Claims {
        iss: cfg.media_api_key.clone(),
        sub: bot_identity(channel_id),
        nbf: now - 10,
        exp: now + BOT_TOKEN_TTL_SECS,
        name: "Stremio".to_owned(),
        metadata: serde_json::json!({"bot": "stremio", "channel_id": channel_id.to_string()}).to_string(),
        video: Some(VideoGrant {
            room: Some(room.to_owned()),
            room_join: true,
            can_publish: true,
            can_publish_sources: vec!["screen_share".to_owned(), "screen_share_audio".to_owned()],
            can_subscribe: false,
            can_publish_data: true,
            ..VideoGrant::default()
        }),
        ..Claims::default()
    };
    token::sign(cfg.media_api_secret.expose(), &claims)
}

fn bot_failed(error: BotError) -> ApiErr {
    match error {
        BotError::Busy => ApiErr::invalid("bot", "The Stremio bot is busy with other calls."),
        BotError::Rejected(_) | BotError::Down => ApiErr::invalid("bot", "The Stremio bot is not available."),
    }
}

/// The stream behind `sid`, if this user listed it and it can be played.
fn playable(state: &AppState, field: &str, sid: &str, user_id: i64) -> ApiResult<Listed> {
    let listed = state.stremio.listed(sid, user_id).ok_or_else(|| ApiErr::invalid(field, "Unknown or expired stream. List the streams again."))?;
    if !listed.candidate.playable() {
        return Err(ApiErr::invalid(field, "That stream cannot be played here."));
    }
    Ok(listed)
}

/// Follows the stream's resolver URL to the file (the guard on every hop) and returns what the bot is given.
async fn prepare(active: &Active<'_>, candidate: &Candidate) -> ApiResult<(Secret, BTreeMap<String, String>)> {
    let Source::Url { url, headers } = &candidate.source else { return Err(ApiErr::invalid("sid", "That stream cannot be played here.")) };
    let pairs: Vec<(&str, &str)> = headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
    match active.clients.fetcher.resolve_media(url, &pairs).await {
        Ok(media) => Ok((media, headers.clone())),
        Err(error) => {
            tracing::info!("stremio: could not open a stream of {}: {error:?}", candidate.addon);
            Err(ApiErr::invalid("sid", "That stream could not be opened. Try another one."))
        }
    }
}

// ---- reading ----

/// The channel's session, for a late joiner and `Call`.
pub fn state_of(state: &AppState, channel_id: i64) -> Option<StremioState> {
    lock(&state.stremio.sessions).get(&channel_id).map(|session| session.view(channel_id))
}

/// Sessions of the given channels (READY / GUILD_CREATE), by channel id.
pub fn states_in(state: &AppState, channel_ids: &HashSet<i64>) -> Vec<StremioUpdate> {
    let mut updates: Vec<StremioUpdate> = lock(&state.stremio.sessions)
        .iter()
        .filter(|(id, _)| channel_ids.contains(id))
        .map(|(id, session)| StremioUpdate { channel_id: Snowflake::from(*id), state: Some(session.view(*id)) })
        .collect();
    updates.sort_by_key(|update| update.channel_id.db());
    updates
}

/// STREMIO_UPDATE to everyone who can see the channel (`state: null` = the session ended).
async fn announce(state: &AppState, channel_id: i64, session: Option<StremioState>) {
    let Ok(Some(row)) = store::channel_row(state, channel_id).await else { return };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return };
    state.hub.send(&viewers, &GatewayEvent::StremioUpdate(StremioUpdate { channel_id: Snowflake::from(channel_id), state: session }));
}

// ---- routes ----

async fn start(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<StremioStartRequest>,
) -> ApiResult<Response> {
    let active = active(&state)?;
    let ctx = control::in_voice(&state, user_id, &id).await?;
    let channel_id = ctx.channel_id;
    if crate::voice::spotify::playing_in(&state, channel_id) {
        return Err(crate::voice::spotify::blocks_stremio());
    }
    // Anyone starts a session; replacing a running item is a controller's (checked again under the lock below).
    if let Some(session) = lock(&state.stremio.sessions).get(&channel_id) {
        control::require_control(&ctx, &session.control)?;
    }
    let room = control::room(&state, channel_id);
    if body.position_ms.is_some_and(|position| position > STREMIO_POSITION_MAX_MS) {
        return Err(ApiErr::invalid("position_ms", "Must be between 0 and 86400000."));
    }
    limit(&state, "stremio-play", user_id, 3.0, 3.0 / 60.0)?;
    let listed = playable(&state, "sid", &body.sid, user_id)?;
    let (media, headers) = prepare(&active, &listed.candidate).await?;
    let generation = state.stremio.next_generation();
    let (view, desired, had_one, replaced) = {
        let mut sessions = lock(&state.stremio.sessions);
        // Lock order is Stremio's sessions, then Spotify's slot (the same in Spotify's start): the check and the insert below are one step.
        if crate::voice::spotify::playing_in(&state, channel_id) {
            return Err(crate::voice::spotify::blocks_stremio());
        }
        let had_one = sessions.contains_key(&channel_id);
        if let Some(session) = sessions.get(&channel_id) {
            control::require_control(&ctx, &session.control)?;
        }
        // Changing the item keeps the queue, the host and who started the session.
        let session = sessions.entry(channel_id).or_insert_with(|| Session {
            room: new_room(channel_id),
            item: StremioItem { title: String::new(), subtitle: None, poster: None, label: String::new() },
            status: StremioStatus::Starting,
            error: None,
            playing: true,
            position_ms: 0,
            updated_at_ms: unix_millis(),
            duration_ms: None,
            started_by: user_id,
            control: control::new_session(user_id, &room),
            queue: Vec::new(),
            candidate: listed.candidate.clone(),
            media: media.clone(),
            headers: BTreeMap::new(),
            token: String::new(),
            generation,
            video: None,
            audio_tracks: Vec::new(),
            subtitle_tracks: Vec::new(),
            audio: None,
            burned: None,
            changed: Instant::now(),
            paused_since: None,
            error_since: None,
            retried: false,
            dirty: false,
            last_put: Instant::now(),
            bot_down_since: None,
            tracked: None,
        });
        let token = bot_token(&state, channel_id, &session.room).ok_or_else(ApiErr::internal)?;
        let replaced = session.take_finished(None, unix_millis());
        session.begin(&listed.info, listed.candidate.clone(), media, headers, generation, token);
        session.track(&listed.info, user_id, body.position_ms.unwrap_or(0));
        let desired = session.desired(&state, unix_millis()).ok_or_else(ApiErr::internal)?;
        (session.view(channel_id), desired, had_one, replaced)
    };
    if let Some(replaced) = replaced {
        library::save(&state, replaced);
    }
    if let Err(error) = active.clients.bot.put(channel_id, &desired).await {
        let removed = {
            let mut sessions = lock(&state.stremio.sessions);
            let ours = sessions.get(&channel_id).is_some_and(|session| session.generation == generation);
            if ours {
                sessions.remove(&channel_id);
            }
            ours
        };
        if removed && had_one {
            announce(&state, channel_id, None).await;
        }
        return Err(bot_failed(error));
    }
    if let Some(session) = lock(&state.stremio.sessions).get_mut(&channel_id).filter(|session| session.generation == generation) {
        session.last_put = Instant::now();
    }
    announce(&state, channel_id, Some(view.clone())).await;
    Ok(Json(view).into_response())
}

async fn control(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<StremioPatchRequest>,
) -> ApiResult<Response> {
    let active = active(&state)?;
    let ctx = control::in_voice(&state, user_id, &id).await?;
    let channel_id = ctx.channel_id;
    if body.position_ms.is_some_and(|position| position > STREMIO_POSITION_MAX_MS) {
        return Err(ApiErr::invalid("position_ms", "Must be between 0 and 86400000."));
    }
    let room = control::room(&state, channel_id);
    let queued = match &body.queue_add {
        Some(sid) => {
            let listed = playable(&state, "queue_add", sid, user_id)?;
            Some(Queued { candidate: listed.candidate, info: listed.info, added_by: user_id })
        }
        None => None,
    };
    limit(&state, "watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND)?;
    let skip = body.skip == Some(true);
    let steer = !skip && (body.playing.is_some() || body.position_ms.is_some());
    let picks = !skip && (body.audio.is_some() || body.burned_subtitle.is_some());
    let now = unix_millis();
    let (before, after, desired, skip_now) = {
        let mut sessions = lock(&state.stremio.sessions);
        let session = sessions.get_mut(&channel_id).ok_or_else(|| ApiErr::conflict(40033, "Nothing is playing in this channel."))?;
        let before = session.view(channel_id);
        let controller = control::controls(&ctx, session.control.host_id);
        // Steering and the tracks are for everyone, so controllers only; anyone removes their own queue entry.
        if (steer || picks) && !controller {
            return Err(ApiErr::missing_permissions());
        }
        if body.queue_remove.and_then(|index| session.queue.get(index)).is_some_and(|queued| queued.added_by != user_id && !controller) {
            return Err(ApiErr::missing_permissions());
        }
        if queued.is_some() {
            control::quota(&ctx, &session.control, session.queue.iter().filter(|queued| queued.added_by == user_id).count(), STREMIO_QUEUE_PER_USER)?;
        }
        if let Some(position) = body.position_ms.filter(|position| steer && session.duration_ms.is_some_and(|duration| *position > duration)) {
            return Err(ApiErr::invalid("position_ms", &format!("Must be between 0 and {} for this video.", session.duration_ms.unwrap_or(position))));
        }
        if body.audio.is_some_and(|audio| !session.audio_tracks.iter().any(|track| track.id == audio)) {
            return Err(ApiErr::invalid("audio", "No such audio track."));
        }
        if body
            .burned_subtitle
            .flatten()
            .is_some_and(|id| !session.subtitle_tracks.iter().any(|track| track.id == id && track.kind == StremioSubtitleKind::Bitmap))
        {
            return Err(ApiErr::invalid("burned_subtitle", "Only a picture-based subtitle track can be burned in."));
        }
        if body.queue_remove.is_some_and(|index| index >= session.queue.len()) {
            return Err(ApiErr::invalid("queue_remove", "No such queue entry."));
        }
        if queued.is_some() && session.queue.len() >= STREMIO_QUEUE_MAX {
            return Err(ApiErr::invalid("queue_add", &format!("The queue holds at most {STREMIO_QUEUE_MAX} videos.")));
        }
        if let Some(index) = body.queue_remove {
            session.queue.remove(index);
        }
        if let Some(queued) = queued {
            session.queue.push(queued);
        }
        // A new track restarts the bot's ffmpeg at the current position, like a seek.
        let retrack =
            picks && (body.audio.is_some_and(|audio| session.audio != Some(audio)) || body.burned_subtitle.is_some_and(|burned| session.burned != burned));
        if let Some(audio) = body.audio {
            session.audio = Some(audio);
        }
        if let Some(burned) = body.burned_subtitle {
            session.burned = burned;
        }
        let steer = steer || retrack;
        if steer {
            if body.position_ms.is_some()
                && let Some(tracked) = session.tracked.as_mut().filter(|tracked| tracked.owner != user_id)
            {
                tracked.foreign_seek = true;
            }
            session.steer(body.playing, body.position_ms, now);
        }
        // shortcut: a vote that races an item change counts for the new item; add an expected-item key like Watch's video_id if that bites.
        let skip_now = body.skip.is_some_and(|skip| control::skip_request(&mut session.control, &ctx, skip, &room));
        (before, session.view(channel_id), steer.then(|| session.desired(&state, now)).flatten(), skip_now)
    };
    if let Some(desired) = desired {
        if active.clients.bot.put(channel_id, &desired).await.is_ok() {
            touch(&state, channel_id, |session| {
                session.last_put = Instant::now();
                session.bot_down_since = None;
            });
        } else {
            // The lease task sends it again every second until the bot answers or the grace runs out.
            touch(&state, channel_id, |session| session.dirty = true);
        }
    }
    if skip_now {
        advance(&state, &active, channel_id, None).await;
        return Ok(Json(state_of(&state, channel_id)).into_response());
    }
    if after != before {
        announce(&state, channel_id, Some(after.clone())).await;
    }
    Ok(Json(after).into_response())
}

async fn stop(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Response> {
    active(&state)?;
    let ctx = control::in_voice(&state, user_id, &id).await?;
    let channel_id = ctx.channel_id;
    if let Some(session) = lock(&state.stremio.sessions).get(&channel_id) {
        control::require_control(&ctx, &session.control)?;
    }
    limit(&state, "watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND)?;
    end(&state, channel_id).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// A subscribe-only token for the media room, for someone who is in the call (the same check as the controls) while a session runs.
async fn viewer_token(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<StremioViewerToken>> {
    let active = active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    limit(&state, "watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND)?;
    let Some(room) = lock(&state.stremio.sessions).get(&channel_id).map(|session| session.room.clone()) else {
        return Err(ApiErr::conflict(40033, "Nothing is playing in this channel."));
    };
    let token = media_viewer_token(&active.cfg.media_api_key, active.cfg.media_api_secret.expose(), &room, user_id, VIEWER_TOKEN_TTL_SECS)
        .ok_or_else(ApiErr::internal)?;
    Ok(Json(StremioViewerToken { url: active.cfg.media_url.clone(), token }))
}

/// A subscribe-only token for a media room (shared with Spotify). A fresh identity per token: two devices of one account must not
/// kick each other out of the room.
pub(crate) fn media_viewer_token(api_key: &str, api_secret: &str, room: &str, user_id: i64, ttl_secs: i64) -> Option<String> {
    let now = unix_now();
    let claims = Claims {
        iss: api_key.to_owned(),
        sub: format!("viewer:{user_id}:{}", random_hex(4)),
        nbf: now - 10,
        exp: now + ttl_secs,
        name: "Viewer".to_owned(),
        video: Some(VideoGrant {
            room: Some(room.to_owned()),
            room_join: true,
            can_subscribe: true,
            can_publish: false,
            can_publish_data: false,
            ..VideoGrant::default()
        }),
        ..Claims::default()
    };
    token::sign(api_secret, &claims)
}

/// Subtitle files the requester's own addons offer for the playing title. Only labels reach the client; the URLs stay here.
async fn addon_subtitles(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<StremioAddonSubtitles>> {
    let active = active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    limit(&state, "stremio-subtitles", user_id, 5.0, 1.0 / 3.0)?;
    let (generation, video) = playing(&state, channel_id)?;
    let Some((kind, video_id)) = video else { return Ok(Json(StremioAddonSubtitles { subtitles: Vec::new(), addon_errors: Vec::new() })) };
    let addons = user_addons(&state, &active, user_id).await?;
    let (found, addon_errors) = addons::fetch_subtitles(&active.clients.fetcher, &addons, &kind, &video_id).await;
    let found: Vec<_> = found.into_iter().take(MAX_ADDON_SUBTITLES).collect();
    let sids = state.stremio.remember_subs(user_id, channel_id, generation, found.iter().map(|sub| sub.url.clone()).collect());
    let mut per_addon: BTreeMap<String, usize> = BTreeMap::new();
    let subtitles = found
        .into_iter()
        .zip(sids)
        .map(|(sub, sid)| {
            let n = per_addon.entry(sub.addon.clone()).and_modify(|n| *n += 1).or_insert(1);
            StremioAddonSubtitle { sid, label: format!("{} {n}", sub.addon), addon: sub.addon, language: sub.language }
        })
        .collect();
    Ok(Json(StremioAddonSubtitles { subtitles, addon_errors }))
}

/// The cues of one listed subtitle file: fetched with the same host rules as a stream, at most 2 MiB, SRT or WebVTT only.
async fn addon_cues(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, sid)): Path<(String, String)>) -> ApiResult<Json<StremioCues>> {
    let active = active(&state)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    limit(&state, "stremio-subtitle-file", user_id, 10.0, 0.5)?;
    let (generation, _) = playing(&state, channel_id)?;
    let listed = state
        .stremio
        .listed_sub(&sid, user_id, channel_id, generation)
        .ok_or_else(|| ApiErr::invalid("sid", "Unknown or expired subtitle. List the subtitles again."))?;
    let text = active
        .clients
        .fetcher
        .get_text(listed.url.expose(), MAX_SUBTITLE_BYTES)
        .await
        .map_err(|_| ApiErr::invalid("sid", "That subtitle could not be opened."))?;
    // Not cached on the server: the client keeps what it fetched, and up to 1.5 MB of cues per listed file would add up.
    Ok(Json(StremioCues { cues: cues::parse(&text, MAX_CUES) }))
}

/// The channel's current item (`generation`) and what it is, or "Nothing is playing".
fn playing(state: &AppState, channel_id: i64) -> ApiResult<(u64, Option<(String, String)>)> {
    lock(&state.stremio.sessions)
        .get(&channel_id)
        .map(|session| (session.generation, session.video.clone()))
        .ok_or_else(|| ApiErr::conflict(40033, "Nothing is playing in this channel."))
}

fn touch(state: &AppState, channel_id: i64, change: impl FnOnce(&mut Session)) {
    if let Some(session) = lock(&state.stremio.sessions).get_mut(&channel_id) {
        change(session);
    }
}

// ---- lifecycle ----

/// Ends the channel's session, if any: the bot drops it and everyone who can see the channel hears.
pub(crate) async fn end(state: &AppState, channel_id: i64) {
    let Some(mut session) = lock(&state.stremio.sessions).remove(&channel_id) else { return };
    if let Some(finished) = session.take_finished(None, unix_millis()) {
        library::save(state, finished);
    }
    if let Some(clients) = &state.stremio.clients {
        let bot = clients.bot.clone();
        let rooms = state.stremio.media_rooms();
        let room = session.room;
        tokio::spawn(async move {
            let _ = bot.delete(channel_id).await;
            // Closing the room disconnects the viewers still in it; their tokens name a room that never comes back.
            let _ = rooms.delete_room(&room).await;
        });
    }
    announce(state, channel_id, None).await;
}

/// Removes everyone from the session's media room whose viewer identity (`viewer:<user_id>:<hex>`) belongs to someone who is not in
/// the call. Run when a person leaves or loses access, and on every tick (a token can join again until it expires).
pub(crate) async fn remove_strangers(state: &AppState, channel_id: i64) {
    let Some(room) = lock(&state.stremio.sessions).get(&channel_id).map(|session| session.room.clone()) else { return };
    let rooms = state.stremio.media_rooms();
    let Ok(inside) = rooms.list_participants(&room).await else { return };
    for participant in inside {
        let user_id = participant.identity.strip_prefix("viewer:").and_then(|rest| rest.split(':').next()).and_then(|id| id.parse::<i64>().ok());
        if user_id.is_some_and(|user_id| !crate::voice::state::in_channel(state, user_id, channel_id)) {
            let _ = rooms.remove_participant(&room, &participant.identity).await;
        }
    }
}

/// A person left the call (or was removed from it): their viewer connections go.
pub(crate) fn user_left(state: &AppState, channel_id: i64) {
    let Some(owner) = lock(&state.stremio.sessions).get(&channel_id).map(|session| session.tracked.as_ref().map(|tracked| tracked.owner)) else { return };
    // The owner went: the rest of the item is not theirs, so their library gets the position they left at, not the end.
    if let Some(owner) = owner.filter(|owner| !crate::voice::state::in_channel(state, *owner, channel_id)) {
        touch(state, channel_id, |session| {
            let here = session.drifted(unix_millis(), MAX_DRIFT_MS);
            if let Some(tracked) = session.tracked.as_mut().filter(|tracked| tracked.owner == owner && tracked.owner_left_at.is_none()) {
                tracked.owner_left_at = Some(here);
            }
        });
    }
    let state = state.clone();
    tokio::spawn(async move { remove_strangers(&state, channel_id).await });
}

/// Who is in the call changed (`control::refresh`): host, votes and the count follow, and enough votes skip.
pub(crate) async fn refresh(state: &AppState, channel_id: i64, room: &control::Room) {
    let Ok(active) = active(state) else { return };
    let (changed, skip) = {
        let mut sessions = lock(&state.stremio.sessions);
        let Some(session) = sessions.get_mut(&channel_id) else { return };
        let before = session.control.clone();
        let skip = control::sync(&mut session.control, room);
        ((session.control != before).then(|| session.view(channel_id)), skip)
    };
    if skip {
        advance(state, &active, channel_id, None).await;
    } else if let Some(view) = changed {
        announce(state, channel_id, Some(view)).await;
    }
}

/// The current item is over (or skipped): plays the next queued one, else ends the session. Items that cannot be opened are passed
/// over. With `ended` set (the generation of the item that ended by itself and the position the bot reported), nothing happens if
/// the session has moved on to another item meanwhile.
async fn advance(state: &AppState, active: &Active<'_>, channel_id: i64, ended: Option<(u64, u64)>) {
    let expected = ended.map(|(generation, _)| generation);
    // The item that is over goes to its starter's library once, before anything replaces it.
    let finished = {
        let mut sessions = lock(&state.stremio.sessions);
        let Some(session) = sessions.get_mut(&channel_id) else { return };
        if expected.is_some_and(|generation| generation != session.generation) {
            return;
        }
        session.take_finished(ended.map(|(_, position_ms)| position_ms), unix_millis())
    };
    if let Some(finished) = finished {
        library::save(state, finished);
    }
    loop {
        let next = {
            let mut sessions = lock(&state.stremio.sessions);
            let Some(session) = sessions.get_mut(&channel_id) else { return };
            if expected.is_some_and(|generation| generation != session.generation) {
                return;
            }
            (!session.queue.is_empty()).then(|| session.queue.remove(0))
        };
        let Some(next) = next else {
            end(state, channel_id).await;
            return;
        };
        let Ok((media, headers)) = prepare(active, &next.candidate).await else { continue };
        let Some(room) = lock(&state.stremio.sessions).get(&channel_id).map(|session| session.room.clone()) else { return };
        let Some(token) = bot_token(state, channel_id, &room) else { return };
        let generation = state.stremio.next_generation();
        let (view, desired) = {
            let mut sessions = lock(&state.stremio.sessions);
            let Some(session) = sessions.get_mut(&channel_id) else { return };
            if expected.is_some_and(|expected| expected != session.generation) {
                session.queue.insert(0, next);
                return;
            }
            session.begin(&next.info, next.candidate, media, headers, generation, token);
            session.track(&next.info, next.added_by, 0);
            let Some(desired) = session.desired(state, unix_millis()) else { return };
            (session.view(channel_id), desired)
        };
        match active.clients.bot.put(channel_id, &desired).await {
            Ok(()) => touch(state, channel_id, |session| session.last_put = Instant::now()),
            Err(_) => touch(state, channel_id, |session| session.dirty = true),
        }
        announce(state, channel_id, Some(view)).await;
        return;
    }
}

/// The user unlinked their Stremio account: what they queued is dropped, what is playing continues.
pub(crate) async fn drop_queued_by(state: &AppState, user_id: i64) {
    let changed: Vec<(i64, StremioState)> = lock(&state.stremio.sessions)
        .iter_mut()
        .filter_map(|(channel_id, session)| {
            let before = session.queue.len();
            session.queue.retain(|queued| queued.added_by != user_id);
            (session.queue.len() != before).then(|| (*channel_id, session.view(*channel_id)))
        })
        .collect();
    for (channel_id, view) in changed {
        announce(state, channel_id, Some(view)).await;
    }
}

// ---- the bot's events ----

#[derive(Debug, Deserialize)]
pub struct BotEvent {
    channel_id: String,
    event: String,
    #[serde(default)]
    position_ms: u64,
    #[serde(default)]
    duration_ms: Option<u64>,
    /// Never stored or shown: ffmpeg's errors can carry the media URL.
    #[serde(default)]
    #[allow(dead_code)]
    message: Option<String>,
    /// `tracks` only: the item (`generation` of the `PUT`) the lists belong to, what the bot found in the file and what it plays by default.
    #[serde(default)]
    generation: Option<u64>,
    #[serde(default)]
    audio_tracks: Vec<StremioAudioTrack>,
    #[serde(default)]
    subtitle_tracks: Vec<StremioSubtitleTrack>,
    #[serde(default)]
    audio: Option<u32>,
    #[serde(default)]
    burned_subtitle: Option<u32>,
}

/// A track title the bot read from the file: one short line of plain text, and nothing that looks like a link (it is shown to everyone).
fn track_title(raw: Option<&str>) -> Option<String> {
    let line = cues::clean_text(raw?).lines().next()?.chars().take(80).collect::<String>();
    let lower = line.to_ascii_lowercase();
    (!line.is_empty() && !lower.contains("://") && !lower.contains("www.")).then_some(line)
}

fn track_codec(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(32).collect::<String>().to_ascii_lowercase()
}

/// The bot's lists are data from inside a media file: capped, ids unique, languages and codecs validated, titles cleaned.
fn sanitized_tracks(audio: Vec<StremioAudioTrack>, subtitles: Vec<StremioSubtitleTrack>) -> (Vec<StremioAudioTrack>, Vec<StremioSubtitleTrack>) {
    let mut seen = HashSet::new();
    let audio = audio
        .into_iter()
        .filter(|track| seen.insert(track.id))
        .take(STREMIO_TRACKS_MAX)
        .map(|track| StremioAudioTrack {
            language: track.language.as_deref().and_then(language_code),
            title: track_title(track.title.as_deref()),
            codec: track_codec(&track.codec),
            ..track
        })
        .collect();
    let mut seen = HashSet::new();
    let subtitles = subtitles
        .into_iter()
        .filter(|track| seen.insert(track.id))
        .take(STREMIO_TRACKS_MAX)
        .map(|track| StremioSubtitleTrack {
            language: track.language.as_deref().and_then(language_code),
            title: track_title(track.title.as_deref()),
            codec: track_codec(&track.codec),
            ..track
        })
        .collect();
    (audio, subtitles)
}

/// `POST /internal/stremio/bot` (never behind Caddy): the bot reports `started`, `position` (every 5 s), `ended` and `error`.
pub async fn bot_event(State(state): State<AppState>, headers: HeaderMap, Json(event): Json<BotEvent>) -> StatusCode {
    let Ok(active) = active(&state) else { return StatusCode::NOT_FOUND };
    let given = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).unwrap_or("");
    if !secrets_match(given.as_bytes(), active.cfg.bot_secret.expose().as_bytes()) {
        return StatusCode::UNAUTHORIZED;
    }
    // An event for a session that is gone is not an error (the bot retries everything but `position` on a failure).
    let Some(channel_id) = event.channel_id.parse::<i64>().ok() else { return StatusCode::NO_CONTENT };
    let grace = active.cfg.event_grace;
    let now = unix_millis();
    enum Next {
        Nothing,
        Announce(StremioState),
        /// The generation of the item that ended and where the bot says it ended.
        Advance(u64, u64),
        Retry(u64, Candidate, u64),
    }
    let next = {
        let mut sessions = lock(&state.stremio.sessions);
        let Some(session) = sessions.get_mut(&channel_id) else { return StatusCode::NO_CONTENT };
        let stale = session.changed.elapsed() < grace;
        match event.event.as_str() {
            "started" if session.status != StremioStatus::Error => {
                session.duration_ms = event.duration_ms.or(session.duration_ms);
                session.position_ms = event.position_ms;
                session.updated_at_ms = now;
                session.bot_down_since = None;
                session.status = if session.playing { StremioStatus::Playing } else { StremioStatus::Paused };
                Next::Announce(session.view(channel_id))
            }
            // Positions are not announced: clients extrapolate. They only correct the server's idea of where the bot is.
            "position" if !stale && session.status != StremioStatus::Error && session.playing => {
                session.position_ms = event.position_ms;
                session.updated_at_ms = now;
                session.duration_ms = event.duration_ms.or(session.duration_ms);
                Next::Nothing
            }
            // The first report for an item sets the lists and the bot's defaults; later ones (after a re-resolve) keep what people chose.
            "tracks" if event.generation == Some(session.generation) && session.audio_tracks.is_empty() && session.subtitle_tracks.is_empty() => {
                let (audio_tracks, subtitle_tracks) = sanitized_tracks(event.audio_tracks, event.subtitle_tracks);
                session.audio = event.audio.filter(|id| audio_tracks.iter().any(|track| track.id == *id));
                session.burned =
                    event.burned_subtitle.filter(|id| subtitle_tracks.iter().any(|track| track.id == *id && track.kind == StremioSubtitleKind::Bitmap));
                session.audio_tracks = audio_tracks;
                session.subtitle_tracks = subtitle_tracks;
                Next::Announce(session.view(channel_id))
            }
            "ended" if !stale && session.status != StremioStatus::Error => Next::Advance(session.generation, event.position_ms),
            "error" if !stale && session.status != StremioStatus::Error => {
                if session.retried {
                    session.status = StremioStatus::Error;
                    session.error = Some(PLAYBACK_FAILED.to_owned());
                    session.error_since = Some(Instant::now());
                    Next::Announce(session.view(channel_id))
                } else {
                    // The CDN link may have expired: resolve it again once and carry on from where it stopped.
                    session.retried = true;
                    session.changed = Instant::now();
                    session.status = StremioStatus::Starting;
                    session.position_ms = event.position_ms;
                    session.updated_at_ms = now;
                    Next::Retry(session.generation, session.candidate.clone(), event.position_ms)
                }
            }
            _ => Next::Nothing,
        }
    };
    match next {
        Next::Nothing => {}
        Next::Announce(view) => announce(&state, channel_id, Some(view)).await,
        Next::Advance(generation, position_ms) => advance(&state, &active, channel_id, Some((generation, position_ms))).await,
        Next::Retry(generation, candidate, position_ms) => retry(&state, &active, channel_id, generation, candidate, position_ms).await,
    }
    StatusCode::NO_CONTENT
}

/// Re-resolves the current item and sends the bot the new link at `position_ms`; if that fails the tile shows the error.
async fn retry(state: &AppState, active: &Active<'_>, channel_id: i64, generation: u64, candidate: Candidate, position_ms: u64) {
    let resolved = prepare(active, &candidate).await;
    let (view, desired) = {
        let mut sessions = lock(&state.stremio.sessions);
        let Some(session) = sessions.get_mut(&channel_id).filter(|session| session.generation == generation) else { return };
        match resolved {
            Ok((media, headers)) => {
                session.media = media;
                session.headers = headers;
                session.position_ms = position_ms;
                session.updated_at_ms = unix_millis();
                session.changed = Instant::now();
                (session.view(channel_id), session.desired(state, unix_millis()))
            }
            Err(_) => {
                session.status = StremioStatus::Error;
                session.error = Some(PLAYBACK_FAILED.to_owned());
                session.error_since = Some(Instant::now());
                (session.view(channel_id), None)
            }
        }
    };
    if let Some(desired) = desired {
        match active.clients.bot.put(channel_id, &desired).await {
            Ok(()) => touch(state, channel_id, |session| session.last_put = Instant::now()),
            Err(_) => touch(state, channel_id, |session| session.dirty = true),
        }
    }
    announce(state, channel_id, Some(view)).await;
}

// ---- background work ----

/// At startup the bot is told to drop whatever it still plays (sessions are in memory only), then every `tick` the sessions are
/// checked: a pause or an error that lasted too long ends the session, and the bot gets the desired state again as a lease (or
/// as soon as a `PUT` failed), because it drops a session not renewed for 150 s.
pub fn spawn_tasks(state: AppState) {
    let Some(clients) = &state.stremio.clients else { return };
    let bot = clients.bot.clone();
    tokio::spawn(async move {
        for _ in 0..5 {
            if bot.delete_all().await.is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
    tokio::spawn(async move {
        let Some(tick) = state.config.stremio.as_ref().map(|cfg| cfg.tick) else { return };
        let mut ticker = tokio::time::interval(tick);
        loop {
            ticker.tick().await;
            sweep(&state).await;
        }
    });
}

async fn sweep(state: &AppState) {
    let (Some(cfg), Some(clients)) = (&state.config.stremio, &state.stremio.clients) else { return };
    let mut stop = Vec::new();
    let mut resend = Vec::new();
    {
        let mut sessions = lock(&state.stremio.sessions);
        for (channel_id, session) in sessions.iter_mut() {
            let paused_too_long = session.paused_since.is_some_and(|since| since.elapsed() >= cfg.pause_timeout);
            let errored_too_long = session.error_since.is_some_and(|since| since.elapsed() >= cfg.error_hold);
            // The bot has been unreachable (or refusing) for as long as an error stays on the tile.
            let bot_gone = session.bot_down_since.is_some_and(|since| since.elapsed() >= cfg.error_hold);
            if paused_too_long || errored_too_long || bot_gone {
                stop.push(*channel_id);
            } else if session.status != StremioStatus::Error
                && (session.dirty || session.last_put.elapsed() >= cfg.lease_interval)
                && let Some(desired) = session.desired(state, unix_millis())
            {
                resend.push((*channel_id, session.generation, desired));
            }
        }
    }
    for channel_id in stop {
        end(state, channel_id).await;
    }
    // A viewer token outlives the person's place in the call (6 h), so who is in the media room is checked against who is in voice.
    let rooms: Vec<i64> = lock(&state.stremio.sessions).keys().copied().collect();
    for channel_id in rooms {
        remove_strangers(state, channel_id).await;
    }
    for (channel_id, generation, desired) in resend {
        let sent = clients.bot.put(channel_id, &desired).await.is_ok();
        touch(state, channel_id, |session| {
            if session.generation != generation {
                return;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_silent_bot_is_not_assumed_to_keep_playing() {
        assert_eq!(extrapolate(60_000, 1_000, true, 4_000, MAX_DRIFT_MS), 63_000, "a report is due: the position moves on with the clock");
        assert_eq!(extrapolate(60_000, 1_000, true, 3_601_000, MAX_DRIFT_MS), 70_000, "an hour without a report counts as ten seconds");
        assert_eq!(extrapolate(60_000, 1_000, true, 3_601_000, u64::MAX), 3_660_000, "what clients see is not capped");
        assert_eq!(extrapolate(60_000, 1_000, false, 3_601_000, MAX_DRIFT_MS), 60_000, "paused");
        assert_eq!(extrapolate(60_000, 5_000, true, 1_000, MAX_DRIFT_MS), 60_000, "a clock that went back");
    }
}
