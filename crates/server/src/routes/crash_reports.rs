//! Automatic crash and error reports: the client sends uncaught JS errors, unhandled rejections and (on the next start) desktop
//! panics, unless the user turned it off in Settings > Data & Privacy. Rows carry no user id, message text or other personal data
//! and are deleted after 30 days (swept with the problem reports). Read with psql: docs/self-hosting.md "Crash reports".
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use vokko_protocol::api::{CrashKind, CreateCrashReportRequest};

use crate::auth::{AuthUser, bearer_header};
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::routes::bug_reports::bounded;
use crate::state::AppState;

/// The whole JSON body; a bigger one is 413 40005.
pub const MAX_BODY_BYTES: usize = 32 * 1024;
const MAX_VERSION_CHARS: usize = 64;
const MAX_OS_CHARS: usize = 256;
const MAX_ROUTE_CHARS: usize = 256;
const MAX_MESSAGE_CHARS: usize = 1000;
const MAX_STACK_CHARS: usize = 16_000;
/// Per user: 10 reports, then one a minute (a crash loop must not fill the table).
const BURST: f64 = 10.0;
const PER_SECOND: f64 = 1.0 / 60.0;

pub fn routes() -> Router<AppState> {
    Router::new().route("/crash-reports", post(create).layer(DefaultBodyLimit::max(MAX_BODY_BYTES)))
}

fn kind_name(kind: CrashKind) -> &'static str {
    match kind {
        CrashKind::Error => "error",
        CrashKind::UnhandledRejection => "unhandled_rejection",
        CrashKind::Panic => "panic",
    }
}

/// Replaces every run of 5+ digits (snowflakes) with `:id`, so a stored route never names a channel, guild or user.
pub fn strip_ids(route: &str) -> String {
    let mut out = String::with_capacity(route.len());
    let mut digits = String::new();
    for c in route.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        out.push_str(if digits.len() >= 5 { ":id" } else { &digits });
        digits.clear();
        out.push(c);
    }
    out.push_str(if digits.len() >= 5 { ":id" } else { &digits });
    out
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<CreateCrashReportRequest>,
) -> ApiResult<StatusCode> {
    let message = body.message.trim();
    if message.is_empty() {
        return Err(ApiErr::invalid("message", "Must not be empty."));
    }
    bounded("message", message, MAX_MESSAGE_CHARS)?;
    bounded("app_version", &body.app_version, MAX_VERSION_CHARS)?;
    bounded("os", &body.os, MAX_OS_CHARS)?;
    bounded("route", &body.route, MAX_ROUTE_CHARS)?;
    bounded("stack", &body.stack, MAX_STACK_CHARS)?;
    // keyed on the user only to limit them; the row itself does not name anyone
    state.limiter.check_key("crash_report", user_id, BURST, PER_SECOND).map_err(ApiErr::rate_limited)?;
    let token = bearer_header(&headers).map(|raw| raw.strip_prefix("Bot ").unwrap_or(raw)).filter(|token| token.len() >= 8);
    let clean = |text: &str| {
        let text = text.replace('\0', "");
        match token {
            Some(token) => text.replace(token, "[redacted]"),
            None => text,
        }
    };
    sqlx::query("INSERT INTO crash_reports (id, kind, app_version, os, route, message, stack) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(state.ids.next())
        .bind(kind_name(body.kind))
        .bind(clean(&body.app_version))
        .bind(clean(&body.os))
        .bind(strip_ids(&clean(&body.route)))
        .bind(clean(message))
        .bind(clean(&body.stack))
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::strip_ids;

    #[test]
    fn ids_leave_the_route() {
        assert_eq!(strip_ids("/channels/123456789012345678/876543210987654321"), "/channels/:id/:id");
        assert_eq!(strip_ids("/channels/@me/1234"), "/channels/@me/1234");
        assert_eq!(strip_ids("/x/12345?a=1"), "/x/:id?a=1");
    }
}
