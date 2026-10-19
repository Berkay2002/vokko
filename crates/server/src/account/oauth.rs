//! Sign in with GitHub (OAuth 2), Google and any OpenID Connect provider: authorization code flow with PKCE, `state` and
//! (OIDC) `nonce`. The server does the token exchange; client secrets and provider tokens never leave it.
//!
//! 1. `POST /auth/oauth/{id}/authorize` stores the flow (hashed `state`, PKCE verifier, nonce, client challenge) and
//!    answers the provider URL.
//! 2. The provider sends the browser to `GET /auth/oauth/{id}/callback`, which checks `state`, exchanges the code, reads
//!    the identity and redirects to the client with a single-use result code.
//! 3. `POST /auth/oauth/complete` redeems the result with the client's verifier: a login, a registration ticket or a link.
use std::error::Error;
use std::fmt;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use oauth2::basic::BasicClient;
use oauth2::{AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse, TokenUrl};
use openidconnect::core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata};
use openidconnect::{IssuerUrl, Nonce};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use vokko_protocol::account::{
    AuthProvider, LinkedProvider, LoginResponse, OAuthAuthorizeRequest, OAuthAuthorizeResponse, OAuthCompleteRequest, OAuthCompleteResponse,
    OAuthRegisterRequest, OAuthRegistration,
};
use vokko_protocol::api::{AuthResponse, PresenceStatus};

use super::config::{ProviderConfig, ProviderKind};
use super::me::confirm_identity;
use super::security::{finish_login, issue_session};
use super::{rules, send_verification, totp, username_taken};
use crate::auth::{AuthUser, bearer_header, hash_token, new_token, user_for_token};
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery};
use crate::state::AppState;
use crate::store;

const FLOW_SECONDS: f64 = 600.0;

// ---- HTTP client for the oauth2 / openidconnect crates (reqwest without redirects, short timeout) ----

#[derive(Debug)]
pub struct HttpError(String);

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for HttpError {}

pub fn http_client() -> Option<reqwest::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(10)).build().ok()
}

async fn execute(client: reqwest::Client, request: oauth2::HttpRequest) -> Result<oauth2::HttpResponse, HttpError> {
    let (parts, body) = request.into_parts();
    let response =
        client.request(parts.method, parts.uri.to_string()).headers(parts.headers).body(body).send().await.map_err(|error| HttpError(error.to_string()))?;
    let mut builder = http::Response::builder().status(response.status());
    for (name, value) in response.headers() {
        builder = builder.header(name, value);
    }
    let bytes = response.bytes().await.map_err(|error| HttpError(error.to_string()))?;
    builder.body(bytes.to_vec()).map_err(|error| HttpError(error.to_string()))
}

type HttpFuture = std::pin::Pin<Box<dyn Future<Output = Result<oauth2::HttpResponse, HttpError>> + Send>>;

fn oauth_http(state: &AppState) -> ApiResult<impl Fn(oauth2::HttpRequest) -> HttpFuture> {
    let client = state.accounts.http.clone().ok_or_else(ApiErr::internal)?;
    Ok(move |request| Box::pin(execute(client.clone(), request)) as HttpFuture)
}

// ---- providers ----

fn provider(state: &AppState, id: &str) -> ApiResult<ProviderConfig> {
    state.config.accounts.providers.iter().find(|provider| provider.id == id).cloned().ok_or_else(|| ApiErr::invalid("provider", "Unknown sign-in provider."))
}

fn redirect_url(state: &AppState, provider: &ProviderConfig) -> String {
    format!("{}/api/v1/auth/oauth/{}/callback", state.config.public_url, provider.id)
}

pub async fn list_providers(State(state): State<AppState>) -> Json<Vec<AuthProvider>> {
    Json(
        state
            .config
            .accounts
            .providers
            .iter()
            .map(|provider| AuthProvider { id: provider.id.clone(), name: provider.name.clone(), kind: provider.kind.as_str().to_owned() })
            .collect(),
    )
}

async fn oidc_client(
    state: &AppState,
    provider: &ProviderConfig,
    issuer: &str,
) -> ApiResult<
    CoreClient<
        openidconnect::EndpointSet,
        openidconnect::EndpointNotSet,
        openidconnect::EndpointNotSet,
        openidconnect::EndpointNotSet,
        openidconnect::EndpointMaybeSet,
        openidconnect::EndpointMaybeSet,
    >,
> {
    let http = oauth_http(state)?;
    let issuer = IssuerUrl::new(issuer.to_owned()).map_err(|_| ApiErr::internal())?;
    let metadata = CoreProviderMetadata::discover_async(issuer, &http).await.map_err(|error| {
        tracing::warn!("OIDC discovery for {} failed: {error}", provider.id);
        provider_error()
    })?;
    let redirect = RedirectUrl::new(redirect_url(state, provider)).map_err(|_| ApiErr::internal())?;
    Ok(CoreClient::from_provider_metadata(metadata, ClientId::new(provider.client_id.clone()), Some(ClientSecret::new(provider.client_secret.clone())))
        .set_redirect_uri(redirect))
}

fn github_client(
    state: &AppState,
    provider: &ProviderConfig,
    auth_url: &str,
    token_url: &str,
) -> ApiResult<BasicClient<oauth2::EndpointSet, oauth2::EndpointNotSet, oauth2::EndpointNotSet, oauth2::EndpointNotSet, oauth2::EndpointSet>> {
    let bad = |_| ApiErr::internal();
    Ok(BasicClient::new(ClientId::new(provider.client_id.clone()))
        .set_client_secret(ClientSecret::new(provider.client_secret.clone()))
        .set_auth_uri(AuthUrl::new(auth_url.to_owned()).map_err(bad)?)
        .set_token_uri(TokenUrl::new(token_url.to_owned()).map_err(bad)?)
        .set_redirect_uri(RedirectUrl::new(redirect_url(state, provider)).map_err(bad)?))
}

fn provider_error() -> ApiErr {
    ApiErr::invalid("provider", "The sign-in provider could not be reached. Try again later.")
}

// ---- 1. authorize ----

pub async fn authorize(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<OAuthAuthorizeRequest>,
) -> ApiResult<Json<OAuthAuthorizeResponse>> {
    let provider = provider(&state, &id)?;
    if body.target != "web" && body.target != "desktop" {
        return Err(ApiErr::invalid("target", "Must be web or desktop."));
    }
    let challenge = body.client_challenge.trim();
    if challenge.len() != 43 || URL_SAFE_NO_PAD.decode(challenge).is_err() {
        return Err(ApiErr::invalid("client_challenge", "Must be base64url(SHA-256(client_verifier))."));
    }
    // linking needs a signed-in caller (this route is under /auth/, so it reads the token itself) who proves it is them:
    // a stolen session alone must not be able to add a sign-in method that outlives a password change
    let link_user = if body.link {
        let token = bearer_header(&headers).ok_or_else(ApiErr::unauthorized)?;
        let user_id = user_for_token(&state, token).await?.ok_or_else(ApiErr::unauthorized)?;
        let (has_password, mfa): (bool, bool) =
            sqlx::query_as("SELECT password_hash IS NOT NULL, mfa_secret IS NOT NULL FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
        // accounts with neither are checked in `complete` (a fresh session), where a re-confirmation needs nothing
        if has_password || mfa {
            confirm_identity(&state, user_id, &headers, body.password.clone(), body.code.as_deref(), false).await?;
        }
        Some(user_id)
    } else {
        None
    };
    let flow_state = new_token();
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let nonce = new_token();
    let csrf = flow_state.clone();
    let url = match &provider.kind {
        ProviderKind::Github { auth_url, token_url, .. } => {
            let (url, _) = github_client(&state, &provider, auth_url, token_url)?
                .authorize_url(move || CsrfToken::new(csrf))
                .add_scope(Scope::new("read:user".to_owned()))
                .add_scope(Scope::new("user:email".to_owned()))
                .set_pkce_challenge(pkce_challenge)
                .url();
            url
        }
        ProviderKind::Oidc { issuer } | ProviderKind::Google { issuer } => {
            let nonce = nonce.clone();
            let (url, _, _) = oidc_client(&state, &provider, issuer)
                .await?
                .authorize_url(CoreAuthenticationFlow::AuthorizationCode, move || CsrfToken::new(csrf), move || Nonce::new(nonce))
                .add_scope(Scope::new("email".to_owned()))
                .add_scope(Scope::new("profile".to_owned()))
                .set_pkce_challenge(pkce_challenge)
                .url();
            url
        }
    };
    sqlx::query(
        "INSERT INTO oauth_flows (state_hash, provider, pkce_verifier, nonce, target, client_challenge, link_user_id, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))",
    )
    .bind(hash_token(&flow_state))
    .bind(&provider.id)
    .bind(pkce_verifier.secret())
    .bind(&nonce)
    .bind(&body.target)
    .bind(challenge)
    .bind(link_user)
    .bind(FLOW_SECONDS)
    .execute(&state.db)
    .await?;
    sqlx::query("DELETE FROM oauth_flows WHERE expires_at < now()").execute(&state.db).await?;
    Ok(Json(OAuthAuthorizeResponse { url: url.to_string() }))
}

// ---- 2. callback ----

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// What the provider told us about the user. `email` only when the provider says it is verified.
struct Identity {
    subject: String,
    email: Option<String>,
    name: Option<String>,
    username: Option<String>,
}

fn client_redirect(state: &AppState, target: &str, query: &[(&str, &str)]) -> Response {
    let encoded: String = query.iter().map(|(key, value)| format!("{key}={}", urlencode(value))).collect::<Vec<_>>().join("&");
    let location =
        if target == "desktop" { format!("vokko://auth/callback?{encoded}") } else { format!("{}/oauth/callback#{encoded}", state.config.accounts.web_url) };
    (StatusCode::SEE_OTHER, [(header::LOCATION, location), (header::CACHE_CONTROL, "no-store".to_owned())]).into_response()
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => char::from(byte).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

pub async fn callback(State(state): State<AppState>, Path(id): Path<String>, ApiQuery(query): ApiQuery<CallbackQuery>) -> Response {
    let Some(flow_state) = query.state.filter(|value| !value.is_empty()) else {
        return client_redirect(&state, "web", &[("error", "The sign-in was not started here.")]);
    };
    let flow: Option<(String, String, String, String, String, Option<i64>)> = match sqlx::query_as(
        "DELETE FROM oauth_flows WHERE state_hash = $1 AND expires_at > now() \
         RETURNING provider, pkce_verifier, nonce, target, client_challenge, link_user_id",
    )
    .bind(hash_token(&flow_state))
    .fetch_optional(&state.db)
    .await
    {
        Ok(flow) => flow,
        Err(error) => {
            tracing::error!("oauth flow lookup: {error}");
            None
        }
    };
    let Some((provider_id, verifier, nonce, target, client_challenge, link_user)) = flow.filter(|flow| flow.0 == id) else {
        return client_redirect(&state, "web", &[("error", "This sign-in has expired. Try again.")]);
    };
    if query.error.is_some() {
        return client_redirect(&state, &target, &[("error", "The sign-in was cancelled.")]);
    }
    let Some(code) = query.code.filter(|code| !code.is_empty()) else {
        return client_redirect(&state, &target, &[("error", "The provider sent no authorization code.")]);
    };
    let result = async {
        let provider = provider(&state, &provider_id)?;
        let identity = identity(&state, &provider, code, verifier, nonce).await?;
        store_result(&state, &provider, identity, &client_challenge, link_user).await
    }
    .await;
    match result {
        Ok(result_code) => client_redirect(&state, &target, &[("code", &result_code), ("provider", &provider_id)]),
        Err(error) => {
            let message =
                error.body.errors.as_ref().and_then(|errors| errors.pointer("/provider/_errors/0/message")).and_then(|value| value.as_str()).map(str::to_owned);
            client_redirect(&state, &target, &[("error", message.as_deref().unwrap_or("The sign-in failed. Try again."))])
        }
    }
}

async fn identity(state: &AppState, provider: &ProviderConfig, code: String, verifier: String, nonce: String) -> ApiResult<Identity> {
    let http = oauth_http(state)?;
    match &provider.kind {
        ProviderKind::Github { auth_url, token_url, api_url } => {
            let token = github_client(state, provider, auth_url, token_url)?
                .exchange_code(AuthorizationCode::new(code))
                .set_pkce_verifier(PkceCodeVerifier::new(verifier))
                .request_async(&http)
                .await
                .map_err(|error| {
                    tracing::warn!("GitHub token exchange failed: {error}");
                    provider_error()
                })?;
            github_identity(state, api_url, token.access_token().secret()).await
        }
        ProviderKind::Oidc { issuer } | ProviderKind::Google { issuer } => {
            let client = oidc_client(state, provider, issuer).await?;
            let token = client
                .exchange_code(AuthorizationCode::new(code))
                .map_err(|_| provider_error())?
                .set_pkce_verifier(PkceCodeVerifier::new(verifier))
                .request_async(&http)
                .await
                .map_err(|error| {
                    tracing::warn!("OIDC token exchange with {} failed: {error}", provider.id);
                    provider_error()
                })?;
            let id_token = token.extra_fields().id_token().ok_or_else(provider_error)?;
            let claims = id_token.claims(&client.id_token_verifier(), &Nonce::new(nonce)).map_err(|error| {
                tracing::warn!("ID token from {} rejected: {error}", provider.id);
                ApiErr::invalid("provider", "The sign-in provider's answer could not be verified.")
            })?;
            let email = claims.email().filter(|_| claims.email_verified() == Some(true)).map(|email| email.as_str().to_lowercase());
            Ok(Identity {
                subject: claims.subject().as_str().to_owned(),
                email,
                name: claims.name().and_then(|name| name.get(None)).map(|name| name.as_str().to_owned()),
                username: claims.preferred_username().map(|name| name.as_str().to_owned()),
            })
        }
    }
}

#[derive(Deserialize)]
struct GithubUser {
    id: u64,
    login: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GithubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

async fn github_identity(state: &AppState, api_url: &str, access_token: &str) -> ApiResult<Identity> {
    let client = state.accounts.http.clone().ok_or_else(ApiErr::internal)?;
    let get = |path: &str| {
        client
            .get(format!("{api_url}{path}"))
            .header(header::AUTHORIZATION, format!("Bearer {access_token}"))
            .header(header::ACCEPT, "application/vnd.github+json")
            .header(header::USER_AGENT, "vokko-server")
            .send()
    };
    let failed = |error: reqwest::Error| {
        tracing::warn!("GitHub API call failed: {error}");
        provider_error()
    };
    let body = get("/user").await.and_then(reqwest::Response::error_for_status).map_err(failed)?.bytes().await.map_err(failed)?;
    let user: GithubUser = serde_json::from_slice(&body).map_err(|_| provider_error())?;
    let emails: Vec<GithubEmail> = match get("/user/emails").await.and_then(reqwest::Response::error_for_status) {
        Ok(response) => response.bytes().await.ok().and_then(|body| serde_json::from_slice(&body).ok()).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let email = emails.iter().find(|email| email.primary && email.verified).map(|email| email.email.to_lowercase());
    Ok(Identity { subject: user.id.to_string(), email, name: user.name, username: Some(user.login) })
}

/// A username suggestion built from the provider's handle (lowercased, invalid characters dropped), if free.
async fn suggest_username(state: &AppState, identity: &Identity) -> ApiResult<Option<String>> {
    let candidates = [identity.username.as_deref(), identity.email.as_deref().and_then(|email| email.split('@').next()), identity.name.as_deref()];
    for raw in candidates.into_iter().flatten() {
        let mut name: String = raw
            .to_lowercase()
            .chars()
            .map(|c| if c == '-' || c == ' ' { '_' } else { c })
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '.')
            .collect();
        while name.contains("..") {
            name = name.replace("..", ".");
        }
        name.truncate(32);
        if rules::username_problem(&name).is_none() && !username_taken(state, &name).await? {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Stores the outcome of a callback as a single-use result and returns its code.
async fn store_result(state: &AppState, provider: &ProviderConfig, identity: Identity, client_challenge: &str, link_user: Option<i64>) -> ApiResult<String> {
    let owner: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM oauth_identities WHERE provider = $1 AND subject = $2")
        .bind(&provider.id)
        .bind(&identity.subject)
        .fetch_optional(&state.db)
        .await?;
    let (kind, user_id) = match (link_user, owner) {
        (Some(user), Some((owner,))) if owner != user => {
            return Err(ApiErr::invalid("provider", &format!("This {} account is already linked to another Vokko account.", provider.name)));
        }
        // nothing is linked yet: `complete` does it once the verifier and the caller's session are checked
        (Some(user), _) => ("link", Some(user)),
        (None, Some((owner,))) => ("login", Some(owner)),
        (None, None) => ("register", None),
    };
    let code = new_token();
    let suggested = if kind == "register" { suggest_username(state, &identity).await? } else { None };
    sqlx::query(
        "INSERT INTO oauth_results (code_hash, kind, provider, client_challenge, user_id, subject, email, suggested_username, display_name, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))",
    )
    .bind(hash_token(&code))
    .bind(kind)
    .bind(&provider.id)
    .bind(client_challenge)
    .bind(user_id)
    .bind(&identity.subject)
    .bind(&identity.email)
    .bind(suggested)
    .bind(identity.name.map(|name| name.chars().take(32).collect::<String>()))
    .bind(FLOW_SECONDS)
    .execute(&state.db)
    .await?;
    sqlx::query("DELETE FROM oauth_results WHERE expires_at < now()").execute(&state.db).await?;
    Ok(code)
}

// ---- 3. complete / register ----

type ResultRow = (String, String, String, Option<i64>, String, Option<String>, Option<String>, Option<String>);

pub async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<OAuthCompleteRequest>,
) -> ApiResult<Json<OAuthCompleteResponse>> {
    let invalid = || ApiErr::invalid("code", "This sign-in has expired. Try again.");
    let row: Option<ResultRow> = sqlx::query_as(
        "DELETE FROM oauth_results WHERE code_hash = $1 AND kind <> 'ticket' AND expires_at > now() \
         RETURNING kind, provider, client_challenge, user_id, subject, email, suggested_username, display_name",
    )
    .bind(hash_token(body.code.trim()))
    .fetch_optional(&state.db)
    .await?;
    let Some((kind, provider_id, challenge, user_id, subject, email, suggested, display_name)) = row else { return Err(invalid()) };
    let computed = URL_SAFE_NO_PAD.encode(Sha256::digest(body.client_verifier.as_bytes()));
    if !totp::ct_eq(computed.as_bytes(), challenge.as_bytes()) {
        return Err(invalid());
    }
    match (kind.as_str(), user_id) {
        ("login", Some(user_id)) => {
            let login = finish_login(&state, user_id, &headers).await?;
            // a provider sign-in counts as a fresh confirmation for this session (accounts without a password)
            if let LoginResponse::Session(session) = &login {
                mark_fresh(&state, &hash_token(&session.token)).await?;
            }
            Ok(Json(OAuthCompleteResponse::Login { login }))
        }
        ("link", Some(user_id)) => complete_link(&state, &headers, user_id, provider_id, subject, email).await.map(Json),
        ("register", None) => {
            if !state.config.registration_open {
                return Err(ApiErr::registration_closed());
            }
            let ticket = new_token();
            sqlx::query(
                "INSERT INTO oauth_results (code_hash, kind, provider, client_challenge, subject, email, suggested_username, display_name, expires_at) \
                 VALUES ($1, 'ticket', $2, '', $3, $4, $5, $6, now() + make_interval(secs => $7))",
            )
            .bind(hash_token(&ticket))
            .bind(&provider_id)
            .bind(&subject)
            .bind(&email)
            .bind(&suggested)
            .bind(&display_name)
            .bind(FLOW_SECONDS)
            .execute(&state.db)
            .await?;
            Ok(Json(OAuthCompleteResponse::Register {
                registration: OAuthRegistration { ticket, provider: provider_id, email, suggested_username: suggested, global_name: display_name },
            }))
        }
        _ => Err(invalid()),
    }
}

async fn mark_fresh(state: &AppState, token_hash: &[u8]) -> ApiResult<()> {
    sqlx::query("UPDATE sessions SET reauth_at = now() WHERE token_hash = $1").bind(token_hash).execute(&state.db).await?;
    Ok(())
}

/// The second half of a link: only the session of the user who started it may finish it. An identity that is already
/// theirs re-confirms the session instead.
async fn complete_link(
    state: &AppState,
    headers: &HeaderMap,
    user_id: i64,
    provider_id: String,
    subject: String,
    email: Option<String>,
) -> ApiResult<OAuthCompleteResponse> {
    let caller = match bearer_header(headers) {
        Some(token) => user_for_token(state, token).await?,
        None => None,
    };
    if caller != Some(user_id) {
        return Err(ApiErr::invalid("code", "This link was started by another account. Start it again while signed in."));
    }
    let token_hash = bearer_header(headers).map(hash_token).ok_or_else(ApiErr::unauthorized)?;
    let name = provider(state, &provider_id).map(|provider| provider.name).unwrap_or_else(|_| provider_id.clone());
    let owner: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM oauth_identities WHERE provider = $1 AND subject = $2")
        .bind(&provider_id)
        .bind(&subject)
        .fetch_optional(&state.db)
        .await?;
    match owner {
        Some((owner,)) if owner == user_id => {
            mark_fresh(state, &token_hash).await?;
            return Ok(OAuthCompleteResponse::Reauthenticated { provider: provider_id });
        }
        Some(_) => return Err(ApiErr::invalid("provider", &format!("This {name} account is already linked to another Vokko account."))),
        None => {}
    }
    // pre-hijack guard: an account whose address is not proven yet cannot collect sign-in methods
    let (verified, has_password, mfa): (bool, bool, bool) =
        sqlx::query_as("SELECT email_verified, password_hash IS NOT NULL, mfa_secret IS NOT NULL FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&state.db)
            .await?;
    if !verified {
        return Err(ApiErr::invalid("email", "Verify your email address before linking another sign-in method."));
    }
    // accounts with a password or two-factor proved it at authorize; the rest need a fresh session for a new identity
    if !has_password && !mfa {
        confirm_identity(state, user_id, headers, None, None, false).await?;
    }
    let linked = sqlx::query("INSERT INTO oauth_identities (provider, subject, user_id, email) VALUES ($1, $2, $3, $4)")
        .bind(&provider_id)
        .bind(&subject)
        .bind(user_id)
        .bind(&email)
        .execute(&state.db)
        .await;
    match linked {
        Ok(_) => Ok(OAuthCompleteResponse::Linked { provider: provider_id }),
        Err(sqlx::Error::Database(database)) if database.is_unique_violation() => {
            Err(ApiErr::invalid("provider", &format!("Another {name} account is already linked. Unlink it first.")))
        }
        Err(error) => Err(error.into()),
    }
}

pub async fn register(State(state): State<AppState>, headers: HeaderMap, ApiJson(body): ApiJson<OAuthRegisterRequest>) -> ApiResult<Json<AuthResponse>> {
    let config = &state.config.accounts;
    if !state.config.registration_open {
        return Err(ApiErr::registration_closed());
    }
    let ticket = hash_token(body.ticket.trim());
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT provider, subject, email FROM oauth_results WHERE code_hash = $1 AND kind = 'ticket' AND expires_at > now()")
            .bind(&ticket)
            .fetch_optional(&state.db)
            .await?;
    let Some((provider_id, subject, provider_email)) = row else { return Err(ApiErr::invalid("ticket", "This sign-up has expired. Start again.")) };
    let username = rules::username(&body.username)?;
    let (email, verified) = match provider_email {
        Some(email) => (email, true),
        None => (rules::email(body.email.as_deref().unwrap_or_default())?, false),
    };
    let global_name = crate::routes::auth::clean_text(body.global_name, 32, "global_name")?;
    let date_of_birth = rules::date_of_birth(body.date_of_birth.as_deref(), config.min_age)?;
    if config.terms().is_some() && body.consent != Some(true) {
        return Err(ApiErr::invalid("consent", "You need to agree to the terms."));
    }
    // the ticket is used up only by a sign-up that goes through
    let mut tx = state.db.begin().await?;
    let used = sqlx::query("DELETE FROM oauth_results WHERE code_hash = $1 AND kind = 'ticket'").bind(&ticket).execute(&mut *tx).await?;
    if used.rows_affected() != 1 {
        return Err(ApiErr::invalid("ticket", "This sign-up has expired. Start again."));
    }
    let id = state.ids.next();
    let inserted = sqlx::query(
        "INSERT INTO users (id, username, email, global_name, password_hash, date_of_birth, email_verified, email_verified_at) \
             VALUES ($1, $2, $3, $4, NULL, $5, $6, CASE WHEN $6 THEN now() END)",
    )
    .bind(id)
    .bind(&username)
    .bind(&email)
    .bind(&global_name)
    .bind(date_of_birth)
    .bind(verified)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        if let sqlx::Error::Database(database) = &error
            && database.is_unique_violation()
        {
            if database.constraint().is_some_and(|name| name.contains("email")) {
                let provider = provider(&state, &provider_id).map(|provider| provider.name).unwrap_or_default();
                return Err(ApiErr::invalid(
                    "email",
                    &format!("An account with this email already exists. Log in to it and link {provider} under My Account > Sign-in Methods."),
                ));
            }
            return Err(ApiErr::invalid("username", "Already taken."));
        }
        return Err(error.into());
    }
    sqlx::query("INSERT INTO oauth_identities (provider, subject, user_id, email) VALUES ($1, $2, $3, $4)")
        .bind(&provider_id)
        .bind(&subject)
        .bind(id)
        .bind(verified.then_some(&email))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO presences (user_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(PresenceStatus::Offline.as_str())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if !verified {
        send_verification(&state, id, &email, None).await?;
    }
    let token = issue_session(&state, id, &headers).await?;
    mark_fresh(&state, &hash_token(&token)).await?;
    let user = store::user(&state, id).await?.ok_or_else(ApiErr::internal)?;
    Ok(Json(AuthResponse { token, user }))
}

// ---- sign-in methods of My Account ----

pub async fn linked(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<LinkedProvider>>> {
    let rows: Vec<(String, Option<String>, time::OffsetDateTime)> =
        sqlx::query_as("SELECT provider, email, created_at FROM oauth_identities WHERE user_id = $1 ORDER BY created_at")
            .bind(user_id)
            .fetch_all(&state.db)
            .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(provider_id, email, linked_at)| LinkedProvider {
                name: provider(&state, &provider_id).map(|provider| provider.name).unwrap_or_else(|_| provider_id.clone()),
                provider: provider_id,
                email,
                linked_at: linked_at.format(&Rfc3339).unwrap_or_default(),
            })
            .collect(),
    ))
}

pub async fn unlink(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(provider_id): Path<String>) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    // lock the user row so two unlinks cannot both pass the "last method" check
    let (has_password,): (bool,) =
        sqlx::query_as("SELECT password_hash IS NOT NULL FROM users WHERE id = $1 FOR UPDATE").bind(user_id).fetch_one(&mut *tx).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities WHERE user_id = $1").bind(user_id).fetch_one(&mut *tx).await?;
    let removed = sqlx::query("DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2").bind(user_id).bind(&provider_id).execute(&mut *tx).await?;
    if removed.rows_affected() == 0 {
        return Err(ApiErr::invalid("provider", "That sign-in method is not linked."));
    }
    if !has_password && count <= 1 {
        return Err(ApiErr::invalid("provider", "This is your only way to sign in. Set a password first."));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
