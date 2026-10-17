#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::{Method, StatusCode};
use common::TestApp;
use serde_json::json;

fn report(logs: &str) -> serde_json::Value {
    json!({"description": "  Voice drops after a minute  ", "app_version": "0.1.8", "os": "macOS 26 (Safari)", "logs": logs})
}

#[tokio::test]
async fn a_report_is_stored_with_the_user_and_the_callers_token_redacted() {
    let app = TestApp::new().await;
    let (token, user) = app.register("ezreal").await;
    let (status, created) = app.post("/bug-reports", &token, report(&format!("warn [vokko:voice] reconnect token={token}"))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id: i64 = created["id"].as_str().expect("id").parse().expect("snowflake");
    let (user_id, description, version, os, logs): (i64, String, String, String, String) =
        sqlx::query_as("SELECT user_id, description, app_version, os, logs FROM bug_reports WHERE id = $1")
            .bind(id)
            .fetch_one(&app.state.db)
            .await
            .expect("row");
    assert_eq!(user_id.to_string(), user["id"].as_str().expect("user id"));
    assert_eq!(description, "Voice drops after a minute");
    assert_eq!((version.as_str(), os.as_str()), ("0.1.8", "macOS 26 (Safari)"));
    assert!(!logs.contains(&token), "token leaked: {logs}");
    assert!(logs.contains("token=[redacted]"));
}

#[tokio::test]
async fn reports_need_a_signed_in_user_and_a_description() {
    let app = TestApp::new().await;
    let (status, _) = app.send(Method::POST, "/bug-reports", None, Some(report(""))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (token, _) = app.register("lux").await;
    let (status, body) = app.post("/bug-reports", &token, json!({"description": "   ", "app_version": "1", "os": "x"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["errors"]["description"].is_object(), "{body}");
    let (status, body) = app.post("/bug-reports", &token, json!({"description": "x".repeat(2001), "app_version": "1", "os": "x"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn the_body_is_capped_at_256_kib() {
    let app = TestApp::new().await;
    let (token, _) = app.register("jinx").await;
    let (status, body) = app.post("/bug-reports", &token, report(&"a".repeat(256 * 1024))).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["code"], 40005);
    let (status, _) = app.post("/bug-reports", &token, report(&"a".repeat(200 * 1024))).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn reports_are_rate_limited_per_user() {
    let app = TestApp::new().await;
    let (token, _) = app.register("vi").await;
    for _ in 0..3 {
        assert_eq!(app.post("/bug-reports", &token, report("")).await.0, StatusCode::OK);
    }
    let (status, body) = app.post("/bug-reports", &token, report("")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body["retry_after"].as_f64().expect("retry_after") > 0.0, "{body}");
    // another user has a bucket of their own
    let (other, _) = app.register("caitlyn").await;
    assert_eq!(app.post("/bug-reports", &other, report("")).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_sweep_deletes_reports_older_than_30_days() {
    let app = TestApp::new().await;
    let (token, _) = app.register("ekko").await;
    let (_, old) = app.post("/bug-reports", &token, report("")).await;
    let (_, fresh) = app.post("/bug-reports", &token, report("")).await;
    let old: i64 = old["id"].as_str().expect("id").parse().expect("id");
    sqlx::query("UPDATE bug_reports SET created_at = now() - interval '31 days' WHERE id = $1").bind(old).execute(&app.state.db).await.expect("age");
    assert_eq!(vokko_server::routes::bug_reports::sweep(&app.state).await.expect("sweep"), 1);
    let left: Vec<(i64,)> = sqlx::query_as("SELECT id FROM bug_reports").fetch_all(&app.state.db).await.expect("rows");
    assert_eq!(left, vec![(fresh["id"].as_str().expect("id").parse::<i64>().expect("id"),)]);
}
