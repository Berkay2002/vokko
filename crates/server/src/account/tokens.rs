//! Single-use emailed tokens (verification and password reset): 32 random bytes, stored as SHA-256 with an expiry.
use std::time::Duration;

use crate::auth::{hash_token, new_token};
use crate::error::ApiResult;
use crate::state::AppState;

pub const VERIFY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
pub const RESET_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Verify,
    Reset,
}

impl Purpose {
    fn as_str(self) -> &'static str {
        match self {
            Self::Verify => "verify",
            Self::Reset => "reset",
        }
    }
}

/// A new token for `email`, replacing the user's earlier tokens of the same purpose.
pub async fn issue(state: &AppState, user_id: i64, purpose: Purpose, email: &str, ttl: Duration) -> ApiResult<String> {
    let token = new_token();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2").bind(user_id).bind(purpose.as_str()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(purpose.as_str())
        .bind(email)
        .bind(ttl.as_secs_f64())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(token)
}

/// Uses up a token: `(user id, email it was sent to)`, or `None` when it is unknown, used or expired.
pub async fn consume(state: &AppState, token: &str, purpose: Purpose) -> ApiResult<Option<(i64, String)>> {
    let row: Option<(i64, String)> =
        sqlx::query_as("DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id, email")
            .bind(hash_token(token.trim()))
            .bind(purpose.as_str())
            .fetch_optional(&state.db)
            .await?;
    Ok(row)
}
