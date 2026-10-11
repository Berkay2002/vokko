#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Custom emoji: CRUD permissions, file and name validation, per-kind limits, role restriction, reactions and GUILD_EMOJIS_UPDATE fan-out.
mod common;
mod support_threads;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use support_threads::{Client, Member, World, code, world};
use tower::ServiceExt;
use vokko_protocol::api::permissions::{DEFAULT_EVERYONE, MANAGE_GUILD_EXPRESSIONS, USE_EXTERNAL_EMOJIS};

fn png() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&[0, 0, 0, 32, 0, 0, 0, 32, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

fn gif() -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&[32, 0, 32, 0, 0, 0, 0, 0x3b]);
    bytes
}

fn jpeg() -> Vec<u8> {
    vec![0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 32, 0, 32, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]
}

/// Uploads `data` as a pending attachment of the general channel; returns its id.
async fn upload(world: &World, user: &Member, filename: &str, data: &[u8]) -> String {
    upload_in(world, user, &world.general, filename, data).await
}

/// Uploads `data` as a pending attachment of `channel`; returns its id.
async fn upload_in(world: &World, user: &Member, channel: &str, filename: &str, data: &[u8]) -> String {
    let boundary = "vokkoemojiboundary";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n")
            .into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", &user.token)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .expect("request");
    let response = world.app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    let attachment: Value = serde_json::from_slice(&bytes).expect("json");
    attachment["id"].as_str().expect("id").to_owned()
}

async fn create(world: &World, user: &Member, name: &str, filename: &str, data: &[u8], roles: Value) -> (StatusCode, Value) {
    let attachment = upload(world, user, filename, data).await;
    world.app.post(&format!("/guilds/{}/emojis", world.guild), &user.token, json!({"name": name, "image_attachment_id": attachment, "roles": roles})).await
}

async fn create_ok(world: &World, name: &str, data: &[u8], roles: Value) -> Value {
    let filename = if data.starts_with(b"GIF") { "e.gif" } else { "e.png" };
    let (status, emoji) = create(world, &world.owner, name, filename, data, roles).await;
    assert_eq!(status, StatusCode::OK, "create emoji: {emoji}");
    emoji
}

/// GET without any auth header; returns status, content type and body bytes.
async fn fetch_image(world: &World, emoji_id: &str) -> (StatusCode, String, Vec<u8>) {
    let request = Request::builder().uri(format!("/api/v1/emojis/{emoji_id}")).body(Body::empty()).expect("request");
    let response = world.app.router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let content_type = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or_default().to_owned();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body").to_vec();
    (status, content_type, bytes)
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

async fn react(world: &World, channel: &str, message: &str, user: &Member, emoji: &str) -> (StatusCode, Value) {
    world.app.put(&format!("/channels/{channel}/messages/{message}/reactions/{}/@me", urlencode(emoji)), &user.token).await
}

fn urlencode(raw: &str) -> String {
    raw.bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'_' { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[tokio::test]
async fn crud_needs_manage_guild_expressions_and_members_can_read() {
    let world = world().await;
    let guild = world.guild.clone();

    // alice has only @everyone: listing works, creating does not
    let (status, error) = create(&world, &world.alice, "nope", "e.png", &png(), json!([])).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    // bob is not a member at all
    let (status, error) = world.app.get(&format!("/guilds/{guild}/emojis"), &world.bob.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50001)));

    let emoji = create_ok(&world, "blob_wave", &png(), json!([])).await;
    assert_eq!(emoji["name"], "blob_wave");
    assert_eq!(emoji["animated"], false);
    assert_eq!(emoji["roles"], json!([]));
    assert_eq!(emoji["user"]["id"], world.owner.id.as_str());
    assert_eq!((emoji["require_colons"].clone(), emoji["managed"].clone(), emoji["available"].clone()), (json!(true), json!(false), json!(true)));
    let emoji_id = id(&emoji);

    let (status, list) = world.app.get(&format!("/guilds/{guild}/emojis"), &world.alice.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().map(Vec::len), Some(1));
    assert_eq!(list[0]["user"]["username"], "sam");
    let (status, one) = world.app.get(&format!("/guilds/{guild}/emojis/{emoji_id}"), &world.alice.token).await;
    assert_eq!((status, one["name"].clone()), (StatusCode::OK, json!("blob_wave")));
    let (status, error) = world.app.get(&format!("/guilds/{guild}/emojis/123"), &world.alice.token).await;
    assert_eq!((status, code(&error)), (StatusCode::NOT_FOUND, Some(10014)));

    // the image is served by id without auth, and the url in the object serves the same bytes
    let (status, content_type, bytes) = fetch_image(&world, &emoji_id).await;
    assert_eq!((status, content_type.as_str(), bytes), (StatusCode::OK, "image/png", png()));
    assert!(emoji["url"].as_str().expect("url").starts_with("http://test.local/api/v1/attachments/"));

    // alice cannot edit or delete until a role grants MANAGE_GUILD_EXPRESSIONS
    let path = format!("/guilds/{guild}/emojis/{emoji_id}");
    assert_eq!(world.app.patch(&path, &world.alice.token, json!({"name": "renamed"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(world.app.delete(&path, &world.alice.token).await.0, StatusCode::FORBIDDEN);
    world.role_for(&world.alice, MANAGE_GUILD_EXPRESSIONS).await;
    let (status, renamed) = world.app.patch(&path, &world.alice.token, json!({"name": "renamed"})).await;
    assert_eq!((status, renamed["name"].clone()), (StatusCode::OK, json!("renamed")));
    let (status, error) = world.app.patch(&path, &world.alice.token, json!({"name": "x"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, mine) = create(&world, &world.alice, "alices", "a.gif", &gif(), json!([])).await;
    assert_eq!((status, mine["animated"].clone(), mine["user"]["username"].clone()), (StatusCode::OK, json!(true), json!("alice")));

    assert_eq!(world.app.delete(&path, &world.alice.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(world.app.delete(&path, &world.alice.token).await.0, StatusCode::NOT_FOUND);
    assert_eq!(fetch_image(&world, &emoji_id).await.0, StatusCode::NOT_FOUND);
    let (_, list) = world.app.get(&format!("/guilds/{guild}/emojis"), &world.owner.token).await;
    assert_eq!(list.as_array().map(|list| list.iter().map(|e| e["name"].clone()).collect::<Vec<_>>()), Some(vec![json!("alices")]));
}

#[tokio::test]
async fn bad_files_names_and_roles_are_rejected() {
    let world = world().await;
    let field_error = |value: &Value, field: &str| value["errors"][field].is_object();

    let (status, error) = create(&world, &world.owner, "photo", "a.jpg", &jpeg(), json!([])).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    assert!(field_error(&error, "image_attachment_id"), "{error}");
    let (status, error) = create(&world, &world.owner, "text", "a.txt", b"hello there", json!([])).await;
    assert!(status == StatusCode::BAD_REQUEST && field_error(&error, "image_attachment_id"), "{error}");
    let mut big = png();
    big.resize(256 * 1024 + 1, 0);
    let (status, error) = create(&world, &world.owner, "big", "big.png", &big, json!([])).await;
    assert!(status == StatusCode::BAD_REQUEST && field_error(&error, "image_attachment_id"), "{error}");
    let mut fits = png();
    fits.resize(256 * 1024, 0);
    assert_eq!(create(&world, &world.owner, "fits", "fits.png", &fits, json!([])).await.0, StatusCode::OK);

    for name in ["a", "has-dash", "spa ce", "ÅÄÖ", &"x".repeat(33)] {
        let (status, error) = create(&world, &world.owner, name, "e.png", &png(), json!([])).await;
        assert!(status == StatusCode::BAD_REQUEST && field_error(&error, "name"), "{name}: {error}");
    }

    // someone else's upload cannot be claimed, and one upload makes one emoji
    let alices = upload(&world, &world.alice, "e.png", &png()).await;
    let (status, error) =
        world.app.post(&format!("/guilds/{}/emojis", world.guild), &world.owner.token, json!({"name": "stolen", "image_attachment_id": alices})).await;
    assert!(status == StatusCode::BAD_REQUEST && field_error(&error, "image_attachment_id"), "{error}");
    let own = upload(&world, &world.owner, "e.png", &png()).await;
    let body = json!({"name": "once", "image_attachment_id": own});
    assert_eq!(world.app.post(&format!("/guilds/{}/emojis", world.guild), &world.owner.token, body.clone()).await.0, StatusCode::OK);
    assert_eq!(world.app.post(&format!("/guilds/{}/emojis", world.guild), &world.owner.token, body).await.0, StatusCode::BAD_REQUEST);

    // roles: @everyone and roles of other guilds are not accepted
    let (status, error) = create(&world, &world.owner, "everyone", "e.png", &png(), json!([world.guild])).await;
    assert!(status == StatusCode::BAD_REQUEST && field_error(&error, "roles"), "{error}");
    let (_, other) = world.app.post("/guilds", &world.owner.token, json!({"name": "Other"})).await;
    let (_, role) = world.app.post(&format!("/guilds/{}/roles", id(&other)), &world.owner.token, json!({"name": "elsewhere"})).await;
    let (status, error) = create(&world, &world.owner, "foreign", "e.png", &png(), json!([id(&role)])).await;
    assert!(status == StatusCode::BAD_REQUEST && field_error(&error, "roles"), "{error}");
}

#[tokio::test]
async fn static_and_animated_have_separate_caps_of_250() {
    let world = world().await;
    let template = create_ok(&world, "seed", &png(), json!([])).await;
    let attachment: (i64,) = sqlx::query_as("SELECT attachment_id FROM emojis WHERE id = $1")
        .bind(id(&template).parse::<i64>().expect("id"))
        .fetch_one(&world.app.state.db)
        .await
        .expect("row");
    for n in 1..250 {
        sqlx::query("INSERT INTO emojis (id, guild_id, name, animated, attachment_id) VALUES ($1, $2, $3, FALSE, $4)")
            .bind(world.app.state.ids.next())
            .bind(world.guild_id())
            .bind(format!("filler_{n}"))
            .bind(attachment.0)
            .execute(&world.app.state.db)
            .await
            .expect("filler");
    }
    let (status, error) = create(&world, &world.owner, "one_more", "e.png", &png(), json!([])).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(30008)));
    // animated emoji still have their own 250
    assert_eq!(create(&world, &world.owner, "dancing", "d.gif", &gif(), json!([])).await.0, StatusCode::OK);
    let (_, list) = world.app.get(&format!("/guilds/{}/emojis", world.guild), &world.owner.token).await;
    assert_eq!(list.as_array().map(Vec::len), Some(251));
}

#[tokio::test]
async fn reactions_with_custom_emoji_follow_membership_roles_and_external_rules() {
    let world = world().await;
    let role = world.role_for(&world.carol, 0).await;
    let open = create_ok(&world, "party", &gif(), json!([])).await;
    let locked = create_ok(&world, "vip", &png(), json!([role])).await;
    let message = world.say(&world.general, &world.owner, "react to me").await;
    let mid = id(&message);
    let general = world.general.clone();

    // unknown id → 400 10014; a malformed name → 400
    let (status, error) = react(&world, &general, &mid, &world.alice, "ghost:42").await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(10014)));
    // the id decides: a wrong name in the path still reacts with the stored name
    assert_eq!(react(&world, &general, &mid, &world.alice, &format!("whatever:{}", id(&open))).await.0, StatusCode::NO_CONTENT);
    // role-restricted: alice lacks the role, carol has it
    let (status, error) = react(&world, &general, &mid, &world.alice, &format!("vip:{}", id(&locked))).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    assert_eq!(react(&world, &general, &mid, &world.carol, &format!("vip:{}", id(&locked))).await.0, StatusCode::NO_CONTENT);
    assert_eq!(react(&world, &general, &mid, &world.carol, &format!("party:{}", id(&open))).await.0, StatusCode::NO_CONTENT);

    let messages = world.messages(&general, &world.alice).await;
    let reactions = messages.iter().find(|m| m["id"] == mid.as_str()).expect("message")["reactions"].clone();
    assert_eq!(
        reactions,
        json!([
            {"emoji": {"id": id(&open), "name": "party", "animated": true}, "count": 2, "me": true},
            {"emoji": {"id": id(&locked), "name": "vip", "animated": false}, "count": 1, "me": false}
        ])
    );
    let (status, users) = world.app.get(&format!("/channels/{general}/messages/{mid}/reactions/x_x:{}", id(&open)), &world.alice.token).await;
    assert_eq!((status, users.as_array().map(Vec::len)), (StatusCode::OK, Some(2)));

    // another guild: alice may use guild 1's emoji there (Nitro perk free), bob (not in guild 1) may not
    let (_, other) = world.app.post("/guilds", &world.alice.token, json!({"name": "Alice's place"})).await;
    let (_, channels) = world.app.get(&format!("/guilds/{}/channels", id(&other)), &world.alice.token).await;
    let elsewhere = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").map(id).expect("general");
    let (_, invite) = world.app.post(&format!("/channels/{elsewhere}/invites"), &world.alice.token, json!({})).await;
    world.app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &world.bob.token, json!({})).await;
    let (_, there) = world.app.post(&format!("/channels/{elsewhere}/messages"), &world.alice.token, json!({"content": "<a:party:1>"})).await;
    assert_eq!(react(&world, &elsewhere, &id(&there), &world.alice, &format!("party:{}", id(&open))).await.0, StatusCode::NO_CONTENT);
    let (status, error) = react(&world, &elsewhere, &id(&there), &world.bob, &format!("party:{}", id(&open))).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    // without USE_EXTERNAL_EMOJIS in that guild, nobody may bring outside emoji
    sqlx::query("UPDATE roles SET permissions = $2 WHERE id = $1")
        .bind(id(&other).parse::<i64>().expect("id"))
        .bind((DEFAULT_EVERYONE & !USE_EXTERNAL_EMOJIS) as i64)
        .execute(&world.app.state.db)
        .await
        .expect("strip external emoji");
    let (_, again) = world.app.post(&format!("/channels/{elsewhere}/messages"), &world.alice.token, json!({"content": "again"})).await;
    assert_eq!(react(&world, &elsewhere, &id(&again), &world.carol, &format!("party:{}", id(&open))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(react(&world, &elsewhere, &id(&again), &world.bob, "🎉").await.0, StatusCode::NO_CONTENT);

    // removing by id works with any name, and after deletion the reaction stays with id and name
    let removed = world.app.delete(&format!("/channels/{general}/messages/{mid}/reactions/other_name:{}/@me", id(&open)), &world.alice.token).await;
    assert_eq!(removed.0, StatusCode::NO_CONTENT);
    assert_eq!(world.app.delete(&format!("/guilds/{}/emojis/{}", world.guild, id(&open)), &world.owner.token).await.0, StatusCode::NO_CONTENT);
    let messages = world.messages(&general, &world.carol).await;
    let reactions = messages.iter().find(|m| m["id"] == mid.as_str()).expect("message")["reactions"].clone();
    let party = reactions.as_array().expect("reactions").iter().find(|r| r["emoji"]["id"] == id(&open).as_str()).expect("party stays").clone();
    assert_eq!(party, json!({"emoji": {"id": id(&open), "name": "party"}, "count": 1, "me": true}));
}

#[tokio::test]
async fn gateway_carries_emojis_and_fans_out_updates_to_members_only() {
    let world = world().await;
    let created = create_ok(&world, "early", &png(), json!([])).await;
    let mut alice = Client::connect(&world.address, &world.alice.token).await;
    let mut bob = Client::connect(&world.address, &world.bob.token).await;

    // READY guild entries carry the emoji without the uploader
    let guild = alice.ready["guilds"].as_array().expect("guilds").iter().find(|g| g["id"] == world.guild.as_str()).expect("guild").clone();
    assert_eq!(guild["emojis"].as_array().map(Vec::len), Some(1));
    assert_eq!(guild["emojis"][0]["name"], "early");
    assert!(guild["emojis"][0].get("user").is_none());

    let second = create_ok(&world, "later", &gif(), json!([])).await;
    let update = alice.wait_for("GUILD_EMOJIS_UPDATE").await;
    assert_eq!(update["guild_id"], world.guild.as_str());
    let names: Vec<Value> = update["emojis"].as_array().expect("emojis").iter().map(|e| e["name"].clone()).collect();
    assert_eq!(names, vec![json!("early"), json!("later")]);
    assert!(update["emojis"][1].get("user").is_none());

    world.app.patch(&format!("/guilds/{}/emojis/{}", world.guild, id(&second)), &world.owner.token, json!({"name": "renamed"})).await;
    let update = alice.wait_for("GUILD_EMOJIS_UPDATE").await;
    assert_eq!(update["emojis"][1]["name"], "renamed");

    world.app.delete(&format!("/guilds/{}/emojis/{}", world.guild, id(&created)), &world.owner.token).await;
    let update = alice.wait_for("GUILD_EMOJIS_UPDATE").await;
    assert_eq!(update["emojis"].as_array().map(Vec::len), Some(1));
    assert!(bob.silent_for("GUILD_EMOJIS_UPDATE", Duration::from_millis(300), |_| true).await);

    // reaction events carry the custom emoji with `animated`
    let message = world.say(&world.general, &world.owner, "hi").await;
    react(&world, &world.general, &id(&message), &world.owner, &format!("renamed:{}", id(&second))).await;
    let event = alice.wait_for("MESSAGE_REACTION_ADD").await;
    assert_eq!(event["emoji"], json!({"id": id(&second), "name": "renamed", "animated": true}));

    // a member who joins gets the list in GUILD_CREATE
    let (_, invite) = world.app.post(&format!("/channels/{}/invites", world.general), &world.owner.token, json!({})).await;
    world.app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &world.bob.token, json!({})).await;
    let joined = bob.wait_id("GUILD_CREATE", &world.guild).await;
    assert_eq!(joined["emojis"][0]["name"], "renamed");
}

#[tokio::test]
async fn emoji_images_cannot_become_profile_images_and_never_block_account_deletion() {
    let world = world().await;
    world.role_for(&world.alice, MANAGE_GUILD_EXPRESSIONS).await;
    let upload_id = upload(&world, &world.alice, "e.png", &png()).await;
    let (status, emoji) =
        world.app.post(&format!("/guilds/{}/emojis", world.guild), &world.alice.token, json!({"name": "mine", "image_attachment_id": upload_id})).await;
    assert_eq!(status, StatusCode::OK, "create emoji: {emoji}");

    // a claimed emoji image is refused as an avatar and as a guild icon
    let (status, _) = world.app.patch("/users/@me", &world.alice.token, json!({"avatar_attachment_id": upload_id})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = world.app.post("/guilds", &world.alice.token, json!({"name": "Iconic", "icon_attachment_id": upload_id})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // an emoji created before that rule existed (an avatar upload that is an emoji too) still survives the account's deletion
    let legacy = upload(&world, &world.alice, "old.png", &png()).await;
    let (status, _) = world.app.patch("/users/@me", &world.alice.token, json!({"avatar_attachment_id": legacy})).await;
    assert_eq!(status, StatusCode::OK);
    let legacy_emoji = world.app.state.ids.next();
    sqlx::query("INSERT INTO emojis (id, guild_id, name, animated, attachment_id, uploader_id) VALUES ($1, $2, 'legacy', FALSE, $3, $4)")
        .bind(legacy_emoji)
        .bind(world.guild_id())
        .bind(legacy.parse::<i64>().expect("attachment id"))
        .bind(world.alice.id.parse::<i64>().expect("user id"))
        .execute(&world.app.state.db)
        .await
        .expect("insert emoji");

    let (status, body) = world.app.post("/users/@me/delete", &world.alice.token, json!({"password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(fetch_image(&world, &id(&emoji)).await.0, StatusCode::OK, "the emoji image stays");
    assert_eq!(fetch_image(&world, &legacy_emoji.to_string()).await.0, StatusCode::OK, "so does the one that doubled as an avatar");
}

#[tokio::test]
async fn an_emoji_survives_deleting_the_channel_it_was_uploaded_through() {
    let world = world().await;
    let channel = world.channel(json!({"name": "scratch", "type": 0})).await;
    let channel_id = id(&channel);
    let attachment = upload_in(&world, &world.owner, &channel_id, "e.png", &png()).await;
    let (status, emoji) =
        world.app.post(&format!("/guilds/{}/emojis", world.guild), &world.owner.token, json!({"name": "kept", "image_attachment_id": attachment})).await;
    assert_eq!(status, StatusCode::OK, "create emoji: {emoji}");

    let (status, body) = world.app.delete(&format!("/channels/{channel_id}"), &world.owner.token).await;
    assert!(status.is_success(), "delete channel: {status} {body}");
    assert_eq!(fetch_image(&world, &id(&emoji)).await.0, StatusCode::OK);
    let (status, _) = world.app.get(&format!("/guilds/{}/emojis/{}", world.guild, id(&emoji)), &world.owner.token).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn deleting_a_guild_removes_its_emoji_images() {
    let world = world().await;
    let emoji = create_ok(&world, "doomed", &png(), json!([])).await;
    let emoji_id = id(&emoji);
    let (attachment,): (i64,) = sqlx::query_as("SELECT attachment_id FROM emojis WHERE id = $1")
        .bind(emoji_id.parse::<i64>().expect("emoji id"))
        .fetch_one(&world.app.state.db)
        .await
        .expect("row");
    assert_eq!(world.app.delete(&format!("/guilds/{}", world.guild), &world.owner.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(fetch_image(&world, &emoji_id).await.0, StatusCode::NOT_FOUND);
    let (left,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM attachments WHERE id = $1").bind(attachment).fetch_one(&world.app.state.db).await.expect("count");
    assert_eq!(left, 0, "the attachment row is gone");
}
