#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Attachment contract: rename / SPOILER_ / alt text on send, keep-list on edit.
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn setup() -> (TestApp, String, String) {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&owner).await;
    (app, owner, channel)
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

async fn upload(app: &TestApp, token: &str, channel: &str, filename: &str) -> Value {
    upload_as(app, token, channel, filename, "image/png", &png(8, 8)).await
}

async fn upload_as(app: &TestApp, token: &str, channel: &str, filename: &str, content_type: &str, bytes: &[u8]) -> Value {
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n").into_bytes();
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

fn path_of(url: &str) -> String {
    url.strip_prefix("http://test.local").expect("test origin").to_owned()
}

async fn status_of(app: &TestApp, path: &str) -> StatusCode {
    app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response").status()
}

#[tokio::test]
async fn rename_spoiler_and_alt_text_round_trip() {
    let (app, owner, channel) = setup().await;
    let first = upload(&app, &owner, &channel, "cat.png").await;
    let second = upload(&app, &owner, &channel, "dog.png").await;
    let third = upload(&app, &owner, &channel, "bird.png").await;
    let (status, message) = app
        .post(
            &format!("/channels/{channel}/messages"),
            &owner,
            json!({"attachments": [
                {"id": first["id"], "filename": "SPOILER_cat.png", "description": "a cat on a sofa"},
                {"id": second["id"], "description": "  "},
                {"id": third["id"], "filename": "../bird renamed.png"},
            ]}),
        )
        .await;
    assert_eq!(status, 200, "{message}");
    let attachments = message["attachments"].as_array().expect("attachments");
    assert_eq!(attachments[0]["filename"], "SPOILER_cat.png");
    assert_eq!(attachments[0]["description"], "a cat on a sofa");
    assert_eq!(attachments[1]["filename"], "dog.png");
    assert!(attachments[1].get("description").is_none(), "{message}");
    assert_eq!(attachments[2]["filename"], "bird renamed.png", "directories are stripped like on upload");
    // the renamed file is served under its new name only
    let url = attachments[0]["url"].as_str().expect("url");
    assert!(url.ends_with("/SPOILER_cat.png"), "{url}");
    assert_eq!(status_of(&app, &path_of(url)).await, 200);
    assert_eq!(status_of(&app, &path_of(first["url"].as_str().expect("url"))).await, 404);

    // history returns them too
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert_eq!(history[0]["attachments"][0]["description"], "a cat on a sofa");
    assert_eq!(history[0]["attachments"][0]["filename"], "SPOILER_cat.png");
}

#[tokio::test]
async fn attachment_meta_is_validated() {
    let (app, owner, channel) = setup().await;
    let file = upload(&app, &owner, &channel, "a.png").await;
    let path = format!("/channels/{channel}/messages");
    let (status, error) = app.post(&path, &owner, json!({"attachments": [{"id": file["id"], "description": "x".repeat(1025)}]})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    let (status, _) = app.post(&path, &owner, json!({"attachments": [{"id": file["id"], "filename": "x".repeat(256)}]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.post(&path, &owner, json!({"attachments": [{"id": file["id"], "filename": "   "}]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // 1024 characters is fine, and the upload was not consumed by the failed attempts
    let (status, message) = app.post(&path, &owner, json!({"attachments": [{"id": file["id"], "description": "x".repeat(1024)}]})).await;
    assert_eq!(status, 200, "{message}");
    // `attachments` wins over `attachment_ids`
    let other = upload(&app, &owner, &channel, "b.png").await;
    let (status, message) = app.post(&path, &owner, json!({"attachment_ids": [file["id"]], "attachments": [{"id": other["id"]}]})).await;
    assert_eq!(status, 200, "{message}");
    assert_eq!(message["attachments"][0]["id"], other["id"]);
}

#[tokio::test]
async fn edit_keep_list_removes_attachments_and_their_files() {
    let (app, owner, channel) = setup().await;
    let keep = upload(&app, &owner, &channel, "keep.png").await;
    let drop = upload(&app, &owner, &channel, "drop.png").await;
    let (_, message) = app
        .post(&format!("/channels/{channel}/messages"), &owner, json!({"content": "two files", "attachments": [{"id": keep["id"]}, {"id": drop["id"]}]}))
        .await;
    let mid = message["id"].as_str().expect("id").to_owned();
    let drop_id: i64 = drop["id"].as_str().expect("id").parse().expect("id");
    let keep_id: i64 = keep["id"].as_str().expect("id").parse().expect("id");
    assert!(vokko_server::media::file_path(&app.state, drop_id).exists());
    let drop_url = path_of(message["attachments"][1]["url"].as_str().expect("url"));
    assert_eq!(status_of(&app, &drop_url).await, 200);

    // omitted keep-list: unchanged
    let (status, same) = app.patch(&format!("/channels/{channel}/messages/{mid}"), &owner, json!({"content": "still two"})).await;
    assert_eq!(status, 200, "{same}");
    assert_eq!(same["attachments"].as_array().expect("attachments").len(), 2);

    // keep one; ids that are not on the message are ignored (it cannot add)
    let (status, edited) =
        app.patch(&format!("/channels/{channel}/messages/{mid}"), &owner, json!({"attachments": [{"id": keep["id"]}, {"id": "12345"}]})).await;
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["attachments"].as_array().expect("attachments").len(), 1);
    assert_eq!(edited["attachments"][0]["id"], keep["id"]);
    assert_eq!(edited["content"], "still two", "content omitted = unchanged");
    assert!(edited["edited_timestamp"].is_string());
    assert!(!vokko_server::media::file_path(&app.state, drop_id).exists(), "the removed file is deleted");
    assert!(vokko_server::media::file_path(&app.state, keep_id).exists());
    assert_eq!(status_of(&app, &drop_url).await, 404);
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM attachments WHERE id = $1").bind(drop_id).fetch_one(&app.state.db).await.expect("count");
    assert_eq!(count, 0);

    // a result with neither content nor attachments is 400 50006 and changes nothing
    let (status, error) = app.patch(&format!("/channels/{channel}/messages/{mid}"), &owner, json!({"content": "", "attachments": []})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50006)), "{error}");
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert_eq!(history[0]["attachments"].as_array().expect("attachments").len(), 1);
    assert_eq!(history[0]["content"], "still two");

    // an attachment-only message may not drop its last file
    let solo = upload(&app, &owner, &channel, "solo.png").await;
    let (_, only) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"attachments": [{"id": solo["id"]}]})).await;
    let only_id = only["id"].as_str().expect("id");
    let (status, error) = app.patch(&format!("/channels/{channel}/messages/{only_id}"), &owner, json!({"attachments": []})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50006)), "{error}");
    // a text-only message edited to empty: same code
    let (_, text) = app.post(&format!("/channels/{channel}/messages"), &owner, json!({"content": "hi"})).await;
    let text_id = text["id"].as_str().expect("id");
    let (status, error) = app.patch(&format!("/channels/{channel}/messages/{text_id}"), &owner, json!({"content": "  "})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50006)), "{error}");
}

#[tokio::test]
async fn voice_messages_need_send_voice_messages() {
    let (app, owner, channel) = setup().await;
    let (member, _) = app.register("alice").await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    let base = format!("/channels/{channel}/messages");
    const VOICE: u32 = 1 << 13;
    let voice = |clip: &Value| json!({"attachments": [{"id": clip["id"], "duration_secs": 3.5, "waveform": "AAAAgP8="}], "flags": VOICE});

    // @everyone does not have SEND_VOICE_MESSAGES: refused, the same file as a plain attachment is fine
    let clip = upload_ogg(&app, &member, &channel).await;
    let (status, error) = app.post(&base, &member, voice(&clip)).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)), "{error}");
    let (status, plain) = app.post(&base, &member, json!({"attachment_ids": [clip["id"]], "flags": 4})).await;
    assert_eq!(status, StatusCode::OK, "{plain}");
    assert_eq!(plain["flags"].as_u64().unwrap_or(0), 0, "other create flags are ignored: {plain}");

    // the owner holds it: one attachment and nothing else
    let clip = upload_ogg(&app, &owner, &channel).await;
    let other = upload_ogg(&app, &owner, &channel).await;
    let (status, _) = app.post(&base, &owner, json!({"attachment_ids": [clip["id"], other["id"]], "flags": VOICE})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut with_content = voice(&clip);
    with_content["content"] = json!("hi");
    let (status, _) = app.post(&base, &owner, with_content).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, sent) = app.post(&base, &owner, voice(&clip)).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["flags"], VOICE);
}

#[tokio::test]
async fn voice_message_duration_and_waveform_round_trip() {
    let (app, owner, channel) = setup().await;
    let base = format!("/channels/{channel}/messages");
    const VOICE: u32 = 1 << 13;
    let send =
        |id: &Value, duration: Value, waveform: Value| json!({"attachments": [{"id": id, "duration_secs": duration, "waveform": waveform}], "flags": VOICE});
    let clip = upload_as(&app, &owner, &channel, "voice-message.webm", "audio/webm;codecs=opus", b"\x1a\x45\xdf\xa3webm").await;

    // both fields are required and checked: (0, 1200] seconds, base64 of 1-256 bytes
    let (status, _) = app.post(&base, &owner, json!({"attachment_ids": [clip["id"]], "flags": VOICE})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "plain ids carry no waveform");
    for (duration, waveform) in [
        (json!(0), json!("AAAA")),
        (json!(1200.5), json!("AAAA")),
        (json!(2), json!("")),
        (json!(2), json!("not base64!")),
        (json!(2), json!(base64_of(&[7u8; 257]))),
    ] {
        let (status, error) = app.post(&base, &owner, send(&clip["id"], duration.clone(), waveform)).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{duration}: {error}");
    }

    // only audio: an image upload is refused
    let image = upload(&app, &owner, &channel, "cat.png").await;
    let (status, _) = app.post(&base, &owner, send(&image["id"], json!(2), json!("AAAA"))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let waveform = base64_of(&(0..=255u8).collect::<Vec<_>>());
    let (status, sent) = app.post(&base, &owner, send(&clip["id"], json!(1200), json!(waveform))).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    let attachment = &sent["attachments"][0];
    assert_eq!(
        (attachment["duration_secs"].clone(), attachment["waveform"].clone(), attachment["content_type"].clone()),
        (json!(1200.0), json!(waveform), json!("audio/webm"))
    );
    let (_, page) = app.get(&format!("{base}?limit=1"), &owner).await;
    assert_eq!(page[0]["attachments"][0]["waveform"], json!(waveform), "stored: {page}");
    assert_eq!(page[0]["attachments"][0]["duration_secs"], json!(1200.0));

    // a voice message cannot be edited; ordinary attachments never carry the fields
    let (status, _) = app.patch(&format!("{base}/{}", sent["id"].as_str().expect("id")), &owner, json!({"content": "words"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let other = upload(&app, &owner, &channel, "dog.png").await;
    let (_, plain) = app.post(&base, &owner, json!({"attachments": [{"id": other["id"], "duration_secs": 3, "waveform": "AAAA"}]})).await;
    assert!(plain["attachments"][0].get("waveform").is_none(), "{plain}");
}

async fn upload_ogg(app: &TestApp, token: &str, channel: &str) -> Value {
    upload_as(app, token, channel, "voice-message.ogg", "audio/ogg", b"OggS\0\x02voice").await
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
