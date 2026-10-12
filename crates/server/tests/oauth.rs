#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Sign in with OAuth / OIDC against mocked providers: an OpenID Connect issuer (discovery, JWKS, RS256 ID tokens) and a
//! GitHub look-alike, both served on ephemeral loopback ports.
mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use common::TestApp;
use openidconnect::core::{CoreIdToken, CoreIdTokenClaims, CoreJwsSigningAlgorithm, CoreRsaPrivateSigningKey};
use openidconnect::{
    Audience, EmptyAdditionalClaims, EndUserEmail, EndUserUsername, IssuerUrl, JsonWebKeyId, Nonce, PrivateSigningKey, StandardClaims, SubjectIdentifier,
};
use rsa::pkcs1::{EncodeRsaPrivateKey, LineEnding};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vokko_server::account::config::{ProviderConfig, ProviderKind};

const VERIFIER: &str = "client-verifier-kept-by-the-vokko-client-0123456789";

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// What the mock provider will say about the next sign-in, and what it saw.
#[derive(Default)]
struct Script {
    subject: String,
    email: Option<String>,
    username: Option<String>,
    nonce: Option<String>,
    pkce_challenge: Option<String>,
    /// Sign the ID token with a nonce other than the one from the request.
    wrong_nonce: bool,
}

#[derive(Clone)]
struct Mock {
    issuer: String,
    key: Arc<CoreRsaPrivateSigningKey>,
    script: Arc<Mutex<Script>>,
}

fn rsa_key() -> CoreRsaPrivateSigningKey {
    let mut rng = rsa::rand_core::OsRng;
    let key = rsa::RsaPrivateKey::new(&mut rng, 2048).expect("rsa key");
    let pem = key.to_pkcs1_pem(LineEnding::LF).expect("pem");
    CoreRsaPrivateSigningKey::from_pem(&pem, Some(JsonWebKeyId::new("test-key".to_owned()))).expect("signing key")
}

/// `application/x-www-form-urlencoded` body of a token request (the values used here need no decoding beyond `%XX`).
fn parse_form(body: &str) -> std::collections::HashMap<String, String> {
    let decode = |text: &str| {
        let bytes = text.replace('+', " ").into_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).expect("hex"), 16).expect("hex"));
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).expect("utf8")
    };
    body.split('&').filter_map(|pair| pair.split_once('=')).map(|(key, value)| (decode(key), decode(value))).collect()
}

/// Checks the PKCE verifier the server sent against the challenge from the authorize URL.
fn pkce_ok(script: &Script, verifier: Option<&String>) -> bool {
    match (&script.pkce_challenge, verifier) {
        (Some(expected), Some(verifier)) => *expected == challenge(verifier),
        _ => false,
    }
}

async fn start_oidc() -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let issuer = format!("http://{}", listener.local_addr().expect("addr"));
    let mock = Mock { issuer: issuer.clone(), key: Arc::new(rsa_key()), script: Arc::default() };
    let router = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get(|State(mock): State<Mock>| async move {
                axum::Json(json!({
                    "issuer": mock.issuer,
                    "authorization_endpoint": format!("{}/authorize", mock.issuer),
                    "token_endpoint": format!("{}/token", mock.issuer),
                    "jwks_uri": format!("{}/jwks", mock.issuer),
                    "response_types_supported": ["code"],
                    "subject_types_supported": ["public"],
                    "id_token_signing_alg_values_supported": ["RS256"]
                }))
            }),
        )
        .route("/jwks", get(|State(mock): State<Mock>| async move { axum::Json(json!({"keys": [mock.key.as_verification_key()]})) }))
        .route(
            "/token",
            post(|State(mock): State<Mock>, body: String| async move {
                let form = parse_form(&body);
                let script = mock.script.lock().expect("script");
                if form.get("code").map(String::as_str) != Some("good-code") || !pkce_ok(&script, form.get("code_verifier")) {
                    return (StatusCode::BAD_REQUEST, axum::Json(json!({"error": "invalid_grant"})));
                }
                let now = chrono::Utc::now();
                let mut standard = StandardClaims::new(SubjectIdentifier::new(script.subject.clone()));
                if let Some(email) = &script.email {
                    standard = standard.set_email(Some(EndUserEmail::new(email.clone()))).set_email_verified(Some(true));
                }
                if let Some(username) = &script.username {
                    standard = standard.set_preferred_username(Some(EndUserUsername::new(username.clone())));
                }
                let nonce = if script.wrong_nonce { "not-the-nonce".to_owned() } else { script.nonce.clone().unwrap_or_default() };
                let claims = CoreIdTokenClaims::new(
                    IssuerUrl::new(mock.issuer.clone()).expect("issuer"),
                    vec![Audience::new("vokko-client".to_owned())],
                    now + chrono::Duration::minutes(5),
                    now,
                    standard,
                    EmptyAdditionalClaims {},
                )
                .set_nonce(Some(Nonce::new(nonce)));
                let token = CoreIdToken::new(claims, mock.key.as_ref(), CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256, None, None).expect("sign");
                (StatusCode::OK, axum::Json(json!({"access_token": "at", "token_type": "Bearer", "expires_in": 300, "id_token": token})))
            }),
        )
        .with_state(mock.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    mock
}

#[derive(Clone)]
struct Github {
    base: String,
    script: Arc<Mutex<Script>>,
}

async fn start_github() -> Github {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let github = Github { base: base.clone(), script: Arc::default() };
    let router = Router::new()
        .route(
            "/login/oauth/access_token",
            post(|State(github): State<Github>, body: String| async move {
                let form = parse_form(&body);
                let script = github.script.lock().expect("script");
                if form.get("code").map(String::as_str) != Some("gh-code") || !pkce_ok(&script, form.get("code_verifier")) {
                    return (StatusCode::BAD_REQUEST, axum::Json(json!({"error": "bad_verification_code"})));
                }
                (StatusCode::OK, axum::Json(json!({"access_token": "gho_token", "token_type": "bearer", "scope": "read:user,user:email"})))
            }),
        )
        .route(
            "/user",
            get(|State(github): State<Github>, headers: axum::http::HeaderMap| async move {
                assert_eq!(headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer gho_token"));
                let script = github.script.lock().expect("script");
                axum::Json(json!({"id": script.subject.parse::<u64>().expect("numeric id"), "login": script.username, "name": "Octo Cat"}))
            }),
        )
        .route(
            "/user/emails",
            get(|State(github): State<Github>| async move {
                let script = github.script.lock().expect("script");
                axum::Json(json!([{"email": "secondary@example.test", "primary": false, "verified": true}, {"email": script.email, "primary": true, "verified": true}]))
            }),
        )
        .with_state(github.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    github
}

async fn app_with(oidc: &Mock, github: &Github) -> TestApp {
    let (issuer, base) = (oidc.issuer.clone(), github.base.clone());
    TestApp::with_config(move |config| {
        config.accounts.providers = vec![
            ProviderConfig {
                id: "testid".to_owned(),
                name: "Test ID".to_owned(),
                kind: ProviderKind::Oidc { issuer },
                client_id: "vokko-client".to_owned(),
                client_secret: "top-secret".to_owned(),
            },
            ProviderConfig {
                id: "github".to_owned(),
                name: "GitHub".to_owned(),
                kind: ProviderKind::Github {
                    auth_url: format!("{base}/login/oauth/authorize"),
                    token_url: format!("{base}/login/oauth/access_token"),
                    api_url: base.clone(),
                },
                client_id: "gh-client".to_owned(),
                client_secret: "gh-secret".to_owned(),
            },
        ];
    })
    .await
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once(['?', '#'])?.1;
    query.split('&').find_map(|pair| pair.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| value.replace("%2F", "/").replace("%3A", ":")))
}

/// Starts a flow and returns the provider URL; the mock provider remembers the nonce and PKCE challenge it would see.
async fn authorize(app: &TestApp, provider: &str, script: &Arc<Mutex<Script>>, body: Value, token: Option<&str>) -> String {
    let (status, answer) = app.send(Method::POST, &format!("/auth/oauth/{provider}/authorize"), token, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let url = answer["url"].as_str().expect("url").to_owned();
    let mut script = script.lock().expect("script");
    script.nonce = query_param(&url, "nonce");
    script.pkce_challenge = query_param(&url, "code_challenge");
    url
}

/// The provider redirects the browser to the server callback; returns the server's Location.
async fn callback(app: &TestApp, provider: &str, query: &str) -> String {
    let request = Request::builder().uri(format!("/api/v1/auth/oauth/{provider}/callback?{query}")).body(Body::empty()).expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    response.headers().get("location").and_then(|value| value.to_str().ok()).expect("location").to_owned()
}

async fn complete(app: &TestApp, code: &str, verifier: &str) -> (StatusCode, Value) {
    complete_as(app, code, verifier, None).await
}

async fn complete_as(app: &TestApp, code: &str, verifier: &str, token: Option<&str>) -> (StatusCode, Value) {
    app.send(Method::POST, "/auth/oauth/complete", token, Some(json!({"code": code, "client_verifier": verifier}))).await
}

fn web(link: bool) -> Value {
    json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": link})
}

#[tokio::test]
async fn oidc_sign_up_then_sign_in() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (_, providers) = app.send(Method::GET, "/auth/providers", None, None).await;
    assert_eq!(providers, json!([{"id": "testid", "name": "Test ID", "kind": "oidc"}, {"id": "github", "name": "GitHub", "kind": "github"}]));
    *oidc.script.lock().expect("script") =
        Script { subject: "sub-1".to_owned(), email: Some("New.Person@Example.test".to_owned()), username: Some("New-Person".to_owned()), ..Script::default() };

    let url = authorize(&app, "testid", &oidc.script, web(false), None).await;
    assert!(url.starts_with(&format!("{}/authorize?", oidc.issuer)), "{url}");
    assert_eq!(query_param(&url, "client_id").as_deref(), Some("vokko-client"));
    assert_eq!(query_param(&url, "code_challenge_method").as_deref(), Some("S256"));
    assert_eq!(query_param(&url, "redirect_uri").as_deref(), Some("http://test.local/api/v1/auth/oauth/testid/callback"));
    assert!(!url.contains("top-secret"), "the client secret never leaves the server");
    let state = query_param(&url, "state").expect("state");

    // a forged state is refused
    let location = callback(&app, "testid", "code=good-code&state=forged").await;
    assert!(location.starts_with("http://test.local/oauth/callback#error="), "{location}");

    let location = callback(&app, "testid", &format!("code=good-code&state={state}")).await;
    assert!(location.starts_with("http://test.local/oauth/callback#code="), "{location}");
    assert_eq!(query_param(&location, "provider").as_deref(), Some("testid"));
    let code = query_param(&location, "code").expect("code");
    // the state is single use
    assert!(callback(&app, "testid", &format!("code=good-code&state={state}")).await.contains("error="));

    let (status, done) = complete(&app, &code, VERIFIER).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["kind"], "register");
    let registration = &done["registration"];
    assert_eq!(registration["email"], "new.person@example.test");
    assert_eq!(registration["suggested_username"], "new_person");
    assert_eq!(complete(&app, &code, VERIFIER).await.0, StatusCode::BAD_REQUEST, "result codes are single use");

    let ticket = registration["ticket"].as_str().expect("ticket");
    let register = |body: Value| app.send(Method::POST, "/auth/oauth/register", None, Some(body));
    let (status, error) = register(json!({"ticket": ticket, "username": "new_person"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["date_of_birth"].is_object(), "{error}");
    let (status, session) = register(json!({"ticket": ticket, "username": "new_person", "date_of_birth": "1995-05-05"})).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let token = session["token"].as_str().expect("token").to_owned();
    let (_, info) = app.get("/users/@me/account", &token).await;
    assert_eq!(info, json!({"email": "new.person@example.test", "pending_email": null, "verified": true, "has_password": false, "mfa_enabled": false}));
    assert_eq!(register(json!({"ticket": ticket, "username": "again", "date_of_birth": "1995-05-05"})).await.0, StatusCode::BAD_REQUEST);
    let (_, linked) = app.get("/users/@me/oauth", &token).await;
    assert_eq!(linked[0]["provider"], "testid");
    assert_eq!(linked[0]["name"], "Test ID");

    // next time the same identity signs in
    let url = authorize(&app, "testid", &oidc.script, web(false), None).await;
    let location = callback(&app, "testid", &format!("code=good-code&state={}", query_param(&url, "state").expect("state"))).await;
    let code = query_param(&location, "code").expect("code");
    let (status, error) = complete(&app, &code, "some-other-verifier").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a leaked result code is useless without the verifier: {error}");
    let url = authorize(&app, "testid", &oidc.script, web(false), None).await;
    let location = callback(&app, "testid", &format!("code=good-code&state={}", query_param(&url, "state").expect("state"))).await;
    let (status, done) = complete(&app, &query_param(&location, "code").expect("code"), VERIFIER).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["kind"], "login");
    assert_eq!(done["login"]["user"]["username"], "new_person");
    assert!(done["login"]["token"].is_string());
    // a password login is impossible for an account without a password
    let (status, _) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "new_person", "password": "anything at all"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn oidc_rejects_a_bad_nonce_and_never_merges_by_email() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    app.register("existing").await;

    *oidc.script.lock().expect("script") = Script { subject: "sub-x".to_owned(), wrong_nonce: true, ..Script::default() };
    let url = authorize(&app, "testid", &oidc.script, web(false), None).await;
    let location = callback(&app, "testid", &format!("code=good-code&state={}", query_param(&url, "state").expect("state"))).await;
    assert!(location.contains("#error="), "{location}");

    // a provider that reports the email of an existing account does not get into it
    *oidc.script.lock().expect("script") = Script { subject: "sub-y".to_owned(), email: Some("existing@example.test".to_owned()), ..Script::default() };
    let url = authorize(&app, "testid", &oidc.script, web(false), None).await;
    let location = callback(&app, "testid", &format!("code=good-code&state={}", query_param(&url, "state").expect("state"))).await;
    let (_, done) = complete(&app, &query_param(&location, "code").expect("code"), VERIFIER).await;
    assert_eq!(done["kind"], "register");
    let (status, error) = app
        .send(
            Method::POST,
            "/auth/oauth/register",
            None,
            Some(json!({"ticket": done["registration"]["ticket"], "username": "intruder", "date_of_birth": "1990-01-01"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"]["_errors"][0]["message"].as_str().is_some_and(|m| m.contains("link Test ID")), "{error}");

    // bad requests
    let (status, _) = app.send(Method::POST, "/auth/oauth/nope/authorize", None, Some(web(false))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.send(Method::POST, "/auth/oauth/testid/authorize", None, Some(json!({"target": "web", "client_challenge": "short"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(app.send(Method::POST, "/auth/oauth/testid/authorize", None, Some(web(true))).await.0, StatusCode::UNAUTHORIZED, "linking needs a session");
}

#[tokio::test]
async fn github_link_login_and_unlink_rules() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (token, user) = app.register("octo").await;
    app.verify_email("octo@example.test").await;
    *github.script.lock().expect("script") =
        Script { subject: "4242".to_owned(), email: Some("octo@github.example".to_owned()), username: Some("octocat".to_owned()), ..Script::default() };

    // link from My Account, coming back to the desktop app
    let body = json!({"target": "desktop", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"});
    let url = authorize(&app, "github", &github.script, body, Some(&token)).await;
    assert!(url.starts_with(&format!("{}/login/oauth/authorize?", github.base)));
    assert!(query_param(&url, "scope").is_some_and(|scope| scope.contains("user%3Aemail") || scope.contains("user:email")), "{url}");
    let location = callback(&app, "github", &format!("code=gh-code&state={}", query_param(&url, "state").expect("state"))).await;
    assert!(location.starts_with("vokko://auth/callback?code="), "{location}");
    let (status, done) = complete_as(&app, &query_param(&location, "code").expect("code"), VERIFIER, Some(&token)).await;
    assert_eq!((status, done.clone()), (StatusCode::OK, json!({"kind": "linked", "provider": "github"})));
    let (_, linked) = app.get("/users/@me/oauth", &token).await;
    assert_eq!(linked.as_array().expect("linked").len(), 1);
    assert_eq!(linked[0]["email"], "octo@github.example");

    // signing in with GitHub now opens this account
    let url = authorize(&app, "github", &github.script, web(false), None).await;
    let location = callback(&app, "github", &format!("code=gh-code&state={}", query_param(&url, "state").expect("state"))).await;
    let (_, done) = complete(&app, &query_param(&location, "code").expect("code"), VERIFIER).await;
    assert_eq!(done["kind"], "login");
    assert_eq!(done["login"]["user"]["id"], user["id"]);

    // the identity cannot be linked to a second account
    let (other, _) = app.register("other").await;
    let body = json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"});
    let url = authorize(&app, "github", &github.script, body, Some(&other)).await;
    let location = callback(&app, "github", &format!("code=gh-code&state={}", query_param(&url, "state").expect("state"))).await;
    assert!(location.contains("#error=") && location.contains("already%20linked"), "{location}");

    // a password account may unlink; unlinking twice fails
    assert_eq!(app.delete("/users/@me/oauth/github", &token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.delete("/users/@me/oauth/github", &token).await.0, StatusCode::BAD_REQUEST);

    // an OAuth-only account keeps its last sign-in method until it sets a password
    *github.script.lock().expect("script") = Script { subject: "777".to_owned(), email: None, username: Some("no-mail".to_owned()), ..Script::default() };
    let url = authorize(&app, "github", &github.script, web(false), None).await;
    let location = callback(&app, "github", &format!("code=gh-code&state={}", query_param(&url, "state").expect("state"))).await;
    let (_, done) = complete(&app, &query_param(&location, "code").expect("code"), VERIFIER).await;
    let registration = &done["registration"];
    assert_eq!(registration["email"], Value::Null, "GitHub's unverified or missing email is not trusted");
    let ticket = registration["ticket"].as_str().expect("ticket");
    let (status, error) =
        app.send(Method::POST, "/auth/oauth/register", None, Some(json!({"ticket": ticket, "username": "no_mail", "date_of_birth": "1990-01-01"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"].is_object());
    let (status, session) = app
        .send(
            Method::POST,
            "/auth/oauth/register",
            None,
            Some(json!({"ticket": ticket, "username": "no_mail", "date_of_birth": "1990-01-01", "email": "typed@example.test"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let solo = session["token"].as_str().expect("token").to_owned();
    assert_eq!(app.get("/users/@me/account", &solo).await.1["verified"], false);
    app.mailed_token("typed@example.test", "verify");
    let (status, error) = app.delete("/users/@me/oauth/github", &solo).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["provider"]["_errors"][0]["message"].as_str().is_some_and(|m| m.contains("Set a password first")));
    // setting a first password needs no current one
    assert_eq!(app.patch("/users/@me/account", &solo, json!({"new_password": "first ever passphrase"})).await.0, StatusCode::OK);
    assert_eq!(app.delete("/users/@me/oauth/github", &solo).await.0, StatusCode::NO_CONTENT);
}

// ---- security review fixes ----

async fn run_flow(app: &TestApp, github: &Github, body: Value, token: Option<&str>) -> String {
    let url = authorize(app, "github", &github.script, body, token).await;
    let location = callback(app, "github", &format!("code=gh-code&state={}", query_param(&url, "state").expect("state"))).await;
    query_param(&location, "code").unwrap_or_else(|| panic!("no result code: {location}"))
}

#[tokio::test]
async fn a_link_started_by_one_account_cannot_land_on_another() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (attacker, _) = app.register("attacker").await;
    app.verify_email("attacker@example.test").await;
    let (victim, _) = app.register("victim").await;
    *github.script.lock().expect("script") = Script { subject: "9001".to_owned(), username: Some("victim-gh".to_owned()), ..Script::default() };

    // the attacker starts a link and sends the provider URL to the victim, whose browser comes back with the result
    let code = run_flow(
        &app,
        &github,
        json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"}),
        Some(&attacker),
    )
    .await;
    // nothing is linked by the callback alone
    let (linked,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(linked, 0);
    // the victim's session (even with the right verifier) cannot finish it, and neither can an anonymous caller
    let (status, error) = complete_as(&app, &code, VERIFIER, Some(&victim)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    let (linked,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(linked, 0);
    let code = run_flow(
        &app,
        &github,
        json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"}),
        Some(&attacker),
    )
    .await;
    assert_eq!(complete_as(&app, &code, VERIFIER, None).await.0, StatusCode::BAD_REQUEST);
    let (linked,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(linked, 0);
}

#[tokio::test]
async fn unverified_accounts_cannot_link_and_a_reset_drops_their_links() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (token, _) = app.register("fresh").await;
    *github.script.lock().expect("script") = Script { subject: "1111".to_owned(), username: Some("fresh-gh".to_owned()), ..Script::default() };
    let code = run_flow(
        &app,
        &github,
        json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"}),
        Some(&token),
    )
    .await;
    let (status, error) = complete_as(&app, &code, VERIFIER, Some(&token)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"].is_object(), "{error}");

    // pre-hijack: an attacker signs up through GitHub with the victim's (unverified) address
    *github.script.lock().expect("script") = Script { subject: "6666".to_owned(), username: Some("squatter".to_owned()), ..Script::default() };
    let code = run_flow(&app, &github, web(false), None).await;
    let (_, done) = complete(&app, &code, VERIFIER).await;
    let ticket = done["registration"]["ticket"].as_str().expect("ticket").to_owned();
    let (status, _) = app
        .send(
            Method::POST,
            "/auth/oauth/register",
            None,
            Some(json!({"ticket": ticket, "username": "victim_name", "date_of_birth": "1990-01-01", "email": "real.owner@example.test"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // the real owner of the inbox resets the password: the squatter's GitHub link goes
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "real.owner@example.test"}))).await.0, StatusCode::NO_CONTENT);
    let reset = app.mailed_token_soon("real.owner@example.test", "reset").await;
    let (status, session) = app.send(Method::POST, "/auth/reset", None, Some(json!({"token": reset, "password": "the owner is back"}))).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let (_, linked) = app.get("/users/@me/oauth", session["token"].as_str().expect("token")).await;
    assert_eq!(linked, json!([]));
    let code = run_flow(&app, &github, web(false), None).await;
    let (_, done) = complete(&app, &code, VERIFIER).await;
    assert_eq!(done["kind"], "register", "the squatter's GitHub no longer signs in to the account");
}

#[tokio::test]
async fn passwordless_accounts_reconfirm_before_sensitive_changes() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    *github.script.lock().expect("script") =
        Script { subject: "2222".to_owned(), email: Some("solo@example.test".to_owned()), username: Some("solo".to_owned()), ..Script::default() };
    let code = run_flow(&app, &github, web(false), None).await;
    let (_, done) = complete(&app, &code, VERIFIER).await;
    let ticket = done["registration"]["ticket"].as_str().expect("ticket").to_owned();
    let (_, session) =
        app.send(Method::POST, "/auth/oauth/register", None, Some(json!({"ticket": ticket, "username": "solo", "date_of_birth": "1990-01-01"}))).await;
    let token = session["token"].as_str().expect("token").to_owned();
    let stale = || async {
        sqlx::query("UPDATE sessions SET reauth_at = now() - interval '10 minutes'").execute(&app.state.db).await.expect("age the session");
    };

    // right after signing up the session is fresh
    assert_eq!(app.patch("/users/@me/account", &token, json!({"username": "solo2"})).await.0, StatusCode::OK);
    stale().await;
    for (method, path, body) in [
        (Method::PATCH, "/users/@me/account", json!({"email": "new@example.test"})),
        (Method::PATCH, "/users/@me/account", json!({"new_password": "a first passphrase"})),
        (Method::POST, "/users/@me/mfa/totp/enable", json!({"secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "code": "000000"})),
        (Method::POST, "/users/@me/disable", json!({})),
        (Method::POST, "/users/@me/delete", json!({})),
    ] {
        let (status, error) = app.send(method, path, Some(&token), Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        assert!(error["errors"]["reauth"].is_object(), "{path}: {error}");
    }
    // re-confirming through the linked provider makes the session fresh again (nothing new gets linked)
    let code = run_flow(&app, &github, json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true}), Some(&token)).await;
    let (status, done) = complete_as(&app, &code, VERIFIER, Some(&token)).await;
    assert_eq!((status, done.clone()), (StatusCode::OK, json!({"kind": "reauthenticated", "provider": "github"})), "{done}");
    assert_eq!(app.patch("/users/@me/account", &token, json!({"email": "new@example.test"})).await.0, StatusCode::OK);

    // with two-factor on, a code is what confirms it, fresh or not
    let secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    let key = vokko_server::account::totp::base32_decode(secret).expect("secret");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs() / 30;
    let code_at = |offset: u64| format!("{:06}", vokko_server::account::totp::code_at(&key, now + offset));
    let (status, enabled) = app.post("/users/@me/mfa/totp/enable", &token, json!({"secret": secret, "code": code_at(0)})).await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    let backup = enabled["backup_codes"][0]["code"].as_str().expect("code").to_owned();
    stale().await;
    let (status, error) = app.post("/users/@me/mfa/codes-verification", &token, json!({"regenerate": true})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["code"].is_object(), "{error}");
    assert_eq!(app.post("/users/@me/mfa/codes-verification", &token, json!({"regenerate": true, "code": backup})).await.0, StatusCode::OK);
    assert_eq!(app.patch("/users/@me/account", &token, json!({"new_password": "a first passphrase", "code": code_at(1)})).await.0, StatusCode::OK);
}

// ---- security review, round 2 ----

#[tokio::test]
async fn linking_a_new_provider_needs_more_than_a_session_token() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (token, _) = app.register("stolen").await;
    app.verify_email("stolen@example.test").await;
    *github.script.lock().expect("script") = Script { subject: "31337".to_owned(), username: Some("thief-gh".to_owned()), ..Script::default() };
    let start = |extra: Value| {
        let mut body = json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true});
        if let (Some(target), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
            target.extend(extra.clone());
        }
        app.send(Method::POST, "/auth/oauth/github/authorize", Some(&token), Some(body))
    };
    // a token alone (or with a wrong password) does not even start a link
    let (status, error) = start(json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["password"].is_object(), "{error}");
    assert_eq!(start(json!({"password": "guessing wrong"})).await.0, StatusCode::BAD_REQUEST);
    let (linked,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(linked, 0);
    // with the password it works
    let code = run_flow(
        &app,
        &github,
        json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"}),
        Some(&token),
    )
    .await;
    assert_eq!(complete_as(&app, &code, VERIFIER, Some(&token)).await.1["kind"], "linked");

    // an OAuth-only account without two-factor needs a fresh session to add a second provider
    *oidc.script.lock().expect("script") = Script { subject: "only-oidc".to_owned(), email: Some("only@example.test".to_owned()), ..Script::default() };
    let url = authorize(&app, "testid", &oidc.script, web(false), None).await;
    let location = callback(&app, "testid", &format!("code=good-code&state={}", query_param(&url, "state").expect("state"))).await;
    let (_, done) = complete(&app, &query_param(&location, "code").expect("code"), VERIFIER).await;
    let (_, session) = app
        .send(
            Method::POST,
            "/auth/oauth/register",
            None,
            Some(json!({"ticket": done["registration"]["ticket"], "username": "only_oidc", "date_of_birth": "1990-01-01"})),
        )
        .await;
    let solo = session["token"].as_str().expect("token").to_owned();
    sqlx::query("UPDATE sessions SET reauth_at = now() - interval '10 minutes'").execute(&app.state.db).await.expect("age");
    *github.script.lock().expect("script") = Script { subject: "4040".to_owned(), username: Some("second-gh".to_owned()), ..Script::default() };
    let code = run_flow(&app, &github, json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true}), Some(&solo)).await;
    let (status, error) = complete_as(&app, &code, VERIFIER, Some(&solo)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["reauth"].is_object(), "{error}");
    let (_, linked) = app.get("/users/@me/oauth", &solo).await;
    assert_eq!(linked.as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn a_reset_drops_links_made_before_the_address_was_proven() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    // the squatter signs up through GitHub with the victim's address, and the victim clicks the verification mail
    *github.script.lock().expect("script") = Script { subject: "7777".to_owned(), username: Some("squat".to_owned()), ..Script::default() };
    let code = run_flow(&app, &github, web(false), None).await;
    let (_, done) = complete(&app, &code, VERIFIER).await;
    let (status, _) = app
        .send(
            Method::POST,
            "/auth/oauth/register",
            None,
            Some(json!({"ticket": done["registration"]["ticket"], "username": "taken_name", "date_of_birth": "1990-01-01", "email": "owner@example.test"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    app.verify_email("owner@example.test").await;
    // an OAuth-only account keeps its link on verification (it is its only way in) ...
    let (links,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(links, 1);
    // ... but the owner's reset drops every link older than the proof of the address
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "owner@example.test"}))).await.0, StatusCode::NO_CONTENT);
    let reset = app.mailed_token_soon("owner@example.test", "reset").await;
    let (status, _) = app.send(Method::POST, "/auth/reset", None, Some(json!({"token": reset, "password": "mine again now"}))).await;
    assert_eq!(status, StatusCode::OK);
    let (links,): (i64,) = sqlx::query_as("SELECT count(*) FROM oauth_identities").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(links, 0);
    let code = run_flow(&app, &github, web(false), None).await;
    assert_eq!(complete(&app, &code, VERIFIER).await.1["kind"], "register", "the squatter's GitHub is out");
}

// ---- security review, round 3 ----

#[tokio::test]
async fn changing_the_email_keeps_linked_providers() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (token, _) = app.register("keeper").await;
    app.verify_email("keeper@example.test").await;
    *github.script.lock().expect("script") = Script { subject: "5150".to_owned(), username: Some("keeper-gh".to_owned()), ..Script::default() };
    let code = run_flow(
        &app,
        &github,
        json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"}),
        Some(&token),
    )
    .await;
    assert_eq!(complete_as(&app, &code, VERIFIER, Some(&token)).await.1["kind"], "linked");
    assert_eq!(app.patch("/users/@me/account", &token, json!({"email": "keeper2@example.test", "password": "correct horse battery"})).await.0, StatusCode::OK);
    app.verify_email("keeper2@example.test").await;
    let (_, linked) = app.get("/users/@me/oauth", &token).await;
    assert_eq!(linked.as_array().map(Vec::len), Some(1), "{linked}");
    assert_eq!(app.get("/users/@me/account", &token).await.1["email"], "keeper2@example.test");
}

// ---- follow-ups after the merge of #10 ----

#[tokio::test]
async fn a_reset_keeps_providers_linked_after_the_address_was_proven() {
    let oidc = start_oidc().await;
    let github = start_github().await;
    let app = app_with(&oidc, &github).await;
    let (token, _) = app.register("resetter").await;
    app.verify_email("resetter@example.test").await;
    *github.script.lock().expect("script") = Script { subject: "4242".to_owned(), username: Some("resetter-gh".to_owned()), ..Script::default() };
    let code = run_flow(
        &app,
        &github,
        json!({"target": "web", "client_challenge": challenge(VERIFIER), "link": true, "password": "correct horse battery"}),
        Some(&token),
    )
    .await;
    assert_eq!(complete_as(&app, &code, VERIFIER, Some(&token)).await.1["kind"], "linked");
    // a reset changes the password only: like Discord, sign-in methods linked after the email was verified stay
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "resetter"}))).await.0, StatusCode::NO_CONTENT);
    let reset = app.mailed_token_soon("resetter@example.test", "reset").await;
    let (status, session) = app.send(Method::POST, "/auth/reset", None, Some(json!({"token": reset, "password": "a brand new passphrase"}))).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let (_, linked) = app.get("/users/@me/oauth", session["token"].as_str().expect("token")).await;
    assert_eq!(linked.as_array().map(Vec::len), Some(1), "{linked}");
    let code = run_flow(&app, &github, web(false), None).await;
    assert_eq!(complete(&app, &code, VERIFIER).await.1["kind"], "login", "GitHub still signs in");
}
