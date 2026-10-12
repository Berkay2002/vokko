#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Per-guild DM privacy (GET/PATCH /users/@me/guilds/{id}/privacy) and Discord's rule where a DM is opened and written to:
//! friends always may; others need the target's `dms_from_server_members` on and a shared guild the target has not restricted.
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

struct Person {
    token: String,
    id: String,
}

async fn person(app: &TestApp, name: &str) -> Person {
    let (token, user) = app.register(name).await;
    Person { token, id: user["id"].as_str().expect("id").to_owned() }
}

async fn join(app: &TestApp, owner: &Person, channel: &str, who: &Person) {
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner.token, json!({})).await;
    let (status, body) = app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &who.token, json!({})).await;
    assert_eq!(status, StatusCode::OK, "join: {body}");
}

async fn set_dms(app: &TestApp, who: &Person, guild: &str, allowed: bool) {
    let (status, body) = app.patch(&format!("/users/@me/guilds/{guild}/privacy"), &who.token, json!({"direct_messages": allowed})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"direct_messages": allowed})));
}

async fn open_dm(app: &TestApp, from: &Person, to: &Person) -> (StatusCode, Value) {
    app.post("/users/@me/channels", &from.token, json!({"recipient_id": to.id})).await
}

async fn send(app: &TestApp, from: &Person, dm: &str) -> (StatusCode, Value) {
    app.post(&format!("/channels/{dm}/messages"), &from.token, json!({"content": "hi"})).await
}

fn refused(result: (StatusCode, Value)) -> bool {
    result.0 == StatusCode::FORBIDDEN && result.1["code"] == 50007
}

#[tokio::test]
async fn the_setting_round_trips_for_members_only() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let (guild, _) = app.guild_with_channel(&ann.token).await;
    let path = format!("/users/@me/guilds/{guild}/privacy");

    assert_eq!(app.get(&path, &ann.token).await, (StatusCode::OK, json!({"direct_messages": true})));
    set_dms(&app, &ann, &guild, false).await;
    assert_eq!(app.get(&path, &ann.token).await.1, json!({"direct_messages": false}));
    set_dms(&app, &ann, &guild, false).await; // idempotent
    set_dms(&app, &ann, &guild, true).await;
    assert_eq!(app.get(&path, &ann.token).await.1, json!({"direct_messages": true}));

    // Not a member, or no such guild: 404 Unknown Guild.
    for (path, token) in
        [(&path, &ben.token), (&"/users/@me/guilds/123/privacy".to_owned(), &ann.token), (&"/users/@me/guilds/x/privacy".to_owned(), &ann.token)]
    {
        let (status, body) = app.get(path, token).await;
        assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!(10004)), "{path}");
        let (status, body) = app.patch(path, token, json!({"direct_messages": false})).await;
        assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!(10004)), "{path}");
    }
    let (status, _) = app.patch(&path, &ann.token, json!({"direct_messages": "no"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn restricting_the_only_shared_guild_blocks_opening_and_sending() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await; // has a DM with ann
    let cat = person(&app, "cat").await; // has none
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    join(&app, &ann, &channel, &cat).await;

    let (status, dm) = open_dm(&app, &ben, &ann).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm = dm["id"].as_str().expect("dm id").to_owned();
    assert_eq!(send(&app, &ben, &dm).await.0, StatusCode::OK);

    set_dms(&app, &ann, &guild, false).await;
    assert!(refused(open_dm(&app, &cat, &ann).await));
    // Reopening an existing DM still returns it (its history stays readable), but writing in it is refused.
    assert_eq!(open_dm(&app, &ben, &ann).await.0, StatusCode::OK);
    assert!(refused(send(&app, &ben, &dm).await));
    // The rule is about who may reach ann; ann can still write to ben (his defaults allow it).
    assert_eq!(send(&app, &ann, &dm).await.0, StatusCode::OK);

    // The choice outlives membership: leaving and rejoining keeps it.
    assert_eq!(app.delete(&format!("/users/@me/guilds/{guild}"), &ben.token).await.0, StatusCode::NO_CONTENT);
    join(&app, &ann, &channel, &ben).await;
    assert!(refused(send(&app, &ben, &dm).await));

    set_dms(&app, &ann, &guild, true).await;
    assert_eq!(open_dm(&app, &cat, &ann).await.0, StatusCode::OK);
    assert_eq!(send(&app, &ben, &dm).await.0, StatusCode::OK);
}

#[tokio::test]
async fn another_open_shared_guild_or_a_friendship_still_allows_it() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let (strict, strict_channel) = app.guild_with_channel(&ann.token).await;
    let (open, open_channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &strict_channel, &ben).await;
    join(&app, &ann, &open_channel, &ben).await;
    set_dms(&app, &ann, &strict, false).await;

    let (status, dm) = open_dm(&app, &ben, &ann).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm = dm["id"].as_str().expect("dm id").to_owned();
    assert_eq!(send(&app, &ben, &dm).await.0, StatusCode::OK);

    // Without the open guild ben is refused; as ann's friend he gets through again.
    assert_eq!(app.delete(&format!("/users/@me/guilds/{open}"), &ben.token).await.0, StatusCode::NO_CONTENT);
    assert!(refused(send(&app, &ben, &dm).await));

    assert_eq!(app.post("/users/@me/relationships", &ben.token, json!({"username": "ann"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", ben.id), &ann.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(send(&app, &ben, &dm).await.0, StatusCode::OK);
    assert_eq!(open_dm(&app, &ben, &ann).await.0, StatusCode::OK);
}

#[tokio::test]
async fn dms_from_server_members_off_blocks_an_existing_dm() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let (_, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    let (_, dm) = open_dm(&app, &ben, &ann).await;
    let dm = dm["id"].as_str().expect("dm id").to_owned();

    let off = json!({"version": 0, "settings": {"dms_from_server_members": false}});
    assert_eq!(app.patch("/users/@me/settings", &ann.token, off).await.0, StatusCode::OK);
    assert!(refused(send(&app, &ben, &dm).await));
}

#[tokio::test]
async fn typing_follows_the_rule_while_group_dms_and_edits_are_untouched() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let cat = person(&app, "cat").await;
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    // cat is friends with both, so cat can put ann and ben in a group DM.
    for who in [&ann, &ben] {
        assert_eq!(
            app.post("/users/@me/relationships", &cat.token, json!({"username": if who.id == ann.id { "ann" } else { "ben" }})).await.0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(app.put(&format!("/users/@me/relationships/{}", cat.id), &who.token).await.0, StatusCode::NO_CONTENT);
    }
    let (_, dm) = open_dm(&app, &ben, &ann).await;
    let dm = dm["id"].as_str().expect("dm id").to_owned();
    let (_, sent) = send(&app, &ben, &dm).await;
    let (status, group) = app.post("/users/@me/channels", &cat.token, json!({"recipient_ids": [ann.id, ben.id]})).await;
    assert_eq!(status, StatusCode::OK, "{group}");
    let group = group["id"].as_str().expect("group id").to_owned();

    set_dms(&app, &ann, &guild, false).await;
    assert!(refused(app.post(&format!("/channels/{dm}/typing"), &ben.token, json!({})).await));
    // Group DMs are not covered by the per-guild setting (as on Discord).
    assert_eq!(send(&app, &ben, &group).await.0, StatusCode::OK);
    assert_eq!(app.post(&format!("/channels/{group}/typing"), &ben.token, json!({})).await.0, StatusCode::NO_CONTENT);
    // Editing a message already sent stays allowed: the rule is about reaching ann with something new.
    let path = format!("/channels/{dm}/messages/{}", sent["id"].as_str().expect("message id"));
    assert_eq!(app.patch(&path, &ben.token, json!({"content": "edited"})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn reactions_in_a_dm_follow_blocks_and_the_rule() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    let (_, dm) = open_dm(&app, &ben, &ann).await;
    let dm = dm["id"].as_str().expect("dm id").to_owned();
    let (_, sent) = send(&app, &ben, &dm).await;
    let react = |emoji: &str| format!("/channels/{dm}/messages/{}/reactions/{emoji}/@me", sent["id"].as_str().expect("message id"));
    assert_eq!(app.put(&react("👍"), &ben.token).await.0, StatusCode::NO_CONTENT);

    // ann restricts the shared guild: ben's reactions reach her like messages, so they are refused; hers still go through.
    set_dms(&app, &ann, &guild, false).await;
    assert!(refused(app.put(&react("🎉"), &ben.token).await));
    assert_eq!(app.put(&react("🎉"), &ann.token).await.0, StatusCode::NO_CONTENT);
    // Removing an own reaction stays possible.
    assert_eq!(app.delete(&react("👍"), &ben.token).await.0, StatusCode::NO_CONTENT);

    // A block closes reactions both ways, even with the guild open again.
    set_dms(&app, &ann, &guild, true).await;
    assert_eq!(app.put_json(&format!("/users/@me/relationships/{}", ann.id), &ben.token, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    assert!(refused(app.put(&react("🔥"), &ben.token).await));
    assert!(refused(app.put(&react("🔥"), &ann.token).await));
    // Pinning posts a notice and reopens the DM, so it is refused too; a poll vote reaches the other side like a reaction.
    let pin = format!("/channels/{dm}/messages/pins/{}", sent["id"].as_str().expect("message id"));
    assert!(refused(app.put(&pin, &ben.token).await));
    assert!(refused(app.put(&pin, &ann.token).await));
}

#[tokio::test]
async fn poll_votes_in_a_dm_follow_the_rule() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    let (_, dm) = open_dm(&app, &ann, &ben).await;
    let dm = dm["id"].as_str().expect("dm id").to_owned();
    let poll = json!({"poll": {"question": {"text": "Lunch?"}, "answers": [{"poll_media": {"text": "Yes"}}, {"poll_media": {"text": "No"}}], "duration": 1}});
    let (status, sent) = app.post(&format!("/channels/{dm}/messages"), &ann.token, poll).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    let vote = format!("/channels/{dm}/polls/{}/answers/1/@me", sent["id"].as_str().expect("message id"));
    set_dms(&app, &ann, &guild, false).await;
    assert!(refused(app.put(&vote, &ben.token).await));
    set_dms(&app, &ann, &guild, true).await;
    assert_eq!(app.put(&vote, &ben.token).await.0, StatusCode::NO_CONTENT);
    // Taking a vote back stays possible after the guild is restricted again.
    set_dms(&app, &ann, &guild, false).await;
    assert_eq!(app.delete(&vote, &ben.token).await.0, StatusCode::NO_CONTENT);
}
