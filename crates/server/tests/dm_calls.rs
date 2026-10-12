#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! DM and group DM calls (docs/api.md "DM calls"): ringing, the ring timeout, block rules, the call message lifecycle and the
//! participant cap, over the gateway against a fake LiveKit RoomService.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use vokko_server::config::{Config, LiveKitConfig};
use vokko_server::voice::livekit::FakeRoomService;
use vokko_server::voice::token;

const SECRET: &str = "test-secret";

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.send(json!({"op": 2, "d": {"token": token}})).await;
        client.wait_for("READY").await;
        client
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
    }

    async fn voice(&mut self, channel: Option<&str>) {
        self.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": channel, "self_mute": false, "self_deaf": false, "self_video": false}})).await;
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        self.wait_until(name, |_| true).await
    }

    async fn wait_until(&mut self, name: &str, matches: impl Fn(&Value) -> bool) -> Value {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.unwrap_or_else(|_| panic!("timed out waiting for {name}"));
            let Some(Ok(Message::Text(text))) = next else { continue };
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            if frame["op"] == 0 && frame["t"] == name && matches(&frame["d"]) {
                return frame["d"].clone();
            }
        }
    }

    /// The next VOICE_SERVER_UPDATE or VOICE_CONNECT_FAILED.
    async fn voice_answer(&mut self) -> (String, Value) {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.expect("voice answer in time");
            let Some(Ok(Message::Text(text))) = next else { continue };
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            if frame["t"] == "VOICE_SERVER_UPDATE" || frame["t"] == "VOICE_CONNECT_FAILED" {
                return (frame["t"].as_str().expect("name").to_owned(), frame["d"].clone());
            }
        }
    }
}

struct User {
    token: String,
    id: String,
}

fn livekit(config: &mut Config) {
    config.livekit =
        Some(LiveKitConfig { url: "wss://lk.test".into(), api_url: "http://127.0.0.1:9".into(), api_key: "vokko".into(), api_secret: SECRET.into() });
}

async fn app_with(adjust: impl FnOnce(&mut Config)) -> (TestApp, String) {
    let app = TestApp::with_room_service(
        |config| {
            livekit(config);
            adjust(config);
        },
        FakeRoomService::new(),
    )
    .await;
    let address = app.serve().await;
    (app, address)
}

async fn user(app: &TestApp, name: &str) -> User {
    let (token, user) = app.register(name).await;
    User { token, id: user["id"].as_str().expect("id").to_owned() }
}

async fn befriend(app: &TestApp, a: &User, b: &User) {
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", b.id), &a.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", a.id), &b.token).await.0, StatusCode::NO_CONTENT);
}

async fn dm(app: &TestApp, from: &User, to: &User) -> String {
    let (status, channel) = app.post("/users/@me/channels", &from.token, json!({"recipient_id": to.id})).await;
    assert_eq!(status, StatusCode::OK, "{channel}");
    channel["id"].as_str().expect("id").to_owned()
}

async fn messages(app: &TestApp, channel: &str, token: &str) -> Value {
    app.get(&format!("/channels/{channel}/messages"), token).await.1
}

#[tokio::test]
async fn joining_a_dm_starts_a_call_that_rings_and_stops_ringing() {
    let (app, address) = app_with(|_| {}).await;
    let (alice, bob) = (user(&app, "alice").await, user(&app, "bob").await);
    befriend(&app, &alice, &bob).await;
    let channel = dm(&app, &alice, &bob).await;
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;

    alice_ws.voice(Some(&channel)).await;
    let (name, server) = alice_ws.voice_answer().await;
    assert_eq!((name.as_str(), &server["guild_id"]), ("VOICE_SERVER_UPDATE", &Value::Null), "{server}");
    let claims = token::verify(SECRET, server["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("token");
    let grant = claims.video.expect("grant");
    assert_eq!(grant.room.as_deref(), Some(format!("v{channel}").as_str()));
    assert_eq!(grant.can_publish_sources, ["microphone", "camera", "screen_share", "screen_share_audio"], "no Nitro gates in DM calls");

    // Bob's closed DM reopens with the call message, then the call rings him.
    assert_eq!(bob_ws.wait_for("CHANNEL_CREATE").await["id"], channel.as_str());
    let created = bob_ws.wait_for("MESSAGE_CREATE").await;
    assert_eq!((created["type"].as_u64(), created["author"]["id"].as_str()), (Some(3), Some(alice.id.as_str())));
    assert_eq!(created["call"], json!({"participants": [alice.id], "ended_timestamp": null}));
    let call = bob_ws.wait_for("CALL_CREATE").await;
    assert_eq!((call["channel_id"].as_str(), call["message_id"].as_str()), (Some(channel.as_str()), created["id"].as_str()));
    assert_eq!((&call["ringing"], &call["region"]), (&json!([bob.id]), &Value::Null));
    assert_eq!(call["voice_states"][0]["user_id"], alice.id.as_str());
    assert_eq!(call["voice_states"][0]["guild_id"], Value::Null);
    let state = bob_ws.wait_for("VOICE_STATE_UPDATE").await;
    assert_eq!((state["channel_id"].as_str(), &state["guild_id"]), (Some(channel.as_str()), &Value::Null));

    // Decline, ring again, region.
    assert_eq!(app.post(&format!("/channels/{channel}/call/stop-ringing"), &bob.token, json!({})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(bob_ws.wait_for("CALL_UPDATE").await["ringing"], json!([]));
    assert_eq!(app.post(&format!("/channels/{channel}/call/ring"), &alice.token, json!({})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(bob_ws.wait_for("CALL_UPDATE").await["ringing"], json!([bob.id]));
    let (status, _) = app.patch(&format!("/channels/{channel}/call"), &alice.token, json!({"region": "Not A Region"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(app.patch(&format!("/channels/{channel}/call"), &bob.token, json!({"region": "eu-north"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(bob_ws.wait_for("CALL_UPDATE").await["region"], "eu-north");
    // Bob cannot stop ringing for others from outside the call; strangers' ids are refused.
    let (status, body) = app.post(&format!("/channels/{channel}/call/stop-ringing"), &bob.token, json!({"recipients": [alice.id]})).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, _) = app.post(&format!("/channels/{channel}/call/ring"), &alice.token, json!({"recipients": ["1"]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Only people in the call can ring.
    let (status, body) = app.post(&format!("/channels/{channel}/call/ring"), &bob.token, json!({})).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));

    // Bob answers: participant added, ringing stops.
    bob_ws.voice(Some(&channel)).await;
    assert_eq!(bob_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let updated = alice_ws.wait_for("MESSAGE_UPDATE").await;
    assert_eq!(updated["call"]["participants"], json!([alice.id, bob.id]));
    assert_eq!(alice_ws.wait_for("CALL_UPDATE").await["ringing"], json!([]));
    assert!(app.state.voice.calls.ringing(channel.parse().expect("id")).is_empty());

    // Somebody reconnecting gets the ongoing call right after READY.
    let mut again = Client::identify(&address, &bob.token).await;
    let call = again.wait_for("CALL_CREATE").await;
    assert_eq!(call["voice_states"].as_array().map(Vec::len), Some(2));

    // Bob hangs up; ringing him again works even though he was in the call before.
    bob_ws.voice(None).await;
    for _ in 0..100 {
        if app.state.voice.get(bob.id.parse().expect("id")).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(app.post(&format!("/channels/{channel}/call/ring"), &alice.token, json!({})).await.0, StatusCode::NO_CONTENT);
    // (Bob's own answer left a CALL_UPDATE with nobody ringing in his queue: read until the ring shows up.)
    let mut rung = false;
    for _ in 0..4 {
        if bob_ws.wait_for("CALL_UPDATE").await["ringing"] == json!([bob.id]) {
            rung = true;
            break;
        }
    }
    assert!(rung, "bob is rung again");
}

#[tokio::test]
async fn an_open_call_row_unknown_to_memory_is_adopted_instead_of_starting_a_second_call() {
    let (app, address) = app_with(|_| {}).await;
    let (alice, bob) = (user(&app, "alice").await, user(&app, "bob").await);
    befriend(&app, &alice, &bob).await;
    let channel = dm(&app, &alice, &bob).await;
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;

    alice_ws.voice(Some(&channel)).await;
    assert_eq!(alice_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let first = bob_ws.wait_for("CALL_CREATE").await["message_id"].as_str().expect("message id").to_owned();
    alice_ws.voice(None).await;
    bob_ws.wait_for("CALL_DELETE").await;
    // A failed end write (or a restart race) leaves the row open while the in-memory call is gone.
    sqlx::query("UPDATE message_calls SET ended_at = NULL WHERE message_id = $1")
        .bind(first.parse::<i64>().expect("id"))
        .execute(&app.state.db)
        .await
        .expect("reopen");

    alice_ws.voice(Some(&channel)).await;
    assert_eq!(alice_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    assert_eq!(bob_ws.wait_for("CALL_CREATE").await["message_id"], first.as_str(), "the open call is adopted");
    let stored = messages(&app, &channel, &bob.token).await;
    assert_eq!(stored.as_array().expect("list").iter().filter(|m| m["type"] == 3).count(), 1, "no orphan call message");
}

#[tokio::test]
async fn ringing_times_out_into_a_missed_call_and_the_last_leave_ends_it() {
    let (app, address) = app_with(|config| config.call_ring_timeout = Duration::from_millis(300)).await;
    let (alice, bob) = (user(&app, "alice").await, user(&app, "bob").await);
    befriend(&app, &alice, &bob).await;
    let channel = dm(&app, &alice, &bob).await;
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;

    alice_ws.voice(Some(&channel)).await;
    assert_eq!(alice_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    assert_eq!(bob_ws.wait_for("CALL_CREATE").await["ringing"], json!([bob.id]));
    let started = std::time::Instant::now();
    assert_eq!(bob_ws.wait_for("CALL_UPDATE").await["ringing"], json!([]), "ringing stops on its own");
    assert!(started.elapsed() >= Duration::from_millis(200), "not before the timeout");
    assert!(app.state.voice.calls.ongoing(channel.parse().expect("id")), "the caller is still in the call");

    alice_ws.voice(None).await;
    let ended = bob_ws.wait_for("MESSAGE_UPDATE").await;
    assert_eq!(ended["call"]["participants"], json!([alice.id]), "bob never joined: a missed call for him");
    assert!(ended["call"]["ended_timestamp"].is_string());
    assert_eq!(bob_ws.wait_for("CALL_DELETE").await, json!({"channel_id": channel}));
    let stored = messages(&app, &channel, &bob.token).await;
    assert_eq!(stored[0]["type"], 3);
    assert_eq!(stored[0]["call"], ended["call"]);
    assert_eq!(app.post(&format!("/channels/{channel}/call/ring"), &alice.token, json!({})).await.0, StatusCode::BAD_REQUEST, "no call any more");

    // A new join starts a new call (a second call message).
    alice_ws.voice(Some(&channel)).await;
    assert_eq!(alice_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let second = bob_ws.wait_for("CALL_CREATE").await;
    assert_ne!(second["message_id"], stored[0]["id"]);
    alice_ws.voice(None).await;
    bob_ws.wait_for("CALL_DELETE").await;
    let stored = messages(&app, &channel, &bob.token).await;
    assert!(stored.as_array().expect("list").iter().filter(|m| m["type"] == 3).all(|m| m["call"]["ended_timestamp"].is_string()));
}

#[tokio::test]
async fn blocks_follow_the_dm_message_rules() {
    let (app, address) = app_with(|_| {}).await;
    let (alice, bob, carl, dana) = (user(&app, "alice").await, user(&app, "bob").await, user(&app, "carl").await, user(&app, "dana").await);
    for other in [&bob, &carl, &dana] {
        befriend(&app, &alice, other).await;
    }
    let one = dm(&app, &alice, &bob).await;
    let (status, group) = app.post("/users/@me/channels", &alice.token, json!({"recipient_ids": [bob.id, carl.id, dana.id]})).await;
    assert_eq!(status, StatusCode::OK);
    let group = group["id"].as_str().expect("id").to_owned();
    // Bob blocks alice: the 1:1 call is closed both ways.
    assert_eq!(app.put_json(&format!("/users/@me/relationships/{}", alice.id), &bob.token, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;
    let mut dana_ws = Client::identify(&address, &dana.token).await;
    alice_ws.voice(Some(&one)).await;
    let (name, failed) = alice_ws.voice_answer().await;
    assert_eq!((name.as_str(), failed["reason"].as_str(), &failed["guild_id"]), ("VOICE_CONNECT_FAILED", Some("blocked"), &Value::Null));
    bob_ws.voice(Some(&one)).await;
    assert_eq!(bob_ws.voice_answer().await.1["reason"], "blocked", "the blocker cannot call either");
    assert!(!app.state.voice.calls.ongoing(one.parse().expect("id")));

    // Group DM: alice's call rings carl and dana, not bob (a block between them).
    alice_ws.voice(Some(&group)).await;
    assert_eq!(alice_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let mut expected = vec![carl.id.clone(), dana.id.clone()];
    expected.sort_by_key(|id| id.parse::<i64>().expect("id"));
    assert_eq!(dana_ws.wait_for("CALL_CREATE").await["ringing"], json!(expected));
    let (status, body) = app.post(&format!("/channels/{group}/call/ring"), &alice.token, json!({"recipients": [bob.id]})).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50007)));
    // Bob can still join the group call (blocks only stop ringing there).
    bob_ws.voice(Some(&group)).await;
    assert_eq!(bob_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    // Leaving the group DM leaves its call; dana leaving stops her ringing.
    assert_eq!(app.delete(&format!("/channels/{group}"), &bob.token).await.0, StatusCode::OK);
    alice_ws.wait_until("VOICE_STATE_UPDATE", |state| state["user_id"] == bob.id.as_str() && state["channel_id"].is_null()).await;
    assert!(app.state.voice.get(bob.id.parse().expect("id")).is_none());
    assert_eq!(app.delete(&format!("/channels/{group}"), &dana.token).await.0, StatusCode::OK);
    assert_eq!(alice_ws.wait_for("CALL_UPDATE").await["ringing"], json!([carl.id]));
    // A non-recipient gets nothing.
    let (status, _) = app.post(&format!("/channels/{group}/call/ring"), &dana.token, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_call_holds_at_most_ten_people() {
    let (app, address) = app_with(|_| {}).await;
    let mut users = Vec::new();
    for index in 0..11 {
        users.push(user(&app, &format!("user{index}")).await);
    }
    // A group DM with 11 recipients (more than the API creates) shows the cap is the call's, not the group's.
    let channel = app.state.ids.next();
    sqlx::query("INSERT INTO channels (id, kind, owner_id) VALUES ($1, 3, $2)")
        .bind(channel)
        .bind(users[0].id.parse::<i64>().expect("id"))
        .execute(&app.state.db)
        .await
        .expect("channel");
    for member in &users {
        sqlx::query("INSERT INTO channel_recipients (channel_id, user_id) VALUES ($1, $2)")
            .bind(channel)
            .bind(member.id.parse::<i64>().expect("id"))
            .execute(&app.state.db)
            .await
            .expect("recipient");
    }
    let channel = channel.to_string();
    let mut clients = Vec::new();
    for member in &users {
        clients.push(Client::identify(&address, &member.token).await);
    }
    for client in clients.iter_mut().take(10) {
        client.voice(Some(&channel)).await;
        assert_eq!(client.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    }
    let last = clients.last_mut().expect("eleventh");
    last.voice(Some(&channel)).await;
    let (name, failed) = last.voice_answer().await;
    assert_eq!((name.as_str(), failed["reason"].as_str()), ("VOICE_CONNECT_FAILED", Some("channel_full")));
    // One leaves: the eleventh gets in.
    clients[0].voice(None).await;
    let first: i64 = users[0].id.parse().expect("id");
    for _ in 0..100 {
        if app.state.voice.get(first).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let last = clients.last_mut().expect("eleventh");
    last.voice(Some(&channel)).await;
    assert_eq!(last.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    let (_, list) = app.get(&format!("/channels/{channel}/messages"), &users[0].token).await;
    let call = list.as_array().expect("list").iter().find(|m| m["type"] == 3).expect("call message").clone();
    assert_eq!(call["call"]["participants"].as_array().map(Vec::len), Some(11), "everyone who joined is recorded");
}

#[tokio::test]
async fn starting_a_dm_call_follows_the_dm_privacy_rule() {
    let (app, address) = app_with(|_| {}).await;
    let (alice, bob) = (user(&app, "alice").await, user(&app, "bob").await);
    let (guild, channel) = app.guild_with_channel(&alice.token).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &alice.token, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &bob.token, json!({})).await;
    let one = dm(&app, &bob, &alice).await;
    // Alice turns off DMs from their only shared guild: bob may not start a call, which would post a message and ring her.
    let privacy = format!("/users/@me/guilds/{guild}/privacy");
    assert_eq!(app.patch(&privacy, &alice.token, json!({"direct_messages": false})).await.0, StatusCode::OK);
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;
    bob_ws.voice(Some(&one)).await;
    assert_eq!(bob_ws.voice_answer().await.1["reason"], "blocked");
    assert!(!app.state.voice.calls.ongoing(one.parse().expect("id")));
    assert_eq!(messages(&app, &one, &alice.token).await, json!([]));
    // Alice may still call bob (his defaults allow it), and bob may join the call she started, but not ring her again.
    alice_ws.voice(Some(&one)).await;
    assert_eq!(alice_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    bob_ws.wait_for("CALL_CREATE").await;
    bob_ws.voice(Some(&one)).await;
    assert_eq!(bob_ws.voice_answer().await.0, "VOICE_SERVER_UPDATE");
    alice_ws.voice(None).await;
    alice_ws.wait_until("VOICE_STATE_UPDATE", |state| state["user_id"] == alice.id.as_str() && state["channel_id"].is_null()).await;
    let (status, body) = app.post(&format!("/channels/{one}/call/ring"), &bob.token, json!({})).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50007)));
}
