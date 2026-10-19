#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::{Method, StatusCode};
use common::TestApp;
use serde_json::{Value, json};

fn signup(username: &str) -> Value {
    json!({"email": format!("{username}@example.test"), "username": username, "password": "correct horse battery", "date_of_birth": "1990-01-01"})
}

async fn register_with(app: &TestApp, body: Value) -> (StatusCode, Value) {
    app.send(Method::POST, "/auth/register", None, Some(body)).await
}

#[tokio::test]
async fn registration_rules() {
    let app = TestApp::new().await;
    let (status, info) = app.send(Method::GET, "/auth/instance", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info, json!({"registration": "open", "min_age": 13, "terms": null, "terms_url": null, "email_verification": true}));

    let mut body = signup("kid");
    body["date_of_birth"] = json!(format!("{}-01-01", time::OffsetDateTime::now_utc().year() - 10));
    let (status, error) = register_with(&app, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["date_of_birth"]["_errors"][0]["message"], "You need to be 13 or older to use Vokko.");

    for (field, value, expected) in [
        ("date_of_birth", Value::Null, "date_of_birth"),
        ("date_of_birth", json!("2001-02-29"), "date_of_birth"),
        ("username", json!("two..dots"), "username"),
        ("username", json!("x"), "username"),
        ("password", json!("password123"), "password"),
        ("password", json!("tester-tester"), "password"), // contains the username
        ("email", json!("not-an-email"), "email"),
    ] {
        let mut body = signup("tester");
        body[field] = value.clone();
        let (status, error) = register_with(&app, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field} = {value}");
        assert_eq!(error["code"], 50035);
        assert!(error["errors"][expected].is_object(), "{field} = {value}: {error}");
    }

    // trimmed and lowercased, date of birth stored
    let (status, created) = register_with(
        &app,
        json!({"email": " Mixed@Example.TEST ", "username": " MiXeD ", "password": "correct horse battery", "date_of_birth": "2000-02-29"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["user"]["username"], "mixed");
    let (dob, email): (Option<time::Date>, String) =
        sqlx::query_as("SELECT date_of_birth, email FROM users WHERE username = 'mixed'").fetch_one(&app.state.db).await.expect("row");
    assert_eq!(dob.map(|date| date.to_string()).as_deref(), Some("2000-02-29"));
    assert_eq!(email, "mixed@example.test");

    let (status, error) =
        register_with(&app, json!({"email": "other@example.test", "username": "mixed", "password": "correct horse battery", "date_of_birth": "1990-01-01"}))
            .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["username"]["_errors"][0]["message"], "Already taken.");
    let (status, error) =
        register_with(&app, json!({"email": "mixed@example.test", "username": "fresh", "password": "correct horse battery", "date_of_birth": "1990-01-01"}))
            .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"].is_object());
}

#[tokio::test]
async fn username_attempt_reports_availability() {
    let app = TestApp::new().await;
    app.register("taken.name").await;
    let attempt = |name: &str| app.send(Method::POST, "/auth/username-attempt", None, Some(json!({"username": name})));
    assert_eq!(attempt("taken.name").await, (StatusCode::OK, json!({"taken": true})));
    assert_eq!(attempt(" Taken.Name ").await, (StatusCode::OK, json!({"taken": true})));
    assert_eq!(attempt("free_name").await, (StatusCode::OK, json!({"taken": false})));
    let (status, error) = attempt("bad..name").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["username"]["_errors"][0]["message"], "Can't contain two dots in a row.");
}

#[tokio::test]
async fn closed_registration_minimum_age_and_terms_come_from_config() {
    let app = TestApp::with_config(|config| {
        config.registration_open = false;
        config.accounts.min_age = 18;
        config.accounts.terms_url = Some("https://example.test/terms".to_owned());
    })
    .await;
    let (_, info) = app.send(Method::GET, "/auth/instance", None, None).await;
    assert_eq!(info["registration"], "closed");
    assert_eq!(info["min_age"], 18);
    assert_eq!(info["terms_url"], "https://example.test/terms");
    assert!(info["terms"].is_string());
    let (status, error) = register_with(&app, signup("late")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 40002);

    let app = TestApp::with_config(|config| {
        config.accounts.min_age = 18;
        config.accounts.terms_text = Some("I accept the house rules.".to_owned());
    })
    .await;
    let mut body = signup("teen");
    body["date_of_birth"] = json!(format!("{}-01-01", time::OffsetDateTime::now_utc().year() - 16));
    body["consent"] = json!(true);
    let (status, error) = register_with(&app, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["date_of_birth"]["_errors"][0]["message"], "You need to be 18 or older to use Vokko.");
    let (status, error) = register_with(&app, signup("adult")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["consent"].is_object());
    let mut body = signup("adult");
    body["consent"] = json!(true);
    assert_eq!(register_with(&app, body).await.0, StatusCode::OK);
}

#[tokio::test]
async fn registration_mails_a_single_use_verification_link() {
    let app = TestApp::new().await;
    let (token, _) = app.register("verifyme").await;
    let verified = || async {
        let (verified,): (bool,) = sqlx::query_as("SELECT email_verified FROM users WHERE username = 'verifyme'").fetch_one(&app.state.db).await.expect("row");
        verified
    };
    assert!(!verified().await);
    let first = app.mailed_token("verifyme@example.test", "verify");
    assert_eq!(first.len(), 64);

    // one mail a minute per account
    let (status, error) = app.post("/auth/verify/resend", &token, json!({})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(error["retry_after"].as_f64().is_some_and(|wait| wait > 0.0 && wait <= 60.0));
    sqlx::query("UPDATE email_tokens SET expires_at = expires_at - interval '61 seconds'").execute(&app.state.db).await.expect("age link");

    // a resend replaces the earlier link
    assert_eq!(app.post("/auth/verify/resend", &token, json!({})).await.0, StatusCode::NO_CONTENT);
    let second = app.mailed_token("verifyme@example.test", "verify");
    assert_ne!(first, second);
    let (status, error) = app.send(Method::POST, "/auth/verify", None, Some(json!({"token": first}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["token"].is_object());

    assert_eq!(app.send(Method::POST, "/auth/verify", None, Some(json!({"token": second}))).await.0, StatusCode::NO_CONTENT);
    assert!(verified().await);
    // single use
    assert_eq!(app.send(Method::POST, "/auth/verify", None, Some(json!({"token": second}))).await.0, StatusCode::BAD_REQUEST);
    let (status, error) = app.post("/auth/verify/resend", &token, json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"].is_object());
    // tokens are stored hashed
    let (stored,): (i64,) = sqlx::query_as("SELECT count(*) FROM email_tokens").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(stored, 0);
}

async fn login(app: &TestApp, login: &str, password: &str) -> (StatusCode, Value) {
    app.send(Method::POST, "/auth/login", None, Some(json!({"login": login, "password": password}))).await
}

#[tokio::test]
async fn account_info_and_username_change() {
    let app = TestApp::new().await;
    let (token, user) = app.register("rename").await;
    app.register("occupied").await;
    let (status, info) = app.get("/users/@me/account", &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info, json!({"email": "rename@example.test", "pending_email": null, "verified": false, "has_password": true, "mfa_enabled": false}));

    // the current password is required
    let (status, error) = app.patch("/users/@me/account", &token, json!({"username": "renamed"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["password"]["_errors"][0]["message"], "Password does not match.");
    let (status, error) = app.patch("/users/@me/account", &token, json!({"username": "renamed", "password": "wrong password"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["password"].is_object());
    let (status, error) = app.patch("/users/@me/account", &token, json!({"username": "occupied", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["username"]["_errors"][0]["message"], "Already taken.");
    let (status, error) = app.patch("/users/@me/account", &token, json!({"username": "a..b", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["username"].is_object());

    let (status, done) = app.patch("/users/@me/account", &token, json!({"username": " Renamed ", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["user"]["username"], "renamed");
    assert_eq!(done["user"]["id"], user["id"]);
    assert_eq!(app.get("/users/@me", &token).await.1["username"], "renamed");
    assert_eq!(login(&app, "renamed", "correct horse battery").await.0, StatusCode::OK);
    assert_eq!(login(&app, "rename", "correct horse battery").await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn wrong_current_passwords_are_counted_per_account() {
    let app = TestApp::new().await;
    let (token, _) = app.register("guesser").await;
    let wrong = json!({"username": "guessed2", "password": "wrong password"});
    for _ in 0..9 {
        assert_eq!(app.patch("/users/@me/account", &token, wrong.clone()).await.0, StatusCode::BAD_REQUEST);
    }
    // a right password does not count, and the wrong ones so far still do
    let (status, done) = app.patch("/users/@me/account", &token, json!({"username": "guessed", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(app.patch("/users/@me/account", &token, wrong.clone()).await.0, StatusCode::BAD_REQUEST);
    // the 11th wrong one is refused, whichever route it comes through, and so is the right password until the window passes
    assert_eq!(app.patch("/users/@me/account", &token, wrong.clone()).await.0, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = app.send(Method::POST, "/users/@me/disable", Some(&token), Some(json!({"password": "wrong password"}))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = app.patch("/users/@me/account", &token, json!({"username": "guessed2", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn email_change_waits_for_the_new_address_to_be_verified() {
    let app = TestApp::new().await;
    let (token, _) = app.register("mover").await;
    app.register("other").await;
    let (status, error) = app.patch("/users/@me/account", &token, json!({"email": "other@example.test", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"].is_object());

    let (status, done) = app.patch("/users/@me/account", &token, json!({"email": "New@Example.test", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["account"]["email"], "mover@example.test");
    assert_eq!(done["account"]["pending_email"], "new@example.test");
    // the old address hears about it, the new one gets the link
    assert!(app.state.accounts.mailer.sent().iter().any(|mail| mail.to == "mover@example.test" && mail.subject.contains("changing")));
    let link = app.mailed_token("new@example.test", "verify");
    // until then the old email still signs in
    assert_eq!(login(&app, "mover@example.test", "correct horse battery").await.0, StatusCode::OK);
    assert_eq!(login(&app, "new@example.test", "correct horse battery").await.0, StatusCode::BAD_REQUEST);

    assert_eq!(app.send(Method::POST, "/auth/verify", None, Some(json!({"token": link}))).await.0, StatusCode::NO_CONTENT);
    let (_, info) = app.get("/users/@me/account", &token).await;
    assert_eq!(info, json!({"email": "new@example.test", "pending_email": null, "verified": true, "has_password": true, "mfa_enabled": false}));
    assert_eq!(login(&app, "new@example.test", "correct horse battery").await.0, StatusCode::OK);
    assert_eq!(login(&app, "mover@example.test", "correct horse battery").await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn password_change_revokes_the_other_sessions() {
    let app = TestApp::new().await;
    let (token, _) = app.register("rotate").await;
    let (_, other) = login(&app, "rotate", "correct horse battery").await;
    let other = other["token"].as_str().expect("token").to_owned();

    let (status, error) = app.patch("/users/@me/account", &token, json!({"new_password": "password123", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["new_password"].is_object());
    let (status, _) = app.patch("/users/@me/account", &token, json!({"new_password": "another fine passphrase", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(app.get("/users/@me", &token).await.0, StatusCode::OK, "the calling session stays");
    assert_eq!(app.get("/users/@me", &other).await.0, StatusCode::UNAUTHORIZED, "other sessions are revoked");
    assert_eq!(login(&app, "rotate", "correct horse battery").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(login(&app, "rotate", "another fine passphrase").await.0, StatusCode::OK);
}

#[tokio::test]
async fn disable_signs_out_until_the_next_login() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sleepy").await;
    assert_eq!(app.post("/users/@me/disable", &token, json!({"password": "nope nope nope"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.post("/users/@me/disable", &token, json!({"password": "correct horse battery"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me", &token).await.0, StatusCode::UNAUTHORIZED);
    let (disabled,): (bool,) =
        sqlx::query_as("SELECT disabled_at IS NOT NULL FROM users WHERE username = 'sleepy'").fetch_one(&app.state.db).await.expect("row");
    assert!(disabled);
    let (status, _) = login(&app, "sleepy", "correct horse battery").await;
    assert_eq!(status, StatusCode::OK);
    let (disabled,): (bool,) =
        sqlx::query_as("SELECT disabled_at IS NOT NULL FROM users WHERE username = 'sleepy'").fetch_one(&app.state.db).await.expect("row");
    assert!(!disabled);
}

#[tokio::test]
async fn delete_anonymises_and_keeps_messages() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (leaver, leaver_user) = app.register("leaver").await;
    let leaver_id = leaver_user["id"].as_str().expect("id").to_owned();
    let (guild_id, channel_id) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{channel_id}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code");
    assert_eq!(app.post(&format!("/invites/{code}"), &leaver, json!({})).await.0, StatusCode::OK);
    let (status, message) = app.post(&format!("/channels/{channel_id}/messages"), &leaver, json!({"content": "bye all"})).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    assert_eq!(app.put_json(&format!("/users/@me/relationships/{leaver_id}"), &owner, json!({})).await.0, StatusCode::NO_CONTENT);

    // owners must hand over their guilds first
    let (status, error) = app.post("/users/@me/delete", &owner, json!({"password": "correct horse battery"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(40011)));
    assert_eq!(app.post("/users/@me/delete", &leaver, json!({"password": "wrong"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.post("/users/@me/delete", &leaver, json!({"password": "correct horse battery"})).await.0, StatusCode::NO_CONTENT);

    assert_eq!(app.get("/users/@me", &leaver).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&app, "leaver", "correct horse battery").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(login(&app, "leaver@example.test", "correct horse battery").await.0, StatusCode::BAD_REQUEST);
    let (_, ghost) = app.get(&format!("/users/{leaver_id}"), &owner).await;
    assert_eq!(ghost["global_name"], "Deleted User");
    assert!(ghost["username"].as_str().is_some_and(|name| name.starts_with("deleted_user_")));
    assert!(ghost["avatar"].is_null());
    // the message stays, authored by the anonymised user; the member and the relationship are gone
    let (_, messages) = app.get(&format!("/channels/{channel_id}/messages"), &owner).await;
    let kept = messages.as_array().expect("messages").iter().find(|m| m["content"] == "bye all").expect("message kept");
    assert_eq!(kept["author"]["global_name"], "Deleted User");
    let (_, members) = app.get(&format!("/guilds/{guild_id}/members"), &owner).await;
    assert!(!members.as_array().expect("members").iter().any(|m| m["user"]["id"] == json!(leaver_id)));
    let (_, relationships) = app.get("/users/@me/relationships", &owner).await;
    assert_eq!(relationships, json!([]));
    // the name and the email are free again
    let (status, _) = register_with(&app, signup("leaver")).await;
    assert_eq!(status, StatusCode::OK);
}

const SECRET: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/// The TOTP code of `SECRET` `offset` steps from now.
fn totp(offset: i64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs() / 30;
    let key = vokko_server::account::totp::base32_decode(SECRET).expect("secret");
    format!("{:06}", vokko_server::account::totp::code_at(&key, (now as i64 + offset) as u64))
}

#[tokio::test]
async fn totp_two_factor_login_and_backup_codes() {
    let app = TestApp::new().await;
    let (token, _) = app.register("guarded").await;
    app.verify_email("guarded@example.test").await;
    let enable = |body: Value| app.post("/users/@me/mfa/totp/enable", &token, body);
    let (status, error) = enable(json!({"password": "correct horse battery", "secret": SECRET, "code": "000000"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errors"]["code"]["_errors"][0]["message"], "Invalid two-factor code");
    assert_eq!(enable(json!({"password": "correct horse battery", "secret": "SHORT", "code": totp(0)})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(enable(json!({"password": "wrong", "secret": SECRET, "code": totp(0)})).await.0, StatusCode::BAD_REQUEST);
    let enable_code = totp(0);
    let (status, enabled) = enable(json!({"password": "correct horse battery", "secret": SECRET, "code": enable_code})).await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    let codes: Vec<String> = enabled["backup_codes"].as_array().expect("codes").iter().map(|c| c["code"].as_str().expect("code").to_owned()).collect();
    assert_eq!(codes.len(), 10);
    assert!(codes.iter().all(|code| code.len() == 8 && code.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())));
    assert_eq!(app.get("/users/@me/account", &token).await.1["mfa_enabled"], true);
    // only hashes are stored
    let (plain,): (i64,) = sqlx::query_as("SELECT count(*) FROM mfa_backup_codes WHERE code_hash = convert_to($1, 'UTF8')")
        .bind(&codes[0])
        .fetch_one(&app.state.db)
        .await
        .expect("count");
    assert_eq!(plain, 0);

    // login now stops at the ticket
    let (status, step) = login(&app, "guarded", "correct horse battery").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(step["token"], Value::Null);
    assert_eq!(step["mfa"], true);
    let ticket = step["ticket"].as_str().expect("ticket").to_owned();
    let mfa = |ticket: String, code: String| app.send(Method::POST, "/auth/mfa/totp", None, Some(json!({"ticket": ticket, "code": code})));
    // the code used to enable it cannot be replayed
    let (status, error) = mfa(ticket.clone(), enable_code.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["code"].is_object());
    let (status, session) = mfa(ticket.clone(), totp(1)).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(session["user"]["username"], "guarded");
    let second = session["token"].as_str().expect("token").to_owned();
    assert_eq!(app.get("/users/@me", &second).await.0, StatusCode::OK);
    assert_eq!(mfa(ticket, totp(1)).await.0, StatusCode::BAD_REQUEST, "tickets are single use");

    // a backup code works once
    let (_, step) = login(&app, "guarded", "correct horse battery").await;
    let ticket = step["ticket"].as_str().expect("ticket").to_owned();
    assert_eq!(mfa(ticket.clone(), codes[0].to_uppercase()).await.0, StatusCode::OK);
    let (_, step) = login(&app, "guarded", "correct horse battery").await;
    let ticket = step["ticket"].as_str().expect("ticket").to_owned();
    assert_eq!(mfa(ticket.clone(), codes[0].clone()).await.0, StatusCode::BAD_REQUEST);
    // five wrong codes burn the ticket
    for _ in 0..4 {
        assert_eq!(mfa(ticket.clone(), "nope-nope".to_owned()).await.0, StatusCode::BAD_REQUEST);
    }
    let (_, error) = mfa(ticket, codes[1].clone()).await;
    assert!(error["errors"]["ticket"].is_object(), "{error}");

    // viewing shows only the used state; regenerating replaces them
    let (status, view) = app.post("/users/@me/mfa/codes-verification", &token, json!({"password": "correct horse battery", "regenerate": false})).await;
    assert_eq!(status, StatusCode::OK);
    let view = view["backup_codes"].as_array().expect("codes").clone();
    assert_eq!(view.len(), 10);
    assert_eq!(view[0], json!({"code": null, "consumed": true}));
    assert_eq!(view[1]["consumed"], false);
    let (_, fresh) = app.post("/users/@me/mfa/codes-verification", &token, json!({"password": "correct horse battery", "regenerate": true})).await;
    let fresh: Vec<String> = fresh["backup_codes"].as_array().expect("codes").iter().map(|c| c["code"].as_str().expect("code").to_owned()).collect();
    assert!(!fresh.contains(&codes[1]));

    // disabling the account needs the second factor too
    let (status, error) = app.post("/users/@me/disable", &token, json!({"password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["code"].is_object());

    // turning it off needs a code; afterwards login is one step again
    assert_eq!(app.post("/users/@me/mfa/totp/disable", &token, json!({"code": codes[2]})).await.0, StatusCode::BAD_REQUEST, "old codes are gone");
    assert_eq!(app.post("/users/@me/mfa/totp/disable", &token, json!({"code": fresh[0]})).await.0, StatusCode::NO_CONTENT);
    let (_, step) = login(&app, "guarded", "correct horse battery").await;
    assert!(step["token"].is_string());
    let (left,): (i64,) = sqlx::query_as("SELECT count(*) FROM mfa_backup_codes").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(left, 0);
}

async fn login_with_agent(app: &TestApp, agent: &str) -> String {
    use tower::ServiceExt;
    let body = json!({"login": "devices", "password": "correct horse battery"});
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/api/v1/auth/login")
        .header("content-type", "application/json")
        .header("user-agent", agent)
        .body(axum::body::Body::from(body.to_string()))
        .expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice::<Value>(&bytes).expect("json")["token"].as_str().expect("token").to_owned()
}

#[tokio::test]
async fn sessions_list_and_log_out_others() {
    let app = TestApp::new().await;
    let (first, _) = app.register("devices").await;
    let chrome = login_with_agent(&app, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36").await;
    let desktop = login_with_agent(&app, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Tauri/2.0").await;

    let (status, list) = app.get("/auth/sessions", &chrome).await;
    assert_eq!(status, StatusCode::OK);
    let sessions = list["user_sessions"].as_array().expect("sessions").clone();
    assert_eq!(sessions.len(), 3);
    let current: Vec<&Value> = sessions.iter().filter(|s| s["current"] == true).collect();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0]["client_info"], json!({"os": "Windows", "platform": "Chrome"}));
    assert!(sessions.iter().any(|s| s["client_info"] == json!({"os": "macOS", "platform": "Vokko Desktop"})));
    assert!(sessions.iter().all(|s| s["approx_last_used_time"].as_str().is_some_and(|t| t.contains('T')) && s["client_info"].get("location").is_none()));
    // the ids reveal nothing about the tokens
    assert!(sessions.iter().all(|s| s["id_hash"].as_str().is_some_and(|id| id.len() == 32 && !chrome.contains(id) && !desktop.contains(id))));

    // "log out all other sessions"
    let others: Vec<Value> = sessions.iter().filter(|s| s["current"] == false).map(|s| s["id_hash"].clone()).collect();
    assert_eq!(app.post("/auth/sessions/logout", &chrome, json!({"session_id_hashes": others})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me", &chrome).await.0, StatusCode::OK);
    assert_eq!(app.get("/users/@me", &desktop).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/users/@me", &first).await.0, StatusCode::UNAUTHORIZED);
    // someone else's id hashes do nothing
    let (stranger, _) = app.register("stranger").await;
    let (_, list) = app.get("/auth/sessions", &chrome).await;
    let mine = list["user_sessions"][0]["id_hash"].clone();
    assert_eq!(app.post("/auth/sessions/logout", &stranger, json!({"session_id_hashes": [mine]})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me", &chrome).await.0, StatusCode::OK);
}

#[tokio::test]
async fn password_reset_by_email_link() {
    let app = TestApp::new().await;
    let (token, _) = app.register("forgetful").await;
    // unknown accounts look the same
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "nobody"}))).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "Forgetful"}))).await.0, StatusCode::NO_CONTENT);
    let link = app.mailed_token_soon("forgetful@example.test", "reset").await;
    let reset = |token: &str, password: &str| app.send(Method::POST, "/auth/reset", None, Some(json!({"token": token, "password": password})));
    // a weak password does not use up the link
    let (status, error) = reset(&link, "password123").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["password"].is_object());
    let (status, session) = reset(&link, "brand new passphrase").await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert!(session["token"].is_string());
    assert_eq!(app.get("/users/@me", &token).await.0, StatusCode::UNAUTHORIZED, "old sessions are revoked");
    assert_eq!(reset(&link, "another new passphrase").await.0, StatusCode::BAD_REQUEST, "single use");
    assert_eq!(login(&app, "forgetful", "brand new passphrase").await.0, StatusCode::OK);
    assert_eq!(app.get("/users/@me/account", session["token"].as_str().expect("token")).await.1["verified"], true);
}

#[tokio::test]
async fn password_rotation_cancels_an_earlier_email_change() {
    let app = TestApp::new().await;
    let (token, _) = app.register("victim").await;
    let (status, _) = app.patch("/users/@me/account", &token, json!({"email": "attacker@example.test", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::OK);
    let link = app.mailed_token("attacker@example.test", "verify");
    // the owner follows the notice and changes the password
    let (status, done) = app.patch("/users/@me/account", &token, json!({"new_password": "a brand new passphrase", "password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["account"]["pending_email"], Value::Null);
    assert_eq!(app.send(Method::POST, "/auth/verify", None, Some(json!({"token": link}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.get("/users/@me/account", &token).await.1["email"], "victim@example.test");

    // an email change made together with the password change survives it
    let (status, _) = app
        .patch(
            "/users/@me/account",
            &token,
            json!({"email": "mine@example.test", "new_password": "yet another passphrase", "password": "a brand new passphrase"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let link = app.mailed_token("mine@example.test", "verify");
    assert_eq!(app.send(Method::POST, "/auth/verify", None, Some(json!({"token": link}))).await.0, StatusCode::NO_CONTENT);
}

// ---- security review fixes ----

#[tokio::test]
async fn password_reset_cancels_a_pending_email_change() {
    let app = TestApp::new().await;
    let (token, _) = app.register("resetter").await;
    assert_eq!(app.patch("/users/@me/account", &token, json!({"email": "thief@example.test", "password": "correct horse battery"})).await.0, StatusCode::OK);
    let stolen = app.mailed_token("thief@example.test", "verify");
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "resetter"}))).await.0, StatusCode::NO_CONTENT);
    let reset = app.mailed_token_soon("resetter@example.test", "reset").await;
    let (status, session) = app.send(Method::POST, "/auth/reset", None, Some(json!({"token": reset, "password": "taking it back now"}))).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let fresh = session["token"].as_str().expect("token");
    assert_eq!(app.get("/users/@me/account", fresh).await.1["pending_email"], Value::Null);
    assert_eq!(app.send(Method::POST, "/auth/verify", None, Some(json!({"token": stolen}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.get("/users/@me/account", fresh).await.1["email"], "resetter@example.test");
}

#[tokio::test]
async fn two_factor_needs_a_verified_email() {
    let app = TestApp::new().await;
    let (token, _) = app.register("unproven").await;
    let enable = json!({"password": "correct horse battery", "secret": SECRET, "code": totp(0)});
    let (status, error) = app.post("/users/@me/mfa/totp/enable", &token, enable.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["email"].is_object(), "{error}");
    app.verify_email("unproven@example.test").await;
    assert_eq!(app.post("/users/@me/mfa/totp/enable", &token, enable).await.0, StatusCode::OK);
}

#[tokio::test]
async fn wrong_codes_are_limited_per_account_across_tickets() {
    let app = TestApp::new().await;
    let (token, _) = app.register("hammered").await;
    app.verify_email("hammered@example.test").await;
    let (status, enabled) =
        app.post("/users/@me/mfa/totp/enable", &token, json!({"password": "correct horse battery", "secret": SECRET, "code": totp(0)})).await;
    assert_eq!(status, StatusCode::OK);
    let backup = enabled["backup_codes"][0]["code"].as_str().expect("code").to_owned();
    // 4 wrong codes per ticket, over three tickets, plus wrong codes on the disable routes: they all add up
    let mut failures = 0;
    while failures < 10 {
        let (_, step) = login(&app, "hammered", "correct horse battery").await;
        let ticket = step["ticket"].as_str().expect("ticket").to_owned();
        for _ in 0..4 {
            if failures == 10 {
                break;
            }
            let (status, _) = app.send(Method::POST, "/auth/mfa/totp", None, Some(json!({"ticket": ticket, "code": "zzzzzzzz"}))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            failures += 1;
        }
    }
    // now even a right code is refused for a while, on every route that checks codes
    let (_, step) = login(&app, "hammered", "correct horse battery").await;
    let (status, error) = app.send(Method::POST, "/auth/mfa/totp", None, Some(json!({"ticket": step["ticket"], "code": backup}))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{error}");
    assert_eq!(app.post("/users/@me/mfa/totp/disable", &token, json!({"code": backup})).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(app.post("/users/@me/delete", &token, json!({"password": "correct horse battery", "code": backup})).await.0, StatusCode::TOO_MANY_REQUESTS);
    // the backup code was never spent by the refused attempts
    sqlx::query("DELETE FROM mfa_failures").execute(&app.state.db).await.expect("reset window");
    assert_eq!(app.post("/users/@me/mfa/totp/disable", &token, json!({"code": backup})).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn delete_purges_pending_tickets_in_one_go() {
    let app = TestApp::new().await;
    let (token, _) = app.register("vanishing").await;
    app.verify_email("vanishing@example.test").await;
    let (_, enabled) = app.post("/users/@me/mfa/totp/enable", &token, json!({"password": "correct horse battery", "secret": SECRET, "code": totp(0)})).await;
    let backup = enabled["backup_codes"][0]["code"].as_str().expect("code").to_owned();
    let (_, step) = login(&app, "vanishing", "correct horse battery").await;
    let ticket = step["ticket"].as_str().expect("ticket").to_owned();
    let (status, error) = app.post("/users/@me/delete", &token, json!({"password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "two-factor accounts need a code to delete");
    assert!(error["errors"]["code"].is_object());
    assert_eq!(app.post("/users/@me/delete", &token, json!({"password": "correct horse battery", "code": backup})).await.0, StatusCode::NO_CONTENT);
    for table in ["mfa_tickets", "mfa_backup_codes", "sessions", "email_tokens", "oauth_results", "oauth_identities"] {
        let (left,): (i64,) = sqlx::query_as(&format!("SELECT count(*) FROM {table} WHERE user_id = (SELECT id FROM users WHERE deleted_at IS NOT NULL)"))
            .fetch_one(&app.state.db)
            .await
            .expect("count");
        assert_eq!(left, 0, "{table}");
    }
    // the pending login ticket died with the account
    let (status, _) = app.send(Method::POST, "/auth/mfa/totp", None, Some(json!({"ticket": ticket, "code": totp(1)}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn forgot_password_answers_alike_for_unknown_logins() {
    let app = TestApp::new().await;
    app.register("known").await;
    let (known, _) = app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "known"}))).await;
    let (unknown, _) = app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "nobody@nowhere.test"}))).await;
    assert_eq!((known, unknown), (StatusCode::NO_CONTENT, StatusCode::NO_CONTENT));
    // the work happens after the answer: the mail for the known account arrives later, none for the unknown one
    app.mailed_token_soon("known@example.test", "reset").await;
    assert!(!app.state.accounts.mailer.sent().iter().any(|mail| mail.to.contains("nowhere")));
}

#[test]
fn invalid_smtp_settings_stop_the_server() {
    use vokko_server::account::config::AccountsConfig;
    use vokko_server::config::DotEnv;
    let dir = std::env::temp_dir().join(format!("vokko-smtp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let parse = |text: &str| {
        let path = dir.join("env");
        std::fs::write(&path, text).expect("write");
        AccountsConfig::from_env(&DotEnv::from_file(&path), "http://test.local")
    };
    assert!(parse("VOKKO_SMTP_HOST=smtp.example.test\nVOKKO_SMTP_FROM=not an address\n").is_err(), "bad sender");
    assert!(parse("VOKKO_SMTP_HOST=smtp.example.test\nVOKKO_SMTP_FROM=noreply@example.test\nVOKKO_SMTP_USERNAME=me\n").is_err(), "half credentials");
    assert!(parse("VOKKO_SMTP_HOST=smtp.example.test\nVOKKO_SMTP_FROM=noreply@example.test\nVOKKO_SMTP_SECURITY=sometimes\n").is_err(), "bad mode");
    assert!(parse("VOKKO_SMTP_HOST=smtp.example.test\nVOKKO_SMTP_FROM=Vokko <noreply@example.test>\n").is_ok());
    assert!(parse("VOKKO_SMTP_FROM=noreply@example.test\n").is_err(), "SMTP settings without a host");
    assert!(parse("VOKKO_SMTP_PASSWORD=secret\n").is_err(), "SMTP settings without a host");
    // only a completely unset SMTP falls back to the log
    assert!(matches!(parse("").expect("defaults").mail, vokko_server::account::config::MailConfig::Log));
}

// ---- security review, round 2 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_ten_parallel_wrong_codes_are_checked() {
    let app = std::sync::Arc::new(TestApp::new().await);
    let (token, _) = app.register("racer2").await;
    app.verify_email("racer2@example.test").await;
    assert_eq!(
        app.post("/users/@me/mfa/totp/enable", &token, json!({"password": "correct horse battery", "secret": SECRET, "code": totp(0)})).await.0,
        StatusCode::OK
    );
    let tasks: Vec<_> = (0..30)
        .map(|_| {
            let (app, token) = (app.clone(), token.clone());
            tokio::spawn(async move { app.post("/users/@me/mfa/totp/disable", &token, json!({"code": "zzzzzzzz"})).await.0 })
        })
        .collect();
    let mut checked = 0;
    for task in tasks {
        if task.await.expect("task") == StatusCode::BAD_REQUEST {
            checked += 1;
        }
    }
    assert!(checked <= 10, "{checked} wrong codes were checked");
    // refused requests are not counted, so the account is not locked by them: exactly the checked ones remain
    let (recorded,): (i64,) = sqlx::query_as("SELECT count(*) FROM mfa_failures").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(recorded, checked);
}

#[tokio::test]
async fn forgot_password_does_not_wait_for_the_mail_server() {
    let app =
        TestApp::with_config(|config| config.accounts.mail = vokko_server::account::config::MailConfig::SlowMemory(std::time::Duration::from_millis(1500)))
            .await;
    // registering sends a verification mail through the slow server too; that is fine here
    app.register("patient").await;
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "patient"}))).await.0, StatusCode::NO_CONTENT);
    // The mail is sent last, after the lookups: still unsent means the answer did not wait for it (a wall-clock bound
    // would also count the lookups, slow on a busy database).
    let sent = app.state.accounts.mailer.sent();
    assert!(!sent.iter().any(|mail| mail.body.contains("/reset#token=")), "answered after the mail went out");
    app.mailed_token_soon("patient@example.test", "reset").await;
    // a second request inside the cooldown sends nothing new
    let before = app.state.accounts.mailer.sent().len();
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "patient"}))).await.0, StatusCode::NO_CONTENT);
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    assert_eq!(app.state.accounts.mailer.sent().len(), before);
}

// ---- Codex review on d7b73eb ----

#[tokio::test]
async fn reset_links_die_with_the_address_they_were_sent_to() {
    let app = TestApp::new().await;
    let (token, _) = app.register("mover2").await;
    assert_eq!(app.send(Method::POST, "/auth/forgot", None, Some(json!({"login": "mover2"}))).await.0, StatusCode::NO_CONTENT);
    let old_link = app.mailed_token_soon("mover2@example.test", "reset").await;
    // the account moves to another address
    assert_eq!(app.patch("/users/@me/account", &token, json!({"email": "moved@example.test", "password": "correct horse battery"})).await.0, StatusCode::OK);
    app.verify_email("moved@example.test").await;
    // whoever controls the former inbox cannot reset the password with the old link
    let (status, error) = app.send(Method::POST, "/auth/reset", None, Some(json!({"token": old_link, "password": "hijacked passphrase"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert!(error["errors"]["token"].is_object());
    assert_eq!(login(&app, "mover2", "correct horse battery").await.0, StatusCode::OK);
}

fn tiny_png() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&4_u32.to_be_bytes());
    bytes.extend_from_slice(&4_u32.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

async fn raw(app: &TestApp, request: axum::http::Request<axum::body::Body>) -> (StatusCode, Value) {
    use tower::ServiceExt;
    let response = app.router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn delete_removes_profile_media() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("host").await;
    let (member, _) = app.register("pictured").await;
    let (_, channel) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    let boundary = "vokkoboundaryAccounts";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"me.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(&tiny_png());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", &member)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(axum::body::Body::from(body))
        .expect("request");
    let (status, avatar) = raw(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{avatar}");
    let (_, user) = app.patch("/users/@me", &member, json!({"avatar_attachment_id": avatar["id"]})).await;
    let url = user["avatar"].as_str().expect("avatar").trim_start_matches("http://test.local").to_owned();
    let fetch = || axum::http::Request::builder().uri(url.clone()).body(axum::body::Body::empty()).expect("request");
    assert_eq!(raw(&app, fetch()).await.0, StatusCode::OK);
    let id: i64 = avatar["id"].as_str().expect("id").parse().expect("number");
    let file = app.state.attachments_dir().join(id.to_string());
    let on_disk = || std::fs::read_dir(app.state.attachments_dir()).map(|entries| entries.count()).unwrap_or(0);
    assert!(on_disk() > 0, "{file:?}");

    assert_eq!(app.post("/users/@me/delete", &member, json!({"password": "correct horse battery"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(raw(&app, fetch()).await.0, StatusCode::NOT_FOUND, "the old avatar URL no longer serves the picture");
    assert_eq!(on_disk(), 0, "the file is gone");
}

// ---- Codex review on 3d1d565 ----

#[tokio::test]
async fn delete_keeps_an_upload_a_guild_still_uses_as_its_icon() {
    let app = TestApp::new().await;
    let (_, heir_user) = app.register("heir").await;
    let (member, member_user) = app.register("iconmaker").await;
    let (_, channel) = app.guild_with_channel(&member).await;
    let boundary = "vokkoboundaryIcon";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"icon.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(&tiny_png());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", &member)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(axum::body::Body::from(body))
        .expect("request");
    let (status, upload) = raw(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{upload}");
    // the same upload is the member's avatar and the icon of a guild they hand over before leaving
    assert_eq!(app.patch("/users/@me", &member, json!({"avatar_attachment_id": upload["id"]})).await.0, StatusCode::OK);
    let (status, guild) = app.post("/guilds", &member, json!({"name": "Iconic", "icon_attachment_id": upload["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{guild}");
    // ownership moves on (there is no transfer route yet), so the account can be deleted
    sqlx::query("UPDATE guilds SET owner_id = $2 WHERE owner_id = $1")
        .bind(id_of(&member_user))
        .bind(id_of(&heir_user))
        .execute(&app.state.db)
        .await
        .expect("transfer");
    let url = guild["icon"].as_str().expect("icon").trim_start_matches("http://test.local").to_owned();
    let fetch = || axum::http::Request::builder().uri(url.clone()).body(axum::body::Body::empty()).expect("request");
    assert_eq!(raw(&app, fetch()).await.0, StatusCode::OK);

    assert_eq!(app.post("/users/@me/delete", &member, json!({"password": "correct horse battery"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(raw(&app, fetch()).await.0, StatusCode::OK, "the guild icon still serves");
}

#[tokio::test]
async fn delete_keeps_an_upload_a_webhook_still_uses_as_its_avatar() {
    let app = TestApp::new().await;
    let (_, heir_user) = app.register("hookheir").await;
    let (member, member_user) = app.register("hookmaker").await;
    let (_, channel) = app.guild_with_channel(&member).await;
    let boundary = "vokkoboundaryHook";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"hook.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(&tiny_png());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", &member)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(axum::body::Body::from(body))
        .expect("request");
    let (status, upload) = raw(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{upload}");
    // the same upload is the member's avatar and the avatar of a webhook that outlives the account
    assert_eq!(app.patch("/users/@me", &member, json!({"avatar_attachment_id": upload["id"]})).await.0, StatusCode::OK);
    let (status, hook) = app.post(&format!("/channels/{channel}/webhooks"), &member, json!({"name": "Hook", "avatar_attachment_id": upload["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{hook}");
    sqlx::query("UPDATE guilds SET owner_id = $2 WHERE owner_id = $1")
        .bind(id_of(&member_user))
        .bind(id_of(&heir_user))
        .execute(&app.state.db)
        .await
        .expect("transfer");
    let url = hook["avatar"].as_str().expect("avatar").trim_start_matches("http://test.local").to_owned();
    let fetch = || axum::http::Request::builder().uri(url.clone()).body(axum::body::Body::empty()).expect("request");
    assert_eq!(raw(&app, fetch()).await.0, StatusCode::OK);

    assert_eq!(app.post("/users/@me/delete", &member, json!({"password": "correct horse battery"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(raw(&app, fetch()).await.0, StatusCode::OK, "the webhook avatar still serves");
}

fn id_of(user: &Value) -> i64 {
    user["id"].as_str().expect("id").parse().expect("number")
}

// ---- follow-ups after the merge of #10 ----

#[tokio::test]
async fn attempts_recorded_by_later_requests_count_too() {
    let app = TestApp::new().await;
    let (token, user) = app.register("latecount").await;
    app.verify_email("latecount@example.test").await;
    let enable = json!({"password": "correct horse battery", "secret": SECRET, "code": totp(0)});
    assert_eq!(app.post("/users/@me/mfa/totp/enable", &token, enable).await.0, StatusCode::OK);
    // ten parallel requests got later ids than the next one and committed before it counts: counting only ids up to its own would miss them
    sqlx::query("INSERT INTO mfa_failures (id, user_id) SELECT 1000000 + n, $1 FROM generate_series(1, 10) n")
        .bind(id_of(&user))
        .execute(&app.state.db)
        .await
        .expect("attempts");
    assert_eq!(app.post("/users/@me/mfa/totp/disable", &token, json!({"code": "zzzzzzzz"})).await.0, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_second_verification_keeps_the_first_timestamp() {
    let app = TestApp::new().await;
    let (token, _) = app.register("twice").await;
    app.verify_email("twice@example.test").await;
    let verified_at = || async {
        let (at,): (Option<String>,) =
            sqlx::query_as("SELECT email_verified_at::text FROM users WHERE username = 'twice'").fetch_one(&app.state.db).await.expect("row");
        at.expect("verified")
    };
    let first = verified_at().await;
    assert_eq!(app.patch("/users/@me/account", &token, json!({"email": "twice2@example.test", "password": "correct horse battery"})).await.0, StatusCode::OK);
    app.verify_email("twice2@example.test").await;
    assert_eq!(verified_at().await, first);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_waits_for_a_claim_in_flight_and_keeps_what_it_references() {
    let app = std::sync::Arc::new(TestApp::new().await);
    let (_, heir_user) = app.register("heir2").await;
    let (member, member_user) = app.register("avatared").await;
    let (guild, channel) = app.guild_with_channel(&member).await;
    let boundary = "vokkoboundaryRace";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"me.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(&tiny_png());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", &member)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(axum::body::Body::from(body))
        .expect("request");
    let (status, upload) = raw(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{upload}");
    assert_eq!(app.patch("/users/@me", &member, json!({"avatar_attachment_id": upload["id"]})).await.0, StatusCode::OK);
    // ownership moves on, so the account can be deleted
    sqlx::query("UPDATE guilds SET owner_id = $2 WHERE owner_id = $1")
        .bind(id_of(&member_user))
        .bind(id_of(&heir_user))
        .execute(&app.state.db)
        .await
        .expect("transfer");
    let upload_id: i64 = upload["id"].as_str().expect("id").parse().expect("number");
    let (avatar_path,): (String,) =
        sqlx::query_as("SELECT avatar_path FROM users WHERE id = $1").bind(id_of(&member_user)).fetch_one(&app.state.db).await.expect("avatar");

    // a claim of the avatar upload as a guild icon is in flight, as `image_path_on` and the icon write do it in one transaction
    let mut claim = app.state.db.begin().await.expect("begin");
    sqlx::query("UPDATE attachments SET claimed_at = COALESCE(claimed_at, now()) WHERE id = $1").bind(upload_id).execute(&mut *claim).await.expect("claim");
    sqlx::query("UPDATE guilds SET icon_path = $2 WHERE id = $1")
        .bind(guild.parse::<i64>().expect("guild id"))
        .bind(&avatar_path)
        .execute(&mut *claim)
        .await
        .expect("icon");
    let deleting = {
        let (app, member) = (app.clone(), member.clone());
        tokio::spawn(async move { app.post("/users/@me/delete", &member, json!({"password": "correct horse battery"})).await.0 })
    };
    // the delete blocks on the claimed row ...
    let mut waited = false;
    for _ in 0..200 {
        let (waiting,): (i64,) = sqlx::query_as("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")
            .fetch_one(&app.state.db)
            .await
            .expect("activity");
        if waiting > 0 {
            waited = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(waited, "the delete never waited for the claim");
    claim.commit().await.expect("commit");
    // ... and once the claim lands it sees the new icon and keeps the upload
    assert_eq!(deleting.await.expect("task"), StatusCode::NO_CONTENT);
    let (kept,): (i64,) = sqlx::query_as("SELECT count(*) FROM attachments WHERE id = $1").bind(upload_id).fetch_one(&app.state.db).await.expect("count");
    assert_eq!(kept, 1, "the guild icon lost its upload");
}
