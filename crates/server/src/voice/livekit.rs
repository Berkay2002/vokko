//! LiveKit's server API (RoomService over Twirp/JSON) behind a trait, so tests run against `FakeRoomService` without an SFU.
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::token::{self, Claims, VideoGrant};

pub type RoomFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// A published track as far as voice state cares.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct TrackInfo {
    #[serde(default)]
    pub sid: String,
    /// `MICROPHONE`, `CAMERA`, `SCREEN_SHARE`, `SCREEN_SHARE_AUDIO` (LiveKit's enum names).
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub muted: bool,
}

/// LiveKit's `ParticipantInfo`, the fields Vokko reads (snake_case from Twirp, camelCase from webhooks).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Participant {
    #[serde(default)]
    pub sid: String,
    #[serde(default)]
    pub identity: String,
    /// Vokko sets `{"session_id": "..."}` through the token.
    #[serde(default)]
    pub metadata: String,
    #[serde(default)]
    pub tracks: Vec<TrackInfo>,
}

impl Participant {
    pub fn user_id(&self) -> Option<i64> {
        self.identity.parse().ok()
    }

    pub fn session_id(&self) -> Option<String> {
        self.metadata_field("session_id")
    }

    /// Nonce of the token the participant connected with (`""` for tokens that had none).
    pub fn token_nonce(&self) -> String {
        self.metadata_field("token").unwrap_or_default()
    }

    fn metadata_field(&self, key: &str) -> Option<String> {
        let metadata: Value = serde_json::from_str(&self.metadata).ok()?;
        metadata.get(key)?.as_str().map(str::to_owned)
    }

    fn has(&self, source: &str, unmuted: bool) -> bool {
        self.tracks.iter().any(|track| track.source.eq_ignore_ascii_case(source) && (!unmuted || !track.muted))
    }

    /// No live microphone track: treat as self-muted (used when rebuilding state from LiveKit).
    pub fn mic_muted(&self) -> bool {
        !self.has("MICROPHONE", true)
    }

    pub fn camera(&self) -> bool {
        self.has("CAMERA", false)
    }

    pub fn screen_share(&self) -> bool {
        self.has("SCREEN_SHARE", false)
    }

    /// Sid of the published microphone track, if any.
    pub fn mic_track(&self) -> Option<&str> {
        self.tracks.iter().find(|track| track.source.eq_ignore_ascii_case("MICROPHONE") && !track.sid.is_empty()).map(|track| track.sid.as_str())
    }
}

/// What a participant may do, as LiveKit's `ParticipantPermission` (sources in the token's lowercase names).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Permission {
    pub can_subscribe: bool,
    pub sources: Vec<String>,
    pub hidden: bool,
}

impl Permission {
    fn to_json(&self) -> Value {
        let sources: Vec<String> = self.sources.iter().map(|source| source.to_ascii_uppercase()).collect();
        json!({
            "can_subscribe": self.can_subscribe,
            "can_publish": !sources.is_empty(),
            "can_publish_sources": sources,
            "can_publish_data": false,
            "can_update_metadata": false,
            "hidden": self.hidden,
        })
    }
}

/// The RoomService calls vokko-server makes. Errors are strings: callers log them and carry on (LiveKit is best effort,
/// the next reconciliation repairs what a failed call left behind).
pub trait RoomService: Send + Sync {
    fn list_rooms(&self) -> RoomFuture<'_, Vec<String>>;
    fn list_participants<'a>(&'a self, room: &'a str) -> RoomFuture<'a, Vec<Participant>>;
    fn remove_participant<'a>(&'a self, room: &'a str, identity: &'a str) -> RoomFuture<'a, ()>;
    /// Replaces the participant's permissions (publish sources, subscribe, hidden) without a reconnect.
    fn update_participant<'a>(&'a self, room: &'a str, identity: &'a str, permission: &'a Permission) -> RoomFuture<'a, ()>;
    fn mute_published_track<'a>(&'a self, room: &'a str, identity: &'a str, track_sid: &'a str) -> RoomFuture<'a, ()>;
}

/// Voice disabled: nothing to talk to.
pub struct NoRoomService;

impl RoomService for NoRoomService {
    fn list_rooms(&self) -> RoomFuture<'_, Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn list_participants<'a>(&'a self, _room: &'a str) -> RoomFuture<'a, Vec<Participant>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn remove_participant<'a>(&'a self, _room: &'a str, _identity: &'a str) -> RoomFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn update_participant<'a>(&'a self, _room: &'a str, _identity: &'a str, _permission: &'a Permission) -> RoomFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn mute_published_track<'a>(&'a self, _room: &'a str, _identity: &'a str, _track_sid: &'a str) -> RoomFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

/// A participant that is not (or no longer) in the room counts as done.
fn gone_is_fine(result: Result<Value, String>) -> Result<(), String> {
    match result {
        Err(error) if error.contains("404") || error.contains("not_found") => Ok(()),
        other => other.map(|_| ()),
    }
}

/// Twirp over HTTP(S) to LiveKit's signal port (`VOKKO_LIVEKIT_API_URL`).
pub struct HttpRoomService {
    client: reqwest::Client,
    api_url: String,
    api_key: String,
    api_secret: String,
}

impl HttpRoomService {
    pub fn new(api_url: &str, api_key: &str, api_secret: &str) -> Result<Self, String> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|error| error.to_string())?;
        Ok(Self { client, api_url: api_url.trim_end_matches('/').to_owned(), api_key: api_key.to_owned(), api_secret: api_secret.to_owned() })
    }

    fn admin_token(&self, grant: VideoGrant) -> Result<String, String> {
        let now = super::unix_now();
        let claims = Claims { iss: self.api_key.clone(), nbf: now, exp: now + 60, video: Some(grant), ..Claims::default() };
        token::sign(&self.api_secret, &claims).ok_or_else(|| "cannot sign a LiveKit admin token".to_owned())
    }

    async fn call(&self, method: &str, grant: VideoGrant, body: Value) -> Result<Value, String> {
        let token = self.admin_token(grant)?;
        let response = self
            .client
            .post(format!("{}/twirp/livekit.RoomService/{method}", self.api_url))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|error| format!("LiveKit {method}: {error}"))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| format!("LiveKit {method}: {error}"))?;
        if !status.is_success() {
            return Err(format!("LiveKit {method}: HTTP {status}: {}", String::from_utf8_lossy(&bytes)));
        }
        serde_json::from_slice(&bytes).map_err(|error| format!("LiveKit {method}: bad JSON: {error}"))
    }
}

fn admin(room: &str) -> VideoGrant {
    VideoGrant { room: Some(room.to_owned()), room_admin: true, ..VideoGrant::default() }
}

impl RoomService for HttpRoomService {
    fn list_rooms(&self) -> RoomFuture<'_, Vec<String>> {
        Box::pin(async move {
            let value = self.call("ListRooms", VideoGrant { room_list: true, ..VideoGrant::default() }, json!({})).await?;
            let rooms = value.get("rooms").and_then(Value::as_array).cloned().unwrap_or_default();
            Ok(rooms.iter().filter_map(|room| room.get("name").and_then(Value::as_str).map(str::to_owned)).collect())
        })
    }

    fn list_participants<'a>(&'a self, room: &'a str) -> RoomFuture<'a, Vec<Participant>> {
        Box::pin(async move {
            let value = self.call("ListParticipants", admin(room), json!({"room": room})).await?;
            let list = value.get("participants").cloned().unwrap_or(Value::Array(Vec::new()));
            serde_json::from_value(list).map_err(|error| format!("LiveKit ListParticipants: {error}"))
        })
    }

    fn remove_participant<'a>(&'a self, room: &'a str, identity: &'a str) -> RoomFuture<'a, ()> {
        Box::pin(async move { gone_is_fine(self.call("RemoveParticipant", admin(room), json!({"room": room, "identity": identity})).await) })
    }

    fn update_participant<'a>(&'a self, room: &'a str, identity: &'a str, permission: &'a Permission) -> RoomFuture<'a, ()> {
        Box::pin(async move {
            let body = json!({"room": room, "identity": identity, "permission": permission.to_json()});
            gone_is_fine(self.call("UpdateParticipant", admin(room), body).await)
        })
    }

    fn mute_published_track<'a>(&'a self, room: &'a str, identity: &'a str, track_sid: &'a str) -> RoomFuture<'a, ()> {
        Box::pin(async move {
            let body = json!({"room": room, "identity": identity, "track_sid": track_sid, "muted": true});
            gone_is_fine(self.call("MutePublishedTrack", admin(room), body).await)
        })
    }
}

/// In-memory RoomService for tests: rooms with participants, and a log of the calls made.
#[derive(Default)]
pub struct FakeRoomService {
    rooms: Mutex<Vec<(String, Vec<Participant>)>>,
    calls: Mutex<Vec<String>>,
    /// `ListRooms` calls that fail before the fake answers again (LiveKit unreachable).
    failing_lists: Mutex<u32>,
    /// The next `ListParticipants` waits for this before answering (a race between the listing and later work).
    held_list: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl FakeRoomService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn add_participant(&self, room: &str, participant: Participant) {
        let mut rooms = lock(&self.rooms);
        match rooms.iter_mut().find(|(name, _)| name == room) {
            Some((_, list)) => list.push(participant),
            None => rooms.push((room.to_owned(), vec![participant])),
        }
    }

    /// `RemoveParticipant room identity`, `ListParticipants room`, `ListRooms`, `UpdateParticipant room identity
    /// sources=a,b subscribe=bool hidden=bool`, `MutePublishedTrack room identity sid` in call order.
    pub fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }

    /// The next `count` `ListRooms` calls fail.
    pub fn fail_lists(&self, count: u32) {
        *lock(&self.failing_lists) = count;
    }

    /// Holds the next `ListParticipants` until the returned sender fires (or is dropped).
    pub fn hold_next_list(&self) -> tokio::sync::oneshot::Sender<()> {
        let (release, held) = tokio::sync::oneshot::channel();
        *lock(&self.held_list) = Some(held);
        release
    }
}

impl RoomService for FakeRoomService {
    fn list_rooms(&self) -> RoomFuture<'_, Vec<String>> {
        lock(&self.calls).push("ListRooms".to_owned());
        {
            let mut failing = lock(&self.failing_lists);
            if *failing > 0 {
                *failing -= 1;
                return Box::pin(async { Err("LiveKit ListRooms: connection refused".to_owned()) });
            }
        }
        let names = lock(&self.rooms).iter().map(|(name, _)| name.clone()).collect();
        Box::pin(async move { Ok(names) })
    }

    fn list_participants<'a>(&'a self, room: &'a str) -> RoomFuture<'a, Vec<Participant>> {
        lock(&self.calls).push(format!("ListParticipants {room}"));
        let list = lock(&self.rooms).iter().find(|(name, _)| name == room).map(|(_, list)| list.clone()).unwrap_or_default();
        let held = lock(&self.held_list).take();
        Box::pin(async move {
            if let Some(held) = held {
                let _ = held.await;
            }
            Ok(list)
        })
    }

    fn remove_participant<'a>(&'a self, room: &'a str, identity: &'a str) -> RoomFuture<'a, ()> {
        lock(&self.calls).push(format!("RemoveParticipant {room} {identity}"));
        if let Some((_, list)) = lock(&self.rooms).iter_mut().find(|(name, _)| name == room) {
            list.retain(|participant| participant.identity != identity);
        }
        Box::pin(async { Ok(()) })
    }

    fn update_participant<'a>(&'a self, room: &'a str, identity: &'a str, permission: &'a Permission) -> RoomFuture<'a, ()> {
        lock(&self.calls).push(format!(
            "UpdateParticipant {room} {identity} sources={} subscribe={} hidden={}",
            permission.sources.join(","),
            permission.can_subscribe,
            permission.hidden
        ));
        Box::pin(async { Ok(()) })
    }

    fn mute_published_track<'a>(&'a self, room: &'a str, identity: &'a str, track_sid: &'a str) -> RoomFuture<'a, ()> {
        lock(&self.calls).push(format!("MutePublishedTrack {room} {identity} {track_sid}"));
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_info_parses_twirp_and_webhook_json() {
        let participant: Participant = serde_json::from_value(json!({
            "sid": "PA_1", "identity": "42", "metadata": "{\"session_id\":\"abc\"}", "state": "ACTIVE", "joinedAt": "1700000000",
            "tracks": [{"sid": "TR_1", "source": "MICROPHONE", "muted": false}, {"source": "SCREEN_SHARE"}]
        }))
        .expect("participant");
        assert_eq!((participant.user_id(), participant.session_id().as_deref()), (Some(42), Some("abc")));
        assert!(!participant.mic_muted() && participant.screen_share() && !participant.camera());
        assert_eq!(participant.mic_track(), Some("TR_1"));
        let silent = Participant { tracks: vec![TrackInfo { sid: String::new(), source: "MICROPHONE".into(), muted: true }], ..Participant::default() };
        assert!(silent.mic_muted());
        assert_eq!(Participant { metadata: "not json".into(), ..Participant::default() }.session_id(), None);
    }

    #[test]
    fn permissions_use_livekit_source_names() {
        let permission = Permission { can_subscribe: false, sources: vec!["microphone".into(), "screen_share_audio".into()], hidden: true };
        assert_eq!(
            permission.to_json(),
            json!({"can_subscribe": false, "can_publish": true, "can_publish_sources": ["MICROPHONE", "SCREEN_SHARE_AUDIO"], "can_publish_data": false,
                   "can_update_metadata": false, "hidden": true})
        );
        assert_eq!(Permission::default().to_json()["can_publish"], false);
    }
}
