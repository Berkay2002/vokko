//! Single-use emailed tokens (verification and password reset): 32 random bytes, stored as SHA-256 with an expiry.
use std::time::Duration;

use crate::auth::{hash_token, new_token};
use crate::error::{ApiErr, ApiResult};
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

/// A new token for `email`, replacing the user's earlier tokens of the same purpose. With a `cooldown`, a token of this
/// purpose issued less than that long ago answers 429 instead; the user row lock makes the check and the replacement
/// one step, so concurrent requests issue (and mail) one token.
pub async fn issue(state: &AppState, user_id: i64, purpose: Purpose, email: &str, ttl: Duration, cooldown: Option<Duration>) -> ApiResult<String> {
    let token = new_token();
    let mut tx = state.db.begin().await?;
    if let Some(cooldown) = cooldown {
        sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(user_id).execute(&mut *tx).await?;
        // clock_timestamp, not now(): this transaction may have started before the one it waited for committed
        let wait: Option<(f64,)> = sqlx::query_as(
            "SELECT $3 - EXTRACT(EPOCH FROM clock_timestamp() - max(created_at))::float8 FROM email_tokens WHERE user_id = $1 AND purpose = $2 \
             AND expires_at > now() HAVING count(*) > 0",
        )
        .bind(user_id)
        .bind(purpose.as_str())
        .bind(cooldown.as_secs_f64())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((wait,)) = wait.filter(|(wait,)| *wait > 0.0) {
            return Err(ApiErr::rate_limited(wait));
        }
    }
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
