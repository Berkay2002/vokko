#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::{Method, StatusCode};
use common::TestApp;
use serde_json::json;

fn crash(stack: &str) -> serde_json::Value {
    json!({
        "kind": "error",
        "app_version": "0.1.9",
        "os": "Windows 11 (WebView2)",
        "route": "/channels/123456789012345678/876543210987654321",
        "message": "  TypeError: x is undefined  ",
        "stack": stack,
    })
}

#[tokio::test]
async fn a_report_is_stored_without_the_user_ids_or_the_callers_token() {
    let app = TestApp::new().await;
    let (token, user) = app.register("ezreal").await;
    let (status, body) = app.post("/crash-reports", &token, crash(&format!("at f (app.js:1:2) token={token}"))).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as("SELECT kind, app_version, route, message, stack FROM crash_reports").fetch_all(&app.state.db).await.expect("rows");
    assert_eq!(rows.len(), 1);
    let (kind, version, route, message, stack) = &rows[0];
    assert_eq!((kind.as_str(), version.as_str()), ("error", "0.1.9"));
    assert_eq!(route, "/channels/:id/:id");
    assert_eq!(message, "TypeError: x is undefined");
    assert!(!stack.contains(&token) && stack.contains("token=[redacted]"), "{stack}");
    let user_id = user["id"].as_str().expect("user id");
    assert!(rows.iter().all(|r| !format!("{r:?}").contains(user_id)));
    // panics from the desktop shell use their own kind
    let mut panic = crash("src/main.rs:10:5");
    panic["kind"] = json!("panic");
    assert_eq!(app.post("/crash-reports", &token, panic).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn reports_need_a_signed_in_user_and_valid_fields() {
    let app = TestApp::new().await;
    let (status, _) = app.send(Method::POST, "/crash-reports", None, Some(crash(""))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app.send(Method::POST, "/crash-reports", Some("not-a-real-token-at-all"), Some(crash(""))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (token, _) = app.register("lux").await;
    let mut empty = crash("");
    empty["message"] = json!("   ");
    let (status, body) = app.post("/crash-reports", &token, empty).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["errors"]["message"].is_object(), "{body}");
    let mut kind = crash("");
    kind["kind"] = json!("oops");
    assert_eq!(app.post("/crash-reports", &token, kind).await.0, StatusCode::BAD_REQUEST);
    let (status, body) = app.post("/crash-reports", &token, crash(&"a".repeat(16_001))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["errors"]["stack"].is_object(), "{body}");
}

#[tokio::test]
async fn the_body_is_capped_at_32_kib() {
    let app = TestApp::new().await;
    let (token, _) = app.register("jinx").await;
    let (status, body) = app.post("/crash-reports", &token, crash(&"a".repeat(33 * 1024))).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["code"], 40005);
}

#[tokio::test]
async fn reports_are_rate_limited_per_user() {
    let app = TestApp::new().await;
    let (token, _) = app.register("vi").await;
    for _ in 0..10 {
        assert_eq!(app.post("/crash-reports", &token, crash("")).await.0, StatusCode::NO_CONTENT);
    }
    let (status, body) = app.post("/crash-reports", &token, crash("")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body["retry_after"].as_f64().expect("retry_after") > 0.0, "{body}");
    let (other, _) = app.register("caitlyn").await;
    assert_eq!(app.post("/crash-reports", &other, crash("")).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn the_sweep_deletes_crash_reports_older_than_30_days() {
    let app = TestApp::new().await;
    let (token, _) = app.register("ekko").await;
    app.post("/crash-reports", &token, crash("old")).await;
    app.post("/crash-reports", &token, crash("fresh")).await;
    sqlx::query("UPDATE crash_reports SET created_at = now() - interval '31 days' WHERE stack = 'old'").execute(&app.state.db).await.expect("age");
    assert_eq!(vokko_server::routes::bug_reports::sweep_crashes(&app.state).await.expect("sweep"), 1);
    let left: Vec<(String,)> = sqlx::query_as("SELECT stack FROM crash_reports").fetch_all(&app.state.db).await.expect("rows");
    assert_eq!(left, vec![("fresh".to_owned(),)]);
}
