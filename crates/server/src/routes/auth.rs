use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use vokko_protocol::account::LoginResponse;
use vokko_protocol::api::{AuthRequest, AuthResponse, PresenceStatus, RegisterRequest};

use crate::account::{self, rules};
use crate::auth::{AuthUser, hash_password, hash_token, verify_password};
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::gateway::CLOSE_AUTH_FAILED;
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new().route("/auth/register", post(register)).route("/auth/login", post(login)).route("/auth/logout", post(logout))
}

pub fn clean_text(value: Option<String>, max_chars: usize, field: &str) -> ApiResult<Option<String>> {
    match value.map(|text| text.trim().to_owned()) {
        None => Ok(None),
        Some(text) if text.is_empty() => Ok(None),
        Some(text) if text.chars().count() > max_chars => Err(ApiErr::invalid(field, &format!("Must be {max_chars} or fewer in length."))),
        Some(text) => Ok(Some(text)),
    }
}

async fn register(State(state): State<AppState>, headers: HeaderMap, ApiJson(body): ApiJson<RegisterRequest>) -> ApiResult<Json<AuthResponse>> {
    let config = &state.config.accounts;
    if !state.config.registration_open {
        return Err(ApiErr::registration_closed());
    }
    let email = rules::email(&body.email)?;
    let username = rules::username(&body.username)?;
    let global_name = clean_text(body.global_name, 32, "global_name")?;
    rules::password(&body.password, &[&username, &email])?;
    let date_of_birth = rules::date_of_birth(body.date_of_birth.as_deref(), config.min_age)?;
    if config.terms().is_some() && body.consent != Some(true) {
        return Err(ApiErr::invalid("consent", "You need to agree to the terms."));
    }
    let hash = hash_password(body.password).await?;
    let id = state.ids.next();
    let inserted = sqlx::query("INSERT INTO users (id, username, email, global_name, password_hash, date_of_birth) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(&username)
        .bind(&email)
        .bind(&global_name)
        .bind(&hash)
        .bind(date_of_birth)
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
    account::send_verification(&state, id, &email, None).await?;
    let token = account::security::issue_session(&state, id, &headers).await?;
    let user = store::user(&state, id).await?.ok_or_else(ApiErr::internal)?;
    Ok(Json(AuthResponse { token, user }))
}

async fn login(State(state): State<AppState>, headers: HeaderMap, ApiJson(body): ApiJson<AuthRequest>) -> ApiResult<Json<LoginResponse>> {
    let login = body.login.trim().to_lowercase();
    let row: Option<(i64, Option<String>)> = sqlx::query_as("SELECT id, password_hash FROM users WHERE (username = $1 OR email = $1) AND deleted_at IS NULL")
        .bind(&login)
        .fetch_optional(&state.db)
        .await?;
    let invalid = || ApiErr::invalid("login", "Login or password is invalid.");
    let Some((id, Some(hash))) = row else {
        // Spend the same time as a real verification.
        verify_password(body.password, account::DUMMY_HASH.to_owned()).await?;
        return Err(invalid());
    };
    if !verify_password(body.password, hash).await? {
        return Err(invalid());
    }
    Ok(Json(account::security::finish_login(&state, id, &headers).await?))
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
