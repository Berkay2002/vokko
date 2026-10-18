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
            match tokio::time::timeout(common::WAIT, self.ws.next()).await {
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
    config.livekit = vec![LiveKitConfig {
        url: "wss://lk.test".into(),
        api_url: "http://127.0.0.1:9".into(),
        api_key: KEY.into(),
        api_secret: SECRET.into(),
        label: "test".into(),
    }];
}

async fn world_with(adjust: impl FnOnce(&mut Config), rooms: Arc<FakeRoomService>) -> World {
    world_over(adjust, vec![rooms.clone()], rooms).await
}

/// One RoomService per LiveKit backend; `rooms` (the first backend's fake) is the one `World` reports on.
async fn world_over(adjust: impl FnOnce(&mut Config), backends: Vec<Arc<dyn RoomService>>, rooms: Arc<FakeRoomService>) -> World {
    let app = TestApp::with_room_services(adjust, backends).await;
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
        self.webhook_as(body, KEY, secret).await
    }

    /// POSTs a webhook body from the LiveKit backend with API key `key`.
    async fn webhook_as(&self, body: Value, key: &str, secret: &str) -> StatusCode {
        let bytes = body.to_string();
        let claims = token::Claims {
            iss: key.into(),
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
    let (name, answer) = alice.voice_answer().await;
    assert_eq!(name, "VOICE_SERVER_UPDATE");
    assert_eq!(answer["bitrate"], 64_000, "an unedited channel publishes at the default bitrate");
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
    // The channel's bitrate (Channel Settings) is the microphone's max bitrate on the next token.
    let (status, _) = w.app.patch(&format!("/channels/{}", w.voice), &w.owner, json!({"bitrate": 96_000})).await;
    assert_eq!(status, StatusCode::OK);
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(alice.voice_answer().await.1["bitrate"], 96_000);
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
    vokko_server::voice::restore(&w.app.state).await.expect("restore");
    let (_, ready) = Client::identify(&w.address, &w.carl).await;
    let states = ready["guilds"][0]["voice_states"].as_array().cloned().expect("voice_states");
    assert_eq!(states.len(), 1);
    assert_eq!((states[0]["user_id"].as_str(), states[0]["session_id"].as_str()), (Some(w.alice_id.as_str()), Some("restored")));
    assert_eq!(states[0]["self_mute"], true, "no live microphone track");
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(400)).await, "no leave events");
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).is_some(), "still within the grace period");

    // The client comes back and claims its state with op 4: re-bound in place with the same voice session and no token, so its
    // LiveKit connection stays; no leave in between.
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    let rebound = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((rebound["channel_id"].as_str(), rebound["session_id"].as_str()), (Some(w.voice.as_str()), Some("restored")));
    assert_eq!(rebound["self_mute"], false, "the client's own mute replaces the guess from LiveKit");
    assert!(alice.silent_for("VOICE_SERVER_UPDATE", Duration::from_millis(300)).await, "no new token: the room is kept");
    let entry = w.app.state.voice.get(w.alice_id.parse().expect("id")).expect("claimed");
    assert!(entry.unbound_since.is_none() && entry.gateway_session.is_some());
    // A client that lost LiveKit meanwhile asks again on its new session: a fresh token for the same voice session.
    alice.voice(Some(&w.voice), false).await;
    let (name, answer) = alice.voice_answer().await;
    assert_eq!((name.as_str(), answer["session_id"].as_str()), ("VOICE_SERVER_UPDATE", Some("restored")));
}

#[tokio::test]
async fn a_re_identified_client_keeps_its_voice_session_without_a_new_token() {
    let w = world_with(
        |config| {
            livekit(config);
            config.voice_gateway_grace = Duration::from_millis(300);
        },
        FakeRoomService::new(),
    )
    .await;
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, ready) = Client::identify(&w.address, &w.alice).await;
    let gateway = ready["session_id"].as_str().expect("gateway session").to_owned();
    let (session, _) = join(&mut alice, &w.voice).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let nonce = w.nonce(&w.alice_id);
    assert_eq!(w.event("participant_joined", w.participant(&w.alice_id, &session, &nonce)).await, StatusCode::OK);

    // The gateway drops and the client identifies again (its old session could not be resumed): same channel, op 4.
    drop(alice);
    while w.app.state.hub.session(&gateway).is_some_and(|old| old.detached_for().is_none()) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    assert_eq!(owner.wait_for("VOICE_STATE_UPDATE").await["session_id"].as_str(), Some(session.as_str()));
    assert!(alice.silent_for("VOICE_SERVER_UPDATE", Duration::from_millis(100)).await, "no new token");
    assert_eq!(w.nonce(&w.alice_id), nonce, "the live connection's token still counts");
    // The old gateway session's grace period passes: the state belongs to the new one now.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(100)).await, "no leave");
    let entry = w.app.state.voice.get(w.alice_id.parse().expect("id")).expect("still in voice");
    assert!(entry.connected && entry.session_id == session);
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
    vokko_server::voice::restore(&w.app.state).await.expect("restore");
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
async fn watch_together_syncs_the_people_in_the_channel_and_ends_when_it_empties() {
    let w = world().await;
    w.overwrite(&w.carl_id, 1, VIEW_CHANNEL).await;
    let path = format!("/channels/{}/watch-together", w.voice);
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;

    assert_eq!(w.app.put_json(&path, &w.alice, json!({"video_id": "dQw4w9WgXcQ"})).await.0, StatusCode::FORBIDDEN, "not in the voice channel");
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    for bad in ["short", "dQw4w9WgXc!", "dQw4w9WgXcQQ", ""] {
        assert_eq!(w.app.put_json(&path, &w.alice, json!({"video_id": bad})).await.0, StatusCode::BAD_REQUEST, "{bad:?}");
    }
    assert_eq!(w.app.patch(&path, &w.alice, json!({"playing": false})).await.0, StatusCode::BAD_REQUEST, "nothing is playing yet");

    let (status, state) = w.app.put_json(&path, &w.alice, json!({"video_id": "dQw4w9WgXcQ", "title": " Never "})).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!((state["video_id"].as_str(), state["title"].as_str(), state["playing"].as_bool()), (Some("dQw4w9WgXcQ"), Some("Never"), Some(true)));
    assert_eq!(
        (state["position_ms"].as_u64(), state["started_by"].as_str(), state["queue"].as_array().map(Vec::len)),
        (Some(0), Some(w.alice_id.as_str()), Some(0))
    );
    assert!(state["updated_at_ms"].as_i64().is_some_and(|ms| ms > 0));
    let update = owner.wait_for("WATCH_TOGETHER_UPDATE").await;
    assert_eq!((update["channel_id"].as_str(), update["state"]["video_id"].as_str()), (Some(w.voice.as_str()), Some("dQw4w9WgXcQ")));
    assert!(carl.silent_for("WATCH_TOGETHER_UPDATE", Duration::from_millis(300)).await, "carl cannot see the channel");

    // Pause at 42 s, bad requests, queue and skip.
    let (_, paused) = w.app.patch(&path, &w.alice, json!({"playing": false, "position_ms": 42_000})).await;
    assert_eq!((paused["playing"].as_bool(), paused["position_ms"].as_u64()), (Some(false), Some(42_000)));
    assert_eq!(owner.wait_for("WATCH_TOGETHER_UPDATE").await["state"]["playing"], false);
    assert_eq!(w.app.patch(&path, &w.alice, json!({"position_ms": 86_400_001_u64})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&path, &w.alice, json!({"queue_add": "nope"})).await.0, StatusCode::BAD_REQUEST);
    let (_, resumed) = w.app.patch(&path, &w.alice, json!({"playing": true})).await;
    assert_eq!(resumed["position_ms"], 42_000, "playing again resumes where it paused");
    w.app.patch(&path, &w.alice, json!({"queue_add": "aaaaaaaaaaa"})).await;
    let (_, queued) = w.app.patch(&path, &w.alice, json!({"queue_add": "bbbbbbbbbbb"})).await;
    assert_eq!(queued["queue"], json!(["aaaaaaaaaaa", "bbbbbbbbbbb"]));
    let (_, stale) = w.app.patch(&path, &w.alice, json!({"skip": true, "video_id": "ccccccccccc"})).await;
    assert_eq!(stale["video_id"], "dQw4w9WgXcQ", "a skip for a video that is no longer current does nothing");
    let (_, skipped) = w.app.patch(&path, &w.alice, json!({"skip": true, "video_id": "dQw4w9WgXcQ"})).await;
    assert_eq!(
        (skipped["video_id"].as_str(), skipped["position_ms"].as_u64(), skipped["queue"].as_array().map(Vec::len)),
        (Some("aaaaaaaaaaa"), Some(0), Some(1))
    );
    for n in 0..19 {
        let (status, _) = w.app.patch(&path, &w.alice, json!({"queue_add": format!("q{n:010}")})).await;
        assert_eq!(status, StatusCode::OK, "{n}");
    }
    assert_eq!(w.app.patch(&path, &w.alice, json!({"queue_add": "zzzzzzzzzzz"})).await.0, StatusCode::BAD_REQUEST, "the queue holds 20");

    // Changing the video keeps the queue; a late joiner gets the running session right after the voice server update.
    let (_, changed) = w.app.put_json(&path, &w.alice, json!({"video_id": "eeeeeeeeeee"})).await;
    assert_eq!((changed["queue"].as_array().map(Vec::len), changed["started_by"].as_str()), (Some(20), Some(w.alice_id.as_str())));
    owner.voice(Some(&w.voice), false).await;
    owner.voice_answer().await;
    let late = loop {
        let update = owner.wait_for("WATCH_TOGETHER_UPDATE").await;
        if update["state"]["video_id"] == "eeeeeeeeeee" && update["state"]["playing"] == true {
            break update;
        }
    };
    assert_eq!(late["channel_id"], w.voice.as_str());
    let channels = std::collections::HashSet::from([w.voice.parse::<i64>().expect("id")]);
    assert_eq!(w.app.state.voice.watch_in(&channels).len(), 1, "READY and GUILD_CREATE carry it for viewers");

    // Stopping by hand ends it; so does the last person leaving.
    assert_eq!(w.app.delete(&path, &w.owner).await.0, StatusCode::NO_CONTENT);
    assert!(owner.wait_for("WATCH_TOGETHER_UPDATE").await["state"].is_null());
    w.app.put_json(&path, &w.owner, json!({"video_id": "dQw4w9WgXcQ"})).await;
    owner.wait_for("WATCH_TOGETHER_UPDATE").await;
    alice.voice(None, false).await;
    assert!(owner.silent_for("WATCH_TOGETHER_UPDATE", Duration::from_millis(300)).await, "owner is still inside");
    owner.voice(None, false).await;
    assert!(owner.wait_for("WATCH_TOGETHER_UPDATE").await["state"].is_null());
    assert!(w.app.state.voice.watch_get(w.voice.parse().expect("id")).is_none());
    assert_eq!(w.app.patch(&path, &w.owner, json!({"playing": false})).await.0, StatusCode::FORBIDDEN, "no longer in voice");
}

/// Losing access ends the voice state, and a request-time check backs that up (the DM block case, where the call stays, is in
/// dm_calls.rs): neither a deny overwrite nor a timeout leaves anyone steering the video.
#[tokio::test]
async fn watch_together_needs_access_that_is_still_valid() {
    let w = world().await;
    let path = format!("/channels/{}/watch-together", w.voice);
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"video_id": "dQw4w9WgXcQ"})).await.0, StatusCode::OK);
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"video_id": "dQw4w9WgXcQ", "title": "zero\u{200B}width"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&path, &w.alice, json!({"title": "a\u{202E}b"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&path, &w.alice, json!({"title": "a\nb"})).await.0, StatusCode::BAD_REQUEST);

    // A deny overwrite for VIEW_CHANNEL + CONNECT while the voice state stays.
    w.overwrite(&w.alice_id, 1, VIEW_CHANNEL | CONNECT).await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"video_id": "aaaaaaaaaaa"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.patch(&path, &w.alice, json!({"playing": false})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&path, &w.alice).await.0, StatusCode::FORBIDDEN);
    w.clear_overwrite(&w.alice_id).await;
    // (The overwrite also ended her voice state, so she joins again.)
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"video_id": "dQw4w9WgXcQ"})).await.0, StatusCode::OK);

    // A timed-out member is refused like on join.
    let until = vokko_server::store::iso(time::OffsetDateTime::now_utc() + time::Duration::days(1));
    let (status, body) = w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.alice_id), &w.owner, json!({"communication_disabled_until": until})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(w.app.patch(&path, &w.alice, json!({"playing": true})).await.0, StatusCode::FORBIDDEN, "timed out");
}

#[tokio::test]
async fn watch_together_controls_are_rate_limited_per_user() {
    let w = world_with(
        |config| {
            livekit(config);
            config.rate_limit = Some(Default::default());
        },
        FakeRoomService::new(),
    )
    .await;
    let path = format!("/channels/{}/watch-together", w.voice);
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    alice.voice(Some(&w.voice), false).await;
    alice.voice_answer().await;
    w.app.state.limiter.freeze_clock(); // sequential requests on a busy machine would refill the bucket as they go
    let mut codes = Vec::new();
    for _ in 0..14 {
        codes.push(w.app.put_json(&path, &w.alice, json!({"video_id": "dQw4w9WgXcQ"})).await.0);
    }
    assert_eq!(codes[0], StatusCode::OK);
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS), "a burst past 10 is limited: {codes:?}");
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

// ---- Voice follow-ups (docs/cloud/voice-followups.md, part A) ----

impl World {
    async fn channel_overwrite(&self, channel: &str, target: &str, kind: u8, deny: u64) {
        let body = json!({"type": kind, "allow": "0", "deny": deny.to_string()});
        let (status, body) = self.app.put_json(&format!("/channels/{channel}/permissions/{target}"), &self.owner, body).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }

    async fn create_channel(&self, name: &str, kind: u8) -> String {
        let (status, created) = self.app.post(&format!("/guilds/{}/channels", self.guild), &self.owner, json!({"name": name, "type": kind})).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        created["id"].as_str().expect("id").to_owned()
    }

    async fn edit_member(&self, token: &str, user: &str, body: Value) -> (StatusCode, Value) {
        self.app.patch(&format!("/guilds/{}/members/{user}", self.guild), token, body).await
    }

    fn calls_with(&self, prefix: &str) -> Vec<String> {
        self.rooms.calls().into_iter().filter(|call| call.starts_with(prefix)).collect()
    }
}

/// Joins `channel`, returns (session_id, token claims).
async fn join(client: &mut Client, channel: &str) -> (String, token::Claims) {
    client.voice(Some(channel), false).await;
    let (name, answer) = client.voice_answer().await;
    assert_eq!(name, "VOICE_SERVER_UPDATE", "{answer}");
    let claims = token::verify(SECRET, answer["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("signed");
    (answer["session_id"].as_str().expect("session").to_owned(), claims)
}

/// A restore that cannot reach LiveKit is retried with backoff, and until one succeeds reconciliation kicks nobody.
#[tokio::test]
async fn an_unreachable_livekit_at_start_is_retried_and_nobody_is_kicked_meanwhile() {
    let rooms = FakeRoomService::new();
    let w = world_with(
        |config| {
            livekit(config);
            config.voice_restore_backoff = Duration::from_millis(30);
        },
        rooms.clone(),
    )
    .await;
    let metadata = json!({"session_id": "live", "token": "n"}).to_string();
    rooms.add_participant(&w.room(), Participant { sid: "PA_c".into(), identity: w.carl_id.clone(), metadata, tracks: Vec::new() });
    rooms.fail_lists(1);
    assert!(vokko_server::voice::restore(&w.app.state).await.is_err());
    assert!(!w.app.state.voice.restored());
    // LiveKit answers again, but the table was never rebuilt: carl looks like an orphan and must be left alone.
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(w.calls_with("RemoveParticipant").is_empty(), "{:?}", w.rooms.calls());

    rooms.fail_lists(2);
    let lists_before = w.calls_with("ListRooms").len();
    tokio::time::timeout(common::WAIT, vokko_server::voice::restore_with_retry(&w.app.state)).await.expect("restore finishes");
    assert_eq!(w.calls_with("ListRooms").len() - lists_before, 3, "two failures, then success");
    assert!(w.app.state.voice.restored());
    let carl = w.app.state.voice.get(w.carl_id.parse().expect("id")).expect("carl restored");
    assert_eq!(carl.session_id, "live");
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(w.calls_with("RemoveParticipant").is_empty(), "a restored participant is not an orphan");
}

/// A token reissued (and connected) between reconciliation's LiveKit listing and its removal keeps the state.
#[tokio::test]
async fn a_token_reissued_during_reconciliation_keeps_its_state() {
    let rooms = FakeRoomService::new();
    let w = world_with(livekit, rooms.clone()).await;
    let alice_id: i64 = w.alice_id.parse().expect("id");
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (session, _) = join(&mut alice, &w.voice).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let first = w.nonce(&w.alice_id);
    assert_eq!(w.event("participant_joined", w.participant(&w.alice_id, &session, &first)).await, StatusCode::OK);

    // LiveKit's listing (taken while alice reconnects) does not show her.
    let release = rooms.hold_next_list();
    let state = w.app.state.clone();
    let reconciling = tokio::spawn(async move { vokko_server::voice::reconcile(&state).await });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (again, _) = join(&mut alice, &w.voice).await;
    assert_eq!(again, session);
    let second = w.nonce(&w.alice_id);
    assert_ne!(second, first);
    assert_eq!(w.event("participant_joined", w.participant(&w.alice_id, &session, &second)).await, StatusCode::OK);
    release.send(()).expect("reconcile waits");
    reconciling.await.expect("reconcile");
    let entry = w.app.state.voice.get(alice_id).expect("the reissued binding survives");
    assert_eq!((entry.token_nonce.as_str(), entry.connected), (second.as_str(), true));
    assert!(owner.silent_for("VOICE_STATE_UPDATE", Duration::from_millis(300)).await);
}

/// Losing CONNECT or VIEW_CHANNEL (overwrite, role edit), or a timeout, ends the call and removes the participant; losing SPEAK
/// only narrows the LiveKit grant.
#[tokio::test]
async fn permission_changes_evict_or_narrow_mid_call() {
    use vokko_protocol::api::permissions::DEFAULT_EVERYONE;
    let w = world().await;
    let room = w.room();
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;

    // SPEAK denied by an overwrite: still in the call, microphone gone from the grant, suppress broadcast.
    join(&mut alice, &w.voice).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    w.overwrite(&w.alice_id, 1, SPEAK).await;
    let narrowed = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((narrowed["channel_id"].as_str(), narrowed["suppress"].as_bool()), (Some(w.voice.as_str()), Some(true)));
    let update = format!("UpdateParticipant {room} {} sources=camera,screen_share,screen_share_audio subscribe=true hidden=false", w.alice_id);
    assert!(w.rooms.calls().contains(&update), "{:?}", w.rooms.calls());
    assert!(w.calls_with("RemoveParticipant").is_empty());
    // CONNECT denied: out.
    w.overwrite(&w.alice_id, 1, SPEAK | CONNECT).await;
    assert!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
    assert!(w.rooms.calls().contains(&format!("RemoveParticipant {room} {}", w.alice_id)));
    w.clear_overwrite(&w.alice_id).await;

    // CONNECT only through a role: editing the role ends carl's call.
    let (status, _) =
        w.app.patch(&format!("/guilds/{}/roles/{}", w.guild, w.guild), &w.owner, json!({"permissions": (DEFAULT_EVERYONE & !CONNECT).to_string()})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, role) = w.app.post(&format!("/guilds/{}/roles", w.guild), &w.owner, json!({"name": "voice", "permissions": CONNECT.to_string()})).await;
    let role = role["id"].as_str().expect("role").to_owned();
    assert_eq!(w.edit_member(&w.owner, &w.carl_id, json!({"roles": [role.clone()]})).await.0, StatusCode::OK);
    join(&mut carl, &w.voice).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let (status, _) = w.app.patch(&format!("/guilds/{}/roles/{role}", w.guild), &w.owner, json!({"permissions": "0"})).await;
    assert_eq!(status, StatusCode::OK);
    let gone = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((gone["user_id"].as_str(), gone["channel_id"].is_null()), (Some(w.carl_id.as_str()), true));
    assert!(w.rooms.calls().contains(&format!("RemoveParticipant {room} {}", w.carl_id)));

    // A timeout ends the call too.
    let (status, _) = w.app.patch(&format!("/guilds/{}/roles/{}", w.guild, w.guild), &w.owner, json!({"permissions": DEFAULT_EVERYONE.to_string()})).await;
    assert_eq!(status, StatusCode::OK);
    join(&mut alice, &w.voice).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let until = (time::OffsetDateTime::now_utc() + time::Duration::hours(1)).format(&time::format_description::well_known::Rfc3339).expect("format");
    assert_eq!(w.edit_member(&w.owner, &w.alice_id, json!({"communication_disabled_until": until})).await.0, StatusCode::OK);
    assert!(owner.wait_for("VOICE_STATE_UPDATE").await["channel_id"].is_null());
    assert!(w.app.state.voice.all().is_empty());
}

#[tokio::test]
async fn voice_status_is_rate_limited_per_channel() {
    use vokko_server::config::RateLimit;
    let w = world_with(
        |config| {
            livekit(config);
            config.rate_limit =
                Some(RateLimit { route_burst: 1000.0, route_per_second: 1000.0, global_burst: 1000.0, global_per_second: 1000.0, ..RateLimit::default() });
        },
        FakeRoomService::new(),
    )
    .await;
    let path = format!("/channels/{}/voice-status", w.voice);
    w.app.state.limiter.freeze_clock(); // ten slow requests would refill the bucket as they go
    for round in 0..10 {
        assert_eq!(w.app.put_json(&path, &w.owner, json!({"status": format!("s{round}")})).await.0, StatusCode::NO_CONTENT);
    }
    let (status, body) = w.app.put_json(&path, &w.owner, json!({"status": "one too many"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(body["retry_after"].as_f64().expect("retry_after") > 0.0);
    // Another channel has its own bucket.
    let other = w.create_channel("Lounge", 2).await;
    assert_eq!(w.app.put_json(&format!("/channels/{other}/voice-status"), &w.owner, json!({"status": "x"})).await.0, StatusCode::NO_CONTENT);
}

/// Server mute / deafen through LiveKit permissions (persisted across rejoin), move with a fresh token, disconnect.
#[tokio::test]
async fn server_mute_deafen_move_and_disconnect() {
    let rooms = FakeRoomService::new();
    let w = world_with(livekit, rooms.clone()).await;
    let room = w.room();
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (session, _) = join(&mut alice, &w.voice).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let tracks = vec![vokko_server::voice::livekit::TrackInfo { sid: "TR_mic".into(), source: "MICROPHONE".into(), muted: false }];
    let metadata = json!({"session_id": session, "token": w.nonce(&w.alice_id)}).to_string();
    rooms.add_participant(&room, Participant { sid: "PA_a".into(), identity: w.alice_id.clone(), metadata, tracks });

    // Only MUTE_MEMBERS / DEAFEN_MEMBERS / MOVE_MEMBERS holders.
    assert_eq!(w.edit_member(&w.carl, &w.alice_id, json!({"mute": true})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.edit_member(&w.carl, &w.alice_id, json!({"deaf": true})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.edit_member(&w.carl, &w.alice_id, json!({"channel_id": null})).await.0, StatusCode::FORBIDDEN);

    let (status, member) = w.edit_member(&w.owner, &w.alice_id, json!({"mute": true})).await;
    assert_eq!((status, member["mute"].as_bool()), (StatusCode::OK, Some(true)));
    let muted = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((muted["mute"].as_bool(), muted["deaf"].as_bool()), (Some(true), Some(false)));
    let update = format!("UpdateParticipant {room} {} sources=camera,screen_share,screen_share_audio subscribe=true hidden=false", w.alice_id);
    assert!(rooms.calls().contains(&update), "{:?}", rooms.calls());
    assert!(rooms.calls().contains(&format!("MutePublishedTrack {room} {} TR_mic", w.alice_id)));
    assert_eq!(owner.wait_for("GUILD_MEMBER_UPDATE").await["mute"], true);

    let (status, _) = w.edit_member(&w.owner, &w.alice_id, json!({"deaf": true})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(owner.wait_for("VOICE_STATE_UPDATE").await["deaf"], true);
    assert!(w.calls_with("UpdateParticipant").last().is_some_and(|call| call.contains("subscribe=false")));

    // Persisted: a rejoin gets a token without the microphone and without subscribing.
    alice.voice(None, false).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    let (_, claims) = join(&mut alice, &w.voice).await;
    let grant = claims.video.expect("grant");
    assert!(!grant.can_publish_sources.contains(&"microphone".to_owned()) && !grant.can_subscribe);
    let rejoined = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((rejoined["mute"].as_bool(), rejoined["deaf"].as_bool()), (Some(true), Some(true)));
    let (status, _) = w.edit_member(&w.owner, &w.alice_id, json!({"mute": false, "deaf": false})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(owner.wait_for("VOICE_STATE_UPDATE").await["mute"], false);
    assert!(w.calls_with("UpdateParticipant").last().is_some_and(|call| call.contains("sources=microphone,") && call.contains("subscribe=true")));

    // Move: same voice session, a fresh token for the new room on alice's session, the old room left.
    let lounge = w.create_channel("Lounge", 2).await;
    let session = w.app.state.voice.get(w.alice_id.parse().expect("id")).expect("state").session_id;
    assert_eq!(w.edit_member(&w.owner, &w.carl_id, json!({"channel_id": lounge})).await.1["code"], 40032, "carl is not in voice");
    let (status, _) = w.edit_member(&w.owner, &w.alice_id, json!({"channel_id": lounge})).await;
    assert_eq!(status, StatusCode::OK);
    let (name, answer) = alice.voice_answer().await;
    assert_eq!(
        (name.as_str(), answer["channel_id"].as_str(), answer["session_id"].as_str()),
        ("VOICE_SERVER_UPDATE", Some(lounge.as_str()), Some(session.as_str()))
    );
    let claims = token::verify(SECRET, answer["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("signed");
    assert_eq!(claims.video.and_then(|grant| grant.room), Some(format!("v{lounge}")));
    let moved = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((moved["channel_id"].as_str(), moved["session_id"].as_str()), (Some(lounge.as_str()), Some(session.as_str())));
    assert!(rooms.calls().contains(&format!("RemoveParticipant {room} {}", w.alice_id)));
    // Not into a channel she cannot connect to.
    w.channel_overwrite(&w.voice, &w.alice_id, 1, CONNECT).await;
    assert_eq!(w.edit_member(&w.owner, &w.alice_id, json!({"channel_id": w.voice})).await.0, StatusCode::FORBIDDEN);
    // Disconnect.
    let (status, _) = w.edit_member(&w.owner, &w.alice_id, json!({"channel_id": null})).await;
    assert_eq!(status, StatusCode::OK);
    let left = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert!(left["channel_id"].is_null(), "{left}");
    assert!(w.app.state.voice.all().is_empty());
}

// ---- Stage channels (part B) ----

#[tokio::test]
async fn stage_audience_raise_hand_invite_and_end() {
    let rooms = FakeRoomService::new();
    let w = world_with(livekit, rooms.clone()).await;
    let stage = w.create_channel("Town Hall", 13).await;
    let stage_room = format!("v{stage}");
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;

    // Everyone joins as audience: no publish source, hidden.
    let (_, claims) = join(&mut alice, &stage).await;
    let grant = claims.video.expect("grant");
    assert!(grant.can_publish_sources.is_empty() && !grant.can_publish && grant.hidden && grant.can_subscribe, "{grant:?}");
    assert_eq!(owner.wait_for("VOICE_STATE_UPDATE").await["suppress"], true);

    // Only stage moderators start a stage.
    let create = json!({"channel_id": stage, "topic": "  Weekly sync  "});
    assert_eq!(w.app.post("/stage-instances", &w.alice, create.clone()).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.post("/stage-instances", &w.owner, json!({"channel_id": stage, "topic": "x".repeat(121)})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.post("/stage-instances", &w.owner, json!({"channel_id": w.voice, "topic": "no"})).await.0, StatusCode::BAD_REQUEST);
    let (status, instance) = w.app.post("/stage-instances", &w.owner, create.clone()).await;
    assert_eq!((status, instance["topic"].as_str(), instance["privacy_level"].as_u64()), (StatusCode::OK, Some("Weekly sync"), Some(2)));
    assert_eq!(alice.wait_for("STAGE_INSTANCE_CREATE").await, instance);
    assert_eq!(w.app.post("/stage-instances", &w.owner, create).await.1["code"], 150006);
    assert_eq!(w.app.get(&format!("/stage-instances/{stage}"), &w.carl).await.1, instance);
    let (_, ready) = Client::identify(&w.address, &w.carl).await;
    assert_eq!(ready["guilds"][0]["stage_instances"], json!([instance]));
    let (status, edited) = w.app.patch(&format!("/stage-instances/{stage}"), &w.owner, json!({"topic": "Renamed"})).await;
    assert_eq!((status, edited["topic"].as_str()), (StatusCode::OK, Some("Renamed")));
    assert_eq!(alice.wait_for("STAGE_INSTANCE_UPDATE").await["topic"], "Renamed");

    // Raise hand (REQUEST_TO_SPEAK), but no self-promotion without moderator rights.
    let me = format!("/guilds/{}/voice-states/@me", w.guild);
    let raised = w.app.patch(&me, &w.alice, json!({"channel_id": stage, "request_to_speak_timestamp": "2020-01-01T00:00:00Z"})).await;
    assert_eq!(raised.0, StatusCode::NO_CONTENT, "{}", raised.1);
    let hand = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert!(hand["request_to_speak_timestamp"].as_str().is_some_and(|at| !at.starts_with("2020")), "the server's clock: {hand}");
    assert_eq!(w.app.patch(&me, &w.alice, json!({"channel_id": stage, "suppress": false})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.patch(&me, &w.carl, json!({"channel_id": stage, "request_to_speak_timestamp": null})).await.1["code"], 40032, "carl is not there");
    let alice_path = format!("/guilds/{}/voice-states/{}", w.guild, w.alice_id);
    assert_eq!(w.app.patch(&alice_path, &w.carl, json!({"channel_id": stage, "suppress": false})).await.0, StatusCode::FORBIDDEN);

    // A moderator invites her to speak: microphone (and STREAM sources), visible, hand lowered.
    assert_eq!(w.app.patch(&alice_path, &w.owner, json!({"channel_id": stage, "suppress": false})).await.0, StatusCode::NO_CONTENT);
    let speaker = owner.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((speaker["suppress"].as_bool(), speaker["request_to_speak_timestamp"].is_null()), (Some(false), true));
    let promoted =
        format!("UpdateParticipant {stage_room} {} sources=microphone,camera,screen_share,screen_share_audio subscribe=true hidden=false", w.alice_id);
    assert!(rooms.calls().contains(&promoted), "{:?}", rooms.calls());

    // The owner (a moderator) joins and leaves: the last moderator gone ends the stage, speakers go back to the audience.
    join(&mut owner, &stage).await;
    owner.wait_for("VOICE_STATE_UPDATE").await;
    owner.voice(None, false).await;
    assert_eq!(carl.wait_for("STAGE_INSTANCE_DELETE").await["channel_id"].as_str(), Some(stage.as_str()));
    loop {
        let update = carl.wait_for("VOICE_STATE_UPDATE").await;
        if update["user_id"] == w.alice_id.as_str() {
            assert_eq!(update["suppress"], true);
            break;
        }
    }
    let demoted = format!("UpdateParticipant {stage_room} {} sources= subscribe=true hidden=true", w.alice_id);
    assert!(rooms.calls().contains(&demoted), "{:?}", rooms.calls());
    assert_eq!(w.app.get(&format!("/stage-instances/{stage}"), &w.alice).await.1["code"], 10067);

    // End Stage from the menu: DELETE.
    let (status, _) = w.app.post("/stage-instances", &w.owner, json!({"channel_id": stage, "topic": "Again"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(w.app.delete(&format!("/stage-instances/{stage}"), &w.alice).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/stage-instances/{stage}"), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(carl.wait_for("STAGE_INSTANCE_DELETE").await["topic"], "Again");
}

// ---- multiple LiveKit backends with failover ----

const KEY_2: &str = "second";
const SECRET_2: &str = "second-secret";

/// Backend 0 is `livekit()`'s, backend 1 is another project at `wss://lk2.test`; the cooldown is short enough to wait out.
async fn two_backends() -> (World, Arc<FakeRoomService>) {
    let second = FakeRoomService::new();
    let first = FakeRoomService::new();
    let w = world_over(
        |config| {
            livekit(config);
            config.livekit.push(LiveKitConfig {
                url: "wss://lk2.test".into(),
                api_url: "http://127.0.0.1:9".into(),
                api_key: KEY_2.into(),
                api_secret: SECRET_2.into(),
                label: "second".into(),
            });
            config.voice_backend_cooldown = Duration::from_millis(600);
        },
        vec![first.clone(), second.clone()],
        first,
    )
    .await;
    (w, second)
}

/// Joins and returns (endpoint, claims of the token verified with the secret of the backend the endpoint names).
async fn join_on(client: &mut Client, channel: &str) -> (String, token::Claims) {
    client.voice(Some(channel), false).await;
    let (name, answer) = client.voice_answer().await;
    assert_eq!(name, "VOICE_SERVER_UPDATE", "{answer}");
    let endpoint = answer["endpoint"].as_str().expect("endpoint").to_owned();
    let secret = if endpoint == "wss://lk2.test" { SECRET_2 } else { SECRET };
    let claims = token::verify(secret, answer["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("signed with that backend's secret");
    (endpoint, claims)
}

#[tokio::test]
async fn a_quota_error_sends_new_rooms_to_the_next_backend_and_live_rooms_stay_put() {
    let (w, second) = two_backends().await;
    let first = w.rooms.clone();
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    let (endpoint, claims) = join_on(&mut alice, &w.voice).await;
    assert_eq!((endpoint.as_str(), claims.iss.as_str()), ("wss://lk.test", KEY), "the first backend while it is healthy");

    // The first project runs out of quota: reconciliation's calls learn it.
    first.fail_api(429, r#"{"code":"resource_exhausted","msg":"quota"}"#);
    vokko_server::voice::reconcile(&w.app.state).await;
    // The live room stays where it is: carl joins alice's room, on the first backend.
    let (endpoint, claims) = join_on(&mut carl, &w.voice).await;
    assert_eq!((endpoint.as_str(), claims.iss.as_str()), ("wss://lk.test", KEY));
    // Once the room is empty, the next join starts a new room on the second backend: its URL, key and secret.
    for client in [&mut alice, &mut carl] {
        client.voice(None, false).await;
        client.wait_for("VOICE_STATE_UPDATE").await;
    }
    let (endpoint, claims) = join_on(&mut alice, &w.voice).await;
    assert_eq!((endpoint.as_str(), claims.iss.as_str()), ("wss://lk2.test", KEY_2));
    assert_eq!(claims.video.and_then(|grant| grant.room), Some(w.room()));
    assert_eq!(w.app.state.voice.get(w.alice_id.parse().expect("id")).map(|entry| entry.backend), Some(1));

    // The first project is back and its cooldown is over, but the room does not move: carl joins alice's room on the second.
    first.heal();
    tokio::time::sleep(Duration::from_millis(700)).await;
    vokko_server::voice::reconcile(&w.app.state).await;
    let (endpoint, claims) = join_on(&mut carl, &w.voice).await;
    assert_eq!((endpoint.as_str(), claims.iss.as_str()), ("wss://lk2.test", KEY_2));

    // Moderation calls go to the room's backend only.
    let before = first.calls().len();
    let (status, _) = w.edit_member(&w.owner, &w.alice_id, json!({"mute": true})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(second.calls().iter().any(|call| call.starts_with("UpdateParticipant")), "{:?}", second.calls());
    assert!(first.calls()[before..].iter().all(|call| !call.starts_with("UpdateParticipant")), "{:?}", first.calls());

    // Both leave; with the first backend in rotation again, the next new room is back on it.
    for client in [&mut alice, &mut carl] {
        client.voice(None, false).await;
    }
    let deadline = tokio::time::Instant::now() + common::WAIT;
    while tokio::time::Instant::now() < deadline {
        if w.app.state.voice.all().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let (endpoint, _) = join_on(&mut alice, &w.voice).await;
    assert_eq!(endpoint, "wss://lk.test");
}

#[tokio::test]
async fn webhooks_belong_to_the_backend_that_signed_them() {
    let (w, _second) = two_backends().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    w.rooms.fail_api(403, r#"{"code":"permission_denied"}"#);
    vokko_server::voice::reconcile(&w.app.state).await;
    let (endpoint, _) = join_on(&mut alice, &w.voice).await;
    assert_eq!(endpoint, "wss://lk2.test");
    let session = w.app.state.voice.get(w.alice_id.parse().expect("id")).expect("state").session_id;
    let joined = json!({"event": "participant_joined", "room": {"name": w.room()}, "participant": w.participant(&w.alice_id, &session, &w.nonce(&w.alice_id))});
    let connected = || w.app.state.voice.get(w.alice_id.parse().expect("id")).is_some_and(|entry| entry.connected);

    assert_eq!(w.webhook_as(joined.clone(), "third", "third-secret").await, StatusCode::UNAUTHORIZED, "a key no backend has");
    assert_eq!(w.webhook_as(joined.clone(), KEY_2, SECRET).await, StatusCode::UNAUTHORIZED, "the second key signed with the first secret");
    assert!(!connected());
    // The first backend's webhook about this channel: not where the room lives, so the state is not touched ...
    assert_eq!(w.webhook_as(joined.clone(), KEY, SECRET).await, StatusCode::OK);
    assert!(!connected());
    assert_eq!(w.webhook_as(json!({"event": "room_finished", "room": {"name": w.room()}}), KEY, SECRET).await, StatusCode::OK);
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).is_some());
    // ... and the second's is.
    assert_eq!(w.webhook_as(joined, KEY_2, SECRET_2).await, StatusCode::OK);
    assert!(connected());
    assert_eq!(w.webhook_as(json!({"event": "room_finished", "room": {"name": w.room()}}), KEY_2, SECRET_2).await, StatusCode::OK);
    assert!(w.app.state.voice.get(w.alice_id.parse().expect("id")).is_none());
}

#[tokio::test]
async fn a_restart_rebuilds_the_rooms_backends_from_every_backend() {
    let (w, second) = two_backends().await;
    // Carl was in this channel's room on the second backend when the server stopped.
    let metadata = json!({"session_id": "live", "token": "n"}).to_string();
    second.add_participant(&w.room(), Participant { sid: "PA_c".into(), identity: w.carl_id.clone(), metadata, tracks: Vec::new() });
    vokko_server::voice::restore(&w.app.state).await.expect("both backends restore");
    assert_eq!(w.app.state.voice.get(w.carl_id.parse().expect("id")).map(|entry| entry.backend), Some(1));
    assert!(w.app.state.voice.restored());
    // Alice joins the same channel: the first backend is healthy, but the room is on the second.
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (endpoint, claims) = join_on(&mut alice, &w.voice).await;
    assert_eq!((endpoint.as_str(), claims.iss.as_str()), ("wss://lk2.test", KEY_2));
    // An orphan listed on the first backend is removed there; the second backend's participants are not touched.
    let first = w.rooms.clone();
    let metadata = json!({"session_id": "stale", "token": "n"}).to_string();
    first.add_participant(&w.room(), Participant { sid: "PA_s".into(), identity: "424242".into(), metadata, tracks: Vec::new() });
    vokko_server::voice::reconcile(&w.app.state).await;
    assert_eq!(w.calls_with("RemoveParticipant"), [format!("RemoveParticipant {} 424242", w.room())]);
    assert!(second.calls().iter().all(|call| !call.starts_with("RemoveParticipant")), "{:?}", second.calls());
}

/// One unreachable backend does not keep the other one from being restored (nor its calls from being reconciled).
#[tokio::test]
async fn an_unreachable_backend_does_not_block_restoring_the_others() {
    let (w, second) = two_backends().await;
    let metadata = json!({"session_id": "live", "token": "n"}).to_string();
    w.rooms.add_participant(&w.room(), Participant { sid: "PA_c".into(), identity: w.carl_id.clone(), metadata, tracks: Vec::new() });
    second.fail_lists(1);
    assert!(vokko_server::voice::restore(&w.app.state).await.is_err());
    assert!(w.app.state.voice.get(w.carl_id.parse().expect("id")).is_some(), "the first backend was restored");
    assert!(!w.app.state.voice.restored(), "the second was not");
    vokko_server::voice::restore(&w.app.state).await.expect("the second answers now");
    assert!(w.app.state.voice.restored());
    assert_eq!(w.calls_with("ListRooms").len(), 1, "the first backend is not restored twice");
}

/// A backend that restores late must not re-insert participants of a room that already lives on another backend.
#[tokio::test]
async fn a_late_backend_restore_does_not_split_a_live_call() {
    let (w, second) = two_backends().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (endpoint, _) = join_on(&mut alice, &w.voice).await;
    assert_eq!(endpoint, "wss://lk.test");
    // The second backend still lists carl in a leftover room for the same channel.
    let metadata = json!({"session_id": "old", "token": "n"}).to_string();
    second.add_participant(&w.room(), Participant { sid: "PA_c".into(), identity: w.carl_id.clone(), metadata, tracks: Vec::new() });
    vokko_server::voice::restore(&w.app.state).await.expect("both backends restore");
    assert!(w.app.state.voice.get(w.carl_id.parse().expect("id")).is_none(), "carl's room is on the first backend: nothing to restore");
    assert!(w.app.state.voice.all().iter().all(|entry| entry.backend == 0));
    // Reconciliation removes him from the late backend, so his client rejoins the live room.
    vokko_server::voice::reconcile(&w.app.state).await;
    assert!(second.calls().contains(&format!("RemoveParticipant {} {}", w.room(), w.carl_id)), "{:?}", second.calls());
}

/// A backend whose listing fails with a quota error is not asked about its rooms again during the same pass.
#[tokio::test]
async fn reconciliation_skips_the_rooms_of_a_backend_that_is_out_of_quota() {
    let (w, _second) = two_backends().await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    join_on(&mut alice, &w.voice).await;
    let first = w.rooms.clone();
    first.fail_api(429, r#"{"code":"resource_exhausted"}"#);
    let before = first.calls().len();
    vokko_server::voice::reconcile(&w.app.state).await;
    let calls = first.calls();
    assert_eq!(&calls[before..], ["ListRooms"], "the listing failed, so no ListParticipants per room: {calls:?}");
}

/// The next WATCH_TOGETHER_UPDATE whose state passes `done`.
async fn watch_until(client: &mut Client, done: impl Fn(&Value) -> bool) -> Value {
    loop {
        let update = client.wait_for("WATCH_TOGETHER_UPDATE").await;
        if done(&update["state"]) {
            return update["state"].clone();
        }
    }
}

/// docs/design/bot-control.md: by default everyone in the call steers; with CONTROL_MEDIA denied to @everyone in the channel only
/// the host, administrators and holders do, and everyone else votes, skips what they added and queues up to 3.
#[tokio::test]
async fn watch_together_without_control_media_votes_skips_and_queues_within_a_quota() {
    use vokko_protocol::api::permissions::CONTROL_MEDIA;
    let w = world().await;
    let path = format!("/channels/{}/watch-together", w.voice);
    let (mut owner, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl, _) = Client::identify(&w.address, &w.carl).await;
    for client in [&mut owner, &mut alice, &mut carl] {
        client.voice(Some(&w.voice), false).await;
        client.voice_answer().await;
    }
    let (status, state) = w.app.put_json(&path, &w.owner, json!({"video_id": "dQw4w9WgXcQ"})).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    let owner_id = state["started_by"].as_str().expect("owner id").to_owned();
    assert_eq!(
        (state["host_id"].as_str(), state["added_by"].as_str(), state["skip_votes"].clone(), state["skip_needed"].as_u64()),
        (Some(owner_id.as_str()), Some(owner_id.as_str()), json!([]), Some(2))
    );
    assert_eq!(w.app.patch(&path, &w.carl, json!({"playing": false})).await.0, StatusCode::OK, "the default: everyone controls");

    // DJ mode in this channel.
    w.overwrite(&w.guild, 0, CONTROL_MEDIA).await;
    for (body, what) in [(json!({"playing": true}), "play"), (json!({"position_ms": 5}), "seek")] {
        assert_eq!(w.app.patch(&path, &w.carl, body).await.0, StatusCode::FORBIDDEN, "{what}");
    }
    assert_eq!(w.app.put_json(&path, &w.carl, json!({"video_id": "eeeeeeeeeee"})).await.0, StatusCode::FORBIDDEN, "replace");
    assert_eq!(w.app.delete(&path, &w.carl).await.0, StatusCode::FORBIDDEN, "stop");
    assert_eq!(w.app.patch(&path, &w.owner, json!({"playing": true})).await.0, StatusCode::OK, "an administrator");
    // A member overwrite granting the bit makes carl a controller.
    let grant = json!({"type": 1, "allow": CONTROL_MEDIA.to_string(), "deny": "0"});
    assert_eq!(w.app.put_json(&format!("/channels/{}/permissions/{}", w.voice, w.carl_id), &w.owner, grant).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.patch(&path, &w.carl, json!({"playing": true})).await.0, StatusCode::OK, "granted");
    w.clear_overwrite(&w.carl_id).await;
    assert_eq!(w.app.patch(&path, &w.carl, json!({"playing": true})).await.0, StatusCode::FORBIDDEN, "revoked");

    // Anyone fills in a missing title; replacing it is a controller's (a second auto-fill changes nothing).
    assert_eq!(w.app.patch(&path, &w.carl, json!({"title": "Auto"})).await.1["title"], "Auto");
    assert_eq!(w.app.patch(&path, &w.alice, json!({"title": "Other"})).await.1["title"], "Auto");

    // Three entries each for non-controllers; controllers only meet the queue max.
    for video in ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"] {
        assert_eq!(w.app.patch(&path, &w.carl, json!({"queue_add": video})).await.0, StatusCode::OK, "{video}");
    }
    let (status, body) = w.app.patch(&path, &w.carl, json!({"queue_add": "fffffffffff"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("queue_add"), "{body}");
    let (_, queued) = w.app.patch(&path, &w.alice, json!({"queue_add": "ddddddddddd"})).await;
    assert_eq!(queued["queue_added_by"], json!([w.carl_id, w.carl_id, w.carl_id, w.alice_id]));

    // Anyone takes back their own entry, controllers any; someone else's is 403 and a stale index changes nothing.
    let remove = |index: usize, video: &str| json!({"queue_remove": {"index": index, "video_id": video}});
    w.app.patch(&path, &w.owner, json!({"queue_add": "eeeeeeeeeee"})).await;
    assert_eq!(w.app.patch(&path, &w.carl, remove(3, "ddddddddddd")).await.0, StatusCode::FORBIDDEN, "alice's entry");
    for (index, video) in [(4, "ddddddddddd"), (9, "ddddddddddd")] {
        let (status, state) = w.app.patch(&path, &w.carl, remove(index, video)).await;
        assert_eq!((status, state["queue"].as_array().map(Vec::len)), (StatusCode::OK, Some(5)), "stale {index}");
    }
    let (_, removed) = w.app.patch(&path, &w.alice, remove(3, "ddddddddddd")).await;
    assert_eq!(
        (removed["queue"].clone(), removed["queue_added_by"].clone()),
        (json!(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "eeeeeeeeeee"]), json!([w.carl_id, w.carl_id, w.carl_id, owner_id]))
    );
    w.app.patch(&path, &w.alice, json!({"queue_add": "ddddddddddd"})).await;
    let (_, removed) = w.app.patch(&path, &w.owner, remove(3, "eeeeeeeeeee")).await;
    assert_eq!(removed["queue_added_by"], json!([w.carl_id, w.carl_id, w.carl_id, w.alice_id]), "a controller removes anyone's");

    // Votes: 3 listeners need 2; a withdrawn vote goes; the second vote skips and clears the votes.
    let (_, voted) = w.app.patch(&path, &w.carl, json!({"skip": true})).await;
    assert_eq!((voted["video_id"].as_str(), voted["skip_votes"].clone(), voted["skip_needed"].as_u64()), (Some("dQw4w9WgXcQ"), json!([w.carl_id]), Some(2)));
    assert_eq!(w.app.patch(&path, &w.carl, json!({"skip": false})).await.1["skip_votes"], json!([]));
    w.app.patch(&path, &w.carl, json!({"skip": true})).await;
    let (_, skipped) = w.app.patch(&path, &w.alice, json!({"skip": true, "video_id": "dQw4w9WgXcQ"})).await;
    assert_eq!(
        (skipped["video_id"].as_str(), skipped["added_by"].as_str(), skipped["skip_votes"].clone()),
        (Some("aaaaaaaaaaa"), Some(w.carl_id.as_str()), json!([]))
    );

    // Whoever added the current video skips it at once; a vote naming an old video does nothing.
    assert_eq!(w.app.patch(&path, &w.carl, json!({"skip": true})).await.1["video_id"], "bbbbbbbbbbb");
    assert_eq!(w.app.patch(&path, &w.alice, json!({"skip": true, "video_id": "aaaaaaaaaaa"})).await.1["skip_votes"], json!([]));
    assert_eq!(w.app.patch(&path, &w.alice, json!({"skip": true, "video_id": "bbbbbbbbbbb"})).await.1["skip_votes"], json!([w.alice_id]));

    // Carl deafens: 2 listeners need 1, so alice's vote is enough.
    carl.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": w.voice, "self_mute": true, "self_deaf": true, "self_video": false}})).await;
    let after = watch_until(&mut owner, |state| state["video_id"] == "ccccccccccc").await;
    assert_eq!((after["skip_votes"].clone(), after["skip_needed"].as_u64()), (json!([]), Some(1)));
    carl.voice(Some(&w.voice), false).await;
    watch_until(&mut owner, |state| state["skip_needed"] == 2).await;

    // The host leaves: alice (in the call longest) hosts, and 2 listeners make her standing vote enough.
    w.app.patch(&path, &w.alice, json!({"skip": true})).await;
    owner.voice(None, false).await;
    let moved = watch_until(&mut alice, |state| state["video_id"] == "ddddddddddd").await;
    assert_eq!((moved["host_id"].as_str(), moved["started_by"].as_str()), (Some(w.alice_id.as_str()), Some(owner_id.as_str())));
    assert_eq!(w.app.patch(&path, &w.alice, json!({"playing": false})).await.0, StatusCode::OK, "the host controls");
    assert_eq!(w.app.patch(&path, &w.carl, json!({"playing": true})).await.0, StatusCode::FORBIDDEN);

    // A vote that skips the last video ends the session.
    let (status, ended) = w.app.patch(&path, &w.carl, json!({"skip": true})).await;
    assert_eq!((status, ended), (StatusCode::OK, Value::Null));
    watch_until(&mut alice, Value::is_null).await;
}
