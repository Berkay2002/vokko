//! Watch Together: one YouTube video the people in a voice channel or DM call watch in sync (Vokko-only). The session lives in
//! memory per channel, anyone connected to the channel's voice may control it, and it ends when the last person leaves voice.
//! `PUT|PATCH|DELETE /channels/{id}/watch-together` and WATCH_TOGETHER_UPDATE.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::{Json, Router};
use vokko_protocol::api::{
    ChannelType, GatewayEvent, Snowflake, WATCH_TOGETHER_POSITION_MAX_MS, WATCH_TOGETHER_QUEUE_MAX, WATCH_TOGETHER_TITLE_MAX_CHARS, WatchTogetherPatchRequest,
    WatchTogetherStartRequest, WatchTogetherState, WatchTogetherUpdate,
};

use super::unix_millis;
use crate::access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;
use crate::store;

/// Control writes per user: a burst of 10, then 2 per second (10 per 5 s).
pub const CONTROL_BURST: f64 = 10.0;
pub const CONTROL_PER_SECOND: f64 = 2.0;

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/watch-together", put(start).patch(control).delete(stop))
}

/// 11 characters of `A-Za-z0-9_-` (a YouTube video id).
pub fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn check_video_id(field: &str, id: &str) -> ApiResult<()> {
    if valid_video_id(id) { Ok(()) } else { Err(ApiErr::invalid(field, "Must be a YouTube video id (11 characters of A-Z a-z 0-9 _ -).")) }
}

/// Characters a broadcast title may not carry: controls (newlines too), zero-width and joiner marks, bidi marks, embeddings and
/// isolates (spoofing), the soft hyphen, word joiners and invisible operators, variation selectors, tags and the blank "filler"
/// letters.
fn hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'
                | '\u{1160}'
                | '\u{17B4}'
                | '\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{2800}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E0FFF}'
        )
}

fn clean_title(title: Option<&str>) -> ApiResult<Option<String>> {
    let title = title.map(str::trim).filter(|text| !text.is_empty());
    if title.is_some_and(|text| text.chars().count() > WATCH_TOGETHER_TITLE_MAX_CHARS) {
        return Err(ApiErr::invalid("title", &format!("Must be {WATCH_TOGETHER_TITLE_MAX_CHARS} or fewer in length.")));
    }
    if title.is_some_and(|text| text.chars().any(hidden_char)) {
        return Err(ApiErr::invalid("title", "Must not contain control or invisible characters."));
    }
    Ok(title.map(str::to_owned))
}

/// The channel id, if the caller is connected to its voice right now and would still be admitted to it: the voice join path's
/// checks run again (VIEW_CHANNEL + CONNECT and not timed out in a guild; still a recipient and not blocked in a DM call), so
/// someone who lost access while connected cannot keep steering the video. Else 403, like a missing permission.
async fn require_in_voice(state: &AppState, user_id: i64, raw: &str) -> ApiResult<i64> {
    let id = parse_id(raw).ok_or_else(ApiErr::unknown_channel)?;
    if !super::state::in_channel(state, user_id, id) {
        return Err(ApiErr::missing_permissions());
    }
    let row = store::channel_row(state, id).await?.ok_or_else(ApiErr::missing_permissions)?;
    if row.channel_type() == ChannelType::GuildStage {
        return Err(ApiErr::wrong_channel_type());
    }
    let admitted = if row.is_dm() { super::state::admit_dm(state, user_id, &row).await } else { super::state::admit_guild(state, user_id, &row).await };
    admitted.map(|_| id).map_err(|_| ApiErr::missing_permissions())
}

fn limited(state: &AppState, user_id: i64) -> Option<Response> {
    state.config.rate_limit.as_ref()?;
    let result = state.limiter.check_key("watch-together", user_id, CONTROL_BURST, CONTROL_PER_SECOND);
    result.err().map(|retry_after| crate::ratelimit::limited_response(crate::ratelimit::Limited { retry_after, global: false }))
}

async fn start(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<WatchTogetherStartRequest>,
) -> ApiResult<Response> {
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    check_video_id("video_id", &body.video_id)?;
    let title = clean_title(body.title.as_deref())?;
    if let Some(response) = limited(&state, user_id) {
        return Ok(response);
    }
    // Changing the video keeps the queue and who started the session; a new session starts with an empty queue.
    let (_, next) = state.voice.watch_update(channel_id, |current| {
        let (started_by, queue) = current.map_or((Snowflake::from(user_id), Vec::new()), |current| (current.started_by, current.queue.clone()));
        Ok(Some(WatchTogetherState { video_id: body.video_id.clone(), title, playing: true, position_ms: 0, updated_at_ms: unix_millis(), started_by, queue }))
    })?;
    announce(&state, channel_id, next.clone()).await;
    Ok(Json(next).into_response())
}

async fn control(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<WatchTogetherPatchRequest>,
) -> ApiResult<Response> {
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    if body.position_ms.is_some_and(|position| position > WATCH_TOGETHER_POSITION_MAX_MS) {
        return Err(ApiErr::invalid("position_ms", "Must be between 0 and 86400000."));
    }
    for (field, value) in [("queue_add", &body.queue_add), ("video_id", &body.video_id)] {
        if let Some(value) = value {
            check_video_id(field, value)?;
        }
    }
    let title = clean_title(body.title.as_deref())?;
    if let Some(response) = limited(&state, user_id) {
        return Ok(response);
    }
    let now = unix_millis();
    let (previous, next) = state.voice.watch_update(channel_id, |current| {
        let mut next = current.ok_or_else(|| ApiErr::conflict(40033, "Nothing is playing in this channel."))?.clone();
        // Where the video is right now, before play / pause / seek apply: pausing keeps the position.
        let here = if next.playing { next.position_ms + (now - next.updated_at_ms).max(0) as u64 } else { next.position_ms };
        if body.skip == Some(true) {
            // Every client reports "ended" at once: only the first one's skip finds its video still current.
            if body.video_id.as_ref().is_some_and(|expected| *expected != next.video_id) {
                return Ok(Some(next));
            }
            if next.queue.is_empty() {
                return Ok(None);
            }
            next.video_id = next.queue.remove(0);
            next.title = None;
            next.playing = true;
            next.position_ms = 0;
            next.updated_at_ms = now;
        } else if body.playing.is_some() || body.position_ms.is_some() {
            next.position_ms = body.position_ms.unwrap_or(here);
            next.playing = body.playing.unwrap_or(next.playing);
            next.updated_at_ms = now;
        }
        if title.is_some() {
            next.title = title.clone();
        }
        if let Some(added) = &body.queue_add {
            if next.queue.len() >= WATCH_TOGETHER_QUEUE_MAX {
                return Err(ApiErr::invalid("queue_add", &format!("The queue holds at most {WATCH_TOGETHER_QUEUE_MAX} videos.")));
            }
            next.queue.push(added.clone());
        }
        Ok(Some(next))
    })?;
    if next != previous {
        announce(&state, channel_id, next.clone()).await;
    }
    Ok(Json(next).into_response())
}

async fn stop(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Response> {
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    if let Some(response) = limited(&state, user_id) {
        return Ok(response);
    }
    end(&state, channel_id).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Ends the channel's session, if any, and tells everyone who can see the channel.
pub(crate) async fn end(state: &AppState, channel_id: i64) {
    if let Ok((Some(_), _)) = state.voice.watch_update(channel_id, |_| Ok(None)) {
        announce(state, channel_id, None).await;
    }
}

/// WATCH_TOGETHER_UPDATE to everyone who can see the channel (`state: null` = the session ended).
async fn announce(state: &AppState, channel_id: i64, session: Option<WatchTogetherState>) {
    let Ok(Some(row)) = store::channel_row(state, channel_id).await else { return };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return };
    state.hub.send(&viewers, &GatewayEvent::WatchTogetherUpdate(WatchTogetherUpdate { channel_id: Snowflake::from(channel_id), state: session }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_ids_and_titles() {
        assert!(valid_video_id("dQw4w9WgXcQ") && valid_video_id("a_b-c_d-e_1"));
        assert!(!valid_video_id("dQw4w9WgXc") && !valid_video_id("dQw4w9WgXc!") && !valid_video_id("dQw4w9WgXcQQ") && !valid_video_id("dQw4w9WgXcé"));
        assert_eq!(clean_title(Some("  Rick  ")).expect("ok").as_deref(), Some("Rick"));
        assert!(clean_title(Some("   ")).expect("ok").is_none());
        for bad in ["a\nb", "a\u{200B}b", "a\u{202E}b", "a\u{00AD}b", "a\u{3164}b", "a\u{2066}b", "a\u{FEFF}b", "a\u{0007}b"] {
            assert!(clean_title(Some(bad)).is_err(), "{bad:?}");
        }
        assert!(clean_title(Some("日本語 ünïcode 🎵")).is_ok());
    }
}
