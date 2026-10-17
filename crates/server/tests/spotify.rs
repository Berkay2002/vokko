#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Spotify in voice calls (docs/design/spotify-bot.md, docs/api.md "Spotify in calls"): the catalog proxy, playback sessions, the
//! bot contract, privacy and lifecycle, against a mock Spotify Web API and a fake bot. No real Spotify, LiveKit or bot is called.
mod common;

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request as AxumRequest, State};
use axum::http::{Request, StatusCode, header};
use axum::middleware::{self, Next};
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
use vokko_server::config::{Cidr, Config, LiveKitConfig, SpotifyConfig, StremioConfig};
use vokko_server::crypto::SecretsKey;
use vokko_server::spotify::webapi::allowed_path;
use vokko_server::voice::livekit::{FakeRoomService, Participant};
use vokko_server::voice::token;

const MEDIA_KEY: &str = "media-key";
const MEDIA_SECRET: &str = "media-secret-media-secret";
const BOT_SECRET: &str = "bot-secret-0123456789";
const CLIENT_SECRET: &str = "client-secret-SECRET";
const HOUSE: &str = "HOUSEACCOUNT";
const HEX_ART: &str = "ab67616d00001e02aabbccddeeff001122334455";

// ---- ids ----

fn tid(n: u32) -> String {
    format!("{n:022}")
}

fn track_uri(n: u32) -> String {
    format!("spotify:track:{}", tid(n))
}

fn album_uri(n: u32) -> String {
    format!("spotify:album:A{n:021}")
}

fn playlist_uri(n: u32) -> String {
    format!("spotify:playlist:P{n:021}")
}

fn number(id: &str) -> u32 {
    id.trim_start_matches(|c: char| c.is_ascii_alphabetic()).parse().unwrap_or(0)
}

// ---- the mock Spotify (accounts + Web API) ----

#[derive(Default)]
struct Mock {
    requests: Mutex<Vec<String>>,
    tokens: AtomicUsize,
    limited: AtomicBool,
}

impl Mock {
    fn paths(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn catalog_calls(&self) -> usize {
        self.paths().iter().filter(|path| path.starts_with("/v1/")).count()
    }
}

fn track_json(n: u32) -> Value {
    json!({
        "type": "track", "id": tid(n), "name": format!("Song {n}"), "duration_ms": 200_000, "explicit": n == 2, "is_playable": true,
        "artists": [{"name": "Artist"}],
        "album": {"name": "Album", "images": [{"url": format!("https://i.scdn.co/image/{HEX_ART}"), "width": 300}, {"url": "https://evil.example/x.jpg", "width": 300}]},
    })
}

async fn record(State(mock): State<Arc<Mock>>, request: AxumRequest, next: Next) -> Response {
    mock.requests.lock().unwrap().push(request.uri().path().to_owned());
    next.run(request).await
}

async fn token_endpoint(State(mock): State<Arc<Mock>>) -> Json<Value> {
    mock.tokens.fetch_add(1, Ordering::SeqCst);
    Json(json!({"access_token": "ACCESS-TOKEN-SECRET", "expires_in": 3600}))
}

async fn one_track(Path(id): Path<String>) -> Response {
    match number(&id) {
        0 => StatusCode::NOT_FOUND.into_response(),
        n => Json(track_json(n)).into_response(),
    }
}

async fn one_album(Path(id): Path<String>) -> Json<Value> {
    let simple = |n: u32| json!({"type": "track", "id": tid(n), "name": format!("Song {n}"), "duration_ms": 200_000, "artists": [{"name": "Artist"}]});
    Json(json!({
        "id": id, "name": "Album", "artists": [{"name": "Artist"}], "release_date": "1999-05-01",
        "images": [{"url": format!("https://i.scdn.co/image/{HEX_ART}"), "width": 640}],
        "tracks": {"items": [simple(1), simple(2), simple(3)]},
    }))
}

/// The Web API gives a playlist's header only; Spotify-owned playlists are 404 for a client-credentials token.
async fn one_playlist(Path(id): Path<String>) -> Response {
    if matches!(number(&id), 98 | 99) {
        return StatusCode::NOT_FOUND.into_response();
    }
    Json(json!({"id": id, "name": "Mix", "owner": {"id": "someone", "display_name": "Sam"}, "images": []})).into_response()
}

async fn search(State(mock): State<Arc<Mock>>) -> Response {
    if mock.limited.load(Ordering::SeqCst) {
        return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "7")]).into_response();
    }
    Json(json!({
        "tracks": {"items": [track_json(1), track_json(2)]},
        "albums": {"items": [{"id": format!("A{:021}", 1), "name": "Album", "artists": [{"name": "Artist"}], "release_date": "1999", "images": []}]},
        "artists": {"items": [{"id": format!("R{:021}", 1), "name": "Artist", "images": []}]},
        "playlists": {"items": [null, {"id": format!("P{:021}", 1), "name": "Mix", "owner": {"id": "x", "display_name": "Sam"}, "images": []},
                                {"id": format!("P{:021}", 99), "name": "Editorial", "owner": {"id": "spotify"}, "images": []}]},
    }))
    .into_response()
}

async fn one_artist(Path(id): Path<String>) -> Json<Value> {
    Json(json!({"id": id, "name": "Artist", "images": []}))
}

async fn artist_albums() -> Json<Value> {
    Json(json!({"items": [{"id": format!("A{:021}", 1), "name": "Album", "artists": [{"name": "Artist"}], "release_date": "1999", "images": []}]}))
}

async fn start_mock() -> (Arc<Mock>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let mock = Arc::new(Mock::default());
    let router = Router::new()
        .route("/api/token", post(token_endpoint))
        .route("/v1/tracks/{id}", get(one_track))
        .route("/v1/albums/{id}", get(one_album))
        .route("/v1/playlists/{id}", get(one_playlist))
        .route("/v1/search", get(search))
        .route("/v1/artists/{id}", get(one_artist))
        .route("/v1/artists/{id}/albums", get(artist_albums))
        .layer(middleware::from_fn_with_state(mock.clone(), record))
        .with_state(mock.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (mock, base)
}

// ---- a minimal Stremio (for the one-activity-per-channel rule) ----

fn stremio_ok(result: Value) -> Json<Value> {
    Json(json!({"result": result}))
}

async fn stremio_collection(State(base): State<String>) -> Json<Value> {
    let manifest = json!({"name": "Addon A", "resources": ["stream"], "types": ["movie"], "idPrefixes": ["tt"]});
    stremio_ok(json!({"addons": [{"transportUrl": format!("{base}/addon-a/CFG/manifest.json"), "manifest": manifest}]}))
}

async fn stremio_streams(State(base): State<String>) -> Json<Value> {
    Json(
        json!({"streams": [{"name": "A 1080p", "description": "Movie", "url": format!("{base}/media/final.mkv"), "behaviorHints": {"videoSize": 1_000_000_u64}}]}),
    )
}

async fn stremio_media() -> Response {
    (StatusCode::PARTIAL_CONTENT, [(header::CONTENT_TYPE, "video/x-matroska")], vec![0_u8]).into_response()
}

async fn start_stremio_mock() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let router = Router::new()
        .route("/api/login", post(|| async { stremio_ok(json!({"authKey": "AUTHKEY-1", "user": {}})) }))
        .route("/api/getUser", post(|| async { stremio_ok(json!({"_id": "u"})) }))
        .route("/api/addonCollectionGet", post(stremio_collection))
        .route("/addon-a/CFG/stream/{kind}/{file}", get(stremio_streams))
        .route("/media/final.mkv", get(stremio_media))
        .route("/cinemeta/meta/{kind}/{file}", get(|| async { Json(json!({"meta": {"name": "Heat"}})) }))
        .with_state(base.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    base
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

    /// Bodies of the `PUT /session` calls, oldest first.
    fn puts(&self) -> Vec<Value> {
        self.all().into_iter().filter(|request| request.method == "PUT" && request.path == "/session").map(|request| request.body).collect()
    }

    fn last_put(&self) -> Value {
        self.puts().pop().expect("the bot was sent a session")
    }

    fn deletes(&self) -> usize {
        self.all().iter().filter(|request| request.method == "DELETE" && request.path == "/session").count()
    }
}

fn bot_track(n: u32) -> Value {
    let art = if n == 5 { "https://evil.example/x.jpg".to_owned() } else { HEX_ART.to_owned() };
    json!({"uri": track_uri(n), "title": format!("Song {n}"), "artists": ["Artist"], "album": "Album", "art": art, "duration_ms": 200_000, "explicit": false})
}

/// The bot's catalog reads (docs/api.md "Bot contract"): a playlist page and an artist's top tracks.
fn bot_catalog(path: &str, query: Option<&str>) -> Response {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let offset: u32 =
        query.and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("offset="))).and_then(|offset| offset.parse().ok()).unwrap_or(0);
    match parts.as_slice() {
        ["catalog", "playlists", id] if number(id) != 0 => {
            let mut tracks: Vec<Value> = (offset + 1..=(offset + 100).min(250)).map(bot_track).collect();
            tracks.push(json!({"uri": "spotify:episode:0000000000000000000099", "title": "Podcast"}));
            Json(json!({"name": "Bot Mix", "total": 250, "spotify_owned": number(id) == 99, "tracks": tracks})).into_response()
        }
        ["catalog", "artists", id, "top-tracks"] if number(id) != 0 => Json(json!({"tracks": [bot_track(1), bot_track(2)]})).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn bot_handler(State(bot): State<Arc<Bot>>, request: Request<Body>) -> Response {
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
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if parts.uri.path().starts_with("/catalog/") {
        return bot_catalog(parts.uri.path(), parts.uri.query());
    }
    match bot.status.load(Ordering::SeqCst) {
        0 => StatusCode::OK,
        status => StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
    }
    .into_response()
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

// ---- gateway client ----

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

    async fn spotify(&mut self) -> Value {
        self.wait_for("SPOTIFY_UPDATE").await
    }

    /// The next SPOTIFY_UPDATE whose state is `null` (the session ended).
    async fn ended(&mut self) -> Value {
        loop {
            let update = self.spotify().await;
            if update["state"].is_null() {
                return update;
            }
        }
    }
}

// ---- the world ----

struct World {
    app: TestApp,
    mock: Arc<Mock>,
    bot: Arc<Bot>,
    media: Arc<FakeRoomService>,
    address: String,
    voice: String,
    guild: String,
    owner: String,
    alice: String,
    alice_id: String,
    carl: String,
    carl_id: String,
    /// The mock Stremio's base URL, when the world was built with Stremio too.
    stremio: Option<String>,
}

/// Quick timers; the lease is long unless a test shortens it. The ticker only runs where a test starts it.
fn tune_default(config: &mut SpotifyConfig) {
    config.tick = Duration::from_millis(50);
    config.error_hold = Duration::from_millis(600);
    config.notice_ttl = Duration::from_millis(300);
}

async fn world() -> World {
    world_with(tune_default, false).await
}

async fn world_with(tune: impl FnOnce(&mut SpotifyConfig), with_stremio: bool) -> World {
    let (mock, spotify_base) = start_mock().await;
    let (bot, bot_url) = start_bot().await;
    let mut spotify = SpotifyConfig::new(
        "client-id".to_owned(),
        CLIENT_SECRET.to_owned(),
        bot_url.clone(),
        BOT_SECRET.to_owned(),
        "wss://media.test".to_owned(),
        MEDIA_KEY.to_owned(),
        MEDIA_SECRET.to_owned(),
    );
    spotify.bot_media_url = "ws://127.0.0.1:7880".to_owned();
    spotify.api_url = spotify_base.clone();
    spotify.accounts_url = spotify_base;
    tune_default(&mut spotify);
    tune(&mut spotify);
    let stremio_base = if with_stremio { Some(start_stremio_mock().await) } else { None };
    let stremio = stremio_base.as_ref().map(|base| {
        let mut config = StremioConfig::new(
            SecretsKey::from_bytes([7; 32]),
            "wss://media.test".to_owned(),
            MEDIA_KEY.to_owned(),
            MEDIA_SECRET.to_owned(),
            bot_url.clone(),
            BOT_SECRET.to_owned(),
        );
        config.fetch_allow = vec![Cidr::parse("127.0.0.1/32").expect("range")];
        config.api_url = base.clone();
        config.cinemeta_url = format!("{base}/cinemeta");
        config
    });
    let app = TestApp::with_room_service(
        |config: &mut Config| {
            config.livekit = vec![LiveKitConfig {
                url: "wss://lk.test".into(),
                api_url: "http://127.0.0.1:9".into(),
                api_key: "vokko".into(),
                api_secret: "test-secret".into(),
                label: "test".into(),
            }];
            config.spotify = Some(spotify);
            config.stremio = stremio;
        },
        FakeRoomService::new(),
    )
    .await;
    let media = FakeRoomService::new();
    app.state.spotify.set_media_rooms(media.clone());
    app.state.stremio.set_media_rooms(media.clone());
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (carl, carl_user) = app.register("carl").await;
    let (guild, text) = app.guild_with_channel(&owner).await;
    let voice = voice_channel(&app, &owner, &guild).await;
    let (_, invite) = app.post(&format!("/channels/{text}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    for token in [&alice, &carl] {
        assert_eq!(app.post(&format!("/invites/{code}"), token, json!({})).await.0, StatusCode::OK);
    }
    let id = |user: &Value| user["id"].as_str().expect("id").to_owned();
    World { app, mock, bot, media, address, voice, guild, owner, alice, alice_id: id(&alice_user), carl, carl_id: id(&carl_user), stremio: stremio_base }
}

async fn voice_channel(app: &TestApp, owner: &str, guild: &str) -> String {
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), owner).await;
    channels.as_array().expect("channels").iter().find(|c| c["type"] == 2).expect("voice channel")["id"].as_str().expect("id").to_owned()
}

impl World {
    fn path(&self) -> String {
        format!("/channels/{}/spotify", self.voice)
    }

    async fn join(&self, client: &mut Client) {
        client.voice(Some(&self.voice)).await;
        client.voice_answer().await;
    }

    async fn play(&self, token: &str, uri: &str) -> (StatusCode, Value) {
        self.app.put_json(&self.path(), token, json!({"uri": uri})).await
    }

    async fn patch(&self, token: &str, body: Value) -> (StatusCode, Value) {
        self.app.patch(&self.path(), token, body).await
    }

    /// alice is in the call and the track `n` plays.
    async fn playing(&self, alice: &mut Client, n: u32) -> Value {
        self.join(alice).await;
        let (status, state) = self.play(&self.alice, &track_uri(n)).await;
        assert_eq!(status, StatusCode::OK, "{state}");
        state
    }

    async fn bot_event(&self, bearer: &str, body: Value) -> StatusCode {
        let request = Request::post("/internal/spotify/bot")
            .header("authorization", format!("Bearer {bearer}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        self.app.router.clone().oneshot(request).await.expect("response").status()
    }

    /// An event of the bot about the track the last `PUT` named, with the `seq` of that `PUT`.
    async fn event(&self, event: &str, extra: Value) -> StatusCode {
        let put = self.bot.last_put();
        self.event_for(&put["track"], &put["seq"], event, extra).await
    }

    async fn event_for(&self, track: &Value, seq: &Value, event: &str, extra: Value) -> StatusCode {
        let mut body = json!({"channel_id": self.voice, "event": event, "track": track, "position_ms": 0, "seq": seq});
        body.as_object_mut().expect("object").extend(extra.as_object().expect("object").clone());
        self.bot_event(BOT_SECRET, body).await
    }

    async fn state(&self, token: &str) -> Value {
        let (status, state) = self.app.get(&self.path(), token).await;
        assert_eq!(status, StatusCode::OK, "{state}");
        state
    }
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

fn room_of(token: &str) -> String {
    token::verify(MEDIA_SECRET, token, vokko_server::voice::unix_now()).expect("signed with the media secret").video.expect("grant").room.expect("room")
}

fn viewer(identity: &str) -> Participant {
    Participant { identity: identity.to_owned(), ..Participant::default() }
}

fn titles(state: &Value) -> Vec<String> {
    state["queue"].as_array().expect("queue").iter().map(|entry| entry["title"].as_str().expect("title").to_owned()).collect()
}

fn song(n: u32) -> String {
    format!("Song {n}")
}

/// Nothing a client can see may carry a secret, the house account or a URL.
fn assert_clean(what: &str, value: &Value) {
    let text = value.to_string();
    for secret in [CLIENT_SECRET, "ACCESS-TOKEN", BOT_SECRET, MEDIA_SECRET, HOUSE, "127.0.0.1", "http", "evil.example"] {
        assert!(!text.contains(secret), "{what} leaks {secret}: {text}");
    }
}

// ---- tests ----

#[tokio::test]
async fn every_route_is_404_without_the_feature() {
    let app = TestApp::with_config(|_| {}).await;
    let (token, _) = app.register("alice").await;
    for (method, path) in [
        ("GET", "/spotify/search?q=daft"),
        ("GET", "/spotify/tracks/0000000000000000000001"),
        ("GET", "/spotify/albums/A000000000000000000001"),
        ("GET", "/spotify/playlists/P000000000000000000001"),
        ("GET", "/spotify/artists/R000000000000000000001"),
        ("PUT", "/channels/1/spotify"),
        ("PATCH", "/channels/1/spotify"),
        ("GET", "/channels/1/spotify"),
        ("DELETE", "/channels/1/spotify"),
        ("POST", "/channels/1/spotify/listener-token"),
    ] {
        let body = (method == "PUT" || method == "PATCH").then(|| json!({"uri": track_uri(1), "skip": true}));
        let (status, reply) = app.send(method.parse().expect("method"), path, Some(&token), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {reply}");
    }
    let request = Request::post("/internal/spotify/bot")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"channel_id":"1","event":"ended"}"#))
        .expect("request");
    assert_eq!(app.router.clone().oneshot(request).await.expect("response").status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn browsing_reduces_the_catalog_and_only_ever_asks_for_allow_listed_paths() {
    let w = world().await;
    let (status, found) = w.app.get("/spotify/search?q=daft%20punk", &w.alice).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["tracks"].as_array().map(Vec::len), Some(2));
    assert_eq!(found["tracks"][0]["uri"], track_uri(1));
    assert_eq!(found["tracks"][0]["art"], HEX_ART, "the art is a bare id from a trusted host");
    assert_eq!(found["tracks"][1]["explicit"], true);
    assert_eq!(found["playlists"].as_array().map(Vec::len), Some(1), "null and Spotify-owned playlists are dropped: {found}");
    assert_clean("search results", &found);

    let (_, only) = w.app.get("/spotify/search?q=daft&type=track", &w.carl).await;
    assert!(only["tracks"].as_array().is_some_and(|tracks| !tracks.is_empty()));
    for bad in ["/spotify/search?q=", "/spotify/search?q=a&type=show", "/spotify/search?q=a&offset=5000", "/spotify/search?q=https://open.spotify.com/user/x"] {
        assert_eq!(w.app.get(bad, &w.alice).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    // A pasted link is one direct lookup.
    let (_, pasted) = w.app.get(&format!("/spotify/search?q=https://open.spotify.com/intl-sv/track/{}?si=x", tid(3)), &w.alice).await;
    assert_eq!(pasted["tracks"][0]["uri"], track_uri(3));

    let (status, album) = w.app.get("/spotify/albums/A000000000000000000001", &w.alice).await;
    assert_eq!((status, album["year"].as_str(), album["tracks"].as_array().map(Vec::len)), (StatusCode::OK, Some("1999"), Some(3)));
    assert_eq!(album["tracks"][0]["album"], "Album", "album tracks inherit the album");
    assert_clean("an album", &album);
    let (status, playlist) = w.app.get("/spotify/playlists/P000000000000000000001?offset=100", &w.alice).await;
    assert_eq!((status, playlist["tracks"][0]["title"].as_str()), (StatusCode::OK, Some("Song 101")));
    assert_eq!(
        (playlist["total"].clone(), playlist["name"].as_str(), playlist["owner_name"].as_str()),
        (json!(250), Some("Mix"), Some("Sam")),
        "the header is Spotify's"
    );
    assert_eq!(playlist["tracks"].as_array().map(Vec::len), Some(100));
    assert_clean("a playlist", &playlist);
    // The bot's list is reduced again: the episode goes, and an art id that is not 40 hex goes.
    let (_, first) = w.app.get("/spotify/playlists/P000000000000000000001", &w.alice).await;
    assert_eq!(first["tracks"].as_array().map(Vec::len), Some(100), "the episode in the bot's list is dropped");
    assert!(first["tracks"][0]["art"] == HEX_ART && first["tracks"][4]["art"].is_null(), "{}", first["tracks"][4]);
    // A Spotify-owned playlist has no header for this token: the bot's name stands.
    let (status, owned) = w.app.get("/spotify/playlists/P000000000000000000099", &w.alice).await;
    assert_eq!(
        (status, owned["name"].as_str(), owned["owner_name"].as_str(), owned["art"].is_null()),
        (StatusCode::OK, Some("Bot Mix"), Some("Spotify"), true),
        "{owned}"
    );
    let (status, artist) = w.app.get("/spotify/artists/R000000000000000000001", &w.alice).await;
    assert_eq!(
        (status, artist["top_tracks"].as_array().map(Vec::len), artist["albums"].as_array().map(Vec::len)),
        (StatusCode::OK, Some(2), Some(1)),
        "{artist}"
    );
    assert_clean("an artist", &artist);
    assert_eq!(w.app.get(&format!("/spotify/tracks/{}", tid(4)), &w.alice).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&format!("/spotify/tracks/{}", tid(0)), &w.alice).await.0, StatusCode::NOT_FOUND, "an id Spotify does not know");
    for bad in ["/spotify/tracks/short", "/spotify/albums/..%2F..%2Fme", "/spotify/playlists/P000000000000000000001?offset=999999"] {
        assert_eq!(w.app.get(bad, &w.alice).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }

    // Every request that reached Spotify is on the allow-list; none is about a user.
    let paths = w.mock.paths();
    assert!(w.mock.tokens.load(Ordering::SeqCst) >= 1);
    for path in paths.iter().filter(|path| path.starts_with("/v1/")) {
        assert!(allowed_path(path), "{path}");
        assert!(!path.contains("/me") && !path.contains("/users"), "{path}");
    }
    // And the bot was asked for nothing but the two catalog reads.
    for request in w.bot.all() {
        let parts: Vec<&str> = request.path.trim_start_matches('/').split('/').collect();
        assert!(matches!(parts.as_slice(), ["catalog", "playlists", _] | ["catalog", "artists", _, "top-tracks"]), "{}", request.path);
        assert!(request.authorized && request.method == "GET");
    }
    assert!(!paths.iter().any(|path| path == "/authorize" || path.contains("recently-played") || path.contains("player")), "{paths:?}");
}

#[tokio::test]
async fn results_are_cached_and_a_spotify_429_pauses_every_catalog_call() {
    let w = world().await;
    assert_eq!(w.app.get("/spotify/search?q=daft", &w.alice).await.0, StatusCode::OK);
    let calls = w.mock.catalog_calls();
    assert_eq!(w.app.get("/spotify/search?q=daft", &w.carl).await.0, StatusCode::OK);
    assert_eq!(w.mock.catalog_calls(), calls, "the second search came from the cache");
    w.mock.limited.store(true, Ordering::SeqCst);
    let request = Request::get("/api/v1/spotify/search?q=other").header("authorization", &w.alice).body(Body::empty()).expect("request");
    let response = w.app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers().get(header::RETRY_AFTER).and_then(|value| value.to_str().ok()), Some("7"));
    let hits = w.mock.catalog_calls();
    assert_eq!(w.app.get(&format!("/spotify/tracks/{}", tid(1)), &w.alice).await.0, StatusCode::TOO_MANY_REQUESTS, "other paths wait too");
    assert_eq!(w.mock.catalog_calls(), hits, "nothing reached Spotify while it asked us to wait");
}

#[tokio::test]
async fn a_member_plays_and_everyone_in_the_call_controls() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    // Not in the call: no playing, no reading, no controls.
    assert_eq!(w.play(&w.alice, &track_uri(1)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.get(&w.path(), &w.alice).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.bot.puts().len(), 0);

    let state = w.playing(&mut alice, 1).await;
    assert_eq!((state["status"].as_str(), state["playing"].as_bool(), state["track"]["title"].as_str()), (Some("starting"), Some(true), Some("Song 1")));
    assert_eq!(state["started_by"], w.alice_id.as_str());
    assert_eq!(state["bot_identity"], format!("bot:spotify:{}", w.voice));
    assert_eq!(state["queue_len"], 0);
    assert_clean("the start reply", &state);
    let update = owner.spotify().await;
    assert_eq!((update["channel_id"].as_str(), update["state"]["track"]["uri"].as_str()), (Some(w.voice.as_str()), Some(track_uri(1).as_str())));

    // The bot was told what to do, with a token that can publish one audio source and nothing else.
    let requests = w.bot.all();
    assert!(requests.iter().all(|request| request.authorized));
    let put = w.bot.last_put();
    assert_eq!(
        (put["channel_id"].as_str(), put["livekit_url"].as_str(), put["track"].as_str()),
        (Some(w.voice.as_str()), Some("ws://127.0.0.1:7880"), Some(track_uri(1).as_str()))
    );
    assert_eq!((put["position_ms"].as_u64(), put["playing"].as_bool()), (Some(0), Some(true)));
    assert!(put.get("next").is_none(), "nothing follows");
    let claims = token::verify(MEDIA_SECRET, put["token"].as_str().expect("token"), vokko_server::voice::unix_now()).expect("signed with the media secret");
    assert_eq!(claims.sub, format!("bot:spotify:{}", w.voice));
    let grant = claims.video.expect("grant");
    assert!(grant.room.as_deref().is_some_and(|room| room.starts_with(&format!("spotify-{}-", w.voice))), "{:?}", grant.room);
    assert!(grant.room_join && grant.can_publish && !grant.can_subscribe && !grant.can_publish_data);
    assert_eq!(grant.can_publish_sources, ["screen_share_audio"]);

    assert_eq!(w.event("started", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.state(&w.alice).await["status"], "playing");

    // Anyone in the call controls it.
    w.join(&mut carl).await;
    owner.voice(Some(&w.voice)).await;
    let (status, paused) = w.patch(&w.carl, json!({"playing": false})).await;
    assert_eq!((status, paused["playing"].as_bool(), paused["status"].as_str()), (StatusCode::OK, Some(false), Some("paused")), "{paused}");
    assert_eq!(w.bot.last_put()["playing"], false);
    assert!(w.bot.last_put()["seq"].as_u64() > put["seq"].as_u64());
    assert_eq!(w.patch(&w.carl, json!({"playing": true})).await.1["status"], "playing");

    // Exactly one operation, well formed.
    for body in [json!({}), json!({"playing": true, "skip": true}), json!({"loop": "forever"}), json!({"position_ms": 999_999_999})] {
        assert_eq!(w.patch(&w.alice, body.clone()).await.0, StatusCode::BAD_REQUEST, "{body}");
    }
    let (status, sought) = w.patch(&w.alice, json!({"position_ms": 90_000})).await;
    assert_eq!((status, sought["position_ms"].as_u64()), (StatusCode::OK, Some(90_000)));
    assert_eq!(w.bot.last_put()["position_ms"], 90_000);
    assert_eq!(w.state(&w.carl).await["track"]["uri"], track_uri(1));

    // Stopping tells the bot, closes the room and everyone hears.
    let room = room_of(put["token"].as_str().expect("token"));
    assert_eq!(w.app.delete(&w.path(), &w.carl).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&w.path(), &w.carl).await.0, StatusCode::BAD_REQUEST, "nothing plays any more");
    assert_eq!(w.patch(&w.carl, json!({"skip": true})).await.1["code"], 40033);
    assert!(owner.ended().await["state"].is_null());
    until("the bot's DELETE", || w.bot.deletes() == 1).await;
    until("the room is closed", || w.media.calls().contains(&format!("DeleteRoom {room}"))).await;
    drop(alice);
}

#[tokio::test]
async fn the_queue_takes_tracks_albums_and_playlists_up_to_its_cap() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    w.playing(&mut alice, 10).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    let add = |uri: String, next: bool| json!({"queue_add": {"uri": uri, "next": next}});
    assert_eq!(titles(&w.patch(&w.alice, add(track_uri(11), false)).await.1), [song(11)]);
    let (_, state) = w.patch(&w.alice, add(track_uri(12), true)).await;
    assert_eq!(titles(&state), [song(12), song(11)], "next goes to the front");
    assert_eq!(state["queue"][0]["added_by"], w.alice_id.as_str());
    assert_eq!(w.bot.last_put()["next"], track_uri(12), "the bot preloads what follows");
    let (_, state) = w.patch(&w.alice, add(album_uri(1), false)).await;
    assert_eq!(titles(&state), [song(12), song(11), song(1), song(2), song(3)]);

    // Move, remove, shuffle and clear go by qid.
    let qid = |state: &Value, index: usize| state["queue"][index]["qid"].as_str().expect("qid").to_owned();
    let (_, state) = w.patch(&w.alice, json!({"queue_move": {"qid": qid(&state, 4), "to": 0}})).await;
    assert_eq!(titles(&state), [song(3), song(12), song(11), song(1), song(2)]);
    let (_, state) = w.patch(&w.alice, json!({"queue_remove": qid(&state, 1)})).await;
    assert_eq!(titles(&state), [song(3), song(11), song(1), song(2)]);
    assert_eq!(w.patch(&w.alice, json!({"queue_remove": "nope"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.patch(&w.alice, json!({"queue_move": {"qid": "nope", "to": 0}})).await.0, StatusCode::BAD_REQUEST);
    let (_, shuffled) = w.patch(&w.alice, json!({"shuffle": true})).await;
    let (mut before, mut after) = (titles(&state), titles(&shuffled));
    before.sort();
    after.sort();
    assert_eq!(before, after, "shuffle keeps the same tracks");

    // A playlist fills the queue to the cap; what did not fit is counted. The events carry at most 50 entries, the reply all.
    let (_, full) = w.patch(&w.alice, add(playlist_uri(1), false)).await;
    assert_eq!((full["queue_len"].as_u64(), full["queue"].as_array().map(Vec::len)), (Some(200), Some(200)));
    assert!(full["left_out"].as_u64().is_some_and(|left| left > 0), "{}", full["left_out"]);
    let mut last = Value::Null;
    loop {
        let update = tokio::time::timeout(Duration::from_millis(300), owner.spotify()).await;
        let Ok(update) = update else { break };
        last = update;
    }
    assert_eq!((last["state"]["queue_len"].as_u64(), last["state"]["queue"].as_array().map(Vec::len)), (Some(200), Some(50)));
    assert_eq!(w.state(&w.alice).await["queue"].as_array().map(Vec::len), Some(200), "GET has all of it");
    assert_eq!(w.patch(&w.alice, add(track_uri(500), false)).await.1["left_out"], 1, "a full queue takes nothing");
    let (_, cleared) = w.patch(&w.alice, json!({"queue_clear": true})).await;
    assert_eq!(cleared["queue_len"], 0);

    // Artists and junk are not playable.
    for uri in ["spotify:artist:R000000000000000000001", "spotify:track:short", "https://open.spotify.com/track/x", "spotify:user:x"] {
        assert_eq!(w.play(&w.alice, uri).await.0, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(w.patch(&w.alice, add(uri.to_owned(), false)).await.0, StatusCode::BAD_REQUEST, "{uri}");
    }
}

#[tokio::test]
async fn an_album_plays_its_first_track_and_queues_the_rest_and_previous_walks_back() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.join(&mut alice).await;
    let (status, state) = w.play(&w.alice, &album_uri(1)).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!((state["track"]["title"].as_str(), titles(&state)), (Some("Song 1"), vec![song(2), song(3)]));
    assert_eq!(state["can_previous"], false);
    let (_, skipped) = w.patch(&w.alice, json!({"skip": true})).await;
    assert_eq!((skipped["track"]["title"].as_str(), skipped["can_previous"].as_bool()), (Some("Song 2"), Some(true)));
    assert_eq!(skipped["status"], "loading");
    // Within 3 s of a track's start, previous steps back; the track we left is next again.
    let (_, back) = w.patch(&w.alice, json!({"previous": true})).await;
    assert_eq!((back["track"]["title"].as_str(), titles(&back)), (Some("Song 1"), vec![song(2), song(3)]));
    // With no history, previous restarts.
    let seq = w.bot.last_put()["seq"].as_u64();
    let (_, again) = w.patch(&w.alice, json!({"previous": true})).await;
    assert_eq!((again["track"]["title"].as_str(), again["position_ms"].as_u64()), (Some("Song 1"), Some(0)));
    assert!(w.bot.last_put()["seq"].as_u64() > seq);
    let (_, looped) = w.patch(&w.alice, json!({"loop": "queue"})).await;
    assert_eq!(looped["loop"], "queue");
}

#[tokio::test]
async fn ended_advances_with_a_gapless_next_and_stale_events_are_ignored() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    w.join(&mut alice).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    assert_eq!(w.play(&w.alice, &album_uri(1)).await.0, StatusCode::OK);
    let first = w.bot.last_put();
    assert_eq!(first["next"], track_uri(2));
    // An event about a track that is not current, or for another channel, changes nothing.
    assert_eq!(w.event_for(&json!(track_uri(3)), &first["seq"], "ended", json!({})).await, StatusCode::NO_CONTENT);
    let elsewhere = json!({"channel_id": "1", "event": "ended", "track": track_uri(1), "seq": first["seq"]});
    assert_eq!(w.bot_event(BOT_SECRET, elsewhere).await, StatusCode::NO_CONTENT);
    assert_eq!(w.bot.puts().len(), 1);
    assert_eq!(w.event("started", json!({"position_ms": 120})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.state(&w.alice).await["status"], "playing");

    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    until("the next track is sent", || w.bot.puts().len() == 2).await;
    let second = w.bot.last_put();
    assert_eq!((second["track"].as_str(), second["next"].as_str()), (Some(track_uri(2).as_str()), Some(track_uri(3).as_str())));
    assert!(second["seq"].as_u64() > first["seq"].as_u64());
    assert_eq!(w.state(&w.alice).await["track"]["uri"], track_uri(2));
    // A retried `ended` of the old track (and anything carrying its seq) cannot advance twice.
    assert_eq!(w.event_for(&json!(track_uri(1)), &first["seq"], "ended", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.event_for(&json!(track_uri(2)), &first["seq"], "ended", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.event_for(&json!(track_uri(2)), &first["seq"], "error", json!({"reason": "unavailable"})).await, StatusCode::NO_CONTENT);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!((w.bot.puts().len(), w.state(&w.alice).await["track"]["uri"].clone()), (2, json!(track_uri(2))));
    // Position reports only correct the clock; they are not announced.
    assert_eq!(w.event("position", json!({"position_ms": 30_000})).await, StatusCode::NO_CONTENT);
    assert!(w.state(&w.alice).await["position_ms"].as_u64().is_some_and(|ms| ms >= 30_000));

    // Loop `track`: the same track again, once per `ended`, even when the bot retries the event.
    assert_eq!(w.patch(&w.alice, json!({"loop": "track"})).await.1["loop"], "track");
    assert_eq!(w.bot.last_put()["next"], track_uri(2), "loop track preloads the track itself");
    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    until("the replay", || w.bot.puts().len() == 4).await;
    let replay = w.bot.last_put();
    assert_eq!((replay["track"].as_str(), replay["position_ms"].as_u64()), (Some(track_uri(2).as_str()), Some(0)));
    assert_eq!(w.event_for(&replay["track"], &w.bot.puts()[2]["seq"], "ended", json!({})).await, StatusCode::NO_CONTENT);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(w.bot.puts().len(), 4, "a retried ended does not replay twice");
    drop(owner);
}

#[tokio::test]
async fn an_unavailable_track_is_skipped_with_a_notice_that_clears_itself() {
    let w = world_with(|config| config.notice_ttl = Duration::from_millis(1000), false).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.join(&mut alice).await;
    assert_eq!(w.play(&w.alice, &album_uri(1)).await.0, StatusCode::OK);
    vokko_server::voice::spotify::spawn_tasks(w.app.state.clone());
    assert_eq!(w.event("error", json!({"reason": "unavailable"})).await, StatusCode::NO_CONTENT);
    let state = w.state(&w.alice).await;
    assert_eq!((state["track"]["uri"].as_str(), state["notice"].as_str()), (Some(track_uri(2).as_str()), Some("Skipped an unavailable track")));
    assert_eq!(state["can_previous"], false, "an unavailable track does not count as played");
    tokio::time::sleep(Duration::from_millis(1600)).await;
    assert!(w.state(&w.alice).await["notice"].is_null(), "the sweep clears it after the notice time");
}

#[tokio::test]
async fn a_rejected_login_stops_the_bot_and_nothing_retakes_the_session() {
    let w = world_with(|config| config.error_hold = Duration::from_millis(400), false).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    w.join(&mut alice).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    assert_eq!(w.play(&w.alice, &track_uri(1)).await.0, StatusCode::OK);
    owner.spotify().await;
    assert_eq!(w.event("error", json!({"reason": "auth", "message": format!("{HOUSE} login rejected https://x.example")})).await, StatusCode::NO_CONTENT);
    let failed = owner.spotify().await;
    assert_eq!(
        (failed["state"]["status"].as_str(), failed["state"]["error"].as_str()),
        (Some("error"), Some("Spotify needs the server owner to sign in again"))
    );
    assert_eq!(failed["state"]["playing"], false);
    assert_clean("the error state", &failed);
    until("the bot is stopped", || w.bot.deletes() == 1).await;
    // The bot is not sent the session again, even by the lease.
    let puts = w.bot.puts().len();
    vokko_server::voice::spotify::spawn_tasks(w.app.state.clone());
    owner.ended().await;
    assert_eq!(w.bot.puts().len(), puts, "no retake");
    assert_eq!(w.event("started", json!({})).await, StatusCode::NO_CONTENT, "late events are not an error");
}

#[tokio::test]
async fn a_rejected_login_shows_a_fixed_text_and_an_io_error_is_retried_once() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    assert_eq!(w.event("started", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.event("error", json!({"reason": "io", "position_ms": 9000, "message": HOUSE})).await, StatusCode::NO_CONTENT);
    until("the track is sent again", || w.bot.puts().len() == 2).await;
    let again = w.bot.last_put();
    assert_eq!((again["position_ms"].as_u64().map(|ms| ms >= 9000), again["track"].as_str()), (Some(true), Some(track_uri(1).as_str())));
    assert_eq!(w.state(&w.alice).await["status"], "playing", "no error shown for the first io error");
    assert_eq!(w.event("error", json!({"reason": "io", "position_ms": 9100})).await, StatusCode::NO_CONTENT);
    let state = w.state(&w.alice).await;
    assert_eq!((state["status"].as_str(), state["error"].as_str()), (Some("error"), Some("Spotify lost its connection.")));
    assert!(w.bot.deletes() >= 1);

    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    for _ in 0..2 {
        assert_eq!(w.event("error", json!({"reason": format!("auth {HOUSE}")})).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(w.state(&w.alice).await["error"], "Spotify lost its connection.", "an unknown reason counts as io and is never shown");
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    assert_eq!(w.event("error", json!({"reason": "auth"})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.state(&w.alice).await["error"], "Spotify needs the server owner to sign in again");
}

#[tokio::test]
async fn an_idle_session_comes_back_cleanly_when_someone_queues_a_track() {
    let w = world_with(|config| config.lease_interval = Duration::from_millis(150), false).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    vokko_server::voice::spotify::spawn_tasks(w.app.state.clone());
    assert_eq!(w.event("started", json!({})).await, StatusCode::NO_CONTENT);
    until("a lease", || w.bot.puts().len() >= 2).await;
    let deletes = w.bot.deletes();
    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    let idle = w.state(&w.alice).await;
    assert_eq!((idle["track"].is_null(), idle["status"].as_str(), idle["playing"].as_bool()), (true, Some("paused"), Some(false)), "{idle}");
    until("the bot lets go", || w.bot.deletes() > deletes).await;
    // An idle session is not renewed: the bot drops it after 150 s on its own.
    let puts = w.bot.puts().len();
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert_eq!(w.bot.puts().len(), puts, "no lease without a track");

    let before = w.bot.last_put()["seq"].as_u64();
    let (status, back) = w.patch(&w.alice, json!({"queue_add": {"uri": track_uri(2)}})).await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!((back["track"]["uri"].as_str(), back["status"].as_str(), back["playing"].as_bool()), (Some(track_uri(2).as_str()), Some("loading"), Some(true)));
    until("the session is sent again", || w.bot.puts().len() > puts).await;
    let fresh = w.bot.puts()[puts].clone();
    assert_eq!((fresh["track"].as_str(), fresh["position_ms"].as_u64(), fresh["playing"].as_bool()), (Some(track_uri(2).as_str()), Some(0), Some(true)));
    assert!(fresh["seq"].as_u64() > before, "a new seq, so the bot treats it as a fresh session");
    assert_eq!(w.event("started", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.state(&w.alice).await["status"], "playing");
    // A play from the idle state works the same way.
    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.play(&w.alice, &track_uri(3)).await.1["track"]["uri"], track_uri(3));
}

#[tokio::test]
async fn an_idle_session_ends_after_its_timeout_and_a_long_pause_stops_playing() {
    let w = world_with(
        |config| {
            config.empty_timeout = Duration::from_millis(300);
            config.pause_timeout = Duration::from_millis(300);
        },
        false,
    )
    .await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    vokko_server::voice::spotify::spawn_tasks(w.app.state.clone());
    assert_eq!(w.event("ended", json!({})).await, StatusCode::NO_CONTENT);
    assert!(owner.ended().await["state"].is_null(), "idle for too long");
    until("the bot is stopped", || w.bot.deletes() >= 2).await;

    assert_eq!(w.play(&w.alice, &track_uri(2)).await.0, StatusCode::OK);
    assert_eq!(w.event("started", json!({})).await, StatusCode::NO_CONTENT);
    assert_eq!(w.patch(&w.alice, json!({"playing": false})).await.1["status"], "paused");
    assert!(owner.ended().await["state"].is_null(), "paused for too long");
}

#[tokio::test]
async fn the_bot_gets_the_desired_state_again_as_a_lease_and_an_unreachable_bot_ends_the_session() {
    let w = world_with(|config| config.lease_interval = Duration::from_millis(150), false).await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    w.playing(&mut alice, 1).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    vokko_server::voice::spotify::spawn_tasks(w.app.state.clone());
    until("the startup DELETE", || w.bot.deletes() >= 1).await;
    until("three PUTs", || w.bot.puts().len() >= 3).await;
    let puts = w.bot.puts();
    assert_eq!(
        (&puts[0]["token"], &puts[0]["track"], &puts[0]["seq"]),
        (&puts[2]["token"], &puts[2]["track"], &puts[2]["seq"]),
        "the same desired state, the same seq"
    );
    assert!(puts[2]["position_ms"].as_u64() > puts[0]["position_ms"].as_u64(), "and the position moves on while it plays");
    w.bot.answer(500);
    assert!(owner.ended().await["state"].is_null(), "the bot stayed unreachable");
}

#[tokio::test]
async fn a_busy_or_refusing_bot_fails_the_start_cleanly() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.join(&mut alice).await;
    for status in [503, 500, 401] {
        w.bot.answer(status);
        let (code, body) = w.play(&w.alice, &track_uri(1)).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{status}: {body}");
        assert!(!body.to_string().contains(BOT_SECRET));
        assert_eq!(w.app.get(&w.path(), &w.alice).await.0, StatusCode::BAD_REQUEST, "no session is left behind");
    }
    w.bot.answer(0);
    assert_eq!(w.play(&w.alice, &track_uri(1)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_failed_put_on_a_running_session_keeps_it_for_the_sweep_to_retry() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    w.bot.answer(500);
    assert_eq!(w.play(&w.alice, &track_uri(2)).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&w.path(), &w.alice).await.0, StatusCode::OK, "the session survives");
}

#[tokio::test]
async fn a_private_playlist_is_not_shown_and_bot_reads_are_capped_for_everyone() {
    let w = world().await;
    let reads = |w: &World| w.bot.all().iter().filter(|request| request.path.starts_with("/catalog/")).count();
    // The Web API hides it and the bot does not call it Spotify's own: a playlist of the house account stays unreachable by id.
    let private = "/spotify/playlists/P000000000000000000098";
    assert_eq!(w.app.get(private, &w.alice).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.get("/spotify/playlists/P000000000000000000099", &w.alice).await.0, StatusCode::OK, "Spotify's own is");

    // An offset past the end costs the bot nothing: the length of the first page answers it, and it is not cached per offset.
    let first = "/spotify/playlists/P000000000000000000001";
    assert_eq!(w.app.get(first, &w.alice).await.0, StatusCode::OK);
    let before = reads(&w);
    for offset in [250, 5000, 99_999] {
        let (status, page) = w.app.get(&format!("{first}?offset={offset}"), &w.alice).await;
        assert_eq!((status, page["total"].clone(), page["tracks"].as_array().map(Vec::len)), (StatusCode::OK, json!(250), Some(0)), "{offset}");
    }
    assert_eq!(reads(&w), before, "no bot read for an offset past the end");

    // Whoever asks, the bot gets a burst of 10 reads and then a slow trickle: new playlists run into the cap.
    let mut limited = None;
    for n in 2..=30 {
        let (status, body) = w.app.get(&format!("/spotify/playlists/P{n:021}"), &w.alice).await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = Some(n);
            break;
        }
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    assert!(limited.is_some_and(|n| n <= 12), "{limited:?}");
    assert!(reads(&w) <= 11, "{} reads", reads(&w));
    assert_eq!(w.app.get(first, &w.carl).await.0, StatusCode::OK, "what is cached is still served");
}

#[tokio::test]
async fn the_last_person_leaving_ends_the_session() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.playing(&mut alice, 1).await;
    w.join(&mut carl).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    owner.voice(None).await;
    alice.voice(None).await;
    assert_eq!(w.bot.deletes(), 0, "carl is still inside");
    assert!(w.app.get(&w.path(), &w.carl).await.0 == StatusCode::OK);
    carl.voice(None).await;
    until("the bot's DELETE", || w.bot.deletes() == 1).await;
    assert_eq!(w.app.get(&w.path(), &w.alice).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ready_and_late_joiners_carry_the_session() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    let (mut owner, ready) = Client::identify(&w.address, &w.owner).await;
    let carried: Vec<&Value> = ready["guilds"].as_array().expect("guilds").iter().flat_map(|guild| guild["spotify"].as_array().into_iter().flatten()).collect();
    assert_eq!(carried.len(), 1, "{ready}");
    assert_eq!((carried[0]["channel_id"].as_str(), carried[0]["state"]["track"]["uri"].as_str()), (Some(w.voice.as_str()), Some(track_uri(1).as_str())));
    assert_clean("READY", &carried[0]["state"]);
    // Joining the call is followed by the running session.
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    let update = owner.spotify().await;
    assert_eq!(update["state"]["track"]["uri"], track_uri(1));
    // Someone who cannot see the channel hears nothing.
    let (stranger_token, _) = w.app.register("stranger").await;
    let (mut stranger, ready) = Client::identify(&w.address, &stranger_token).await;
    assert!(ready["guilds"].as_array().is_none_or(|guilds| guilds.iter().all(|guild| guild.get("spotify").is_none())), "{ready}");
    assert_eq!(w.patch(&w.alice, json!({"playing": false})).await.0, StatusCode::OK);
    assert!(stranger.silent_for("SPOTIFY_UPDATE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn listener_tokens_are_subscribe_only_and_strangers_are_removed_from_the_room() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.join(&mut alice).await;
    let listener = format!("{}/listener-token", w.path());
    assert_eq!(w.app.post(&listener, &w.alice, json!({})).await.1["code"], 40033, "nothing is playing yet");
    assert_eq!(w.play(&w.alice, &track_uri(1)).await.0, StatusCode::OK);
    assert_eq!(w.app.post(&listener, &w.carl, json!({})).await.0, StatusCode::FORBIDDEN, "carl is not in the call");
    let (status, first) = w.app.post(&listener, &w.alice, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["url"], "wss://media.test");
    let now = vokko_server::voice::unix_now();
    let claims = token::verify(MEDIA_SECRET, first["token"].as_str().expect("token"), now).expect("signed with the media secret");
    let grant = claims.video.expect("grant");
    let room = grant.room.clone().expect("room");
    assert!(room.starts_with(&format!("spotify-{}-", w.voice)));
    assert_eq!(room_of(w.bot.last_put()["token"].as_str().expect("token")), room, "the bot and the listeners share the room");
    assert!(grant.room_join && grant.can_subscribe && !grant.can_publish && !grant.can_publish_data && grant.can_publish_sources.is_empty());
    assert!(claims.sub.starts_with(&format!("viewer:{}:", w.alice_id)), "{}", claims.sub);
    assert!((6 * 3600 - 30..=6 * 3600 + 30).contains(&(claims.exp - now)), "6 h");
    let (_, second) = w.app.post(&listener, &w.alice, json!({})).await;
    assert_ne!(
        claims.sub,
        token::verify(MEDIA_SECRET, second["token"].as_str().expect("token"), now).expect("claims").sub,
        "two devices do not share an identity"
    );

    w.join(&mut carl).await;
    let carl_listener = format!("viewer:{}:ab12cd34", w.carl_id);
    let alice_listener = format!("viewer:{}:ef56ef56", w.alice_id);
    for identity in [&carl_listener, &alice_listener, "bot:spotify:1"] {
        w.media.add_participant(&room, viewer(identity));
    }
    carl.voice(None).await;
    until("carl's listener is removed", || w.media.calls().contains(&format!("RemoveParticipant {room} {carl_listener}"))).await;
    let calls = w.media.calls();
    assert!(!calls.iter().any(|call| call.contains(&alice_listener) || call.contains("bot:spotify")), "only the leaver goes: {calls:?}");

    // A token that outlives the person's place in the call joins again, and the next tick removes it once more.
    w.media.add_participant(&room, viewer(&carl_listener));
    let removals = |media: &FakeRoomService| media.calls().iter().filter(|call| call.starts_with("RemoveParticipant")).count();
    let before = removals(&w.media);
    vokko_server::voice::spotify::spawn_tasks(w.app.state.clone());
    until("the sweep removes the returning listener", || removals(&w.media) > before).await;
}

#[tokio::test]
async fn every_session_has_its_own_media_room() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    let first = room_of(w.bot.last_put()["token"].as_str().expect("token"));
    assert_eq!(w.play(&w.alice, &track_uri(2)).await.0, StatusCode::OK);
    assert_eq!(room_of(w.bot.last_put()["token"].as_str().expect("token")), first, "changing the track keeps the room");
    assert_eq!(w.app.delete(&w.path(), &w.alice).await.0, StatusCode::NO_CONTENT);
    until("the room is closed", || w.media.calls().contains(&format!("DeleteRoom {first}"))).await;
    assert_eq!(w.play(&w.alice, &track_uri(1)).await.0, StatusCode::OK);
    assert_ne!(room_of(w.bot.last_put()["token"].as_str().expect("token")), first, "the next session is another room");
}

#[tokio::test]
async fn there_is_one_session_on_the_server_and_the_message_names_only_what_the_caller_can_see() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    // A private guild alice is not in, and a second voice channel in her own guild.
    let (secret_guild, _) = w.app.guild_with_channel(&w.owner).await;
    let secret_voice = voice_channel(&w.app, &w.owner, &secret_guild).await;
    let (status, lounge) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "lounge", "type": 2})).await;
    assert_eq!(status, StatusCode::OK, "{lounge}");
    let lounge = lounge["id"].as_str().expect("id").to_owned();

    owner.voice(Some(&secret_voice)).await;
    owner.voice_answer().await;
    let (status, played) = w.app.put_json(&format!("/channels/{secret_voice}/spotify"), &w.owner, json!({"uri": track_uri(1)})).await;
    assert_eq!(status, StatusCode::OK, "{played}");
    w.join(&mut alice).await;
    let (status, busy) = w.play(&w.alice, &track_uri(2)).await;
    assert_eq!((status, busy["code"].as_u64()), (StatusCode::CONFLICT, Some(40035)), "{busy}");
    assert_eq!(busy["message"], "Spotify is already playing in another call.", "she cannot see that channel");
    assert_eq!(w.bot.puts().len(), 1, "the bot was not touched");
    assert_eq!(w.app.delete(&format!("/channels/{secret_voice}/spotify"), &w.owner).await.0, StatusCode::NO_CONTENT);

    owner.voice(Some(&lounge)).await;
    owner.voice_answer().await;
    assert_eq!(w.app.put_json(&format!("/channels/{lounge}/spotify"), &w.owner, json!({"uri": track_uri(1)})).await.0, StatusCode::OK);
    let (status, busy) = w.play(&w.alice, &track_uri(2)).await;
    assert_eq!((status, busy["code"].as_u64()), (StatusCode::CONFLICT, Some(40035)));
    let message = busy["message"].as_str().expect("message");
    assert!(message.contains("#lounge") && message.contains("Test guild") && message.contains("sam"), "{message}");
    assert_eq!(w.app.get(&format!("/channels/{lounge}/spotify"), &w.alice).await.0, StatusCode::FORBIDDEN, "and she still cannot read it");
}

#[tokio::test]
async fn spotify_and_stremio_refuse_each_other_in_one_channel() {
    let w = world_with(tune_default, true).await;
    assert!(w.stremio.is_some());
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    w.join(&mut alice).await;
    w.join(&mut carl).await;
    let stremio = format!("/channels/{}/stremio", w.voice);
    for token in [&w.alice, &w.carl] {
        assert_eq!(w.app.post("/users/@me/stremio/login", token, json!({"email": "a@b.test", "password": "pw"})).await.0, StatusCode::NO_CONTENT);
    }
    let (_, streams) = w.app.get("/stremio/streams/movie/tt0111161", &w.alice).await;
    let sid = streams["streams"][0]["sid"].as_str().expect("sid").to_owned();

    // Spotify first: the movie is refused.
    assert_eq!(w.play(&w.alice, &track_uri(1)).await.0, StatusCode::OK);
    let (status, refused) = w.app.put_json(&stremio, &w.alice, json!({"sid": sid})).await;
    assert_eq!((status, refused["code"].as_u64()), (StatusCode::CONFLICT, Some(40034)), "{refused}");
    assert_eq!(w.app.delete(&w.path(), &w.alice).await.0, StatusCode::NO_CONTENT);

    // The movie first: Spotify is refused, and nothing was sent to the Spotify bot for it.
    let puts = w.bot.puts().len();
    let (status, started) = w.app.put_json(&stremio, &w.alice, json!({"sid": sid})).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let (status, refused) = w.play(&w.carl, &track_uri(2)).await;
    assert_eq!((status, refused["code"].as_u64()), (StatusCode::CONFLICT, Some(40034)), "{refused}");
    assert_eq!(w.bot.puts().len(), puts, "the Spotify bot got nothing");
    assert_eq!(w.app.get(&w.path(), &w.alice).await.0, StatusCode::BAD_REQUEST, "no Spotify session was left behind");
}

#[tokio::test]
async fn the_bot_endpoint_checks_its_secret_and_ignores_what_it_does_not_know() {
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.playing(&mut alice, 1).await;
    let body = json!({"channel_id": w.voice, "event": "ended", "track": track_uri(1), "seq": w.bot.last_put()["seq"]});
    assert_eq!(w.bot_event("wrong-secret-0123456789", body.clone()).await, StatusCode::UNAUTHORIZED);
    assert_eq!(w.bot_event("", body.clone()).await, StatusCode::UNAUTHORIZED);
    assert_eq!(w.state(&w.alice).await["track"]["uri"], track_uri(1), "a wrong secret changes nothing");
    for odd in [
        json!({"channel_id": "not-a-number", "event": "ended"}),
        json!({"channel_id": w.voice, "event": "dance", "track": track_uri(1)}),
        json!({"channel_id": w.voice, "event": "position"}),
    ] {
        assert_eq!(w.bot_event(BOT_SECRET, odd).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(w.state(&w.alice).await["track"]["uri"], track_uri(1));
    // The secret is checked before the body is read as JSON.
    for (authorization, expected) in
        [(format!("Bearer {BOT_SECRET}"), StatusCode::UNPROCESSABLE_ENTITY), ("Bearer wrong-secret-0123456789".to_owned(), StatusCode::UNAUTHORIZED)]
    {
        let request = Request::post("/internal/spotify/bot").header("authorization", authorization).body(Body::from("not json")).expect("request");
        assert_eq!(w.app.router.clone().oneshot(request).await.expect("response").status(), expected);
    }
}

#[tokio::test]
async fn nothing_about_the_house_account_reaches_a_client() {
    let w = world().await;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    w.join(&mut alice).await;
    owner.voice(Some(&w.voice)).await;
    owner.voice_answer().await;
    let mut seen = vec![w.play(&w.alice, &album_uri(1)).await.1];
    let leaky = json!({"display_name": HOUSE, "user": HOUSE, "country": "SE", "message": format!("{HOUSE} https://open.spotify.com/user/{HOUSE}"), "playlist": "Private mix", "device": "iPhone"});
    for (event, reason) in [("started", None), ("position", None), ("error", Some("unavailable")), ("error", Some(HOUSE)), ("ended", None)] {
        let mut extra = leaky.clone();
        if let Some(reason) = reason {
            extra["reason"] = json!(reason);
        }
        assert_eq!(w.event(event, extra).await, StatusCode::NO_CONTENT);
        seen.push(w.state(&w.alice).await);
        seen.push(w.patch(&w.alice, json!({"playing": true})).await.1);
    }
    assert_eq!(w.app.post(&format!("{}/listener-token", w.path()), &w.alice, json!({})).await.0, StatusCode::OK);
    for body in seen {
        assert_clean("a reply", &body);
        assert!(!body.to_string().contains("Private mix"));
    }
    // Every event the owner got along the way is clean too.
    while let Ok(Ok(update)) = tokio::time::timeout(Duration::from_millis(200), async { Ok::<_, ()>(owner.spotify().await) }).await {
        assert_clean("SPOTIFY_UPDATE", &update);
    }
    // And the server asked Spotify for nothing but the catalog, with its own app token.
    assert!(w.mock.paths().iter().all(|path| path == "/api/token" || allowed_path(path)), "{:?}", w.mock.paths());
}

/// docs/design/bot-control.md: with CONTROL_MEDIA denied to @everyone in the channel, carl (in the call, not the host) only
/// appends within his quota of 10, removes his own entries, votes and skips what he added; previous restores who added a track.
#[tokio::test]
async fn without_control_media_others_vote_skip_their_own_and_queue_ten() {
    use vokko_protocol::api::permissions::CONTROL_MEDIA;
    let w = world().await;
    let mut alice = Client::identify(&w.address, &w.alice).await.0;
    let mut carl = Client::identify(&w.address, &w.carl).await.0;
    let mut owner = Client::identify(&w.address, &w.owner).await.0;
    w.playing(&mut alice, 1).await;
    w.join(&mut carl).await;
    w.join(&mut owner).await;
    let deny = json!({"type": 0, "allow": "0", "deny": CONTROL_MEDIA.to_string()});
    assert_eq!(w.app.put_json(&format!("/channels/{}/permissions/{}", w.voice, w.guild), &w.owner, deny).await.0, StatusCode::NO_CONTENT);
    let (_, state) = w.patch(&w.alice, json!({"queue_add": {"uri": track_uri(20), "next": false}})).await;
    let hers = state["queue"][0]["qid"].as_str().expect("qid").to_owned();

    for body in [
        json!({"playing": false}),
        json!({"position_ms": 5}),
        json!({"previous": true}),
        json!({"loop": "queue"}),
        json!({"shuffle": true}),
        json!({"queue_add": {"uri": track_uri(21), "next": true}}),
        json!({"queue_move": {"qid": hers, "to": 0}}),
        json!({"queue_clear": true}),
        json!({"queue_remove": hers}),
    ] {
        assert_eq!(w.patch(&w.carl, body.clone()).await.0, StatusCode::FORBIDDEN, "{body}");
    }
    assert_eq!(w.play(&w.carl, &track_uri(2)).await.0, StatusCode::FORBIDDEN, "replace");
    assert_eq!(w.app.delete(&w.path(), &w.carl).await.0, StatusCode::FORBIDDEN, "stop");

    // A playlist from carl queues 10; then he is full until he removes one of his own.
    let (_, state) = w.patch(&w.carl, json!({"queue_add": {"uri": playlist_uri(1), "next": false}})).await;
    let by_carl = state["queue"].as_array().expect("queue").iter().filter(|entry| entry["added_by"] == w.carl_id.as_str()).count();
    assert_eq!(by_carl, 10);
    assert!(state["left_out"].as_u64().is_some_and(|left| left > 0), "{}", state["left_out"]);
    let (status, body) = w.patch(&w.carl, json!({"queue_add": {"uri": track_uri(22), "next": false}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let his = state["queue"][10]["qid"].as_str().expect("qid").to_owned();
    assert_eq!(w.patch(&w.carl, json!({"queue_remove": his})).await.0, StatusCode::OK);

    // Three listeners need two votes; a withdrawn vote goes; a controller skips at once.
    let (_, voted) = w.patch(&w.carl, json!({"skip": true})).await;
    assert_eq!(
        (voted["track"]["uri"].as_str(), voted["skip_votes"].clone(), voted["skip_needed"].as_u64()),
        (Some(track_uri(1).as_str()), json!([w.carl_id]), Some(2))
    );
    assert_eq!(w.patch(&w.carl, json!({"skip": false})).await.1["skip_votes"], json!([]));
    let (_, skipped) = w.patch(&w.alice, json!({"skip": true})).await;
    assert_eq!((skipped["track"]["uri"].as_str(), skipped["added_by"].as_str()), (Some(track_uri(20).as_str()), Some(w.alice_id.as_str())));
    let (_, skipped) = w.patch(&w.owner, json!({"skip": true})).await;
    assert_eq!(skipped["added_by"], w.carl_id.as_str());

    // Previous brings back alice's track with alice as its adder, so carl's skip there is only a vote.
    let (_, back) = w.patch(&w.alice, json!({"previous": true})).await;
    assert_eq!((back["track"]["uri"].as_str(), back["added_by"].as_str()), (Some(track_uri(20).as_str()), Some(w.alice_id.as_str())));
    assert_eq!(w.patch(&w.carl, json!({"skip": true})).await.1["track"]["uri"], track_uri(20));
    let (_, his_turn) = w.patch(&w.alice, json!({"skip": true})).await;
    let first = his_turn["track"]["uri"].clone();
    assert_eq!(his_turn["added_by"], w.carl_id.as_str());
    let (_, own) = w.patch(&w.carl, json!({"skip": true})).await;
    assert_ne!(own["track"]["uri"], first, "the adder skips without a vote");
    assert_eq!(own["added_by"], w.carl_id.as_str());
}
