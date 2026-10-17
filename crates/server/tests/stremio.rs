#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Stremio in voice calls (docs/design/stremio-bot.md): account linking, browsing, stream lists, playback sessions, the bot
//! contract, security rules and lifecycle, against a mock Stremio/addon/Cinemeta server and a fake bot. No real service is called.
mod common;

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;
use vokko_protocol::api::permissions::{CONNECT, VIEW_CHANNEL};
use vokko_server::config::{Cidr, Config, LiveKitConfig, StremioConfig};
use vokko_server::crypto::SecretsKey;
use vokko_server::voice::livekit::FakeRoomService;
use vokko_server::voice::token;

const MEDIA_KEY: &str = "media-key";
const MEDIA_SECRET: &str = "media-secret-media-secret";
const BOT_SECRET: &str = "bot-secret-0123456789";
const POSTER: &str = "https://images.metahub.space/poster/small/tt0113277/img";

// ---- the mock Stremio / addon / Cinemeta / media server ----

struct Mock {
    base: String,
    dead: AtomicBool,
    approved: AtomicBool,
    logouts: AtomicUsize,
    redirect_hits: AtomicUsize,
}

fn ok(result: Value) -> Json<Value> {
    Json(json!({"result": result}))
}

fn fail(code: i64) -> Json<Value> {
    Json(json!({"error": {"code": code, "message": "no"}}))
}

async fn login(Json(body): Json<Value>) -> Json<Value> {
    if body["password"] == "pw" { ok(json!({"authKey": "AUTHKEY-1", "user": {}})) } else { fail(2) }
}

async fn get_user(State(mock): State<Arc<Mock>>) -> Json<Value> {
    if mock.dead.load(Ordering::SeqCst) { fail(1) } else { ok(json!({"_id": "u"})) }
}

async fn logout(State(mock): State<Arc<Mock>>) -> Json<Value> {
    mock.logouts.fetch_add(1, Ordering::SeqCst);
    ok(json!({"success": true}))
}

async fn addon_collection(State(mock): State<Arc<Mock>>) -> Json<Value> {
    let manifest = |name: &str| json!({"name": name, "resources": ["stream"], "types": ["movie", "series"], "idPrefixes": ["tt"]});
    ok(json!({"addons": [
        {"transportUrl": format!("{}/addon-a/SECRETCFG/manifest.json", mock.base), "manifest": manifest("Addon A")},
        {"transportUrl": format!("{}/addon-b/SECRETCFG2/manifest.json", mock.base), "manifest": manifest("Broken")},
        {"transportUrl": "http://localhost:11470/local-addon/manifest.json", "manifest": manifest("Local Files")},
    ]}))
}

async fn addon_a_streams(State(mock): State<Arc<Mock>>) -> Json<Value> {
    let base = &mock.base;
    Json(json!({"streams": [
        {"name": "A 1080p", "description": "Movie.1080p.WEB-DL\n3.2 GB", "url": format!("{base}/media/redirect"),
         "behaviorHints": {"videoSize": 3_400_000_000_u64, "proxyHeaders": {"request": {"User-Agent": "UA-test", "Authorization": "secret"}}}},
        {"name": "A 720p", "description": "Movie.720p.WEB-DL\n1.1 GB", "url": format!("{base}/media/second.mkv"), "behaviorHints": {"videoSize": 1_100_000_000_u64}},
        {"name": "Torrent 1080p", "infoHash": "abcdef"},
        {"name": "Private 1080p", "url": "http://10.0.0.5/x.mkv"},
    ]}))
}

async fn addon_b_streams() -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn media_redirect(State(mock): State<Arc<Mock>>) -> Response {
    mock.redirect_hits.fetch_add(1, Ordering::SeqCst);
    (StatusCode::FOUND, [(header::LOCATION, "/media/final.mkv")]).into_response()
}

async fn media_file() -> Response {
    (StatusCode::PARTIAL_CONTENT, [(header::CONTENT_TYPE, "video/x-matroska")], vec![0_u8]).into_response()
}

async fn catalog() -> Json<Value> {
    Json(json!({"metas": [
        {"id": "tt0113277", "name": "Heat", "poster": POSTER, "releaseInfo": "1995"},
        {"id": "tt0000002", "name": "Evil poster", "poster": "https://evil.example/p.jpg"},
        {"id": "yt_bad", "name": "Not an IMDb id"},
    ]}))
}

async fn cinemeta_meta(Path((kind, _file)): Path<(String, String)>) -> Json<Value> {
    if kind == "series" {
        return Json(json!({"meta": {"name": "Breaking", "poster": POSTER, "background": "https://evil.example/b.jpg", "videos": [
            {"id": "tt0903747:1:2", "season": 1, "episode": 2, "name": "Cat", "thumbnail": "https://episodes.metahub.space/x.jpg"},
            {"id": "tt0903747:1:3", "season": 1, "episode": 3, "name": "Bag", "thumbnail": "https://evil.example/t.jpg"},
            {"id": "bad", "season": 1, "episode": 4, "name": "Dropped"},
        ]}}));
    }
    Json(json!({"meta": {"name": "Heat", "poster": POSTER, "releaseInfo": "1995", "runtime": "170 min"}}))
}

async fn link_create() -> Json<Value> {
    ok(json!({"code": "ABCD", "link": "https://link.example/ABCD"}))
}

async fn link_read(State(mock): State<Arc<Mock>>) -> Json<Value> {
    if mock.approved.load(Ordering::SeqCst) { ok(json!({"authKey": "AUTHKEY-LINK"})) } else { fail(101) }
}

async fn start_mock() -> Arc<Mock> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let mock = Arc::new(Mock {
        base,
        dead: AtomicBool::new(false),
        approved: AtomicBool::new(false),
        logouts: AtomicUsize::new(0),
        redirect_hits: AtomicUsize::new(0),
    });
    let router = Router::new()
        .route("/api/login", post(login))
        .route("/api/getUser", post(get_user))
        .route("/api/logout", post(logout))
        .route("/api/addonCollectionGet", post(addon_collection))
        .route("/addon-a/SECRETCFG/stream/{kind}/{file}", get(addon_a_streams))
        .route("/addon-b/SECRETCFG2/stream/{kind}/{file}", get(addon_b_streams))
        .route("/media/redirect", get(media_redirect))
        .route("/media/final.mkv", get(media_file))
        .route("/media/second.mkv", get(media_file))
        .route("/cinemeta/catalog/{kind}/top.json", get(catalog))
        .route("/cinemeta/catalog/{kind}/top/{extra}", get(catalog))
        .route("/cinemeta/meta/{kind}/{file}", get(cinemeta_meta))
        .route("/link/api/v2/create", get(link_create))
        .route("/link/api/v2/read", get(link_read))
        .with_state(mock.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    mock
}

// ---- the fake bot ----

#[derive(Clone, Debug)]
struct BotRequest {
    method: String,
    path: String,
    authorized: bool,
    body: Value,
}

#[derive(Default)]
struct Bot {
    requests: Mutex<Vec<BotRequest>>,
    status: AtomicU16,
}

impl Bot {
    fn answer(&self, status: u16) {
        self.status.store(status, Ordering::SeqCst);
    }

    fn all(&self) -> Vec<BotRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// Bodies of the `PUT /sessions/{channel}` calls, oldest first.
    fn puts(&self, channel: &str) -> Vec<Value> {
        self.all().into_iter().filter(|request| request.method == "PUT" && request.path == format!("/sessions/{channel}")).map(|request| request.body).collect()
    }

    fn deletes(&self, path: &str) -> usize {
        self.all().iter().filter(|request| request.method == "DELETE" && request.path == path).count()
    }
}

async fn bot_handler(State(bot): State<Arc<Bot>>, request: Request<Body>) -> StatusCode {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap_or_default();
    let authorized = parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()) == Some(&format!("Bearer {BOT_SECRET}"));
    bot.requests.lock().unwrap().push(BotRequest {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        authorized,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    });
    if !authorized {
        return StatusCode::UNAUTHORIZED;
    }
    match bot.status.load(Ordering::SeqCst) {
        0 => StatusCode::OK,
        status => StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
    }
}

async fn start_bot() -> (Arc<Bot>, String) {
    let bot = Arc::new(Bot::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    let router = Router::new().fallback(bot_handler).with_state(bot.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (bot, url)
}

// ---- gateway client (as in voice.rs) ----

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> (Self, Value) {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        assert_eq!(client.recv().await.expect("hello")["op"], 10);
        client.send(json!({"op": 2, "d": {"token": token}})).await;
        let ready = client.wait_for("READY").await;
        (client, ready)
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
    }

    async fn voice(&mut self, channel: Option<&str>) {
        self.send(json!({"op": 4, "d": {"guild_id": null, "channel_id": channel, "self_mute": false, "self_deaf": false, "self_video": false}})).await;
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

    async fn voice_answer(&mut self) {
        loop {
            let frame = self.recv().await.expect("voice answer");
            if frame["op"] == 0 && (frame["t"] == "VOICE_SERVER_UPDATE" || frame["t"] == "VOICE_CONNECT_FAILED") {
                assert_eq!(frame["t"], "VOICE_SERVER_UPDATE", "{frame}");
                return;
            }
        }
    }

    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            match next {
                Some(Ok(Message::Text(text))) => {
                    if serde_json::from_str::<Value>(&text).expect("json")["t"] == name {
                        return false;
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
        true
    }

    async fn stremio(&mut self) -> Value {
        self.wait_for("STREMIO_UPDATE").await
    }
}

// ---- the world ----

struct World {
    app: TestApp,
    mock: Arc<Mock>,
    bot: Arc<Bot>,
    address: String,
    voice: String,
    owner: String,
    alice: String,
    alice_id: String,
    carl: String,
    carl_id: String,
}

/// Quick timers; the lease is long unless a test shortens it. The ticker only runs where a test starts it.
fn tune_default(config: &mut StremioConfig) {
    config.tick = Duration::from_millis(50);
    config.event_grace = Duration::from_millis(100);
    config.error_hold = Duration::from_millis(600);
}

async fn world() -> World {
    world_with(tune_default, |_| {}).await
}

async fn world_with(tune: impl FnOnce(&mut StremioConfig), adjust: impl FnOnce(&mut Config)) -> World {
    let mock = start_mock().await;
    let (bot, bot_url) = start_bot().await;
    let mut stremio = StremioConfig::new(
        SecretsKey::from_bytes([7; 32]),
        "wss://media.test".to_owned(),
        MEDIA_KEY.to_owned(),
        MEDIA_SECRET.to_owned(),
        bot_url,
        BOT_SECRET.to_owned(),
    );
    stremio.bot_media_url = "ws://127.0.0.1:7880".to_owned();
    stremio.fetch_allow = vec![Cidr::parse("127.0.0.1/32").expect("range")];
    stremio.api_url = mock.base.clone();
    stremio.link_url = format!("{}/link", mock.base);
    stremio.cinemeta_url = format!("{}/cinemeta", mock.base);
    tune_default(&mut stremio);
    tune(&mut stremio);
    let app = TestApp::with_room_service(
        |config| {
            config.livekit = vec![LiveKitConfig {
                url: "wss://lk.test".into(),
                api_url: "http://127.0.0.1:9".into(),
                api_key: "vokko".into(),
                api_secret: "test-secret".into(),
                label: "test".into(),
            }];
            config.stremio = Some(stremio);
            adjust(config);
        },
        FakeRoomService::new(),
    )
    .await;
    build(app, mock, bot).await
}

async fn build(app: TestApp, mock: Arc<Mock>, bot: Arc<Bot>) -> World {
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
    World { app, mock, bot, address, voice, owner, alice, alice_id: id(&alice_user), carl, carl_id: id(&carl_user) }
}

impl World {
    fn path(&self) -> String {
        format!("/channels/{}/stremio", self.voice)
    }

    async fn link(&self, token: &str) {
        let (status, body) = self.app.post("/users/@me/stremio/login", token, json!({"email": "a@b.test", "password": "pw"})).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }

    async fn join(&self, client: &mut Client) {
        client.voice(Some(&self.voice)).await;
        client.voice_answer().await;
    }

    async fn streams(&self, token: &str) -> Value {
        let (status, body) = self.app.get("/stremio/streams/movie/tt0111161", token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// The `sid` of the listed stream called `label`.
    fn sid(streams: &Value, label: &str) -> String {
        streams["streams"].as_array().expect("streams").iter().find(|stream| stream["label"] == label).unwrap_or_else(|| panic!("no stream {label}: {streams}"))
            ["sid"]
            .as_str()
            .expect("sid")
            .to_owned()
    }

    /// alice is linked and in the call, and the stream `label` of a movie is playing.
    async fn playing(&self, alice: &mut Client, label: &str) -> Value {
        self.link(&self.alice).await;
        self.join(alice).await;
        let sid = Self::sid(&self.streams(&self.alice).await, label);
        let (status, state) = self.app.put_json(&self.path(), &self.alice, json!({"sid": sid})).await;
        assert_eq!(status, StatusCode::OK, "{state}");
        state
    }

    async fn bot_event(&self, bearer: &str, body: Value) -> StatusCode {
        let request = Request::post("/internal/stremio/bot")
            .header("authorization", format!("Bearer {bearer}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        self.app.router.clone().oneshot(request).await.expect("response").status()
    }

    async fn event(&self, event: &str, extra: Value) -> StatusCode {
        let mut body = json!({"channel_id": self.voice, "event": event, "position_ms": 0});
        body.as_object_mut().expect("object").extend(extra.as_object().expect("object").clone());
        self.bot_event(BOT_SECRET, body).await
    }

    async fn overwrite(&self, target: &str, kind: u8, deny: u64) {
        let (status, body) = self
            .app
            .put_json(&format!("/channels/{}/permissions/{target}", self.voice), &self.owner, json!({"type": kind, "allow": "0", "deny": deny.to_string()}))
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
}

/// The bot's lease on a changed item: time in the middle is never needed, only that stale events are over.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(160)).await;
}

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..120 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Nothing a client can see may carry a secret: the authKey, the addon's configuration, any stream or resolved media URL.
fn assert_no_secrets(what: &str, value: &Value) {
    let text = value.to_string();
    for secret in ["AUTHKEY", "SECRETCFG", "127.0.0.1", "final.mkv", "second.mkv", "media/redirect", "10.0.0.5", "secret.example", BOT_SECRET, MEDIA_SECRET] {
        assert!(!text.contains(secret), "{what} leaks {secret}: {text}");
    }
}

/// The only URLs in a session state are poster images from Stremio's own hosts.
fn assert_no_urls(state: &Value) {
    fn walk(value: &Value, path: &str) {
        match value {
            Value::String(text) => {
                assert!(!text.contains("://") || (path.ends_with("poster") && text.starts_with("https://images.metahub.space/")), "{path}: {text}")
            }
            Value::Array(items) => items.iter().enumerate().for_each(|(index, item)| walk(item, &format!("{path}[{index}]"))),
            Value::Object(map) => map.iter().for_each(|(key, item)| walk(item, &format!("{path}.{key}"))),
            _ => {}
        }
    }
    walk(state, "state");
}

// ---- tests ----

#[tokio::test]
async fn every_route_is_404_without_the_feature() {
    let app = TestApp::with_config(|_| {}).await;
    let (token, _) = app.register("alice").await;
    for (method, path) in [
        ("GET", "/users/@me/stremio"),
        ("DELETE", "/users/@me/stremio"),
        ("POST", "/users/@me/stremio/link"),
        ("POST", "/users/@me/stremio/link/poll"),
        ("POST", "/users/@me/stremio/login"),
        ("GET", "/stremio/search?type=movie&q=heat"),
        ("GET", "/stremio/catalog?type=movie"),
        ("GET", "/stremio/meta/movie/tt0113277"),
        ("GET", "/stremio/streams/movie/tt0113277"),
        ("PUT", "/channels/1/stremio"),
        ("PATCH", "/channels/1/stremio"),
        ("DELETE", "/channels/1/stremio"),
        ("POST", "/channels/1/stremio/viewer-token"),
    ] {
        let body = (method != "GET" && method != "DELETE").then(|| json!({"sid": "x", "email": "a@b.test", "password": "pw"}));
        let (status, reply) = app.send(method.parse().expect("method"), path, Some(&token), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {reply}");
    }
    let request = Request::post("/internal/stremio/bot")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"channel_id":"1","event":"ended"}"#))
        .expect("request");
    assert_eq!(app.router.clone().oneshot(request).await.expect("response").status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn linking_by_code_and_by_login_stores_a_sealed_key() {
    let w = world().await;
    let (status, state) = w.app.get("/users/@me/stremio", &w.alice).await;
    assert_eq!((status, state["linked"].as_bool()), (StatusCode::OK, Some(false)));
    assert_eq!(w.app.post("/users/@me/stremio/link/poll", &w.alice, json!({})).await.0, StatusCode::BAD_REQUEST, "no link started");

    let (status, started) = w.app.post("/users/@me/stremio/link", &w.alice, json!({})).await;
    assert_eq!((status, started["code"].as_str(), started["link"].as_str()), (StatusCode::OK, Some("ABCD"), Some("https://link.example/ABCD")));
    assert!(started["expires_at"].is_string());
    assert_eq!(w.app.post("/users/@me/stremio/link/poll", &w.alice, json!({})).await.1["linked"], false, "not approved yet");
    w.mock.approved.store(true, Ordering::SeqCst);
    assert_eq!(w.app.post("/users/@me/stremio/link/poll", &w.alice, json!({})).await.1["linked"], true);
    let (_, state) = w.app.get("/users/@me/stremio", &w.alice).await;
    assert_eq!(state["linked"], true);
    assert!(state["linked_at"].is_string());
    assert_no_secrets("the account status", &state);

    // The key is encrypted at rest, and bound to the user: the same bytes under another user's id do not open.
    let alice_id: i64 = w.alice_id.parse().expect("id");
    let (sealed,): (Vec<u8>,) =
        sqlx::query_as("SELECT auth_key_enc FROM stremio_accounts WHERE user_id = $1").bind(alice_id).fetch_one(&w.app.state.db).await.expect("row");
    assert!(sealed.len() > 24 + 16 && !sealed.windows(7).any(|window| window == b"AUTHKEY"), "sealed, not plain");
    let key = SecretsKey::from_bytes([7; 32]);
    assert_eq!(key.open(format!("stremio:{alice_id}").as_bytes(), &sealed).as_deref(), Some(&b"AUTHKEY-LINK"[..]));
    assert!(key.open(format!("stremio:{}", alice_id + 1).as_bytes(), &sealed).is_none());

    // Login: a wrong password is a 400, the password is never stored, and unlinking logs out of Stremio.
    let (status, _) = w.app.post("/users/@me/stremio/login", &w.carl, json!({"email": "c@d.test", "password": "wrong"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.get("/users/@me/stremio", &w.carl).await.1["linked"], false);
    w.link(&w.carl).await;
    let (stored,): (Vec<u8>,) = sqlx::query_as("SELECT auth_key_enc FROM stremio_accounts WHERE user_id = $1")
        .bind(w.carl_id.parse::<i64>().expect("id"))
        .fetch_one(&w.app.state.db)
        .await
        .expect("row");
    assert!(!stored.windows(2).any(|window| window == b"pw"), "no password in the row");
    assert_eq!(w.app.delete("/users/@me/stremio", &w.carl).await.0, StatusCode::NO_CONTENT);
    until("the logout", || w.mock.logouts.load(Ordering::SeqCst) == 1).await;
    assert_eq!(w.app.get("/users/@me/stremio", &w.carl).await.1["linked"], false);
    assert_eq!(w.app.get("/stremio/streams/movie/tt0111161", &w.carl).await.0, StatusCode::FORBIDDEN, "not linked");
}

#[tokio::test]
async fn a_dead_stremio_session_unlinks_the_account() {
    let w = world().await;
    w.link(&w.alice).await;
    w.mock.dead.store(true, Ordering::SeqCst);
    // Stremio no longer knows the key: the next use of the account forgets it (here: relinking checks it).
    let (status, _) = w.app.post("/users/@me/stremio/login", &w.alice, json!({"email": "a@b.test", "password": "pw"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "login does not call getUser");
    w.mock.approved.store(true, Ordering::SeqCst);
    w.app.post("/users/@me/stremio/link", &w.alice, json!({})).await;
    assert_eq!(w.app.post("/users/@me/stremio/link/poll", &w.alice, json!({})).await.0, StatusCode::FORBIDDEN, "the approved key is dead");
}

#[tokio::test]
async fn browsing_validates_ids_and_filters_images() {
    let w = world().await;
    let (status, found) = w.app.get("/stremio/search?type=movie&q=heat", &w.alice).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    let titles = found.as_array().expect("titles");
    assert_eq!(titles.len(), 2, "the entry with a bad id is dropped: {found}");
    assert_eq!((titles[0]["id"].as_str(), titles[0]["poster"].as_str(), titles[0]["year"].as_str()), (Some("tt0113277"), Some(POSTER), Some("1995")));
    assert!(titles[1]["poster"].is_null(), "a poster from another host is dropped");
    assert_eq!(w.app.get("/stremio/catalog?type=series&genre=Action&skip=20", &w.alice).await.0, StatusCode::OK);

    for bad in [
        "/stremio/search?type=anime&q=x",
        "/stremio/search?type=movie&q=",
        "/stremio/search?type=movie&q=a%E2%80%AEb",
        "/stremio/catalog?type=movie&genre=a%2Fb",
        "/stremio/catalog?type=movie&skip=99999",
    ] {
        assert_eq!(w.app.get(bad, &w.alice).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(w.app.get(&format!("/stremio/search?type=movie&q={}", "x".repeat(101)), &w.alice).await.0, StatusCode::BAD_REQUEST);

    let (status, meta) = w.app.get("/stremio/meta/series/tt0903747", &w.alice).await;
    assert_eq!(status, StatusCode::OK, "{meta}");
    assert_eq!((meta["name"].as_str(), meta["poster"].as_str()), (Some("Breaking"), Some(POSTER)));
    assert!(meta["background"].is_null(), "background from another host is dropped");
    let videos = meta["videos"].as_array().expect("videos");
    assert_eq!(videos.len(), 2, "an episode with a bad id is dropped");
    assert_eq!(videos[0]["thumbnail"], "https://episodes.metahub.space/x.jpg");
    assert!(videos[1]["thumbnail"].is_null(), "thumbnail from another host is dropped");
    for bad in [
        "/stremio/meta/series/tt0903747:1:2",
        "/stremio/meta/series/yt1",
        "/stremio/meta/series/tt",
        "/stremio/meta/series/tt1%2F..%2Fx",
        "/stremio/meta/anime/tt1",
    ] {
        assert_eq!(w.app.get(bad, &w.alice).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    for bad in ["tt", "tt0903747:1", "tt0903747:1:2:3", "tt0903747:a:2", "tt1%2F..%2Fx", "xx1", "tt12345678901"] {
        assert_eq!(w.app.get(&format!("/stremio/streams/series/{bad}"), &w.alice).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(w.app.get("/stremio/streams/movie/tt0111161", &w.alice).await.0, StatusCode::FORBIDDEN, "alice has not linked an account");
}

#[tokio::test]
async fn stream_lists_hide_urls_and_sids_belong_to_their_user() {
    let w = world().await;
    w.link(&w.alice).await;
    w.link(&w.carl).await;
    let listing = w.streams(&w.alice).await;
    assert_no_secrets("the stream list", &listing);
    assert_eq!(listing["addon_errors"], json!(["Broken"]), "the failing addon is named, the local one is never called");
    let streams = listing["streams"].as_array().expect("streams");
    assert_eq!(streams.len(), 4, "{listing}");
    assert_eq!(streams[0]["label"], "A 1080p", "playable and closest to 1080p first");
    assert_eq!((streams[0]["playable"].as_bool(), streams[0]["resolution"].as_u64(), streams[0]["addon"].as_str()), (Some(true), Some(1080), Some("Addon A")));
    for key in streams[0].as_object().expect("object").keys() {
        assert!(["sid", "addon", "label", "details", "size_bytes", "resolution", "flags", "playable", "unsupported"].contains(&key.as_str()), "{key}");
    }
    let torrent = streams.iter().find(|stream| stream["label"] == "Torrent 1080p").expect("torrent");
    assert_eq!((torrent["playable"].as_bool(), torrent["unsupported"].as_str()), (Some(false), Some("torrent")));
    let private = streams.iter().find(|stream| stream["label"] == "Private 1080p").expect("private");
    assert_eq!(private["playable"], false, "a link the server would never open is not playable");

    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.join(&mut alice).await;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.join(&mut carl).await;
    let sid = World::sid(&listing, "A 1080p");
    // carl cannot play, or queue, what alice listed; unknown and unplayable sids are refused.
    assert_eq!(w.app.put_json(&w.path(), &w.carl, json!({"sid": sid})).await.0, StatusCode::BAD_REQUEST);
    assert!(w.bot.puts(&w.voice).is_empty());
    assert_eq!(w.app.put_json(&w.path(), &w.alice, json!({"sid": "nope"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.put_json(&w.path(), &w.alice, json!({"sid": World::sid(&listing, "Torrent 1080p")})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.put_json(&w.path(), &w.alice, json!({"sid": World::sid(&listing, "Private 1080p")})).await.0, StatusCode::BAD_REQUEST);
    let (status, state) = w.app.put_json(&w.path(), &w.alice, json!({"sid": sid})).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(w.app.patch(&w.path(), &w.carl, json!({"queue_add": sid})).await.0, StatusCode::BAD_REQUEST, "carl cannot queue alice's sid");
    // Streams of another title are distinct ids again.
    let again = w.streams(&w.alice).await;
    assert_ne!(World::sid(&again, "A 1080p"), sid);
}

#[tokio::test]
async fn playing_follows_the_bot_contract_and_shows_no_urls() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.overwrite(&w.carl_id, 1, VIEW_CHANNEL).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let state = w.playing(&mut alice, "A 1080p").await;
    let ch = w.voice.clone();

    // What the bot is told.
    let puts = w.bot.puts(&ch);
    assert_eq!(puts.len(), 1);
    let put = &puts[0];
    assert!(w.bot.all().iter().filter(|request| request.path != "/sessions").all(|request| request.authorized), "bearer on every call");
    assert_eq!(put["livekit_url"], "ws://127.0.0.1:7880");
    assert_eq!(put["media_url"], format!("{}/media/final.mkv", w.mock.base), "the redirect is followed on the server");
    assert_eq!(put["headers"], json!({"User-Agent": "UA-test"}), "only User-Agent and Referer pass");
    assert_eq!(
        (put["max_height"].as_u64(), put["bitrate"].as_u64(), put["playing"].as_bool(), put["position_ms"].as_u64()),
        (Some(1080), Some(6000), Some(true), Some(0))
    );
    let claims = token::verify(MEDIA_SECRET, put["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("signed with the media secret");
    let grant = claims.video.expect("grant");
    assert_eq!((claims.iss.as_str(), claims.sub.as_str()), (MEDIA_KEY, format!("bot:stremio:{ch}").as_str()));
    assert_eq!(grant.room.as_deref(), Some(format!("stremio-{ch}").as_str()));
    assert!(grant.room_join && grant.can_publish && !grant.can_subscribe && !grant.can_publish_data && !grant.hidden);
    assert_eq!(grant.can_publish_sources, ["screen_share", "screen_share_audio"]);

    // What clients see.
    assert_eq!((state["status"].as_str(), state["playing"].as_bool(), state["started_by"].as_str()), (Some("starting"), Some(true), Some(w.alice_id.as_str())));
    assert_eq!(
        (state["item"]["title"].as_str(), state["item"]["label"].as_str(), state["item"]["poster"].as_str()),
        (Some("Heat"), Some("A 1080p"), Some(POSTER))
    );
    assert_eq!(state["bot_identity"], format!("bot:stremio:{ch}"));
    assert_no_secrets("the session state", &state);
    assert_no_urls(&state);
    let update = owner.stremio().await;
    assert_eq!((update["channel_id"].as_str(), update["state"]["status"].as_str()), (Some(ch.as_str()), Some("starting")));
    assert_no_secrets("STREMIO_UPDATE", &update);
    assert_no_urls(&update["state"]);
    assert!(carl.silent_for("STREMIO_UPDATE", Duration::from_millis(300)).await, "carl cannot see the channel");

    // The bot reports: started (with the duration), then positions that nobody is told about.
    assert_eq!(w.event("started", json!({"position_ms": 0, "duration_ms": 7_200_000})).await, StatusCode::NO_CONTENT);
    let started = owner.stremio().await;
    assert_eq!((started["state"]["status"].as_str(), started["state"]["duration_ms"].as_u64()), (Some("playing"), Some(7_200_000)));
    settle().await;
    assert_eq!(w.event("position", json!({"position_ms": 5000, "duration_ms": 7_200_000})).await, StatusCode::NO_CONTENT);
    assert!(owner.silent_for("STREMIO_UPDATE", Duration::from_millis(250)).await);

    // Pause and seek reach the bot; a seek past the end is refused.
    let (status, paused) = w.app.patch(&w.path(), &w.alice, json!({"playing": false, "position_ms": 42_000})).await;
    assert_eq!((status, paused["status"].as_str(), paused["position_ms"].as_u64()), (StatusCode::OK, Some("paused"), Some(42_000)));
    assert_eq!(owner.stremio().await["state"]["playing"], false);
    let last = w.bot.puts(&ch).pop().expect("put");
    assert_eq!((last["playing"].as_bool(), last["position_ms"].as_u64()), (Some(false), Some(42_000)));
    assert_eq!(last["token"], put["token"], "a seek does not change the token");
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({"position_ms": 7_200_001_u64})).await.0, StatusCode::BAD_REQUEST, "past the duration");
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({"position_ms": 86_400_001_u64})).await.0, StatusCode::BAD_REQUEST);
    let (_, resumed) = w.app.patch(&w.path(), &w.alice, json!({"playing": true})).await;
    assert_eq!((resumed["status"].as_str(), resumed["position_ms"].as_u64()), (Some("playing"), Some(42_000)));
    assert_eq!(w.bot.puts(&ch).pop().expect("put")["playing"], true);

    // Stopping ends it for everyone and tells the bot.
    assert_eq!(w.app.delete(&w.path(), &w.alice).await.0, StatusCode::NO_CONTENT);
    loop {
        if owner.stremio().await["state"].is_null() {
            break;
        }
    }
    until("the bot's DELETE", || w.bot.deletes(&format!("/sessions/{ch}")) == 1).await;
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({"playing": false})).await.0, StatusCode::BAD_REQUEST, "nothing is playing");
}

#[tokio::test]
async fn the_queue_holds_ten_skips_and_follows_the_bot() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    owner.stremio().await;
    let listing = w.streams(&w.alice).await;
    let second = World::sid(&listing, "A 720p");
    for n in 0..10 {
        let (status, state) = w.app.patch(&w.path(), &w.alice, json!({"queue_add": second})).await;
        assert_eq!((status, state["queue"].as_array().map(Vec::len)), (StatusCode::OK, Some(n + 1)), "{state}");
    }
    let (status, _) = w.app.patch(&w.path(), &w.alice, json!({"queue_add": second})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "the queue holds 10");
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({"queue_remove": 10})).await.0, StatusCode::BAD_REQUEST);
    let (_, removed) = w.app.patch(&w.path(), &w.alice, json!({"queue_remove": 0})).await;
    assert_eq!(removed["queue"].as_array().map(Vec::len), Some(9));
    assert_eq!((removed["queue"][0]["label"].as_str(), removed["queue"][0]["added_by"].as_str()), (Some("A 720p"), Some(w.alice_id.as_str())));
    assert_no_secrets("the queue", &removed);

    // Skip plays the next one: a new bot PUT with the next link and a fresh token.
    let before = w.bot.puts(&w.voice).len();
    let (_, skipped) = w.app.patch(&w.path(), &w.alice, json!({"skip": true})).await;
    assert_eq!(
        (skipped["item"]["label"].as_str(), skipped["status"].as_str(), skipped["queue"].as_array().map(Vec::len)),
        (Some("A 720p"), Some("starting"), Some(8))
    );
    let puts = w.bot.puts(&w.voice);
    assert_eq!(puts.len(), before + 1);
    assert_eq!(puts[before]["media_url"], format!("{}/media/second.mkv", w.mock.base));
    assert_eq!(puts[before]["position_ms"], 0);

    // An event right after a change describes the previous item and is ignored; later `ended` moves on, and the last one ends it.
    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    settle().await;
    let current = w.app.patch(&w.path(), &w.alice, json!({})).await.1;
    assert_eq!(current["queue"].as_array().map(Vec::len), Some(8), "the early `ended` was ignored: {current}");
    for left in (0..8).rev() {
        assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
        settle().await;
        let state = w.app.patch(&w.path(), &w.alice, json!({})).await.1;
        assert_eq!(state["queue"].as_array().map(Vec::len), Some(left), "{state}");
    }
    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    until("the session to end", || w.bot.deletes(&format!("/sessions/{}", w.voice)) == 1).await;
    let ended = loop {
        let update = owner.stremio().await;
        if update["state"].is_null() {
            break update;
        }
    };
    assert_eq!(ended["channel_id"], w.voice.as_str());
}

#[tokio::test]
async fn bot_events_need_the_secret_and_a_known_channel() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    let body = json!({"channel_id": w.voice, "event": "ended", "position_ms": 0});
    assert_eq!(w.bot_event("wrong-secret-wrong-secret", body.clone()).await, StatusCode::UNAUTHORIZED);
    assert_eq!(w.bot_event("", body.clone()).await, StatusCode::UNAUTHORIZED);
    let request = Request::post("/internal/stremio/bot").header("content-type", "application/json").body(Body::from(body.to_string())).expect("request");
    assert_eq!(w.app.router.clone().oneshot(request).await.expect("response").status(), StatusCode::UNAUTHORIZED, "no header");
    settle().await;
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({})).await.1["status"], "starting", "the session is untouched");
    // An event for a channel without a session is accepted quietly (the bot retries anything else).
    assert_eq!(w.bot_event(BOT_SECRET, json!({"channel_id": "12345", "event": "ended", "position_ms": 0})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.bot_event(BOT_SECRET, json!({"channel_id": "not-a-number", "event": "ended"})).await, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn control_calls_check_access_every_time() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    let carl_path = w.path();
    // carl is not in the call: no controls, no viewer token.
    assert_eq!(w.app.put_json(&carl_path, &w.carl, json!({"sid": "x"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.patch(&carl_path, &w.carl, json!({"playing": false})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&carl_path, &w.carl).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.post(&format!("{carl_path}/viewer-token"), &w.carl, json!({})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        w.app.post(&format!("{carl_path}/viewer-token"), &w.owner, json!({})).await.0,
        StatusCode::FORBIDDEN,
        "watching from outside the call is not allowed either"
    );
    // alice loses CONNECT while she is in the call: the check runs again on each route.
    let listing = w.streams(&w.alice).await;
    w.overwrite(&w.alice_id, 1, VIEW_CHANNEL | CONNECT).await;
    let sid = World::sid(&listing, "A 1080p");
    assert_eq!(w.app.put_json(&w.path(), &w.alice, json!({"sid": sid})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({"playing": false})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&w.path(), &w.alice).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.post(&format!("{}/viewer-token", w.path()), &w.alice, json!({})).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn viewer_tokens_are_subscribe_only_and_need_a_running_session() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.link(&w.alice).await;
    w.join(&mut alice).await;
    let viewer = format!("{}/viewer-token", w.path());
    assert_eq!(w.app.post(&viewer, &w.alice, json!({})).await.0, StatusCode::BAD_REQUEST, "nothing is playing yet");
    let sid = World::sid(&w.streams(&w.alice).await, "A 1080p");
    w.app.put_json(&w.path(), &w.alice, json!({"sid": sid})).await;
    let (status, first) = w.app.post(&viewer, &w.alice, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["url"], "wss://media.test");
    let now = vokko_server::voice::unix_now();
    let claims = token::verify(MEDIA_SECRET, first["token"].as_str().expect("token"), now).expect("signed with the media secret");
    let grant = claims.video.expect("grant");
    assert_eq!(grant.room.as_deref(), Some(format!("stremio-{}", w.voice).as_str()));
    assert!(grant.room_join && grant.can_subscribe && !grant.can_publish && !grant.can_publish_data && grant.can_publish_sources.is_empty());
    assert!(claims.sub.starts_with(&format!("viewer:{}:", w.alice_id)), "{}", claims.sub);
    assert!((6 * 3600 - 30..=6 * 3600 + 30).contains(&(claims.exp - now)), "6 h");
    let (_, second) = w.app.post(&viewer, &w.alice, json!({})).await;
    let other = token::verify(MEDIA_SECRET, second["token"].as_str().expect("token"), now).expect("claims");
    assert_ne!(claims.sub, other.sub, "two devices do not share an identity");
}

#[tokio::test]
async fn ready_and_late_joiners_carry_the_session() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    let (mut owner, ready) = Client::identify(&w.address, &w.owner).await;
    let lists = &ready["guilds"][0]["stremio"];
    assert_eq!(
        (lists.as_array().map(Vec::len), lists[0]["channel_id"].as_str(), lists[0]["state"]["item"]["label"].as_str()),
        (Some(1), Some(w.voice.as_str()), Some("A 1080p"))
    );
    assert_no_secrets("READY", lists);
    // The session reaches whoever joins the call.
    w.join(&mut owner).await;
    assert_eq!(owner.stremio().await["state"]["item"]["label"], "A 1080p");
}

#[tokio::test]
async fn the_session_ends_when_the_last_person_leaves() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    owner.stremio().await;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.join(&mut carl).await;
    alice.voice(None).await;
    assert!(owner.silent_for("STREMIO_UPDATE", Duration::from_millis(300)).await, "carl is still inside");
    assert_eq!(w.bot.deletes(&format!("/sessions/{}", w.voice)), 0);
    carl.voice(None).await;
    assert!(owner.stremio().await["state"].is_null());
    until("the bot's DELETE", || w.bot.deletes(&format!("/sessions/{}", w.voice)) == 1).await;
}

#[tokio::test]
async fn the_bot_gets_the_desired_state_again_as_a_lease() {
    let w = world_with(|config| config.lease_interval = Duration::from_millis(200), |_| {}).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    vokko_server::voice::stremio::spawn_tasks(w.app.state.clone());
    until("the startup DELETE /sessions", || w.bot.deletes("/sessions") == 1).await;
    until("three PUTs", || w.bot.puts(&w.voice).len() >= 3).await;
    let puts = w.bot.puts(&w.voice);
    assert_eq!((&puts[0]["token"], &puts[0]["media_url"]), (&puts[2]["token"], &puts[2]["media_url"]), "the same desired state");
    assert!(puts[2]["position_ms"].as_u64() > puts[0]["position_ms"].as_u64(), "and the position moves on while it plays");
    assert!(puts[2]["playing"].as_bool().unwrap_or(false));
}

#[tokio::test]
async fn a_bot_that_stays_unreachable_ends_the_session() {
    let w = world_with(|config| config.lease_interval = Duration::from_millis(100), |_| {}).await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    owner.stremio().await;
    vokko_server::voice::stremio::spawn_tasks(w.app.state.clone());
    w.bot.answer(500);
    let ended = loop {
        let update = owner.stremio().await;
        if update["state"].is_null() {
            break update;
        }
    };
    assert_eq!(ended["channel_id"], w.voice.as_str());
}

#[tokio::test]
async fn a_busy_or_refusing_bot_fails_the_start_cleanly() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.link(&w.alice).await;
    w.join(&mut alice).await;
    let sid = World::sid(&w.streams(&w.alice).await, "A 1080p");
    for status in [503, 500, 401] {
        w.bot.answer(status);
        let (code, body) = w.app.put_json(&w.path(), &w.alice, json!({"sid": sid})).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{status}: {body}");
        assert!(!body.to_string().contains(BOT_SECRET));
        assert_eq!(w.app.post(&format!("{}/viewer-token", w.path()), &w.alice, json!({})).await.0, StatusCode::BAD_REQUEST, "no session is left behind");
    }
    w.bot.answer(0);
    assert_eq!(w.app.put_json(&w.path(), &w.alice, json!({"sid": sid})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_long_pause_stops_the_session() {
    let w = world_with(|config| config.pause_timeout = Duration::from_millis(300), |_| {}).await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    owner.stremio().await;
    vokko_server::voice::stremio::spawn_tasks(w.app.state.clone());
    assert_eq!(w.app.patch(&w.path(), &w.alice, json!({"playing": false})).await.0, StatusCode::OK);
    assert_eq!(owner.stremio().await["state"]["status"], "paused");
    assert!(owner.stremio().await["state"].is_null(), "stopped after the pause timeout");
    until("the bot's DELETE", || w.bot.deletes(&format!("/sessions/{}", w.voice)) == 1).await;
}

#[tokio::test]
async fn a_playback_error_is_retried_once_then_shown_without_the_bots_message() {
    let w = world_with(|config| config.error_hold = Duration::from_millis(400), |_| {}).await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, "A 1080p").await;
    owner.stremio().await;
    assert_eq!(w.event("started", json!({"duration_ms": 100_000})).await, StatusCode::NO_CONTENT);
    owner.stremio().await;
    settle().await;
    let hits = w.mock.redirect_hits.load(Ordering::SeqCst);
    assert_eq!(w.event("error", json!({"position_ms": 9000, "message": "ffmpeg: https://secret.example/x.mkv failed"})).await, StatusCode::NO_CONTENT);
    until("the link to be resolved again", || w.bot.puts(&w.voice).len() == 2).await;
    assert_eq!(w.mock.redirect_hits.load(Ordering::SeqCst), hits + 1, "re-resolved");
    assert_eq!(w.bot.puts(&w.voice)[1]["position_ms"].as_u64().map(|ms| ms >= 9000), Some(true), "from where it stopped");
    settle().await;
    assert_eq!(w.event("error", json!({"position_ms": 9100, "message": "ffmpeg: https://secret.example/x.mkv failed"})).await, StatusCode::NO_CONTENT);
    let failed = loop {
        let update = owner.stremio().await;
        if update["state"]["status"] == "error" {
            break update;
        }
    };
    assert_eq!(failed["state"]["error"], "Playback failed.");
    assert_no_secrets("the error state", &failed);
    vokko_server::voice::stremio::spawn_tasks(w.app.state.clone());
    assert!(owner.stremio().await["state"].is_null(), "the error stays on the tile for a while, then the session ends");
}

#[tokio::test]
async fn unlinking_drops_what_the_user_queued() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.playing(&mut alice, "A 1080p").await;
    w.link(&w.carl).await;
    w.join(&mut carl).await;
    owner.stremio().await;
    let carl_sid = World::sid(&w.streams(&w.carl).await, "A 720p");
    let alice_sid = World::sid(&w.streams(&w.alice).await, "A 720p");
    w.app.patch(&w.path(), &w.carl, json!({"queue_add": carl_sid})).await;
    let (_, state) = w.app.patch(&w.path(), &w.alice, json!({"queue_add": alice_sid})).await;
    assert_eq!(state["queue"].as_array().map(Vec::len), Some(2));
    owner.stremio().await;
    owner.stremio().await;
    assert_eq!(w.app.delete("/users/@me/stremio", &w.carl).await.0, StatusCode::NO_CONTENT);
    let update = owner.stremio().await;
    assert_eq!(update["state"]["queue"].as_array().map(Vec::len), Some(1));
    assert_eq!(update["state"]["queue"][0]["added_by"], w.alice_id.as_str());
    assert_eq!(update["state"]["item"]["label"], "A 1080p", "what is playing continues");
    assert_eq!(w.app.get("/stremio/streams/movie/tt0111161", &w.carl).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_expensive_routes_are_rate_limited() {
    let w = world_with(tune_default, |config| config.rate_limit = Some(Default::default())).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.link(&w.alice).await;
    w.join(&mut alice).await;
    let sid = World::sid(&w.streams(&w.alice).await, "A 1080p");
    let mut codes = Vec::new();
    for _ in 0..5 {
        codes.push(w.app.put_json(&w.path(), &w.alice, json!({"sid": sid})).await.0);
    }
    assert_eq!(codes[0], StatusCode::OK);
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS), "starting is limited to a few per minute: {codes:?}");
    let mut codes = Vec::new();
    for _ in 0..8 {
        codes.push(w.app.get("/stremio/streams/movie/tt0111161", &w.alice).await.0);
    }
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS), "stream lists too: {codes:?}");
    let mut codes = Vec::new();
    for _ in 0..8 {
        codes.push(w.app.post("/users/@me/stremio/link", &w.alice, json!({})).await.0);
    }
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS), "and link codes: {codes:?}");
}
