//! Test harness: every test gets its own `vokko_test_<unix>_<rand>` database (never any other name), dropped on drop.
#![allow(dead_code)]
use std::path::PathBuf;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgPoolOptions};
use sqlx::{Connection, Executor};
use tower::ServiceExt;
use vokko_server::config::DotEnv;
use vokko_server::{AppState, Config};

/// How long a test waits for something that should happen (a gateway frame, a background task) before failing. Generous:
/// a busy machine or a remote test database can take seconds, and a passing test never waits this long.
pub const WAIT: std::time::Duration = std::time::Duration::from_secs(30);

pub struct TestApp {
    pub state: AppState,
    pub router: Router,
    admin_options: PgConnectOptions,
    db_name: String,
    pub data_dir: PathBuf,
}

fn test_database_url() -> String {
    let env_file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join(".env.dev");
    DotEnv::from_file(&env_file).get("TEST_DATABASE_URL").expect("TEST_DATABASE_URL (environment or .env.dev)")
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0)
}

impl TestApp {
    pub async fn new() -> Self {
        Self::with_heartbeat(60_000).await
    }

    pub async fn with_heartbeat(heartbeat_interval_ms: u64) -> Self {
        Self::with_config(|config| config.heartbeat_interval_ms = heartbeat_interval_ms).await
    }

    /// `adjust` runs on a config with rate limiting disabled.
    pub async fn with_config(adjust: impl FnOnce(&mut Config)) -> Self {
        Self::build(adjust, AppState::new).await
    }

    /// Like `with_config`, with a LiveKit RoomService of the test's choosing (voice tests pass a fake).
    pub async fn with_room_service(adjust: impl FnOnce(&mut Config), rooms: std::sync::Arc<dyn vokko_server::voice::livekit::RoomService>) -> Self {
        Self::build(adjust, move |pool, config| AppState::with_room_service(pool, config, rooms)).await
    }

    /// Like `with_room_service`, with one RoomService per LiveKit backend (in the order of `config.livekit`).
    pub async fn with_room_services(adjust: impl FnOnce(&mut Config), rooms: Vec<std::sync::Arc<dyn vokko_server::voice::livekit::RoomService>>) -> Self {
        Self::build(adjust, move |pool, config| AppState::with_room_services(pool, config, rooms)).await
    }

    /// Like `with_config`, with an attachment backend of the test's choosing (upload tests pass one that fails or stalls).
    pub async fn with_storage(adjust: impl FnOnce(&mut Config), storage: std::sync::Arc<dyn vokko_server::storage::Storage>) -> Self {
        Self::build(adjust, move |pool, config| AppState::with_storage(pool, config, storage)).await
    }

    async fn build(adjust: impl FnOnce(&mut Config), make: impl FnOnce(sqlx::PgPool, Config) -> AppState) -> Self {
        let admin_options = PgConnectOptions::from_str(&test_database_url()).expect("valid TEST_DATABASE_URL");
        // VOKKO_TEST_DB_PREFIX (e.g. `vokko_test_search`) lets parallel workers keep their databases apart.
        let prefix = std::env::var("VOKKO_TEST_DB_PREFIX").unwrap_or_else(|_| "vokko_test".to_owned());
        let db_name = format!("{prefix}_{}_{}", unix_seconds(), vokko_server::auth::random_hex(4));
        assert!(db_name.starts_with("vokko_test"));
        let mut admin = PgConnection::connect_with(&admin_options).await.expect("connect to the test database server");
        sweep_stale(&mut admin).await;
        admin.execute(format!("CREATE DATABASE \"{db_name}\"").as_str()).await.expect("create test database (role needs CREATEDB)");
        let pool = PgPoolOptions::new().max_connections(8).connect_with(admin_options.clone().database(&db_name)).await.expect("connect to the fresh database");
        vokko_server::migrate(&pool).await.expect("migrations apply");
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("target").join("test-data").join(&db_name);
        std::fs::create_dir_all(data_dir.join("attachments")).expect("data dir");
        let mut config = Config::new("unused".to_owned(), "127.0.0.1:0".to_owned(), data_dir.clone(), "http://test.local".to_owned());
        config.heartbeat_interval_ms = 60_000;
        config.rate_limit = None;
        config.unfurl.enabled = false; // tests that exercise link previews opt in
        config.accounts.mail = vokko_server::account::config::MailConfig::Memory;
        adjust(&mut config);
        let state = make(pool, config);
        let router = vokko_server::router(state.clone());
        Self { state, router, admin_options, db_name, data_dir }
    }

    pub async fn send(&self, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
        self.send_with(method, path, token, &[], body).await
    }

    /// `send` with extra request headers.
    pub async fn send_with(&self, method: Method, path: &str, token: Option<&str>, headers: &[(&str, &str)], body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(format!("/api/v1{path}"));
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        if let Some(token) = token {
            builder = builder.header("authorization", token);
        }
        let request = match body {
            Some(value) => builder.header("content-type", "application/json").body(Body::from(value.to_string())),
            None => builder.body(Body::empty()),
        }
        .expect("request");
        let response = self.router.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
        let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
        (status, value)
    }

    /// POSTs raw bytes (not JSON) with the given content type.
    pub async fn post_bytes(&self, path: &str, token: Option<&str>, content_type: &str, body: Vec<u8>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(Method::POST).uri(format!("/api/v1{path}")).header("content-type", content_type);
        if let Some(token) = token {
            builder = builder.header("authorization", token);
        }
        let response = self.router.clone().oneshot(builder.body(Body::from(body)).expect("request")).await.expect("response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
        (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) })
    }

    pub async fn get(&self, path: &str, token: &str) -> (StatusCode, Value) {
        self.send(Method::GET, path, Some(token), None).await
    }

    pub async fn post(&self, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
        self.send(Method::POST, path, Some(token), Some(body)).await
    }

    pub async fn patch(&self, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
        self.send(Method::PATCH, path, Some(token), Some(body)).await
    }

    pub async fn put(&self, path: &str, token: &str) -> (StatusCode, Value) {
        self.send(Method::PUT, path, Some(token), None).await
    }

    pub async fn put_json(&self, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
        self.send(Method::PUT, path, Some(token), Some(body)).await
    }

    /// A guild with a `#general` channel owned by `token`; returns (guild id, channel id).
    pub async fn guild_with_channel(&self, token: &str) -> (String, String) {
        let (status, guild) = self.post("/guilds", token, json!({"name": "Test guild"})).await;
        assert_eq!(status, StatusCode::OK, "create guild: {guild}");
        let guild_id = guild["id"].as_str().expect("guild id").to_owned();
        let (_, channels) = self.get(&format!("/guilds/{guild_id}/channels"), token).await;
        let channel =
            channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general channel")["id"].as_str().expect("id").to_owned();
        (guild_id, channel)
    }

    /// A bot application of `owner`'s, added to `guild`; returns (bot user id, "Bot <token>").
    pub async fn bot_in(&self, owner: &str, guild: &str, name: &str) -> (String, String) {
        let (status, created) = self.post("/applications", owner, json!({"name": name})).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let id = created["id"].as_str().expect("id").to_owned();
        let (status, added) = self.post(&format!("/oauth2/authorize?client_id={id}"), owner, json!({"guild_id": guild, "permissions": "2048"})).await;
        assert_eq!(status, StatusCode::OK, "{added}");
        (id, format!("Bot {}", created["token"].as_str().expect("token")))
    }

    /// `token` posts `content` in `channel`; returns the message id.
    pub async fn say(&self, channel: &str, token: &str, content: &str) -> String {
        let (status, message) = self.post(&format!("/channels/{channel}/messages"), token, json!({"content": content})).await;
        assert_eq!(status, StatusCode::OK, "{message}");
        message["id"].as_str().expect("id").to_owned()
    }

    pub async fn delete(&self, path: &str, token: &str) -> (StatusCode, Value) {
        self.send(Method::DELETE, path, Some(token), None).await
    }

    /// Registers a user; returns (token, user json).
    pub async fn register(&self, username: &str) -> (String, Value) {
        let body =
            json!({"email": format!("{username}@example.test"), "username": username, "password": "correct horse battery", "date_of_birth": "1990-01-01"});
        let (status, value) = self.send(Method::POST, "/auth/register", None, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "register {username}: {value}");
        (value["token"].as_str().expect("token").to_owned(), value["user"].clone())
    }

    /// The token of the latest `<page>#token=` link mailed to `to`.
    pub fn mailed_token(&self, to: &str, page: &str) -> String {
        let marker = format!("/{page}#token=");
        let mails = self.state.accounts.mailer.sent();
        let mail = mails.iter().rev().find(|mail| mail.to == to && mail.body.contains(&marker)).unwrap_or_else(|| panic!("no {page} mail to {to}: {mails:?}"));
        let start = mail.body.find(&marker).expect("marker") + marker.len();
        mail.body[start..].chars().take_while(char::is_ascii_hexdigit).collect()
    }

    /// Like `mailed_token`, for mails sent in the background (password reset): waits up to `WAIT`.
    pub async fn mailed_token_soon(&self, to: &str, page: &str) -> String {
        let marker = format!("/{page}#token=");
        let deadline = tokio::time::Instant::now() + WAIT;
        while tokio::time::Instant::now() < deadline {
            if self.state.accounts.mailer.sent().iter().any(|mail| mail.to == to && mail.body.contains(&marker)) {
                return self.mailed_token(to, page);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        self.mailed_token(to, page)
    }

    /// Opens the verification link mailed to `to` (marks the address verified).
    pub async fn verify_email(&self, to: &str) {
        let token = self.mailed_token(to, "verify");
        let (status, body) = self.send(Method::POST, "/auth/verify", None, Some(json!({"token": token}))).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "verify {to}: {body}");
    }

    /// Serves the router on an ephemeral loopback port (never an 87xx port) for WebSocket tests.
    pub async fn serve(&self) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral port");
        let address = listener.local_addr().expect("address");
        let router = self.router.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await;
        });
        format!("{address}")
    }
}

async fn sweep_stale(admin: &mut PgConnection) {
    let cutoff = unix_seconds().saturating_sub(3600);
    let Ok(rows) = sqlx::query_as::<_, (String,)>("SELECT datname FROM pg_database WHERE datname LIKE 'vokko\\_test\\_%'").fetch_all(&mut *admin).await else {
        return;
    };
    for (name,) in rows {
        let stamp = name.strip_prefix("vokko_test_").and_then(|rest| rest.split('_').next()).and_then(|part| part.parse::<u64>().ok());
        if stamp.is_some_and(|stamp| stamp < cutoff) {
            let _ = admin.execute(format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)").as_str()).await;
        }
    }
}

/// A tiny HTTP server on an ephemeral loopback port that plays web pages for the unfurler tests.
pub struct PageServer {
    pub address: String,
    hits: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl PageServer {
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral port");
        let address = listener.local_addr().expect("address").to_string();
        let hits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = hits.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let seen = seen.clone();
                tokio::spawn(async move {
                    let _ = serve_page(stream, seen).await;
                });
            }
        });
        Self { address, hits }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }

    /// How many requests for `path` arrived so far.
    pub fn count(&self, path: &str) -> usize {
        self.hits.lock().expect("hits").iter().filter(|hit| hit.as_str() == path).count()
    }

    pub fn total(&self) -> usize {
        self.hits.lock().expect("hits").len()
    }
}

async fn serve_page(mut stream: tokio::net::TcpStream, hits: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut head = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
    hits.lock().expect("hits").push(path.clone());
    let base = format!("http://{}", stream.local_addr()?);
    let (status, content_type, extra, body): (&str, &str, String, Vec<u8>) = match path.as_str() {
        "/page" => (
            "200 OK",
            "text/html; charset=utf-8",
            String::new(),
            format!(
                "<!doctype html><html><head><title>Fallback</title>\
                 <meta property=\"og:title\" content=\"Vokko &amp; friends\">\
                 <meta property=\"og:description\" content=\"An open source chat app\">\
                 <meta property=\"og:image\" content=\"/card.png\">\
                 <meta property=\"og:site_name\" content=\"Vokko\">\
                 <meta name=\"theme-color\" content=\"#5865f2\"></head><body>{base}</body></html>"
            )
            .into_bytes(),
        ),
        "/redirect" => ("302 Found", "text/plain", "Location: /page\r\n".to_owned(), Vec::new()),
        "/loop" => ("302 Found", "text/plain", "Location: /loop\r\n".to_owned(), Vec::new()),
        "/image.png" => ("200 OK", "image/png", String::new(), vec![0x89, b'P', b'N', b'G']),
        "/text" => ("200 OK", "text/plain", String::new(), b"just text".to_vec()),
        // a real 1x1 PNG header, a PNG-labelled HTML page, an SVG and a PNG past the embed-media cap
        "/card.png" => ("200 OK", "image/png", String::new(), TINY_PNG.to_vec()),
        "/to-card" => ("302 Found", "text/plain", "Location: /card.png\r\n".to_owned(), Vec::new()),
        "/fake.png" => ("200 OK", "image/png", String::new(), b"<html><script>alert(1)</script></html>".to_vec()),
        "/icon.svg" => ("200 OK", "image/svg+xml", String::new(), b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec()),
        "/huge.png" => {
            let mut body = TINY_PNG.to_vec();
            body.resize(9 * 1024 * 1024, 0);
            ("200 OK", "image/png", String::new(), body)
        }
        "/late" => {
            // The Open Graph tags start after the 1 MiB cap.
            let mut html = String::from("<html><head>");
            html.push_str(&" ".repeat(1_100_000));
            html.push_str("<meta property=\"og:title\" content=\"Too late\"></head></html>");
            ("200 OK", "text/html", String::new(), html.into_bytes())
        }
        "/slow" => {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            ("200 OK", "text/html", String::new(), b"<title>slow</title>".to_vec())
        }
        _ => ("404 Not Found", "text/plain", String::new(), b"nope".to_vec()),
    };
    let header = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len());
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let options = self.admin_options.clone();
        let name = self.db_name.clone();
        let data_dir = self.data_dir.clone();
        // A separate thread + runtime: Drop cannot await, and the test runtime may already be shutting down.
        let _ = std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
            runtime.block_on(async move {
                if let Ok(mut admin) = PgConnection::connect_with(&options).await {
                    let _ = admin.execute(format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)").as_str()).await;
                }
            });
            let _ = std::fs::remove_dir_all(data_dir);
        })
        .join();
    }
}

/// The signature, IHDR (1x1) and IEND of a PNG: enough for `sniff_image`.
pub const TINY_PNG: [u8; 33] =
    [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89];
