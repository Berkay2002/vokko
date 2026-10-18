#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Group DM recipients (docs/api.md "Group DM recipients"): PUT / DELETE /channels/{id}/recipients/{user_id}.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use vokko_server::config::LiveKitConfig;
use vokko_server::voice::livekit::FakeRoomService;

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
}

struct User {
    token: String,
    id: String,
}

async fn user(app: &TestApp, name: &str) -> User {
    let (token, user) = app.register(name).await;
    User { token, id: user["id"].as_str().expect("id").to_owned() }
}

async fn befriend(app: &TestApp, a: &User, b: &User) {
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", b.id), &a.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", a.id), &b.token).await.0, StatusCode::NO_CONTENT);
}

/// A group DM owned by `owner` with `others` in it.
async fn group(app: &TestApp, owner: &User, others: &[&User]) -> String {
    let ids: Vec<&str> = others.iter().map(|user| user.id.as_str()).collect();
    let (status, channel) = app.post("/users/@me/channels", &owner.token, json!({"recipient_ids": ids})).await;
    assert_eq!(status, StatusCode::OK, "{channel}");
    channel["id"].as_str().expect("id").to_owned()
}

fn path(channel: &str, user: &User) -> String {
    format!("/channels/{channel}/recipients/{}", user.id)
}

#[tokio::test]
async fn adding_and_removing_recipients_follows_the_rules() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (alice, bob, carl, dana, erin) =
        (user(&app, "alice").await, user(&app, "bob").await, user(&app, "carl").await, user(&app, "dana").await, user(&app, "erin").await);
    for other in [&bob, &carl, &dana] {
        befriend(&app, &alice, other).await;
    }
    let channel = group(&app, &alice, &[&bob, &carl]).await;
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut dana_ws = Client::identify(&address, &dana.token).await;

    // Not a recipient: no access. Not a friend of the caller: refused.
    assert_eq!(app.put(&path(&channel, &dana), &erin.token).await.0, StatusCode::FORBIDDEN);
    let (status, body) = app.put(&path(&channel, &erin), &bob.token).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50007)));
    // A block ends the friendship: refused too.
    assert_eq!(app.put_json(&format!("/users/@me/relationships/{}", dana.id), &alice.token, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&path(&channel, &dana), &alice.token).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&format!("/users/@me/relationships/{}", dana.id), &alice.token).await.0, StatusCode::NO_CONTENT);
    befriend(&app, &alice, &dana).await;

    // A 1:1 DM has no recipients route.
    let (status, one) = app.post("/users/@me/channels", &alice.token, json!({"recipient_id": bob.id})).await;
    assert_eq!(status, StatusCode::OK);
    let one = one["id"].as_str().expect("id").to_owned();
    assert_eq!(app.put(&path(&one, &dana), &alice.token).await.0, StatusCode::BAD_REQUEST);

    // Bob (not the owner) adds a friend of his: only friends of the caller; alice is friends with dana, bob is not.
    assert_eq!(app.put(&path(&channel, &dana), &bob.token).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.put(&path(&channel, &dana), &alice.token).await.0, StatusCode::NO_CONTENT);
    let added = alice_ws.wait_for("CHANNEL_RECIPIENT_ADD").await;
    assert_eq!((added["channel_id"].as_str(), added["user"]["id"].as_str()), (Some(channel.as_str()), Some(dana.id.as_str())));
    assert_eq!(dana_ws.wait_for("CHANNEL_CREATE").await["id"], channel.as_str());
    let (_, list) = app.get("/users/@me/channels", &dana.token).await;
    assert!(list.as_array().expect("list").iter().any(|c| c["id"] == channel.as_str() && c["recipients"].as_array().map(Vec::len) == Some(3)), "{list}");

    // Idempotent: 204 again, and no second event (the next one alice hears is the removal below).
    assert_eq!(app.put(&path(&channel, &dana), &alice.token).await.0, StatusCode::NO_CONTENT);

    // Only the owner removes others.
    let (status, body) = app.delete(&path(&channel, &carl), &bob.token).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));
    assert_eq!(app.delete(&path(&channel, &dana), &alice.token).await.0, StatusCode::NO_CONTENT);
    let removed = alice_ws.wait_for("CHANNEL_RECIPIENT_REMOVE").await;
    assert_eq!(removed["user"]["id"], dana.id.as_str());
    assert_eq!(dana_ws.wait_for("CHANNEL_DELETE").await["id"], channel.as_str());
    // Dana is out: no access, no more events.
    assert_eq!(app.get(&format!("/channels/{channel}/messages"), &dana.token).await.0, StatusCode::FORBIDDEN);

    // Anyone removes themselves.
    assert_eq!(app.delete(&path(&channel, &carl), &carl.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(alice_ws.wait_for("CHANNEL_RECIPIENT_REMOVE").await["user"]["id"], carl.id.as_str());
}

#[tokio::test]
async fn a_group_holds_at_most_ten_people() {
    let app = TestApp::new().await;
    let alice = user(&app, "alice").await;
    let mut members = Vec::new();
    for index in 0..10 {
        let member = user(&app, &format!("member{index}")).await;
        befriend(&app, &alice, &member).await;
        members.push(member);
    }
    let channel = group(&app, &alice, &members[..9].iter().collect::<Vec<_>>()).await;
    let (status, body) = app.put(&path(&channel, &members[9]), &alice.token).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(30004)), "{body}");
    // One leaves: the tenth fits.
    assert_eq!(app.delete(&path(&channel, &members[0]), &members[0].token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&path(&channel, &members[9]), &alice.token).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn leaving_a_group_leaves_its_call_and_voice_room() {
    let rooms = FakeRoomService::new();
    let app = TestApp::with_room_service(
        |config| {
            config.livekit = vec![LiveKitConfig {
                url: "wss://lk.test".into(),
                api_url: "http://127.0.0.1:9".into(),
                api_key: "vokko".into(),
                api_secret: "test-secret".into(),
                label: "test".into(),
            }];
        },
        rooms.clone(),
    )
    .await;
    let address = app.serve().await;
    let (alice, bob, carl) = (user(&app, "alice").await, user(&app, "bob").await, user(&app, "carl").await);
    for other in [&bob, &carl] {
        befriend(&app, &alice, other).await;
    }
    let channel = group(&app, &alice, &[&bob, &carl]).await;
    let mut alice_ws = Client::identify(&address, &alice.token).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;
    for ws in [&mut alice_ws, &mut bob_ws] {
        ws.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": channel, "self_mute": false, "self_deaf": false, "self_video": false}})).await;
        ws.wait_for("VOICE_SERVER_UPDATE").await;
    }
    let bob_id: i64 = bob.id.parse().expect("id");
    assert!(app.state.voice.get(bob_id).is_some());

    // The owner removes bob while he is in the call.
    assert_eq!(app.delete(&path(&channel, &bob), &alice.token).await.0, StatusCode::NO_CONTENT);
    alice_ws.wait_until("VOICE_STATE_UPDATE", |state| state["user_id"] == bob.id.as_str() && state["channel_id"].is_null()).await;
    assert!(app.state.voice.get(bob_id).is_none());
    assert!(rooms.calls().iter().any(|call| call == &format!("RemoveParticipant v{channel} {}", bob.id)), "{:?}", rooms.calls());
    assert_eq!(bob_ws.wait_for("CHANNEL_DELETE").await["id"], channel.as_str());
    assert!(app.state.voice.calls.ongoing(channel.parse().expect("id")), "alice is still in the call");
}

#[tokio::test]
async fn the_owner_leaving_hands_the_group_to_a_remaining_recipient() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (alice, bob, carl) = (user(&app, "alice").await, user(&app, "bob").await, user(&app, "carl").await);
    for other in [&bob, &carl] {
        befriend(&app, &alice, other).await;
    }
    let channel = group(&app, &alice, &[&bob, &carl]).await;
    let mut bob_ws = Client::identify(&address, &bob.token).await;
    assert_eq!(app.delete(&path(&channel, &alice), &alice.token).await.0, StatusCode::NO_CONTENT);
    let updated = bob_ws.wait_until("CHANNEL_UPDATE", |channel| channel["owner_id"].is_string()).await;
    let new_owner = updated["owner_id"].as_str().expect("owner").to_owned();
    assert!(new_owner == bob.id || new_owner == carl.id, "{updated}");
    let (owner, other) = if new_owner == bob.id { (&bob, &carl) } else { (&carl, &bob) };
    // The new owner can remove others; the old owner, re-added by a friend, has no owner powers.
    befriend(&app, owner, &alice).await;
    assert_eq!(app.put(&path(&channel, &alice), &owner.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.delete(&path(&channel, other), &alice.token).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&path(&channel, other), &owner.token).await.0, StatusCode::NO_CONTENT);
}
