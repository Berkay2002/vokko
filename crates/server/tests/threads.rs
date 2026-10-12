#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Threads: starting them, archive / lock rules, permissions, private visibility, members, lists, gateway events, the sweep and deletion.
mod common;
mod support_threads;

use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{Value, json};
use support_threads::{Client, World, code, world};
use vokko_protocol::api::permissions::{CREATE_PUBLIC_THREADS, DEFAULT_EVERYONE, MANAGE_THREADS, READ_MESSAGE_HISTORY, SEND_MESSAGES_IN_THREADS};

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

impl World {
    async fn active(&self, user: &support_threads::Member) -> Vec<Value> {
        let (status, list) = self.app.get(&format!("/guilds/{}/threads/active", self.guild), &user.token).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        list["threads"].as_array().expect("threads").clone()
    }
}

#[tokio::test]
async fn a_thread_from_a_message_starts_with_its_starter_and_is_not_a_channel() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "let's talk").await;
    let mid = id(&original);
    let thread = w.thread_from(&w.general, &mid, &w.alice, "Talk").await;

    assert_eq!(thread["id"], mid.as_str(), "the thread id is the message id");
    assert_eq!(
        (thread["type"].as_u64(), thread["parent_id"].as_str(), thread["owner_id"].as_str()),
        (Some(11), Some(w.general.as_str()), Some(w.alice.id.as_str()))
    );
    assert_eq!(thread["name"], "Talk");
    let metadata = &thread["thread_metadata"];
    assert_eq!(
        (metadata["archived"].as_bool(), metadata["locked"].as_bool(), metadata["auto_archive_duration"].as_u64()),
        (Some(false), Some(false), Some(1440))
    );
    assert_eq!(
        (thread["newly_created"].as_bool(), thread["member"]["user_id"].as_str(), thread["member_count"].as_u64()),
        (Some(true), Some(w.alice.id.as_str()), Some(1))
    );

    // the first message is the type 21 starter pointing back at the original in the parent
    let messages = w.messages(&mid, &w.alice).await;
    assert_eq!(messages.len(), 1);
    let starter = &messages[0];
    assert_eq!(starter["type"], 21);
    assert_eq!(starter["message_reference"]["message_id"], mid.as_str());
    assert_eq!(starter["message_reference"]["channel_id"], w.general.as_str());
    assert_eq!(starter["referenced_message"]["content"], "let's talk");
    assert_eq!(starter["author"]["id"], w.owner.id.as_str(), "the starter is attributed to the original author");

    // the original now carries its thread
    let parent_messages = w.messages(&w.general, &w.alice).await;
    let carried = parent_messages.iter().find(|message| message["id"] == mid.as_str()).expect("original");
    assert_eq!(carried["thread"]["id"], mid.as_str());

    // one thread per message, none from inside a thread
    let (status, error) = w.app.post(&format!("/channels/{}/messages/{mid}/threads", w.general), &w.carol.token, json!({"name": "again"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(160004)));
    let starter_id = id(starter);
    let (status, error) = w.app.post(&format!("/channels/{mid}/messages/{starter_id}/threads"), &w.alice.token, json!({"name": "nested"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));
    let (status, error) = w.app.post(&format!("/channels/{}/messages/999999999999/threads", w.general), &w.alice.token, json!({"name": "ghost"})).await;
    assert_eq!((status, code(&error)), (StatusCode::NOT_FOUND, Some(10008)));
    let (status, error) = w.app.post(&format!("/channels/{}/messages/{mid}/threads", w.general), &w.alice.token, json!({"name": "  "})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));

    // threads are not channels of the guild, but they are active threads
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.carol.token).await;
    assert!(
        channels
            .as_array()
            .expect("channels")
            .iter()
            .all(|channel| channel["id"] != mid.as_str() && !(10..=12).contains(&channel["type"].as_u64().unwrap_or(0)))
    );
    let active = w.active(&w.carol).await;
    assert_eq!(active.len(), 1);
    assert_eq!(active[0]["id"], mid.as_str());
    assert!(active[0].get("member").is_none_or(Value::is_null), "carol has not joined");
}

#[tokio::test]
async fn archive_unarchive_and_lock() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "topic").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "Topic").await;
    w.say(&mid, &w.alice, "one").await;
    w.say(&mid, &w.owner, "two").await;

    // the owner of the thread archives it
    let (status, archived) = w.patch(&mid, &w.alice, json!({"archived": true})).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["thread_metadata"]["archived"], true);
    assert!(w.active(&w.alice).await.is_empty());
    let (_, listed) = w.app.get(&format!("/channels/{}/threads/archived/public", w.general), &w.carol.token).await;
    assert_eq!(listed["threads"][0]["id"], mid.as_str());
    assert_eq!(listed["threads"][0]["message_count"], 2, "messages after the starter");
    assert_eq!(listed["has_more"], false);

    // archived threads are read-only for edits, reactions and joining
    let (status, error) = w
        .app
        .patch(&format!("/channels/{mid}/messages/{}", w.messages(&mid, &w.alice).await[0]["id"].as_str().unwrap()), &w.alice.token, json!({"content": "x"}))
        .await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50083)));
    let (status, error) = w.patch(&mid, &w.alice, json!({"name": "renamed"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50083)), "only unarchiving is allowed on an archived thread");
    let (status, error) = w.app.put(&format!("/channels/{mid}/thread-members/@me"), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50083)));

    // a message into the archived thread unarchives it and joins the sender
    w.say(&mid, &w.carol, "anyone here?").await;
    let active = w.active(&w.carol).await;
    assert_eq!(active.len(), 1);
    assert_eq!(active[0]["thread_metadata"]["archived"], false);
    assert_eq!(active[0]["member"]["user_id"], w.carol.id.as_str());
    assert_eq!(active[0]["member_count"], 3);
    assert_eq!(active[0]["message_count"], 3);
    let (_, members) = w.app.get(&format!("/channels/{mid}/thread-members"), &w.carol.token).await;
    assert_eq!(members.as_array().expect("members").len(), 3);

    // archive and unarchive again with PATCH
    assert_eq!(w.patch(&mid, &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    let (status, reopened) = w.patch(&mid, &w.alice, json!({"archived": false})).await;
    assert_eq!((status, reopened["thread_metadata"]["archived"].clone()), (StatusCode::OK, json!(false)));

    // a moderator locks it: members cannot send or edit, moderators can
    let (status, locked) = w.patch(&mid, &w.owner, json!({"locked": true})).await;
    assert_eq!((status, locked["thread_metadata"]["locked"].clone()), (StatusCode::OK, json!(true)));
    let (status, error) = w.app.post(&format!("/channels/{mid}/messages"), &w.carol.token, json!({"content": "hello?"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(160005)));
    let (status, error) = w.patch(&mid, &w.alice, json!({"name": "mine", "locked": false})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(160005)), "even its owner cannot edit or unlock a locked thread");
    w.say(&mid, &w.owner, "moderators may").await;
    let (status, unlocked) = w.patch(&mid, &w.owner, json!({"locked": false})).await;
    assert_eq!((status, unlocked["thread_metadata"]["locked"].clone()), (StatusCode::OK, json!(false)));
    w.say(&mid, &w.carol, "thanks").await;

    // validation
    let (status, error) = w.patch(&mid, &w.alice, json!({"auto_archive_duration": 77})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, renamed) = w.patch(&mid, &w.alice, json!({"name": "Renamed", "auto_archive_duration": 4320})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((renamed["name"].clone(), renamed["thread_metadata"]["auto_archive_duration"].clone()), (json!("Renamed"), json!(4320)));
}

#[tokio::test]
async fn permissions_gate_creating_sending_and_moderating() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "anchor").await;
    let mid = id(&original);

    // CREATE_PUBLIC_THREADS
    w.set_everyone(DEFAULT_EVERYONE & !CREATE_PUBLIC_THREADS).await;
    let (status, error) = w.app.post(&format!("/channels/{}/messages/{mid}/threads", w.general), &w.alice.token, json!({"name": "no"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = w.thread(&w.general, &w.alice, json!({"name": "no"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    // a role brings it back for alice only
    w.role_for(&w.alice, DEFAULT_EVERYONE).await;
    w.thread_from(&w.general, &mid, &w.alice, "yes").await;

    // SEND_MESSAGES_IN_THREADS replaces SEND_MESSAGES inside threads
    w.set_everyone(DEFAULT_EVERYONE & !SEND_MESSAGES_IN_THREADS).await;
    w.say(&w.general, &w.carol, "still fine in the channel").await;
    let (status, error) = w.app.post(&format!("/channels/{mid}/messages"), &w.carol.token, json!({"content": "nope"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = w.app.post(&format!("/channels/{mid}/typing"), &w.carol.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    w.say(&mid, &w.alice, "alice's role keeps it").await;
    w.set_everyone(DEFAULT_EVERYONE).await;

    // only the owner or MANAGE_THREADS edit; locked / flags need MANAGE_THREADS
    let (status, error) = w.patch(&mid, &w.carol, json!({"archived": true})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = w.patch(&mid, &w.alice, json!({"locked": true})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = w.app.delete(&format!("/channels/{mid}"), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    w.role_for(&w.carol, DEFAULT_EVERYONE | MANAGE_THREADS).await;
    let (status, locked) = w.patch(&mid, &w.carol, json!({"locked": true, "archived": true})).await;
    assert_eq!(
        (status, locked["thread_metadata"]["locked"].clone(), locked["thread_metadata"]["archived"].clone()),
        (StatusCode::OK, json!(true), json!(true))
    );
    // flags and tags only exist on forum posts
    let (status, error) = w.patch(&mid, &w.carol, json!({"flags": 2})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));
    // a member cannot see a thread of a channel they cannot see
    let hidden = w.channel(json!({"type": 0, "name": "staff", "permission_overwrites": [{"id": w.guild, "type": 0, "allow": "0", "deny": "1024"}]})).await;
    let hidden_id = id(&hidden);
    let staff_message = w.say(&hidden_id, &w.owner, "secret").await;
    let staff_thread = w.thread_from(&hidden_id, &id(&staff_message), &w.owner, "secret thread").await;
    let (status, error) = w.app.get(&format!("/channels/{}/messages", id(&staff_thread)), &w.alice.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50001)));
    assert!(w.active(&w.alice).await.iter().all(|thread| thread["id"] != staff_thread["id"]));
    // wrong parent type
    let (status, error) = w.thread(&id(&w.channel(json!({"type": 2, "name": "voice"})).await), &w.owner, json!({"name": "x"})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));
}

#[tokio::test]
async fn threads_without_a_message_are_announced_in_the_parent_only_when_public() {
    let w = world().await;
    let (status, public) = w.thread(&w.general, &w.alice, json!({"name": "ideas", "auto_archive_duration": 60})).await;
    assert_eq!(status, StatusCode::OK, "{public}");
    assert_eq!(public["type"], 11);
    assert_eq!(public["thread_metadata"]["auto_archive_duration"], 60);
    let pid = id(&public);
    let parent_messages = w.messages(&w.general, &w.carol).await;
    let announcement = parent_messages.iter().find(|message| message["type"] == 18).expect("type 18 message in the parent");
    assert_eq!((announcement["content"].clone(), announcement["message_reference"]["channel_id"].clone()), (json!("ideas"), json!(pid)));
    assert_eq!(announcement["author"]["id"], w.alice.id.as_str());

    let (status, private) = w.thread(&w.general, &w.alice, json!({"name": "plans", "type": 12, "invitable": false})).await;
    assert_eq!(status, StatusCode::OK, "{private}");
    assert_eq!((private["type"].clone(), private["thread_metadata"]["invitable"].clone()), (json!(12), json!(false)));
    assert_eq!(w.messages(&w.general, &w.carol).await.iter().filter(|message| message["type"] == 18).count(), 1, "private threads post nothing in the parent");

    // an invalid thread type and a wrong parent
    let (status, error) = w.thread(&w.general, &w.alice, json!({"name": "x", "type": 0})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));

    // sending joins; counts follow
    w.say(&pid, &w.carol, "first").await;
    w.say(&pid, &w.carol, "second").await;
    let active = w.active(&w.carol).await;
    let thread = active.iter().find(|thread| thread["id"] == pid.as_str()).expect("public thread");
    assert_eq!((thread["message_count"].clone(), thread["member_count"].clone()), (json!(2), json!(2)));
    assert!(thread["last_message_id"].is_string());
}

#[tokio::test]
async fn private_threads_are_visible_to_members_and_moderators_only() {
    let w = world().await;
    let (_, private) = w.thread(&w.general, &w.alice, json!({"name": "closed", "type": 12})).await;
    let tid = id(&private);
    w.say(&tid, &w.alice, "just us").await;

    // carol is not a member
    let (status, error) = w.app.get(&format!("/channels/{tid}/messages"), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50001)));
    let (status, error) = w.app.post(&format!("/channels/{tid}/messages"), &w.carol.token, json!({"content": "let me in"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50001)));
    let (status, error) = w.app.put(&format!("/channels/{tid}/thread-members/@me"), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50001)), "private threads cannot be joined uninvited");
    assert!(w.active(&w.carol).await.is_empty());
    assert_eq!(w.active(&w.alice).await.len(), 1);
    assert_eq!(w.active(&w.owner).await.len(), 1, "MANAGE_THREADS holders see private threads");
    assert_eq!(w.messages(&tid, &w.owner).await.len(), 1);

    // invitable: members add others who can see the parent
    let (status, _) = w.app.put(&format!("/channels/{tid}/thread-members/{}", w.carol.id), &w.alice.token).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(w.messages(&tid, &w.carol).await.len(), 1);
    assert_eq!(w.active(&w.carol).await.len(), 1);
    // a stranger to the guild cannot be added
    let (status, error) = w.app.put(&format!("/channels/{tid}/thread-members/{}", w.bob.id), &w.alice.token).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    // carol is a member now and may invite while it is invitable, but not once the owner turns it off
    let (status, _) = w.app.put(&format!("/channels/{tid}/thread-members/{}", w.owner.id), &w.carol.token).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(w.patch(&tid, &w.alice, json!({"invitable": false})).await.0, StatusCode::OK);
    let (status, error) = w.app.put(&format!("/channels/{tid}/thread-members/{}", w.bob.id), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)), "no longer invitable: only the owner and moderators add people");
    // leaving hides it again
    assert_eq!(w.app.delete(&format!("/channels/{tid}/thread-members/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&format!("/channels/{tid}/messages"), &w.carol.token).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.put(&format!("/channels/{tid}/thread-members/{}", w.carol.id), &w.alice.token).await.0, StatusCode::NO_CONTENT, "the owner can still add");
    // private archived lists: moderators list all, members list their own
    assert_eq!(w.patch(&tid, &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    let (status, error) = w.app.get(&format!("/channels/{}/threads/archived/private", w.general), &w.alice.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (_, all) = w.app.get(&format!("/channels/{}/threads/archived/private", w.general), &w.owner.token).await;
    assert_eq!(all["threads"][0]["id"], tid.as_str());
    let (_, joined) = w.app.get(&format!("/channels/{}/users/@me/threads/archived/private", w.general), &w.carol.token).await;
    assert_eq!(joined["threads"][0]["id"], tid.as_str());
    assert_eq!(joined["members"][0]["user_id"], w.carol.id.as_str());
    let (_, public) = w.app.get(&format!("/channels/{}/threads/archived/public", w.general), &w.owner.token).await;
    assert!(public["threads"].as_array().expect("threads").is_empty(), "private threads are not in the public list");
}

#[tokio::test]
async fn thread_member_endpoints() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "x").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "members").await;
    let members = format!("/channels/{mid}/thread-members");

    // join, again (still 204), read back
    assert_eq!(w.app.put(&format!("{members}/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.put(&format!("{members}/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    let (status, own) = w.app.get(&format!("{members}/@me"), &w.carol.token).await;
    assert_eq!((status, own["user_id"].clone(), own["id"].clone()), (StatusCode::OK, json!(w.carol.id), json!(mid)));
    let (_, list) = w.app.get(&members, &w.alice.token).await;
    assert_eq!(list.as_array().expect("members").len(), 2);
    // not a member: 404 10065
    let (status, error) = w.app.get(&format!("{members}/{}", w.owner.id), &w.alice.token).await;
    assert_eq!((status, code(&error)), (StatusCode::NOT_FOUND, Some(10065)));

    // removing others needs ownership or MANAGE_THREADS
    let (status, error) = w.app.delete(&format!("{members}/{}", w.alice.id), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    assert_eq!(w.app.delete(&format!("{members}/{}", w.carol.id), &w.alice.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&format!("{members}/{}", w.carol.id), &w.alice.token).await.0, StatusCode::NOT_FOUND);
    // adding others on a public thread: the owner may, a plain member may not
    assert_eq!(w.app.put(&format!("{members}/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    let (status, error) = w.app.put(&format!("{members}/{}", w.owner.id), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    assert_eq!(w.app.put(&format!("{members}/{}", w.owner.id), &w.alice.token).await.0, StatusCode::NO_CONTENT);
    // leave
    assert_eq!(w.app.delete(&format!("{members}/@me"), &w.alice.token).await.0, StatusCode::NO_CONTENT);
    let (_, list) = w.app.get(&members, &w.carol.token).await;
    assert_eq!(list.as_array().expect("members").len(), 2);
    // a channel is not a thread
    let (status, error) = w.app.put(&format!("/channels/{}/thread-members/@me", w.general), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));
    // outsiders cannot see the thread at all
    assert_eq!(w.app.get(&members, &w.bob.token).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn thread_member_settings_set_the_level_and_mute() {
    let w = world().await;
    let mut carol = Client::connect(&w.address, &w.carol.token).await;
    let mut owner = Client::connect(&w.address, &w.owner.token).await;
    let original = w.say(&w.general, &w.owner, "x").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "settings").await;
    let me = format!("/channels/{mid}/thread-members/@me");

    // not a member: 404 10065
    let (status, error) = w.app.patch(&me, &w.carol.token, json!({"flags": 2})).await;
    assert_eq!((status, code(&error)), (StatusCode::NOT_FOUND, Some(10065)));
    assert_eq!(w.app.put(&me, &w.carol.token).await.0, StatusCode::NO_CONTENT);
    carol.wait_match("THREAD_MEMBER_UPDATE", |data| data["id"] == mid.as_str()).await;

    // set the level, read it back, hear about it
    let (status, member) = w.app.patch(&me, &w.carol.token, json!({"flags": 4})).await;
    assert_eq!(
        (status, member["flags"].clone(), member["muted"].clone(), member["mute_config"].clone()),
        (StatusCode::OK, json!(4), json!(false), Value::Null)
    );
    let event = carol.wait_match("THREAD_MEMBER_UPDATE", |data| data["id"] == mid.as_str() && data["flags"] == 4).await;
    assert_eq!(event["guild_id"], json!(w.guild));
    assert_eq!(w.app.get(&me, &w.carol.token).await.1["flags"], 4);
    // HAS_INTERACTED is kept; clearing the notify bits goes back to the channel default
    let (_, member) = w.app.patch(&me, &w.carol.token, json!({"flags": 0})).await;
    assert_eq!(member["flags"], 0);

    // more than one notify bit, or unknown bits: 400 50035
    for flags in [6, 14, 16] {
        let (status, error) = w.app.patch(&me, &w.carol.token, json!({"flags": flags})).await;
        assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)), "flags {flags}");
    }

    // mute forever, then a timed mute, then unmute
    let (_, member) = w.app.patch(&me, &w.carol.token, json!({"muted": true, "mute_config": null})).await;
    assert_eq!((member["muted"].clone(), member["mute_config"].clone()), (json!(true), json!({"end_time": null})));
    let (_, member) = w.app.patch(&me, &w.carol.token, json!({"muted": true, "mute_config": {"end_time": "2999-01-01T00:00:00.000Z"}})).await;
    assert_eq!((member["muted"].clone(), member["mute_config"]["end_time"].clone()), (json!(true), json!("2999-01-01T00:00:00Z")));
    let (status, error) = w.app.patch(&me, &w.carol.token, json!({"muted": true, "mute_config": {"end_time": "2000-01-01T00:00:00.000Z"}})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (_, member) = w.app.patch(&me, &w.carol.token, json!({"muted": false})).await;
    assert_eq!((member["muted"].clone(), member["mute_config"].clone()), (json!(false), Value::Null));

    // a mute whose end has passed reads as unmuted
    let thread_id: i64 = mid.parse().expect("thread id");
    sqlx::query("UPDATE thread_members SET muted = TRUE, mute_end = now() - interval '1 minute' WHERE thread_id = $1 AND user_id = $2")
        .bind(thread_id)
        .bind(w.carol.id.parse::<i64>().expect("user id"))
        .execute(&w.app.state.db)
        .await
        .expect("expire the mute");
    let own = w.app.get(&me, &w.carol.token).await.1;
    assert_eq!((own["muted"].clone(), own["mute_config"].clone()), (json!(false), Value::Null));
    // `mute_config: null` alone changes nothing (the expired mute does not turn into a forever one)
    let (_, member) = w.app.patch(&me, &w.carol.token, json!({"mute_config": null})).await;
    assert_eq!((member["muted"].clone(), member["mute_config"].clone()), (json!(false), Value::Null));
    // a config object alone mutes
    let (_, member) = w.app.patch(&me, &w.carol.token, json!({"mute_config": {"end_time": null}})).await;
    assert_eq!((member["muted"].clone(), member["mute_config"].clone()), (json!(true), json!({"end_time": null})));

    // HAS_INTERACTED survives a level change; the caller's own numeric id works like @me, anyone else's is 403
    sqlx::query("UPDATE thread_members SET flags = 1 WHERE thread_id = $1 AND user_id = $2")
        .bind(thread_id)
        .bind(w.carol.id.parse::<i64>().expect("user id"))
        .execute(&w.app.state.db)
        .await
        .expect("mark interacted");
    let (status, member) = w.app.patch(&format!("/channels/{mid}/thread-members/{}", w.carol.id), &w.carol.token, json!({"flags": 2})).await;
    assert_eq!((status, member["flags"].clone()), (StatusCode::OK, json!(3)));
    let (status, _) = w.app.patch(&format!("/channels/{mid}/thread-members/{}", w.owner.id), &w.carol.token, json!({"flags": 2})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // archived threads still take settings; nobody else hears about it
    assert_eq!(w.patch(&mid, &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    assert_eq!(w.app.patch(&me, &w.carol.token, json!({"flags": 8})).await.0, StatusCode::OK);
    assert!(owner.silent_for("THREAD_MEMBER_UPDATE", Duration::from_millis(300), |data| data["flags"] == 8).await);
}

#[tokio::test]
async fn archived_lists_page_by_archive_time() {
    let w = world().await;
    let mut ids = Vec::new();
    for name in ["one", "two", "three"] {
        let (_, thread) = w.thread(&w.general, &w.alice, json!({"name": name})).await;
        ids.push(id(&thread));
        assert_eq!(w.patch(&id(&thread), &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    }
    let path = format!("/channels/{}/threads/archived/public", w.general);
    let (_, first) = w.app.get(&format!("{path}?limit=2"), &w.carol.token).await;
    let names: Vec<&str> = first["threads"].as_array().expect("threads").iter().map(|thread| thread["name"].as_str().unwrap()).collect();
    assert_eq!((names, first["has_more"].clone()), (vec!["three", "two"], json!(true)), "newest archive first");
    let before = first["threads"][1]["thread_metadata"]["archive_timestamp"].as_str().expect("timestamp").replace('+', "%2B");
    let (_, second) = w.app.get(&format!("{path}?limit=2&before={before}"), &w.carol.token).await;
    assert_eq!((second["threads"][0]["name"].clone(), second["has_more"].clone()), (json!("one"), json!(false)));
    let (status, error) = w.app.get(&format!("{path}?limit=0"), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    // listing archived threads of a thread is a type error
    let (status, error) = w.app.get(&format!("/channels/{}/threads/archived/public", ids[0]), &w.carol.token).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));
}

#[tokio::test]
async fn events_follow_the_thread_audience() {
    let w = world().await;
    let mut owner = Client::connect(&w.address, &w.owner.token).await;
    let mut carol = Client::connect(&w.address, &w.carol.token).await;
    let original = w.say(&w.general, &w.alice, "hello").await;
    let mid = id(&original);

    // a public thread reaches everyone who sees the parent, without a `member` for those who did not join
    let thread = w.thread_from(&w.general, &mid, &w.alice, "public").await;
    let created = carol.wait_id("THREAD_CREATE", &mid).await;
    assert_eq!((created["newly_created"].clone(), created["type"].clone(), created["guild_id"].clone()), (json!(true), json!(11), json!(w.guild)));
    assert!(created.get("member").is_none_or(Value::is_null));
    assert_eq!(thread["id"], created["id"]);
    let update = owner.wait_id("MESSAGE_UPDATE", &mid).await;
    assert_eq!(update["thread"]["id"], mid.as_str(), "the starter message now carries its thread");

    // join / leave
    assert_eq!(w.app.put(&format!("/channels/{mid}/thread-members/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    let own = carol.wait_match("THREAD_MEMBER_UPDATE", |data| data["id"] == mid.as_str()).await;
    assert_eq!((own["user_id"].clone(), own["guild_id"].clone()), (json!(w.carol.id), json!(w.guild)));
    let joined = owner.wait_match("THREAD_MEMBERS_UPDATE", |data| data["id"] == mid.as_str()).await;
    assert_eq!((joined["member_count"].clone(), joined["added_members"][0]["user_id"].clone()), (json!(2), json!(w.carol.id)));
    assert_eq!(w.app.delete(&format!("/channels/{mid}/thread-members/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    let left = owner.wait_match("THREAD_MEMBERS_UPDATE", |data| data["removed_member_ids"].is_array()).await;
    assert_eq!((left["member_count"].clone(), left["removed_member_ids"][0].clone()), (json!(1), json!(w.carol.id)));

    // archive / edit => THREAD_UPDATE with the new state
    assert_eq!(w.patch(&mid, &w.alice, json!({"archived": true, "name": "renamed"})).await.0, StatusCode::OK);
    let updated = carol.wait_id("THREAD_UPDATE", &mid).await;
    assert_eq!((updated["thread_metadata"]["archived"].clone(), updated["name"].clone()), (json!(true), json!("renamed")));
    let mine = w.say(&mid, &w.alice, "reopened by talking").await;
    let reopened = carol.wait_id("THREAD_UPDATE", &mid).await;
    assert_eq!(reopened["thread_metadata"]["archived"], false);
    assert_eq!(carol.wait_match("MESSAGE_CREATE", |data| data["id"] == mine["id"]).await["channel_id"], mid.as_str());

    // private: only members and moderators hear about it, its messages and its typing
    let (_, private) = w.thread(&w.general, &w.alice, json!({"name": "closed", "type": 12})).await;
    let pid = id(&private);
    let created = owner.wait_id("THREAD_CREATE", &pid).await;
    assert_eq!(created["type"], 12);
    assert!(carol.silent_for("THREAD_CREATE", Duration::from_millis(300), |data| data["id"] == pid.as_str()).await, "carol is not in it");
    let secret = w.say(&pid, &w.alice, "hush").await;
    assert_eq!(owner.wait_match("MESSAGE_CREATE", |data| data["id"] == secret["id"]).await["content"], "hush");
    assert_eq!(w.app.post(&format!("/channels/{pid}/typing"), &w.alice.token, json!({})).await.0, StatusCode::NO_CONTENT);
    owner.wait_match("TYPING_START", |data| data["channel_id"] == pid.as_str()).await;
    assert!(carol.silent_for("MESSAGE_CREATE", Duration::from_millis(300), |data| data["channel_id"] == pid.as_str()).await);
    assert!(carol.silent_for("TYPING_START", Duration::from_millis(100), |data| data["channel_id"] == pid.as_str()).await);
    // invited: THREAD_CREATE for the new member, then the member update
    assert_eq!(w.app.put(&format!("/channels/{pid}/thread-members/{}", w.carol.id), &w.alice.token).await.0, StatusCode::NO_CONTENT);
    let invited = carol.wait_id("THREAD_CREATE", &pid).await;
    assert_eq!(invited["member"]["user_id"], w.carol.id.as_str());
    carol.wait_match("THREAD_MEMBER_UPDATE", |data| data["id"] == pid.as_str()).await;
    // removed again: carol is told the thread is gone for her
    assert_eq!(w.app.delete(&format!("/channels/{pid}/thread-members/{}", w.carol.id), &w.alice.token).await.0, StatusCode::NO_CONTENT);
    let gone = carol.wait_id("THREAD_DELETE", &pid).await;
    assert_eq!((gone["parent_id"].clone(), gone["type"].clone(), gone["guild_id"].clone()), (json!(w.general), json!(12), json!(w.guild)));
}

#[tokio::test]
async fn ready_carries_the_active_threads_the_user_can_see() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "start").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "visible").await;
    let (_, private) = w.thread(&w.general, &w.alice, json!({"name": "closed", "type": 12})).await;
    let (_, archived) = w.thread(&w.general, &w.alice, json!({"name": "old"})).await;
    assert_eq!(w.patch(&id(&archived), &w.alice, json!({"archived": true})).await.0, StatusCode::OK);

    let alice = Client::connect(&w.address, &w.alice.token).await;
    let guild = &alice.ready["guilds"][0];
    let thread_ids: Vec<&str> = guild["threads"].as_array().expect("threads").iter().map(|thread| thread["id"].as_str().unwrap()).collect();
    assert!(thread_ids.contains(&mid.as_str()) && thread_ids.contains(&id(&private).as_str()) && !thread_ids.contains(&id(&archived).as_str()));
    let own = guild["threads"].as_array().unwrap().iter().find(|thread| thread["id"] == mid.as_str()).unwrap();
    assert_eq!(own["member"]["user_id"], w.alice.id.as_str(), "READY fills the viewer's membership");
    assert!(guild["channels"].as_array().expect("channels").iter().all(|channel| !(10..=12).contains(&channel["type"].as_u64().unwrap_or(0))));

    let carol = Client::connect(&w.address, &w.carol.token).await;
    let carol_ids: Vec<&str> = carol.ready["guilds"][0]["threads"].as_array().expect("threads").iter().map(|thread| thread["id"].as_str().unwrap()).collect();
    assert_eq!(carol_ids, vec![mid.as_str()], "no private and no archived threads for carol");
}

#[tokio::test]
async fn the_sweep_archives_inactive_threads_and_messages_restart_the_clock() {
    let w = world().await;
    let mut owner = Client::connect(&w.address, &w.owner.token).await;
    let (_, short) = w.thread(&w.general, &w.alice, json!({"name": "short", "auto_archive_duration": 60})).await;
    let (_, long) = w.thread(&w.general, &w.alice, json!({"name": "long", "auto_archive_duration": 10080})).await;
    let (_, busy) = w.thread(&w.general, &w.alice, json!({"name": "busy", "auto_archive_duration": 60})).await;
    let (short, long, busy) = (id(&short), id(&long), id(&busy));

    // nothing is overdue yet
    assert_eq!(vokko_server::threads::sweep_archived(&w.app.state).await.expect("sweep"), 0);
    // two hours of silence: the 60 minute threads are overdue, a message revives the busy one's clock
    for thread in [&short, &long, &busy] {
        sqlx::query("UPDATE channels SET last_activity_at = now() - interval '2 hours' WHERE id = $1")
            .bind(thread.parse::<i64>().unwrap())
            .execute(&w.app.state.db)
            .await
            .unwrap();
    }
    w.say(&busy, &w.alice, "still here").await;
    assert_eq!(vokko_server::threads::sweep_archived(&w.app.state).await.expect("sweep"), 1);

    let update = owner.wait_match("THREAD_UPDATE", |data| data["thread_metadata"]["archived"] == true).await;
    assert_eq!(update["id"], short.as_str());
    let active: Vec<String> = w.active(&w.alice).await.iter().map(id).collect();
    assert!(!active.contains(&short) && active.contains(&long) && active.contains(&busy));
    // archived threads are still readable, and unarchiving restarts the clock
    assert_eq!(w.messages(&short, &w.carol).await.len(), 0);
    assert_eq!(w.patch(&short, &w.alice, json!({"archived": false})).await.0, StatusCode::OK);
    assert_eq!(vokko_server::threads::sweep_archived(&w.app.state).await.expect("sweep"), 0);
}

#[tokio::test]
async fn deleting_a_thread_or_its_parent_deletes_the_threads() {
    let w = world().await;
    let mut owner = Client::connect(&w.address, &w.owner.token).await;
    let original = w.say(&w.general, &w.owner, "root").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "doomed").await;
    w.say(&mid, &w.alice, "bye").await;
    owner.wait_match("MESSAGE_UPDATE", |data| data["id"] == mid.as_str()).await;

    // the owner of the thread deletes it; the original message loses its `thread`
    let (status, deleted) = w.app.delete(&format!("/channels/{mid}"), &w.alice.token).await;
    assert_eq!((status, deleted["id"].clone()), (StatusCode::OK, json!(mid)));
    let gone = owner.wait_id("THREAD_DELETE", &mid).await;
    assert_eq!((gone["parent_id"].clone(), gone["type"].clone()), (json!(w.general), json!(11)));
    let refreshed = owner.wait_match("MESSAGE_UPDATE", |data| data["id"] == mid.as_str()).await;
    assert!(refreshed.get("thread").is_none_or(Value::is_null));
    assert_eq!(w.app.get(&format!("/channels/{mid}/messages"), &w.alice.token).await.0, StatusCode::NOT_FOUND);
    assert!(w.active(&w.alice).await.is_empty());

    // deleting the parent announces each thread, then the channel
    let parent = w.channel(json!({"type": 0, "name": "doomed-parent"})).await;
    let parent_id = id(&parent);
    let (_, first) = w.thread(&parent_id, &w.alice, json!({"name": "a"})).await;
    let (_, second) = w.thread(&parent_id, &w.alice, json!({"name": "b", "type": 12})).await;
    let (status, _) = w.app.delete(&format!("/channels/{parent_id}"), &w.owner.token).await;
    assert_eq!(status, StatusCode::OK);
    owner.wait_id("THREAD_DELETE", &id(&first)).await;
    owner.wait_id("THREAD_DELETE", &id(&second)).await;
    owner.wait_id("CHANNEL_DELETE", &parent_id).await;
    let (remaining,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM channels WHERE parent_id = $1").bind(parent_id.parse::<i64>().unwrap()).fetch_one(&w.app.state.db).await.unwrap();
    assert_eq!(remaining, 0);
    let (members,): (i64,) = sqlx::query_as("SELECT count(*) FROM thread_members WHERE thread_id = ANY($1)")
        .bind(vec![id(&first).parse::<i64>().unwrap(), id(&second).parse::<i64>().unwrap()])
        .fetch_one(&w.app.state.db)
        .await
        .unwrap();
    assert_eq!(members, 0, "memberships go with the threads");
}

#[tokio::test]
async fn leaving_the_guild_leaves_its_threads() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "x").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "t").await;
    assert_eq!(w.app.put(&format!("/channels/{mid}/thread-members/@me"), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &w.carol.token).await.0, StatusCode::NO_CONTENT);
    let (_, members) = w.app.get(&format!("/channels/{mid}/thread-members"), &w.alice.token).await;
    assert_eq!(members.as_array().expect("members").len(), 1);
}

#[tokio::test]
async fn threads_have_no_overwrites_and_guild_search_follows_thread_visibility() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "findable").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "t").await;
    let (_, private) = w.thread(&w.general, &w.alice, json!({"name": "closed", "type": 12})).await;
    w.say(&mid, &w.alice, "needle in a public thread").await;
    w.say(&id(&private), &w.alice, "needle in a private thread").await;

    let body = json!({"type": 0, "allow": "0", "deny": "2048"});
    let (status, error) = w.app.put_json(&format!("/channels/{mid}/permissions/{}", w.guild), &w.owner.token, body).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50024)));

    // guild search reads public threads of readable channels; private threads only for members and MANAGE_THREADS holders
    let search = |user: &support_threads::Member, extra: &str| {
        let path = format!("/guilds/{}/messages/search?content=needle{extra}", w.guild);
        let token = user.token.clone();
        let w = &w;
        async move { w.app.get(&path, &token).await.1 }
    };
    let found = search(&w.carol, "").await;
    assert_eq!((found["total_results"].clone(), found["messages"][0][0]["channel_id"].clone()), (json!(1), json!(mid)), "carol: the public thread only");
    assert_eq!(search(&w.carol, &format!("&channel_id={}", id(&private))).await["total_results"], 0, "filtering by a private thread leaks nothing");
    assert_eq!(search(&w.carol, &format!("&channel_id={mid}")).await["total_results"], 1);
    assert_eq!(search(&w.alice, "").await["total_results"], 2, "alice is a member of the private thread");
    assert_eq!(search(&w.owner, "").await["total_results"], 2, "MANAGE_THREADS sees private threads");
    // hiding the parent hides its threads
    let hidden = w.channel(json!({"type": 0, "name": "staff", "permission_overwrites": [{"id": w.guild, "type": 0, "allow": "0", "deny": "1024"}]})).await;
    let hidden_message = w.say(&id(&hidden), &w.owner, "x").await;
    let staff = w.thread_from(&id(&hidden), &id(&hidden_message), &w.owner, "staff thread").await;
    w.say(&id(&staff), &w.owner, "needle in staff").await;
    assert_eq!(search(&w.carol, "").await["total_results"], 1);
    assert_eq!(search(&w.owner, "").await["total_results"], 3);
    // archived threads stay searchable
    assert_eq!(w.patch(&mid, &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    assert_eq!(search(&w.carol, "").await["total_results"], 1);
    let (_, found) = w.app.get(&format!("/channels/{mid}/messages/search?content=needle"), &w.carol.token).await;
    assert_eq!(found["total_results"], 1);
    let (status, _) = w.app.get(&format!("/channels/{}/messages/search?content=needle", id(&private)), &w.carol.token).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(w.patch(&mid, &w.alice, json!({"archived": false})).await.0, StatusCode::OK);

    // acks work in threads the user can see and nowhere else
    let last = w.messages(&mid, &w.carol).await[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(w.app.post(&format!("/channels/{mid}/messages/{last}/ack"), &w.carol.token, json!({})).await.0, StatusCode::NO_CONTENT);
    let (state,): (Option<i64>,) = sqlx::query_as("SELECT last_message_id FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(w.carol.id.parse::<i64>().unwrap())
        .bind(mid.parse::<i64>().unwrap())
        .fetch_one(&w.app.state.db)
        .await
        .unwrap();
    assert_eq!(state, Some(last.parse::<i64>().unwrap()));
    let body = json!({"read_states": [{"channel_id": id(&private), "message_id": id(&private)}]});
    assert_eq!(w.app.post("/read-states/ack-bulk", &w.carol.token, body).await.0, StatusCode::NO_CONTENT);
    let (hidden,): (i64,) = sqlx::query_as("SELECT count(*) FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(w.carol.id.parse::<i64>().unwrap())
        .bind(id(&private).parse::<i64>().unwrap())
        .fetch_one(&w.app.state.db)
        .await
        .unwrap();
    assert_eq!(hidden, 0, "bulk ack skips threads the user cannot see");
}

#[tokio::test]
async fn an_invalid_message_does_not_reopen_an_archived_thread() {
    let w = world().await;
    let mut carol = Client::connect(&w.address, &w.carol.token).await;
    let original = w.say(&w.general, &w.owner, "root").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "quiet").await;
    assert_eq!(w.patch(&mid, &w.alice, json!({"archived": true})).await.0, StatusCode::OK);
    carol.wait_match("THREAD_UPDATE", |data| data["thread_metadata"]["archived"] == true).await;

    let path = format!("/channels/{mid}/messages");
    let post = |body: Value| w.app.post(&path, &w.carol.token, body);
    let (status, error) = post(json!({"content": "   "})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, _) = post(json!({"content": "reply", "message_reference": {"message_id": "999999999999"}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = post(json!({"content": "files", "attachment_ids": ["12345"]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(carol.silent_for("THREAD_UPDATE", Duration::from_millis(300), |_| true).await, "no THREAD_UPDATE for refused messages");
    assert!(w.active(&w.carol).await.is_empty(), "still archived");
    assert!(!w.messages(&mid, &w.carol).await.iter().any(|message| message["author"]["id"] == w.carol.id.as_str()));
    let (inactive,): (bool,) =
        sqlx::query_as("SELECT archived FROM channels WHERE id = $1").bind(mid.parse::<i64>().unwrap()).fetch_one(&w.app.state.db).await.unwrap();
    assert!(inactive);

    // a valid one reopens it, announced before the message
    w.say(&mid, &w.carol, "now it counts").await;
    let reopened = carol.wait_id("THREAD_UPDATE", &mid).await;
    assert_eq!(reopened["thread_metadata"]["archived"], false);
    assert_eq!(w.active(&w.carol).await.len(), 1);
}

#[tokio::test]
async fn starting_a_thread_from_a_message_needs_read_message_history() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "old news").await;
    let mid = id(&original);
    w.set_everyone(DEFAULT_EVERYONE & !READ_MESSAGE_HISTORY).await;
    // without history access the type 21 starter would copy the old message to someone who cannot read it
    let (status, error) = w.app.post(&format!("/channels/{}/messages/{mid}/threads", w.general), &w.alice.token, json!({"name": "peek"})).await;
    assert_eq!((status, code(&error)), (StatusCode::FORBIDDEN, Some(50013)));
    let (_, active) = w.app.get(&format!("/guilds/{}/threads/active", w.guild), &w.owner.token).await;
    assert!(active["threads"].as_array().expect("threads").is_empty(), "nothing was created");
    w.set_everyone(DEFAULT_EVERYONE).await;
    w.thread_from(&w.general, &mid, &w.alice, "now fine").await;
}

#[tokio::test]
async fn timed_out_moderators_get_no_private_thread_events() {
    let w = world().await;
    w.role_for(&w.carol, MANAGE_THREADS).await;
    let (_, private) = w.thread(&w.general, &w.alice, json!({"name": "closed", "type": 12})).await;
    let tid = id(&private);
    let mut carol = Client::connect(&w.address, &w.carol.token).await;

    // a MANAGE_THREADS holder sees the private thread's traffic ...
    w.say(&tid, &w.alice, "first").await;
    let seen = carol.wait_match("MESSAGE_CREATE", |data| data["channel_id"] == tid.as_str()).await;
    assert_eq!(seen["content"], "first");

    // ... until a timeout strips the permission down to view + history
    sqlx::query("UPDATE guild_members SET timeout_until = now() + interval '1 day' WHERE guild_id = $1 AND user_id = $2")
        .bind(w.guild_id())
        .bind(w.carol.id.parse::<i64>().unwrap())
        .execute(&w.app.state.db)
        .await
        .unwrap();
    w.say(&tid, &w.alice, "second").await;
    assert!(carol.silent_for("MESSAGE_CREATE", Duration::from_millis(400), |data| data["channel_id"] == tid.as_str()).await);
}

#[tokio::test]
async fn invites_are_refused_for_threads() {
    let w = world().await;
    let original = w.say(&w.general, &w.owner, "root").await;
    let mid = id(&original);
    w.thread_from(&w.general, &mid, &w.alice, "side").await;
    let (status, error) = w.app.post(&format!("/channels/{mid}/invites"), &w.owner.token, json!({})).await;
    assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, _) = w.app.post(&format!("/channels/{}/invites", w.general), &w.owner.token, json!({})).await;
    assert_eq!(status, StatusCode::OK, "the parent still takes invites");
}

#[tokio::test]
async fn a_send_racing_the_sweep_never_leaves_the_thread_archived() {
    let w = world().await;
    let (_, thread) = w.thread(&w.general, &w.alice, json!({"name": "racy", "auto_archive_duration": 60})).await;
    let tid = id(&thread);
    let numeric: i64 = tid.parse().unwrap();
    for round in 0..15 {
        sqlx::query("UPDATE channels SET archived = FALSE, last_activity_at = now() - interval '2 hours' WHERE id = $1")
            .bind(numeric)
            .execute(&w.app.state.db)
            .await
            .unwrap();
        let path = format!("/channels/{tid}/messages");
        let body = json!({"content": format!("message {round}")});
        let (sweep, (status, sent)) = tokio::join!(vokko_server::threads::sweep_archived(&w.app.state), w.app.post(&path, &w.alice.token, body));
        sweep.expect("sweep");
        assert_eq!(status, StatusCode::OK, "{sent}");
        let (archived,): (bool,) = sqlx::query_as("SELECT archived FROM channels WHERE id = $1").bind(numeric).fetch_one(&w.app.state.db).await.unwrap();
        assert!(!archived, "round {round}: a thread that just got a message must not stay archived");
    }
}
