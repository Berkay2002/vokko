#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Stickers, GIF proxy, forwards, bookmarks and reminders.
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_protocol::api::permissions::{MANAGE_GUILD_EXPRESSIONS, USE_EXTERNAL_STICKERS};

struct World {
    app: TestApp,
    owner: String,
    member: String,
    member_id: String,
    guild: String,
    channel: String,
}

async fn world_with(adjust: impl FnOnce(&mut vokko_server::Config)) -> World {
    let app = TestApp::with_config(adjust).await;
    let (owner, _) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &member).await;
    World { app, owner, member, member_id: member_user["id"].as_str().expect("id").to_owned(), guild, channel }
}

async fn world() -> World {
    world_with(|_| {}).await
}

async fn join(app: &TestApp, owner: &str, channel: &str, user: &str) {
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), owner, json!({})).await;
    let (status, body) = app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), user, json!({})).await;
    assert_eq!(status, StatusCode::OK, "join: {body}");
}

fn png(width: u32, height: u32, extra: usize) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes.extend(std::iter::repeat_n(7_u8, extra));
    bytes
}

fn apng(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = png(width, height, 0);
    bytes.extend_from_slice(&8_u32.to_be_bytes());
    bytes.extend_from_slice(b"acTL");
    bytes.extend_from_slice(&[0; 12]);
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(b"IDAT");
    bytes.extend_from_slice(&[0; 4]);
    bytes
}

async fn upload(app: &TestApp, token: &str, channel: &str, filename: &str, data: &[u8]) -> Value {
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n")
            .into_bytes();
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
    assert_eq!(response.status(), 200);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("attachment json")
}

async fn fetch_status(app: &TestApp, url: &str) -> StatusCode {
    let path = url.strip_prefix("http://test.local").expect("test origin");
    app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response").status()
}

impl World {
    async fn sticker(&self, token: &str, guild: &str, name: &str, data: &[u8]) -> (StatusCode, Value) {
        let attachment = upload(&self.app, token, &self.channel_for(guild), "s.png", data).await;
        self.app.post(&format!("/guilds/{guild}/stickers"), token, json!({"name": name, "tags": "wave,hello", "attachment_id": attachment["id"]})).await
    }

    fn channel_for(&self, _guild: &str) -> String {
        self.channel.clone()
    }

    async fn role_for_member(&self, permissions: u64) {
        let (status, role) =
            self.app.post(&format!("/guilds/{}/roles", self.guild), &self.owner, json!({"name": "creators", "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "{role}");
        let (status, body) = self.app.patch(&format!("/guilds/{}/members/{}", self.guild, self.member_id), &self.owner, json!({"roles": [role["id"]]})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    async fn say(&self, token: &str, channel: &str, body: Value) -> (StatusCode, Value) {
        self.app.post(&format!("/channels/{channel}/messages"), token, body).await
    }
}

#[tokio::test]
async fn sticker_lifecycle_validation_and_permissions() {
    let w = world().await;
    // a plain member can neither upload, edit nor delete
    let (status, _) = w.sticker(&w.member, &w.guild, "nope", &png(64, 64, 0)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, sticker) = w.sticker(&w.owner, &w.guild, "wave", &png(64, 64, 0)).await;
    assert_eq!(status, StatusCode::OK, "{sticker}");
    assert_eq!((sticker["name"].clone(), sticker["format_type"].clone(), sticker["available"].clone()), (json!("wave"), json!(1), json!(true)));
    assert_eq!(sticker["guild_id"], json!(w.guild));
    assert!(sticker["url"].as_str().expect("url").starts_with("http://test.local/api/v1/attachments/"));
    assert_eq!(fetch_status(&w.app, sticker["url"].as_str().expect("url")).await, StatusCode::OK);

    // validation: APNG detected, oversize, too large dimensions, not an image, bad names
    let (status, animated) = w.sticker(&w.owner, &w.guild, "spin", &apng(32, 32)).await;
    assert_eq!((status, animated["format_type"].clone()), (StatusCode::OK, json!(2)));
    assert_eq!(w.sticker(&w.owner, &w.guild, "huge", &png(64, 64, 600 * 1024)).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.sticker(&w.owner, &w.guild, "wide", &png(600, 64, 0)).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.sticker(&w.owner, &w.guild, "text", b"just text, not an image").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.sticker(&w.owner, &w.guild, "x", &png(8, 8, 0)).await.0, StatusCode::BAD_REQUEST, "name needs 2 characters");
    let (_, listed) = w.app.get(&format!("/guilds/{}/stickers", w.guild), &w.member).await;
    assert_eq!(listed.as_array().expect("list").len(), 2, "rejected uploads create nothing");

    let id0 = sticker["id"].as_str().expect("id");
    assert_eq!(w.app.patch(&format!("/guilds/{}/stickers/{id0}", w.guild), &w.member, json!({"name": "stolen"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/guilds/{}/stickers/{id0}", w.guild), &w.member).await.0, StatusCode::FORBIDDEN);
    // members read; strangers do not
    let (stranger, _) = w.app.register("bob").await;
    assert_eq!(w.app.get(&format!("/guilds/{}/stickers", w.guild), &stranger).await.0, StatusCode::FORBIDDEN);
    let id = sticker["id"].as_str().expect("id");
    assert_eq!(w.app.get(&format!("/guilds/{}/stickers/{id}", w.guild), &w.member).await.0, StatusCode::OK);

    // MANAGE_GUILD_EXPRESSIONS via a role: the member can now create, edit and delete any sticker
    w.role_for_member(MANAGE_GUILD_EXPRESSIONS).await;
    let (status, mine) = w.sticker(&w.member, &w.guild, "mine", &png(16, 16, 0)).await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    let mine_id = mine["id"].as_str().expect("id");
    assert_eq!(mine["user"]["username"], "alice");
    let (status, edited) = w.app.patch(&format!("/guilds/{}/stickers/{mine_id}", w.guild), &w.member, json!({"name": "mine2", "description": "hi"})).await;
    assert_eq!((status, edited["name"].clone(), edited["description"].clone()), (StatusCode::OK, json!("mine2"), json!("hi")));
    assert_eq!(w.app.delete(&format!("/guilds/{}/stickers/{mine_id}", w.guild), &w.member).await.0, StatusCode::NO_CONTENT);
    // without it: no edit, no delete (the owner's sticker, tried by a member who lost the role)
    // the owner clears the description again with an explicit null
    let (_, cleared) = w.app.patch(&format!("/guilds/{}/stickers/{id}", w.guild), &w.owner, json!({"description": null, "tags": "new,tags"})).await;
    assert_eq!((cleared["description"].clone(), cleared["tags"].clone()), (Value::Null, json!("new,tags")));
}

#[tokio::test]
async fn sticker_changes_reach_members_and_ready_carries_the_list() {
    let w = world().await;
    let address = w.app.serve().await;
    let mut gateway = Gateway::connect(&address, &w.member).await;
    let (_, sticker) = w.sticker(&w.owner, &w.guild, "wave", &png(64, 64, 0)).await;
    let update = gateway.wait_for("GUILD_STICKERS_UPDATE").await;
    assert_eq!((update["guild_id"].clone(), update["stickers"][0]["id"].clone()), (json!(w.guild), sticker["id"].clone()));
    w.app.patch(&format!("/guilds/{}/stickers/{}", w.guild, sticker["id"].as_str().expect("id")), &w.owner, json!({"name": "renamed"})).await;
    assert_eq!(gateway.wait_for("GUILD_STICKERS_UPDATE").await["stickers"][0]["name"], "renamed");
    w.app.delete(&format!("/guilds/{}/stickers/{}", w.guild, sticker["id"].as_str().expect("id")), &w.owner).await;
    assert_eq!(gateway.wait_for("GUILD_STICKERS_UPDATE").await["stickers"], json!([]));
    w.sticker(&w.owner, &w.guild, "again", &png(8, 8, 0)).await;
    // a fresh connection gets the stickers inside READY
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{address}/gateway")).await.expect("connect");
    let mut fresh = Gateway { ws };
    fresh.next_frame().await;
    fresh.ws.send(tokio_tungstenite::tungstenite::Message::Text(json!({"op": 2, "d": {"token": w.member}}).to_string().into())).await.expect("identify");
    let ready = fresh.wait_for("READY").await;
    assert_eq!(ready["guilds"][0]["stickers"][0]["name"], "again");
}

#[tokio::test]
async fn sticker_count_is_limited_per_guild() {
    let w = world_with(|config| config.max_stickers_per_guild = 2).await;
    assert_eq!(w.sticker(&w.owner, &w.guild, "one", &png(8, 8, 0)).await.0, StatusCode::OK);
    assert_eq!(w.sticker(&w.owner, &w.guild, "two", &png(8, 8, 0)).await.0, StatusCode::OK);
    let (status, body) = w.sticker(&w.owner, &w.guild, "three", &png(8, 8, 0)).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(30039)));
}

#[tokio::test]
async fn concurrent_sticker_creates_cannot_pass_the_cap() {
    let w = world_with(|config| config.max_stickers_per_guild = 1).await;
    let mut attachments = Vec::new();
    for extra in 0..4 {
        attachments.push(upload(&w.app, &w.owner, &w.channel, "s.png", &png(8, 8, extra)).await["id"].clone());
    }
    let path = format!("/guilds/{}/stickers", w.guild);
    let results = futures_util::future::join_all(
        attachments.iter().map(|id| w.app.post(&path, &w.owner, json!({"name": "race", "tags": "wave,hello", "attachment_id": id}))),
    )
    .await;
    assert_eq!(results.iter().filter(|(status, _)| *status == StatusCode::OK).count(), 1, "exactly the cap got in");
}

#[tokio::test]
async fn sending_stickers_follows_membership_and_external_sticker_permission() {
    let w = world().await;
    let (_, sticker) = w.sticker(&w.owner, &w.guild, "wave", &png(64, 64, 0)).await;
    let sid = sticker["id"].clone();

    // own guild: content may be empty, the item is a copy with a url
    let (status, message) = w.say(&w.member, &w.channel, json!({"sticker_ids": [sid]})).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    assert_eq!(message["sticker_items"][0]["name"], "wave");
    assert_eq!(message["sticker_items"][0]["url"], sticker["url"]);
    assert_eq!(message["content"], "");
    assert_eq!(w.say(&w.member, &w.channel, json!({"sticker_ids": [sid, sid, sid, sid]})).await.0, StatusCode::OK, "duplicates collapse");
    let other = json!(["1", "2", "3", "4"]);
    assert_eq!(w.say(&w.member, &w.channel, json!({"sticker_ids": other})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.say(&w.member, &w.channel, json!({"sticker_ids": ["12345"]})).await.0, StatusCode::BAD_REQUEST, "unknown sticker");

    // another guild: needs membership of the sticker's guild and USE_EXTERNAL_STICKERS where it is sent
    let (carol, _) = w.app.register("carol").await;
    let (guild_b, channel_b) = w.app.guild_with_channel(&carol).await;
    let (status, _) = w.say(&carol, &channel_b, json!({"sticker_ids": [sid]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "carol is not in the sticker's guild: same answer as unknown");
    join(&w.app, &w.owner, &w.channel, &carol).await;
    let (status, external) = w.say(&carol, &channel_b, json!({"sticker_ids": [sid]})).await;
    assert_eq!(status, StatusCode::OK, "{external}");
    assert_eq!(external["sticker_items"][0]["id"], sid);
    // deny the permission in that channel for @everyone
    let deny = USE_EXTERNAL_STICKERS.to_string();
    let (status, _) = w.app.put_json(&format!("/channels/{channel_b}/permissions/{guild_b}"), &carol, json!({"type": 0, "allow": "0", "deny": deny})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = w.say(&carol, &channel_b, json!({"sticker_ids": [sid]})).await;
    assert_eq!(status, StatusCode::OK, "the guild owner keeps ADMINISTRATOR-level access");
    // a plain member of guild B is blocked
    let (dave, _) = w.app.register("dave").await;
    join(&w.app, &carol, &channel_b, &dave).await;
    join(&w.app, &w.owner, &w.channel, &dave).await;
    assert_eq!(w.say(&dave, &channel_b, json!({"sticker_ids": [sid]})).await.0, StatusCode::FORBIDDEN);

    // search: has=sticker finds the sticker messages and nothing else
    w.say(&w.member, &w.channel, json!({"content": "plain"})).await;
    let (_, found) = w.app.get(&format!("/guilds/{}/messages/search?has=sticker", w.guild), &w.owner).await;
    assert_eq!(found["total_results"], 2);
}

#[tokio::test]
async fn sent_stickers_survive_deleting_the_sticker_until_the_message_goes() {
    let w = world().await;
    let (_, sticker) = w.sticker(&w.owner, &w.guild, "wave", &png(64, 64, 0)).await;
    let url = sticker["url"].as_str().expect("url").to_owned();
    let (_, message) = w.say(&w.member, &w.channel, json!({"sticker_ids": [sticker["id"]]})).await;
    assert_eq!(w.app.delete(&format!("/guilds/{}/stickers/{}", w.guild, sticker["id"].as_str().expect("id")), &w.owner).await.0, StatusCode::NO_CONTENT);
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", w.channel), &w.owner).await;
    assert_eq!(messages[0]["sticker_items"][0]["url"], json!(url));
    assert_eq!(fetch_status(&w.app, &url).await, StatusCode::OK, "still referenced by the message");
    assert_eq!(w.app.delete(&format!("/channels/{}/messages/{}", w.channel, message["id"].as_str().expect("id")), &w.member).await.0, StatusCode::NO_CONTENT);
    vokko_server::stickers::sweep_assets(&w.app.state).await;
    assert_eq!(fetch_status(&w.app, &url).await, StatusCode::NOT_FOUND, "nothing refers to it any more");
}

#[tokio::test]
async fn forward_copies_a_snapshot_and_never_leaks_unreadable_messages() {
    let w = world().await;
    let attachment = upload(&w.app, &w.owner, &w.channel, "pic.png", &png(40, 30, 0)).await;
    let (_, source) =
        w.say(&w.owner, &w.channel, json!({"content": "original <@1>", "attachments": [{"id": attachment["id"], "description": "alt text"}]})).await;
    let source_id = source["id"].as_str().expect("id").to_owned();

    // forward into a second channel of the same guild
    let (_, second) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "second", "type": 0})).await;
    let second = second["id"].as_str().expect("id").to_owned();
    let reference = json!({"type": 1, "message_id": source_id, "channel_id": w.channel});
    let (status, forwarded) = w.say(&w.member, &second, json!({"message_reference": reference})).await;
    assert_eq!(status, StatusCode::OK, "{forwarded}");
    assert_eq!(forwarded["content"], "");
    assert_eq!(forwarded["type"], 0);
    assert_eq!(forwarded["message_reference"], json!({"type": 1, "message_id": source_id, "channel_id": w.channel, "guild_id": w.guild}));
    assert_eq!(forwarded["referenced_message"], Value::Null);
    assert_eq!(forwarded["attachments"], json!([]), "snapshot files are not the message's own attachments");
    let snapshot = &forwarded["message_snapshots"][0]["message"];
    assert_eq!(snapshot["content"], "original <@1>");
    assert_eq!(snapshot["timestamp"], source["timestamp"]);
    assert_eq!((snapshot["attachments"][0]["filename"].clone(), snapshot["attachments"][0]["description"].clone()), (json!("pic.png"), json!("alt text")));
    assert_eq!(
        w.app.patch(&format!("/channels/{second}/messages/{}", forwarded["id"].as_str().expect("id")), &w.member, json!({"content": "x"})).await.0,
        StatusCode::BAD_REQUEST,
        "forwards are not editable"
    );
    let copy_url = snapshot["attachments"][0]["url"].as_str().expect("url").to_owned();
    assert_ne!(copy_url, attachment["url"].as_str().expect("url"), "the file is copied, not shared");
    assert_eq!(fetch_status(&w.app, &copy_url).await, StatusCode::OK);

    // editing and deleting the source changes nothing in the copy
    w.app.patch(&format!("/channels/{}/messages/{source_id}", w.channel), &w.owner, json!({"content": "edited"})).await;
    assert_eq!(w.app.delete(&format!("/channels/{}/messages/{source_id}", w.channel), &w.owner).await.0, StatusCode::NO_CONTENT);
    let (_, listed) = w.app.get(&format!("/channels/{second}/messages"), &w.member).await;
    assert_eq!(listed[0]["message_snapshots"][0]["message"]["content"], "original <@1>");
    assert_eq!(fetch_status(&w.app, &copy_url).await, StatusCode::OK, "the copied file outlives the source");
    // deleting the forward removes its copies
    assert_eq!(w.app.delete(&format!("/channels/{second}/messages/{}", forwarded["id"].as_str().expect("id")), &w.member).await.0, StatusCode::NO_CONTENT);
    assert_eq!(fetch_status(&w.app, &copy_url).await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn forward_rejects_what_the_caller_cannot_read_with_the_unknown_message_answer() {
    let w = world().await;
    // a private channel only the owner can see
    let (status, private) = w
        .app
        .post(
            &format!("/guilds/{}/channels", w.guild),
            &w.owner,
            json!({"name": "secret", "type": 0, "permission_overwrites": [{"id": w.guild, "type": 0, "allow": "0", "deny": "1024"}]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{private}");
    let private = private["id"].as_str().expect("id").to_owned();
    let (_, secret) = w.say(&w.owner, &private, json!({"content": "classified"})).await;
    let secret_ref = |id: &str, channel: &str| json!({"type": 1, "message_id": id, "channel_id": channel});

    let (status, hidden) = w.say(&w.member, &w.channel, json!({"message_reference": secret_ref(secret["id"].as_str().expect("id"), &private)})).await;
    let (status_missing, missing) = w.say(&w.member, &w.channel, json!({"message_reference": secret_ref("999999", &private)})).await;
    let (status_nochannel, nochannel) = w.say(&w.member, &w.channel, json!({"message_reference": secret_ref("999999", "888888")})).await;
    assert_eq!((status, status_missing, status_nochannel), (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND, StatusCode::NOT_FOUND));
    assert_eq!((hidden.clone(), missing.clone()), (missing, nochannel), "indistinguishable from a message that does not exist");
    assert_eq!(hidden["code"], 10008);
    let (_, listed) = w.app.get(&format!("/channels/{}/messages", w.channel), &w.member).await;
    assert!(listed.as_array().expect("messages").iter().all(|message| message["type"] != 0), "nothing was posted");

    // history hidden: can see the channel but not read old messages
    let (_, open) = w.say(&w.owner, &w.channel, json!({"content": "visible"})).await;
    let deny_history = (1_u64 << 16).to_string();
    let (status, _) =
        w.app.put_json(&format!("/channels/{}/permissions/{}", w.channel, w.member_id), &w.owner, json!({"type": 1, "allow": "0", "deny": deny_history})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, second) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "second", "type": 0})).await;
    let (status, _) =
        w.say(&w.member, second["id"].as_str().expect("id"), json!({"message_reference": secret_ref(open["id"].as_str().expect("id"), &w.channel)})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // shape rules
    let (status, _) = w
        .say(
            &w.owner,
            second["id"].as_str().expect("id"),
            json!({"content": "comment", "message_reference": secret_ref(open["id"].as_str().expect("id"), &w.channel)}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a forward carries no content");
    let (status, _) = w.say(&w.owner, second["id"].as_str().expect("id"), json!({"message_reference": {"type": 1, "message_id": open["id"]}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a forward needs the source channel");
}

#[tokio::test]
async fn automod_screens_a_forward_on_its_snapshot_and_removes_the_copies() {
    let w = world().await;
    let rule =
        json!({"name": "No bad words", "event_type": 1, "trigger_type": 1, "trigger_metadata": {"keyword_filter": ["free money"]}, "actions": [{"type": 1}]});
    let (status, body) = w.app.post(&format!("/guilds/{}/auto-moderation/rules", w.guild), &w.owner, rule).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The owner is exempt from AutoMod, so the source gets through; a member forwarding it must not.
    let attachment = upload(&w.app, &w.owner, &w.channel, "pic.png", &png(4, 4, 0)).await;
    let (status, source) = w.say(&w.owner, &w.channel, json!({"content": "get free money", "attachments": [{"id": attachment["id"]}]})).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    let files = || std::fs::read_dir(w.app.data_dir.join("attachments")).expect("attachments dir").count();
    let before = files();
    let reference = json!({"type": 1, "message_id": source["id"], "channel_id": w.channel});
    let (status, body) = w.say(&w.member, &w.channel, json!({"message_reference": reference})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(200000)), "{body}");
    assert_eq!(files(), before, "the blocked forward's file copies are removed");
}

#[tokio::test]
async fn automod_spam_counts_repeated_forwards() {
    let w = world().await;
    let rule = json!({"name": "Spam", "event_type": 1, "trigger_type": 3, "actions": [{"type": 1}]});
    let (status, body) = w.app.post(&format!("/guilds/{}/auto-moderation/rules", w.guild), &w.owner, rule).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, source) = w.say(&w.owner, &w.channel, json!({"content": "the same long text"})).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    let reference = json!({"type": 1, "message_id": source["id"], "channel_id": w.channel});
    for _ in 0..2 {
        let (status, body) = w.say(&w.member, &w.channel, json!({"message_reference": reference})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = w.say(&w.member, &w.channel, json!({"message_reference": reference})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::BAD_REQUEST, json!(200000)), "the third forward is spam: {body}");
}

#[tokio::test]
async fn a_forward_stopped_by_verification_or_slowmode_copies_no_files() {
    let w = world().await;
    let attachment = upload(&w.app, &w.owner, &w.channel, "pic.png", &png(4, 4, 0)).await;
    let (status, source) = w.say(&w.owner, &w.channel, json!({"content": "look", "attachments": [{"id": attachment["id"]}]})).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    // A copy of this source fails (a directory in place of its file, 500): a gate that answers first never reached the copy.
    let original = w.app.data_dir.join("attachments").join(attachment["id"].as_str().expect("id"));
    std::fs::remove_file(&original).expect("remove file");
    std::fs::create_dir(&original).expect("dir in its place");
    let files = || std::fs::read_dir(w.app.data_dir.join("attachments")).expect("attachments dir").count();
    let before = files();
    let reference = json!({"type": 1, "message_id": source["id"], "channel_id": w.channel});

    // Medium: the member's account is not 5 minutes old
    assert_eq!(w.app.patch(&format!("/guilds/{}", w.guild), &w.owner, json!({"verification_level": 2})).await.0, StatusCode::OK);
    let (status, body) = w.say(&w.member, &w.channel, json!({"message_reference": reference})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::FORBIDDEN, json!(50009)), "{body}");
    assert_eq!(files(), before, "verification stops the forward before its files are copied");
    assert_eq!(w.app.patch(&format!("/guilds/{}", w.guild), &w.owner, json!({"verification_level": 0})).await.0, StatusCode::OK);

    assert_eq!(w.app.patch(&format!("/channels/{}", w.channel), &w.owner, json!({"rate_limit_per_user": 60})).await.0, StatusCode::OK);
    assert_eq!(w.say(&w.member, &w.channel, json!({"content": "first"})).await.0, StatusCode::OK);
    let (status, body) = w.say(&w.member, &w.channel, json!({"message_reference": reference})).await;
    assert_eq!((status, body["code"].clone()), (StatusCode::TOO_MANY_REQUESTS, json!(20016)), "{body}");
    assert_eq!(files(), before, "slowmode stops the forward before its files are copied");
}

#[tokio::test]
async fn forwarding_to_a_dm_and_forwarding_a_forward() {
    let w = world().await;
    let (bob, friend) = w.app.register("bob").await;
    // DMs need a friendship
    let name = friend["username"].as_str().expect("username");
    assert_eq!(w.app.post("/users/@me/relationships", &w.owner, json!({"username": name})).await.0, StatusCode::NO_CONTENT);
    let (_, owner_user) = w.app.get("/users/@me", &w.owner).await;
    assert_eq!(w.app.put(&format!("/users/@me/relationships/{}", owner_user["id"].as_str().expect("id")), &bob).await.0, StatusCode::NO_CONTENT);
    let (status, dm) = w.app.post("/users/@me/channels", &w.owner, json!({"recipient_id": friend["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm = dm["id"].as_str().expect("id").to_owned();

    let (_, source) = w.say(&w.owner, &w.channel, json!({"content": "hello guild"})).await;
    let reference = json!({"type": 1, "message_id": source["id"], "channel_id": w.channel});
    let (status, forwarded) = w.say(&w.owner, &dm, json!({"message_reference": reference})).await;
    assert_eq!(status, StatusCode::OK, "{forwarded}");
    // bob reads the snapshot in the DM; the reference points into a guild he is not in, and he gets no access through it
    let (_, seen) = w.app.get(&format!("/channels/{dm}/messages"), &bob).await;
    assert_eq!(seen[0]["message_snapshots"][0]["message"]["content"], "hello guild");
    let (status, _) = w.say(&bob, &dm, json!({"message_reference": {"type": 1, "message_id": source["id"], "channel_id": w.channel}})).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "bob cannot use the original ids");
    // but he can forward the forward (the DM message is readable to him), which copies the snapshot
    let (status, again) = w.say(&bob, &dm, json!({"message_reference": {"type": 1, "message_id": forwarded["id"], "channel_id": dm}})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["message_snapshots"][0]["message"]["content"], "hello guild");
    assert_eq!(again["message_reference"]["message_id"], forwarded["id"]);
    // system messages cannot be forwarded
    let (_, pin_target) = w.say(&w.owner, &w.channel, json!({"content": "pin me"})).await;
    w.app.put(&format!("/channels/{}/messages/pins/{}", w.channel, pin_target["id"].as_str().expect("id")), &w.owner).await;
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", w.channel), &w.owner).await;
    let notice = messages.as_array().expect("messages").iter().find(|m| m["type"] == 6).expect("pin notice");
    let (status, _) = w.say(&w.owner, &dm, json!({"message_reference": {"type": 1, "message_id": notice["id"], "channel_id": w.channel}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn bookmarks_are_per_user_listed_while_readable_and_removed_with_the_message() {
    let w = world().await;
    let (_, first) = w.say(&w.owner, &w.channel, json!({"content": "one"})).await;
    let (_, second) = w.say(&w.owner, &w.channel, json!({"content": "two"})).await;
    let url = |message: &Value| format!("/channels/{}/messages/{}/bookmark", w.channel, message["id"].as_str().expect("id"));
    assert_eq!(w.app.put(&url(&first), &w.member).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.put(&url(&first), &w.member).await.0, StatusCode::NO_CONTENT, "idempotent");
    assert_eq!(w.app.put(&url(&second), &w.member).await.0, StatusCode::NO_CONTENT);
    let (status, page) = w.app.get("/users/@me/bookmarks", &w.member).await;
    assert_eq!(status, StatusCode::OK);
    let contents: Vec<&str> = page["items"].as_array().expect("items").iter().map(|item| item["message"]["content"].as_str().expect("content")).collect();
    assert_eq!(contents, vec!["two", "one"], "newest saved first");
    assert_eq!(page["has_more"], false);
    let (_, mine_only) = w.app.get("/users/@me/bookmarks", &w.owner).await;
    assert_eq!(mine_only["items"], json!([]), "bookmarks are private");
    let (_, limited) = w.app.get("/users/@me/bookmarks?limit=1", &w.member).await;
    assert_eq!((limited["items"].as_array().expect("items").len(), limited["has_more"].clone()), (1, json!(true)));
    let (_, older) = w
        .app
        .get(&format!("/users/@me/bookmarks?limit=1&before={}", limited["items"][0]["saved_at"].as_str().expect("saved_at").replace('+', "%2B")), &w.member)
        .await;
    assert_eq!(older["items"][0]["message"]["content"], "one");

    // an outsider cannot bookmark; a bookmark hides when access is lost and returns with it
    let (outsider, _) = w.app.register("bob").await;
    assert_eq!(w.app.put(&url(&first), &outsider).await.0, StatusCode::FORBIDDEN);
    let deny_view = (1_u64 << 10).to_string();
    w.app.put_json(&format!("/channels/{}/permissions/{}", w.channel, w.member_id), &w.owner, json!({"type": 1, "allow": "0", "deny": deny_view})).await;
    let (_, hidden) = w.app.get("/users/@me/bookmarks", &w.member).await;
    assert_eq!(hidden["items"], json!([]), "unreadable messages are never returned");
    w.app.delete(&format!("/channels/{}/permissions/{}", w.channel, w.member_id), &w.owner).await;
    let (_, back) = w.app.get("/users/@me/bookmarks", &w.member).await;
    assert_eq!(back["items"].as_array().expect("items").len(), 2);

    assert_eq!(w.app.delete(&url(&first), &w.member).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&url(&first), &w.member).await.0, StatusCode::NO_CONTENT, "removing twice is fine");
    w.app.delete(&format!("/channels/{}/messages/{}", w.channel, second["id"].as_str().expect("id")), &w.owner).await;
    let (_, after) = w.app.get("/users/@me/bookmarks", &w.member).await;
    assert_eq!(after["items"], json!([]));
}

struct Gateway {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Gateway {
    async fn connect(address: &str, token: &str) -> Self {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{address}/gateway")).await.expect("connect");
        let mut gateway = Self { ws };
        gateway.next_frame().await;
        gateway.ws.send(tokio_tungstenite::tungstenite::Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        gateway.wait_for("READY").await;
        gateway
    }

    async fn next_frame(&mut self) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(8), self.ws.next()).await.expect("a frame in time") {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => return serde_json::from_str(&text).expect("json"),
                Some(Ok(_)) => continue,
                other => panic!("gateway closed: {other:?}"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.next_frame().await;
            if frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }
}

#[tokio::test]
async fn reminders_are_validated_delivered_exactly_once_and_dismissable() {
    let w = world_with(|config| config.reminder_poll = Duration::from_millis(100)).await;
    let (_, message) = w.say(&w.owner, &w.channel, json!({"content": "remind me"})).await;
    let at = |seconds: i64| {
        (time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds)).format(&time::format_description::well_known::Rfc3339).expect("format")
    };
    let body = |remind_at: String| json!({"channel_id": w.channel, "message_id": message["id"], "remind_at": remind_at});

    // validation
    assert_eq!(w.app.post("/users/@me/reminders", &w.member, body(at(-60))).await.0, StatusCode::BAD_REQUEST, "past");
    assert_eq!(w.app.post("/users/@me/reminders", &w.member, body(at(400 * 86_400))).await.0, StatusCode::BAD_REQUEST, "more than a year ahead");
    assert_eq!(w.app.post("/users/@me/reminders", &w.member, body("tomorrow".to_owned())).await.0, StatusCode::BAD_REQUEST);
    let (outsider, _) = w.app.register("bob").await;
    assert_eq!(w.app.post("/users/@me/reminders", &outsider, body(at(60))).await.0, StatusCode::FORBIDDEN);

    let address = w.app.serve().await;
    let mut gateway = Gateway::connect(&address, &w.member).await;
    let (status, created) = w.app.post("/users/@me/reminders", &w.member, body(at(3600))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!((created["delivered_at"].clone(), created["message"]["content"].clone()), (Value::Null, json!("remind me")));
    assert_eq!(gateway.wait_for("REMINDER_CREATE").await["id"], created["id"]);
    // one reminder per message: setting again moves it
    let (_, moved) = w.app.post("/users/@me/reminders", &w.member, body(at(2))).await;
    assert_eq!(moved["id"], created["id"]);
    let (_, all) = w.app.get("/users/@me/reminders", &w.member).await;
    assert_eq!(all.as_array().expect("list").len(), 1);

    // the periodic task delivers it once it is due
    vokko_server::reminders::spawn(w.app.state.clone());
    let due = gateway.wait_for("REMINDER_DUE").await;
    assert_eq!(due["id"], created["id"]);
    assert!(due["delivered_at"].is_string());
    assert_eq!(due["message"]["content"], "remind me");
    assert_eq!(vokko_server::reminders::deliver_due(&w.app.state).await.expect("delivery"), 0, "delivered exactly once");
    let (_, after) = w.app.get("/users/@me/reminders", &w.member).await;
    assert!(after[0]["delivered_at"].is_string(), "stays listed until dismissed");
    // nobody else got it
    assert_eq!(w.app.get("/users/@me/reminders", &w.owner).await.1, json!([]));

    assert_eq!(w.app.delete(&format!("/users/@me/reminders/{}", created["id"].as_str().expect("id")), &w.member).await.0, StatusCode::NO_CONTENT);
    assert_eq!(gateway.wait_for("REMINDER_DELETE").await["id"], created["id"]);
    assert_eq!(w.app.get("/users/@me/reminders", &w.member).await.1, json!([]));
}

#[tokio::test]
async fn reminder_of_a_message_that_became_unreadable_has_no_message() {
    let w = world().await;
    let (_, message) = w.say(&w.owner, &w.channel, json!({"content": "secret"})).await;
    let remind_at = (time::OffsetDateTime::now_utc() + time::Duration::hours(1)).format(&time::format_description::well_known::Rfc3339).expect("format");
    let (status, _) =
        w.app.post("/users/@me/reminders", &w.member, json!({"channel_id": w.channel, "message_id": message["id"], "remind_at": remind_at})).await;
    assert_eq!(status, StatusCode::OK);
    let deny_view = (1_u64 << 10).to_string();
    w.app.put_json(&format!("/channels/{}/permissions/{}", w.channel, w.member_id), &w.owner, json!({"type": 1, "allow": "0", "deny": deny_view})).await;
    let (_, all) = w.app.get("/users/@me/reminders", &w.member).await;
    assert_eq!(all[0]["message"], Value::Null);
    assert_eq!(all[0]["message_id"], message["id"]);
}

// ---- GIF proxy ----

/// Plays the Giphy API on a loopback port and remembers the queries it saw.
async fn fake_giphy() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::Router;
    use axum::extract::{RawQuery, State};
    use axum::routing::get;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    async fn gifs(State(seen): State<std::sync::Arc<std::sync::Mutex<Vec<String>>>>, RawQuery(query): RawQuery) -> axum::Json<Value> {
        seen.lock().expect("lock").push(query.unwrap_or_default());
        axum::Json(json!({
            "data": [{"id": "abc", "title": "cat", "images": {"original": {"url": "https://media.example/o.gif", "width": "200", "height": "100"}, "fixed_width_small": {"url": "https://media.example/s.gif"}}}],
            "pagination": {"total_count": 40, "count": 1, "offset": 0}
        }))
    }
    async fn categories() -> axum::Json<Value> {
        axum::Json(json!({"data": [{"name": "reactions", "gif": {"images": {"fixed_width_small": {"url": "https://media.example/c.gif"}}}}]}))
    }
    let router = Router::new()
        .route("/v1/gifs/search", get(gifs))
        .route("/v1/gifs/trending", get(gifs))
        .route("/v1/gifs/categories", get(categories))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://{address}"), seen)
}

#[tokio::test]
async fn gif_proxy_normalises_provider_results_and_keeps_the_key_server_side() {
    let (base, seen) = fake_giphy().await;
    let app = TestApp::with_config(|config| {
        config.gif =
            vokko_server::config::GifConfig { provider: vokko_protocol::api::GifProvider::Giphy, api_key: "secret-key".to_owned(), base_url: Some(base) };
    })
    .await;
    let (token, _) = app.register("sam").await;
    let (status, page) = app.get("/gifs/search?q=cat%20video&limit=5", &token).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        page,
        json!({"provider": "giphy", "next": "1", "results": [{"id": "giphy:abc", "title": "cat", "url": "https://media.example/o.gif", "preview_url": "https://media.example/s.gif", "width": 200, "height": 100}]})
    );
    assert!(!page.to_string().contains("secret-key"));
    let query = seen.lock().expect("lock").last().cloned().expect("provider was called");
    assert!(query.contains("api_key=secret-key") && query.contains("q=cat+video") && query.contains("limit=5"), "{query}");
    let (_, trending) = app.get("/gifs/trending?pos=24", &token).await;
    assert_eq!(trending["results"][0]["id"], "giphy:abc");
    assert!(seen.lock().expect("lock").last().expect("query").contains("offset=24"));
    let (_, categories) = app.get("/gifs/categories", &token).await;
    assert_eq!(categories, json!({"provider": "giphy", "categories": [{"name": "reactions", "image": "https://media.example/c.gif"}]}));

    assert_eq!(app.get("/gifs/search", &token).await.0, StatusCode::BAD_REQUEST, "q is required");
    assert_eq!(app.get("/gifs/search?q=x&limit=0", &token).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.send(axum::http::Method::GET, "/gifs/trending", None, None).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn gif_provider_failure_is_a_bad_gateway_and_none_is_empty() {
    let app = TestApp::with_config(|config| {
        config.gif = vokko_server::config::GifConfig {
            provider: vokko_protocol::api::GifProvider::Tenor,
            api_key: "k".to_owned(),
            base_url: Some("http://127.0.0.1:9".to_owned()),
        };
    })
    .await;
    let (token, _) = app.register("sam").await;
    let (status, error) = app.get("/gifs/trending", &token).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{error}");
    let none = TestApp::new().await;
    let (token, _) = none.register("sam").await;
    assert_eq!(none.get("/gifs/trending", &token).await.1, json!({"provider": "none", "results": [], "next": null}));
    assert_eq!(none.get("/gifs/search?q=cat", &token).await.1, json!({"provider": "none", "results": [], "next": null}));
    assert_eq!(none.get("/gifs/categories", &token).await.1, json!({"provider": "none", "categories": []}));
}

#[tokio::test]
async fn gif_favourites_are_per_user_ordered_and_validated() {
    let app = TestApp::new().await;
    let (alice, _) = app.register("alice").await;
    let (bob, _) = app.register("bob").await;
    let gif = |id: &str| json!({"id": id, "title": "t", "url": "https://media.example/a.gif", "preview_url": "https://media.example/p.gif", "width": 10, "height": 10});
    assert_eq!(app.put_json("/users/@me/gifs/favorites", &alice, gif("giphy:1")).await.0, StatusCode::OK);
    assert_eq!(app.put_json("/users/@me/gifs/favorites", &alice, gif("tenor:2")).await.0, StatusCode::OK);
    assert_eq!(app.put_json("/users/@me/gifs/favorites", &alice, gif("giphy:1")).await.0, StatusCode::OK, "re-adding moves it to the top");
    let (_, list) = app.get("/users/@me/gifs/favorites", &alice).await;
    let ids: Vec<&str> = list.as_array().expect("list").iter().map(|gif| gif["id"].as_str().expect("id")).collect();
    assert_eq!(ids, vec!["giphy:1", "tenor:2"]);
    assert_eq!(app.get("/users/@me/gifs/favorites", &bob).await.1, json!([]));
    for bad in [
        json!({"id": "nocolon", "title": "t", "url": "https://x/a.gif", "preview_url": "https://x/p.gif", "width": 1, "height": 1}),
        json!({"id": "giphy:1", "title": "t", "url": "javascript:alert(1)", "preview_url": "https://x/p.gif", "width": 1, "height": 1}),
        json!({"id": "giphy:1", "title": "t", "url": "https://x/a.gif", "preview_url": "data:image/gif;base64,AAAA", "width": 1, "height": 1}),
    ] {
        assert_eq!(app.put_json("/users/@me/gifs/favorites", &alice, bad).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(app.delete("/users/@me/gifs/favorites/tenor%3A2", &alice).await.0, StatusCode::NO_CONTENT);
    let (_, list) = app.get("/users/@me/gifs/favorites", &alice).await;
    assert_eq!(list.as_array().expect("list").len(), 1);
    assert_eq!(app.get("/users/@me/gifs/favorites", &bob).await.1, json!([]));
}

#[tokio::test]
async fn sticker_images_survive_deleting_the_channel_they_were_uploaded_through() {
    let w = world().await;
    let (_, upload_channel) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "uploads", "type": 0})).await;
    let upload_channel = upload_channel["id"].as_str().expect("id").to_owned();
    let attachment = upload(&w.app, &w.owner, &upload_channel, "s.png", &png(32, 32, 0)).await;
    let (status, sticker) =
        w.app.post(&format!("/guilds/{}/stickers", w.guild), &w.owner, json!({"name": "wave", "tags": "hi", "attachment_id": attachment["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{sticker}");
    let (_, message) = w.say(&w.member, &w.channel, json!({"sticker_ids": [sticker["id"]]})).await;
    assert_eq!(w.app.delete(&format!("/channels/{upload_channel}"), &w.owner).await.0, StatusCode::OK);
    let url = sticker["url"].as_str().expect("url");
    assert_eq!(fetch_status(&w.app, url).await, StatusCode::OK, "the sticker's file is not tied to the upload channel");
    assert_eq!(message["sticker_items"][0]["url"], sticker["url"]);
}

#[tokio::test]
async fn stickers_inside_a_forward_keep_their_image_after_the_source_is_gone() {
    let w = world().await;
    let (_, sticker) = w.sticker(&w.owner, &w.guild, "wave", &png(64, 64, 0)).await;
    let url = sticker["url"].as_str().expect("url").to_owned();
    let (_, source) = w.say(&w.member, &w.channel, json!({"sticker_ids": [sticker["id"]]})).await;
    let (_, second) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "second", "type": 0})).await;
    let second = second["id"].as_str().expect("id").to_owned();
    let (status, forwarded) = w.say(&w.member, &second, json!({"message_reference": {"type": 1, "message_id": source["id"], "channel_id": w.channel}})).await;
    assert_eq!(status, StatusCode::OK, "{forwarded}");
    assert_eq!(forwarded["message_snapshots"][0]["message"]["sticker_items"][0]["url"], json!(url));
    assert!(forwarded.get("sticker_items").is_none(), "snapshot stickers are not the forward's own");

    w.app.delete(&format!("/channels/{}/messages/{}", w.channel, source["id"].as_str().expect("id")), &w.member).await;
    w.app.delete(&format!("/guilds/{}/stickers/{}", w.guild, sticker["id"].as_str().expect("id")), &w.owner).await;
    vokko_server::stickers::sweep_assets(&w.app.state).await;
    assert_eq!(fetch_status(&w.app, &url).await, StatusCode::OK, "the forward still shows it");
    // and a forward of the forward keeps it alive after the first forward is deleted
    let (_, third) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "third", "type": 0})).await;
    let third = third["id"].as_str().expect("id").to_owned();
    let (status, again) = w.say(&w.member, &third, json!({"message_reference": {"type": 1, "message_id": forwarded["id"], "channel_id": second}})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    w.app.delete(&format!("/channels/{second}/messages/{}", forwarded["id"].as_str().expect("id")), &w.member).await;
    vokko_server::stickers::sweep_assets(&w.app.state).await;
    assert_eq!(fetch_status(&w.app, &url).await, StatusCode::OK);
    w.app.delete(&format!("/channels/{third}/messages/{}", again["id"].as_str().expect("id")), &w.member).await;
    vokko_server::stickers::sweep_assets(&w.app.state).await;
    assert_eq!(fetch_status(&w.app, &url).await, StatusCode::NOT_FOUND, "nothing refers to it any more");
}

#[tokio::test]
async fn bookmark_pages_skip_unreadable_items_before_the_limit_applies() {
    let w = world().await;
    let (_, old) = w.say(&w.owner, &w.channel, json!({"content": "readable"})).await;
    let (_, private) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "secret", "type": 0})).await;
    let private = private["id"].as_str().expect("id").to_owned();
    let deny_view = (1_u64 << 10).to_string();
    // member can see the channel for now
    let mut hidden = Vec::new();
    for index in 0..3 {
        let (_, message) = w.say(&w.owner, &private, json!({"content": format!("private {index}")})).await;
        hidden.push(message);
    }
    assert_eq!(w.app.put(&format!("/channels/{}/messages/{}/bookmark", w.channel, old["id"].as_str().expect("id")), &w.member).await.0, StatusCode::NO_CONTENT);
    for message in &hidden {
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(
            w.app.put(&format!("/channels/{private}/messages/{}/bookmark", message["id"].as_str().expect("id")), &w.member).await.0,
            StatusCode::NO_CONTENT
        );
    }
    w.app.put_json(&format!("/channels/{private}/permissions/{}", w.guild), &w.owner, json!({"type": 0, "allow": "0", "deny": deny_view})).await;
    // the three newest bookmarks are now unreadable; a page of 2 must still reach the readable one
    let (_, page) = w.app.get("/users/@me/bookmarks?limit=2", &w.member).await;
    let contents: Vec<&str> = page["items"].as_array().expect("items").iter().map(|item| item["message"]["content"].as_str().expect("content")).collect();
    assert_eq!(contents, vec!["readable"]);
    assert_eq!(page["has_more"], false);
}

#[tokio::test]
async fn an_oversized_gif_provider_answer_is_refused() {
    use axum::Router;
    use axum::routing::get;
    let router = Router::new().fallback(get(|| async { vec![b' '; 5 * 1024 * 1024] }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let app = TestApp::with_config(|config| {
        config.gif = vokko_server::config::GifConfig { provider: vokko_protocol::api::GifProvider::Giphy, api_key: "k".to_owned(), base_url: Some(base) };
    })
    .await;
    let (token, _) = app.register("sam").await;
    assert_eq!(app.get("/gifs/trending", &token).await.0, StatusCode::BAD_GATEWAY);
}

fn attachment_files(app: &TestApp) -> usize {
    std::fs::read_dir(app.state.attachments_dir()).map(|entries| entries.count()).unwrap_or(0)
}

async fn snapshot_attachment_rows(app: &TestApp) -> i64 {
    sqlx::query_as::<_, (i64,)>("SELECT count(*) FROM attachments WHERE snapshot").fetch_one(&app.state.db).await.expect("count").0
}

#[tokio::test]
async fn a_forward_needs_attach_files_in_the_target_channel_when_it_carries_files() {
    let w = world().await;
    let attachment = upload(&w.app, &w.owner, &w.channel, "pic.png", &png(40, 30, 0)).await;
    let (_, with_file) = w.say(&w.owner, &w.channel, json!({"content": "has a file", "attachment_ids": [attachment["id"]]})).await;
    let (_, text_only) = w.say(&w.owner, &w.channel, json!({"content": "just text"})).await;
    let (_, target) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "no-files", "type": 0})).await;
    let target = target["id"].as_str().expect("id").to_owned();
    let deny_attach = (1_u64 << 15).to_string();
    let (status, _) =
        w.app.put_json(&format!("/channels/{target}/permissions/{}", w.guild), &w.owner, json!({"type": 0, "allow": "0", "deny": deny_attach})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let files_before = attachment_files(&w.app);
    let reference = |message: &Value| json!({"message_reference": {"type": 1, "message_id": message["id"], "channel_id": w.channel}});
    let (status, denied) = w.say(&w.member, &target, reference(&with_file)).await;
    assert_eq!((status, denied["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)), "{denied}");
    assert_eq!(attachment_files(&w.app), files_before, "nothing was copied for the refused forward");
    assert_eq!(snapshot_attachment_rows(&w.app).await, 0);
    let (status, ok) = w.say(&w.member, &target, reference(&text_only)).await;
    assert_eq!(status, StatusCode::OK, "a forward without files is fine: {ok}");

    // allowed again: the forward goes through, and the copy shares the data on disk where hard links work
    w.app.delete(&format!("/channels/{target}/permissions/{}", w.guild), &w.owner).await;
    let (status, allowed) = w.say(&w.member, &target, reference(&with_file)).await;
    assert_eq!(status, StatusCode::OK, "{allowed}");
    let copy = allowed["message_snapshots"][0]["message"]["attachments"][0]["id"].as_str().expect("id").to_owned();
    let (original, copied) = (w.app.state.attachments_dir().join(attachment["id"].as_str().expect("id")), w.app.state.attachments_dir().join(&copy));
    assert_eq!(std::fs::read(&original).expect("original"), std::fs::read(&copied).expect("copy"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert!(std::fs::metadata(&copied).expect("metadata").nlink() >= 2, "the copy is a hard link on this filesystem");
    }
    // deleting the source must not take the copy's data with it
    w.app.delete(&format!("/channels/{}/messages/{}", w.channel, with_file["id"].as_str().expect("id")), &w.owner).await;
    assert_eq!(std::fs::read(&copied).expect("copy survives"), png(40, 30, 0));
}

#[tokio::test]
async fn a_forward_needs_use_external_stickers_for_stickers_of_other_servers() {
    let w = world().await;
    let (_, sticker) = w.sticker(&w.owner, &w.guild, "wave", &png(64, 64, 0)).await;
    let (_, source) = w.say(&w.member, &w.channel, json!({"sticker_ids": [sticker["id"]]})).await;
    let reference = json!({"message_reference": {"type": 1, "message_id": source["id"], "channel_id": w.channel}});

    // a second server where the member has no external-sticker permission in #general
    let (carol, _) = w.app.register("carol").await;
    let (guild_b, channel_b) = w.app.guild_with_channel(&carol).await;
    join(&w.app, &carol, &channel_b, &w.member).await;
    let deny = USE_EXTERNAL_STICKERS.to_string();
    w.app.put_json(&format!("/channels/{channel_b}/permissions/{guild_b}"), &carol, json!({"type": 0, "allow": "0", "deny": deny})).await;

    let (status, denied) = w.say(&w.member, &channel_b, reference.clone()).await;
    assert_eq!((status, denied["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)), "{denied}");
    // the sticker's own server is fine, and so is a channel where the permission is not denied
    let (_, second) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "second", "type": 0})).await;
    let (status, own) = w.say(&w.member, second["id"].as_str().expect("id"), reference.clone()).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    w.app.delete(&format!("/channels/{channel_b}/permissions/{guild_b}"), &carol).await;
    let (status, allowed) = w.say(&w.member, &channel_b, reference).await;
    assert_eq!(status, StatusCode::OK, "{allowed}");
}

#[tokio::test]
async fn an_oversized_provider_redirect_is_not_followed() {
    use axum::Router;
    use axum::response::Redirect;
    use axum::routing::get;
    let hits = std::sync::Arc::new(std::sync::Mutex::new(0_u32));
    let other = Router::new().fallback(get({
        let hits = hits.clone();
        move || {
            let hits = hits.clone();
            async move {
                *hits.lock().expect("lock") += 1;
                axum::Json(json!({"data": []}))
            }
        }
    }));
    let other_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let other_url = format!("http://{}/stolen", other_listener.local_addr().expect("address"));
    tokio::spawn(async move {
        let _ = axum::serve(other_listener, other).await;
    });
    let redirecting = Router::new().fallback(get(move || {
        let target = other_url.clone();
        async move { Redirect::temporary(&target) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    tokio::spawn(async move {
        let _ = axum::serve(listener, redirecting).await;
    });
    let app = TestApp::with_config(|config| {
        config.gif = vokko_server::config::GifConfig { provider: vokko_protocol::api::GifProvider::Giphy, api_key: "k".to_owned(), base_url: Some(base) };
    })
    .await;
    let (token, _) = app.register("sam").await;
    assert_eq!(app.get("/gifs/trending", &token).await.0, StatusCode::BAD_GATEWAY);
    assert_eq!(*hits.lock().expect("lock"), 0, "the redirect target (which would receive the key) was never contacted");
}

#[tokio::test]
async fn bookmark_pages_do_not_repeat_or_skip_items_saved_in_the_same_instant() {
    let w = world().await;
    let mut ids = Vec::new();
    for index in 0..3 {
        let (_, message) = w.say(&w.owner, &w.channel, json!({"content": format!("m{index}")})).await;
        ids.push(message["id"].as_str().expect("id").to_owned());
    }
    sqlx::query("INSERT INTO bookmarks (user_id, message_id, channel_id, created_at) SELECT $1, id, channel_id, '2026-10-12T10:00:00Z' FROM messages WHERE channel_id = $2")
        .bind(w.member_id.parse::<i64>().expect("id"))
        .bind(w.channel.parse::<i64>().expect("channel"))
        .execute(&w.app.state.db)
        .await
        .expect("bookmarks");
    let mut seen = Vec::new();
    let mut path = "/users/@me/bookmarks?limit=1".to_owned();
    for _ in 0..10 {
        let (_, page) = w.app.get(&path, &w.member).await;
        let Some(item) = page["items"].as_array().and_then(|items| items.first()) else { break };
        seen.push(item["message"]["id"].as_str().expect("id").to_owned());
        if page["has_more"] != true {
            break;
        }
        path = format!(
            "/users/@me/bookmarks?limit=1&before={}&before_id={}",
            item["saved_at"].as_str().expect("saved_at").replace('+', "%2B"),
            item["message"]["id"].as_str().expect("id")
        );
    }
    let total = sqlx::query_as::<_, (i64,)>("SELECT count(*) FROM bookmarks").fetch_one(&w.app.state.db).await.expect("count").0 as usize;
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!((seen.len(), unique.len()), (total, total), "every bookmark exactly once: {seen:?}");
    assert!(total >= 3);
}

#[tokio::test]
async fn copied_files_are_removed_when_the_insert_fails_before_the_commit() {
    use vokko_protocol::api::{MessageSnapshot, MessageSnapshotContent, MessageType};
    use vokko_server::forward::{AttachmentCopy, ForwardDraft};
    use vokko_server::routes::messages::{Draft, Resolved, insert_message_with};
    let w = world().await;
    let channel = vokko_server::store::channel_row(&w.app.state, w.channel.parse().expect("id")).await.expect("query").expect("channel");
    let author: i64 = w.member_id.parse().expect("id");
    let copy_id = w.app.state.ids.next();
    std::fs::create_dir_all(w.app.state.attachments_dir()).expect("dir");
    std::fs::write(w.app.state.attachments_dir().join(copy_id.to_string()), b"copied bytes").expect("file");
    let forward = ForwardDraft {
        source_channel: channel.id,
        source_guild: channel.guild_id,
        source_message: 1,
        snapshot: MessageSnapshot {
            message: MessageSnapshotContent {
                kind: MessageType::Default,
                content: String::new(),
                timestamp: "2026-10-12T10:00:00Z".to_owned(),
                edited_timestamp: None,
                mentions: Vec::new(),
                attachments: Vec::new(),
                embeds: Vec::new(),
                sticker_items: Vec::new(),
            },
        },
        copies: vec![AttachmentCopy {
            id: copy_id,
            key: "k".repeat(32),
            filename: "a.png".to_owned(),
            content_type: None,
            size: 12,
            width: None,
            height: None,
            description: None,
        }],
        stickers: Vec::new(),
    };
    // an own attachment id that does not exist makes the insert fail inside the transaction, before the commit
    let draft = Draft {
        content: String::new(),
        kind: MessageType::Default,
        reference: None,
        attachments: vec![vokko_server::routes::messages::DraftAttachment::plain(999_999)],
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
        stickers: Vec::new(),
        forward: Some(forward),
    };
    let result = insert_message_with(&w.app.state, &channel, author, draft, Default::default()).await;
    assert!(result.is_err(), "the insert fails");
    assert!(!w.app.state.attachments_dir().join(copy_id.to_string()).exists(), "the copy was removed with the failed insert");
    let (rows,): (i64,) = sqlx::query_as("SELECT count(*) FROM attachments WHERE id = $1").bind(copy_id).fetch_one(&w.app.state.db).await.expect("count");
    assert_eq!(rows, 0);
}
