//! Password & Security: TOTP two-factor with backup codes, the MFA login step, sessions (devices) and password reset.
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;
use axum::http::header::USER_AGENT;
use axum::http::{HeaderMap, StatusCode};
use rand::Rng;
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use vokko_protocol::account::{
    BackupCode, BackupCodesRequest, BackupCodesResponse, ClientInfo, CodeRequest, EnableTotpRequest, ForgotPasswordRequest, LoginResponse,
    LogoutSessionsRequest, MfaLoginRequest, MfaRequiredResponse, ResetPasswordRequest, UserSession, UserSessions,
};
use vokko_protocol::api::{ApiError, AuthResponse};

use super::me::{cancel_email_change, confirm_identity, revoke_sessions};
use super::tokens::{self, Purpose};
use super::{link, rules, totp};
use crate::auth::{AuthUser, bearer_header, hash_password, hash_token, new_token};
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::state::AppState;
use crate::store;

const TICKET_SECONDS: f64 = 300.0;
const TICKET_ATTEMPTS: i32 = 5;
const BACKUP_CODES: usize = 10;
const BACKUP_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
/// Wrong second-factor codes (or, counted apart, current passwords) per account before 429, and the window they count in.
const MAX_FAILURES: i64 = 10;
const FAILURE_WINDOW_SECONDS: f64 = 900.0;
const RESET_COOLDOWN_SECONDS: f64 = 60.0;

fn invalid_code() -> ApiErr {
    ApiErr::invalid("code", "Invalid two-factor code")
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0)
}

/// `(os, platform)` guessed from the User-Agent, e.g. `("Windows", "Chrome")` or `(.., "Vokko Desktop")`.
pub fn client_info(headers: &HeaderMap) -> ClientInfo {
    let ua = headers.get(USER_AGENT).and_then(|value| value.to_str().ok()).unwrap_or_default();
    let os =
        [("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iOS"), ("iPad", "iOS"), ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux")]
            .iter()
            .find(|(needle, _)| ua.contains(needle))
            .map(|(_, name)| (*name).to_owned());
    let platform = [("Tauri", "Vokko Desktop"), ("Firefox/", "Firefox"), ("Edg/", "Edge"), ("OPR/", "Opera"), ("Chrome/", "Chrome"), ("Safari/", "Safari")]
        .iter()
        .find(|(needle, _)| ua.contains(needle))
        .map(|(_, name)| (*name).to_owned());
    ClientInfo { os, platform }
}

/// A new session token for `user_id`, remembering the client it was issued to.
pub async fn issue_session(state: &AppState, user_id: i64, headers: &HeaderMap) -> ApiResult<String> {
    let token = new_token();
    let client = client_info(headers);
    sqlx::query("INSERT INTO sessions (token_hash, user_id, client_os, client_platform) VALUES ($1, $2, $3, $4)")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(client.os)
        .bind(client.platform)
        .execute(&state.db)
        .await?;
    Ok(token)
}

/// The end of every sign-in (password, reset, OAuth): a session, or an MFA ticket when two-factor is on.
/// A successful sign-in re-enables a disabled account (Discord does the same).
pub async fn finish_login(state: &AppState, user_id: i64, headers: &HeaderMap) -> ApiResult<LoginResponse> {
    let (mfa,): (bool,) = sqlx::query_as("SELECT mfa_secret IS NOT NULL FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if mfa {
        let ticket = new_token();
        sqlx::query("INSERT INTO mfa_tickets (ticket_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))")
            .bind(hash_token(&ticket))
            .bind(user_id)
            .bind(TICKET_SECONDS)
            .execute(&state.db)
            .await?;
        return Ok(LoginResponse::Mfa(MfaRequiredResponse { token: None, mfa: true, ticket, totp: true, backup: true }));
    }
    Ok(LoginResponse::Session(Box::new(session_response(state, user_id, headers).await?)))
}

async fn session_response(state: &AppState, user_id: i64, headers: &HeaderMap) -> ApiResult<AuthResponse> {
    sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = $1 AND disabled_at IS NOT NULL").bind(user_id).execute(&state.db).await?;
    let token = issue_session(state, user_id, headers).await?;
    let user = store::user(state, user_id).await?.ok_or_else(ApiErr::internal)?;
    Ok(AuthResponse { token, user })
}

fn backup_hash(user_id: i64, code: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(user_id.to_be_bytes());
    hasher.update(code.as_bytes());
    hasher.finalize().to_vec()
}

/// Checks a second factor: a TOTP code (never the same 30 s step twice) or an unused backup code (used up).
pub async fn check_code(state: &AppState, user_id: i64, code: &str) -> ApiResult<bool> {
    let attempt = begin_attempt(state, "mfa_failures", user_id, "Too many wrong codes. Try again in 15 minutes.").await?;
    let accepted = check_code_once(state, user_id, code).await?;
    end_attempt(state, "mfa_failures", attempt, accepted).await?;
    Ok(accepted)
}

/// Records an attempt in `table` (`mfa_failures` or `password_failures`) and refuses with 429 once the account has
/// MAX_FAILURES wrong ones in the window. Pass the returned id to `end_attempt`.
pub(super) async fn begin_attempt(state: &AppState, table: &str, user_id: i64, refused: &str) -> ApiResult<i64> {
    // record the attempt before counting: of any number of parallel requests at most MAX_FAILURES see a count in range
    let (attempt,): (i64,) = sqlx::query_as(&format!("INSERT INTO {table} (user_id) VALUES ($1) RETURNING id")).bind(user_id).fetch_one(&state.db).await?;
    let (attempts,): (i64,) = sqlx::query_as(&format!("SELECT count(*) FROM {table} WHERE user_id = $1 AND failed_at > now() - make_interval(secs => $2)"))
        .bind(user_id)
        .bind(FAILURE_WINDOW_SECONDS)
        .fetch_one(&state.db)
        .await?;
    if attempts > MAX_FAILURES {
        // a refused request is not an attempt: it must not keep extending the lockout
        sqlx::query(&format!("DELETE FROM {table} WHERE id = $1")).bind(attempt).execute(&state.db).await?;
        // the oldest counted failure leaving the window: exact at MAX_FAILURES + 1, a lower bound past that
        let (left,): (Option<f64>,) = sqlx::query_as(&format!(
            "SELECT EXTRACT(EPOCH FROM (min(failed_at) + make_interval(secs => $2) - now()))::float8 FROM {table} WHERE user_id = $1 AND failed_at > now() - make_interval(secs => $2)"
        ))
        .bind(user_id)
        .bind(FAILURE_WINDOW_SECONDS)
        .fetch_one(&state.db)
        .await?;
        let retry_after = Some(left.unwrap_or(1.0).max(1.0));
        return Err(ApiErr { status: StatusCode::TOO_MANY_REQUESTS, body: ApiError { code: 0, message: refused.to_owned(), errors: None }, retry_after });
    }
    Ok(attempt)
}

/// Settles an attempt from `begin_attempt`: a right one does not count against the limit, a wrong one stays (and old rows go).
pub(super) async fn end_attempt(state: &AppState, table: &str, attempt: i64, accepted: bool) -> ApiResult<()> {
    if accepted {
        sqlx::query(&format!("DELETE FROM {table} WHERE id = $1")).bind(attempt).execute(&state.db).await?;
    } else {
        sqlx::query(&format!("DELETE FROM {table} WHERE failed_at < now() - make_interval(secs => $1)"))
            .bind(FAILURE_WINDOW_SECONDS)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

async fn check_code_once(state: &AppState, user_id: i64, code: &str) -> ApiResult<bool> {
    let (secret,): (Option<String>,) = sqlx::query_as("SELECT mfa_secret FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    let Some(secret) = secret else { return Ok(false) };
    let compact: String = code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_lowercase();
    if compact.len() == 6 && compact.bytes().all(|b| b.is_ascii_digit()) {
        let Some(step) = totp::matching_step(&secret, &compact, unix_seconds()) else { return Ok(false) };
        let accepted = sqlx::query("UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)")
            .bind(user_id)
            .bind(step as i64)
            .execute(&state.db)
            .await?;
        return Ok(accepted.rows_affected() == 1);
    }
    let used = sqlx::query("UPDATE mfa_backup_codes SET consumed = TRUE WHERE user_id = $1 AND code_hash = $2 AND NOT consumed")
        .bind(user_id)
        .bind(backup_hash(user_id, &compact))
        .execute(&state.db)
        .await?;
    Ok(used.rows_affected() == 1)
}

/// With two-factor on, `code` must be a valid second factor (disable / delete account, disable two-factor).
pub async fn require_code(state: &AppState, user_id: i64, code: Option<&str>) -> ApiResult<()> {
    let (mfa,): (bool,) = sqlx::query_as("SELECT mfa_secret IS NOT NULL FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if !mfa {
        return Ok(());
    }
    match code {
        Some(code) if check_code(state, user_id, code).await? => Ok(()),
        _ => Err(invalid_code()),
    }
}

async fn regenerate_codes(state: &AppState, user_id: i64) -> ApiResult<Vec<BackupCode>> {
    let codes: Vec<String> = {
        let mut rng = rand::rng();
        (0..BACKUP_CODES).map(|_| (0..8).map(|_| char::from(BACKUP_ALPHABET[rng.random_range(0..BACKUP_ALPHABET.len())])).collect()).collect()
    };
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    for (position, code) in codes.iter().enumerate() {
        sqlx::query("INSERT INTO mfa_backup_codes (user_id, code_hash, position) VALUES ($1, $2, $3)")
            .bind(user_id)
            .bind(backup_hash(user_id, code))
            .bind(position as i16)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(codes.into_iter().map(|code| BackupCode { code: Some(code), consumed: false }).collect())
}

pub async fn enable_totp(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<EnableTotpRequest>,
) -> ApiResult<Json<BackupCodesResponse>> {
    let (enabled, verified): (bool, bool) =
        sqlx::query_as("SELECT mfa_secret IS NOT NULL, email_verified FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if enabled {
        return Err(ApiErr::invalid("code", "Two-factor authentication is already enabled."));
    }
    // pre-hijack guard: whoever made an account with someone else's address must not lock it with their own second factor
    if !verified {
        return Err(ApiErr::invalid("email", "Verify your email address before turning on two-factor authentication."));
    }
    confirm_identity(&state, user_id, &headers, body.password, None, false).await?;
    let secret = totp::normalize_secret(&body.secret).ok_or_else(|| ApiErr::invalid("secret", "Not a valid base32 secret of at least 16 characters."))?;
    let step = totp::matching_step(&secret, &body.code, unix_seconds()).ok_or_else(invalid_code)?;
    sqlx::query("UPDATE users SET mfa_secret = $2, mfa_last_step = $3 WHERE id = $1").bind(user_id).bind(&secret).bind(step as i64).execute(&state.db).await?;
    Ok(Json(BackupCodesResponse { backup_codes: regenerate_codes(&state, user_id).await? }))
}

pub async fn disable_totp(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<CodeRequest>) -> ApiResult<StatusCode> {
    if !check_code(&state, user_id, &body.code).await? {
        return Err(invalid_code());
    }
    sqlx::query("UPDATE users SET mfa_secret = NULL, mfa_last_step = NULL WHERE id = $1").bind(user_id).execute(&state.db).await?;
    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1").bind(user_id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn backup_codes(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<BackupCodesRequest>,
) -> ApiResult<Json<BackupCodesResponse>> {
    let (enabled,): (bool,) = sqlx::query_as("SELECT mfa_secret IS NOT NULL FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if !enabled {
        return Err(ApiErr::invalid("code", "Two-factor authentication is not enabled."));
    }
    confirm_identity(&state, user_id, &headers, body.password, body.code.as_deref(), false).await?;
    if body.regenerate {
        return Ok(Json(BackupCodesResponse { backup_codes: regenerate_codes(&state, user_id).await? }));
    }
    let rows: Vec<(bool,)> =
        sqlx::query_as("SELECT consumed FROM mfa_backup_codes WHERE user_id = $1 ORDER BY position").bind(user_id).fetch_all(&state.db).await?;
    Ok(Json(BackupCodesResponse { backup_codes: rows.into_iter().map(|(consumed,)| BackupCode { code: None, consumed }).collect() }))
}

pub async fn mfa_login(State(state): State<AppState>, headers: HeaderMap, ApiJson(body): ApiJson<MfaLoginRequest>) -> ApiResult<Json<AuthResponse>> {
    let ticket = hash_token(body.ticket.trim());
    let row: Option<(i64,)> =
        sqlx::query_as("UPDATE mfa_tickets SET attempts = attempts + 1 WHERE ticket_hash = $1 AND expires_at > now() AND attempts < $2 RETURNING user_id")
            .bind(&ticket)
            .bind(TICKET_ATTEMPTS)
            .fetch_optional(&state.db)
            .await?;
    let Some((user_id,)) = row else { return Err(ApiErr::invalid("ticket", "This login has expired. Log in again.")) };
    if !check_code(&state, user_id, &body.code).await? {
        return Err(invalid_code());
    }
    sqlx::query("DELETE FROM mfa_tickets WHERE ticket_hash = $1 OR expires_at < now()").bind(&ticket).execute(&state.db).await?;
    Ok(Json(session_response(&state, user_id, &headers).await?))
}

/// `(token hash, last used, os, platform)` of one stored session.
type SessionRow = (Vec<u8>, time::OffsetDateTime, Option<String>, Option<String>);

/// Opaque per-session id for the devices list: a hash of the stored token hash, never the token itself.
fn id_hash(token_hash: &[u8]) -> String {
    Sha256::digest(token_hash)[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

pub async fn list_sessions(State(state): State<AppState>, AuthUser(user_id): AuthUser, headers: HeaderMap) -> ApiResult<Json<UserSessions>> {
    let current = bearer_header(&headers).map(hash_token);
    let rows: Vec<SessionRow> =
        sqlx::query_as("SELECT token_hash, last_used_at, client_os, client_platform FROM sessions WHERE user_id = $1 ORDER BY last_used_at DESC")
            .bind(user_id)
            .fetch_all(&state.db)
            .await?;
    let user_sessions = rows
        .into_iter()
        .map(|(hash, used, os, platform)| UserSession {
            id_hash: id_hash(&hash),
            approx_last_used_time: used.format(&Rfc3339).unwrap_or_default(),
            client_info: ClientInfo { os, platform },
            current: current.as_deref() == Some(hash.as_slice()),
        })
        .collect();
    Ok(Json(UserSessions { user_sessions }))
}

pub async fn logout_sessions(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<LogoutSessionsRequest>,
) -> ApiResult<StatusCode> {
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT token_hash FROM sessions WHERE user_id = $1").bind(user_id).fetch_all(&state.db).await?;
    for (hash,) in rows {
        if body.session_id_hashes.iter().any(|wanted| *wanted == id_hash(&hash)) {
            sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(&hash).execute(&state.db).await?;
            state.hub.close_token_sessions(&hash, crate::gateway::CLOSE_AUTH_FAILED);
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn forgot_password(State(state): State<AppState>, ApiJson(body): ApiJson<ForgotPasswordRequest>) -> ApiResult<StatusCode> {
    let login = body.login.trim().to_lowercase();
    // the lookup, token and mail happen after the answer, so known and unknown logins look the same from outside
    tokio::spawn(async move {
        if let Err(error) = send_reset(&state, &login).await {
            tracing::warn!("password reset mail failed: {}", error.body.message);
        }
    });
    Ok(StatusCode::NO_CONTENT)
}

async fn send_reset(state: &AppState, login: &str) -> ApiResult<()> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, email FROM users WHERE (username = $1 OR email = $1) AND deleted_at IS NULL").bind(login).fetch_optional(&state.db).await?;
    if let Some((user_id, email)) = row {
        // at most one reset mail a minute per account
        let (recent,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM email_tokens WHERE user_id = $1 AND purpose = 'reset' \
             AND expires_at > now() + make_interval(secs => $2))",
        )
        .bind(user_id)
        .bind(tokens::RESET_TTL.as_secs_f64() - RESET_COOLDOWN_SECONDS)
        .fetch_one(&state.db)
        .await?;
        if recent {
            return Ok(());
        }
        let token = tokens::issue(state, user_id, Purpose::Reset, &email, tokens::RESET_TTL).await?;
        let body = format!(
            "Someone asked to reset the password of your Vokko account. Open this link within an hour to choose a new one:\n\n{}\n\nIf this wasn't you, ignore this mail; your password stays the same.",
            link(state, "reset", &token)
        );
        state.accounts.mailer.send(&email, "Reset your password", body);
    }
    Ok(())
}

pub async fn reset_password(State(state): State<AppState>, headers: HeaderMap, ApiJson(body): ApiJson<ResetPasswordRequest>) -> ApiResult<Json<LoginResponse>> {
    // validate before using up the link, so a weak password can be corrected
    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT u.id, u.username, u.email FROM email_tokens t JOIN users u ON u.id = t.user_id \
         WHERE t.token_hash = $1 AND t.purpose = 'reset' AND t.expires_at > now() AND t.email = u.email",
    )
    .bind(hash_token(body.token.trim()))
    .fetch_optional(&state.db)
    .await?;
    let invalid = || ApiErr::invalid("token", "This link is invalid or has expired.");
    let Some((user_id, username, email)) = row else { return Err(invalid()) };
    rules::password(&body.password, &[&username, &email])?;
    // hash before using up the link too: a busy server's 429 leaves the link for the retry
    let hash = hash_password(body.password).await?;
    let Some((consumed_user, sent_to)) = tokens::consume(&state, &body.token, Purpose::Reset).await? else { return Err(invalid()) };
    if consumed_user != user_id {
        return Err(invalid());
    }
    let mut tx = state.db.begin().await?;
    // the row lock orders this after any verification that moves the account; the link only counts for the address it went to
    let current: Option<(String,)> = sqlx::query_as("SELECT email FROM users WHERE id = $1 FOR UPDATE").bind(user_id).fetch_optional(&mut *tx).await?;
    if current.is_none_or(|(current,)| current != sent_to) {
        return Err(invalid());
    }
    // pre-hijack: links made before the address was proven may belong to whoever created the account
    sqlx::query(
        "DELETE FROM oauth_identities i USING users u WHERE i.user_id = u.id AND u.id = $1 \
         AND (u.email_verified_at IS NULL OR i.created_at < u.email_verified_at)",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    // the link proves the inbox: the address it went to counts as verified
    sqlx::query(
        "UPDATE users SET password_hash = $2, email_verified = (email_verified OR email = $3), \
         email_verified_at = CASE WHEN NOT email_verified AND email = $3 THEN now() ELSE email_verified_at END WHERE id = $1",
    )
    .bind(user_id)
    .bind(hash)
    .bind(&sent_to)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // an email change someone else started must not outlive the owner taking the account back
    cancel_email_change(&state, user_id, &email).await?;
    revoke_sessions(&state, user_id, None).await?;
    Ok(Json(finish_login(&state, user_id, &headers).await?))
}
