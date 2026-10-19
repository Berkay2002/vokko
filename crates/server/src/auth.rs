//! Password hashing (argon2id), opaque session tokens (random 32 bytes, stored as SHA-256) and the `Authorization` extractor.
use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::extract::FromRequestParts;
use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;

/// Argon2 takes ~19 MiB and tens of milliseconds of CPU: at most this many run at once, the rest wait up to HASH_WAIT.
const MAX_CONCURRENT_HASHES: usize = 4;
const HASH_WAIT: Duration = Duration::from_secs(2);
static HASH_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_HASHES);

/// A hashing slot, or 429 with `Retry-After` when none frees up within `wait`, so a flood of logins cannot queue
/// everyone else's sign-in behind it without bound.
async fn hash_slot(slots: &Semaphore, wait: Duration) -> ApiResult<SemaphorePermit<'_>> {
    match tokio::time::timeout(wait, slots.acquire()).await {
        Ok(Ok(slot)) => Ok(slot),
        Ok(Err(_)) => Err(ApiErr::internal()),
        Err(_) => {
            let mut error = ApiErr::rate_limited(wait.as_secs_f64());
            error.body.message = "The server is busy. Try again in a moment.".to_owned();
            Err(error)
        }
    }
}

pub async fn hash_password(password: String) -> ApiResult<String> {
    let _slot = hash_slot(&HASH_SLOTS, HASH_WAIT).await?;
    let result = tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default().hash_password(password.as_bytes(), &salt).map(|hash| hash.to_string())
    })
    .await;
    match result {
        Ok(Ok(hash)) => Ok(hash),
        _ => Err(ApiErr::internal()),
    }
}

/// Whether `password` matches `hash`; errors only when the server is too busy to check (429, see `hash_slot`).
pub async fn verify_password(password: String, hash: String) -> ApiResult<bool> {
    let _slot = hash_slot(&HASH_SLOTS, HASH_WAIT).await?;
    Ok(tokio::task::spawn_blocking(move || match PasswordHash::new(&hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    })
    .await
    .unwrap_or(false))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn new_token() -> String {
    random_hex(32)
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Looks a token up; `None` if it is unknown or revoked. Bot tokens only work with the `Bot ` prefix, user tokens only without it.
pub async fn user_for_token(state: &AppState, token: &str) -> ApiResult<Option<i64>> {
    let (raw, bot) = match token.strip_prefix("Bot ") {
        Some(raw) => (raw.trim(), true),
        None => (token, false),
    };
    let hash = hash_token(raw);
    let row: Option<(i64, bool)> = sqlx::query_as(
        "SELECT s.user_id, s.last_used_at < now() - interval '5 minutes' FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND u.bot = $2",
    )
    .bind(&hash)
    .bind(bot)
    .fetch_optional(&state.db)
    .await?;
    // "last used" for the devices list, written at most every 5 minutes per session
    if let Some((_, true)) = row {
        sqlx::query("UPDATE sessions SET last_used_at = now() WHERE token_hash = $1").bind(&hash).execute(&state.db).await?;
    }
    Ok(row.map(|(id, _)| id))
}

/// The raw `Authorization` header value (no scheme prefix), if present and non-empty.
pub fn bearer_header(headers: &HeaderMap) -> Option<&str> {
    headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()).map(str::trim).filter(|value| !value.is_empty())
}

/// Set by the rate-limit middleware once it has resolved the caller, so the extractor does not look the token up again.
#[derive(Clone, Copy)]
pub struct ResolvedUser(pub i64);

/// The authenticated user, from the raw `Authorization: <token>` header (no scheme prefix; `Bot <token>` for bots).
pub struct AuthUser(pub i64);

/// An authenticated user that is not a bot: routes only people may use (applications, OAuth2, running commands) answer bots 403 20001.
pub struct HumanUser(pub i64);

impl FromRequestParts<AppState> for HumanUser {
    type Rejection = ApiErr;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let AuthUser(id) = AuthUser::from_request_parts(parts, state).await?;
        let (bot,): (bool,) = sqlx::query_as("SELECT bot FROM users WHERE id = $1").bind(id).fetch_one(&state.db).await?;
        if bot { Err(ApiErr::bots_forbidden()) } else { Ok(Self(id)) }
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiErr;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if let Some(ResolvedUser(id)) = parts.extensions.get::<ResolvedUser>().copied() {
            return Ok(Self(id));
        }
        let Some(token) = bearer_header(&parts.headers) else { return Err(ApiErr::unauthorized()) };
        match user_for_token(state, token).await? {
            Some(id) => Ok(Self(id)),
            None => Err(ApiErr::unauthorized()),
        }
    }
}

/// `Option<AuthUser>` for routes that also serve anonymous callers: no `Authorization` header is `None`, while a header with
/// an unknown or expired token is still 401 (the client signs in again instead of silently seeing the anonymous view).
impl axum::extract::OptionalFromRequestParts<AppState> for AuthUser {
    type Rejection = ApiErr;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Option<Self>, Self::Rejection> {
        if parts.extensions.get::<ResolvedUser>().is_none() && bearer_header(&parts.headers).is_none() {
            return Ok(None);
        }
        <Self as FromRequestParts<AppState>>::from_request_parts(parts, state).await.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hash_slot_refuses_with_retry_after_when_every_slot_stays_busy() {
        let slots = Semaphore::new(1);
        let held = slots.acquire().await.unwrap();
        let refused = hash_slot(&slots, Duration::from_millis(20)).await.unwrap_err();
        assert_eq!(refused.status, axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert!(refused.retry_after.is_some_and(|seconds| seconds > 0.0));
        drop(held);
        assert!(hash_slot(&slots, Duration::from_millis(20)).await.is_ok());
    }
}
