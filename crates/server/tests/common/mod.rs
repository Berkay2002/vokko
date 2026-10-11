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
        let admin_options = PgConnectOptions::from_str(&test_database_url()).expect("valid TEST_DATABASE_URL");
        let db_name = format!("vokko_test_{}_{}", unix_seconds(), vokko_server::auth::random_hex(4));
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
        adjust(&mut config);
        let state = AppState::new(pool, config);
        let router = vokko_server::router(state.clone());
        Self { state, router, admin_options, db_name, data_dir }
    }

    pub async fn send(&self, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(format!("/api/v1{path}"));
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

    pub async fn delete(&self, path: &str, token: &str) -> (StatusCode, Value) {
        self.send(Method::DELETE, path, Some(token), None).await
    }

    /// Registers a user; returns (token, user json).
    pub async fn register(&self, username: &str) -> (String, Value) {
        let body = json!({"email": format!("{username}@example.test"), "username": username, "password": "correct horse battery"});
        let (status, value) = self.send(Method::POST, "/auth/register", None, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "register {username}: {value}");
        (value["token"].as_str().expect("token").to_owned(), value["user"].clone())
    }

    /// Serves the router on an ephemeral loopback port (never an 87xx port) for WebSocket tests.
    pub async fn serve(&self) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral port");
        let address = listener.local_addr().expect("address");
        let router = self.router.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
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
