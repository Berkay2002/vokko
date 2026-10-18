//! "Report a problem": a signed-in user sends a short description, the app version, the OS and a scrubbed tail of the client
//! log. Rows are kept for the instance operator (no in-app reader; see docs/self-hosting.md) and deleted after 30 days.
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::HeaderMap;
use axum::routing::post;
use vokko_protocol::api::{BugReportCreated, CreateBugReportRequest, Snowflake};

use crate::auth::{AuthUser, bearer_header};
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::state::AppState;

/// The whole JSON body; a bigger one is 413 40005.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_VERSION_CHARS: usize = 64;
const MAX_OS_CHARS: usize = 256;
/// Per user: 3 reports, then one every 10 minutes.
const BURST: f64 = 3.0;
const PER_SECOND: f64 = 1.0 / 600.0;
const RETENTION_DAYS: i32 = 30;
/// Reports kept per user (at most about 5 MiB); a new one past that deletes the oldest.
pub const MAX_PER_USER: i64 = 20;
const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);

pub fn routes() -> Router<AppState> {
    Router::new().route("/bug-reports", post(create).layer(DefaultBodyLimit::max(MAX_BODY_BYTES)))
}

pub(crate) fn bounded(field: &str, value: &str, max: usize) -> ApiResult<()> {
    if value.chars().count() > max {
        return Err(ApiErr::invalid(field, &format!("Must be at most {max} characters.")));
    }
    Ok(())
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<CreateBugReportRequest>,
) -> ApiResult<Json<BugReportCreated>> {
    let description = body.description.trim();
    if description.is_empty() {
        return Err(ApiErr::invalid("description", "Describe the problem."));
    }
    bounded("description", description, MAX_DESCRIPTION_CHARS)?;
    bounded("app_version", &body.app_version, MAX_VERSION_CHARS)?;
    bounded("os", &body.os, MAX_OS_CHARS)?;
    state.limiter.check_key("bug_report", user_id, BURST, PER_SECOND).map_err(ApiErr::rate_limited)?;
    // The client scrubs its log; the caller's own token is the one secret the server can still recognise.
    let mut logs = body.logs.replace('\0', "");
    if let Some(token) = bearer_header(&headers).map(|raw| raw.strip_prefix("Bot ").unwrap_or(raw)).filter(|token| token.len() >= 8) {
        logs = logs.replace(token, "[redacted]");
    }
    let id = state.ids.next();
    sqlx::query("INSERT INTO bug_reports (id, user_id, description, app_version, os, logs) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(user_id)
        .bind(description.replace('\0', ""))
        .bind(body.app_version.replace('\0', ""))
        .bind(body.os.replace('\0', ""))
        .bind(logs)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM bug_reports WHERE user_id = $1 AND id < (SELECT id FROM bug_reports WHERE user_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)")
        .bind(user_id)
        .bind(MAX_PER_USER - 1)
        .execute(&state.db)
        .await?;
    Ok(Json(BugReportCreated { id: Snowflake::from(id) }))
}

/// Deletes reports older than the retention period; returns how many went.
pub async fn sweep(state: &AppState) -> Result<u64, sqlx::Error> {
    let done = sqlx::query("DELETE FROM bug_reports WHERE created_at < now() - make_interval(days => $1)").bind(RETENTION_DAYS).execute(&state.db).await?;
    Ok(done.rows_affected())
}

/// Deletes crash reports (routes/crash_reports.rs) older than the same retention period; returns how many went.
pub async fn sweep_crashes(state: &AppState) -> Result<u64, sqlx::Error> {
    let done = sqlx::query("DELETE FROM crash_reports WHERE created_at < now() - make_interval(days => $1)").bind(RETENTION_DAYS).execute(&state.db).await?;
    Ok(done.rows_affected())
}

pub fn spawn_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            match sweep(&state).await {
                Ok(0) => {}
                Ok(count) => tracing::info!("deleted {count} problem reports past retention"),
                Err(error) => tracing::warn!("problem report sweep failed: {error:?}"),
            }
            match sweep_crashes(&state).await {
                Ok(0) => {}
                Ok(count) => tracing::info!("deleted {count} crash reports past retention"),
                Err(error) => tracing::warn!("crash report sweep failed: {error:?}"),
            }
        }
    });
}
