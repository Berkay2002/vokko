#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `/healthz`, `VOKKO_CORS_ORIGINS` and `VOKKO_REGISTRATION=closed`.
mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_server::AppState;

async fn call(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.expect("response")
}

async fn json_of(response: Response<Body>) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn preflight(origin: &str) -> Request<Body> {
    Request::builder()
        .method("OPTIONS")
        .uri("/api/v1/auth/login")
        .header("origin", origin)
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "authorization,content-type")
        .body(Body::empty())
        .expect("request")
}

fn allowed_origin(response: &Response<Body>) -> Option<String> {
    response.headers().get("access-control-allow-origin").map(|value| value.to_str().expect("header").to_owned())
}

#[tokio::test]
async fn healthz_reports_version_and_database_without_auth() {
    let app = TestApp::new().await;
    let response = call(&app.router, Request::builder().uri("/healthz").body(Body::empty()).expect("request")).await;
    let (status, body) = json_of(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "ok");
    assert_eq!(body["db"], "ok");
    assert!(body["version"].as_str().is_some_and(|version| !version.is_empty()), "{body}");

    // a dead database is a 503, not a hang
    app.state.db.close().await;
    let response = call(&app.router, Request::builder().uri("/healthz").body(Body::empty()).expect("request")).await;
    let (status, body) = json_of(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["db"], "error");
}

#[tokio::test]
async fn cors_defaults_allow_localhost_and_tauri_only() {
    let app = TestApp::new().await;
    for origin in ["http://localhost:1420", "http://127.0.0.1:5173", "tauri://localhost", "http://tauri.localhost"] {
        assert_eq!(allowed_origin(&call(&app.router, preflight(origin)).await).as_deref(), Some(origin), "{origin}");
    }
    for origin in ["https://chat.example.com", "http://localhost.evil.test", "http://localhost:abc"] {
        assert_eq!(allowed_origin(&call(&app.router, preflight(origin)).await), None, "{origin}");
    }
}

#[tokio::test]
async fn cors_allow_list_replaces_the_dev_defaults() {
    let app = TestApp::with_config(|config| config.cors_origins = Some(vec!["https://chat.example.com".to_owned()])).await;
    let response = call(&app.router, preflight("https://chat.example.com")).await;
    assert_eq!(allowed_origin(&response).as_deref(), Some("https://chat.example.com"));
    // the real request carries the header too
    let get = Request::builder().uri("/healthz").header("origin", "https://chat.example.com").body(Body::empty()).expect("request");
    assert_eq!(allowed_origin(&call(&app.router, get).await).as_deref(), Some("https://chat.example.com"));

    for origin in ["https://other.example.com", "http://chat.example.com", "https://chat.example.com.evil.test", "http://localhost:1420"] {
        assert_eq!(allowed_origin(&call(&app.router, preflight(origin)).await), None, "{origin}");
    }
    // the desktop app keeps working
    assert_eq!(allowed_origin(&call(&app.router, preflight("tauri://localhost")).await).as_deref(), Some("tauri://localhost"));
}

#[tokio::test]
async fn closed_registration_refuses_sign_ups_but_not_existing_users() {
    let app = TestApp::new().await;
    let (token, _) = app.register("sam").await;

    let mut config = app.state.config.clone();
    config.registration_open = false;
    let closed = vokko_server::router(AppState::new(app.state.db.clone(), config));
    let request = |path: &str, body: Value| {
        Request::builder().method("POST").uri(path).header("content-type", "application/json").body(Body::from(body.to_string())).expect("request")
    };

    let (status, body) = json_of(
        call(&closed, request("/api/v1/auth/register", json!({"email": "new@example.test", "username": "newbie", "password": "correct horse battery"}))).await,
    )
    .await;
    assert_eq!((status, body["code"].clone()), (StatusCode::FORBIDDEN, json!(40002)), "{body}");
    assert!(body["message"].as_str().is_some_and(|message| message.contains("closed")), "{body}");
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM users WHERE username = 'newbie'").fetch_one(&app.state.db).await.expect("count");
    assert_eq!(count, 0);

    // existing users still sign in and use the API
    let (status, login) = json_of(call(&closed, request("/api/v1/auth/login", json!({"login": "sam", "password": "correct horse battery"}))).await).await;
    assert_eq!(status, StatusCode::OK, "{login}");
    let me = Request::builder().uri("/api/v1/users/@me").header("authorization", token).body(Body::empty()).expect("request");
    assert_eq!(call(&closed, me).await.status(), StatusCode::OK);

    // the default stays open
    let (status, _) = json_of(
        call(
            &app.router,
            request(
                "/api/v1/auth/register",
                json!({"email": "new@example.test", "username": "newbie", "password": "correct horse battery", "date_of_birth": "1990-01-01"}),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
