//! Vokko chat server: REST under `/api/v1` and a WebSocket gateway on `/gateway`, backed by PostgreSQL.
pub mod access;
pub mod auth;
pub mod config;
pub mod error;
pub mod events;
pub mod extract;
pub mod gateway;
pub mod hub;
pub mod ids;
pub mod media;
pub mod net;
pub mod presence;
pub mod ratelimit;
pub mod routes;
pub mod seed;
pub mod state;
pub mod store;
pub mod threads;
pub mod unfurl;

use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::{Json, Router};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{AllowOrigin, CorsLayer};

pub use config::Config;
pub use state::AppState;

pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new().max_connections(10).connect(database_url).await
}

/// Applies the embedded migrations.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}

/// The desktop client's own origins are always allowed; then either the configured allow-list or, when none is set, localhost on any port.
fn origin_allowed(origin: &HeaderValue, allow_list: Option<&[String]>) -> bool {
    let Ok(origin) = origin.to_str() else { return false };
    if origin == "tauri://localhost" || origin == "http://tauri.localhost" || origin == "https://tauri.localhost" {
        return true;
    }
    if let Some(allow_list) = allow_list {
        return allow_list.iter().any(|allowed| allowed == origin);
    }
    ["http://localhost", "http://127.0.0.1"].iter().any(|prefix| {
        origin.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || (rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit())))
    })
}

/// `GET /healthz`: liveness plus a database round trip, no auth. 503 when the database does not answer within 2 seconds.
async fn healthz(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    let database = tokio::time::timeout(Duration::from_secs(2), sqlx::query("SELECT 1").execute(&state.db)).await;
    let database_ok = matches!(database, Ok(Ok(_)));
    let status = if database_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    let body = serde_json::json!({
        "status": if database_ok { "ok" } else { "unavailable" },
        "version": env!("CARGO_PKG_VERSION"),
        "db": if database_ok { "ok" } else { "error" },
    });
    (status, Json(body))
}

pub fn router(state: AppState) -> Router {
    let allow_list = state.config.cors_origins.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| origin_allowed(origin, allow_list.as_deref())))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .expose_headers([header::CONTENT_DISPOSITION, header::RETRY_AFTER]);
    Router::new()
        .nest("/api/v1", routes::api(state.config.max_upload_bytes).layer(axum::middleware::from_fn_with_state(state.clone(), ratelimit::middleware)))
        .route("/healthz", axum::routing::get(healthz))
        .route("/gateway", axum::routing::get(gateway::upgrade))
        .fallback(|| async { error::ApiErr::not_found() })
        .layer(cors)
        .with_state(state)
}
