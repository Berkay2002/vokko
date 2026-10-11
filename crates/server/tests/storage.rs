#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Attachment storage backends behind the routes, and TLS to managed Postgres.
//! The in-memory backend always runs. S3 runs against a real bucket (MinIO) when `VOKKO_TEST_S3_ENDPOINT`,
//! `VOKKO_TEST_S3_BUCKET`, `VOKKO_TEST_S3_ACCESS_KEY_ID` and `VOKKO_TEST_S3_SECRET_ACCESS_KEY` are set, and the TLS test when
//! `VOKKO_TEST_TLS_DATABASE_URL` points at a Postgres with `ssl=on` (`deploy/selfhost-check.sh` starts both in Docker).
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_server::storage::{S3Config, StorageConfig};

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

fn s3_config(presign_ttl: Option<Duration>) -> Option<S3Config> {
    let var = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    Some(S3Config {
        endpoint: var("VOKKO_TEST_S3_ENDPOINT")?.trim_end_matches('/').to_owned(),
        bucket: var("VOKKO_TEST_S3_BUCKET")?,
        region: var("VOKKO_TEST_S3_REGION").unwrap_or_else(|| "us-east-1".to_owned()),
        access_key_id: var("VOKKO_TEST_S3_ACCESS_KEY_ID")?,
        secret_access_key: var("VOKKO_TEST_S3_SECRET_ACCESS_KEY")?,
        // A fresh prefix per test keeps parallel runs apart in one bucket.
        prefix: format!("test-{}/", vokko_server::auth::random_hex(6)),
        presign_ttl,
    })
}

async fn upload(app: &TestApp, token: &str, channel: &str, bytes: &[u8]) -> Value {
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"pic.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", token)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("attachment json")
}

/// Status, `Location` and body of a GET of an attachment URL through the router.
async fn download(app: &TestApp, url: &str) -> (StatusCode, Option<String>, Vec<u8>) {
    let path = url.strip_prefix("http://test.local").expect("test origin");
    let response = app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response");
    let status = response.status();
    let location = response.headers().get("location").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    (status, location, bytes.to_vec())
}

/// `.../attachments/<id>/<key>/<filename>` with another key.
fn with_wrong_key(url: &str) -> String {
    let key = url.split('/').nth_back(1).expect("key");
    url.replacen(&format!("/{key}/"), &format!("/{}/", "f".repeat(key.len())), 1)
}

/// Remote backends delete in the background, so wait a little for the file to go.
async fn gone(app: &TestApp, id: &str) -> bool {
    for _ in 0..50 {
        if !stored(app, id).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn stored(app: &TestApp, id: &str) -> bool {
    app.state.storage.read(id.parse().expect("id")).await.is_ok()
}

/// Upload → send → download → forward (a copy) → delete the source (its file goes, the copy stays) → delete the copy.
async fn round_trip(storage: StorageConfig) {
    let app = TestApp::with_config(|config| config.storage = storage).await;
    let (owner, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&owner).await;
    let image = png(16, 9);
    let attachment = upload(&app, &owner, &channel, &image).await;
    let id = attachment["id"].as_str().expect("id").to_owned();
    assert!(stored(&app, &id).await, "the upload reached the backend");
    let (status, message) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"attachments": [{"id": id}]})).await;
    assert_eq!(status, 200, "{message}");
    let url = message["attachments"][0]["url"].as_str().expect("url").to_owned();
    let (status, _, body) = download(&app, &url).await;
    assert_eq!((status, body), (StatusCode::OK, image.clone()));
    assert_eq!(download(&app, &with_wrong_key(&url)).await.0, StatusCode::NOT_FOUND);

    let reference = json!({"message_reference": {"type": 1, "message_id": message["id"], "channel_id": channel}});
    let (status, forwarded) = app.post(&format!("/channels/{channel}/messages"), &owner, reference).await;
    assert_eq!(status, 200, "{forwarded}");
    let copy = &forwarded["message_snapshots"][0]["message"]["attachments"][0];
    let copy_id = copy["id"].as_str().expect("copy id").to_owned();
    assert_ne!(copy_id, id);
    assert!(stored(&app, &copy_id).await, "the forward copied the file");

    let (status, _) = app.delete(&format!("/channels/{channel}/messages/{}", message["id"].as_str().expect("id")), &owner).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(gone(&app, &id).await, "deleting the message deleted its file");
    let (status, _, body) = download(&app, copy["url"].as_str().expect("url")).await;
    assert_eq!((status, body), (StatusCode::OK, image), "the copy outlives the source");

    let (status, _) = app.delete(&format!("/channels/{channel}/messages/{}", forwarded["id"].as_str().expect("id")), &owner).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(gone(&app, &copy_id).await);
}

#[tokio::test]
async fn memory_backend_round_trip() {
    round_trip(StorageConfig::Memory).await;
}

#[tokio::test]
async fn s3_backend_round_trip() {
    let Some(config) = s3_config(None) else {
        eprintln!("skipped: VOKKO_TEST_S3_* not set");
        return;
    };
    round_trip(StorageConfig::S3(config)).await;
}

#[tokio::test]
async fn s3_presigned_downloads_redirect_after_the_key_check() {
    let Some(config) = s3_config(Some(Duration::from_secs(60))) else {
        eprintln!("skipped: VOKKO_TEST_S3_* not set");
        return;
    };
    let app = TestApp::with_config(|settings| settings.storage = StorageConfig::S3(config)).await;
    let (owner, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&owner).await;
    let image = png(3, 4);
    let attachment = upload(&app, &owner, &channel, &image).await;
    let url = attachment["url"].as_str().expect("url");
    let (status, location, _) = download(&app, url).await;
    assert_eq!(status, StatusCode::FOUND);
    let location = location.expect("location");
    let response = reqwest::get(&location).await.expect("presigned fetch");
    assert_eq!(response.status(), reqwest::StatusCode::OK, "{location}");
    assert_eq!(response.headers()["content-type"], "image/png");
    assert!(response.headers()["content-disposition"].to_str().expect("ascii").starts_with("inline; filename=\"pic.png\""));
    assert_eq!(response.bytes().await.expect("bytes").to_vec(), image);
    // A wrong key is refused before any redirect.
    let (status, location, _) = download(&app, &with_wrong_key(url)).await;
    assert_eq!((status, location), (StatusCode::NOT_FOUND, None));
}

#[test]
fn database_url_ssl_options_parse() {
    for url in [
        "postgres://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require",
        "postgres://postgres.abcd:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
        "postgres://u:p@localhost/vokko?sslmode=disable",
        "postgres://u:p@localhost/vokko",
    ] {
        assert!(vokko_server::connect_options(url).is_ok(), "{url}");
    }
    assert!(vokko_server::connect_options("postgres://u:p@localhost/vokko?sslmode=sometimes").is_err());
}

#[tokio::test]
async fn connects_to_postgres_over_tls_with_sslmode_require() {
    let Ok(url) = std::env::var("VOKKO_TEST_TLS_DATABASE_URL") else {
        eprintln!("skipped: VOKKO_TEST_TLS_DATABASE_URL not set");
        return;
    };
    let separator = if url.contains('?') { '&' } else { '?' };
    // `require` encrypts without verifying the (self-signed) certificate, like libpq.
    let pool = vokko_server::connect(&format!("{url}{separator}sslmode=require"), 2).await.expect("TLS connection");
    let (ssl,): (bool,) = sqlx::query_as("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").fetch_one(&pool).await.expect("pg_stat_ssl");
    assert!(ssl, "the session is encrypted");
    // `verify-full` checks the certificate against the bundled roots, which a self-signed one fails.
    assert!(vokko_server::connect(&format!("{url}{separator}sslmode=verify-full"), 1).await.is_err());
    // `disable` against a server that requires TLS (hostssl only) fails; against one that allows both it connects in the clear.
    if let Ok(pool) = vokko_server::connect(&format!("{url}{separator}sslmode=disable"), 1).await {
        let (ssl,): (bool,) = sqlx::query_as("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").fetch_one(&pool).await.expect("pg_stat_ssl");
        assert!(!ssl);
    }
}
