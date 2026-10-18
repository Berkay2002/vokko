//! Everything a user does with their own account: registration rules, email verification, account editing, MFA,
//! sessions, password reset and OAuth sign-in. Routes are merged into `/api/v1` by `routes::api`.
pub mod config;
pub mod mail;
pub mod me;
pub mod oauth;
pub mod rules;
pub mod security;
pub mod tokens;
pub mod totp;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use vokko_protocol::account::{InstanceInfo, UsernameAttemptRequest, UsernameAttemptResponse, VerifyEmailRequest};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::state::AppState;
use config::AccountsConfig;
use mail::Mailer;
pub use me::DUMMY_HASH;
use tokens::Purpose;

/// Account services held by the app state.
pub struct Accounts {
    pub mailer: Mailer,
    /// Outgoing HTTP for OAuth / OIDC (no redirects, 10 s timeout); `None` if it could not be built.
    pub http: Option<reqwest::Client>,
}

impl Accounts {
    pub fn new(config: &AccountsConfig) -> Self {
        Self { mailer: Mailer::new(&config.mail), http: oauth::http_client() }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/instance", get(instance))
        .route("/auth/username-attempt", post(username_attempt))
        .route("/auth/verify", post(verify_email))
        .route("/auth/verify/resend", post(resend_verification))
        .route("/auth/mfa/totp", post(security::mfa_login))
        .route("/auth/forgot", post(security::forgot_password))
        .route("/auth/reset", post(security::reset_password))
        .route("/auth/sessions", get(security::list_sessions))
        .route("/auth/sessions/logout", post(security::logout_sessions))
        .route("/users/@me/mfa/totp/enable", post(security::enable_totp))
        .route("/users/@me/mfa/totp/disable", post(security::disable_totp))
        .route("/users/@me/mfa/codes-verification", post(security::backup_codes))
        .route("/auth/providers", get(oauth::list_providers))
        .route("/auth/oauth/{provider}/authorize", post(oauth::authorize))
        .route("/auth/oauth/{provider}/callback", get(oauth::callback))
        .route("/auth/oauth/complete", post(oauth::complete))
        .route("/auth/oauth/register", post(oauth::register))
        .route("/users/@me/oauth", get(oauth::linked))
        .route("/users/@me/oauth/{provider}", axum::routing::delete(oauth::unlink))
        .route("/users/@me/account", get(me::get_account).patch(me::edit_account))
        .route("/users/@me/disable", post(me::disable_account))
        .route("/users/@me/delete", post(me::delete_account))
}

/// `<web url>/<page>#token=<token>`: the token stays out of server and proxy logs.
pub fn link(state: &AppState, page: &str, token: &str) -> String {
    format!("{}/{page}#token={token}", state.config.accounts.web_url)
}

/// Mails a verification link for `email` (the current address after sign-up, or the new one after a change).
pub async fn send_verification(state: &AppState, user_id: i64, email: &str) -> ApiResult<()> {
    let token = tokens::issue(state, user_id, Purpose::Verify, email, tokens::VERIFY_TTL).await?;
    let body = format!(
        "Confirm this email address for your Vokko account by opening this link within 24 hours:\n\n{}\n\nIf you did not ask for this, ignore this mail.",
        link(state, "verify", &token)
    );
    state.accounts.mailer.send(email, "Verify your email address", body);
    Ok(())
}

async fn instance(State(state): State<AppState>) -> Json<InstanceInfo> {
    let config = &state.config.accounts;
    Json(InstanceInfo {
        registration: if state.config.registration_open { "open" } else { "closed" }.to_owned(),
        min_age: config.min_age,
        terms: config.terms(),
        terms_url: config.terms_url.clone(),
        email_verification: state.accounts.mailer.delivers(),
    })
}

pub async fn username_taken(state: &AppState, username: &str) -> ApiResult<bool> {
    let (taken,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM users WHERE username = $1)").bind(username).fetch_one(&state.db).await?;
    Ok(taken)
}

async fn username_attempt(State(state): State<AppState>, ApiJson(body): ApiJson<UsernameAttemptRequest>) -> ApiResult<Json<UsernameAttemptResponse>> {
    let username = rules::username(&body.username)?;
    Ok(Json(UsernameAttemptResponse { taken: username_taken(&state, &username).await? }))
}

async fn verify_email(State(state): State<AppState>, ApiJson(body): ApiJson<VerifyEmailRequest>) -> ApiResult<StatusCode> {
    let invalid = || ApiErr::invalid("token", "This link is invalid or has expired.");
    let Some((user_id, email)) = tokens::consume(&state, &body.token, Purpose::Verify).await? else { return Err(invalid()) };
    // A token for an address the account has since moved away from (or a stale pending change) is dead.
    let result = sqlx::query(
        "UPDATE users SET email = $2, email_verified = TRUE, email_verified_at = COALESCE(email_verified_at, now()), pending_email = NULL \
         WHERE id = $1 AND (email = $2 OR pending_email = $2)",
    )
    .bind(user_id)
    .bind(&email)
    .execute(&state.db)
    .await;
    match result {
        Ok(done) if done.rows_affected() == 1 => {
            // reset links sent to an address the account no longer uses are dead
            sqlx::query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset' AND email <> $2")
                .bind(user_id)
                .bind(&email)
                .execute(&state.db)
                .await?;
            Ok(StatusCode::NO_CONTENT)
        }
        Ok(_) => Err(invalid()),
        Err(sqlx::Error::Database(database)) if database.is_unique_violation() => Err(ApiErr::invalid("email", "Already taken.")),
        Err(error) => Err(error.into()),
    }
}

async fn resend_verification(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<StatusCode> {
    let (email, verified, pending): (String, bool, Option<String>) =
        sqlx::query_as("SELECT email, email_verified, pending_email FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    match (pending, verified) {
        (Some(pending), _) => send_verification(&state, user_id, &pending).await?,
        (None, false) => send_verification(&state, user_id, &email).await?,
        (None, true) => return Err(ApiErr::invalid("email", "Your email is already verified.")),
    }
    Ok(StatusCode::NO_CONTENT)
}
