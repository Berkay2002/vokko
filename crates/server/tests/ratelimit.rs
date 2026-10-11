#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_server::config::RateLimit;

fn lenient_global(route_burst: f64) -> RateLimit {
    RateLimit { route_burst, route_per_second: 0.5, global_burst: 1000.0, global_per_second: 1000.0, ..RateLimit::default() }
}

#[tokio::test]
async fn bursts_are_answered_with_429_and_retry_after() {
    let app = TestApp::with_config(|config| config.rate_limit = Some(lenient_global(3.0))).await;
    let (token, _) = app.register("sam").await;
    for _ in 0..3 {
        assert_eq!(app.get("/users/@me", &token).await.0, 200);
    }
    let request = Request::builder().uri("/api/v1/users/@me").header("authorization", &token).body(Body::empty()).expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), 429);
    let retry_header: u64 = response.headers()["retry-after"].to_str().expect("header").parse().expect("integer seconds");
    assert!(retry_header >= 1);
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body")).expect("json");
    assert_eq!(body["global"], false);
    assert!(body["retry_after"].as_f64().expect("seconds") > 0.0);
    assert!(body["message"].is_string());
    // other routes keep their own bucket
    let (status, _) = app.post("/guilds", &token, json!({"name": "still fine"})).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn limits_follow_the_user_not_the_header_text() {
    let app = TestApp::with_config(|config| config.rate_limit = Some(lenient_global(3.0))).await;
    let (first, user) = app.register("sam").await;
    let (status, login) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": user["username"], "password": "correct horse battery"}))).await;
    assert_eq!(status, StatusCode::OK);
    let second = login["token"].as_str().expect("token").to_owned();
    assert_ne!(first, second);

    // two tokens of one user share the user's buckets
    assert_eq!(app.get("/users/@me", &first).await.0, 200);
    assert_eq!(app.get("/users/@me", &second).await.0, 200);
    assert_eq!(app.get("/users/@me", &first).await.0, 200);
    assert_eq!(app.get("/users/@me", &second).await.0, 429);
    // another user is unaffected
    let (other, _) = app.register("alice").await;
    assert_eq!(app.get("/users/@me", &other).await.0, 200);
}

#[tokio::test]
async fn invented_tokens_share_the_clients_bucket() {
    let app = TestApp::with_config(|config| config.rate_limit = Some(lenient_global(3.0))).await;
    // every request carries a different bogus Authorization value; none of them may get a fresh bucket
    let mut statuses = Vec::new();
    for n in 0..6 {
        statuses.push(app.get("/users/@me", &format!("bogus-token-{n}")).await.0);
    }
    assert_eq!(statuses[..3], [StatusCode::UNAUTHORIZED; 3]);
    assert_eq!(statuses[3..], [StatusCode::TOO_MANY_REQUESTS; 3]);
}

#[tokio::test]
async fn auth_routes_are_limited_per_client_address() {
    let app = TestApp::with_config(|config| {
        config.rate_limit = Some(RateLimit { auth_burst: 3.0, auth_per_second: 0.1, ..lenient_global(30.0) });
    })
    .await;
    let attempt = |n: u32| {
        let app = &app;
        async move { app.send(Method::POST, "/auth/login", None, Some(json!({"login": format!("nobody{n}"), "password": "whatever you like"}))).await }
    };
    for n in 0..3 {
        assert_eq!(attempt(n).await.0, StatusCode::BAD_REQUEST, "wrong credentials are answered normally");
    }
    let (status, body) = attempt(3).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["global"], false);
    // registering shares the address but has its own route bucket
    let register = json!({"email": "a@example.test", "username": "newbie", "password": "correct horse battery"});
    assert_eq!(app.send(Method::POST, "/auth/register", None, Some(register)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn gif_routes_share_one_bucket_per_user_to_protect_the_provider_quota() {
    // default limits: 30 per route and 10 per second per route; the GIF bucket is 10 with 2 per second, shared by search/trending/categories
    let app = TestApp::with_config(|config| config.rate_limit = Some(RateLimit::default())).await;
    let (token, _) = app.register("sam").await;
    let (other, _) = app.register("alice").await;
    let mut limited_at = None;
    for request in 0..14 {
        let path = match request % 3 {
            0 => "/gifs/trending",
            1 => "/gifs/categories",
            _ => "/gifs/search?q=cat",
        };
        if app.get(path, &token).await.0 == 429 {
            limited_at = Some(request);
            break;
        }
    }
    let limited_at = limited_at.expect("the shared GIF bucket ran dry");
    assert!((10..=12).contains(&limited_at), "burst of 10 plus a little refill, got {limited_at}");
    assert_eq!(app.get("/gifs/trending", &other).await.0, 200, "another user has their own bucket");
    assert_eq!(app.get("/users/@me", &token).await.0, 200, "other routes are unaffected");
}
