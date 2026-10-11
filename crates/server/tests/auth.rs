#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::{Method, StatusCode};
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn register_login_me_logout() {
    let app = TestApp::new().await;
    let (token, user) = app.register("sam").await;
    assert_eq!(user["username"], "sam");
    assert_eq!(user["bot"], false);
    assert!(user["id"].is_string());
    assert_eq!(token.len(), 64);

    let (status, me) = app.get("/users/@me", &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me, user);

    // login by username and by email, case-insensitive
    let (status, login) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "SAM", "password": "correct horse battery"}))).await;
    assert_eq!(status, StatusCode::OK);
    let second = login["token"].as_str().expect("token").to_owned();
    assert_ne!(second, token);
    let (status, _) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "sam@example.test", "password": "correct horse battery"}))).await;
    assert_eq!(status, StatusCode::OK);

    // logout revokes only that token
    let (status, _) = app.post("/auth/logout", &second, json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, error) = app.get("/users/@me", &second).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error["code"], 0);
    assert_eq!(error["message"], "401: Unauthorized");
    assert_eq!(app.get("/users/@me", &token).await.0, StatusCode::OK);
}

#[tokio::test]
async fn bad_credentials_and_validation() {
    let app = TestApp::new().await;
    app.register("alice").await;

    let (status, error) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "alice", "password": "wrong password"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], 50035);

    let (status, error) = app
        .send(
            Method::POST,
            "/auth/register",
            None,
            Some(json!({"email": "a@x.io", "username": "alice", "password": "correct horse battery", "date_of_birth": "1990-01-01"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "duplicate username");
    assert_eq!(error["code"], 50035);
    assert!(error["errors"]["username"].is_object());

    let (status, error) = app
        .send(
            Method::POST,
            "/auth/register",
            None,
            Some(json!({"email": "x@x.io", "username": "Bad Name!", "password": "correct horse battery", "date_of_birth": "1990-01-01"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["username"].is_object());

    let (status, error) = app
        .send(Method::POST, "/auth/register", None, Some(json!({"email": "x@x.io", "username": "okname", "password": "short", "date_of_birth": "1990-01-01"})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["errors"]["password"].is_object());

    // malformed JSON also uses the ApiError shape
    let (status, error) = app.send(Method::POST, "/auth/login", None, Some(json!({"nope": 1}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], 50035);

    // no header / garbage token
    assert_eq!(app.send(Method::GET, "/users/@me", None, None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/users/@me", "not-a-token").await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn profile_update_and_lookup() {
    let app = TestApp::new().await;
    let (token, user) = app.register("nova").await;
    let (status, updated) = app.patch("/users/@me", &token, json!({"global_name": "Nova", "bio": "hello", "banner_color": "#12ab34"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["global_name"], "Nova");
    assert_eq!(updated["banner_color"], "#12ab34");

    let (status, error) = app.patch("/users/@me", &token, json!({"banner_color": "red"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], 50035);

    let (_, other) = app.register("bob").await;
    let (status, fetched) = app.get(&format!("/users/{}", user["id"].as_str().expect("id")), &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["username"], "nova");
    assert_eq!(other["username"], "bob");
    let (status, error) = app.get("/users/123456", &token).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], 10013);
}

#[tokio::test]
async fn cors_allows_local_origins_only() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    let app = TestApp::new().await;
    for (origin, allowed) in [
        ("http://localhost:1420", true),
        ("http://127.0.0.1:5173", true),
        ("tauri://localhost", true),
        ("http://tauri.localhost", true),
        ("https://evil.example", false),
    ] {
        let request = Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/v1/users/@me")
            .header("origin", origin)
            .header("access-control-request-method", "GET")
            .header("access-control-request-headers", "authorization")
            .body(Body::empty())
            .expect("request");
        let response = app.router.clone().oneshot(request).await.expect("response");
        let header = response.headers().get("access-control-allow-origin").and_then(|value| value.to_str().ok()).map(str::to_owned);
        assert_eq!(header.as_deref() == Some(origin), allowed, "origin {origin}");
    }
}
