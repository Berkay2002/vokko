//! Events to the server: `POST {server}/internal/stremio/bot` with the bearer secret.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use vokko_protocol::api::{StremioAudioTrack, StremioSubtitleTrack};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Started,
    Position,
    Ended,
    Error,
    Tracks,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Started => "started",
            Kind::Position => "position",
            Kind::Ended => "ended",
            Kind::Error => "error",
            Kind::Tracks => "tracks",
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Event<'a> {
    pub channel_id: &'a str,
    pub event: &'a str,
    pub position_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
    /// `started` only: the item (`generation` of the `PUT`) whose pipeline started; `tracks` carry theirs in `Tracks`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<&'a Tracks>,
}

/// What the file holds and what the bot plays by default; sent once per probe (the server keeps the first report of an item).
#[derive(Serialize, Debug, PartialEq)]
pub struct Tracks {
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub burned_subtitle: Option<u32>,
    pub audio_tracks: Vec<StremioAudioTrack>,
    pub subtitle_tracks: Vec<StremioSubtitleTrack>,
}

#[derive(Clone)]
pub struct Reporter {
    client: reqwest::Client,
    url: Arc<str>,
    secret: Arc<str>,
}

impl Reporter {
    pub fn new(server_url: &str, secret: &str) -> Self {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default();
        Self { client, url: format!("{server_url}/internal/stremio/bot").into(), secret: secret.into() }
    }

    /// Fire and forget. Everything but `position` is retried a few times, because the server only learns of the end
    /// of a movie from here.
    pub fn send(&self, channel_id: &str, kind: Kind, position_ms: u64, duration_ms: Option<u64>, message: Option<String>) {
        self.dispatch(channel_id, kind, position_ms, duration_ms, message, None, None);
    }

    /// The first frame of a pipeline of item `generation`, so the server can drop a late one from the item before.
    pub fn send_started(&self, channel_id: &str, position_ms: u64, duration_ms: Option<u64>, generation: u64) {
        self.dispatch(channel_id, Kind::Started, position_ms, duration_ms, None, Some(generation), None);
    }

    pub fn send_tracks(&self, channel_id: &str, position_ms: u64, tracks: Tracks) {
        self.dispatch(channel_id, Kind::Tracks, position_ms, None, None, None, Some(tracks));
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch(
        &self,
        channel_id: &str,
        kind: Kind,
        position_ms: u64,
        duration_ms: Option<u64>,
        message: Option<String>,
        generation: Option<u64>,
        tracks: Option<Tracks>,
    ) {
        let this = self.clone();
        let channel_id = channel_id.to_owned();
        tokio::spawn(async move {
            let body = Event {
                channel_id: &channel_id,
                event: kind.name(),
                position_ms,
                duration_ms,
                message: message.as_deref(),
                generation,
                tracks: tracks.as_ref(),
            };
            let attempts = if kind == Kind::Position { 1 } else { 4 };
            for attempt in 1..=attempts {
                match this.client.post(this.url.as_ref()).bearer_auth(this.secret.as_ref()).json(&body).send().await {
                    Ok(r) if r.status().is_success() => return,
                    Ok(r) => tracing::warn!(channel_id, event = kind.name(), status = %r.status(), "server rejected event"),
                    Err(e) => tracing::warn!(channel_id, event = kind.name(), error = %e.without_url(), "event not delivered"),
                }
                if attempt < attempts {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_json_shape() {
        let e = Event { channel_id: "42", event: Kind::Position.name(), position_ms: 5000, duration_ms: None, message: None, generation: None, tracks: None };
        assert_eq!(serde_json::to_string(&e).expect("json"), r#"{"channel_id":"42","event":"position","position_ms":5000}"#);
        let e =
            Event { channel_id: "42", event: Kind::Error.name(), position_ms: 1, duration_ms: Some(9), message: Some("boom"), generation: None, tracks: None };
        assert_eq!(serde_json::to_string(&e).expect("json"), r#"{"channel_id":"42","event":"error","position_ms":1,"duration_ms":9,"message":"boom"}"#);
        let tracks = Tracks { generation: 7, audio: Some(1), burned_subtitle: None, audio_tracks: Vec::new(), subtitle_tracks: Vec::new() };
        let e =
            Event { channel_id: "42", event: Kind::Tracks.name(), position_ms: 0, duration_ms: None, message: None, generation: None, tracks: Some(&tracks) };
        assert_eq!(
            serde_json::to_string(&e).expect("json"),
            r#"{"channel_id":"42","event":"tracks","position_ms":0,"generation":7,"audio":1,"audio_tracks":[],"subtitle_tracks":[]}"#
        );
        let e = Event { channel_id: "42", event: Kind::Started.name(), position_ms: 0, duration_ms: Some(9), message: None, generation: Some(7), tracks: None };
        assert_eq!(serde_json::to_string(&e).expect("json"), r#"{"channel_id":"42","event":"started","position_ms":0,"duration_ms":9,"generation":7}"#);
    }
}
