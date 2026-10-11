//! Safety setup: the verification level gate on sending and AutoMod keyword rules (CRUD routes and enforcement).
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use time::{Duration, OffsetDateTime};
use vokko_protocol::api::permissions::{ADMINISTRATOR, MANAGE_GUILD};
use vokko_protocol::api::{
    AuditEntryInfo, AuditLogEvent, AutoModerationAction, AutoModerationActionMetadata, AutoModerationActionType, AutoModerationEventType, AutoModerationRule,
    AutoModerationRuleRequest, AutoModerationTriggerMetadata, AutoModerationTriggerType, GatewayEvent, Snowflake, VerificationLevel,
};

use crate::access::{ChannelAccess, guild_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;

const MAX_KEYWORD_RULES: i64 = 6;
const MAX_KEYWORDS: usize = 1000;
const MAX_KEYWORD_CHARS: usize = 60;
const MAX_ALLOW_LIST: usize = 100;
const MAX_EXEMPT_ROLES: usize = 20;
const MAX_EXEMPT_CHANNELS: usize = 50;
const MAX_CUSTOM_MESSAGE_CHARS: usize = 150;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/auto-moderation/rules", get(list_rules).post(create_rule))
        .route("/guilds/{id}/auto-moderation/rules/{rule_id}", get(get_rule).patch(update_rule).delete(delete_rule))
}

// ---- enforcement ----

/// Verification level and AutoMod for a new message by `user_id` in a guild channel. DMs pass.
pub async fn check_send(state: &AppState, access: &ChannelAccess, user_id: i64, content: &str) -> ApiResult<()> {
    let Some(guild_id) = access.channel.guild_id else { return Ok(()) };
    check_verification(state, guild_id, user_id).await?;
    check_automod(state, access, user_id, content).await
}

/// 403 50009 when the guild's verification level is above what the member meets. Roles, administrators and the owner bypass it.
async fn check_verification(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    let row: Option<(i16, i64, OffsetDateTime, OffsetDateTime, bool)> = sqlx::query_as(
        "SELECT g.verification_level, g.owner_id, u.created_at, m.joined_at, \
         EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id) \
         FROM guilds g JOIN guild_members m ON m.guild_id = g.id JOIN users u ON u.id = m.user_id WHERE g.id = $1 AND m.user_id = $2",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((level, owner_id, created_at, joined_at, has_roles)) = row else { return Ok(()) };
    let level = VerificationLevel::from_u8(level as u8).unwrap_or_default();
    if owner_id == user_id || has_roles || meets_level(level, created_at, joined_at, OffsetDateTime::now_utc()) {
        return Ok(());
    }
    if guild_access(state, user_id, guild_id).await?.permissions & ADMINISTRATOR != 0 {
        return Ok(());
    }
    Err(ApiErr::verification_level())
}

pub fn meets_level(level: VerificationLevel, created_at: OffsetDateTime, joined_at: OffsetDateTime, now: OffsetDateTime) -> bool {
    let account_ok = now - created_at >= Duration::minutes(5);
    let member_ok = now - joined_at >= Duration::minutes(10);
    match level {
        VerificationLevel::None | VerificationLevel::Low => true,
        VerificationLevel::Medium => account_ok,
        VerificationLevel::High | VerificationLevel::VeryHigh => account_ok && member_ok,
    }
}

/// Blocks `content` (400 200000) when an enabled keyword rule matches and the author is not exempt; records audit entry 143.
pub async fn check_automod(state: &AppState, access: &ChannelAccess, user_id: i64, content: &str) -> ApiResult<()> {
    let Some(guild_id) = access.channel.guild_id else { return Ok(()) };
    if content.trim().is_empty() {
        return Ok(());
    }
    let rules = load_rules(state, guild_id).await?;
    let rules: Vec<RuleRow> = rules.into_iter().filter(|rule| rule.enabled).collect();
    if rules.is_empty() {
        return Ok(());
    }
    let guild = guild_access(state, user_id, guild_id).await?;
    if guild.owner_id == user_id || guild.permissions & (MANAGE_GUILD | ADMINISTRATOR) != 0 {
        return Ok(());
    }
    // A thread is exempt when its parent is.
    let channels = [Some(access.channel.id), access.channel.is_thread().then_some(access.channel.parent_id).flatten()];
    for rule in rules {
        if rule.exempt_roles.iter().any(|role| guild.roles.contains(role)) || channels.iter().flatten().any(|id| rule.exempt_channels.contains(id)) {
            continue;
        }
        if find_keyword(content, &rule.keyword_filter, &rule.allow_list).is_none() {
            continue;
        }
        let options = AuditEntryInfo {
            channel_id: Some(Snowflake::from(access.channel.id)),
            auto_moderation_rule_name: Some(rule.name.clone()),
            auto_moderation_rule_trigger_type: Some(AutoModerationTriggerType::Keyword.as_u8().to_string()),
            ..Default::default()
        };
        audit::record(state, Entry::new(guild_id, user_id, AuditLogEvent::AutoModerationBlockMessage, user_id).options(options)).await?;
        return Err(ApiErr::automod_blocked(rule.custom_message.as_deref()));
    }
    Ok(())
}

/// The first keyword of `keywords` that matches `content` (case-insensitive, whole words unless `*` wildcards say otherwise),
/// skipping matches whose word is on `allow_list`.
pub fn find_keyword<'a>(content: &str, keywords: &'a [String], allow_list: &[String]) -> Option<&'a str> {
    let text: Vec<char> = content.to_lowercase().chars().collect();
    keywords.iter().find(|keyword| matches_in(&text, keyword, allow_list)).map(String::as_str)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// (core, may extend left, may extend right).
fn pattern(keyword: &str) -> (Vec<char>, bool, bool) {
    let lower = keyword.trim().to_lowercase();
    let left = lower.starts_with('*');
    let right = lower.len() > 1 && lower.ends_with('*');
    (lower.trim_matches('*').chars().collect(), left, right)
}

fn matches_in(text: &[char], keyword: &str, allow_list: &[String]) -> bool {
    let (core, left, right) = pattern(keyword);
    if core.is_empty() || core.len() > text.len() {
        return false;
    }
    (0..=text.len() - core.len()).any(|start| {
        let end = start + core.len();
        if text[start..end] != core[..] {
            return false;
        }
        let bounded_left = start == 0 || !is_word(text[start - 1]) || !is_word(core[0]);
        let bounded_right = end == text.len() || !is_word(text[end]) || !core.last().copied().is_some_and(is_word);
        if !(left || bounded_left) || !(right || bounded_right) {
            return false;
        }
        // The whole word(s) around the hit: when the allow list matches it, this hit does not count.
        let mut word_start = start;
        while word_start > 0 && is_word(text[word_start - 1]) {
            word_start -= 1;
        }
        let mut word_end = end;
        while word_end < text.len() && is_word(text[word_end]) {
            word_end += 1;
        }
        let word = &text[word_start..word_end];
        !allow_list.iter().any(|allowed| whole_match(word, allowed))
    })
}

/// Whether `word` as a whole fits the keyword syntax of `allowed`.
fn whole_match(word: &[char], allowed: &str) -> bool {
    let (core, left, right) = pattern(allowed);
    if core.is_empty() || core.len() > word.len() {
        return false;
    }
    match (left, right) {
        (false, false) => word == &core[..],
        (false, true) => word.starts_with(&core),
        (true, false) => word.ends_with(&core),
        (true, true) => word.windows(core.len()).any(|window| window == &core[..]),
    }
}

// ---- rules ----

#[derive(sqlx::FromRow, Clone)]
struct RuleRow {
    id: i64,
    guild_id: i64,
    name: String,
    creator_id: i64,
    keyword_filter: Vec<String>,
    allow_list: Vec<String>,
    custom_message: Option<String>,
    enabled: bool,
    exempt_roles: Vec<i64>,
    exempt_channels: Vec<i64>,
}

const RULE_COLS: &str = "id, guild_id, name, creator_id, keyword_filter, allow_list, custom_message, enabled, exempt_roles, exempt_channels";

impl RuleRow {
    fn api(&self) -> AutoModerationRule {
        AutoModerationRule {
            id: Snowflake::from(self.id),
            guild_id: Snowflake::from(self.guild_id),
            name: self.name.clone(),
            creator_id: Snowflake::from(self.creator_id),
            event_type: AutoModerationEventType::MessageSend,
            trigger_type: AutoModerationTriggerType::Keyword,
            trigger_metadata: AutoModerationTriggerMetadata { keyword_filter: self.keyword_filter.clone(), allow_list: self.allow_list.clone() },
            actions: vec![AutoModerationAction {
                kind: AutoModerationActionType::BlockMessage,
                metadata: self.custom_message.clone().map(|message| AutoModerationActionMetadata { custom_message: Some(message) }),
            }],
            enabled: self.enabled,
            exempt_roles: self.exempt_roles.iter().copied().map(Snowflake::from).collect(),
            exempt_channels: self.exempt_channels.iter().copied().map(Snowflake::from).collect(),
        }
    }
}

async fn load_rules(state: &AppState, guild_id: i64) -> ApiResult<Vec<RuleRow>> {
    Ok(sqlx::query_as(&format!("SELECT {RULE_COLS} FROM automod_rules WHERE guild_id = $1 ORDER BY id")).bind(guild_id).fetch_all(&state.db).await?)
}

async fn load_rule(state: &AppState, guild_id: i64, raw: &str) -> ApiResult<RuleRow> {
    let id = parse_id(raw).ok_or_else(ApiErr::unknown_automod_rule)?;
    let row: Option<RuleRow> = sqlx::query_as(&format!("SELECT {RULE_COLS} FROM automod_rules WHERE guild_id = $1 AND id = $2"))
        .bind(guild_id)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    row.ok_or_else(ApiErr::unknown_automod_rule)
}

fn guild_of(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

async fn require_manager(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<()> {
    guild_access(state, user_id, guild_id).await?.require(MANAGE_GUILD)
}

fn clean_list(values: Vec<String>, max: usize, field: &str) -> ApiResult<Vec<String>> {
    if values.len() > max {
        return Err(ApiErr::invalid(field, &format!("Must have at most {max} entries.")));
    }
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim().to_owned();
        let count = value.chars().count();
        if count == 0 || count > MAX_KEYWORD_CHARS || value.trim_matches('*').is_empty() {
            return Err(ApiErr::invalid(field, "Each entry must be 1-60 characters."));
        }
        if !out.contains(&value) {
            out.push(value);
        }
    }
    Ok(out)
}

/// Rule fields after validation; `None` = keep the stored value (PATCH).
struct Fields {
    name: Option<String>,
    keywords: Option<Vec<String>>,
    allow_list: Option<Vec<String>>,
    custom_message: Option<Option<String>>,
    enabled: Option<bool>,
    exempt_roles: Option<Vec<i64>>,
    exempt_channels: Option<Vec<i64>>,
}

async fn validate(state: &AppState, guild_id: i64, body: AutoModerationRuleRequest) -> ApiResult<Fields> {
    let name = match body.name {
        Some(name) => {
            let name = name.trim().to_owned();
            if !(1..=100).contains(&name.chars().count()) {
                return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
            }
            Some(name)
        }
        None => None,
    };
    let (keywords, allow_list) = match body.trigger_metadata {
        Some(meta) => (
            Some(clean_list(meta.keyword_filter, MAX_KEYWORDS, "trigger_metadata.keyword_filter")?),
            Some(clean_list(meta.allow_list, MAX_ALLOW_LIST, "trigger_metadata.allow_list")?),
        ),
        None => (None, None),
    };
    let custom_message = match body.actions {
        Some(actions) => {
            let [action] = actions.as_slice() else { return Err(ApiErr::invalid("actions", "Exactly one BLOCK_MESSAGE action is supported.")) };
            let message = action.metadata.as_ref().and_then(|meta| meta.custom_message.as_deref()).map(str::trim).filter(|text| !text.is_empty());
            if message.is_some_and(|text| text.chars().count() > MAX_CUSTOM_MESSAGE_CHARS) {
                return Err(ApiErr::invalid("actions", "The custom message must be 150 or fewer in length."));
            }
            Some(message.map(str::to_owned))
        }
        None => None,
    };
    let exempt_roles = match body.exempt_roles {
        Some(roles) => {
            let ids: Vec<i64> = roles.into_iter().map(Snowflake::db).collect();
            if ids.len() > MAX_EXEMPT_ROLES {
                return Err(ApiErr::invalid("exempt_roles", "Must have at most 20 entries."));
            }
            let (found,): (i64,) =
                sqlx::query_as("SELECT count(*) FROM roles WHERE guild_id = $1 AND id = ANY($2)").bind(guild_id).bind(&ids).fetch_one(&state.db).await?;
            if found as usize != dedup(&ids).len() {
                return Err(ApiErr::invalid("exempt_roles", "Unknown role."));
            }
            Some(dedup(&ids))
        }
        None => None,
    };
    let exempt_channels = match body.exempt_channels {
        Some(channels) => {
            let ids: Vec<i64> = channels.into_iter().map(Snowflake::db).collect();
            if ids.len() > MAX_EXEMPT_CHANNELS {
                return Err(ApiErr::invalid("exempt_channels", "Must have at most 50 entries."));
            }
            let (found,): (i64,) =
                sqlx::query_as("SELECT count(*) FROM channels WHERE guild_id = $1 AND id = ANY($2)").bind(guild_id).bind(&ids).fetch_one(&state.db).await?;
            if found as usize != dedup(&ids).len() {
                return Err(ApiErr::invalid("exempt_channels", "Unknown channel."));
            }
            Some(dedup(&ids))
        }
        None => None,
    };
    Ok(Fields { name, keywords, allow_list, custom_message, enabled: body.enabled, exempt_roles, exempt_channels })
}

fn dedup(ids: &[i64]) -> Vec<i64> {
    let mut out = ids.to_vec();
    out.sort_unstable();
    out.dedup();
    out
}

/// AUTO_MODERATION_RULE_* to members with MANAGE_GUILD.
async fn publish(state: &AppState, guild_id: i64, event: GatewayEvent) -> ApiResult<()> {
    let audience = crate::access::members_with_permission(state, guild_id, MANAGE_GUILD).await?;
    state.hub.send(&audience, &event);
    Ok(())
}

fn rule_changes(entry: Entry, old: Option<&AutoModerationRule>, new: Option<&AutoModerationRule>) -> Entry {
    entry
        .change("name", old.map(|r| &r.name), new.map(|r| &r.name))
        .change("enabled", old.map(|r| r.enabled), new.map(|r| r.enabled))
        .change("trigger_metadata", old.map(|r| &r.trigger_metadata), new.map(|r| &r.trigger_metadata))
        .change("actions", old.map(|r| &r.actions), new.map(|r| &r.actions))
        .change("exempt_roles", old.map(|r| &r.exempt_roles), new.map(|r| &r.exempt_roles))
        .change("exempt_channels", old.map(|r| &r.exempt_channels), new.map(|r| &r.exempt_channels))
}

async fn list_rules(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<AutoModerationRule>>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    Ok(Json(load_rules(&state, guild).await?.iter().map(RuleRow::api).collect()))
}

async fn get_rule(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, rule)): Path<(String, String)>) -> ApiResult<Json<AutoModerationRule>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    Ok(Json(load_rule(&state, guild, &rule).await?.api()))
}

async fn create_rule(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<AutoModerationRuleRequest>,
) -> ApiResult<Json<AutoModerationRule>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    if body.event_type.is_none() {
        return Err(ApiErr::invalid("event_type", "Required."));
    }
    if body.trigger_type.is_none() {
        return Err(ApiErr::invalid("trigger_type", "Required."));
    }
    if body.actions.is_none() {
        return Err(ApiErr::invalid("actions", "Required."));
    }
    let fields = validate(&state, guild, body).await?;
    let name = fields.name.ok_or_else(|| ApiErr::invalid("name", "Required."))?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM automod_rules WHERE guild_id = $1").bind(guild).fetch_one(&state.db).await?;
    if count >= MAX_KEYWORD_RULES {
        return Err(ApiErr::conflict(30035, "Maximum number of keyword rules reached (6)"));
    }
    let row: RuleRow = sqlx::query_as(&format!(
        "INSERT INTO automod_rules (id, guild_id, name, creator_id, keyword_filter, allow_list, custom_message, enabled, exempt_roles, exempt_channels) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING {RULE_COLS}"
    ))
    .bind(state.ids.next())
    .bind(guild)
    .bind(&name)
    .bind(user_id)
    .bind(fields.keywords.unwrap_or_default())
    .bind(fields.allow_list.unwrap_or_default())
    .bind(fields.custom_message.flatten())
    .bind(fields.enabled.unwrap_or(true))
    .bind(fields.exempt_roles.unwrap_or_default())
    .bind(fields.exempt_channels.unwrap_or_default())
    .fetch_one(&state.db)
    .await?;
    let rule = row.api();
    publish(&state, guild, GatewayEvent::AutoModerationRuleCreate(rule.clone())).await?;
    audit::record(&state, rule_changes(Entry::new(guild, user_id, AuditLogEvent::AutoModerationRuleCreate, row.id).reason(reason), None, Some(&rule))).await?;
    Ok(Json(rule))
}

async fn update_rule(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, rule_id)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<AutoModerationRuleRequest>,
) -> ApiResult<Json<AutoModerationRule>> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    let current = load_rule(&state, guild, &rule_id).await?;
    if body.trigger_type.is_some_and(|kind| kind != AutoModerationTriggerType::Keyword) {
        return Err(ApiErr::invalid("trigger_type", "The trigger type cannot change."));
    }
    let fields = validate(&state, guild, body).await?;
    let row: RuleRow = sqlx::query_as(&format!(
        "UPDATE automod_rules SET name = $2, keyword_filter = $3, allow_list = $4, custom_message = $5, enabled = $6, exempt_roles = $7, \
         exempt_channels = $8 WHERE id = $1 RETURNING {RULE_COLS}"
    ))
    .bind(current.id)
    .bind(fields.name.unwrap_or_else(|| current.name.clone()))
    .bind(fields.keywords.unwrap_or_else(|| current.keyword_filter.clone()))
    .bind(fields.allow_list.unwrap_or_else(|| current.allow_list.clone()))
    .bind(fields.custom_message.unwrap_or_else(|| current.custom_message.clone()))
    .bind(fields.enabled.unwrap_or(current.enabled))
    .bind(fields.exempt_roles.unwrap_or_else(|| current.exempt_roles.clone()))
    .bind(fields.exempt_channels.unwrap_or_else(|| current.exempt_channels.clone()))
    .fetch_one(&state.db)
    .await?;
    let (old, rule) = (current.api(), row.api());
    publish(&state, guild, GatewayEvent::AutoModerationRuleUpdate(rule.clone())).await?;
    let entry = rule_changes(Entry::new(guild, user_id, AuditLogEvent::AutoModerationRuleUpdate, row.id).reason(reason), Some(&old), Some(&rule));
    if !entry.changes.is_empty() {
        audit::record(&state, entry).await?;
    }
    Ok(Json(rule))
}

async fn delete_rule(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, rule_id)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let guild = guild_of(&id)?;
    require_manager(&state, user_id, guild).await?;
    let current = load_rule(&state, guild, &rule_id).await?;
    sqlx::query("DELETE FROM automod_rules WHERE id = $1").bind(current.id).execute(&state.db).await?;
    let rule = current.api();
    publish(&state, guild, GatewayEvent::AutoModerationRuleDelete(rule.clone())).await?;
    audit::record(&state, rule_changes(Entry::new(guild, user_id, AuditLogEvent::AutoModerationRuleDelete, current.id).reason(reason), Some(&rule), None))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn keywords_match_whole_words_and_wildcards() {
        let hit = |content: &str, keyword: &str| find_keyword(content, &words(&[keyword]), &[]).is_some();
        assert!(hit("I like Cats.", "cats"));
        assert!(!hit("concatenate", "cat"), "whole words only");
        assert!(hit("concatenate", "*cat*"));
        assert!(hit("catalogue", "cat*"));
        assert!(!hit("bobcat", "cat*"));
        assert!(hit("bobcat!", "*cat"));
        assert!(hit("well, free money here", "free money"));
        assert!(!hit("freemoney", "free money"));
        assert!(hit("ÅSKA och regn", "åska"));
        assert!(!hit("", "x"));
    }

    #[test]
    fn allow_list_saves_a_word() {
        let keywords = words(&["bad*"]);
        assert_eq!(find_keyword("a badge", &keywords, &words(&["badge"])), None);
        assert_eq!(find_keyword("a badge and a baddie", &keywords, &words(&["badge"])), Some("bad*"));
        assert_eq!(find_keyword("badminton", &keywords, &words(&["*minton"])), None);
    }

    #[test]
    fn verification_levels() {
        let now = OffsetDateTime::now_utc();
        let fresh = now - Duration::minutes(1);
        let old = now - Duration::hours(1);
        assert!(meets_level(VerificationLevel::Low, fresh, fresh, now));
        assert!(!meets_level(VerificationLevel::Medium, fresh, old, now));
        assert!(meets_level(VerificationLevel::Medium, old, fresh, now));
        assert!(!meets_level(VerificationLevel::High, old, fresh, now));
        assert!(meets_level(VerificationLevel::VeryHigh, old, old, now));
    }
}
