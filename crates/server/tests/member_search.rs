#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Members page: `POST /guilds/{id}/members-search` and the join source recorded on invite accept.
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

const KICK: u64 = 1 << 1;
const MANAGE_NICKNAMES: u64 = 1 << 27;
const SEND_MESSAGES: u64 = 1 << 11;
const EPOCH_MS: i64 = 1_420_070_400_000;

struct World {
    app: TestApp,
    guild: String,
    channel: String,
    owner: String,
    owner_id: String,
}

impl World {
    async fn new() -> Self {
        let app = TestApp::new().await;
        let (owner, user) = app.register("owner").await;
        let (guild, channel) = app.guild_with_channel(&owner).await;
        Self { app, guild, channel, owner, owner_id: user["id"].as_str().expect("id").to_owned() }
    }

    async fn invite(&self) -> String {
        let (status, invite) = self.app.post(&format!("/channels/{}/invites", self.channel), &self.owner, json!({"unique": true})).await;
        assert_eq!(status, StatusCode::OK, "invite: {invite}");
        invite["code"].as_str().expect("code").to_owned()
    }

    /// Registers a user and joins them through `code`; returns (token, id).
    async fn member_via(&self, name: &str, code: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let (status, body) = self.app.post(&format!("/invites/{code}"), &token, json!({})).await;
        assert_eq!(status, StatusCode::OK, "join: {body}");
        (token, user["id"].as_str().expect("id").to_owned())
    }

    async fn role(&self, name: &str, permissions: u64) -> String {
        let (status, role) = self.app.post(&self.path("/roles"), &self.owner, json!({"name": name, "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "create role: {role}");
        role["id"].as_str().expect("id").to_owned()
    }

    async fn give(&self, user: &str, roles: &[&str]) {
        let (status, body) = self.app.patch(&self.path(&format!("/members/{user}")), &self.owner, json!({"roles": roles})).await;
        assert_eq!(status, StatusCode::OK, "give roles: {body}");
    }

    /// Moves a member's joined_at to `days` days ago.
    async fn joined_days_ago(&self, user: &str, days: i32) {
        sqlx::query("UPDATE guild_members SET joined_at = now() - make_interval(days => $3) WHERE guild_id = $1 AND user_id = $2")
            .bind(self.guild.parse::<i64>().expect("guild id"))
            .bind(user.parse::<i64>().expect("user id"))
            .bind(days)
            .execute(&self.app.state.db)
            .await
            .expect("move joined_at");
    }

    fn path(&self, tail: &str) -> String {
        format!("/guilds/{}{tail}", self.guild)
    }

    async fn search_as(&self, token: &str, body: Value) -> (StatusCode, Value) {
        self.app.post(&self.path("/members-search"), token, body).await
    }

    /// Searches as the owner and returns the user ids in result order, plus the total.
    async fn ids(&self, body: Value) -> (Vec<String>, u64) {
        let (status, result) = self.search_as(&self.owner, body).await;
        assert_eq!(status, StatusCode::OK, "search: {result}");
        let ids = result["members"].as_array().expect("members").iter().map(|m| m["member"]["user"]["id"].as_str().expect("id").to_owned()).collect();
        (ids, result["total_result_count"].as_u64().expect("total"))
    }
}

fn code(body: &Value) -> u64 {
    body["code"].as_u64().unwrap_or(0)
}

fn created_ms(id: &str) -> i64 {
    (id.parse::<i64>().expect("snowflake") >> 22) + EPOCH_MS
}

#[tokio::test]
async fn needs_a_moderation_permission() {
    let w = World::new().await;
    let code_a = w.invite().await;
    let (plain, _) = w.member_via("plain", &code_a).await;
    let (kicker, kicker_id) = w.member_via("kicker", &code_a).await;
    let (nicker, nicker_id) = w.member_via("nicker", &code_a).await;
    let (chatty, chatty_id) = w.member_via("chatty", &code_a).await;
    let (outsider, _) = w.app.register("outsider").await;
    let kick_role = w.role("kick", KICK).await;
    let nick_role = w.role("nick", MANAGE_NICKNAMES).await;
    let chat_role = w.role("chat", SEND_MESSAGES).await;
    w.give(&kicker_id, &[&kick_role]).await;
    w.give(&nicker_id, &[&nick_role]).await;
    w.give(&chatty_id, &[&chat_role]).await;

    for token in [&plain, &chatty] {
        let (status, body) = w.search_as(token, json!({"and_query": {}})).await;
        assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "no moderation permission: {body}");
    }
    let (status, body) = w.search_as(&outsider, json!({"and_query": {}})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50001), "not a member");
    for token in [&w.owner, &kicker, &nicker] {
        let (status, body) = w.search_as(token, json!({"and_query": {}})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["total_result_count"], 5);
        assert_eq!(body["guild_id"], w.guild.as_str());
    }

    let (status, body) = w.search_as(&w.owner, json!({"limit": 0, "and_query": {}})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "limit 0");
    let (status, body) = w.search_as(&w.owner, json!({"sort": 9, "and_query": {}})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "unknown sort");
    let (status, body) = w.search_as(&w.owner, json!({"and_query": {"usernames": {"or_query": ["  "]}}})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "blank term");
}

#[tokio::test]
async fn records_the_join_source_on_invite_accept() {
    let w = World::new().await;
    let first = w.invite().await;
    let second = w.invite().await;
    let (token, id) = w.member_via("joiner", &first).await;

    let (status, body) = w.search_as(&w.owner, json!({"and_query": {}})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["members"].as_array().expect("members");
    let joiner = rows.iter().find(|m| m["member"]["user"]["id"] == id.as_str()).expect("joiner listed");
    assert_eq!(joiner["source_invite_code"], first.as_str());
    assert_eq!(joiner["inviter_id"], w.owner_id.as_str());
    assert_eq!(joiner["join_source_type"], 5);
    let owner = rows.iter().find(|m| m["member"]["user"]["id"] == w.owner_id.as_str()).expect("owner listed");
    assert_eq!((owner["source_invite_code"].clone(), owner["inviter_id"].clone(), owner["join_source_type"].clone()), (Value::Null, Value::Null, json!(0)));

    // Accepting again as a member changes nothing; leaving and rejoining records the new invite.
    let (status, _) = w.app.post(&format!("/invites/{second}"), &token, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (ids, _) = w.ids(json!({"and_query": {"source_invite_code": {"or_query": [first.clone()]}}})).await;
    assert_eq!(ids, vec![id.clone()]);
    let (status, _) = w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &token).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = w.app.post(&format!("/invites/{second}"), &token, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (ids, _) = w.ids(json!({"and_query": {"source_invite_code": {"or_query": [second.clone()]}}})).await;
    assert_eq!(ids, vec![id.clone()]);
    let (ids, _) = w.ids(json!({"and_query": {"source_invite_code": {"or_query": [first]}}})).await;
    assert!(ids.is_empty());

    // A temporary invite records its source too.
    let (status, temp) = w.app.post(&format!("/channels/{}/invites", w.channel), &w.owner, json!({"temporary": true, "unique": true})).await;
    assert_eq!(status, StatusCode::OK, "temporary invite: {temp}");
    let temp = temp["code"].as_str().expect("code").to_owned();
    let (_, guest) = w.member_via("guest", &temp).await;
    let (ids, _) = w.ids(json!({"and_query": {"source_invite_code": {"or_query": [temp]}}})).await;
    assert_eq!(ids, vec![guest]);
}

#[tokio::test]
async fn filters() {
    let w = World::new().await;
    let invite_a = w.invite().await;
    let invite_b = w.invite().await;
    let (_, alice) = w.member_via("alice", &invite_a).await;
    let (alicia_token, alicia) = w.member_via("alicia", &invite_a).await;
    let (_, bob) = w.member_via("bob", &invite_b).await;
    let (_, carol) = w.member_via("carol", &invite_b).await;
    let red = w.role("red", 0).await;
    let blue = w.role("blue", 0).await;
    w.give(&alice, &[&red]).await;
    w.give(&bob, &[&red, &blue]).await;
    w.give(&carol, &[&blue]).await;
    let (status, _) = w.app.patch("/users/@me", &alicia_token, json!({"global_name": "Zed"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = w.app.patch(&w.path(&format!("/members/{carol}")), &w.owner, json!({"nick": "Nicky"})).await;
    assert_eq!(status, StatusCode::OK);

    let sorted = |mut ids: Vec<String>| {
        ids.sort();
        ids
    };
    let search = |query: Value| w.ids(json!({"and_query": query}));

    // Username, display name and nickname prefixes, case-insensitive; an all-digit term is an exact id.
    assert_eq!(sorted(search(json!({"usernames": {"or_query": ["ALI"]}})).await.0), sorted(vec![alice.clone(), alicia.clone()]));
    assert_eq!(search(json!({"usernames": {"or_query": ["zE"]}})).await.0, vec![alicia.clone()]);
    assert_eq!(search(json!({"usernames": {"or_query": ["nick"]}})).await.0, vec![carol.clone()]);
    assert_eq!(search(json!({"usernames": {"or_query": [bob.clone()]}})).await.0, vec![bob.clone()]);
    assert_eq!(sorted(search(json!({"usernames": {"or_query": ["bob", "carol"]}})).await.0), sorted(vec![bob.clone(), carol.clone()]));
    assert!(search(json!({"usernames": {"or_query": ["lice"]}})).await.0.is_empty(), "prefix, not substring");
    assert_eq!(search(json!({"user_id": {"or_query": [carol.clone()]}})).await.0, vec![carol.clone()]);

    // Roles: any of / all of.
    assert_eq!(sorted(search(json!({"role_ids": {"or_query": [red.clone()]}})).await.0), sorted(vec![alice.clone(), bob.clone()]));
    assert_eq!(sorted(search(json!({"role_ids": {"or_query": [red.clone(), blue.clone()]}})).await.0), sorted(vec![alice.clone(), bob.clone(), carol.clone()]));
    assert_eq!(search(json!({"role_ids": {"and_query": [red.clone(), blue.clone()]}})).await.0, vec![bob.clone()]);

    // Join method.
    assert_eq!(sorted(search(json!({"source_invite_code": {"or_query": [invite_b.clone()]}})).await.0), sorted(vec![bob.clone(), carol.clone()]));
    let (unknown, _) = search(json!({"join_source_type": {"or_query": [0]}})).await;
    assert_eq!(unknown, vec![w.owner_id.clone()]);
    let (_, invited) = search(json!({"join_source_type": {"or_query": [5]}})).await;
    assert_eq!(invited, 4);

    // Member since: ranges in unix ms, inclusive.
    w.joined_days_ago(&alice, 30).await;
    w.joined_days_ago(&bob, 10).await;
    let now_ms = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    let day = 86_400_000_i64;
    assert_eq!(search(json!({"guild_joined_at": {"range": {"lte": now_ms - 20 * day}}})).await.0, vec![alice.clone()]);
    assert_eq!(search(json!({"guild_joined_at": {"range": {"gte": now_ms - 20 * day, "lte": now_ms - 5 * day}}})).await.0, vec![bob.clone()]);
    let (_, recent) = search(json!({"guild_joined_at": {"range": {"gte": now_ms - day}}})).await;
    assert_eq!(recent, 3, "owner, alicia and carol joined today");

    // Joined Vokko: read from the snowflake. Everyone registered in order, so a bound at bob's creation splits the list.
    let (later, _) = search(json!({"user_created_at": {"range": {"gte": created_ms(&bob)}}})).await;
    assert!(later.contains(&bob) && later.contains(&carol) && !later.contains(&w.owner_id), "{later:?}");
    let (earlier, _) = search(json!({"user_created_at": {"range": {"lte": created_ms(&bob)}}})).await;
    assert!(earlier.contains(&bob) && earlier.contains(&w.owner_id) && !earlier.contains(&carol), "{earlier:?}");

    // Filters combine with AND.
    assert_eq!(search(json!({"role_ids": {"or_query": [blue]}, "usernames": {"or_query": ["b"]}})).await.0, vec![bob]);
}

#[tokio::test]
async fn sorts_and_pages() {
    let w = World::new().await;
    let invite = w.invite().await;
    let mut members = Vec::new();
    for name in ["m1", "m2", "m3", "m4", "m5"] {
        members.push(w.member_via(name, &invite).await.1);
    }
    // Member-since order is the reverse of registration: m1 joined most recently, m5 longest ago, the owner in between.
    for (index, id) in members.iter().enumerate() {
        w.joined_days_ago(id, if index == 0 { 0 } else { 10 * index as i32 }).await;
    }
    w.joined_days_ago(&w.owner_id, 25).await;
    let [m1, m2, m3, m4, m5] = <[String; 5]>::try_from(members).expect("five");
    let owner = w.owner_id.clone();

    let (newest, total) = w.ids(json!({"and_query": {}})).await;
    assert_eq!(total, 6);
    assert_eq!(newest, vec![m1.clone(), m2.clone(), m3.clone(), owner.clone(), m4.clone(), m5.clone()], "default: member since, newest first");
    let (oldest, _) = w.ids(json!({"sort": 2, "and_query": {}})).await;
    assert_eq!(oldest, newest.iter().rev().cloned().collect::<Vec<_>>());
    let (vokko_newest, _) = w.ids(json!({"sort": 3, "and_query": {}})).await;
    assert_eq!(vokko_newest, vec![m5.clone(), m4.clone(), m3.clone(), m2.clone(), m1.clone(), owner.clone()]);
    let (vokko_oldest, _) = w.ids(json!({"sort": 4, "and_query": {}})).await;
    assert_eq!(vokko_oldest, vec![owner.clone(), m1.clone(), m2.clone(), m3.clone(), m4.clone(), m5.clone()]);

    let (status, page) = w.search_as(&w.owner, json!({"limit": 2, "offset": 2, "and_query": {}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((page["page_result_count"].as_u64(), page["total_result_count"].as_u64()), (Some(2), Some(6)));
    let ids: Vec<&str> = page["members"].as_array().expect("members").iter().map(|m| m["member"]["user"]["id"].as_str().expect("id")).collect();
    assert_eq!(ids, vec![m3.as_str(), owner.as_str()]);
    let (status, past) = w.search_as(&w.owner, json!({"limit": 5, "offset": 5, "and_query": {}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((past["page_result_count"].as_u64(), past["total_result_count"].as_u64()), (Some(1), Some(6)));
    let (status, empty) = w.search_as(&w.owner, json!({"limit": 5, "offset": 50, "and_query": {}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((empty["page_result_count"].as_u64(), empty["total_result_count"].as_u64()), (Some(0), Some(6)));
    // A filtered total counts the matches only.
    let (_, total) = w.ids(json!({"limit": 1, "and_query": {"usernames": {"or_query": ["m"]}}})).await;
    assert_eq!(total, 5);
}
