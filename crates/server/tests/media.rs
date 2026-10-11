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
    let big = vec![b'a'; 10 * 1024 * 1024 + 1];
    let (status, body) = upload(&app, &owner, &channel, "big.bin", "application/octet-stream", &big).await;
    assert_eq!(status, 413, "{body}");
    assert_eq!(body["code"], 40005);
    // far beyond the body limit: still 413 / 40005, not a generic 400
    let huge = vec![b'a'; 16 * 1024 * 1024];
    let (status, body) = upload(&app, &owner, &channel, "huge.bin", "application/octet-stream", &huge).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::PAYLOAD_TOO_LARGE, json!(40005)), "{body}");
    let ok = vec![b'a'; 1024 * 1024];
    let (status, _) = upload(&app, &owner, &channel, "ok.bin", "application/octet-stream", &ok).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn ten_attachments_per_message() {
    let (app, owner, _, channel, _) = setup().await;
    let mut ids = Vec::new();
    for index in 0..11 {
        let (status, attachment) = upload(&app, &owner, &channel, &format!("p{index}.png"), "image/png", &png(2, 2)).await;
        assert_eq!(status, 200);
        ids.push(attachment["id"].clone());
    }
    let (status, _) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"attachment_ids": ids})).await;
    assert_eq!(status, 400);
    ids.pop();
    let (status, message) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"attachment_ids": ids})).await;
    assert_eq!(status, 200);
    assert_eq!(message["attachments"].as_array().expect("attachments").len(), 10);
}

async fn fetch(app: &TestApp, path: &str) -> axum::response::Response {
    app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response")
}

fn path_of(url: &str) -> String {
    url.strip_prefix("http://test.local").expect("prefix").to_owned()
}

#[tokio::test]
async fn attachment_urls_carry_an_unguessable_key() {
    let (app, owner, _, channel, _) = setup().await;
    let (_, attachment) = upload(&app, &owner, &channel, "my pic.png", "image/png", &png(8, 8)).await;
    let id = attachment["id"].as_str().expect("id");
    let url = attachment["url"].as_str().expect("url");
    let rest = url.strip_prefix("http://test.local/api/v1/attachments/").expect("shape");
    let parts: Vec<&str> = rest.split('/').collect();
    assert_eq!(parts.len(), 3, "{url}");
    assert_eq!(parts[0], id);
    assert_eq!(parts[1].len(), 32);
    assert!(parts[1].bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(parts[2], "my%20pic.png");
    assert_eq!(fetch(&app, &path_of(url)).await.status(), 200);

    let key = parts[1];
    let wrong_key = format!("/api/v1/attachments/{id}/{}/my%20pic.png", "0".repeat(32));
    let wrong_name = format!("/api/v1/attachments/{id}/{key}/other.png");
    let no_key = format!("/api/v1/attachments/{id}/my%20pic.png");
    for path in [wrong_key, wrong_name, no_key] {
        let response = fetch(&app, &path).await;
        assert_eq!(response.status(), 404, "{path}");
    }

    // a row from before keys existed is never served
    let numeric: i64 = id.parse().expect("id");
    sqlx::query("UPDATE attachments SET key = NULL WHERE id = $1").bind(numeric).execute(&app.state.db).await.expect("update");
    assert_eq!(fetch(&app, &path_of(url)).await.status(), 404);
}

#[tokio::test]
async fn avatar_and_icon_urls_download() {
    let (app, owner, _, channel, guild) = setup().await;
    let (_, avatar) = upload(&app, &owner, &channel, "me.png", "image/png", &png(4, 4)).await;
    let (status, user) = app.patch("/users/@me", &owner, json!({"avatar_attachment_id": avatar["id"]})).await;
    assert_eq!(status, 200, "{user}");
    let avatar_url = user["avatar"].as_str().expect("avatar").to_owned();
    assert_eq!(avatar_url, avatar["url"].as_str().expect("url"));
    assert_eq!(fetch(&app, &path_of(&avatar_url)).await.status(), 200);

    let (_, icon) = upload(&app, &owner, &channel, "icon.png", "image/png", &png(4, 4)).await;
    let (status, updated) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"icon_attachment_id": icon["id"]})).await;
    assert_eq!(status, 200, "{updated}");
    let icon_url = updated["icon"].as_str().expect("icon").to_owned();
    assert_eq!(fetch(&app, &path_of(&icon_url)).await.status(), 200);
}

#[tokio::test]
async fn large_downloads_stream_with_content_length() {
    let (app, owner, _, channel, _) = setup().await;
    let data: Vec<u8> = (0..5 * 1024 * 1024_u32).map(|i| (i % 251) as u8).collect();
    let (status, attachment) = upload(&app, &owner, &channel, "big.bin", "application/octet-stream", &data).await;
    assert_eq!(status, 200);
    let response = fetch(&app, &path_of(attachment["url"].as_str().expect("url"))).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-length"], data.len().to_string().as_str());
    assert_eq!(response.headers()["cache-control"], "private, max-age=86400");
    assert!(response.headers()["content-disposition"].to_str().expect("header").starts_with("attachment"));
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    assert!(body.as_ref() == data.as_slice(), "streamed body differs");
}

#[tokio::test]
async fn cleanup_removes_only_stale_pending_uploads() {
    let (app, owner, _, channel, _) = setup().await;
    let (_, stale) = upload(&app, &owner, &channel, "stale.bin", "application/octet-stream", b"stale").await;
    let (_, attached) = upload(&app, &owner, &channel, "kept.bin", "application/octet-stream", b"kept").await;
    let (_, avatar) = upload(&app, &owner, &channel, "me.png", "image/png", &png(4, 4)).await;
    let (_, fresh) = upload(&app, &owner, &channel, "fresh.bin", "application/octet-stream", b"fresh").await;
    let (status, _) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"content": "x", "attachment_ids": [attached["id"]]})).await;
    assert_eq!(status, 200);
    let (status, _) = app.patch("/users/@me", &owner, json!({"avatar_attachment_id": avatar["id"]})).await;
    assert_eq!(status, 200);
    let ids: Vec<i64> = [&stale, &attached, &avatar, &fresh].iter().map(|a| a["id"].as_str().expect("id").parse().expect("id")).collect();
    sqlx::query("UPDATE attachments SET created_at = now() - interval '2 hours' WHERE id = ANY($1)").bind(&ids[..3]).execute(&app.state.db).await.expect("age");

    let removed = vokko_server::media::cleanup_pending(&app.state, std::time::Duration::from_secs(3600)).await;
    assert_eq!(removed, 1);
    let remaining: Vec<(i64,)> =
        sqlx::query_as("SELECT id FROM attachments WHERE id = ANY($1) ORDER BY id").bind(&ids).fetch_all(&app.state.db).await.expect("rows");
    let remaining: Vec<i64> = remaining.into_iter().map(|(id,)| id).collect();
    assert!(!remaining.contains(&ids[0]));
    assert!(ids[1..].iter().all(|id| remaining.contains(id)));
    assert!(!vokko_server::media::file_path(&app.state, ids[0]).exists());
    assert!(vokko_server::media::file_path(&app.state, ids[1]).exists());
    assert!(vokko_server::media::file_path(&app.state, ids[2]).exists());
    let (_, user) = app.get("/users/@me", &owner).await;
    assert_eq!(fetch(&app, &path_of(user["avatar"].as_str().expect("avatar"))).await.status(), 200);
}

#[tokio::test]
async fn pending_uploads_have_a_quota() {
    let (app, owner, member, channel, _) = setup().await;
    // pre-fill 95 MiB of pending rows for the owner directly in the database
    sqlx::query(
        "INSERT INTO attachments (id, channel_id, uploader_id, filename, size, key) \
         SELECT 9000000000000 + g, $1, u.id, 'filler', 5 * 1024 * 1024, 'k' FROM generate_series(1, 19) g, users u WHERE u.username = 'sam'",
    )
    .bind(channel.parse::<i64>().expect("channel"))
    .execute(&app.state.db)
    .await
    .expect("filler");
    let chunk = vec![b'a'; 4 * 1024 * 1024];
    let (status, body) = upload(&app, &owner, &channel, "ok.bin", "application/octet-stream", &chunk).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = upload(&app, &owner, &channel, "too-much.bin", "application/octet-stream", &chunk).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::PAYLOAD_TOO_LARGE, json!(40005)), "{body}");
    assert!(body["message"].as_str().expect("message").contains("100 MiB"));
    // quota is per user
    let (status, _) = upload(&app, &member, &channel, "mine.bin", "application/octet-stream", &chunk).await;
    assert_eq!(status, 200);
}
