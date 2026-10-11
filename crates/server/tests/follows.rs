#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Announcement channels: following one into another server's channel, publishing (crossposting) and the permissions around both.
mod common;
mod support_threads;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support_threads::{Client, Member, World, code, world};

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

/// The second server: owned by bob, with a `general` channel that will receive the follow; alice is a plain member there.
struct Other {
    guild: String,
    feed: String,
}

async fn other_server(w: &World) -> Other {
    let (status, guild) = w.app.post("/guilds", &w.bob.token, json!({"name": "Other server"})).await;
    assert_eq!(status, StatusCode::OK, "{guild}");
    let guild_id = id(&guild);
    let (_, channels) = w.app.get(&format!("/guilds/{guild_id}/channels"), &w.bob.token).await;
    let feed = id(channels.as_array().unwrap().iter().find(|channel| channel["name"] == "general").unwrap());
    let (_, invite) = w.app.post(&format!("/channels/{feed}/invites"), &w.bob.token, json!({})).await;
    let invite = invite["code"].as_str().unwrap().to_owned();
    assert_eq!(w.app.post(&format!("/invites/{invite}"), &w.alice.token, json!({})).await.0, StatusCode::OK);
    Other { guild: guild_id, feed }
}

/// bob joins the first server (to be able to see its announcements).
async fn bob_joins(w: &World) {
    let (_, invite) = w.app.post(&format!("/channels/{}/invites", w.general), &w.owner.token, json!({})).await;
    let invite = invite["code"].as_str().unwrap().to_owned();
    assert_eq!(w.app.post(&format!("/invites/{invite}"), &w.bob.token, json!({})).await.0, StatusCode::OK);
}

async fn follow(w: &World, user: &Member, source: &str, target: &str) -> (StatusCode, Value) {
    w.app.post(&format!("/channels/{source}/followers"), &user.token, json!({"webhook_channel_id": target})).await
}

#[tokio::test]
async fn following_needs_an_announcement_source_and_manage_webhooks_on_the_target() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    bob_joins(&w).await;
    let other = other_server(&w).await;

    let (status, followed) = follow(&w, &w.bob, &news, &other.feed).await;
    assert_eq!(status, StatusCode::OK, "{followed}");
    assert_eq!(followed["channel_id"], news.as_str());
    let follow_id = id(&json!({"id": followed["webhook_id"]}));
    // repeating returns the same follow
    let (status, again) = follow(&w, &w.bob, &news, &other.feed).await;
    assert_eq!((status, again["webhook_id"].clone()), (StatusCode::OK, followed["webhook_id"].clone()));

    // alice is in the other server without MANAGE_WEBHOOKS; carol cannot even see it
    let (status, error) = follow(&w, &w.alice, &news, &other.feed).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = follow(&w, &w.carol, &news, &other.feed).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50001)));
    // the source must be an announcement channel the caller can see; the target another text / announcement channel
    let (status, error) = follow(&w, &w.bob, &w.general, &other.feed).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, error) = follow(&w, &w.owner, &news, &news).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let voice = id(&w.channel(json!({"type": 2, "name": "voice"})).await);
    let (status, error) = follow(&w, &w.owner, &news, &voice).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, error) = follow(&w, &w.bob, "999999999999", &other.feed).await;
    assert_eq!((status, code(&error)), (StatusCode::NOT_FOUND, Some(10003)));

    // the target lists its follows, for MANAGE_WEBHOOKS holders only
    let (status, followers) = w.app.get(&format!("/channels/{}/followers", other.feed), &w.bob.token).await;
    assert_eq!(status, StatusCode::OK, "{followers}");
    let followers = followers.as_array().unwrap();
    assert_eq!(followers.len(), 1);
    assert_eq!(
        (followers[0]["id"].clone(), followers[0]["channel_id"].clone(), followers[0]["guild_id"].clone(), followers[0]["source_channel_id"].clone()),
        (json!(follow_id), json!(other.feed), json!(other.guild), json!(news))
    );
    assert_eq!(
        (followers[0]["source_channel_name"].clone(), followers[0]["source_guild_id"].clone(), followers[0]["source_guild_name"].clone()),
        (json!("news"), json!(w.guild), json!("Test guild"))
    );
    assert_eq!(w.app.get(&format!("/channels/{}/followers", other.feed), &w.alice.token).await.0, StatusCode::FORBIDDEN);

    // unfollowing needs MANAGE_WEBHOOKS on the target, and the follow must belong to it
    assert_eq!(w.app.delete(&format!("/channels/{}/followers/{follow_id}", other.feed), &w.alice.token).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/channels/{news}/followers/{follow_id}"), &w.owner.token).await.0, StatusCode::NOT_FOUND, "{{id}} is the target channel");
    assert_eq!(w.app.delete(&format!("/channels/{}/followers/{follow_id}", other.feed), &w.bob.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&format!("/channels/{}/followers/{follow_id}", other.feed), &w.bob.token).await.0, StatusCode::NOT_FOUND);
    let (_, followers) = w.app.get(&format!("/channels/{}/followers", other.feed), &w.bob.token).await;
    assert!(followers.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn publishing_copies_a_message_into_every_follower_channel() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    bob_joins(&w).await;
    let other = other_server(&w).await;
    // a second follower inside the same server
    let mirror = id(&w.channel(json!({"type": 0, "name": "mirror"})).await);
    assert_eq!(follow(&w, &w.bob, &news, &other.feed).await.0, StatusCode::OK);
    assert_eq!(follow(&w, &w.owner, &news, &mirror).await.0, StatusCode::OK);

    let mut bob = Client::connect(&w.address, &w.bob.token).await;
    let mut owner = Client::connect(&w.address, &w.owner.token).await;
    let source = w.say(&news, &w.owner, "Release 1.0 is out").await;
    let sid = id(&source);
    sqlx::query("UPDATE messages SET embeds = $2::jsonb WHERE id = $1")
        .bind(sid.parse::<i64>().unwrap())
        .bind(json!([{"type": "link", "url": "https://example.test/release", "title": "Release notes"}]).to_string())
        .execute(&w.app.state.db)
        .await
        .unwrap();

    // attachments stay behind: the source keeps its file, the copies carry none
    sqlx::query("INSERT INTO attachments (id, channel_id, uploader_id, message_id, filename, content_type, size, key) VALUES ($1, $2, $3, $4, 'cat.png', 'image/png', 10, 'k')")
        .bind(sid.parse::<i64>().unwrap() + 1)
        .bind(news.parse::<i64>().unwrap())
        .bind(w.owner.id.parse::<i64>().unwrap())
        .bind(sid.parse::<i64>().unwrap())
        .execute(&w.app.state.db)
        .await
        .unwrap();
    assert_eq!(w.messages(&news, &w.owner).await[0]["attachments"].as_array().unwrap().len(), 1);
    let (status, published) = w.app.post(&format!("/channels/{news}/messages/{sid}/crosspost"), &w.owner.token, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["flags"].as_u64().unwrap() & 1, 1, "CROSSPOSTED");
    let updated = owner.wait_match("MESSAGE_UPDATE", |data| data["id"] == sid.as_str()).await;
    assert_eq!(updated["flags"].as_u64().unwrap() & 1, 1);

    // the copy in the other server: regular message by the original author, flagged IS_CROSSPOST, pointing at the source
    let copy = bob.wait_match("MESSAGE_CREATE", |data| data["channel_id"] == other.feed.as_str()).await;
    assert_eq!((copy["content"].clone(), copy["type"].clone(), copy["author"]["id"].clone()), (json!("Release 1.0 is out"), json!(0), json!(w.owner.id)));
    assert_eq!(copy["flags"].as_u64().unwrap() & 2, 2, "IS_CROSSPOST");
    assert_eq!(copy["flags"].as_u64().unwrap() & 1, 0);
    assert_eq!(
        (copy["message_reference"]["message_id"].clone(), copy["message_reference"]["channel_id"].clone(), copy["message_reference"]["guild_id"].clone()),
        (json!(sid), json!(news), json!(w.guild))
    );
    assert_eq!(copy["attachments"], json!([]));
    assert_eq!(copy["embeds"][0]["title"], "Release notes", "embeds are copied");
    assert_eq!(copy["guild_id"], other.guild.as_str());
    // (the channel also holds alice's join notice, the system channel of that server)
    let copies = |messages: Vec<Value>| messages.into_iter().filter(|message| message["flags"].as_u64().unwrap_or(0) & 2 != 0).collect::<Vec<_>>();
    let listed = copies(w.messages(&other.feed, &w.bob).await);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], copy["id"]);
    // ... and in the same-server follower
    let local = w.messages(&mirror, &w.carol).await;
    assert_eq!((local.len(), local[0]["flags"].as_u64().unwrap() & 2), (1, 2));
    // the author is not a member of the other server, so it never touches their read states there
    let (reads,): (i64,) = sqlx::query_as("SELECT count(*) FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(w.owner.id.parse::<i64>().unwrap())
        .bind(other.feed.parse::<i64>().unwrap())
        .fetch_one(&w.app.state.db)
        .await
        .unwrap();
    assert_eq!(reads, 0);

    // publishing twice is refused and delivers nothing more
    let (status, error) = w.app.post(&format!("/channels/{news}/messages/{sid}/crosspost"), &w.owner.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(40033)));
    assert_eq!(copies(w.messages(&other.feed, &w.bob).await).len(), 1);
    // deleting the copy leaves the source alone
    assert_eq!(w.app.delete(&format!("/channels/{}/messages/{}", other.feed, id(&copy)), &w.bob.token).await.0, StatusCode::NO_CONTENT);
    let kept = w.messages(&news, &w.owner).await;
    assert_eq!(kept[0]["id"], sid.as_str());
}

#[tokio::test]
async fn who_may_publish_what() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    let mirror = id(&w.channel(json!({"type": 0, "name": "mirror"})).await);
    assert_eq!(follow(&w, &w.owner, &news, &mirror).await.0, StatusCode::OK);

    // authors publish their own messages, others need MANAGE_MESSAGES
    let alices = id(&w.say(&news, &w.alice, "mine").await);
    let carols = id(&w.say(&news, &w.carol, "hers").await);
    let (status, error) = w.app.post(&format!("/channels/{news}/messages/{carols}/crosspost"), &w.alice.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    assert_eq!(w.app.post(&format!("/channels/{news}/messages/{alices}/crosspost"), &w.alice.token, json!({})).await.0, StatusCode::OK);
    assert_eq!(w.app.post(&format!("/channels/{news}/messages/{carols}/crosspost"), &w.owner.token, json!({})).await.0, StatusCode::OK);
    let authors: Vec<String> = w.messages(&mirror, &w.owner).await.iter().map(|message| message["author"]["username"].as_str().unwrap().to_owned()).collect();
    assert_eq!(authors, ["carol", "alice"], "copies keep their authors");
    // an outsider cannot see the channel
    assert_eq!(w.app.post(&format!("/channels/{news}/messages/{alices}/crosspost"), &w.bob.token, json!({})).await.0, StatusCode::FORBIDDEN);

    // only announcement channels, only user messages, never a copy
    let plain = id(&w.say(&w.general, &w.owner, "plain").await);
    let (status, error) = w.app.post(&format!("/channels/{}/messages/{plain}/crosspost", w.general), &w.owner.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));
    let (status, error) = w.app.post(&format!("/channels/{news}/messages/999999999999/crosspost"), &w.owner.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::NOT_FOUND, Some(10008)));
    let pinned = id(&w.say(&news, &w.owner, "to pin").await);
    assert_eq!(w.app.put(&format!("/channels/{news}/messages/pins/{pinned}"), &w.owner.token).await.0, StatusCode::NO_CONTENT);
    let notice = w.messages(&news, &w.owner).await.into_iter().find(|message| message["type"] == 6).expect("pin notice");
    let (status, error) = w.app.post(&format!("/channels/{news}/messages/{}/crosspost", id(&notice)), &w.owner.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
}

#[tokio::test]
async fn deleting_either_end_removes_the_follow_and_unfollowed_channels_get_nothing() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    let mirror = id(&w.channel(json!({"type": 0, "name": "mirror"})).await);
    let second_mirror = id(&w.channel(json!({"type": 0, "name": "mirror-2"})).await);
    let (_, first) = follow(&w, &w.owner, &news, &mirror).await;
    assert_eq!(follow(&w, &w.owner, &news, &second_mirror).await.0, StatusCode::OK);
    let count = || async {
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM channel_follows").fetch_one(&w.app.state.db).await.unwrap();
        n
    };
    assert_eq!(count().await, 2);

    // unfollow one, publish: only the other receives it
    assert_eq!(
        w.app.delete(&format!("/channels/{mirror}/followers/{}", first["webhook_id"].as_str().unwrap()), &w.owner.token).await.0,
        StatusCode::NO_CONTENT
    );
    let sid = id(&w.say(&news, &w.owner, "after unfollow").await);
    assert_eq!(w.app.post(&format!("/channels/{news}/messages/{sid}/crosspost"), &w.owner.token, json!({})).await.0, StatusCode::OK);
    assert!(w.messages(&mirror, &w.owner).await.is_empty());
    assert_eq!(w.messages(&second_mirror, &w.owner).await.len(), 1);

    // deleting the target, then the source
    assert_eq!(w.app.delete(&format!("/channels/{second_mirror}"), &w.owner.token).await.0, StatusCode::OK);
    assert_eq!(count().await, 0);
    assert_eq!(follow(&w, &w.owner, &news, &mirror).await.0, StatusCode::OK);
    assert_eq!(count().await, 1);
    assert_eq!(w.app.delete(&format!("/channels/{news}"), &w.owner.token).await.0, StatusCode::OK);
    assert_eq!(count().await, 0);
}

#[tokio::test]
async fn announcement_channels_take_announcement_threads() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    let post = id(&w.say(&news, &w.owner, "big news").await);
    let thread = w.thread_from(&news, &post, &w.alice, "discussion").await;
    assert_eq!((thread["type"].clone(), thread["parent_id"].clone()), (json!(10), json!(news)));
    let (status, free) = w.thread(&news, &w.alice, json!({"name": "more"})).await;
    assert_eq!((status, free["type"].clone()), (StatusCode::OK, json!(10)));
    let (status, error) = w.thread(&news, &w.alice, json!({"name": "private", "type": 12})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "announcement channels have no private threads");
}

#[tokio::test]
async fn copies_never_expand_their_source_for_viewers_outside_its_channel() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    bob_joins(&w).await;
    let other = other_server(&w).await;
    assert_eq!(follow(&w, &w.bob, &news, &other.feed).await.0, StatusCode::OK);
    let dave = {
        let (token, user) = w.app.register("dave").await;
        let (_, invite) = w.app.post(&format!("/channels/{}/invites", other.feed), &w.bob.token, json!({})).await;
        assert_eq!(w.app.post(&format!("/invites/{}", invite["code"].as_str().unwrap()), &token, json!({})).await.0, StatusCode::OK);
        Member { token, id: id(&user) }
    };
    let sid = id(&w.say(&news, &w.owner, "with a file").await);
    sqlx::query("INSERT INTO attachments (id, channel_id, uploader_id, message_id, filename, content_type, size, key) VALUES ($1, $2, $3, $4, 'secret.png', 'image/png', 10, 'abc')")
        .bind(sid.parse::<i64>().unwrap() + 1)
        .bind(news.parse::<i64>().unwrap())
        .bind(w.owner.id.parse::<i64>().unwrap())
        .bind(sid.parse::<i64>().unwrap())
        .execute(&w.app.state.db)
        .await
        .unwrap();
    let mut live = Client::connect(&w.address, &dave.token).await;
    assert_eq!(w.app.post(&format!("/channels/{news}/messages/{sid}/crosspost"), &w.owner.token, json!({})).await.0, StatusCode::OK);

    // dave is only in the other server: the copy points at the source but carries nothing of it
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", other.feed), &dave.token).await;
    let copy = messages.as_array().unwrap().iter().find(|message| message["flags"].as_u64().unwrap_or(0) & 2 != 0).expect("copy");
    assert_eq!(copy["message_reference"]["message_id"], sid.as_str());
    assert!(copy["referenced_message"].is_null(), "{copy}");
    assert_eq!(copy["attachments"], json!([]));
    assert!(!copy.to_string().contains("secret.png"), "no download URL of the source leaks");
    // the live event is the same
    let event = live.wait_match("MESSAGE_CREATE", |data| data["flags"].as_u64().unwrap_or(0) & 2 != 0).await;
    assert!(event["referenced_message"].is_null() && !event.to_string().contains("secret.png"));
    // inside the source's own server the source still has its attachment
    assert_eq!(w.messages(&news, &w.carol).await[0]["attachments"][0]["filename"], "secret.png");
    // thread starters still expand: the viewer reads the parent
    let thread = w.thread_from(&news, &sid, &w.alice, "talk").await;
    let starter = &w.messages(&id(&thread), &w.carol).await[0];
    assert_eq!(starter["type"], 21);
    assert_eq!(starter["referenced_message"]["content"], "with a file");
}

#[tokio::test]
async fn published_copies_cannot_be_edited() {
    let w = world().await;
    let news = id(&w.channel(json!({"type": 5, "name": "news"})).await);
    let mirror = id(&w.channel(json!({"type": 0, "name": "mirror"})).await);
    assert_eq!(follow(&w, &w.owner, &news, &mirror).await.0, StatusCode::OK);
    let source = w.say(&news, &w.owner, "Release 1.0 is out").await;
    let sid = id(&source);
    let (status, published) = w.app.post(&format!("/channels/{news}/messages/{sid}/crosspost"), &w.owner.token, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{published}");
    let copy = w.messages(&mirror, &w.owner).await.into_iter().find(|message| message["flags"].as_u64().unwrap_or(0) & 2 != 0).expect("copy");
    let cid = id(&copy);

    // the copy is attributed to the original author, but it mirrors the source: no edits
    let (status, error) = w.app.patch(&format!("/channels/{mirror}/messages/{cid}"), &w.owner.token, json!({"content": "rewritten"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "{error}");
    let after = w.messages(&mirror, &w.owner).await.into_iter().find(|message| message["id"] == cid.as_str()).expect("copy");
    assert_eq!(after["content"], "Release 1.0 is out");
    // the source stays editable
    let (status, _) = w.app.patch(&format!("/channels/{news}/messages/{sid}"), &w.owner.token, json!({"content": "Release 1.0.1 is out"})).await;
    assert_eq!(status, StatusCode::OK);
}
