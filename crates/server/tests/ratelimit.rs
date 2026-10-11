mod common;

use axum::body::Body;
use axum::http::Request;
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_server::config::RateLimit;

#[tokio::test]
async fn bursts_are_answered_with_429_and_retry_after() {
    let app = TestApp::with_config(|config| {
        config.rate_limit = Some(RateLimit { route_burst: 3.0, route_per_second: 0.5, global_burst: 100.0, global_per_second: 100.0 })
    })
    .await;
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
