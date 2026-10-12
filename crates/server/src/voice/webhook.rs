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
    if state.config.livekit.is_empty() {
        tracing::warn!("livekit webhook: received but LiveKit is not configured on this server");
        return StatusCode::NOT_FOUND;
    }
    let authorization = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    let keys: Vec<(&str, &str)> = state.config.livekit.iter().map(|livekit| (livekit.api_key.as_str(), livekit.api_secret.as_str())).collect();
    let backend = match super::token::verify_webhook_any(&keys, authorization, &body, unix_now()) {
        Ok(backend) => backend,
        Err(refusal) => {
            tracing::warn!("livekit webhook: rejected ({}), {} body bytes", refusal.reason(), body.len());
            return StatusCode::UNAUTHORIZED;
        }
    };
    let event = match serde_json::from_slice::<WebhookEvent>(&body) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!("livekit webhook: signed body is not an event: {error}");
            return StatusCode::BAD_REQUEST;
        }
    };
    tracing::info!(
        "livekit webhook: {} backend={} room={:?} identity={:?} source={:?}",
        event.event,
        state.config.livekit.get(backend).map_or("", |livekit| livekit.label.as_str()),
        event.room.as_ref().map_or("", |room| room.name.as_str()),
        event.participant.as_ref().map_or("", |participant| participant.identity.as_str()),
        event.track.as_ref().map_or("", |track| track.source.as_str()),
    );
    let Some(channel_id) = event.room.as_ref().and_then(|room| room_channel(&room.name)) else { return StatusCode::OK };
    let participant = event.participant.unwrap_or_default();
    match event.event.as_str() {
        "participant_joined" => state::participant_joined(&state, backend, channel_id, &participant).await,
        "participant_left" => state::participant_left(&state, backend, channel_id, &participant, event.created_at.as_ref().and_then(seconds)).await,
        "track_published" | "track_unpublished" => {
            let source = event.track.map(|track| track.source).unwrap_or_default();
            state::track_changed(&state, backend, channel_id, &participant, &source, event.event == "track_published").await;
        }
        "room_finished" => state::room_finished(&state, backend, channel_id).await,
        _ => {}
    }
    StatusCode::OK
}
