#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Friend suggestions: ranking, privacy (blocks both ways, opt-out, dismissals, big guilds) and the settings endpoint.
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::json;

struct Person {
    token: String,
    id: String,
}

async fn person(app: &TestApp, name: &str) -> Person {
    let (token, user) = app.register(name).await;
    Person { token, id: user["id"].as_str().expect("id").to_owned() }
}

async fn befriend(app: &TestApp, a: &Person, b: &Person) {
    let (_, user) = app.get(&format!("/users/{}", b.id), &a.token).await;
    let name = user["username"].as_str().expect("username");
    assert_eq!(app.post("/users/@me/relationships", &a.token, json!({"username": name})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.put(&format!("/users/@me/relationships/{}", a.id), &b.token).await.0, StatusCode::NO_CONTENT);
}

async fn join(app: &TestApp, owner: &Person, guild_channel: &str, who: &Person) {
    let (_, invite) = app.post(&format!("/channels/{guild_channel}/invites"), &owner.token, json!({})).await;
    let (status, body) = app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &who.token, json!({})).await;
    assert_eq!(status, StatusCode::OK, "join: {body}");
}

async fn suggested(app: &TestApp, who: &Person) -> Vec<String> {
    let (status, body) = app.get("/users/@me/friend-suggestions", &who.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["suggestions"].as_array().expect("suggestions").iter().map(|s| s["user"]["username"].as_str().expect("username").to_owned()).collect()
}

#[tokio::test]
async fn mutual_friends_rank_above_shared_guilds() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await; // shares a guild with ann
    let cat = person(&app, "cat").await; // friend of ann's friend
    let dan = person(&app, "dan").await; // ann's friend
    let eve = person(&app, "eve").await; // nothing in common
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    let _ = guild;
    join(&app, &ann, &channel, &ben).await;
    befriend(&app, &ann, &dan).await;
    befriend(&app, &dan, &cat).await;

    // cat shares no guild or DM with ann, so (as on cat's profile) no mutual friend count is shown and it does not rank.
    assert_eq!(suggested(&app, &ann).await, vec!["ben", "cat"]);
    let (_, body) = app.get("/users/@me/friend-suggestions", &ann.token).await;
    assert_eq!(body["enabled"], true);
    assert_eq!(body["suggestions"][0]["mutual_guilds"][0]["id"], guild);
    assert_eq!(body["suggestions"][0]["mutual_friends_count"], 0);
    assert_eq!(body["suggestions"][1]["mutual_friends_count"], 0);
    assert_eq!(body["suggestions"][1]["mutual_guilds"], json!([]));
    assert_eq!(app.get(&format!("/users/{}/profile", cat.id), &ann.token).await.1["mutual_friends_count"], 0);
    // symmetrical: ben sees ann, cat sees ann, eve sees nobody
    assert_eq!(suggested(&app, &ben).await, vec!["ann"]);
    assert_eq!(suggested(&app, &cat).await, vec!["ann"]);
    assert!(suggested(&app, &eve).await.is_empty());

    let (status, error) = app.get("/users/@me/friend-suggestions?limit=0", &ann.token).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    let (_, one) = app.get("/users/@me/friend-suggestions?limit=1", &ann.token).await;
    assert_eq!(one["suggestions"].as_array().expect("list").len(), 1);

    // becoming friends or sending a request removes the suggestion
    assert_eq!(app.post("/users/@me/relationships", &ann.token, json!({"username": "cat"})).await.0, StatusCode::NO_CONTENT);
    assert_eq!(suggested(&app, &ann).await, vec!["ben"]);
    assert!(!suggested(&app, &cat).await.contains(&"ann".to_owned()));
}

#[tokio::test]
async fn share_mutuals_off_hides_a_mutual_friend_only_link() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let cat = person(&app, "cat").await;
    let dan = person(&app, "dan").await;
    befriend(&app, &ann, &dan).await;
    befriend(&app, &dan, &cat).await;
    assert_eq!(suggested(&app, &ann).await, vec!["cat"]);
    let (_, current) = app.get("/users/@me/settings", &cat.token).await;
    let body = json!({"version": current["version"], "settings": {"share_mutuals": false}});
    assert_eq!(app.patch("/users/@me/settings", &cat.token, body).await.0, StatusCode::OK);
    assert!(suggested(&app, &ann).await.is_empty(), "the mutual friend was the only link, and cat does not share mutuals");
}

#[tokio::test]
async fn suggestion_counts_match_the_profile_once_there_is_context() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let cat = person(&app, "cat").await; // friend of two of ann's friends
    let ben = person(&app, "ben").await; // shares a guild with ann
    let (dan, fay) = (person(&app, "dan").await, person(&app, "fay").await);
    let (_, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    for friend in [&dan, &fay] {
        befriend(&app, &ann, friend).await;
        befriend(&app, friend, &cat).await;
    }
    let counts = |body: &serde_json::Value| {
        body["suggestions"]
            .as_array()
            .expect("list")
            .iter()
            .map(|s| (s["user"]["username"].as_str().expect("name").to_owned(), s["mutual_friends_count"].clone()))
            .collect::<Vec<_>>()
    };
    let (_, body) = app.get("/users/@me/friend-suggestions", &ann.token).await;
    assert_eq!(counts(&body), [("ben".to_owned(), json!(0)), ("cat".to_owned(), json!(0))], "no context: no count, no rank");

    // Once cat shares a guild with ann, the count shows (the same as the profile) and ranks first.
    join(&app, &ann, &channel, &cat).await;
    let (_, body) = app.get("/users/@me/friend-suggestions", &ann.token).await;
    assert_eq!(counts(&body), [("cat".to_owned(), json!(2)), ("ben".to_owned(), json!(0))]);
    assert_eq!(app.get(&format!("/users/{}/profile", cat.id), &ann.token).await.1["mutual_friends_count"], 2);
    let (_, list) = app.get(&format!("/users/{}/relationships", cat.id), &ann.token).await;
    assert_eq!(list.as_array().map(Vec::len), Some(2));
}

#[tokio::test]
async fn a_dm_with_a_message_is_context_for_the_count() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let cat = person(&app, "cat").await; // DM'd by ann, then left the guild
    let gus = person(&app, "gus").await; // DM opened by ann but never written in, then left the guild
    let dan = person(&app, "dan").await; // friend of all three
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    for who in [&cat, &gus] {
        join(&app, &ann, &channel, who).await;
        befriend(&app, &dan, who).await;
        let (status, dm) = app.post("/users/@me/channels", &ann.token, json!({"recipient_id": who.id})).await;
        assert_eq!(status, StatusCode::OK, "{dm}");
        if who.id == cat.id {
            let path = format!("/channels/{}/messages", dm["id"].as_str().expect("dm id"));
            assert_eq!(app.post(&path, &ann.token, json!({"content": "hi"})).await.0, StatusCode::OK);
        }
    }
    befriend(&app, &ann, &dan).await;
    for who in [&cat, &gus] {
        assert_eq!(app.delete(&format!("/users/@me/guilds/{guild}"), &who.token).await.0, StatusCode::NO_CONTENT);
    }
    let (_, body) = app.get("/users/@me/friend-suggestions", &ann.token).await;
    let counts: Vec<(String, serde_json::Value)> = body["suggestions"]
        .as_array()
        .expect("list")
        .iter()
        .map(|s| (s["user"]["username"].as_str().expect("name").to_owned(), s["mutual_friends_count"].clone()))
        .collect();
    assert_eq!(counts, [("cat".to_owned(), json!(1)), ("gus".to_owned(), json!(0))]);
    for (who, count) in [(&cat, 1), (&gus, 0)] {
        assert_eq!(app.get(&format!("/users/{}/profile", who.id), &ann.token).await.1["mutual_friends_count"], count);
    }
}

#[tokio::test]
async fn blocks_opt_out_and_dismissals_hide_people() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let blocker = person(&app, "blocker").await; // blocked ann
    let blocked = person(&app, "blocked").await; // ann blocked them
    let shy = person(&app, "shy").await; // opted out
    let dismissed = person(&app, "dismissed").await;
    let visible = person(&app, "visible").await;
    let (_, channel) = app.guild_with_channel(&ann.token).await;
    for who in [&blocker, &blocked, &shy, &dismissed, &visible] {
        join(&app, &ann, &channel, who).await;
    }
    let mut all = suggested(&app, &ann).await;
    all.sort();
    assert_eq!(all, vec!["blocked", "blocker", "dismissed", "shy", "visible"]);

    assert_eq!(
        app.send(axum::http::Method::PUT, &format!("/users/@me/relationships/{}", ann.id), Some(&blocker.token), Some(json!({"type": 2}))).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.send(axum::http::Method::PUT, &format!("/users/@me/relationships/{}", blocked.id), Some(&ann.token), Some(json!({"type": 2}))).await.0,
        StatusCode::NO_CONTENT
    );
    let (status, settings) = app.patch("/users/@me/friend-suggestion-settings", &shy.token, json!({"enabled": false})).await;
    assert_eq!((status, settings), (StatusCode::OK, json!({"enabled": false})));
    assert_eq!(app.delete(&format!("/users/@me/friend-suggestions/{}", dismissed.id), &ann.token).await.0, StatusCode::NO_CONTENT);
    // dismissing answers the same for ids that belong to nobody, so it cannot be used to probe which accounts exist
    assert_eq!(app.delete("/users/@me/friend-suggestions/424242", &ann.token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.delete("/users/@me/friend-suggestions/not-an-id", &ann.token).await.0, StatusCode::NO_CONTENT);

    assert_eq!(suggested(&app, &ann).await, vec!["visible"]);
    // nobody who is hidden from ann sees ann either, except the person ann merely dismissed
    assert!(suggested(&app, &blocker).await.iter().all(|name| name != "ann"));
    assert!(suggested(&app, &blocked).await.iter().all(|name| name != "ann"));
    let (_, shy_view) = app.get("/users/@me/friend-suggestions", &shy.token).await;
    assert_eq!((shy_view["enabled"].clone(), shy_view["suggestions"].clone()), (json!(false), json!([])));
    assert!(suggested(&app, &dismissed).await.contains(&"ann".to_owned()));

    // switching back on restores both directions (the dismissal stays)
    assert_eq!(app.patch("/users/@me/friend-suggestion-settings", &shy.token, json!({"enabled": true})).await.1, json!({"enabled": true}));
    let mut again = suggested(&app, &ann).await;
    again.sort();
    assert_eq!(again, vec!["shy", "visible"]);
    assert_eq!(app.patch("/users/@me/friend-suggestion-settings", &shy.token, json!({})).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn big_guilds_and_bots_are_not_a_reason() {
    let app = TestApp::new().await;
    let ann = person(&app, "ann").await;
    let ben = person(&app, "ben").await;
    let (guild, channel) = app.guild_with_channel(&ann.token).await;
    join(&app, &ann, &channel, &ben).await;
    assert_eq!(suggested(&app, &ann).await, vec!["ben"]);

    // 250 more members make it a community, not a circle of acquaintances
    let guild_id: i64 = guild.parse().expect("guild id");
    sqlx::query("INSERT INTO users (id, username, email, password_hash) SELECT 9000000000000 + n, 'filler' || n, 'filler' || n || '@x.test', 'x' FROM generate_series(1, 250) n")
        .execute(&app.state.db)
        .await
        .expect("filler users");
    sqlx::query("INSERT INTO guild_members (guild_id, user_id) SELECT $1, 9000000000000 + n FROM generate_series(1, 250) n")
        .bind(guild_id)
        .execute(&app.state.db)
        .await
        .expect("filler members");
    assert!(suggested(&app, &ann).await.is_empty());
    assert!(suggested(&app, &ben).await.is_empty());

    // bots are never suggested
    let carl = person(&app, "carl").await;
    let small = app.post("/guilds", &ann.token, json!({"name": "Small one"})).await.1;
    let (_, channels) = app.get(&format!("/guilds/{}/channels", small["id"].as_str().expect("id")), &ann.token).await;
    let small_channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    join(&app, &ann, &small_channel, &carl).await;
    assert_eq!(suggested(&app, &ann).await, vec!["carl"]);
    sqlx::query("UPDATE users SET bot = TRUE WHERE username = 'carl'").execute(&app.state.db).await.expect("mark bot");
    assert!(suggested(&app, &ann).await.is_empty());
}
