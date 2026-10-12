#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Synced user settings, the privacy keys the server enforces, and the data export.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};

struct Gateway {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Gateway {
    async fn connect(address: &str, token: &str) -> Self {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{address}/gateway")).await.expect("connect");
        let mut gateway = Self { ws };
        gateway.next_frame().await;
        gateway.ws.send(tokio_tungstenite::tungstenite::Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        gateway.wait_for("READY").await;
        gateway
    }

    async fn next_frame(&mut self) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(8), self.ws.next()).await.expect("a frame in time") {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => return serde_json::from_str(&text).expect("json"),
                Some(Ok(_)) => continue,
                other => panic!("gateway closed: {other:?}"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.next_frame().await;
            if frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    /// No event called `name` arrives within `wait`.
    async fn assert_silent(&mut self, name: &str, wait: Duration) {
        let deadline = tokio::time::Instant::now() + wait;
        while let Ok(Some(Ok(frame))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let tokio_tungstenite::tungstenite::Message::Text(text) = frame {
                let value: Value = serde_json::from_str(&text).expect("json");
                assert_ne!(value["t"], name, "unexpected {name}: {value}");
            }
        }
    }
}

#[tokio::test]
async fn settings_start_empty_and_patch_merges_and_bumps_the_version() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sam").await;
    let (status, initial) = app.get("/users/@me/settings", &token).await;
    assert_eq!((status, initial), (StatusCode::OK, json!({"version": 0, "settings": {}})));

    let (status, saved) = app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"theme": "light", "time_format": "24"}})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved, json!({"version": 1, "settings": {"theme": "light", "time_format": "24"}}));

    // Absent keys stay, null removes a key.
    let (_, saved) = app.patch("/users/@me/settings", &token, json!({"version": 1, "settings": {"theme": null, "locale": "en-US"}})).await;
    assert_eq!(saved, json!({"version": 2, "settings": {"time_format": "24", "locale": "en-US"}}));
    assert_eq!(app.get("/users/@me/settings", &token).await.1, saved);

    // Settings are per user.
    let (other, _) = app.register("alice").await;
    assert_eq!(app.get("/users/@me/settings", &other).await.1, json!({"version": 0, "settings": {}}));
}

#[tokio::test]
async fn unknown_keys_and_bad_values_are_rejected_without_saving_anything() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sam").await;
    let (status, body) = app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"theme": "dark", "made_up": true}})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    assert!(body["errors"]["settings"]["made_up"].is_object(), "{body}");
    assert!(body["errors"]["settings"].get("theme").is_none());
    for (key, value) in [("theme", json!(7)), ("message_group_gap", json!(99)), ("developer_mode", json!("yes")), ("disabled_sounds", json!([1]))] {
        let (status, _) = app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {key: value}})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{key}");
    }
    let (status, _) =
        app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"keybinds": [{"action": "x", "keys": "Ctrl+K", "global": "no"}]}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A null for an unknown key is still an unknown key.
    assert_eq!(app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"made_up": null}})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.get("/users/@me/settings", &token).await.1, json!({"version": 0, "settings": {}}));
}

#[tokio::test]
async fn the_blob_is_capped_at_64_kib() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sam").await;
    let binds = |count: usize| -> Vec<Value> { (0..count).map(|i| json!({"action": format!("{i:0>64}"), "keys": "k".repeat(64)})).collect() };
    // ~155 bytes per bind: 300 fit, 512 (each value valid on its own) do not.
    let (status, body) = app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"keybinds": binds(300)}})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = app.patch("/users/@me/settings", &token, json!({"version": 1, "settings": {"keybinds": binds(512)}})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{body}");
    let (_, stored) = app.get("/users/@me/settings", &token).await;
    assert_eq!((stored["version"].clone(), stored["settings"]["keybinds"].as_array().map(Vec::len)), (json!(1), Some(300)));
}

#[tokio::test]
async fn a_stale_version_gets_409_with_the_current_blob() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sam").await;
    app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"theme": "onyx"}})).await;
    let (status, body) = app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"theme": "light"}})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({"code": 40090, "message": "Settings version conflict", "version": 1, "settings": {"theme": "onyx"}}));
    let (status, body) = app.patch("/users/@me/settings", &token, json!({"version": 7, "settings": {}})).await;
    assert_eq!((status, body["version"].clone()), (StatusCode::CONFLICT, json!(1)));
    // Retrying on the current version works.
    let (status, body) = app.patch("/users/@me/settings", &token, json!({"version": 1, "settings": {"theme": "light"}})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"version": 2, "settings": {"theme": "light"}})));
}

#[tokio::test]
async fn updates_fan_out_to_every_session_of_the_user_only() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sam").await;
    let (other, _) = app.register("alice").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &token, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &other, json!({})).await;
    let address = app.serve().await;
    let mut desktop = Gateway::connect(&address, &token).await;
    let mut laptop = Gateway::connect(&address, &token).await;
    let mut stranger = Gateway::connect(&address, &other).await;

    let (_, saved) = app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"developer_mode": true}})).await;
    let expected = json!({"version": 1, "settings": {"developer_mode": true}});
    assert_eq!(saved, expected);
    assert_eq!(desktop.wait_for("USER_SETTINGS_UPDATE").await, expected);
    assert_eq!(laptop.wait_for("USER_SETTINGS_UPDATE").await, expected);
    stranger.assert_silent("USER_SETTINGS_UPDATE", Duration::from_millis(300)).await;

    // A rejected PATCH sends nothing.
    app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"developer_mode": false}})).await;
    desktop.assert_silent("USER_SETTINGS_UPDATE", Duration::from_millis(300)).await;
}

#[tokio::test]
async fn privacy_settings_gate_dms_and_friend_requests() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (bob, bob_user) = app.register("bob").await;
    let alice_id = alice_user["id"].as_str().expect("id").to_owned();
    let bob_id = bob_user["id"].as_str().expect("id").to_owned();
    let (_, channel) = app.guild_with_channel(&owner).await;
    for token in [&alice, &bob] {
        let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
        app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), token, json!({})).await;
    }

    // Alice turns off DMs from server members and every friend request source but shared servers.
    let off = json!({"version": 0, "settings": {"dms_from_server_members": false, "friend_requests_everyone": false, "friend_requests_mutual_friends": false}});
    assert_eq!(app.patch("/users/@me/settings", &alice, off).await.0, StatusCode::OK);
    let (status, body) = app.post("/users/@me/channels", &bob, json!({"recipient_id": alice_id})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::FORBIDDEN, json!(50007)));
    // Alice can still DM bob (his defaults allow it).
    assert_eq!(app.post("/users/@me/channels", &alice, json!({"recipient_id": bob_id})).await.0, StatusCode::OK);

    // A shared server still allows a friend request; once friends, DMs work.
    assert_eq!(app.put(&format!("/users/@me/relationships/{alice_id}"), &bob).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&format!("/users/@me/relationships/{bob_id}"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.post("/users/@me/channels", &bob, json!({"recipient_id": alice_id})).await.0, StatusCode::OK);

    // A stranger without a shared server is refused with 80000 once only mutual guilds are allowed.
    let (carol, _) = app.register("carol").await;
    let (status, body) = app.post("/users/@me/relationships", &carol, json!({"username": "alice"})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::FORBIDDEN, json!(80000)));
    // With everything off nobody gets through; back on, carol can ask.
    app.patch("/users/@me/settings", &alice, json!({"version": 1, "settings": {"friend_requests_everyone": true}})).await;
    assert_eq!(app.post("/users/@me/relationships", &carol, json!({"username": "alice"})).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn export_returns_own_data_once_per_day() {
    let app = TestApp::new().await;
    let (token, me) = app.register("sam").await;
    let (other, _) = app.register("alice").await;
    let (guild, channel) = app.guild_with_channel(&token).await;
    app.post(&format!("/channels/{channel}/messages"), &token, json!({"content": "mine"})).await;
    app.patch(&format!("/users/@me/guilds/{guild}/privacy"), &token, json!({"direct_messages": false})).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &token, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &other, json!({})).await;
    app.post(&format!("/channels/{channel}/messages"), &other, json!({"content": "not mine"})).await;
    app.patch("/users/@me/settings", &token, json!({"version": 0, "settings": {"locale": "en-US"}})).await;

    let (status, export) = app.get("/users/@me/export", &token).await;
    assert_eq!(status, StatusCode::OK, "{export}");
    assert_eq!(export["user"]["id"], me["id"]);
    assert_eq!(export["settings"], json!({"version": 1, "settings": {"locale": "en-US"}}));
    let contents: Vec<&str> = export["messages"].as_array().expect("messages").iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(contents, vec!["mine"]);
    assert_eq!(export["messages_truncated"], json!(false));
    assert_eq!(export["dm_restricted_guild_ids"], json!([guild]));
    assert_eq!(export["guilds"].as_array().map(Vec::len), Some(1));
    assert!(export["channels"].as_array().expect("channels").iter().any(|c| c["id"] == channel));

    let (status, limited) = app.get("/users/@me/export", &token).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(limited["retry_after"].as_f64().expect("retry_after") > 86_000.0, "{limited}");
    // The limit is per user and leaves the settings alone.
    assert_eq!(app.get("/users/@me/export", &other).await.0, StatusCode::OK);
    assert_eq!(app.get("/users/@me/settings", &token).await.1["version"], json!(1));

    // A day later it works again.
    sqlx::query("UPDATE user_settings SET last_export_at = now() - interval '25 hours'").execute(&app.state.db).await.expect("age the export");
    assert_eq!(app.get("/users/@me/export", &token).await.0, StatusCode::OK);
}
