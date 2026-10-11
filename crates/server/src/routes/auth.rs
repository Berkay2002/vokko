use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use vokko_protocol::api::{AuthRequest, AuthResponse, PresenceStatus, RegisterRequest};

use crate::auth::{AuthUser, hash_password, hash_token, new_token, verify_password};
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::gateway::CLOSE_AUTH_FAILED;
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new().route("/auth/register", post(register)).route("/auth/login", post(login)).route("/auth/logout", post(logout))
}

pub fn valid_username(username: &str) -> bool {
    (2..=32).contains(&username.len()) && username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

pub fn clean_text(value: Option<String>, max_chars: usize, field: &str) -> ApiResult<Option<String>> {
    match value.map(|text| text.trim().to_owned()) {
        None => Ok(None),
        Some(text) if text.is_empty() => Ok(None),
        Some(text) if text.chars().count() > max_chars => Err(ApiErr::invalid(field, &format!("Must be {max_chars} or fewer in length."))),
        Some(text) => Ok(Some(text)),
    }
}

async fn issue_token(state: &AppState, user_id: i64) -> ApiResult<String> {
    let token = new_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)").bind(hash_token(&token)).bind(user_id).execute(&state.db).await?;
    Ok(token)
}

async fn register(State(state): State<AppState>, ApiJson(body): ApiJson<RegisterRequest>) -> ApiResult<Json<AuthResponse>> {
    let username = body.username.trim().to_lowercase();
    if !valid_username(&username) {
        return Err(ApiErr::invalid("username", "Must be 2-32 characters: lowercase letters, numbers, '_' and '.'."));
    }
    let email = body.email.trim().to_lowercase();
    if email.len() > 254 || !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err(ApiErr::invalid("email", "Not a well formed email address."));
    }
    let length = body.password.chars().count();
    if !(8..=128).contains(&length) {
        return Err(ApiErr::invalid("password", "Must be between 8 and 128 in length."));
    }
    let global_name = clean_text(body.global_name, 32, "global_name")?;
    let hash = hash_password(body.password).await?;
    let id = state.ids.next();
    let inserted = sqlx::query("INSERT INTO users (id, username, email, global_name, password_hash) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(&username)
        .bind(&email)
        .bind(&global_name)
        .bind(&hash)
        .execute(&state.db)
        .await;
    if let Err(error) = inserted {
        if let sqlx::Error::Database(database) = &error
            && database.is_unique_violation()
        {
            let field = if database.constraint().is_some_and(|name| name.contains("email")) { "email" } else { "username" };
            return Err(ApiErr::invalid(field, "Already taken."));
        }
        return Err(error.into());
    }
    sqlx::query("INSERT INTO presences (user_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(PresenceStatus::Offline.as_str())
        .execute(&state.db)
        .await?;
    let token = issue_token(&state, id).await?;
    let user = store::user(&state, id).await?.ok_or_else(ApiErr::internal)?;
    Ok(Json(AuthResponse { token, user }))
}

async fn login(State(state): State<AppState>, ApiJson(body): ApiJson<AuthRequest>) -> ApiResult<Json<AuthResponse>> {
    let login = body.login.trim().to_lowercase();
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE username = $1 OR email = $1").bind(&login).fetch_optional(&state.db).await?;
    let invalid = || ApiErr::invalid("login", "Login or password is invalid.");
    let Some((id, hash)) = row else {
        // Spend the same time as a real verification.
        let _ = verify_password(body.password, "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned())
            .await;
        return Err(invalid());
    };
    if !verify_password(body.password, hash).await {
        return Err(invalid());
    }
    let token = issue_token(&state, id).await?;
    let user = store::user(&state, id).await?.ok_or_else(ApiErr::internal)?;
    Ok(Json(AuthResponse { token, user }))
}

async fn logout(State(state): State<AppState>, AuthUser(_): AuthUser, headers: HeaderMap) -> ApiResult<StatusCode> {
    if let Some(token) = headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()) {
        let hash = hash_token(token.trim());
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(&hash).execute(&state.db).await?;
        // live gateway connections of this token end now (4004: the client must not reconnect with it)
        state.hub.close_token_sessions(&hash, CLOSE_AUTH_FAILED);
    }
    Ok(StatusCode::NO_CONTENT)
}
