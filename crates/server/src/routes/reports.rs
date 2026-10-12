//! Reports of messages and members for a guild's moderators (MOD-009). DM message reports are kept with no guild for the
//! instance operator; nobody sees them in the app.
use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{get, patch, post};
use serde::Deserialize;
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{ADMINISTRATOR, MANAGE_MESSAGES, MODERATE_MEMBERS, READ_MESSAGE_HISTORY, VIEW_CHANNEL};
use vokko_protocol::api::{AuditLogEvent, CreateReportRequest, Report, ReportReason, ReportStatus, ReportTargetType, Snowflake, UpdateReportRequest};

use crate::access::{channel_access, guild_access, guild_channels_with_permissions};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::state::AppState;
use crate::store;
use crate::threads;

const MAX_DETAILS_CHARS: usize = 1000;
/// Per reporter: 5 reports, then one a minute. Repeating an open report does not count.
const REPORT_BURST: f64 = 5.0;
const REPORT_PER_SECOND: f64 = 1.0 / 60.0;
const MAX_OPEN_PER_GUILD: i64 = 50;
const MAX_OPEN_DM: i64 = 20;
/// What a moderator needs in a channel to read a report's snapshot of a message there.
const READ: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
/// Message kinds a person wrote (default, reply, slash and context-menu command responses); system messages are not reportable.
const REPORTABLE_KINDS: [i16; 4] = [0, 19, 20, 23];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/messages/{mid}/report", post(report_message))
        .route("/guilds/{id}/members/{uid}/report", post(report_member))
        .route("/guilds/{id}/reports", get(list))
        .route("/guilds/{id}/reports/{report_id}", patch(update))
}

const COLS: &str = "id, guild_id, target_type, reporter_id, target_user_id, channel_id, message_id, message_content, reason, details, status, \
                    created_at, closed_by, closed_at";

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    guild_id: Option<i64>,
    target_type: String,
    reporter_id: i64,
    target_user_id: i64,
    channel_id: Option<i64>,
    message_id: Option<i64>,
    message_content: Option<String>,
    reason: String,
    details: Option<String>,
    status: String,
    created_at: OffsetDateTime,
    closed_by: Option<i64>,
    closed_at: Option<OffsetDateTime>,
}

fn reason_str(reason: ReportReason) -> &'static str {
    match reason {
        ReportReason::Spam => "spam",
        ReportReason::Harassment => "harassment",
        ReportReason::Hate => "hate",
        ReportReason::Sexual => "sexual",
        ReportReason::Violence => "violence",
        ReportReason::SelfHarm => "self_harm",
        ReportReason::Impersonation => "impersonation",
        ReportReason::Other => "other",
    }
}

fn parse_reason(raw: &str) -> ReportReason {
    match raw {
        "spam" => ReportReason::Spam,
        "harassment" => ReportReason::Harassment,
        "hate" => ReportReason::Hate,
        "sexual" => ReportReason::Sexual,
        "violence" => ReportReason::Violence,
        "self_harm" => ReportReason::SelfHarm,
        "impersonation" => ReportReason::Impersonation,
        _ => ReportReason::Other,
    }
}

fn status_str(status: ReportStatus) -> &'static str {
    match status {
        ReportStatus::Open => "open",
        ReportStatus::Resolved => "resolved",
        ReportStatus::Dismissed => "dismissed",
    }
}

fn parse_status(raw: &str) -> ReportStatus {
    match raw {
        "resolved" => ReportStatus::Resolved,
        "dismissed" => ReportStatus::Dismissed,
        _ => ReportStatus::Open,
    }
}

/// Rows to `Report`s; a row whose reporter or target account no longer exists is left out.
async fn hydrate(state: &AppState, rows: Vec<Row>) -> ApiResult<Vec<Report>> {
    let mut ids: Vec<i64> = rows.iter().flat_map(|row| [row.reporter_id, row.target_user_id]).collect();
    ids.sort_unstable();
    ids.dedup();
    let users = store::users(state, &ids).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(Report {
                id: Snowflake::from(row.id),
                guild_id: row.guild_id.map(Snowflake::from),
                target_type: if row.target_type == "message" { ReportTargetType::Message } else { ReportTargetType::User },
                reporter: users.get(&row.reporter_id)?.clone(),
                target_user: users.get(&row.target_user_id)?.clone(),
                channel_id: row.channel_id.map(Snowflake::from),
                message_id: row.message_id.map(Snowflake::from),
                message_content: row.message_content,
                reason: parse_reason(&row.reason),
                details: row.details,
                status: parse_status(&row.status),
                created_at: store::iso(row.created_at),
                closed_by: row.closed_by.map(Snowflake::from),
                closed_at: row.closed_at.map(store::iso),
            })
        })
        .collect())
}

async fn one(state: &AppState, id: i64) -> ApiResult<Report> {
    let row: Row = sqlx::query_as(&format!("SELECT {COLS} FROM reports WHERE id = $1")).bind(id).fetch_one(&state.db).await?;
    hydrate(state, vec![row]).await?.pop().ok_or_else(ApiErr::internal)
}

/// Trimmed, at most `MAX_DETAILS_CHARS`; blank is `None`.
fn clean_details(details: Option<String>) -> ApiResult<Option<String>> {
    let Some(details) = details.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty()) else { return Ok(None) };
    if details.chars().count() > MAX_DETAILS_CHARS {
        return Err(ApiErr::invalid("details", "Must be 1000 or fewer in length."));
    }
    Ok(Some(details))
}

fn rate_limit(state: &AppState, user_id: i64) -> ApiResult<()> {
    state.limiter.check_key("report", user_id, REPORT_BURST, REPORT_PER_SECOND).map_err(ApiErr::rate_limited)
}

/// The new report, or (when the same reporter already has an open one for this target, also after a concurrent insert) that one.
/// If that open report is closed between the conflict and the lookup, the insert is tried once more.
async fn insert(state: &AppState, report: NewReport<'_>, existing: &str) -> ApiResult<Report> {
    for _ in 0..2 {
        let inserted: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO reports (id, guild_id, target_type, reporter_id, target_user_id, channel_id, message_id, message_content, reason, details) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING id",
        )
        .bind(state.ids.next())
        .bind(report.guild_id)
        .bind(report.target_type)
        .bind(report.reporter_id)
        .bind(report.target_user_id)
        .bind(report.channel_id)
        .bind(report.message_id)
        .bind(report.message_content)
        .bind(reason_str(report.reason))
        .bind(report.details.as_deref())
        .fetch_optional(&state.db)
        .await?;
        if let Some((id,)) = inserted {
            return one(state, id).await;
        }
        if let Some(open) = find_open(state, existing, &report).await? {
            return Ok(open);
        }
    }
    Err(ApiErr::internal())
}

/// At most `MAX_OPEN_PER_GUILD` open reports per reporter in a guild, `MAX_OPEN_DM` for DM messages (nobody closes those in the app).
async fn check_open_cap(state: &AppState, reporter: i64, guild: Option<i64>) -> ApiResult<()> {
    let (open,): (i64,) = sqlx::query_as("SELECT count(*) FROM reports WHERE reporter_id = $1 AND guild_id IS NOT DISTINCT FROM $2 AND status = 'open'")
        .bind(reporter)
        .bind(guild)
        .fetch_one(&state.db)
        .await?;
    let cap = if guild.is_some() { MAX_OPEN_PER_GUILD } else { MAX_OPEN_DM };
    if open >= cap {
        return Err(ApiErr::conflict(30093, &format!("Maximum number of open reports reached ({cap})")));
    }
    Ok(())
}

struct NewReport<'a> {
    guild_id: Option<i64>,
    target_type: &'static str,
    reporter_id: i64,
    target_user_id: i64,
    channel_id: Option<i64>,
    message_id: Option<i64>,
    message_content: Option<&'a str>,
    reason: ReportReason,
    details: Option<String>,
}

const OPEN_MESSAGE_REPORT: &str = "reporter_id = $1 AND message_id = $2 AND target_type = 'message' AND status = 'open'";
const OPEN_MEMBER_REPORT: &str = "reporter_id = $1 AND guild_id = $2 AND target_user_id = $3 AND target_type = 'user' AND status = 'open'";

async fn find_open(state: &AppState, filter: &str, report: &NewReport<'_>) -> ApiResult<Option<Report>> {
    let query = format!("SELECT {COLS} FROM reports WHERE {filter}");
    let row: Option<Row> = if report.target_type == "message" {
        sqlx::query_as(&query).bind(report.reporter_id).bind(report.message_id).fetch_optional(&state.db).await?
    } else {
        sqlx::query_as(&query).bind(report.reporter_id).bind(report.guild_id).bind(report.target_user_id).fetch_optional(&state.db).await?
    };
    match row {
        Some(row) => Ok(hydrate(state, vec![row]).await?.pop()),
        None => Ok(None),
    }
}

async fn report_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((channel, message)): Path<(String, String)>,
    ApiJson(body): ApiJson<CreateReportRequest>,
) -> ApiResult<Json<Report>> {
    let details = clean_details(body.details)?;
    let channel = parse_id(&channel).ok_or_else(ApiErr::unknown_channel)?;
    let message = parse_id(&message).ok_or_else(ApiErr::unknown_message)?;
    let access = channel_access(&state, user_id, channel).await?;
    access.require(READ_MESSAGE_HISTORY)?;
    let row: Option<(i64, i16, String)> = sqlx::query_as("SELECT author_id, kind, content FROM messages WHERE id = $1 AND channel_id = $2")
        .bind(message)
        .bind(channel)
        .fetch_optional(&state.db)
        .await?;
    let (author_id, kind, content) = row.ok_or_else(ApiErr::unknown_message)?;
    if !REPORTABLE_KINDS.contains(&kind) {
        return Err(ApiErr::invalid("message_id", "System messages cannot be reported."));
    }
    if author_id == user_id {
        return Err(ApiErr::invalid("message_id", "You cannot report your own message."));
    }
    let report = NewReport {
        guild_id: access.channel.guild_id,
        target_type: "message",
        reporter_id: user_id,
        target_user_id: author_id,
        channel_id: Some(channel),
        message_id: Some(message),
        message_content: Some(&content),
        reason: body.reason,
        details,
    };
    if let Some(existing) = find_open(&state, OPEN_MESSAGE_REPORT, &report).await? {
        return Ok(Json(existing));
    }
    check_open_cap(&state, user_id, report.guild_id).await?;
    rate_limit(&state, user_id)?;
    Ok(Json(insert(&state, report, OPEN_MESSAGE_REPORT).await?))
}

async fn report_member(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((guild, target)): Path<(String, String)>,
    ApiJson(body): ApiJson<CreateReportRequest>,
) -> ApiResult<Json<Report>> {
    let details = clean_details(body.details)?;
    let guild = parse_id(&guild).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(&state, user_id, guild).await?;
    let target = parse_id(&target).ok_or_else(ApiErr::unknown_member)?;
    if target == user_id {
        return Err(ApiErr::invalid("user_id", "You cannot report yourself."));
    }
    let member: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(target).fetch_optional(&state.db).await?;
    member.ok_or_else(ApiErr::unknown_member)?;
    let report = NewReport {
        guild_id: Some(guild),
        target_type: "user",
        reporter_id: user_id,
        target_user_id: target,
        channel_id: None,
        message_id: None,
        message_content: None,
        reason: body.reason,
        details,
    };
    if let Some(existing) = find_open(&state, OPEN_MEMBER_REPORT, &report).await? {
        return Ok(Json(existing));
    }
    check_open_cap(&state, user_id, report.guild_id).await?;
    rate_limit(&state, user_id)?;
    Ok(Json(insert(&state, report, OPEN_MEMBER_REPORT).await?))
}

struct Moderator {
    guild: i64,
    admin: bool,
}

/// A moderator: MANAGE_MESSAGES or MODERATE_MEMBERS (ADMINISTRATOR and the owner have both). Bots are not: reports name the
/// reporter, which stays between people.
async fn require_moderator(state: &AppState, user_id: i64, guild: &str) -> ApiResult<Moderator> {
    let guild = parse_id(guild).ok_or_else(ApiErr::unknown_guild)?;
    let access = guild_access(state, user_id, guild).await?;
    if access.permissions & (MANAGE_MESSAGES | MODERATE_MEMBERS) == 0 {
        return Err(ApiErr::missing_permissions());
    }
    let (bot,): (bool,) = sqlx::query_as("SELECT bot FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if bot {
        return Err(ApiErr::missing_permissions());
    }
    Ok(Moderator { guild, admin: access.permissions & ADMINISTRATOR != 0 })
}

/// The reported channels of the guild whose reports the moderator may not see, since the snapshot would show them the
/// message: channels they cannot read (VIEW_CHANNEL and READ_MESSAGE_HISTORY), and for everyone but administrators deleted
/// ones (which may have been private). Computed once per request.
async fn hidden_channels(state: &AppState, user_id: i64, moderator: &Moderator) -> ApiResult<Vec<i64>> {
    let reported: Vec<(i64,)> = sqlx::query_as("SELECT DISTINCT channel_id FROM reports WHERE guild_id = $1 AND channel_id IS NOT NULL")
        .bind(moderator.guild)
        .fetch_all(&state.db)
        .await?;
    if reported.is_empty() {
        return Ok(Vec::new());
    }
    let reported: Vec<i64> = reported.into_iter().map(|(id,)| id).collect();
    let kinds: HashMap<i64, i16> =
        sqlx::query_as("SELECT id, kind FROM channels WHERE id = ANY($1)").bind(&reported).fetch_all(&state.db).await?.into_iter().collect();
    let readable: HashMap<i64, u64> =
        guild_channels_with_permissions(state, user_id, moderator.guild).await?.into_iter().map(|(channel, permissions)| (channel.id, permissions)).collect();
    let mut hidden = Vec::new();
    for channel in reported {
        let visible = match kinds.get(&channel) {
            None => moderator.admin,
            Some(&kind) if threads::is_thread_kind(kind) => channel_access(state, user_id, channel).await.is_ok_and(|access| access.permissions & READ == READ),
            Some(_) => readable.get(&channel).is_some_and(|permissions| permissions & READ == READ),
        };
        if !visible {
            hidden.push(channel);
        }
    }
    Ok(hidden)
}

/// What a moderator may see: not reports about themselves, and not message reports of `hidden` channels.
const VISIBLE: &str = "target_user_id <> $2 AND (channel_id IS NULL OR NOT (channel_id = ANY($3)))";

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
    before: Option<Snowflake>,
    limit: Option<i64>,
}

async fn list(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(guild): Path<String>,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> ApiResult<Json<Vec<Report>>> {
    let moderator = require_moderator(&state, user_id, &guild).await?;
    let status = match query.status.as_deref() {
        None | Some("open") => Some("open"),
        Some("resolved") => Some("resolved"),
        Some("dismissed") => Some("dismissed"),
        Some("all") => None,
        Some(_) => return Err(ApiErr::invalid("status", "Must be open, resolved, dismissed or all.")),
    };
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let hidden = hidden_channels(&state, user_id, &moderator).await?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM reports WHERE guild_id = $1 AND {VISIBLE} AND ($4::text IS NULL OR status = $4) AND id < $5 ORDER BY id DESC LIMIT $6"
    ))
    .bind(moderator.guild)
    .bind(user_id)
    .bind(&hidden)
    .bind(status)
    .bind(query.before.map_or(i64::MAX, Snowflake::db))
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(hydrate(&state, rows).await?))
}

async fn update(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((guild, report)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<UpdateReportRequest>,
) -> ApiResult<Json<Report>> {
    let moderator = require_moderator(&state, user_id, &guild).await?;
    let report = parse_id(&report).ok_or_else(ApiErr::not_found)?;
    let hidden = hidden_channels(&state, user_id, &moderator).await?;
    let found: Option<(i64,)> = sqlx::query_as(&format!("SELECT id FROM reports WHERE guild_id = $1 AND {VISIBLE} AND id = $4"))
        .bind(moderator.guild)
        .bind(user_id)
        .bind(&hidden)
        .bind(report)
        .fetch_optional(&state.db)
        .await?;
    found.ok_or_else(ApiErr::not_found)?;
    let closing = body.status != ReportStatus::Open;
    // Reopening fails (400) when the reporter has opened a newer report of the same target meanwhile. The row lock makes
    // the returned old status the one this update replaced, also when two moderators act at once.
    let updated: Result<Option<(String,)>, _> = sqlx::query_as(
        "UPDATE reports r SET status = $2, closed_by = CASE WHEN $3 THEN $4 END, closed_at = CASE WHEN $3 THEN now() END \
         FROM (SELECT id, status FROM reports WHERE id = $1 FOR UPDATE) old WHERE r.id = old.id RETURNING old.status",
    )
    .bind(report)
    .bind(status_str(body.status))
    .bind(closing)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await;
    let old = match updated {
        Ok(Some((old,))) => old,
        Ok(None) => return Err(ApiErr::not_found()),
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
            return Err(ApiErr::invalid("status", "The reporter already has an open report of this target."));
        }
        Err(error) => return Err(error.into()),
    };
    let new = status_str(body.status);
    if old != new {
        // Only the report id and status: the reporter, target and reason stay with the moderators.
        audit::record(&state, Entry::new(moderator.guild, user_id, AuditLogEvent::ReportUpdate, report).change("status", &old, new).reason(reason)).await?;
    }
    Ok(Json(one(&state, report).await?))
}
