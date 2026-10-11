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
use tokio::sync::Semaphore;

use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;

/// Argon2 takes ~19 MiB and tens of milliseconds of CPU: at most this many run at once, the rest wait.
const MAX_CONCURRENT_HASHES: usize = 4;
static HASH_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_HASHES);

pub async fn hash_password(password: String) -> ApiResult<String> {
    let _slot = HASH_SLOTS.acquire().await.map_err(|_| ApiErr::internal())?;
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

pub async fn verify_password(password: String, hash: String) -> bool {
    let Ok(_slot) = HASH_SLOTS.acquire().await else { return false };
    tokio::task::spawn_blocking(move || match PasswordHash::new(&hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    })
    .await
    .unwrap_or(false)
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

/// Looks a token up; `None` if it is unknown or revoked.
pub async fn user_for_token(state: &AppState, token: &str) -> ApiResult<Option<i64>> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM sessions WHERE token_hash = $1").bind(hash_token(token)).fetch_optional(&state.db).await?;
    Ok(row.map(|(id,)| id))
}

/// The raw `Authorization` header value (no scheme prefix), if present and non-empty.
pub fn bearer_header(headers: &HeaderMap) -> Option<&str> {
    headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()).map(str::trim).filter(|value| !value.is_empty())
}

/// Set by the rate-limit middleware once it has resolved the caller, so the extractor does not look the token up again.
#[derive(Clone, Copy)]
pub struct ResolvedUser(pub i64);

/// The authenticated user, from the raw `Authorization: <token>` header (no scheme prefix).
pub struct AuthUser(pub i64);

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
