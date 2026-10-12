//! Apply to Join: the member verification form and the join requests (Server Settings > Access). While a guild's `join_mode` is
//! Apply, approval is the only way in (invites are refused in `invites::accept`).
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, put};
use serde::Deserialize;
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{KICK_MEMBERS, MANAGE_GUILD};
use vokko_protocol::api::{
    ActionJoinRequest, AuditLogEvent, GatewayEvent, GuildJoinRequest, GuildJoinRequestDelete, GuildJoinRequestEvent, GuildJoinRequestList, JoinMode,
    JoinRequestStatus, MemberVerificationField, MemberVerificationFieldType as FieldType, MemberVerificationForm, MemberVerificationResponse as Response,
    Snowflake, SubmitJoinRequest,
};

use crate::access::{self, guild_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::{AuthUser, HumanUser};
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::routes::auth::clean_text;
use crate::routes::invites::{self, Via};
use crate::state::AppState;
use crate::store;

const MAX_DESCRIPTION: usize = 300;
const MAX_LABEL: usize = 300;
const MAX_PLACEHOLDER: usize = 100;
const MAX_TERMS: usize = 16;
const MAX_RULE: usize = 300;
const MAX_CHOICES: usize = 8;
const MAX_CHOICE: usize = 150;
const MAX_OTHER_FIELDS: usize = 5;
const MAX_TEXT_ANSWER: usize = 150;
const MAX_PARAGRAPH_ANSWER: usize = 1000;
const MAX_REJECTION_REASON: usize = 160;
/// Applications per user: 10, then one every 10 seconds (checked once the answers are valid).
const APPLY_BURST: f64 = 10.0;
const APPLY_PER_SECOND: f64 = 0.1;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/member-verification", get(get_form).put(put_form))
        .route("/guilds/{id}/requests/@me", put(submit).get(mine).delete(withdraw))
        .route("/guilds/{id}/requests", get(list))
        .route("/guilds/{id}/requests/{request_id}", patch(action))
}

// ---- form ----

async fn load_form(state: &AppState, guild: i64) -> ApiResult<Option<MemberVerificationForm>> {
    let row: Option<(Option<String>, String)> = sqlx::query_as("SELECT description, form_fields::text FROM guild_member_verification WHERE guild_id = $1")
        .bind(guild)
        .fetch_optional(&state.db)
        .await?;
    let Some((description, fields)) = row else { return Ok(None) };
    let form_fields = serde_json::from_str(&fields).map_err(|_| ApiErr::internal())?;
    Ok(Some(MemberVerificationForm { description, form_fields }))
}

/// A live invite of `guild`; anything else is `unknown` (404), so a non-member learns nothing about the guild.
async fn invite_of_guild(state: &AppState, code: &str, guild: i64, unknown: fn() -> ApiErr) -> ApiResult<()> {
    match invites::live_row(state, code).await {
        Ok(row) if row.guild_id == guild => Ok(()),
        Ok(_) => Err(unknown()),
        Err(error) if error.status == StatusCode::NOT_FOUND => Err(unknown()),
        Err(error) => Err(error),
    }
}

#[derive(Deserialize)]
struct FormQuery {
    invite_code: Option<String>,
}

async fn get_form(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(guild): Path<String>,
    ApiQuery(query): ApiQuery<FormQuery>,
) -> ApiResult<Json<MemberVerificationForm>> {
    let guild = parse_id(&guild).ok_or_else(ApiErr::unknown_guild)?;
    let member: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user_id).fetch_optional(&state.db).await?;
    if member.is_none() {
        let code = query.invite_code.ok_or_else(ApiErr::unknown_guild)?;
        invite_of_guild(&state, &code, guild, ApiErr::unknown_guild).await?;
    }
    Ok(Json(load_form(&state, guild).await?.unwrap_or_default()))
}

/// Trimmed; blank is `None`; longer than `max` characters or holding control characters (other than line breaks and tabs; Postgres
/// refuses NUL) is a 400 on `field`.
fn clean(value: Option<String>, max: usize, field: &str) -> ApiResult<Option<String>> {
    let text = clean_text(value, max, field)?;
    if text.as_deref().is_some_and(|text| text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))) {
        return Err(ApiErr::invalid(field, "Must not contain control characters."));
    }
    Ok(text)
}

fn clean_all(values: Vec<String>, min: usize, max: usize, max_len: usize, field: &str) -> ApiResult<Vec<String>> {
    if !(min..=max).contains(&values.len()) {
        return Err(ApiErr::invalid(field, &format!("Must have between {min} and {max} entries.")));
    }
    values.into_iter().map(|value| clean(Some(value), max_len, field)?.ok_or_else(|| ApiErr::invalid(field, "Entries cannot be blank."))).collect()
}

/// The form as it is stored: trimmed, limits checked, responses dropped.
fn validate_form(form: MemberVerificationForm) -> ApiResult<MemberVerificationForm> {
    let description = clean(form.description, MAX_DESCRIPTION, "description")?;
    let terms = form.form_fields.iter().filter(|field| field.field_type == FieldType::Terms).count();
    if terms > 1 || form.form_fields.len() - terms > MAX_OTHER_FIELDS {
        return Err(ApiErr::invalid("form_fields", "At most one TERMS field and 5 other fields."));
    }
    let mut form_fields = Vec::with_capacity(form.form_fields.len());
    for (index, field) in form.form_fields.into_iter().enumerate() {
        let at = |name: &str| format!("form_fields.{index}.{name}");
        let label = clean(Some(field.label), MAX_LABEL, &at("label"))?.ok_or_else(|| ApiErr::invalid(&at("label"), "Must be 1 or more in length."))?;
        let values = match field.field_type {
            FieldType::Terms => Some(clean_all(field.values.unwrap_or_default(), 1, MAX_TERMS, MAX_RULE, &at("values"))?),
            FieldType::MultipleChoice => Some(clean_all(field.values.unwrap_or_default(), 1, MAX_CHOICES, MAX_CHOICE, &at("values"))?),
            FieldType::TextInput | FieldType::Paragraph => {
                if field.values.is_some_and(|values| !values.is_empty()) {
                    return Err(ApiErr::invalid(&at("values"), "Text fields have no values."));
                }
                None
            }
        };
        form_fields.push(MemberVerificationField {
            field_type: field.field_type,
            label,
            required: field.required,
            values,
            description: clean(field.description, MAX_DESCRIPTION, &at("description"))?,
            placeholder: clean(field.placeholder, MAX_PLACEHOLDER, &at("placeholder"))?,
            response: None,
        });
    }
    Ok(MemberVerificationForm { description, form_fields })
}

async fn put_form(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(guild): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<MemberVerificationForm>,
) -> ApiResult<Json<MemberVerificationForm>> {
    let guild = parse_id(&guild).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(&state, user_id, guild).await?.require(MANAGE_GUILD)?;
    let form = validate_form(body)?;
    let before = load_form(&state, guild).await?;
    let fields = serde_json::to_string(&form.form_fields).map_err(|_| ApiErr::internal())?;
    sqlx::query(
        "INSERT INTO guild_member_verification (guild_id, description, form_fields) VALUES ($1, $2, $3::jsonb) \
         ON CONFLICT (guild_id) DO UPDATE SET description = EXCLUDED.description, form_fields = EXCLUDED.form_fields",
    )
    .bind(guild)
    .bind(&form.description)
    .bind(fields)
    .execute(&state.db)
    .await?;
    let entry = Entry::new(guild, user_id, AuditLogEvent::GuildUpdate, guild).reason(reason).change("member_verification", before.as_ref(), &form);
    if !entry.changes.is_empty() {
        audit::record(&state, entry).await?;
    }
    Ok(Json(form))
}

// ---- requests ----

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    guild_id: i64,
    user_id: i64,
    status: String,
    form_responses: String,
    rejection_reason: Option<String>,
    created_at: OffsetDateTime,
    actioned_at: Option<OffsetDateTime>,
    actioned_by: Option<i64>,
}

const COLS: &str = "id, guild_id, user_id, status, form_responses::text AS form_responses, rejection_reason, created_at, actioned_at, actioned_by";

fn status_str(status: JoinRequestStatus) -> &'static str {
    match status {
        JoinRequestStatus::Submitted => "SUBMITTED",
        JoinRequestStatus::Approved => "APPROVED",
        JoinRequestStatus::Rejected => "REJECTED",
    }
}

fn parse_status(raw: &str) -> JoinRequestStatus {
    match raw {
        "APPROVED" => JoinRequestStatus::Approved,
        "REJECTED" => JoinRequestStatus::Rejected,
        _ => JoinRequestStatus::Submitted,
    }
}

async fn hydrate(state: &AppState, rows: Vec<Row>) -> ApiResult<Vec<GuildJoinRequest>> {
    let mut ids: Vec<i64> = rows.iter().flat_map(|row| [Some(row.user_id), row.actioned_by]).flatten().collect();
    ids.sort_unstable();
    ids.dedup();
    let users = store::users(state, &ids).await?;
    rows.into_iter()
        .filter_map(|row| {
            let user = users.get(&row.user_id)?.clone();
            Some(serde_json::from_str(&row.form_responses).map_err(|_| ApiErr::internal()).map(|form_responses| GuildJoinRequest {
                id: Snowflake::from(row.id),
                guild_id: Snowflake::from(row.guild_id),
                user_id: Snowflake::from(row.user_id),
                user,
                created_at: store::iso(row.created_at),
                application_status: parse_status(&row.status),
                form_responses,
                rejection_reason: row.rejection_reason,
                actioned_at: row.actioned_at.map(store::iso),
                actioned_by_user: row.actioned_by.and_then(|by| users.get(&by).cloned()),
            }))
        })
        .collect()
}

async fn one(state: &AppState, row: Row) -> ApiResult<GuildJoinRequest> {
    hydrate(state, vec![row]).await?.pop().ok_or_else(ApiErr::internal)
}

/// What the applicant sees: not which moderator handled the request.
fn for_applicant(mut request: GuildJoinRequest) -> GuildJoinRequest {
    request.actioned_by_user = None;
    request
}

/// Sends the request event: the full request to the members who handle requests, the applicant's view to the applicant.
async fn announce(state: &AppState, guild: i64, request: &GuildJoinRequest, wrap: fn(Box<GuildJoinRequestEvent>) -> GatewayEvent) -> ApiResult<()> {
    let applicant = request.user_id.db();
    let event =
        |request: GuildJoinRequest| wrap(Box::new(GuildJoinRequestEvent { guild_id: Snowflake::from(guild), status: request.application_status, request }));
    let handlers: Vec<i64> = audience(state, guild, applicant).await?.into_iter().filter(|id| *id != applicant).collect();
    state.hub.send(&handlers, &event(request.clone()));
    state.hub.send(&[applicant], &event(for_applicant(request.clone())));
    Ok(())
}

/// The applicant and the members who handle requests (KICK_MEMBERS or MANAGE_GUILD).
async fn audience(state: &AppState, guild: i64, applicant: i64) -> ApiResult<Vec<i64>> {
    let mut ids = access::members_with_permission(state, guild, KICK_MEMBERS | MANAGE_GUILD).await?;
    if !ids.contains(&applicant) {
        ids.push(applicant);
    }
    Ok(ids)
}

async fn announce_delete(state: &AppState, guild: i64, id: i64, applicant: i64) -> ApiResult<()> {
    let event = GuildJoinRequestDelete { guild_id: Snowflake::from(guild), id: Snowflake::from(id), user_id: Snowflake::from(applicant) };
    state.hub.send(&audience(state, guild, applicant).await?, &GatewayEvent::GuildJoinRequestDelete(event));
    Ok(())
}

/// A ban removes the user's request; call inside the ban transaction, then `announce_ban_removal` after the commit.
pub async fn delete_for_ban(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, guild: i64, user: i64) -> ApiResult<Option<i64>> {
    let deleted: Option<(i64,)> = sqlx::query_as("DELETE FROM guild_join_requests WHERE guild_id = $1 AND user_id = $2 RETURNING id")
        .bind(guild)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(deleted.map(|(id,)| id))
}

pub async fn announce_ban_removal(state: &AppState, guild: i64, id: i64, user: i64) -> ApiResult<()> {
    announce_delete(state, guild, id, user).await
}

/// The submitted answers checked against the stored form (same count, order and types; required ones answered), as the form's
/// fields with `response` set.
fn check_answers(form: Vec<MemberVerificationField>, submitted: Vec<MemberVerificationField>) -> ApiResult<Vec<MemberVerificationField>> {
    if form.len() != submitted.len() {
        return Err(ApiErr::invalid("form_fields", "Must answer every field of the form, in order."));
    }
    let mut out = Vec::with_capacity(form.len());
    for (index, (mut field, answer)) in form.into_iter().zip(submitted).enumerate() {
        let name = format!("form_fields.{index}.response");
        if field.field_type != answer.field_type {
            return Err(ApiErr::invalid(&format!("form_fields.{index}.field_type"), "Does not match the form."));
        }
        let response = match (field.field_type, answer.response) {
            (_, None) => None,
            (FieldType::Terms, Some(Response::Bool(accepted))) => accepted.then_some(Response::Bool(true)),
            (FieldType::TextInput, Some(Response::Text(text))) => clean(Some(text), MAX_TEXT_ANSWER, &name)?.map(Response::Text),
            (FieldType::Paragraph, Some(Response::Text(text))) => clean(Some(text), MAX_PARAGRAPH_ANSWER, &name)?.map(Response::Text),
            (FieldType::MultipleChoice, Some(Response::Index(choice))) => {
                if choice as usize >= field.values.as_ref().map_or(0, Vec::len) {
                    return Err(ApiErr::invalid(&name, "Not one of the choices."));
                }
                Some(Response::Index(choice))
            }
            _ => return Err(ApiErr::invalid(&name, "Wrong type of response for this field.")),
        };
        if field.required && response.is_none() {
            return Err(ApiErr::invalid(&name, "This field is required."));
        }
        field.response = response;
        out.push(field);
    }
    Ok(out)
}

async fn submit(
    State(state): State<AppState>,
    HumanUser(user_id): HumanUser,
    Path(guild): Path<String>,
    ApiJson(body): ApiJson<SubmitJoinRequest>,
) -> ApiResult<Json<GuildJoinRequest>> {
    let guild = parse_id(&guild).ok_or_else(ApiErr::unknown_invite)?;
    invite_of_guild(&state, &body.invite_code, guild, ApiErr::unknown_invite).await?;
    let invite = invites::live_row(&state, &body.invite_code).await?;
    let form = load_form(&state, guild).await?.unwrap_or_default();
    let responses = check_answers(form.form_fields, body.form_fields)?;
    state.limiter.check_key("join_request", user_id, APPLY_BURST, APPLY_PER_SECOND).map_err(ApiErr::rate_limited)?;
    let responses_json = serde_json::to_string(&responses).map_err(|_| ApiErr::internal())?;
    let id = state.ids.next();
    let mut tx = state.db.begin().await?;
    // The shared guild lock orders this against a ban and a mode switch; the request row lock (taken before the checks, which then read
    // a fresh snapshot) orders it against an approval of the request being replaced.
    let locked: Option<(i16,)> = sqlx::query_as("SELECT join_mode FROM guilds WHERE id = $1 FOR SHARE").bind(guild).fetch_optional(&mut *tx).await?;
    let (join_mode,) = locked.ok_or_else(ApiErr::unknown_invite)?;
    let previous: Option<(i64,)> = sqlx::query_as("SELECT id FROM guild_join_requests WHERE guild_id = $1 AND user_id = $2 FOR UPDATE")
        .bind(guild)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let banned: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user_id).fetch_optional(&mut *tx).await?;
    if banned.is_some() {
        return Err(ApiErr::banned());
    }
    let member: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(user_id).fetch_optional(&mut *tx).await?;
    if member.is_some() {
        return Err(ApiErr::invalid("guild_id", "You are already a member of this server."));
    }
    if join_mode != i16::from(JoinMode::Apply.as_u8()) {
        return Err(ApiErr::invalid("join_mode", "This server does not take applications."));
    }
    // Reapplying replaces the earlier request (a rejected one, a withdrawn-and-forgotten one, an approved one whose user left).
    let row: Row = sqlx::query_as(&format!(
        "INSERT INTO guild_join_requests (id, guild_id, user_id, form_responses, invite_code, inviter_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6) \
         ON CONFLICT (guild_id, user_id) DO UPDATE SET id = EXCLUDED.id, status = 'SUBMITTED', form_responses = EXCLUDED.form_responses, \
         invite_code = EXCLUDED.invite_code, inviter_id = EXCLUDED.inviter_id, rejection_reason = NULL, created_at = now(), actioned_at = NULL, actioned_by = NULL \
         RETURNING {COLS}"
    ))
    .bind(id)
    .bind(guild)
    .bind(user_id)
    .bind(responses_json)
    .bind(&invite.code)
    .bind(invite.inviter_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Some((old,)) = previous {
        announce_delete(&state, guild, old, user_id).await?;
    }
    let request = one(&state, row).await?;
    announce(&state, guild, &request, GatewayEvent::GuildJoinRequestCreate).await?;
    Ok(Json(for_applicant(request)))
}

async fn mine(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(guild): Path<String>) -> ApiResult<Json<GuildJoinRequest>> {
    let guild = parse_id(&guild).ok_or_else(ApiErr::unknown_join_request)?;
    let row: Option<Row> = sqlx::query_as(&format!("SELECT {COLS} FROM guild_join_requests WHERE guild_id = $1 AND user_id = $2"))
        .bind(guild)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    let row = row.ok_or_else(ApiErr::unknown_join_request)?;
    Ok(Json(for_applicant(one(&state, row).await?)))
}

async fn withdraw(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(guild): Path<String>) -> ApiResult<StatusCode> {
    let guild = parse_id(&guild).ok_or_else(ApiErr::unknown_join_request)?;
    let deleted: Option<(i64,)> = sqlx::query_as("DELETE FROM guild_join_requests WHERE guild_id = $1 AND user_id = $2 AND status = 'SUBMITTED' RETURNING id")
        .bind(guild)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    let (id,) = deleted.ok_or_else(ApiErr::unknown_join_request)?;
    announce_delete(&state, guild, id, user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// KICK_MEMBERS or MANAGE_GUILD.
async fn require_handler(state: &AppState, user_id: i64, guild: &str) -> ApiResult<i64> {
    let guild = parse_id(guild).ok_or_else(ApiErr::unknown_guild)?;
    if guild_access(state, user_id, guild).await?.permissions & (KICK_MEMBERS | MANAGE_GUILD) == 0 {
        return Err(ApiErr::missing_permissions());
    }
    Ok(guild)
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<JoinRequestStatus>,
    before: Option<Snowflake>,
    limit: Option<i64>,
}

async fn list(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(guild): Path<String>,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> ApiResult<Json<GuildJoinRequestList>> {
    let guild = require_handler(&state, user_id, &guild).await?;
    let status = status_str(query.status.unwrap_or(JoinRequestStatus::Submitted));
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let rows: Vec<Row> =
        sqlx::query_as(&format!("SELECT {COLS} FROM guild_join_requests WHERE guild_id = $1 AND status = $2 AND id < $3 ORDER BY id DESC LIMIT $4"))
            .bind(guild)
            .bind(status)
            .bind(query.before.map_or(i64::MAX, Snowflake::db))
            .bind(limit)
            .fetch_all(&state.db)
            .await?;
    let (total,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM guild_join_requests WHERE guild_id = $1 AND status = $2").bind(guild).bind(status).fetch_one(&state.db).await?;
    Ok(Json(GuildJoinRequestList { guild_join_requests: hydrate(&state, rows).await?, total: u32::try_from(total).unwrap_or(u32::MAX) }))
}

async fn action(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((guild, request)): Path<(String, String)>,
    ApiJson(body): ApiJson<ActionJoinRequest>,
) -> ApiResult<Json<GuildJoinRequest>> {
    let guild = require_handler(&state, user_id, &guild).await?;
    let request = parse_id(&request).ok_or_else(ApiErr::unknown_join_request)?;
    let approve = match body.action {
        JoinRequestStatus::Approved => true,
        JoinRequestStatus::Rejected => false,
        JoinRequestStatus::Submitted => return Err(ApiErr::invalid("action", "Must be APPROVED or REJECTED.")),
    };
    let reason = clean(body.rejection_reason, MAX_REJECTION_REASON, "rejection_reason")?.filter(|_| !approve);
    let mut tx = state.db.begin().await?;
    // Same lock as an invite accept: a ban either lands before the re-check below or removes the member added here. The request
    // row lock keeps two handlers from both acting on it.
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR SHARE").bind(guild).execute(&mut *tx).await?;
    let found: Option<(i64, String, Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT user_id, status, invite_code, inviter_id FROM guild_join_requests WHERE id = $1 AND guild_id = $2 FOR UPDATE")
            .bind(request)
            .bind(guild)
            .fetch_optional(&mut *tx)
            .await?;
    let (applicant, status, code, inviter) = found.ok_or_else(ApiErr::unknown_join_request)?;
    if status != status_str(JoinRequestStatus::Submitted) {
        return Err(ApiErr::invalid("action", "This request was already handled."));
    }
    if approve {
        let banned: Option<(i64,)> =
            sqlx::query_as("SELECT user_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(applicant).fetch_optional(&mut *tx).await?;
        if banned.is_some() {
            return Err(ApiErr::banned());
        }
    }
    let row: Row = sqlx::query_as(&format!(
        "UPDATE guild_join_requests SET status = $2, rejection_reason = $3, actioned_at = now(), actioned_by = $4 WHERE id = $1 RETURNING {COLS}"
    ))
    .bind(request)
    .bind(status_str(body.action))
    .bind(&reason)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    // Joins like an invite accept, minus the invite use (the request never consumed one).
    let is_new = approve && invites::insert_member(&mut tx, guild, applicant, &Via { code: code.as_deref(), inviter_id: inviter, temporary: false }).await?;
    tx.commit().await?;
    let updated = one(&state, row).await?;
    announce(&state, guild, &updated, GatewayEvent::GuildJoinRequestUpdate).await?;
    if is_new {
        invites::announce_new_member(&state, guild, applicant).await?;
    }
    Ok(Json(updated))
}
