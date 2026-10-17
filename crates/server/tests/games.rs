#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Games in calls (docs/design/games-host.md section 10): the guild catalog, starting and stopping a game, the relay and app ids,
//! over the gateway against a fake LiveKit RoomService.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use vokko_protocol::api::permissions::MANAGE_CHANNELS;
use vokko_server::config::{Config, LiveKitConfig};
use vokko_server::voice::livekit::FakeRoomService;

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> (Self, Value) {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.send(json!({"op": 2, "d": {"token": token}})).await;
        let ready = client.wait_for("READY").await;
        (client, ready)
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
    }

    /// Joins (or with `None` leaves) voice and waits for the answer.
    async fn voice(&mut self, channel: Option<&str>) {
        self.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": channel, "self_mute": false, "self_deaf": false, "self_video": false}})).await;
        let answer = if channel.is_some() { "VOICE_SERVER_UPDATE" } else { "VOICE_STATE_UPDATE" };
        self.wait_for(answer).await;
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.unwrap_or_else(|_| panic!("timed out waiting for {name}"));
            let Some(Ok(Message::Text(text))) = next else { continue };
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
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

fn livekit(config: &mut Config) {
    config.livekit = vec![LiveKitConfig {
        url: "wss://lk.test".into(),
        api_url: "http://127.0.0.1:9".into(),
        api_key: "vokko".into(),
        api_secret: "test-secret".into(),
        label: "test".into(),
    }];
    config.public_url = "https://vokko.test".into();
}

struct World {
    app: TestApp,
    address: String,
    guild: String,
    voice: String,
    owner: String,
    alice: String,
    alice_id: String,
    carl: String,
    carl_id: String,
}

async fn world_with(adjust: impl FnOnce(&mut Config)) -> World {
    let app = TestApp::with_room_service(
        |config| {
            livekit(config);
            adjust(config);
        },
        FakeRoomService::new(),
    )
    .await;
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (carl, carl_user) = app.register("carl").await;
    let (guild, text) = app.guild_with_channel(&owner).await;
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &owner).await;
    let voice = channels.as_array().expect("channels").iter().find(|c| c["type"] == 2).expect("voice channel")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{text}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    for token in [&alice, &carl] {
        assert_eq!(app.post(&format!("/invites/{code}"), token, json!({})).await.0, StatusCode::OK);
    }
    let id = |user: &Value| user["id"].as_str().expect("id").to_owned();
    World { app, address, guild, voice, owner, alice, alice_id: id(&alice_user), carl, carl_id: id(&carl_user) }
}

fn game(name: &str) -> Value {
    json!({"name": name, "url": "https://play.example.com/vokko/", "icon": "🕵️", "min_players": 2, "max_players": 8, "aspect": "4:3"})
}

#[tokio::test]
async fn the_catalog_is_managed_with_manage_guild_and_validated() {
    let w = world_with(|_| {}).await;
    let path = format!("/guilds/{}/games", w.guild);
    let (mut alice_ws, _) = Client::identify(&w.address, &w.alice).await;

    assert_eq!(w.app.post(&path, &w.alice, game("Codenames")).await.0, StatusCode::FORBIDDEN, "members without MANAGE_GUILD");
    let (status, created) = w.app.post(&path, &w.owner, game(" Codenames ")).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(
        created,
        json!({"id": created["id"], "name": "Codenames", "url": "https://play.example.com/vokko/", "icon": "🕵️", "min_players": 2, "max_players": 8, "aspect": "4:3"})
    );
    assert_eq!(alice_ws.wait_for("GUILD_GAMES_UPDATE").await, json!({"guild_id": w.guild}));
    let id = created["id"].as_str().expect("id").to_owned();
    let (status, list) = w.app.get(&path, &w.alice).await;
    assert_eq!((status, list), (StatusCode::OK, json!([created])), "any member reads the catalog");
    let (_, defaults) = w.app.post(&path, &w.owner, json!({"name": "Plain", "url": "https://plain.example/"})).await;
    assert_eq!((defaults["min_players"].as_u64(), defaults["max_players"].as_u64(), defaults["aspect"].as_str()), (Some(1), Some(16), Some("16:9")));
    assert!(defaults["icon"].is_null());

    let bad: [(Value, &str); 12] = [
        (json!({"url": "http://play.example.com/"}), "url"),
        (json!({"url": "https://vokko.test/games/x"}), "url"),
        (json!({"url": "https://user:pw@play.example.com/"}), "url"),
        (json!({"url": "https://play.example.com/#frag"}), "url"),
        (json!({"url": format!("https://a.example/{}", "x".repeat(495))}), "url"),
        (json!({"url": "not a url"}), "url"),
        (json!({"icon": "ab"}), "icon"),
        (json!({"icon": "🎨🎨"}), "icon"),
        (json!({"name": "a\u{202E}b"}), "name"),
        (json!({"name": "x".repeat(33)}), "name"),
        (json!({"min_players": 0}), "min_players"),
        (json!({"min_players": 4, "max_players": 3}), "max_players"),
    ];
    for (change, field) in bad {
        let mut body = game("Bad");
        body.as_object_mut().expect("object").extend(change.as_object().expect("object").clone());
        let (status, error) = w.app.post(&path, &w.owner, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {error}");
        assert!(error["errors"].get(field).is_some(), "{field}: {error}");
    }
    let (status, _) = w.app.post(&path, &w.owner, json!({"name": "Long ok", "url": format!("https://a.example/{}", "x".repeat(494))})).await;
    assert_eq!(status, StatusCode::CREATED, "512 bytes is fine");

    // Edit, then remove; each leaves an audit entry.
    let item = format!("{path}/{id}");
    assert_eq!(w.app.patch(&item, &w.alice, json!({"name": "Mine"})).await.0, StatusCode::FORBIDDEN);
    let (status, edited) = w.app.patch(&item, &w.owner, json!({"name": "Spies", "icon": null})).await;
    assert_eq!(
        (status, edited["name"].as_str(), edited["icon"].is_null(), edited["url"].as_str()),
        (StatusCode::OK, Some("Spies"), true, created["url"].as_str())
    );
    assert_eq!(w.app.patch(&item, &w.owner, json!({"url": "ftp://x.example/"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&format!("{path}/1"), &w.owner, json!({"name": "x"})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.delete(&item, &w.alice).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&item, &w.owner).await.0, StatusCode::NO_CONTENT);
    let (status, error) = w.app.delete(&item, &w.owner).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10090)));
    for (action, changed) in [(251, "url"), (252, "name"), (253, "name")] {
        let (_, log) = w.app.get(&format!("/guilds/{}/audit-logs?action_type={action}", w.guild), &w.owner).await;
        let entries = log["audit_log_entries"].as_array().expect("entries");
        let entry = entries.iter().find(|entry| entry["target_id"] == id.as_str()).unwrap_or_else(|| panic!("{action}: {log}"));
        assert!(entry["changes"].as_array().expect("changes").iter().any(|change| change["key"] == changed), "{action}: {entry}");
    }

    // At most 25 games per guild (two are left), also when the adds race.
    let adds = futures_util::future::join_all((0..30).map(|n| w.app.post(&path, &w.owner, game(&format!("G{n}"))))).await;
    let statuses: Vec<StatusCode> = adds.iter().map(|(status, _)| *status).collect();
    assert_eq!(statuses.iter().filter(|status| **status == StatusCode::CREATED).count(), 23, "{statuses:?}");
    assert!(statuses.iter().all(|status| matches!(*status, StatusCode::CREATED | StatusCode::BAD_REQUEST)), "{statuses:?}");
    assert_eq!(w.app.post(&path, &w.owner, game("One too many")).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_game_runs_in_the_call_and_relays_only_to_the_people_in_it() {
    let w = world_with(|_| {}).await;
    let path = format!("/channels/{}/game", w.voice);
    let (mut owner_ws, _) = Client::identify(&w.address, &w.owner).await;
    let (mut alice_ws, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl_ws, _) = Client::identify(&w.address, &w.carl).await;
    let (_, guild_game) = w.app.post(&format!("/guilds/{}/games", w.guild), &w.owner, game("Codenames")).await;
    let guild_game = guild_game["id"].as_str().expect("id").to_owned();

    let sketch = json!({"game_id": "builtin:sketch"});
    assert_eq!(w.app.put_json(&path, &w.alice, sketch.clone()).await.0, StatusCode::FORBIDDEN, "not in voice");
    alice_ws.voice(Some(&w.voice)).await;
    carl_ws.voice(Some(&w.voice)).await;
    for unknown in ["builtin:mock", "nope", "1"] {
        let (status, error) = w.app.put_json(&path, &w.alice, json!({"game_id": unknown})).await;
        assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10090)), "{unknown}");
    }
    let (status, error) = w.app.get(&format!("{path}/players"), &w.alice).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10091)), "no game yet");

    let (status, session) = w.app.put_json(&path, &w.alice, json!({"game_id": guild_game})).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!((session["game"]["name"].as_str(), session["started_by"].as_str()), (Some("Codenames"), Some(w.alice_id.as_str())));
    assert!(session["session_id"].as_str().is_some_and(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit())));
    assert_eq!(owner_ws.wait_for("GAME_UPDATE").await, json!({"channel_id": w.voice, "state": session}), "viewers outside the call see it");
    let (status, error) = w.app.put_json(&path, &w.carl, sketch.clone()).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::CONFLICT, Some(40090)), "one game per call");
    let (_, ready) = Client::identify(&w.address, &w.owner).await;
    assert_eq!(ready["guilds"][0]["games"], json!([{"channel_id": w.voice, "state": session}]), "READY carries it");

    // Players and app ids.
    let (status, players) = w.app.get(&format!("{path}/players"), &w.carl).await;
    assert_eq!(status, StatusCode::OK, "{players}");
    let app_of =
        |user: &str| players.as_array().expect("players").iter().find(|p| p["user_id"] == user).expect("player")["app_id"].as_str().expect("app id").to_owned();
    let (alice_app, carl_app) = (app_of(&w.alice_id), app_of(&w.carl_id));
    assert_eq!(players.as_array().map(Vec::len), Some(2));
    for (app, user) in [(&alice_app, &w.alice_id), (&carl_app, &w.carl_id)] {
        assert!(app.len() == 22 && app.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{app}");
        assert!(!app.contains(user.as_str()), "the app id does not carry the user id");
    }
    assert_ne!(alice_app, carl_app);
    let (_, again) = w.app.get(&format!("{path}/players"), &w.alice).await;
    assert_eq!(again, players, "stable");

    // The relay: everyone in the call but the sender, or only `to`.
    let messages = format!("{path}/messages");
    assert_eq!(w.app.post(&messages, &w.alice, json!({"data": {"move": "e4"}})).await.0, StatusCode::NO_CONTENT);
    let relayed = carl_ws.wait_for("GAME_MESSAGE").await;
    assert_eq!(relayed, json!({"channel_id": w.voice, "session_id": session["session_id"], "from": alice_app, "data": {"move": "e4"}}));
    assert!(alice_ws.silent_for("GAME_MESSAGE", Duration::from_millis(300)).await, "not back to the sender");
    assert!(owner_ws.silent_for("GAME_MESSAGE", Duration::from_millis(300)).await, "not to viewers outside the call");
    assert_eq!(w.app.post(&messages, &w.carl, json!({"data": 1, "to": alice_app})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(alice_ws.wait_for("GAME_MESSAGE").await["data"], 1);
    for to in ["nobody", carl_app.as_str()] {
        let (status, error) = w.app.post(&messages, &w.carl, json!({"data": 1, "to": to})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{to}: {error}");
    }
    assert_eq!(w.app.post(&messages, &w.alice, json!({"data": "x".repeat(4094)})).await.0, StatusCode::NO_CONTENT, "4096 bytes");
    let (status, error) = w.app.post(&messages, &w.alice, json!({"data": "x".repeat(4095)})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "4097 bytes: {error}");
    let (status, error) = w.app.post(&messages, &w.alice, json!({"data": "x".repeat(6000)})).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "the body limit: {error}");
    assert_eq!(w.app.post(&messages, &w.owner, json!({"data": 1})).await.0, StatusCode::FORBIDDEN, "not in the call");

    // Stopping: not carl (not the starter), but carl with MANAGE_CHANNELS.
    assert_eq!(w.app.delete(&path, &w.carl).await.0, StatusCode::FORBIDDEN);
    let (_, role) = w.app.post(&format!("/guilds/{}/roles", w.guild), &w.owner, json!({"name": "mods", "permissions": MANAGE_CHANNELS.to_string()})).await;
    let role = role["id"].as_str().expect("role").to_owned();
    w.app.patch(&format!("/guilds/{}/members/{}", w.guild, w.carl_id), &w.owner, json!({"roles": [role]})).await;
    assert_eq!(w.app.delete(&path, &w.carl).await.0, StatusCode::NO_CONTENT);
    assert!(owner_ws.wait_for("GAME_UPDATE").await["state"].is_null());
    let (status, error) = w.app.post(&messages, &w.alice, json!({"data": 1})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10091)));

    // The owner (MANAGE_CHANNELS) stops a game from outside the call.
    w.app.put_json(&path, &w.alice, sketch.clone()).await;
    owner_ws.wait_for("GAME_UPDATE").await;
    assert_eq!(w.app.delete(&path, &w.owner).await.0, StatusCode::NO_CONTENT, "not in the call");
    assert!(owner_ws.wait_for("GAME_UPDATE").await["state"].is_null());

    // App ids differ across games; a late joiner gets the running game; removing the game from the catalog ends it.
    let (_, sketch_session) = w.app.put_json(&path, &w.carl, sketch.clone()).await;
    owner_ws.wait_for("GAME_UPDATE").await;
    let (_, sketch_players) = w.app.get(&format!("{path}/players"), &w.alice).await;
    assert!(!sketch_players.to_string().contains(&alice_app) && !sketch_players.to_string().contains(&carl_app), "{sketch_players}");
    owner_ws.voice(Some(&w.voice)).await;
    assert_eq!(owner_ws.wait_for("GAME_UPDATE").await["state"], sketch_session);
    assert_eq!(w.app.delete(&path, &w.owner).await.0, StatusCode::NO_CONTENT, "the owner may stop it");
    owner_ws.wait_for("GAME_UPDATE").await;
    // Editing a game's URL ends its sessions and gives new app ids; other edits leave it running.
    let item = format!("/guilds/{}/games/{guild_game}", w.guild);
    w.app.put_json(&path, &w.alice, json!({"game_id": guild_game})).await;
    owner_ws.wait_for("GAME_UPDATE").await;
    assert_eq!(w.app.patch(&item, &w.owner, json!({"name": "Spies"})).await.0, StatusCode::OK);
    assert!(owner_ws.silent_for("GAME_UPDATE", Duration::from_millis(300)).await, "a rename keeps it running");
    assert_eq!(w.app.patch(&item, &w.owner, json!({"url": "https://moved.example.com/"})).await.0, StatusCode::OK);
    assert!(owner_ws.wait_for("GAME_UPDATE").await["state"].is_null(), "a new URL ends it");
    w.app.put_json(&path, &w.alice, json!({"game_id": guild_game})).await;
    owner_ws.wait_for("GAME_UPDATE").await;
    let (_, moved_players) = w.app.get(&format!("{path}/players"), &w.alice).await;
    assert!(!moved_players.to_string().contains(&alice_app), "another origin, other app ids: {moved_players}");
    assert_eq!(w.app.delete(&format!("/guilds/{}/games/{guild_game}", w.guild), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert!(owner_ws.wait_for("GAME_UPDATE").await["state"].is_null(), "a removed game ends");

    // The last person leaving ends it.
    w.app.put_json(&path, &w.alice, sketch).await;
    owner_ws.wait_for("GAME_UPDATE").await;
    for ws in [&mut alice_ws, &mut carl_ws] {
        ws.voice(None).await;
    }
    assert!(owner_ws.silent_for("GAME_UPDATE", Duration::from_millis(300)).await, "the owner is still inside");
    owner_ws.voice(None).await;
    assert!(owner_ws.wait_for("GAME_UPDATE").await["state"].is_null());
    assert!(w.app.state.voice.game_get(w.voice.parse().expect("id")).is_none());
}

/// 50 relay sends from alice at once, so the 20/s refill cannot hide the burst limit on a loaded machine.
async fn burst(w: &World, path: &str, body: Value) -> Vec<StatusCode> {
    let messages = format!("{path}/messages");
    let sends = futures_util::future::join_all((0..50).map(|_| w.app.post(&messages, &w.alice, body.clone()))).await;
    sends.into_iter().map(|(status, _)| status).collect()
}

#[tokio::test]
async fn the_relay_is_rate_limited() {
    let w = world_with(|config| config.rate_limit = Some(Default::default())).await;
    let path = format!("/channels/{}/game", w.voice);
    let (mut alice_ws, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl_ws, _) = Client::identify(&w.address, &w.carl).await;
    alice_ws.voice(Some(&w.voice)).await;
    carl_ws.voice(Some(&w.voice)).await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"game_id": "builtin:sketch"})).await.0, StatusCode::OK);
    let codes = burst(&w, &path, json!({"data": 1})).await;
    assert!(codes.contains(&StatusCode::NO_CONTENT), "{codes:?}");
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS), "a burst past 40 is limited: {codes:?}");

    // Oversized sends count against the limit too: it runs before the size check.
    let w = world_with(|config| config.rate_limit = Some(Default::default())).await;
    let path = format!("/channels/{}/game", w.voice);
    let (mut alice_ws, _) = Client::identify(&w.address, &w.alice).await;
    alice_ws.voice(Some(&w.voice)).await;
    assert_eq!(w.app.put_json(&path, &w.alice, json!({"game_id": "builtin:sketch"})).await.0, StatusCode::OK);
    let codes = burst(&w, &path, json!({"data": "x".repeat(4095)})).await;
    assert!(codes.contains(&StatusCode::BAD_REQUEST), "{codes:?}");
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS), "oversized sends are limited: {codes:?}");
}

#[tokio::test]
async fn dm_calls_get_built_ins_only_and_anyone_in_the_call_stops() {
    let w = world_with(|_| {}).await;
    let (_, guild_game) = w.app.post(&format!("/guilds/{}/games", w.guild), &w.owner, game("Codenames")).await;
    for (from, to) in [(&w.alice, &w.carl_id), (&w.carl, &w.alice_id)] {
        assert_eq!(w.app.put(&format!("/users/@me/relationships/{to}"), from).await.0, StatusCode::NO_CONTENT);
    }
    let (_, dm) = w.app.post("/users/@me/channels", &w.alice, json!({"recipient_id": w.carl_id})).await;
    let dm = dm["id"].as_str().expect("dm").to_owned();
    let path = format!("/channels/{dm}/game");
    let (mut alice_ws, _) = Client::identify(&w.address, &w.alice).await;
    let (mut carl_ws, _) = Client::identify(&w.address, &w.carl).await;
    alice_ws.voice(Some(&dm)).await;
    let (status, error) = w.app.put_json(&path, &w.alice, json!({"game_id": guild_game["id"]})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10090)), "no guild games in a DM call");
    let (status, session) = w.app.put_json(&path, &w.alice, json!({"game_id": "builtin:sketch"})).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(carl_ws.wait_for("GAME_UPDATE").await["state"], session);
    assert_eq!(alice_ws.wait_for("GAME_UPDATE").await["state"], session);
    carl_ws.voice(Some(&dm)).await;
    let (mut fresh, _) = Client::identify(&w.address, &w.carl).await;
    assert_eq!(fresh.wait_for("CALL_CREATE").await["game"], session, "CALL_CREATE carries the game");
    assert_eq!(w.app.delete(&path, &w.carl).await.0, StatusCode::NO_CONTENT, "anyone in a DM call stops it");
    assert!(alice_ws.wait_for("GAME_UPDATE").await["state"].is_null());
}
