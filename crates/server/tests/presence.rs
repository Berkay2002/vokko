#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Chosen status persistence, invisible, and presence announcements around joining and leaving guilds.
mod common;

use std::time::Duration;

use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(address: &str, token: &str) -> (Self, Value) {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.recv().await;
        client.send(json!({"op": 2, "d": {"token": token}})).await;
        let ready = client.wait_for("READY").await;
        (client, ready)
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
    }

    async fn recv(&mut self) -> Value {
        loop {
            match tokio::time::timeout(common::WAIT, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return serde_json::from_str(&text).expect("json frame"),
                Ok(Some(Ok(_))) => continue,
                Ok(_) => panic!("gateway closed"),
                Err(_) => panic!("timed out waiting for a gateway frame"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.recv().await;
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    /// The next PRESENCE_UPDATE of `user_id` that has `status`.
    async fn wait_presence(&mut self, user_id: &str, status: &str) -> Value {
        loop {
            let data = self.wait_for("PRESENCE_UPDATE").await;
            if data["user_id"] == user_id && data["status"] == status {
                return data;
            }
        }
    }

    /// True if no PRESENCE_UPDATE of `user_id` with another status than `allowed` arrives within `window`.
    async fn only_presence(&mut self, user_id: &str, allowed: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Some(Ok(Message::Text(text))) = next {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == "PRESENCE_UPDATE" && frame["d"]["user_id"] == user_id && frame["d"]["status"] != allowed {
                    return false;
                }
            }
        }
        true
    }
}

fn find<'a>(presences: &'a Value, user_id: &str) -> Option<&'a Value> {
    presences.as_array().expect("presences").iter().find(|presence| presence["user_id"] == user_id)
}

struct World {
    app: TestApp,
    address: String,
    guild: String,
    invite: String,
    channel: String,
    owner: (String, String),
    alice: (String, String),
    bob: (String, String),
}

async fn world() -> World {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner_token, owner) = app.register("sam").await;
    let (alice_token, alice) = app.register("alice").await;
    let (bob_token, bob) = app.register("bob").await;
    let (guild, channel) = app.guild_with_channel(&owner_token).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner_token, json!({})).await;
    let invite = invite["code"].as_str().expect("code").to_owned();
    app.post(&format!("/invites/{invite}"), &alice_token, json!({})).await;
    let id = |user: &Value| user["id"].as_str().expect("id").to_owned();
    World { address, guild, invite, channel, owner: (owner_token, id(&owner)), alice: (alice_token, id(&alice)), bob: (bob_token, id(&bob)), app }
}

#[tokio::test]
async fn chosen_status_and_custom_status_survive_disconnects() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    alice.send(json!({"op": 3, "d": {"status": "dnd", "custom_status": "busy"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "dnd").await;
    assert_eq!(seen["custom_status"], "busy");

    drop(alice);
    let gone = owner.wait_presence(&w.alice.1, "offline").await;
    assert_eq!(gone["custom_status"], Value::Null);

    let (_alice, ready) = Client::connect(&w.address, &w.alice.0).await;
    let own = find(&ready["presences"], &w.alice.1).expect("own presence in READY");
    assert_eq!((own["status"].as_str(), own["custom_status"].as_str()), (Some("dnd"), Some("busy")), "alice sees her chosen status");
    let back = owner.wait_presence(&w.alice.1, "dnd").await;
    assert_eq!(back["custom_status"], "busy", "restored, not reset to online");
}

#[tokio::test]
async fn activity_is_shared_kept_cleared_and_hidden_like_a_custom_status() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    let game = json!([{"name": "Factorio", "type": 0, "timestamps": {"start": 1_760_000_000_000_i64}}]);
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": game}})).await;
    let seen = loop {
        let seen = owner.wait_presence(&w.alice.1, "online").await;
        if !seen["activities"].is_null() {
            break seen;
        }
    };
    assert_eq!(seen["activities"], game, "others see the activity");

    // a later update without `activities` keeps it
    alice.send(json!({"op": 3, "d": {"status": "idle", "custom_status": "brb"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "idle").await;
    assert_eq!((seen["custom_status"].as_str(), &seen["activities"]), (Some("brb"), &game), "absent activities are kept");

    // invisible hides it from others but not from her own sessions
    alice.send(json!({"op": 3, "d": {"status": "invisible"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "offline").await;
    assert!(seen["activities"].is_null(), "no activity while invisible: {seen}");
    let own = alice.wait_presence(&w.alice.1, "invisible").await;
    assert_eq!(own["activities"], game);

    // an empty list clears it
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": []}})).await;
    let cleared = owner.wait_presence(&w.alice.1, "online").await;
    assert!(cleared["activities"].is_null(), "cleared: {cleared}");

    // the last disconnect clears it, so a reconnect starts without one
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": game}})).await;
    owner.wait_for("PRESENCE_UPDATE").await;
    drop(alice);
    owner.wait_presence(&w.alice.1, "offline").await;
    let (_alice, ready) = Client::connect(&w.address, &w.alice.0).await;
    let own = find(&ready["presences"], &w.alice.1).expect("own presence in READY");
    assert!(own["activities"].is_null(), "no activity after a reconnect: {own}");
}

/// The next PRESENCE_UPDATE of `user_id` with `status` whose activities satisfy `want`.
async fn wait_activities(client: &mut Client, user_id: &str, status: &str, want: impl Fn(&Value) -> bool) -> Value {
    loop {
        let seen = client.wait_presence(user_id, status).await;
        if want(&seen["activities"]) {
            return seen;
        }
    }
}

#[tokio::test]
async fn a_game_and_spotify_are_shown_together_and_keep_their_fields() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;
    set_settings(&w.app, &w.alice.0, json!({"share_spotify": true})).await;

    let both = json!([
        {"name": "Factorio", "type": 0, "timestamps": {"start": 1_760_000_000_000_i64}},
        {"name": "Spotify", "type": 2, "details": "Song", "state": "A; B", "sync_id": "4uLU6hMCjMI75M1A2tKUQC",
         "assets": {"large_image": format!("spotify:{}", "0f".repeat(20))}, "timestamps": {"start": 1_760_000_000_000_i64, "end": 1_760_000_200_000_i64}}
    ]);
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": both}})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a == &both).await;
}

#[tokio::test]
async fn app_icons_on_activities_must_exist_on_the_server() {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    let mut icon = Vec::new();
    PngEncoder::new(&mut icon).write_image(&[255; 4 * 8 * 8], 8, 8, ExtendedColorType::Rgba8).unwrap();
    let (_, uploaded) = w.app.post_bytes("/app-icons", Some(&w.alice.0), "image/png", icon).await;
    let asset = uploaded["asset"].as_str().expect("asset").to_owned();

    // an icon the server has stays on the activity
    let known = json!([{"name": "Google Chrome", "type": 0, "assets": {"large_image": asset}, "app": true}]);
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": known}})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a == &known).await;

    // one it does not have is dropped, the activity stays
    let unknown = json!([{"name": "Claude", "type": 0, "assets": {"large_image": format!("app:{}", "ab".repeat(32))}}]);
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": unknown}})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a == &json!([{"name": "Claude", "type": 0}])).await;

    // a malformed one closes the connection like any other invalid activity (4002)
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": [{"name": "X", "type": 0, "assets": {"large_image": "app:nothex"}}]}})).await;
    let closed = tokio::time::timeout(common::WAIT, async {
        loop {
            match alice.ws.next().await {
                Some(Ok(Message::Close(frame))) => return frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .expect("closed in time");
    assert_eq!(closed, Some(4002));
}

#[tokio::test]
async fn activity_belongs_to_the_session_that_reported_it() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut desktop, _) = Client::connect(&w.address, &w.alice.0).await;
    let (mut browser, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    let game = json!([{"name": "Factorio", "type": 0, "timestamps": {"start": 1_760_000_000_000_i64}}]);
    let other = json!([{"name": "Terraria", "type": 0}]);
    desktop.send(json!({"op": 3, "d": {"status": "online", "activities": game}})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a == &game).await;

    // the browser neither wipes the game with an empty list nor with an update that has no activities
    browser.send(json!({"op": 3, "d": {"status": "online", "activities": []}})).await;
    browser.send(json!({"op": 3, "d": {"status": "dnd"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "dnd").await;
    assert_eq!(seen["activities"], game, "another session cannot wipe the game: {seen}");

    // the newest report wins while both are connected; when that session goes, the older one shows again
    browser.send(json!({"op": 3, "d": {"status": "dnd", "activities": other}})).await;
    wait_activities(&mut owner, &w.alice.1, "dnd", |a| a == &other).await;
    drop(browser);
    wait_activities(&mut owner, &w.alice.1, "dnd", |a| a == &game).await;

    // the desktop goes while another session stays: its game goes with it, not at the last disconnect
    let (_still_here, _) = Client::connect(&w.address, &w.alice.0).await;
    drop(desktop);
    let cleared = wait_activities(&mut owner, &w.alice.1, "dnd", |a| a.is_null()).await;
    assert_eq!(cleared["status"], "dnd", "she is still online: {cleared}");
}

#[tokio::test]
async fn invisible_reads_offline_to_others_and_survives_reconnects() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    alice.send(json!({"op": 3, "d": {"status": "invisible", "custom_status": "secret"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "offline").await;
    assert_eq!(seen["custom_status"], Value::Null, "custom status is hidden while invisible");
    let own = alice.wait_presence(&w.alice.1, "invisible").await;
    assert_eq!(own["custom_status"], "secret", "her own sessions still see it");

    // a fresh READY of someone else shows her offline although she is connected
    let (mut bob_owner, ready) = Client::connect(&w.address, &w.owner.0).await;
    let seen = find(&ready["presences"], &w.alice.1).expect("alice in READY");
    assert_eq!((seen["status"].as_str(), seen["custom_status"].is_null()), (Some("offline"), true));
    drop(bob_owner.ws.close(None).await);

    // reconnecting keeps her invisible: nobody ever sees her online
    drop(alice);
    let (_alice, ready) = Client::connect(&w.address, &w.alice.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).expect("own presence")["status"], "invisible");
    assert!(owner.only_presence(&w.alice.1, "offline", Duration::from_millis(600)).await, "invisible user never appears online");
}

#[tokio::test]
async fn joining_and_leaving_announces_presence_to_new_strangers() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut bob, ready) = Client::connect(&w.address, &w.bob.0).await;
    assert!(find(&ready["presences"], &w.owner.1).is_none(), "bob shares nothing with sam yet");

    let (status, _) = w.app.post(&format!("/invites/{}", w.invite), &w.bob.0, json!({})).await;
    assert_eq!(status, 200);
    let created = bob.wait_for("GUILD_CREATE").await;
    let presences = &created["presences"];
    assert_eq!(find(presences, &w.owner.1).expect("sam online in GUILD_CREATE")["status"], "online");
    assert!(created["presences"].as_array().is_some_and(|list| list.iter().all(|entry| entry["status"] != "offline")));

    owner.wait_for("GUILD_MEMBER_ADD").await;
    owner.wait_presence(&w.bob.1, "online").await;

    let (status, _) = w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &w.bob.0).await;
    assert_eq!(status, 204);
    owner.wait_presence(&w.bob.1, "offline").await;
    bob.wait_presence(&w.owner.1, "offline").await;
}

impl Client {
    /// True if no `name` event about `user_id` arrives within `window`.
    async fn quiet(&mut self, name: &str, user_id: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Some(Ok(Message::Text(text))) = next {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == name && frame["d"]["user_id"] == user_id {
                    return false;
                }
            }
        }
        true
    }
}

const QUIET: Duration = Duration::from_millis(600);

async fn typing(app: &TestApp, token: &str, channel: &str) {
    assert_eq!(app.post(&format!("/channels/{channel}/typing"), token, json!({})).await.0, 204, "typing always succeeds");
}

async fn befriend(app: &TestApp, a: &(String, String), b: &(String, String)) {
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", b.1), &a.0).await.0, 204);
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", a.1), &b.0).await.0, 204);
}

async fn set_settings(app: &TestApp, token: &str, settings: Value) {
    let (_, current) = app.get("/users/@me/settings", token).await;
    let (status, body) = app.patch("/users/@me/settings", token, json!({"version": current["version"], "settings": settings})).await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn an_invisible_user_types_unseen() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert_eq!(owner.wait_for("TYPING_START").await["user_id"], w.alice.1.as_str());

    alice.send(json!({"op": 3, "d": {"status": "invisible"}})).await;
    owner.wait_presence(&w.alice.1, "offline").await;
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert!(owner.quiet("TYPING_START", &w.alice.1, QUIET).await, "no typing from an invisible user");
}

#[tokio::test]
async fn appearing_offline_in_one_server_hides_only_there() {
    let w = world().await;
    // guild B is bob's and alice joins it; carl is alice's friend and shares no guild
    let (carl_token, carl) = w.app.register("carl").await;
    let carl = (carl_token, carl["id"].as_str().expect("id").to_owned());
    befriend(&w.app, &w.alice, &carl).await;
    let (_, channel_b) = w.app.guild_with_channel(&w.bob.0).await;
    let (_, invite) = w.app.post(&format!("/channels/{channel_b}/invites"), &w.bob.0, json!({})).await;
    w.app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &w.alice.0, json!({})).await;

    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    let (mut owner, ready) = Client::connect(&w.address, &w.owner.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).expect("alice")["status"], "online");
    let (mut bob, _) = Client::connect(&w.address, &w.bob.0).await;
    let (mut friend, _) = Client::connect(&w.address, &carl.0).await;

    let path = format!("/users/@me/guilds/{}/privacy", w.guild);
    let (status, body) = w.app.patch(&path, &w.alice.0, json!({"appear_offline": true})).await;
    assert_eq!((status.as_u16(), body), (200, json!({"direct_messages": true, "appear_offline": true})));
    owner.wait_presence(&w.alice.1, "offline").await;
    assert!(bob.only_presence(&w.alice.1, "online", QUIET).await, "guild B still sees her online");
    assert!(friend.only_presence(&w.alice.1, "online", QUIET).await, "a friend still sees her online");

    // a status change reaches B and the friend, not A
    alice.send(json!({"op": 3, "d": {"status": "dnd"}})).await;
    bob.wait_presence(&w.alice.1, "dnd").await;
    friend.wait_presence(&w.alice.1, "dnd").await;
    assert!(owner.only_presence(&w.alice.1, "offline", QUIET).await);
    let (_, ready) = Client::connect(&w.address, &w.owner.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).expect("alice")["status"], "offline", "a fresh READY in A");
    let (_, ready) = Client::connect(&w.address, &carl.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).expect("alice")["status"], "dnd", "a fresh READY of the friend");

    // typing: hidden in A, shown in B
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert!(owner.quiet("TYPING_START", &w.alice.1, QUIET).await, "no typing in A");
    typing(&w.app, &w.alice.0, &channel_b).await;
    assert_eq!(bob.wait_for("TYPING_START").await["user_id"], w.alice.1.as_str());

    // turned off: A sees her again
    w.app.patch(&path, &w.alice.0, json!({"appear_offline": false})).await;
    owner.wait_presence(&w.alice.1, "dnd").await;
}

async fn dm(app: &TestApp, from: &(String, String), to: &str, content: &str) -> String {
    let (status, channel) = app.post("/users/@me/channels", &from.0, json!({"recipient_id": to})).await;
    assert_eq!(status, 200, "{channel}");
    let channel = channel["id"].as_str().expect("id").to_owned();
    let (status, body) = app.post(&format!("/channels/{channel}/messages"), &from.0, json!({"content": content})).await;
    assert_eq!(status, 200, "{body}");
    channel
}

#[tokio::test]
async fn an_unanswered_dm_does_not_lift_appear_offline() {
    let w = world().await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    let path = format!("/users/@me/guilds/{}/privacy", w.guild);
    assert_eq!(w.app.patch(&path, &w.alice.0, json!({"appear_offline": true})).await.0, 200);
    alice.send(json!({"op": 3, "d": {"status": "dnd"}})).await;

    // sam shares only the guild with alice and DMs her: that reopens her side of the DM, but she never took part
    let channel = dm(&w.app, &w.owner, &w.alice.1, "hi").await;
    let (mut owner, ready) = Client::connect(&w.address, &w.owner.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).map(|p| p["status"].clone()), Some(json!("offline")), "still hidden after his DM");
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert!(owner.quiet("TYPING_START", &w.alice.1, QUIET).await, "no typing in the hidden guild");

    // she answers: the DM is hers too now, so he sees her, but typing in the hidden guild stays hidden
    let (status, _) = w.app.post(&format!("/channels/{channel}/messages"), &w.alice.0, json!({"content": "hey"})).await;
    assert_eq!(status, 200);
    let (mut owner, ready) = Client::connect(&w.address, &w.owner.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).expect("alice")["status"], "dnd", "a DM she wrote in shows her");
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert!(owner.quiet("TYPING_START", &w.alice.1, QUIET).await, "still no typing in the hidden guild");
}

#[tokio::test]
async fn deleting_a_guild_shows_offline_to_whoever_shares_nothing_else() {
    let w = world().await;
    // bob joins too and is alice's friend, so the two still share something after the guild goes
    w.app.post(&format!("/invites/{}", w.invite), &w.bob.0, json!({})).await;
    befriend(&w.app, &w.alice, &w.bob).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    let (mut bob, _) = Client::connect(&w.address, &w.bob.0).await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    alice.wait_presence(&w.owner.1, "online").await;
    bob.wait_presence(&w.owner.1, "online").await;

    assert_eq!(w.app.delete(&format!("/guilds/{}", w.guild), &w.owner.0).await.0, 204);
    alice.wait_presence(&w.owner.1, "offline").await;
    let mut gone = std::collections::HashSet::new();
    while gone.len() < 2 {
        let data = owner.wait_for("PRESENCE_UPDATE").await;
        if data["status"] == "offline" {
            gone.insert(data["user_id"].as_str().expect("id").to_owned());
        }
    }
    assert_eq!(gone, [w.alice.1.clone(), w.bob.1.clone()].into(), "the owner sees both offline");
    assert!(bob.only_presence(&w.alice.1, "online", QUIET).await, "a friend keeps seeing her");
}

#[tokio::test]
async fn an_unanswered_dm_shares_no_presence() {
    let w = world().await;
    let (_alice, _) = Client::connect(&w.address, &w.alice.0).await;
    dm(&w.app, &w.owner, &w.alice.1, "hi").await;
    // alice leaves the only guild they shared: his DM alone must not let him track her
    assert_eq!(w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &w.alice.0).await.0, 204);
    let (_owner, ready) = Client::connect(&w.address, &w.owner.0).await;
    assert!(find(&ready["presences"], &w.alice.1).is_none_or(|p| p["status"] == "offline"), "no presence through an unanswered DM");
}

#[tokio::test]
async fn activity_privacy_opt_outs_are_enforced() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;
    let game = json!({"name": "Factorio", "type": 0});
    let song = json!({"name": "Spotify", "type": 2, "details": "Song", "state": "A"});
    // Spotify is opt-in: a track sent unasked is dropped
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": [game, song]}})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a == &json!([game])).await;
    set_settings(&w.app, &w.alice.0, json!({"share_spotify": true})).await;
    alice.send(json!({"op": 3, "d": {"status": "online", "activities": [game, song]}})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a.as_array().is_some_and(|list| list.len() == 2)).await;

    // Spotify off: the track goes now, the game stays, and a later update cannot bring it back
    set_settings(&w.app, &w.alice.0, json!({"share_spotify": false})).await;
    wait_activities(&mut owner, &w.alice.1, "online", |a| a == &json!([game])).await;
    alice.send(json!({"op": 3, "d": {"status": "dnd", "activities": [game, song]}})).await;
    wait_activities(&mut owner, &w.alice.1, "dnd", |a| a == &json!([game])).await;

    // all activity off: everything goes, and typing too (it follows the general choice while unset)
    set_settings(&w.app, &w.alice.0, json!({"share_activity": false})).await;
    wait_activities(&mut owner, &w.alice.1, "dnd", |a| a.is_null()).await;
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert!(owner.quiet("TYPING_START", &w.alice.1, QUIET).await, "typing follows share_activity");

    // typing on by itself again, then off by itself
    set_settings(&w.app, &w.alice.0, json!({"share_typing": true})).await;
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert_eq!(owner.wait_for("TYPING_START").await["user_id"], w.alice.1.as_str());
    set_settings(&w.app, &w.alice.0, json!({"share_typing": false, "share_activity": true})).await;
    typing(&w.app, &w.alice.0, &w.channel).await;
    assert!(owner.quiet("TYPING_START", &w.alice.1, QUIET).await, "typing off on its own");

    // mutual servers and friends on the profile
    let profile = format!("/users/{}/profile", w.alice.1);
    assert_eq!(w.app.get(&profile, &w.owner.0).await.1["mutual_guilds"].as_array().map(Vec::len), Some(1));
    set_settings(&w.app, &w.alice.0, json!({"share_mutuals": false})).await;
    let (_, seen) = w.app.get(&profile, &w.owner.0).await;
    assert_eq!((seen["mutual_guilds"].clone(), seen["mutual_friends_count"].clone()), (json!([]), json!(0)));
    let theirs = w.app.get(&format!("/users/{}/profile", w.owner.1), &w.alice.0).await.1;
    assert_eq!(theirs["mutual_guilds"].as_array().map(Vec::len), Some(1), "her view of others is unchanged");
}
