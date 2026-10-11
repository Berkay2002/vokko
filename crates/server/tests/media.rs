mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;

const THUMBS_UP: &str = "%F0%9F%91%8D";

async fn setup() -> (TestApp, String, String, String, String) {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, _) = app.register("alice").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Media guild"})).await;
    let guild_id = guild["id"].as_str().expect("id").to_owned();
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    let channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    (app, owner, member, channel, guild_id)
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

async fn upload(app: &TestApp, token: &str, channel: &str, filename: &str, declared: &str, data: &[u8]) -> (StatusCode, Value) {
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
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn reaction_counts_and_me_are_per_viewer() {
    let (app, owner, member, channel, _) = setup().await;
    let (_, message) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"content": "react to me"})).await;
    let url = format!("/channels/{channel}/messages/{}/reactions/{THUMBS_UP}/@me", message["id"].as_str().expect("id"));
    assert_eq!(app.put(&url, &owner).await.0, 204);
    assert_eq!(app.put(&url, &member).await.0, 204);
    assert_eq!(app.put(&url, &member).await.0, 204, "adding twice is idempotent");
    let custom = format!("/channels/{channel}/messages/{}/reactions/party:123456789/@me", message["id"].as_str().expect("id"));
    assert_eq!(app.put(&custom, &member).await.0, 204);

    let (_, messages) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    let reactions = messages[0]["reactions"].as_array().expect("reactions");
    assert_eq!(reactions.len(), 2);
    let thumbs = reactions.iter().find(|r| r["emoji"]["name"] == "👍").expect("unicode reaction");
    assert_eq!((thumbs["count"].clone(), thumbs["me"].clone()), (json!(2), json!(true)));
    assert_eq!(thumbs["emoji"]["id"], Value::Null);
    let party = reactions.iter().find(|r| r["emoji"]["name"] == "party").expect("custom reaction");
    assert_eq!((party["count"].clone(), party["me"].clone(), party["emoji"]["id"].clone()), (json!(1), json!(false), json!("123456789")));

    let (_, reactors) = app.get(&format!("/channels/{channel}/messages/{}/reactions/{THUMBS_UP}", message["id"].as_str().expect("id")), &owner).await;
    assert_eq!(reactors.as_array().expect("users").len(), 2);

    assert_eq!(app.delete(&url, &member).await.0, 204);
    let (_, messages) = app.get(&format!("/channels/{channel}/messages"), &member).await;
    let thumbs = messages[0]["reactions"].as_array().expect("reactions").iter().find(|r| r["emoji"]["name"] == "👍").expect("still there").clone();
    assert_eq!((thumbs["count"].clone(), thumbs["me"].clone()), (json!(1), json!(false)));
}

#[tokio::test]
async fn reaction_limits_and_access() {
    let (app, owner, _, channel, _) = setup().await;
    let (outsider, _) = app.register("bob").await;
    let (_, message) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"content": "many"})).await;
    let mid = message["id"].as_str().expect("id");
    assert_eq!(app.put(&format!("/channels/{channel}/messages/{mid}/reactions/{THUMBS_UP}/@me"), &outsider).await.0, 403);
    for index in 0..20 {
        let status = app.put(&format!("/channels/{channel}/messages/{mid}/reactions/e{index:02}:{}/@me", 1000 + index), &owner).await.0;
        assert_eq!(status, 204);
    }
    let (status, body) = app.put(&format!("/channels/{channel}/messages/{mid}/reactions/{THUMBS_UP}/@me"), &owner).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(30010)));
}

#[tokio::test]
async fn upload_and_serve_attachments() {
    let (app, owner, member, channel, _) = setup().await;
    let (status, attachment) = upload(&app, &owner, &channel, "pic.png", "application/octet-stream", &png(640, 480)).await;
    assert_eq!(status, 200, "{attachment}");
    assert_eq!(attachment["content_type"], "image/png");
    assert_eq!((attachment["width"].clone(), attachment["height"].clone()), (json!(640), json!(480)));
    let url = attachment["url"].as_str().expect("url").to_owned();
    assert!(url.starts_with("http://test.local/api/v1/attachments/"), "{url}");
    let path = url.strip_prefix("http://test.local").expect("prefix").to_owned();

    let response = app.router.clone().oneshot(Request::builder().uri(&path).body(Body::empty()).expect("request")).await.expect("response");
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert!(response.headers()["content-disposition"].to_str().expect("header").starts_with("inline"));
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body").to_vec(), png(640, 480));

    // an HTML upload is neither inline nor served as html
    let (status, page) = upload(&app, &owner, &channel, "evil.html", "text/html", b"<script>alert(1)</script>").await;
    assert_eq!(status, 200);
    assert_eq!(page["content_type"], "application/octet-stream");
    assert_eq!(page["width"], Value::Null);
    let page_path = page["url"].as_str().expect("url").strip_prefix("http://test.local").expect("prefix").to_owned();
    let response = app.router.clone().oneshot(Request::builder().uri(&page_path).body(Body::empty()).expect("request")).await.expect("response");
    assert!(response.headers()["content-disposition"].to_str().expect("header").starts_with("attachment"));

    // attach to a message
    let (status, message) = app.post(&format!("/channels/{channel}/messages"), &member, json!({"content": "look", "attachment_ids": [attachment["id"]]})).await;
    // the attachment belongs to the owner: member may not reuse it
    assert_ne!(status, 200, "{message}");
    let (status, message) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"content": "look", "attachment_ids": [attachment["id"]]})).await;
    assert_eq!(status, 200, "{message}");
    assert_eq!(message["attachments"][0]["filename"], "pic.png");
    assert_eq!(message["attachments"][0]["width"], 640);

    // unknown attachments and missing credentials
    let response =
        app.router.clone().oneshot(Request::builder().uri("/api/v1/attachments/1/x.png").body(Body::empty()).expect("request")).await.expect("response");
    assert_eq!(response.status(), 404);
    let (status, _) = upload(&app, "bad-token", &channel, "pic.png", "image/png", &png(1, 1)).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn oversized_upload_is_rejected() {
    let (app, owner, _, channel, _) = setup().await;
    let big = vec![b'a'; 25 * 1024 * 1024 + 1];
    let (status, body) = upload(&app, &owner, &channel, "big.bin", "application/octet-stream", &big).await;
    assert_eq!(status, 413, "{body}");
    assert_eq!(body["code"], 40005);
    let ok = vec![b'a'; 1024 * 1024];
    let (status, _) = upload(&app, &owner, &channel, "ok.bin", "application/octet-stream", &ok).await;
    assert_eq!(status, 200);
}
