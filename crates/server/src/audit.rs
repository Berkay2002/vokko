//! Guild audit log: recording entries (with the `X-Audit-Log-Reason` header), `GET /guilds/{id}/audit-logs` and the
//! GUILD_AUDIT_LOG_ENTRY_CREATE fan-out to members with VIEW_AUDIT_LOG.
use std::collections::HashSet;

use axum::Json;
use axum::Router;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::routing::get;
use serde::Serialize;
use serde_json::Value;
use vokko_protocol::api::permissions::VIEW_AUDIT_LOG;
use vokko_protocol::api::{AuditEntryInfo, AuditLog, AuditLogChange, AuditLogEntry, AuditLogEvent, AuditLogQuery, Channel, GatewayEvent, Snowflake};

use crate::access::{self, guild_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiQuery, parse_id};
use crate::state::AppState;
use crate::store;

pub const REASON_HEADER: &str = "x-audit-log-reason";
const MAX_REASON_CHARS: usize = 512;

pub fn routes() -> Router<AppState> {
    Router::new().route("/guilds/{id}/audit-logs", get(list))
}

/// The percent-decoded, trimmed `X-Audit-Log-Reason` header (at most 512 characters), `None` when absent or blank.
pub struct AuditReason(pub Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for AuditReason {
    type Rejection = ApiErr;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let raw = parts.headers.get(REASON_HEADER).map(|value| value.as_bytes().to_vec());
        Ok(Self(raw.and_then(|bytes| clean_reason(&percent_decode(&bytes)))))
    }
}

fn percent_decode(bytes: &[u8]) -> String {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            out.push(high * 16 + low);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Trimmed and cut to 512 characters; blank → `None`.
pub fn clean_reason(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(MAX_REASON_CHARS).collect())
}

/// An entry about to be recorded.
pub struct Entry {
    pub guild_id: i64,
    pub user_id: Option<i64>,
    pub target_id: Option<String>,
    pub action: AuditLogEvent,
    pub changes: Vec<AuditLogChange>,
    pub options: Option<AuditEntryInfo>,
    pub reason: Option<String>,
}

impl Entry {
    pub fn new(guild_id: i64, user_id: i64, action: AuditLogEvent, target_id: impl ToString) -> Self {
        Self { guild_id, user_id: Some(user_id), target_id: Some(target_id.to_string()), action, changes: Vec::new(), options: None, reason: None }
    }

    pub fn reason(mut self, reason: Option<String>) -> Self {
        self.reason = reason;
        self
    }

    pub fn options(mut self, options: AuditEntryInfo) -> Self {
        self.options = Some(options);
        self
    }

    /// Adds a change when the two values differ (`null` counts as "not set").
    pub fn change(mut self, key: &str, old: impl Serialize, new: impl Serialize) -> Self {
        if let Some(change) = change(key, old, new) {
            self.changes.push(change);
        }
        self
    }

    pub fn push(mut self, change: AuditLogChange) -> Self {
        self.changes.push(change);
        self
    }
}

/// Audit changes between two channel states (name, type, topic, position, parent).
pub fn channel_changes(entry: Entry, old: Option<&Channel>, new: Option<&Channel>) -> Entry {
    entry
        .change("name", old.map(|c| &c.name), new.map(|c| &c.name))
        .change("type", old.map(|c| c.kind), new.map(|c| c.kind))
        .change("topic", old.map(|c| &c.topic), new.map(|c| &c.topic))
        .change("nsfw", old.map(|c| c.nsfw).unwrap_or(false), new.map(|c| c.nsfw).unwrap_or(false))
        .change("rate_limit_per_user", old.and_then(|c| c.rate_limit_per_user), new.and_then(|c| c.rate_limit_per_user))
        .change("position", old.map(|c| c.position), new.map(|c| c.position))
        .change("parent_id", old.map(|c| c.parent_id), new.map(|c| c.parent_id))
}

/// A change record when `old != new`; `null` sides are left out.
pub fn change(key: &str, old: impl Serialize, new: impl Serialize) -> Option<AuditLogChange> {
    let old = serde_json::to_value(old).unwrap_or(Value::Null);
    let new = serde_json::to_value(new).unwrap_or(Value::Null);
    (old != new).then(|| AuditLogChange { key: key.to_owned(), old_value: (!old.is_null()).then_some(old), new_value: (!new.is_null()).then_some(new) })
}

/// Stores the entry and sends GUILD_AUDIT_LOG_ENTRY_CREATE to members with VIEW_AUDIT_LOG.
pub async fn record(state: &AppState, entry: Entry) -> ApiResult<AuditLogEntry> {
    let api = insert(state, &state.db, entry).await?;
    announce(state, &api).await?;
    Ok(api)
}

/// Stores the entry with `db` (a transaction, to commit it with the change it records); `announce` it after the commit.
pub async fn insert(state: &AppState, db: impl sqlx::PgExecutor<'_>, entry: Entry) -> ApiResult<AuditLogEntry> {
    let id = state.ids.next();
    let changes = (!entry.changes.is_empty()).then_some(entry.changes);
    let changes_json = changes.as_ref().map(serde_json::to_string).transpose().map_err(|_| ApiErr::internal())?;
    let options_json = entry.options.as_ref().map(serde_json::to_string).transpose().map_err(|_| ApiErr::internal())?;
    sqlx::query(
        "INSERT INTO audit_log_entries (id, guild_id, user_id, target_id, action_type, changes, options, reason) \
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)",
    )
    .bind(id)
    .bind(entry.guild_id)
    .bind(entry.user_id)
    .bind(&entry.target_id)
    .bind(entry.action.as_u8() as i16)
    .bind(changes_json)
    .bind(options_json)
    .bind(&entry.reason)
    .execute(db)
    .await?;
    Ok(AuditLogEntry {
        id: Snowflake::from(id),
        guild_id: Snowflake::from(entry.guild_id),
        user_id: entry.user_id.map(Snowflake::from),
        target_id: entry.target_id,
        action_type: entry.action,
        changes,
        options: entry.options,
        reason: entry.reason,
    })
}

/// Sends GUILD_AUDIT_LOG_ENTRY_CREATE to members with VIEW_AUDIT_LOG.
pub async fn announce(state: &AppState, api: &AuditLogEntry) -> ApiResult<()> {
    let audience = access::members_with_permission(state, api.guild_id.db(), VIEW_AUDIT_LOG).await?;
    state.hub.send(&audience, &GatewayEvent::GuildAuditLogEntryCreate(api.clone()));
    Ok(())
}

/// Action types whose `target_id` is a user.
fn targets_user(action: AuditLogEvent) -> bool {
    use AuditLogEvent::*;
    matches!(
        action,
        MemberKick
            | MemberBanAdd
            | MemberBanRemove
            | MemberUpdate
            | MemberRoleUpdate
            | BotAdd
            | AutoModerationBlockMessage
            | MessageDelete
            | MessagePin
            | MessageUnpin
    )
}

type EntryRow = (i64, Option<i64>, Option<String>, i16, Option<String>, Option<String>, Option<String>);

async fn list(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<AuditLogQuery>,
) -> ApiResult<Json<AuditLog>> {
    let guild = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(&state, user_id, guild).await?.require(VIEW_AUDIT_LOG)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    if let Some(action) = query.action_type
        && AuditLogEvent::from_u8(action).is_none()
    {
        return Err(ApiErr::invalid("action_type", "Unknown audit log action type."));
    }
    let rows: Vec<EntryRow> = sqlx::query_as(
        "SELECT id, user_id, target_id, action_type, changes::text, options::text, reason FROM audit_log_entries \
         WHERE guild_id = $1 AND ($2::bigint IS NULL OR user_id = $2) AND ($3::smallint IS NULL OR action_type = $3) \
         AND ($4::bigint IS NULL OR id < $4) AND ($5::bigint IS NULL OR id > $5) ORDER BY id DESC LIMIT $6",
    )
    .bind(guild)
    .bind(query.user_id.map(Snowflake::db))
    .bind(query.action_type.map(i16::from))
    .bind(query.before.map(Snowflake::db))
    .bind(query.after.map(Snowflake::db))
    .bind(i64::from(limit))
    .fetch_all(&state.db)
    .await?;
    let mut entries = Vec::with_capacity(rows.len());
    let mut user_ids: HashSet<i64> = HashSet::new();
    for (id, actor, target_id, action, changes, options, reason) in rows {
        let Some(action) = AuditLogEvent::from_u8(action as u8) else { continue };
        user_ids.extend(actor);
        if targets_user(action) {
            user_ids.extend(target_id.as_deref().and_then(parse_id));
        }
        entries.push(AuditLogEntry {
            id: Snowflake::from(id),
            guild_id: Snowflake::from(guild),
            user_id: actor.map(Snowflake::from),
            target_id,
            action_type: action,
            changes: changes.and_then(|text| serde_json::from_str(&text).ok()),
            options: options.and_then(|text| serde_json::from_str(&text).ok()),
            reason,
        });
    }
    let ids: Vec<i64> = user_ids.into_iter().collect();
    let mut users: Vec<_> = store::users(&state, &ids).await?.into_values().collect();
    users.sort_by_key(|user| user.id);
    Ok(Json(AuditLog { audit_log_entries: entries, users }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_are_decoded_trimmed_and_capped() {
        assert_eq!(percent_decode(b"spam%20bot%21"), "spam bot!");
        assert_eq!(percent_decode(b"100%"), "100%");
        assert_eq!(percent_decode(b"%zz"), "%zz");
        assert_eq!(percent_decode("caf%C3%A9".as_bytes()), "café");
        assert_eq!(clean_reason("  "), None);
        assert_eq!(clean_reason(&"x".repeat(600)).map(|reason| reason.chars().count()), Some(512));
    }

    #[test]
    fn changes_only_when_different() {
        assert!(change("name", "a", "a").is_none());
        let renamed = change("name", "a", "b").expect("changed");
        assert_eq!((renamed.old_value, renamed.new_value), (Some(Value::from("a")), Some(Value::from("b"))));
        let cleared = change("nick", Some("x"), None::<String>).expect("cleared");
        assert!(cleared.new_value.is_none());
    }
}
