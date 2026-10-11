#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Soundboard and entrance sounds: uploads (format, size, duration), permissions, limits, the per-channel play limit and
//! VOICE_CHANNEL_EFFECT_SEND fan-out to the users connected to the voice channel.
mod common;

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
use vokko_protocol::api::permissions::{CREATE_GUILD_EXPRESSIONS, DEFAULT_EVERYONE, MANAGE_GUILD_EXPRESSIONS, SPEAK, USE_EXTERNAL_SOUNDS, USE_SOUNDBOARD};
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

    /// Op 4 into `channel` (or out with `None`); waits for this session's VOICE_SERVER_UPDATE on a join.
    async fn voice(&mut self, channel: Option<&str>) {
        self.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": channel, "self_mute": false, "self_deaf": false, "self_video": false}})).await;
        if channel.is_some() {
            self.wait_for("VOICE_SERVER_UPDATE").await;
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await;
            match next {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let frame: Value = serde_json::from_str(&text).expect("json frame");
                    if frame["op"] == 0 && frame["t"] == name {
                        return frame["d"].clone();
                    }
                }
                Ok(Some(Ok(_))) => {}
                other => panic!("no {name}: {other:?}"),
            }
        }
    }

    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(text) = message {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == name {
                    return false;
                }
            }
        }
        true
    }
}

fn wav(seconds: f64, extra: usize) -> Vec<u8> {
    let rate = 8000_u32;
    let data = (seconds * f64::from(rate)) as u32 * 2 + extra as u32;
    let mut out = b"RIFF".to_vec();
    out.extend((36 + data).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16_u32.to_le_bytes());
    out.extend(1_u16.to_le_bytes());
    out.extend(1_u16.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * 2).to_le_bytes());
    out.extend(2_u16.to_le_bytes());
    out.extend(16_u16.to_le_bytes());
    out.extend(b"data");
    out.extend(data.to_le_bytes());
    out.resize(out.len() + data as usize, 0);
    out
}

async fn upload(app: &TestApp, token: &str, channel: &str, data: &[u8]) -> Value {
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s.wav\"\r\nContent-Type: application/octet-stream\r\n\r\n")
            .into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", token)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), 200);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("attachment json")
}

/// Status and content type of a GET without auth.
async fn fetch(app: &TestApp, url: &str) -> (StatusCode, String) {
    let path = url.strip_prefix("http://test.local").expect("test origin");
    let response = app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response");
    let content_type = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or_default().to_owned();
    (response.status(), content_type)
}

struct World {
    app: TestApp,
    address: String,
    owner: String,
    guild: String,
    text: String,
    voice: String,
    /// (token, user id)
    alice: (String, String),
    carl: (String, String),
    dana: (String, String),
}

async fn join(app: &TestApp, owner: &str, channel: &str, user: &str) {
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), owner, json!({})).await;
    let (status, body) = app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), user, json!({})).await;
    assert_eq!(status, StatusCode::OK, "join: {body}");
}

async fn world() -> World {
    let app = TestApp::with_room_service(
        |config| {
            config.livekit =
                Some(LiveKitConfig { url: "wss://lk.test".into(), api_url: "http://127.0.0.1:9".into(), api_key: "vokko".into(), api_secret: "s".into() })
        },
        FakeRoomService::new(),
    )
    .await;
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (guild, text) = app.guild_with_channel(&owner).await;
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &owner).await;
    let voice = channels.as_array().expect("channels").iter().find(|c| c["type"] == 2).expect("voice channel")["id"].as_str().expect("id").to_owned();
    let mut users = Vec::new();
    for name in ["alice", "carl", "dana"] {
        let (token, user) = app.register(name).await;
        join(&app, &owner, &text, &token).await;
        users.push((token, user["id"].as_str().expect("id").to_owned()));
    }
    let dana = users.pop().expect("dana");
    let carl = users.pop().expect("carl");
    let alice = users.pop().expect("alice");
    World { app, address, owner, guild, text, voice, alice, carl, dana }
}

impl World {
    async fn create(&self, token: &str, guild: &str, channel: &str, name: &str, data: &[u8]) -> (StatusCode, Value) {
        let attachment = upload(&self.app, token, channel, data).await;
        self.app.post(&format!("/guilds/{guild}/soundboard-sounds"), token, json!({"name": name, "attachment_id": attachment["id"], "emoji_name": "📯"})).await
    }

    async fn role(&self, user_id: &str, permissions: u64) {
        let (status, role) =
            self.app.post(&format!("/guilds/{}/roles", self.guild), &self.owner, json!({"name": "r", "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "{role}");
        let (status, body) = self.app.patch(&format!("/guilds/{}/members/{user_id}", self.guild), &self.owner, json!({"roles": [role["id"]]})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    async fn deny(&self, user_id: &str, bits: u64) {
        let body = json!({"type": 1, "allow": "0", "deny": bits.to_string()});
        let (status, body) = self.app.put_json(&format!("/channels/{}/permissions/{user_id}", self.voice), &self.owner, body).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }

    async fn allow_all(&self, user_id: &str) {
        let (status, _) = self.app.delete(&format!("/channels/{}/permissions/{user_id}", self.voice), &self.owner).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    async fn play(&self, token: &str, body: Value) -> (StatusCode, Value) {
        self.app.post(&format!("/channels/{}/send-soundboard-sound", self.voice), token, body).await
    }
}

#[tokio::test]
async fn sounds_lifecycle_validation_and_permissions() {
    let w = world().await;
    let (alice, alice_id) = w.alice.clone();
    let mut watcher = Client::identify(&w.address, &w.carl.0).await;

    // Default sounds: listed for everyone, their files are public WAVs.
    let (status, defaults) = w.app.get("/soundboard-default-sounds", &alice).await;
    assert_eq!(status, StatusCode::OK);
    let defaults = defaults.as_array().expect("array").clone();
    assert!(defaults.len() >= 4);
    assert!(defaults.iter().all(|sound| sound.get("guild_id").is_none() && sound["available"] == true));
    assert_eq!(fetch(&w.app, defaults[0]["url"].as_str().expect("url")).await, (StatusCode::OK, "audio/wav".to_owned()));

    // Without CREATE_GUILD_EXPRESSIONS (default for @everyone) a member cannot upload.
    let everyone = (DEFAULT_EVERYONE & !CREATE_GUILD_EXPRESSIONS).to_string();
    let (status, _) = w.app.patch(&format!("/guilds/{0}/roles/{0}", w.guild), &w.owner, json!({"permissions": everyone})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = w.create(&alice, &w.guild, &w.text, "nope", &wav(1.0, 0)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, sound) = w.create(&w.owner, &w.guild, &w.text, "airhorn", &wav(1.5, 0)).await;
    assert_eq!(status, StatusCode::OK, "{sound}");
    assert_eq!((sound["name"].clone(), sound["volume"].clone(), sound["emoji_name"].clone()), (json!("airhorn"), json!(1.0), json!("📯")));
    assert_eq!(sound["guild_id"], json!(w.guild));
    assert_eq!(fetch(&w.app, sound["url"].as_str().expect("url")).await, (StatusCode::OK, "audio/wav".to_owned()));
    let created = watcher.wait_for("GUILD_SOUNDBOARD_SOUND_CREATE").await;
    assert_eq!(created["sound_id"], sound["sound_id"]);
    let id = sound["sound_id"].as_str().expect("id").to_owned();

    // Bad files and fields.
    for (name, data, why) in [
        ("long", wav(5.3, 0), "longer than 5.2 s"),
        ("big", wav(1.0, 520 * 1024), "over 512 KiB"),
        ("text", b"definitely not audio".to_vec(), "not audio"),
        ("x", wav(1.0, 0), "name too short"),
    ] {
        let (status, body) = w.create(&w.owner, &w.guild, &w.text, name, &data).await;
        assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{why}: {body}");
    }
    assert_eq!(w.create(&w.owner, &w.guild, &w.text, "exact", &wav(5.2, 0)).await.0, StatusCode::OK, "5.2 s is allowed");
    let attachment = upload(&w.app, &w.owner, &w.text, &wav(1.0, 0)).await;
    let (status, _) = w
        .app
        .post(&format!("/guilds/{}/soundboard-sounds", w.guild), &w.owner, json!({"name": "loud", "attachment_id": attachment["id"], "volume": 1.5}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Listing and reading.
    let (_, list) = w.app.get(&format!("/guilds/{}/soundboard-sounds", w.guild), &alice).await;
    assert_eq!(list["items"].as_array().map(Vec::len), Some(2));
    let (status, body) = w.app.get(&format!("/guilds/{}/soundboard-sounds/123", w.guild), &alice).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!(10097)));
    let (status, _) = w.app.get(&format!("/guilds/{}/soundboard-sounds", w.guild), &w.app.register("outsider").await.0).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // CREATE_GUILD_EXPRESSIONS: create, edit and delete your own, not others'.
    w.role(&alice_id, CREATE_GUILD_EXPRESSIONS).await;
    let (status, own) = w.create(&alice, &w.guild, &w.text, "mine", &wav(0.5, 0)).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    let own_id = own["sound_id"].as_str().expect("id").to_owned();
    let (status, edited) =
        w.app.patch(&format!("/guilds/{}/soundboard-sounds/{own_id}", w.guild), &alice, json!({"name": "renamed", "volume": 0.25, "emoji_name": null})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!((edited["name"].clone(), edited["volume"].clone(), edited["emoji_name"].clone()), (json!("renamed"), json!(0.25), Value::Null));
    assert_eq!(watcher.wait_for("GUILD_SOUNDBOARD_SOUND_UPDATE").await["name"], "renamed");
    let (status, _) = w.app.patch(&format!("/guilds/{}/soundboard-sounds/{id}", w.guild), &alice, json!({"name": "stolen"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/guilds/{}/soundboard-sounds/{id}", w.guild), &alice).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/guilds/{}/soundboard-sounds/{own_id}", w.guild), &alice).await.0, StatusCode::NO_CONTENT);
    let deleted = watcher.wait_for("GUILD_SOUNDBOARD_SOUND_DELETE").await;
    assert_eq!(deleted, json!({"sound_id": own_id, "guild_id": w.guild}));
    assert_eq!(fetch(&w.app, own["url"].as_str().expect("url")).await.0, StatusCode::NOT_FOUND, "the file goes with the sound");

    // MANAGE_GUILD_EXPRESSIONS manages everyone's.
    w.role(&alice_id, MANAGE_GUILD_EXPRESSIONS).await;
    assert_eq!(w.app.patch(&format!("/guilds/{}/soundboard-sounds/{id}", w.guild), &alice, json!({"name": "horn"})).await.0, StatusCode::OK);

    // 48 per guild.
    for index in 0..46 {
        let (status, body) = w.create(&w.owner, &w.guild, &w.text, &format!("s{index}"), &wav(0.1, 0)).await;
        assert_eq!(status, StatusCode::OK, "{index}: {body}");
    }
    let (status, body) = w.create(&w.owner, &w.guild, &w.text, "one too many", &wav(0.1, 0)).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(30045)));

    // Deleting the channel the files were uploaded in keeps the sounds playable.
    let (status, _) = w.app.delete(&format!("/channels/{}", w.text), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetch(&w.app, sound["url"].as_str().expect("url")).await.0, StatusCode::OK);
}

#[tokio::test]
async fn ready_carries_the_guild_sounds() {
    let w = world().await;
    let (status, _) = w.create(&w.owner, &w.guild, &w.text, "airhorn", &wav(1.0, 0)).await;
    assert_eq!(status, StatusCode::OK);
    let (ws, _) = connect_async(format!("ws://{}/gateway", w.address)).await.expect("connect");
    let mut client = Client { ws };
    client.send(json!({"op": 2, "d": {"token": w.alice.0}})).await;
    let ready = client.wait_for("READY").await;
    let guild = ready["guilds"].as_array().expect("guilds").iter().find(|g| g["id"] == json!(w.guild)).expect("guild").clone();
    assert_eq!(guild["soundboard_sounds"][0]["name"], "airhorn");
}

#[tokio::test]
async fn playing_is_limited_and_reaches_only_the_channel() {
    let w = world().await;
    let (alice, alice_id) = w.alice.clone();
    let (carl, carl_id) = w.carl.clone();
    let (_, guild_sound) = w.create(&w.owner, &w.guild, &w.text, "airhorn", &wav(1.0, 0)).await;
    let guild_sound_id = guild_sound["sound_id"].as_str().expect("id").to_owned();

    // A second guild with a sound; alice is a member there, carl is not.
    let (other_guild, other_text) = w.app.guild_with_channel(&w.owner).await;
    join(&w.app, &w.owner, &other_text, &alice).await;
    let (_, external) = w.create(&w.owner, &other_guild, &other_text, "elsewhere", &wav(1.0, 0)).await;
    let external_id = external["sound_id"].as_str().expect("id").to_owned();

    let mut alice_ws = Client::identify(&w.address, &alice).await;
    let mut carl_ws = Client::identify(&w.address, &carl).await;
    let mut dana_ws = Client::identify(&w.address, &w.dana.0).await;

    // Not connected to the channel.
    let (status, _) = w.play(&alice, json!({"sound_id": "1"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = w.app.post(&format!("/channels/{}/send-soundboard-sound", w.text), &alice, json!({"sound_id": "1"})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(50024)), "text channels have no soundboard");

    alice_ws.voice(Some(&w.voice)).await;
    carl_ws.voice(Some(&w.voice)).await;

    // A default sound reaches everyone in the channel (sender included), not dana who only sees the channel.
    let (status, body) = w.play(&alice, json!({"sound_id": "1"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    for client in [&mut alice_ws, &mut carl_ws] {
        let effect = client.wait_for("VOICE_CHANNEL_EFFECT_SEND").await;
        assert_eq!(
            (effect["channel_id"].clone(), effect["user_id"].clone(), effect["sound_id"].clone(), effect["source_guild_id"].clone()),
            (json!(w.voice), json!(alice_id), json!("1"), Value::Null)
        );
        assert!(effect["sound_url"].as_str().expect("url").ends_with("/soundboard-default-sounds/1/file"));
        assert!(effect.get("entrance").is_none());
    }
    assert!(dana_ws.silent_for("VOICE_CHANNEL_EFFECT_SEND", Duration::from_millis(300)).await, "not in the channel");

    // One play per 3 s per user and channel.
    let request = Request::post(format!("/api/v1/channels/{}/send-soundboard-sound", w.voice))
        .header("authorization", alice.as_str())
        .header("content-type", "application/json")
        .body(Body::from(json!({"sound_id": guild_sound_id}).to_string()))
        .expect("request");
    let response = w.app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().get("retry-after").is_some());

    // The channel's own guild sound, with its volume and emoji.
    let (status, _) = w.play(&carl, json!({"sound_id": guild_sound_id})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let effect = alice_ws.wait_for("VOICE_CHANNEL_EFFECT_SEND").await;
    assert_eq!((effect["source_guild_id"].clone(), effect["sound_volume"].clone()), (json!(w.guild), json!(1.0)));
    assert_eq!(effect["emoji"], json!({"id": null, "name": "📯"}));
    assert_eq!(carl_ws.wait_for("VOICE_CHANNEL_EFFECT_SEND").await["sound_id"], json!(guild_sound_id), "the sender hears it too");

    // Another guild's sound: only for its members, and only with USE_EXTERNAL_SOUNDS.
    let (status, body) = w.play(&carl, json!({"sound_id": external_id, "source_guild_id": other_guild})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!(10097)), "carl is not in that guild");
    w.deny(&alice_id, USE_EXTERNAL_SOUNDS).await;
    let (status, _) = w.play(&alice, json!({"sound_id": external_id, "source_guild_id": other_guild})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    w.allow_all(&alice_id).await;
    tokio::time::sleep(Duration::from_millis(3000)).await;
    let (status, body) = w.play(&alice, json!({"sound_id": external_id, "source_guild_id": other_guild})).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "free external sounds: {body}");
    assert_eq!(carl_ws.wait_for("VOICE_CHANNEL_EFFECT_SEND").await["source_guild_id"], json!(other_guild));

    // USE_SOUNDBOARD and SPEAK are needed; a deafened user cannot play.
    w.deny(&carl_id, USE_SOUNDBOARD).await;
    assert_eq!(w.play(&carl, json!({"sound_id": "2"})).await.0, StatusCode::FORBIDDEN);
    w.deny(&carl_id, SPEAK).await;
    carl_ws.voice(None).await;
    carl_ws.voice(Some(&w.voice)).await;
    assert_eq!(w.play(&carl, json!({"sound_id": "2"})).await.0, StatusCode::FORBIDDEN, "suppressed");
    w.allow_all(&carl_id).await;
    carl_ws.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": w.voice, "self_mute": true, "self_deaf": true, "self_video": false}})).await;
    while carl_ws.wait_for("VOICE_STATE_UPDATE").await["self_deaf"] != true {}
    assert_eq!(w.play(&carl, json!({"sound_id": "2"})).await.0, StatusCode::FORBIDDEN, "self-deafened");
    assert_eq!(w.play(&alice, json!({"sound_id": "999"})).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn entrance_sound_plays_for_the_channel_on_join() {
    let w = world().await;
    let (alice, alice_id) = w.alice.clone();
    let (_, guild_sound) = w.create(&w.owner, &w.guild, &w.text, "hello", &wav(1.0, 0)).await;
    let guild_sound_id = guild_sound["sound_id"].as_str().expect("id").to_owned();
    let (other_guild, other_text) = w.app.guild_with_channel(&w.owner).await;
    let (_, other_sound) = w.create(&w.owner, &other_guild, &other_text, "elsewhere", &wav(1.0, 0)).await;

    let mut alice_ws = Client::identify(&w.address, &alice).await;
    let mut carl_ws = Client::identify(&w.address, &w.carl.0).await;

    // Only sounds alice may pick.
    let (status, body) = w
        .app
        .put_json("/users/@me/entrance-sounds", &alice, json!({"guild_id": null, "sound_id": other_sound["sound_id"], "source_guild_id": other_guild}))
        .await;
    assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!(10097)), "not a member of that guild");
    let (status, _) = w.app.put_json("/users/@me/entrance-sounds", &alice, json!({"guild_id": other_guild, "sound_id": "1"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a scope of a guild alice is not in");

    let (status, body) = w.app.put_json("/users/@me/entrance-sounds", &alice, json!({"guild_id": null, "sound_id": "3"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(alice_ws.wait_for("ENTRANCE_SOUNDS_UPDATE").await, body);
    let (status, body) =
        w.app.put_json("/users/@me/entrance-sounds", &alice, json!({"guild_id": w.guild, "sound_id": guild_sound_id, "source_guild_id": w.guild})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"entrance_sounds": [
            {"guild_id": null, "sound_id": "3", "source_guild_id": null},
            {"guild_id": w.guild, "sound_id": guild_sound_id, "source_guild_id": w.guild}
        ]})
    );
    assert_eq!(w.app.get("/users/@me/entrance-sounds", &alice).await.1, body);

    // Carl is in the channel; alice joins: the guild's entrance sound plays for both.
    carl_ws.voice(Some(&w.voice)).await;
    alice_ws.voice(Some(&w.voice)).await;
    for client in [&mut carl_ws, &mut alice_ws] {
        let effect = client.wait_for("VOICE_CHANNEL_EFFECT_SEND").await;
        assert_eq!((effect["user_id"].clone(), effect["sound_id"].clone(), effect["entrance"].clone()), (json!(alice_id), json!(guild_sound_id), json!(true)));
    }
    // A mute toggle is not a join.
    alice_ws.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": w.voice, "self_mute": true, "self_deaf": false, "self_video": false}})).await;
    assert!(carl_ws.silent_for("VOICE_CHANNEL_EFFECT_SEND", Duration::from_millis(300)).await);

    // Leaving and rejoining within the 3 s limit is silent.
    alice_ws.voice(None).await;
    alice_ws.voice(Some(&w.voice)).await;
    assert!(carl_ws.silent_for("VOICE_CHANNEL_EFFECT_SEND", Duration::from_millis(300)).await);
    tokio::time::sleep(Duration::from_millis(3000)).await;

    // Without the guild scope the global sound plays.
    let (status, _) = w.app.put_json("/users/@me/entrance-sounds", &alice, json!({"guild_id": w.guild, "sound_id": null})).await;
    assert_eq!(status, StatusCode::OK);
    alice_ws.voice(None).await;
    alice_ws.voice(Some(&w.voice)).await;
    assert_eq!(carl_ws.wait_for("VOICE_CHANNEL_EFFECT_SEND").await["sound_id"], "3");

    // Without USE_SOUNDBOARD nothing plays (waited out the limit first, so the permission is what stops it).
    tokio::time::sleep(Duration::from_millis(3100)).await;
    w.deny(&alice_id, USE_SOUNDBOARD).await;
    alice_ws.voice(None).await;
    alice_ws.voice(Some(&w.voice)).await;
    assert!(carl_ws.silent_for("VOICE_CHANNEL_EFFECT_SEND", Duration::from_millis(300)).await);
}
