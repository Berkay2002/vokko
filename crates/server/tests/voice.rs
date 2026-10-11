#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Voice V1 (docs/design/voice.md §6): op 4, token grants, broadcasts, limits, webhooks, lifecycle and restore, against a fake
//! LiveKit RoomService.
mod common;

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;
use vokko_protocol::api::permissions::{CONNECT, MOVE_MEMBERS, SPEAK, STREAM, VIEW_CHANNEL};
use vokko_server::config::{Config, LiveKitConfig};
use vokko_server::voice::livekit::{FakeRoomService, Participant, RoomService};
use vokko_server::voice::token;

const KEY: &str = "vokko";
const SECRET: &str = "test-secret";

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> (Self, Value) {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        let hello = client.recv().await.expect("hello");
        assert_eq!(hello["op"], 10);
        client.send(json!({"op": 2, "d": {"token": token}})).await;
        let ready = client.wait_for("READY").await;
        (client, ready)
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
    }

    async fn voice(&mut self, channel: Option<&str>, self_mute: bool) {
        self.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": channel, "self_mute": self_mute, "self_deaf": false, "self_video": false}})).await;
    }

    async fn recv(&mut self) -> Result<Value, Option<u16>> {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return Ok(serde_json::from_str(&text).expect("json frame")),
                Ok(Some(Ok(Message::Close(frame)))) => return Err(frame.map(|frame| u16::from(frame.code))),
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => return Err(None),
                Err(_) => panic!("timed out waiting for a gateway frame"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.recv().await.unwrap_or_else(|code| panic!("closed ({code:?}) while waiting for {name}"));
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    /// The next VOICE_SERVER_UPDATE or VOICE_CONNECT_FAILED.
    async fn voice_answer(&mut self) -> (String, Value) {
        loop {
            let frame = self.recv().await.expect("voice answer");
            if frame["op"] == 0 && (frame["t"] == "VOICE_SERVER_UPDATE" || frame["t"] == "VOICE_CONNECT_FAILED") {
                return (frame["t"].as_str().expect("name").to_owned(), frame["d"].clone());
            }
        }
    }

    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            match next {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).expect("json");
                    if frame["t"] == name {
                        return false;
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
        true
    }
}

struct World {
    app: TestApp,
    rooms: Arc<FakeRoomService>,
    address: String,
    guild: String,
    voice: String,
    owner: String,
    alice: String,
    alice_id: String,
    carl: String,
    carl_id: String,
}

fn livekit(config: &mut Config) {
    config.livekit = Some(LiveKitConfig { url: "wss://lk.test".into(), api_url: "http://127.0.0.1:9".into(), api_key: KEY.into(), api_secret: SECRET.into() });
}

async fn world_with(adjust: impl FnOnce(&mut Config), rooms: Arc<FakeRoomService>) -> World {
    let app = TestApp::with_room_service(adjust, rooms.clone()).await;
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (carl, carl_user) = app.register("carl").await;
    let (guild, text) = app.guild_with_channel(&owner).await;
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &owner).await;
    let voice = channels.as_array().expect("channels").iter().find(|c| c["type"] == 2).expect("General voice channel")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{text}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    for token in [&alice, &carl] {
        let (status, _) = app.post(&format!("/invites/{code}"), token, json!({})).await;
        assert_eq!(status, StatusCode::OK);
    }
    let id = |user: &Value| user["id"].as_str().expect("id").to_owned();
    World { app, rooms, address, guild, voice, owner, alice, alice_id: id(&alice_user), carl, carl_id: id(&carl_user) }
}

async fn world() -> World {
    world_with(livekit, FakeRoomService::new()).await
}

impl World {
    async fn overwrite(&self, target: &str, kind: u8, deny: u64) {
        let (status, body) = self
            .app
            .put_json(&format!("/channels/{}/permissions/{target}", self.voice), &self.owner, json!({"type": kind, "allow": "0", "deny": deny.to_string()}))
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }

    async fn clear_overwrite(&self, target: &str) {
        let (status, _) = self.app.delete(&format!("/channels/{}/permissions/{target}", self.voice), &self.owner).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    /// POSTs a webhook body signed with `secret`.
    async fn webhook(&self, body: Value, secret: &str) -> StatusCode {
        let bytes = body.to_string();
        let claims = token::Claims {
            iss: KEY.into(),
            exp: vokko_server::voice::unix_now() + 60,
            sha256: Some(token::body_hash(bytes.as_bytes())),
            ..Default::default()
        };
        let authorization = token::sign(secret, &claims).expect("sign");
        let request = Request::post("/internal/livekit/webhook")
            .header("authorization", authorization)
            .header("content-type", "application/webhook+json")
            .body(Body::from(bytes))
            .expect("request");
        self.app.router.clone().oneshot(request).await.expect("response").status()
    }

    fn participant(&self, user_id: &str, session_id: &str, nonce: &str) -> Value {
        json!({"sid": format!("PA_{session_id}_{nonce}"), "identity": user_id, "metadata": json!({"session_id": session_id, "token": nonce}).to_string()})
    }

    /// Nonce of the user's latest token (as LiveKit would echo it in the participant metadata).
    fn nonce(&self, user_id: &str) -> String {
        self.app.state.voice.get(user_id.parse().expect("id")).map(|entry| entry.token_nonce).unwrap_or_default()
    }

    async fn event(&self, event: &str, participant: Value) -> StatusCode {
        self.webhook(json!({"event": event, "room": {"name": self.room()}, "participant": participant}), SECRET).await
    }

    fn room(&self) -> String {
        format!("v{}", self.voice)
    }
}

/// {CONNECT, SPEAK, STREAM} × {allowed, denied by a role overwrite, denied by a member overwrite} → token grants.
#[tokio::test]
async fn token_grants_follow_the_permission_matrix() {
    let w = world().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let all_sources = ["microphone", "camera", "screen_share", "screen_share_audio"];
    for bit in [CONNECT, SPEAK, STREAM] {
        for target in [None, Some((w.guild.clone(), 0_u8)), Some((w.alice_id.clone(), 1_u8))] {
            if let Some((id, kind)) = &target {
                w.overwrite(id, *kind, bit).await;
            }
            alice.voice(Some(&w.voice), false).await;
            let (name, answer) = alice.voice_answer().await;
            let case = format!("bit {bit} denied by {target:?}");
            if bit == CONNECT && target.is_some() {
                assert_eq!((name.as_str(), answer["reason"].as_str()), ("VOICE_CONNECT_FAILED", Some("missing_permissions")), "{case}");
                assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).is_none(), "{case}: no state without CONNECT");
            } else {
                assert_eq!(name, "VOICE_SERVER_UPDATE", "{case}: {answer}");
                assert_eq!(answer["endpoint"], "wss://lk.test");
                let token = answer["token"].as_str().expect("token");
                let claims = token::verify(SECRET, token, vokko_server::voice::unix_now()).expect("signed with the API secret");
                assert_eq!((claims.iss.as_str(), claims.sub.as_str()), (KEY, w.alice_id.as_str()));
                let grant = claims.video.expect("video grant");
                assert_eq!(grant.room.as_deref(), Some(w.room().as_str()));
                assert!(grant.room_join && grant.can_subscribe && !grant.can_publish_data && !grant.can_update_own_metadata, "{case}");
                let expected: Vec<&str> = match (bit, target.is_some()) {
                    (SPEAK, true) => all_sources[1..].to_vec(),
                    (STREAM, true) => all_sources[..1].to_vec(),
                    _ => all_sources.to_vec(),
                };
                assert_eq!(grant.can_publish_sources, expected, "{case}");
                let state = alice.wait_for("VOICE_STATE_UPDATE").await;
                assert_eq!(state["suppress"], bit == SPEAK && target.is_some(), "{case}");
                alice.voice(None, false).await;
                assert!(alice.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
            }
            if let Some((id, _)) = &target {
                w.clear_overwrite(id).await;
            }
        }
    }
    // No token without VIEW_CHANNEL, or while timed out.
    w.overwrite(&w.alice_id, 1, VIEW_CHANNEL).await;
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(alice.voice_answer().await.1["reason"], "missing_permissions");
    w.clear_overwrite(&w.alice_id).await;
    let until = (time::OffsetDateTime::now_utc() + time::Duration::hours(1)).format(&time::format_description::well_known::Rfc3339).expect("format");
    let (status, _) = w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.alice_id), &w.owner, json!({"communication_disabled_until": until})).await;
    assert_eq!(status, StatusCode::OK);
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(alice.voice_answer().await.1["reason"], "timed_out");
}

#[tokio::test]
async fn join_is_broadcast_only_to_those_who_can_see_the_channel() {
    let w = world().await;
    w.overwrite(&w.carl_id, 1, VIEW_CHANNEL).await;
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), true).await;
    assert_eq!(alice.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let seen = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!(
        (seen["user_id"].as_str(), seen["channel_id"].as_str(), seen["guild_id"].as_str()),
        (Some(w.alice_id.as_str()), Some(w.voice.as_str()), Some(w.guild.as_str()))
    );
    assert_eq!((seen["self_mute"].as_bool(), seen["member"]["user"]["username"].as_str()), (Some(true), Some("alice")));
    assert!(carl.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(400)).await, "carl cannot see the channel");
    assert!(owner.silent_for("VOICE_SERVER_UPDATE", Duration::from_millis(200)).await, "the token goes to alice's session only");

    // READY carries the states of visible channels only.
    let (_, ready) = Client::identify(&w.address, &w.owner).await;
    let states = &ready["guilds"][0]["voice_states"];
    assert_eq!(states.as_array().map(Vec::len), Some(1), "{states}");
    assert_eq!(states[0]["user_id"].as_str(), Some(w.alice_id.as_str()));
    assert_eq!(ready["media"]["voice_enabled"], true);
    assert_eq!(ready["media"]["voice_bitrate_ceiling"], 128_000);
    let (_, carl_ready) = Client::identify(&w.address, &w.carl).await;
    assert_eq!(carl_ready["guilds"][0]["voice_states"], json!([]));

    // Self mute toggle from the same session: a state update, no new token.
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(owner.wait_for("VOICE_STATE_UPDATE").await["self_mute"], false);
    assert!(alice.silent_for("VOICE_SERVER_UPDATE", Duration::from_millis(300)).await);
    // The same op 4 again (a client reconnecting to LiveKit): a fresh token for the same binding, nothing broadcast.
    alice.voice(Some(&w.voice), false).await;
    let (name, answer) = alice.voice_answer().await;
    assert_eq!(name, "VOICE_SERVER_UPDATE");
    let claims = token::verify(SECRET, answer["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("signed");
    let metadata: Value = serde_json::from_str(&claims.metadata).expect("metadata");
    assert_eq!(metadata["session_id"], seen["session_id"], "same voice session");
    assert_eq!(answer["session_id"], seen["session_id"], "VOICE_SERVER_UPDATE names its session");
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn user_limit_and_bitrate() {
    let w = world().await;
    let path = format!("/channels/{}", w.voice);
    let (status, channel) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let voice = channel.as_array().expect("channels").iter().find(|c| c["type"] == 2).expect("voice").clone();
    assert_eq!((voice["bitrate"].as_u64(), voice["user_limit"].as_u64()), (Some(64_000), Some(0)), "defaults");
    let text = channel.as_array().expect("channels").iter().find(|c| c["type"] == 0).expect("text").clone();
    assert!(text.get("bitrate").is_none());
    assert_eq!(w.app.patch(&path, &w.owner, json!({"bitrate": 200_000})).await.0, StatusCode::BAD_REQUEST, "above the 128 kbps maximum");
    assert_eq!(w.app.patch(&format!("/channels/{}", text["id"].as_str().expect("id")), &w.owner, json!({"bitrate": 64_000})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&path, &w.alice, json!({"user_limit": 1})).await.0, StatusCode::FORBIDDEN, "needs MANAGE_CHANNELS");
    let (status, edited) = w.app.patch(&path, &w.owner, json!({"bitrate": 96_000, "user_limit": 1})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!((edited["bitrate"].as_u64(), edited["user_limit"].as_u64()), (Some(96_000), Some(1)));
    let (status, created) =
        w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "Lounge", "type": 2, "bitrate": 8000, "user_limit": 5})).await;
    assert_eq!((status, created["bitrate"].as_u64(), created["user_limit"].as_u64()), (StatusCode::OK, Some(8000), Some(5)));

    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(alice.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    carl.voice(Some(&w.voice), false).await;
    assert_eq!(carl.voice_answer().await.1["reason"], "channel_full");
    // MOVE_MEMBERS bypasses the limit.
    let (_, role) = w.app.post(&format!("/guilds/{}/roles", w.guild), &w.owner, json!({"name": "movers", "permissions": MOVE_MEMBERS.to_string()})).await;
    let role = role["id"].as_str().expect("role").to_owned();
    let (status, _) = w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.carl_id), &w.owner, json!({"roles": [role]})).await;
    assert_eq!(status, StatusCode::OK);
    carl.voice(Some(&w.voice), false).await;
    assert_eq!(carl.voice_answer().await.0, "VOICE_SERVER_UPDATE");
}

#[tokio::test]
async fn webhooks_are_signed_and_keyed_by_session() {
    let w = world().await;
    let alice_id: i64 = w.alice_id.parse().expect("id");
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut first, _) = Client::identify(&w.address, &w.alice).await;
    first.voice(Some(&w.voice), false).await;
    first.voice_answer().await;
    let first_session = first.wait_for("VOICE_STATE_UPDATE").await["session_id"].as_str().expect("session").to_owned();
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let first_nonce = w.nonce(&w.alice_id);

    let joined = json!({"event": "participant_joined", "room": {"name": w.room()}, "participant": w.participant(&w.alice_id, &first_session, &first_nonce)});
    assert_eq!(w.webhook(joined.clone(), "wrong-secret").await, StatusCode::UNAUTHORIZED);
    assert!(!w.app.state.voice.get(alice_id).expect("state").connected, "a forged webhook changes nothing");
    assert_eq!(w.webhook(joined, SECRET).await, StatusCode::OK);
    assert!(w.app.state.voice.get(alice_id).expect("state").connected);

    // A second gateway session (another device) joining moves the state; the old session sees the new session id.
    let (mut second, _) = Client::identify(&w.address, &w.alice).await;
    second.voice(Some(&w.voice), false).await;
    assert_eq!(second.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let moved = first.wait_for("VOICE_STATE_UPDATE").await;
    let second_session = moved["session_id"].as_str().expect("session").to_owned();
    assert_ne!(second_session, first_session);
    assert_eq!(moved["channel_id"].as_str(), Some(w.voice.as_str()));
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let second_nonce = w.nonce(&w.alice_id);

    // The old binding's participant_left (twice, and late) never drops the new state.
    let old_left = json!({"event": "participant_left", "room": {"name": w.room()}, "participant": w.participant(&w.alice_id, &first_session, &first_nonce)});
    for _ in 0..2 {
        assert_eq!(w.webhook(old_left.clone(), SECRET).await, StatusCode::OK);
    }
    assert_eq!(w.app.state.voice.get(alice_id).map(|entry| entry.session_id), Some(second_session.clone()));
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(300)).await);
    // The old device cannot disconnect the new one either.
    first.voice(None, false).await;
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(300)).await);
    assert!(w.app.state.voice.get(alice_id).is_some());

    let new_joined =
        json!({"event": "participant_joined", "room": {"name": w.room()}, "participant": w.participant(&w.alice_id, &second_session, &second_nonce)});
    assert_eq!(w.webhook(new_joined, SECRET).await, StatusCode::OK);
    let new_left = json!({"event": "participant_left", "room": {"name": w.room()}, "participant": w.participant(&w.alice_id, &second_session, &second_nonce)});
    assert_eq!(w.webhook(new_left, SECRET).await, StatusCode::OK);
    let gone = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert!(gone["channel_id"].is_null());
    assert_eq!(gone["session_id"].as_str(), Some(second_session.as_str()));
    assert!(w.app.state.voice.get(alice_id).is_none());

    // A participant nobody granted a place any more is removed from the room.
    let stale = json!({"event": "participant_joined", "room": {"name": w.room()}, "participant": w.participant(&w.alice_id, &first_session, &first_nonce)});
    assert_eq!(w.webhook(stale, SECRET).await, StatusCode::OK);
    assert!(w.rooms.calls().contains(&format!("RemoveParticipant {} {}", w.room(), w.alice_id)));
}

#[tokio::test]
async fn a_client_that_never_reaches_livekit_is_dropped() {
    let rooms = FakeRoomService::new();
    let w = world_with(
        |config| {
            livekit(config);
            config.voice_connect_timeout = Duration::from_millis(300);
        },
        rooms,
    )
    .await;
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    assert_eq!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].as_str(), Some(w.voice.as_str()));
    let dropped = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert!(dropped["channel_id"].is_null(), "{dropped}");
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).is_none());
}

#[tokio::test]
async fn a_lost_gateway_session_ends_voice_after_the_grace_period() {
    let w = world_with(
        |config| {
            livekit(config);
            config.voice_gateway_grace = Duration::from_millis(300);
        },
        FakeRoomService::new(),
    )
    .await;
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    drop(alice);
    let left = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert!(left["channel_id"].is_null(), "{left}");
}

#[tokio::test]
async fn restart_restores_states_from_livekit_without_leave_events() {
    let rooms = FakeRoomService::new();
    let w = world_with(livekit, rooms.clone()).await;
    let metadata = json!({"session_id": "restored"}).to_string();
    rooms.add_participant(&w.room(), Participant { sid: "PA_1".into(), identity: w.alice_id.clone(), metadata, tracks: Vec::new() });
    // An unknown room and a participant without Vokko metadata are ignored.
    rooms.add_participant("v1", Participant { identity: w.carl_id.clone(), metadata: "{}".into(), ..Participant::default() });
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    vokko_server::voice::restore(&w.app.state).await;
    let (_, ready) = Client::identify(&w.address, &w.carl).await;
    let states = ready["guilds"][0]["voice_states"].as_array().cloned().expect("voice_states");
    assert_eq!(states.len(), 1);
    assert_eq!((states[0]["user_id"].as_str(), states[0]["session_id"].as_str()), (Some(w.alice_id.as_str()), Some("restored")));
    assert_eq!(states[0]["self_mute"], true, "no live microphone track");
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(400)).await, "no leave events");
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).is_some(), "still within the grace period");

    // The client comes back and claims its state with op 4: re-bound in place, no leave in between.
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(alice.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let rebound = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!(rebound["channel_id"].as_str(), Some(w.voice.as_str()));
    assert_ne!(rebound["session_id"], "restored");
}

#[tokio::test]
async fn reconciliation_drops_states_livekit_lost() {
    let rooms = FakeRoomService::new();
    let w = world_with(livekit, rooms.clone()).await;
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    let session = owner.wait_for("VOICE_STATE_UPDATE").await["session_id"].as_str().expect("session").to_owned();
    // LiveKit lists the participant (a missed participant_joined webhook): reconciliation marks it connected.
    let metadata = json!({"session_id": session}).to_string();
    rooms.add_participant(&w.room(), Participant { sid: "PA_2".into(), identity: w.alice_id.clone(), metadata, tracks: Vec::new() });
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).expect("state").connected);
    // Then LiveKit loses it (a missed participant_left): the state ends.
    rooms.remove_participant(&w.room(), &w.alice_id).await.expect("fake");
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
}

#[tokio::test]
async fn voice_is_unavailable_without_livekit() {
    let w = world_with(|_| {}, FakeRoomService::new()).await;
    let (mut alice, ready) = Client::identify(&w.address, &w.alice).await;
    assert_eq!(ready["media"]["voice_enabled"], false);
    alice.voice(Some(&w.voice), false).await;
    let (name, answer) = alice.voice_answer().await;
    assert_eq!((name.as_str(), answer["reason"].as_str()), ("VOICE_CONNECT_FAILED", Some("media_unavailable")));
    let request = Request::post("/internal/livekit/webhook").body(Body::from("{}")).expect("request");
    assert_eq!(w.app.router.clone().oneshot(request).await.expect("response").status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn op_4_is_rate_limited() {
    let w = world().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    for round in 0..31 {
        alice.voice(Some(&w.voice), round % 2 == 0).await;
    }
    loop {
        match alice.recv().await {
            Ok(_) => continue,
            Err(code) => {
                assert_eq!(code, Some(4008));
                break;
            }
        }
    }
}

#[tokio::test]
async fn leaving_removes_from_livekit_before_anything_else_happens() {
    let w = world().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    alice.wait_for("VOICE_STATE_UPDATE").await;
    alice.voice(None, false).await;
    alice.voice(Some(&w.voice), false).await;
    assert!(alice.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
    // The removal was awaited before the leave was announced, so the rejoin's binding cannot be hit by it.
    let remove = format!("RemoveParticipant {} {}", w.room(), w.alice_id);
    assert_eq!(w.rooms.calls().iter().filter(|call| **call == remove).count(), 1);
    assert_eq!(alice.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    assert_eq!(w.rooms.calls().iter().filter(|call| **call == remove).count(), 1, "the rejoin is not removed");
}

#[tokio::test]
async fn concurrent_joins_cannot_overfill_a_channel() {
    let w = world().await;
    let (status, _) = w.app.patch(&format!("/channels/{}", w.voice), &w.owner, json!({"user_limit": 1})).await;
    assert_eq!(status, StatusCode::OK);
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    for _ in 0..5 {
        tokio::join!(alice.voice(Some(&w.voice), false), carl.voice(Some(&w.voice), false));
        let (a, c) = tokio::join!(alice.voice_answer(), carl.voice_answer());
        let joined = [&a, &c].iter().filter(|(name, _)| name == "VOICE_SERVER_UPDATE").count();
        assert_eq!(joined, 1, "exactly one gets the last slot: {a:?} {c:?}");
        alice.voice(None, false).await;
        carl.voice(None, false).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(w.app.state.voice.all().is_empty());
    }
}

#[tokio::test]
async fn deleting_the_channel_or_leaving_the_guild_ends_voice() {
    let w = world().await;
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let (status, _) = w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &w.alice).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
    assert!(w.app.state.voice.all().is_empty());
    assert!(w.rooms.calls().contains(&format!("RemoveParticipant {} {}", w.room(), w.alice_id)));

    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    carl.voice(Some(&w.voice), false).await;
    carl.voice_answer().await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let (status, _) = w.app.delete(&format!("/channels/{}", w.voice), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    assert!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
    assert!(w.app.state.voice.all().is_empty(), "no state lingers in a deleted channel");
    assert!(w.rooms.calls().contains(&format!("RemoveParticipant {} {}", w.room(), w.carl_id)));
}

/// A reconnect reissues the token for the same session: the old connection leaving, before or after the new one joins, never
/// ends the state; only the latest token's events count.
#[tokio::test]
async fn a_reconnects_old_connection_leaving_never_ends_the_state() {
    let w = world().await;
    let alice_id: i64 = w.alice_id.parse().expect("id");
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    let session = owner.wait_for("VOICE_STATE_UPDATE").await["session_id"].as_str().expect("session").to_owned();
    for left_first in [true, false] {
        let old = w.nonce(&w.alice_id);
        assert_eq!(w.event("participant_joined", w.participant(&w.alice_id, &session, &old)).await, StatusCode::OK);
        assert!(w.app.state.voice.get(alice_id).expect("state").connected);
        // Same op 4 again: a fresh token for the same session.
        alice.voice(Some(&w.voice), false).await;
        let (name, answer) = alice.voice_answer().await;
        assert_eq!((name.as_str(), answer["session_id"].as_str()), ("VOICE_SERVER_UPDATE", Some(session.as_str())));
        let new = w.nonce(&w.alice_id);
        assert_ne!(new, old);
        let old_left = w.participant(&w.alice_id, &session, &old);
        let new_joined = w.participant(&w.alice_id, &session, &new);
        if left_first {
            assert_eq!(w.event("participant_left", old_left).await, StatusCode::OK);
            assert_eq!(w.event("participant_joined", new_joined).await, StatusCode::OK);
        } else {
            assert_eq!(w.event("participant_joined", new_joined).await, StatusCode::OK);
            assert_eq!(w.event("participant_left", old_left).await, StatusCode::OK);
        }
        let entry = w.app.state.voice.get(alice_id).expect("the state survives the old connection leaving");
        assert!(entry.connected && entry.session_id == session, "left_first={left_first}");
        assert!(!w.rooms.calls().iter().any(|call| call.starts_with("RemoveParticipant")), "nobody was kicked");
        assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(200)).await);
    }
    // The latest token's own leave still ends it.
    let latest = w.nonce(&w.alice_id);
    assert_eq!(w.event("participant_left", w.participant(&w.alice_id, &session, &latest)).await, StatusCode::OK);
    assert!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
}

/// Reconciliation removes LiveKit participants that match no voice state (e.g. a kick whose RemoveParticipant failed), and
/// spares users with a fresh binding.
#[tokio::test]
async fn reconciliation_removes_orphaned_livekit_participants() {
    let rooms = FakeRoomService::new();
    let w = world_with(livekit, rooms.clone()).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    let session = alice.wait_for("VOICE_STATE_UPDATE").await["session_id"].as_str().expect("session").to_owned();
    let nonce = w.nonce(&w.alice_id);
    let metadata = |session: &str, nonce: &str| json!({"session_id": session, "token": nonce}).to_string();
    // alice is where her state says; carl has no state at all (his kick's removal failed); alice also lingers in another room
    // from before her fresh binding.
    rooms
        .add_participant(&w.room(), Participant { sid: "PA_a".into(), identity: w.alice_id.clone(), metadata: metadata(&session, &nonce), tracks: Vec::new() });
    rooms.add_participant(&w.room(), Participant { sid: "PA_c".into(), identity: w.carl_id.clone(), metadata: metadata("gone", "x"), tracks: Vec::new() });
    rooms.add_participant("v77", Participant { sid: "PA_old".into(), identity: w.alice_id.clone(), metadata: metadata("older", "y"), tracks: Vec::new() });
    vokko_server::voice::reconcile(&w.app.state).await;
    let calls = w.rooms.calls();
    assert!(calls.contains(&format!("RemoveParticipant {} {}", w.room(), w.carl_id)), "{calls:?}");
    assert!(!calls.iter().any(|call| call.ends_with(&format!(" {}", w.alice_id))), "alice is spared: {calls:?}");
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).expect("state").connected, "and marked connected");
}

#[tokio::test]
async fn voice_channel_status_is_shared_and_cleared_when_the_channel_empties() {
    use vokko_protocol::api::permissions::SET_VOICE_CHANNEL_STATUS;
    let w = world().await;
    w.overwrite(&w.carl_id, 1, VIEW_CHANNEL).await;
    let path = format!("/channels/{}/voice-status", w.voice);
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;

    assert_eq!(w.app.put_json(&path, &w.alice, json!({"status": "hi"})).await.0, StatusCode::FORBIDDEN, "no permission");
    let (_, role) =
        w.app.post(&format!("/guilds/{}/roles", w.guild), &w.owner, json!({"name": "status", "permissions": SET_VOICE_CHANNEL_STATUS.to_string()})).await;
    let role = role["id"].as_str().expect("role").to_owned();
    w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.alice_id), &w.owner, json!({"roles": [role]})).await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"status": "hi"})).await.0, StatusCode::FORBIDDEN, "only while connected there");
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"status": "x".repeat(501)})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"status": " Raid night "})).await.0, StatusCode::NO_CONTENT);
    let update = owner.wait_for("VOICE_CHANNEL_STATUS_UPDATE").await;
    assert_eq!(update, json!({"id": w.voice, "guild_id": w.guild, "status": "Raid night"}));
    assert!(carl.silent_for("VOICE_CHANNEL_STATUS_UPDATE", Duration::from_millis(300)).await, "carl cannot see the channel");
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.owner).await;
    let voice = channels.as_array().expect("channels").iter().find(|c| c["id"] == w.voice.as_str()).expect("voice").clone();
    assert_eq!(voice["status"], "Raid night");
    let text = channels.as_array().expect("channels").iter().find(|c| c["type"] == 0).expect("text").clone();
    assert!(text.get("status").is_none());
    assert_eq!(
        w.app.put_json(&format!("/channels/{}/voice-status", text["id"].as_str().expect("id")), &w.owner, json!({"status": "x"})).await.0,
        StatusCode::BAD_REQUEST
    );

    // The last one out clears it.
    alice.voice(None, false).await;
    assert!(owner.wait_for("VOICE_CHANNEL_STATUS_UPDATE").await["status"].is_null());
    // MANAGE_CHANNELS sets it without being connected.
    assert_eq!(w.app.put_json(&path, &w.owner, json!({"status": "Later"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(owner.wait_for("VOICE_CHANNEL_STATUS_UPDATE").await["status"], "Later");
    assert_eq!(w.app.state.voice.serial_entries(), 0, "per-user locks are pruned once released");
}

/// A join that arrives while a channel is being deleted waits for the deletion and then fails, instead of inserting a state
/// into a channel that is gone.
#[tokio::test]
async fn a_join_cannot_slip_in_while_its_channel_is_deleted() {
    let w = world().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let channel_id: i64 = w.voice.parse().expect("id");
    let eviction = vokko_server::voice::state::channel_deleted(&w.app.state, channel_id).await;
    alice.voice(Some(&w.voice), false).await;
    assert!(alice.silent_for("VOICE_SERVER_UPDATE", Duration::from_millis(300)).await, "the join waits for the eviction");
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(channel_id).execute(&w.app.state.db).await.expect("delete");
    drop(eviction);
    let (name, answer) = alice.voice_answer().await;
    assert_eq!((name.as_str(), answer["reason"].as_str()), ("VOICE_CONNECT_FAILED", Some("missing_permissions")));
    assert!(w.app.state.voice.all().is_empty());
}
