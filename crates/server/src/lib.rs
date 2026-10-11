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
pub mod routes;
pub mod state;
pub mod store;

use axum::Router;
use axum::http::{HeaderValue, Method, header};
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

fn origin_allowed(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else { return false };
    if origin == "tauri://localhost" || origin == "http://tauri.localhost" || origin == "https://tauri.localhost" {
        return true;
    }
    ["http://localhost", "http://127.0.0.1"].iter().any(|prefix| {
        origin.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || (rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit())))
    })
}

pub fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| origin_allowed(origin)))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .expose_headers([header::CONTENT_DISPOSITION]);
    Router::new()
        .nest("/api/v1", routes::api())
        .route("/gateway", axum::routing::get(gateway::upgrade))
        .fallback(|| async { error::ApiErr::not_found() })
        .layer(cors)
        .with_state(state)
}
