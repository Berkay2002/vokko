//! `POST /internal/livekit/webhook`: LiveKit's signed participant/track/room events (docs/design/voice.md §1.5).
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use serde::Deserialize;
use serde_json::Value;

use super::livekit::{Participant, TrackInfo};
use super::{room_channel, state, unix_now};
use crate::state::AppState;

#[derive(Debug, Default, Deserialize)]
struct Room {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct WebhookEvent {
    #[serde(default)]
    event: String,
    #[serde(default)]
    room: Option<Room>,
    #[serde(default)]
    participant: Option<Participant>,
    #[serde(default)]
    track: Option<TrackInfo>,
    /// Unix seconds; protojson sends int64 as a string.
    #[serde(default, alias = "created_at", rename = "createdAt")]
    created_at: Option<Value>,
}

fn seconds(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

pub async fn receive(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> StatusCode {
    let Some(livekit) = &state.config.livekit else { return StatusCode::NOT_FOUND };
    let authorization = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    if !super::token::verify_webhook(&livekit.api_key, &livekit.api_secret, authorization, &body, unix_now()) {
        return StatusCode::UNAUTHORIZED;
    }
    let Ok(event) = serde_json::from_slice::<WebhookEvent>(&body) else { return StatusCode::BAD_REQUEST };
    let Some(channel_id) = event.room.as_ref().and_then(|room| room_channel(&room.name)) else { return StatusCode::OK };
    let participant = event.participant.unwrap_or_default();
    match event.event.as_str() {
        "participant_joined" => state::participant_joined(&state, channel_id, &participant).await,
        "participant_left" => state::participant_left(&state, channel_id, &participant, event.created_at.as_ref().and_then(seconds)).await,
        "track_published" | "track_unpublished" => {
            let source = event.track.map(|track| track.source).unwrap_or_default();
            state::track_changed(&state, channel_id, &participant, &source, event.event == "track_published").await;
        }
        "room_finished" => state::room_finished(&state, channel_id).await,
        _ => {}
    }
    StatusCode::OK
}
