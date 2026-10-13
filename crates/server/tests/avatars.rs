#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Recent avatars (`GET /users/@me/avatars`) and importing a picked GIF as an avatar (`POST /users/@me/avatars/gif`).
mod common;

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_protocol::api::GifProvider;
use vokko_server::config::GifConfig;

/// A PNG header whose width differs per `n`, so every upload is a different file.
fn png(n: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&(4 + n).to_be_bytes());
    bytes.extend_from_slice(&4_u32.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

fn gif() -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&[0x20, 0x00, 0x10, 0x00]);
    bytes.extend_from_slice(&[0; 64]);
    bytes
}

async fn upload(app: &TestApp, token: &str, channel: &str, filename: &str, declared: &str, data: &[u8]) -> Value {
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {declared}\r\n\r\n").into_bytes();
    body.extend_from_slice(data);
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

async fn status_of(app: &TestApp, url: &str) -> StatusCode {
    let path = url.strip_prefix("http://test.local").expect("test origin");
    app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response").status()
}

/// A user in a guild of their own, with its general channel to upload through.
async fn setup(adjust: impl FnOnce(&mut vokko_server::Config)) -> (TestApp, String, String) {
    let app = TestApp::with_config(adjust).await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    (app, token, channel)
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("array").iter().map(|entry| entry["id"].as_str().expect("id").to_owned()).collect()
}

fn id_of(attachment: &Value) -> i64 {
    attachment["id"].as_str().expect("id").parse().expect("number")
}

#[tokio::test]
async fn recent_avatars_keep_the_last_six_newest_first_and_their_files() {
    let (app, token, channel) = setup(|_| {}).await;
    assert_eq!(app.get("/users/@me/avatars", &token).await.1, json!([]));

    let mut uploads = Vec::new();
    for n in 0..8 {
        let attachment = upload(&app, &token, &channel, &format!("a{n}.png"), "image/png", &png(n)).await;
        let (status, user) = app.patch("/users/@me", &token, json!({"avatar_attachment_id": attachment["id"]})).await;
        assert_eq!(status, StatusCode::OK, "{user}");
        assert_eq!(user["avatar"], attachment["url"]);
        uploads.push(attachment);
    }
    let (status, recent) = app.get("/users/@me/avatars", &token).await;
    assert_eq!(status, StatusCode::OK, "{recent}");
    let expected: Vec<String> = (2..8).rev().map(|n| uploads[n]["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids(&recent), expected, "the last six, newest first");
    assert_eq!(recent[0]["url"], uploads[7]["url"]);

    // clicking an older one sets it again and moves it to the top
    let (status, user) = app.patch("/users/@me", &token, json!({"avatar_attachment_id": uploads[3]["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{user}");
    assert_eq!(user["avatar"], uploads[3]["url"]);
    let (_, recent) = app.get("/users/@me/avatars", &token).await;
    assert_eq!(ids(&recent)[0], uploads[3]["id"].as_str().unwrap());
    assert_eq!(recent.as_array().unwrap().len(), 6);

    // clearing the avatar leaves the list alone; another user has their own list
    app.patch("/users/@me", &token, json!({"avatar_attachment_id": null})).await;
    assert_eq!(app.get("/users/@me/avatars", &token).await.1.as_array().unwrap().len(), 6);
    let (other, _) = app.register("alice").await;
    assert_eq!(app.get("/users/@me/avatars", &other).await.1, json!([]));
    assert_eq!(app.send(axum::http::Method::GET, "/users/@me/avatars", None, None).await.0, StatusCode::UNAUTHORIZED);

    // a listed avatar is in use: even with its claim cleared the pending-upload cleanup keeps the file, and removes one that fell off
    for upload in [&uploads[5], &uploads[0]] {
        sqlx::query("UPDATE attachments SET claimed_at = NULL WHERE id = $1").bind(id_of(upload)).execute(&app.state.db).await.unwrap();
    }
    let removed = vokko_server::media::cleanup_pending(&app.state, Duration::ZERO).await;
    assert!(removed >= 1, "the avatar that fell off the list is a pending upload again");
    assert_eq!(status_of(&app, uploads[5]["url"].as_str().unwrap()).await, StatusCode::OK);
    assert_eq!(status_of(&app, uploads[0]["url"].as_str().unwrap()).await, StatusCode::NOT_FOUND);
}

/// A fake provider media host: a GIF, something that is not an image, redirects and a body past the limit.
async fn media_host() -> String {
    async fn page() -> impl IntoResponse {
        ([("content-type", "image/gif")], gif())
    }
    async fn text() -> impl IntoResponse {
        ([("content-type", "image/gif")], "<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    }
    async fn elsewhere() -> impl IntoResponse {
        (StatusCode::FOUND, [("location", "http://localhost:9/other.gif")])
    }
    async fn within() -> impl IntoResponse {
        (StatusCode::FOUND, [("location", "/media/a.gif")])
    }
    async fn huge() -> impl IntoResponse {
        let mut bytes = gif();
        bytes.resize(11 * 1024 * 1024, 0);
        ([("content-type", "image/gif")], bytes)
    }
    let router = Router::new()
        .route("/media/a.gif", get(page))
        .route("/media/text.gif", get(text))
        .route("/media/elsewhere.gif", get(elsewhere))
        .route("/media/within.gif", get(within))
        .route("/media/huge.gif", get(huge));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    format!("http://{address}")
}

#[tokio::test]
async fn a_picked_gif_is_fetched_by_the_server_only_from_the_providers_media_hosts() {
    let base = media_host().await;
    let configured = base.clone();
    let (app, token, channel) = setup(move |config| {
        config.gif = GifConfig { provider: GifProvider::Giphy, api_key: "k".to_owned(), base_url: Some(configured) };
        config.unfurl.allow_private = true; // the fake host is on loopback
    })
    .await;
    let import = |url: String| app.post("/users/@me/avatars/gif", &token, json!({"channel_id": channel, "url": url}));

    let (status, attachment) = import(format!("{base}/media/a.gif")).await;
    assert_eq!(status, StatusCode::OK, "{attachment}");
    assert_eq!((attachment["content_type"].as_str(), attachment["filename"].as_str()), (Some("image/gif"), Some("avatar.gif")));
    assert_eq!((attachment["width"].as_u64(), attachment["height"].as_u64()), (Some(32), Some(16)));
    // it is an ordinary pending upload: saving the profile claims it, and it shows up under recent avatars
    let (status, user) = app.patch("/users/@me", &token, json!({"avatar_attachment_id": attachment["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{user}");
    assert!(user["avatar"].as_str().unwrap().ends_with("/avatar.gif"), "{user}");
    assert_eq!(status_of(&app, user["avatar"].as_str().unwrap()).await, StatusCode::OK);
    assert_eq!(ids(&app.get("/users/@me/avatars", &token).await.1), vec![attachment["id"].as_str().unwrap().to_owned()]);

    // a redirect inside the allowed origin is followed
    assert_eq!(import(format!("{base}/media/within.gif")).await.0, StatusCode::OK);
    // everything else is refused before or while fetching
    for (url, why) in [
        ("https://evil.example/a.gif".to_owned(), "other host"),
        ("https://media.giphy.com.evil.example/a.gif".to_owned(), "look-alike host"),
        ("http://media.giphy.com/a.gif".to_owned(), "plain http"),
        ("http://127.0.0.1:9/a.gif".to_owned(), "other port on loopback"),
        ("file:///etc/passwd".to_owned(), "not http"),
        ("nonsense".to_owned(), "not a URL"),
        (format!("{base}/media/elsewhere.gif"), "redirect to another origin"),
        (format!("{base}/media/text.gif"), "not an image"),
        (format!("{base}/media/huge.gif"), "too large"),
        (format!("{base}/media/missing.gif"), "provider 404"),
    ] {
        let (status, error) = import(url).await;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::BAD_GATEWAY, "{why}: {status} {error}");
    }
    // nobody can import into a channel they cannot upload to, and a server without a GIF provider downloads nothing
    let (stranger, _) = app.register("mallory").await;
    let (status, _) = app.post("/users/@me/avatars/gif", &stranger, json!({"channel_id": channel, "url": format!("{base}/media/a.gif")})).await;
    assert_ne!(status, StatusCode::OK);
    let (plain, plain_token, plain_channel) = setup(|_| {}).await;
    let (status, error) = plain.post("/users/@me/avatars/gif", &plain_token, json!({"channel_id": plain_channel, "url": format!("{base}/media/a.gif")})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
}
