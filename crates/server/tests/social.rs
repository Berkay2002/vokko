#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

#[tokio::test]
async fn friend_request_flow() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let sam_id = sam_user["id"].as_str().expect("id");
    let alice_id = alice_user["id"].as_str().expect("id");

    // request by username
    let (status, _) = app.post("/users/@me/relationships", &sam, json!({"username": "Alice"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, mine) = app.get("/users/@me/relationships", &sam).await;
    assert_eq!(mine[0]["type"], 4);
    assert_eq!(mine[0]["id"], alice_id);
    assert_eq!(mine[0]["user"]["username"], "alice");
    let (_, theirs) = app.get("/users/@me/relationships", &alice).await;
    assert_eq!(theirs[0]["type"], 3);
    assert_eq!(theirs[0]["id"], sam_id);

    // accepting by PUT
    assert_eq!(app.put(&format!("/users/@me/relationships/{sam_id}"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &sam).await.1[0]["type"], 1);
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1[0]["type"], 1);

    // removing
    assert_eq!(app.delete(&format!("/users/@me/relationships/{alice_id}"), &sam).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1, json!([]));

    // errors
    assert_eq!(app.put(&format!("/users/@me/relationships/{sam_id}"), &sam).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.post("/users/@me/relationships", &sam, json!({"username": "ghost"})).await.1["code"], 10013);
}

/// Makes `a` and `b` accepted friends.
async fn befriend(app: &TestApp, a: (&str, &Value), b: (&str, &Value)) {
    let name = b.1["username"].as_str().expect("username");
    assert_eq!(app.post("/users/@me/relationships", a.0, json!({"username": name})).await.0, StatusCode::NO_CONTENT);
    let a_id = a.1["id"].as_str().expect("id");
    assert_eq!(app.put(&format!("/users/@me/relationships/{a_id}"), b.0).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn direct_and_group_messages_channels() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (bob, bob_user) = app.register("bob").await;
    let (nova, nova_user) = app.register("nova").await;
    befriend(&app, (&sam, &sam_user), (&alice, &alice_user)).await;
    befriend(&app, (&sam, &sam_user), (&bob, &bob_user)).await;

    // strangers cannot be DM'd, and a group DM only takes the creator's friends
    let (status, error) = app.post("/users/@me/channels", &sam, json!({"recipient_id": nova_user["id"]})).await;
    assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50007)));
    let (status, error) = app.post("/users/@me/channels", &sam, json!({"recipient_ids": [alice_user["id"], nova_user["id"]]})).await;
    assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50007)));
    let (status, error) = app.post("/users/@me/channels", &nova, json!({"recipient_id": sam_user["id"]})).await;
    assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50007)));

    let (status, dm) = app.post("/users/@me/channels", &sam, json!({"recipient_id": alice_user["id"]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dm["type"], 1);
    assert_eq!(dm["name"], serde_json::Value::Null);
    assert_eq!(dm["recipients"].as_array().expect("recipients").len(), 1);
    assert_eq!(dm["recipients"][0]["username"], "alice");
    assert!(dm.get("owner_id").is_none());

    // same DM again
    let (_, again) = app.post("/users/@me/channels", &sam, json!({"recipient_id": alice_user["id"]})).await;
    assert_eq!(again["id"], dm["id"]);
    let (_, list) = app.get("/users/@me/channels", &sam).await;
    assert_eq!(list.as_array().expect("list").len(), 1);

    // group DM
    let (status, group) = app.post("/users/@me/channels", &sam, json!({"recipient_ids": [alice_user["id"], bob_user["id"]]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(group["type"], 3);
    assert_eq!(group["owner_id"], sam_user["id"]);
    assert_eq!(group["icon"], serde_json::Value::Null);
    assert_eq!(group["recipients"].as_array().expect("recipients").len(), 2);

    // outsiders cannot touch it
    let group_id = group["id"].as_str().expect("id");
    let (status, error) = app.patch(&format!("/channels/{group_id}"), &nova, json!({"name": "x"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50001);
    assert_eq!(nova_user["username"], "nova");

    // self DM is invalid
    assert_eq!(app.post("/users/@me/channels", &sam, json!({"recipient_id": sam_user["id"]})).await.0, StatusCode::BAD_REQUEST);

    // closing a DM removes it from the list for that user only
    let dm_id = dm["id"].as_str().expect("id");
    assert_eq!(app.delete(&format!("/channels/{dm_id}"), &sam).await.0, StatusCode::OK);
    let (_, list) = app.get("/users/@me/channels", &sam).await;
    assert_eq!(list.as_array().expect("list").len(), 1);
}

#[tokio::test]
async fn blocking_ends_the_friendship_and_only_the_blocker_can_undo_it() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let sam_id = sam_user["id"].as_str().expect("id");
    let alice_id = alice_user["id"].as_str().expect("id");
    let sam_path = format!("/users/@me/relationships/{sam_id}");
    let alice_path = format!("/users/@me/relationships/{alice_id}");

    // friends first
    app.post("/users/@me/relationships", &sam, json!({"username": "alice"})).await;
    assert_eq!(app.put_json(&sam_path, &alice, json!({"type": 1})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1[0]["type"], 1);
    let (status, dm) = app.post("/users/@me/channels", &sam, json!({"recipient_id": alice_id})).await;
    assert_eq!(status, StatusCode::OK);

    // sam blocks alice: only sam keeps a row, of type 2
    assert_eq!(app.put_json(&alice_path, &sam, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    let (_, mine) = app.get("/users/@me/relationships", &sam).await;
    assert_eq!((mine[0]["id"].as_str(), mine[0]["type"].as_u64(), mine.as_array().expect("list").len()), (Some(alice_id), Some(2), 1));
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1, json!([]));
    // blocking again changes nothing
    assert_eq!(app.put_json(&alice_path, &sam, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);

    // the blocked user cannot befriend, and deleting does not lift the block
    assert_eq!(app.put(&sam_path, &alice).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.post("/users/@me/relationships", &alice, json!({"username": "sam"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&sam_path, &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &sam).await.1[0]["type"], 2);

    // a blocked pair cannot open or reopen a DM in either direction
    for (token, other) in [(&sam, alice_id), (&alice, sam_id)] {
        let (status, error) = app.post("/users/@me/channels", token, json!({"recipient_id": other})).await;
        assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50007)));
        let (status, error) = app.post("/users/@me/channels", token, json!({"recipient_ids": [other]})).await;
        assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50007)));
    }

    // a 1:1 DM opened before the block is closed for new messages in both directions
    let messages = format!("/channels/{}/messages", dm["id"].as_str().expect("dm id"));
    for token in [&sam, &alice] {
        let (status, error) = app.post(&messages, token, json!({"content": "hi"})).await;
        assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50007)));
    }

    // validation
    assert_eq!(app.put_json(&alice_path, &sam, json!({"type": 7})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.put_json(&sam_path, &sam, json!({"type": 2})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.put_json("/users/@me/relationships/1", &sam, json!({"type": 2})).await.1["code"], 10013);

    // both sides blocked: the first to unblock does not lift the other's block
    assert_eq!(app.put_json(&sam_path, &alice, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.delete(&alice_path, &sam).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &sam).await.1, json!([]));
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1[0]["type"], 2);
    let (status, _) = app.post(&messages, &sam, json!({"content": "still blocked from alice's side"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // once nobody blocks, messages flow again
    assert_eq!(app.delete(&sam_path, &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.post(&messages, &sam, json!({"content": "hi again"})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn profile_shows_mutual_guilds_friends_and_the_guild_member() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (bob, bob_user) = app.register("bob").await;
    let (nova, _) = app.register("nova").await;
    let (sam_id, alice_id) = (sam_user["id"].as_str().expect("id"), alice_user["id"].as_str().expect("id"));

    let (guild, channel) = app.guild_with_channel(&sam).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &sam, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    app.post(&format!("/invites/{code}"), &alice, json!({})).await;
    // there is no nickname route yet, so set it directly
    sqlx::query("UPDATE guild_members SET nick = 'Al' WHERE guild_id = $1 AND user_id = $2")
        .bind(guild.parse::<i64>().expect("guild id"))
        .bind(alice_id.parse::<i64>().expect("alice id"))
        .execute(&app.state.db)
        .await
        .expect("set nick");

    // bob is friends with both sam and alice (a mutual friend); nova only with sam
    for (token, name) in [(&sam, "bob"), (&alice, "bob"), (&sam, "nova")] {
        app.post("/users/@me/relationships", token, json!({"username": name})).await;
    }
    assert_eq!(app.put(&format!("/users/@me/relationships/{sam_id}"), &bob).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&format!("/users/@me/relationships/{alice_id}"), &bob).await.0, StatusCode::NO_CONTENT);
    assert_eq!(bob_user["username"], "bob");

    let (status, profile) = app.get(&format!("/users/{alice_id}/profile?guild_id={guild}"), &sam).await;
    assert_eq!(status, StatusCode::OK, "{profile}");
    assert_eq!(profile["user"]["username"], "alice");
    assert_eq!(profile["mutual_guilds"], json!([{"id": guild, "nick": "Al"}]));
    assert_eq!(profile["mutual_friends_count"], 1);
    assert_eq!(profile["guild_member"]["nick"], "Al");
    assert_eq!(profile["guild_member"]["user"]["id"], alice_id);

    // without ?guild_id= there is no member block; strangers share nothing
    let (_, plain) = app.get(&format!("/users/{alice_id}/profile"), &sam).await;
    assert!(plain.get("guild_member").is_none());
    let (_, stranger) = app.get(&format!("/users/{alice_id}/profile?guild_id={guild}"), &nova).await;
    assert_eq!(stranger["mutual_guilds"], json!([]));
    assert_eq!(stranger["mutual_friends_count"], 0);
    assert!(stranger.get("guild_member").is_none(), "no guild member info for a guild the caller is not in");
    assert_eq!(app.get(&format!("/users/{sam_id}/profile"), &alice).await.1["mutual_guilds"][0]["nick"], Value::Null);
    assert_eq!(app.get("/users/1/profile", &sam).await.1["code"], 10013);
}

async fn mutuals(app: &TestApp, viewer: &str, target: &str) -> (StatusCode, Value) {
    app.get(&format!("/users/{target}/relationships"), viewer).await
}

#[tokio::test]
async fn mutual_friends_are_only_shared_friends_with_a_shared_context_and_no_blocks() {
    let app = TestApp::new().await;
    let mut people = Vec::new();
    for name in ["sam", "alice", "bob", "dave", "carl", "eve"] {
        people.push(app.register(name).await);
    }
    let [sam, alice, bob, dave, carl, eve] = [0, 1, 2, 3, 4, 5].map(|i| (people[i].0.as_str(), &people[i].1));
    let uid = |who: (&str, &Value)| who.1["id"].as_str().expect("id").to_owned();
    let names = |list: &Value| list.as_array().expect("user list").iter().map(|u| u["username"].as_str().expect("name").to_owned()).collect::<Vec<_>>();

    // sam and alice share a guild; bob and dave are friends of both, carl only of alice, eve only of bob and alice.
    let (guild, channel) = app.guild_with_channel(sam.0).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), sam.0, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(app.post(&format!("/invites/{code}"), alice.0, json!({})).await.0, StatusCode::OK);
    for (a, b) in [(sam, bob), (alice, bob), (sam, dave), (alice, dave), (alice, carl), (eve, bob), (eve, alice)] {
        befriend(&app, a, b).await;
    }

    let (status, list) = mutuals(&app, sam.0, &uid(alice)).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(names(&list), ["bob", "dave"], "only shared friends, by id; never carl");
    assert_eq!(app.get(&format!("/users/{}/profile?guild_id={guild}", uid(alice)), sam.0).await.1["mutual_friends_count"], 2);

    // Yourself: nothing (not your whole friend list).
    assert_eq!(mutuals(&app, sam.0, &uid(sam)).await.1, json!([]));
    assert_eq!(app.get(&format!("/users/{}/profile", uid(sam)), sam.0).await.1["mutual_friends_count"], 0);
    // No shared context: eve and sam share bob, but no guild, DM or relationship.
    assert_eq!(mutuals(&app, eve.0, &uid(sam)).await.1, json!([]));
    assert_eq!(app.get(&format!("/users/{}/profile", uid(sam)), eve.0).await.1["mutual_friends_count"], 0);
    // A pending friend request is shared context (so are a guild, as above, and a DM).
    assert_eq!(app.post("/users/@me/relationships", eve.0, json!({"username": "sam"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(names(&mutuals(&app, eve.0, &uid(sam)).await.1), ["bob"]);
    assert_eq!(names(&mutuals(&app, sam.0, &uid(eve)).await.1), ["bob"]);

    // A block between the caller and the user hides everything, either way round, until it is lifted.
    let sam_path = format!("/users/@me/relationships/{}", uid(sam));
    assert_eq!(app.put_json(&sam_path, alice.0, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(mutuals(&app, sam.0, &uid(alice)).await.1, json!([]));
    assert_eq!(mutuals(&app, alice.0, &uid(sam)).await.1, json!([]));
    assert_eq!(app.get(&format!("/users/{}/profile", uid(alice)), sam.0).await.1["mutual_friends_count"], 0);
    assert_eq!(app.delete(&sam_path, alice.0).await.0, StatusCode::NO_CONTENT);
    assert_eq!(names(&mutuals(&app, sam.0, &uid(alice)).await.1), ["bob", "dave"]);

    // A friend the caller blocks drops out; so does a friend who blocks the caller.
    assert_eq!(app.put_json(&format!("/users/@me/relationships/{}", uid(dave)), sam.0, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(names(&mutuals(&app, sam.0, &uid(alice)).await.1), ["bob"]);
    assert_eq!(app.put_json(&sam_path, bob.0, json!({"type": 2})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(mutuals(&app, sam.0, &uid(alice)).await.1, json!([]));

    assert_eq!(mutuals(&app, sam.0, "1").await.1["code"], 10013);
}

#[tokio::test]
async fn mutual_friends_need_a_guild_or_a_dm_with_messages() {
    let app = TestApp::new().await;
    let mut people = Vec::new();
    for name in ["sam", "alice", "bob", "carl"] {
        people.push(app.register(name).await);
    }
    let [sam, alice, bob, carl] = [0, 1, 2, 3].map(|i| (people[i].0.as_str(), &people[i].1));
    let uid = |who: (&str, &Value)| who.1["id"].as_str().expect("id").to_owned();
    let names = |list: &Value| list.as_array().expect("user list").iter().map(|u| u["username"].as_str().expect("name").to_owned()).collect::<Vec<_>>();

    // alice and carl join sam's guild; bob is a friend of all three.
    let (guild, channel) = app.guild_with_channel(sam.0).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), sam.0, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    for who in [alice, carl] {
        assert_eq!(app.post(&format!("/invites/{code}"), who.0, json!({})).await.0, StatusCode::OK);
        befriend(&app, who, bob).await;
    }
    befriend(&app, sam, bob).await;
    assert_eq!(names(&mutuals(&app, sam.0, &uid(alice)).await.1), ["bob"]);

    // A DM with a message keeps the context after leaving the guild; a DM only opened does not.
    let (status, dm) = app.post("/users/@me/channels", sam.0, json!({"recipient_id": uid(alice)})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm = dm["id"].as_str().expect("dm id").to_owned();
    assert_eq!(app.post(&format!("/channels/{dm}/messages"), sam.0, json!({"content": "hi"})).await.0, StatusCode::OK);
    assert_eq!(app.post("/users/@me/channels", sam.0, json!({"recipient_id": uid(carl)})).await.0, StatusCode::OK);
    for who in [alice, carl] {
        assert_eq!(app.delete(&format!("/users/@me/guilds/{guild}"), who.0).await.0, StatusCode::NO_CONTENT);
    }
    assert_eq!(names(&mutuals(&app, sam.0, &uid(alice)).await.1), ["bob"]);
    assert_eq!(names(&mutuals(&app, alice.0, &uid(sam)).await.1), ["bob"]);
    assert_eq!(mutuals(&app, sam.0, &uid(carl)).await.1, json!([]));
    assert_eq!(mutuals(&app, carl.0, &uid(sam)).await.1, json!([]));
}

#[tokio::test]
async fn presence_is_only_shared_with_accepted_relationships() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let (_, bob_user) = app.register("bob").await;
    let (carol, carol_user) = app.register("carol").await;
    let id = |user: &Value| user["id"].as_str().expect("id").parse::<i64>().expect("number");
    let (sam_id, alice_id, bob_id, carol_id) = (id(&sam_user), id(&alice_user), id(&bob_user), id(&carol_user));
    let audience = |user: i64| {
        let state = app.state.clone();
        async move { vokko_server::events::user_audience(&state, user).await.expect("audience") }
    };

    // a pending request (either direction) shares nothing
    assert_eq!(app.post("/users/@me/relationships", &sam, json!({"username": "bob"})).await.0, StatusCode::NO_CONTENT);
    assert!(!audience(sam_id).await.contains(&bob_id));
    assert!(!audience(bob_id).await.contains(&sam_id));

    // an accepted friendship shares presence
    befriend(&app, (&sam, &sam_user), (&alice, &alice_user)).await;
    assert!(audience(sam_id).await.contains(&alice_id));
    assert!(audience(alice_id).await.contains(&sam_id));

    // a DM that the other side never opened shares nothing once the friendship is gone
    let (_, dm) = app.post("/users/@me/channels", &sam, json!({"recipient_id": alice_user["id"]})).await;
    assert_eq!(app.delete(&format!("/users/@me/relationships/{alice_id}"), &sam).await.0, StatusCode::NO_CONTENT);
    assert!(!audience(sam_id).await.contains(&alice_id));
    assert!(!audience(alice_id).await.contains(&sam_id));

    // the first message opens it on both sides
    let (status, _) = app.post(&format!("/channels/{}/messages", dm["id"].as_str().expect("id")), &sam, json!({"content": "hi"})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(audience(sam_id).await.contains(&alice_id));
    assert!(audience(alice_id).await.contains(&sam_id));

    // guild mates still share presence
    let (_, channel) = app.guild_with_channel(&sam).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &sam, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &carol, json!({})).await;
    assert!(audience(sam_id).await.contains(&carol_id));
    assert!(audience(carol_id).await.contains(&sam_id));
}
