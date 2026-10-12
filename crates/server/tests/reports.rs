#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

/// MANAGE_MESSAGES, MODERATE_MEMBERS and VIEW_CHANNEL (Discord bits).
const MANAGE_MESSAGES: u64 = 1 << 13;
const MODERATE_MEMBERS: u64 = 1 << 40;
const VIEW_CHANNEL: u64 = 1 << 10;

struct World {
    app: TestApp,
    owner: String,
    guild: String,
    general: String,
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

async fn world() -> World {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    World { app, owner, guild, general }
}

impl World {
    /// A new member; returns (token, user id).
    async fn join(&self, name: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.general), &self.owner, json!({"unique": true})).await;
        let code = invite["code"].as_str().expect("code");
        assert_eq!(self.app.post(&format!("/invites/{code}"), &token, json!({})).await.0, StatusCode::OK);
        (token, id(&user))
    }

    async fn say(&self, token: &str, channel: &str, content: &str) -> String {
        let (status, message) = self.app.post(&format!("/channels/{channel}/messages"), token, json!({"content": content})).await;
        assert_eq!(status, StatusCode::OK, "send: {message}");
        id(&message)
    }

    async fn grant(&self, user_id: &str, permissions: u64) {
        let (status, role) =
            self.app.post(&format!("/guilds/{}/roles", self.guild), &self.owner, json!({"name": "mods", "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "role: {role}");
        let path = format!("/guilds/{}/members/{user_id}", self.guild);
        assert_eq!(self.app.patch(&path, &self.owner, json!({"roles": [role["id"]]})).await.0, StatusCode::OK);
    }

    async fn overwrite(&self, channel: &str, target: &str, kind: u8, allow: u64, deny: u64) {
        let path = format!("/channels/{channel}/permissions/{target}");
        let body = json!({"type": kind, "allow": allow.to_string(), "deny": deny.to_string()});
        assert_eq!(self.app.put_json(&path, &self.owner, body).await.0, StatusCode::NO_CONTENT);
    }

    fn message_path(&self, channel: &str, message: &str) -> String {
        format!("/channels/{channel}/messages/{message}/report")
    }

    fn member_path(&self, user: &str) -> String {
        format!("/guilds/{}/members/{user}/report", self.guild)
    }

    async fn reports(&self, token: &str, query: &str) -> (StatusCode, Value) {
        self.app.get(&format!("/guilds/{}/reports{query}", self.guild), token).await
    }
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("report list").iter().map(id).collect()
}

#[tokio::test]
async fn members_report_messages_with_a_snapshot_once_per_open_report() {
    let w = world().await;
    let (alice, alice_id) = w.join("alice").await;
    let (bob, bob_id) = w.join("bob").await;
    let message = w.say(&alice, &w.general, "buy cheap followers").await;
    let path = w.message_path(&w.general, &message);

    let (status, report) = w.app.post(&path, &bob, json!({"reason": "spam", "details": "  posted in every channel  "})).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(
        (report["target_type"].clone(), report["reason"].clone(), report["status"].clone(), report["details"].clone()),
        (json!("message"), json!("spam"), json!("open"), json!("posted in every channel"))
    );
    assert_eq!((report["guild_id"].as_str(), report["channel_id"].as_str()), (Some(w.guild.as_str()), Some(w.general.as_str())));
    assert_eq!((id(&report["reporter"]), id(&report["target_user"])), (bob_id.clone(), alice_id.clone()));
    assert_eq!(report["message_content"], "buy cheap followers");
    assert_eq!((report["closed_by"].clone(), report["closed_at"].clone()), (Value::Null, Value::Null));

    // Editing the message later does not change the snapshot; reporting it again returns the open report unchanged.
    assert_eq!(w.app.patch(&format!("/channels/{}/messages/{message}", w.general), &alice, json!({"content": "hello"})).await.0, StatusCode::OK);
    let (status, again) = w.app.post(&path, &bob, json!({"reason": "harassment"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((id(&again), again["reason"].clone(), again["message_content"].clone()), (id(&report), json!("spam"), json!("buy cheap followers")));

    // Not your own message; unknown messages and reasons; details at most 1000 characters.
    let (status, error) = w.app.post(&path, &alice, json!({"reason": "spam"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    assert!(error["errors"]["message_id"].is_object(), "{error}");
    let (status, error) = w.app.post(&w.message_path(&w.general, "1234"), &bob, json!({"reason": "spam"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10008)));
    assert_eq!(w.app.post(&path, &w.owner, json!({"reason": "rude"})).await.0, StatusCode::BAD_REQUEST);
    let (status, error) = w.app.post(&path, &w.owner, json!({"reason": "other", "details": "x".repeat(1001)})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    assert_eq!(w.app.post(&path, &w.owner, json!({"reason": "other", "details": "x".repeat(1000)})).await.0, StatusCode::OK);

    // Someone outside the guild cannot report (nor learn whether the message exists).
    let (outsider, _) = w.app.register("carol").await;
    let (status, error) = w.app.post(&path, &outsider, json!({"reason": "spam"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50001)));
    // And a DM message report has no guild.
    let (_, dm) = w.app.post("/users/@me/channels", &bob, json!({"recipient_id": alice_id})).await;
    let dm = id(&dm);
    let dm_message = w.say(&alice, &dm, "psst").await;
    let (status, dm_report) = w.app.post(&w.message_path(&dm, &dm_message), &bob, json!({"reason": "harassment"})).await;
    assert_eq!((status, dm_report["guild_id"].clone()), (StatusCode::OK, Value::Null));
}

#[tokio::test]
async fn members_report_members_of_the_same_guild() {
    let w = world().await;
    let (alice, alice_id) = w.join("alice").await;
    let (_, bob_id) = w.join("bob").await;
    let (status, report) = w.app.post(&w.member_path(&bob_id), &alice, json!({"reason": "impersonation"})).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!((report["target_type"].clone(), id(&report["target_user"]), report["message_id"].clone()), (json!("user"), bob_id.clone(), Value::Null));
    let (_, again) = w.app.post(&w.member_path(&bob_id), &alice, json!({"reason": "spam", "details": ""})).await;
    assert_eq!((id(&again), again["reason"].clone()), (id(&report), json!("impersonation")));

    let (status, error) = w.app.post(&w.member_path(&alice_id), &alice, json!({"reason": "spam"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    let (_, stranger) = w.app.register("dave").await;
    let (status, error) = w.app.post(&w.member_path(&id(&stranger)), &alice, json!({"reason": "spam"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10007)));
    let (outsider, _) = w.app.register("carol").await;
    let (status, error) = w.app.post(&w.member_path(&bob_id), &outsider, json!({"reason": "spam"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50001)));
}

#[tokio::test]
async fn moderators_list_and_close_reports_they_can_see() {
    let w = world().await;
    let (alice, alice_id) = w.join("alice").await;
    let (bob, bob_id) = w.join("bob").await;
    let (carol, carol_id) = w.join("carol").await;
    let public = w.say(&alice, &w.general, "public").await;
    let (_, by_message) = w.app.post(&w.message_path(&w.general, &public), &bob, json!({"reason": "hate"})).await;
    let (_, by_member) = w.app.post(&w.member_path(&alice_id), &bob, json!({"reason": "harassment"})).await;

    // A private channel only alice can see (besides the owner); a report of a message there is hidden from moderators who cannot.
    let (_, private) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "secret", "type": 0})).await;
    let private = id(&private);
    w.overwrite(&private, &w.guild, 0, 0, VIEW_CHANNEL).await;
    w.overwrite(&private, &alice_id, 1, VIEW_CHANNEL, 0).await;
    w.overwrite(&private, &carol_id, 1, VIEW_CHANNEL, 0).await;
    let secret = w.say(&alice, &private, "secret").await;
    let (_, hidden) = w.app.post(&w.message_path(&private, &secret), &carol, json!({"reason": "violence"})).await;

    // A plain member is no moderator; MANAGE_MESSAGES or MODERATE_MEMBERS is.
    let (status, error) = w.reports(&alice, "").await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)));
    w.grant(&bob_id, MODERATE_MEMBERS).await;
    let (status, seen) = w.reports(&bob, "").await;
    assert_eq!(status, StatusCode::OK, "{seen}");
    assert_eq!(ids(&seen), [id(&by_member), id(&by_message)], "newest first, the private channel's report left out");
    let (_, all) = w.reports(&w.owner, "?status=all").await;
    assert_eq!(ids(&all), [id(&hidden), id(&by_member), id(&by_message)]);
    let (_, page) = w.reports(&w.owner, &format!("?limit=1&before={}", id(&hidden))).await;
    assert_eq!(ids(&page), [id(&by_member)]);
    assert_eq!(w.reports(&w.owner, "?status=new").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.reports(&w.owner, "?limit=0").await.0, StatusCode::BAD_REQUEST);
    let (_, carol_user) = w.app.get("/users/@me", &carol).await;
    w.grant(&id(&carol_user), MANAGE_MESSAGES).await;
    assert_eq!(ids(&w.reports(&carol, "").await.1).len(), 3, "carol can see the private channel");

    // Closing and reopening; a hidden report cannot be touched.
    let path = format!("/guilds/{}/reports/{}", w.guild, id(&by_message));
    let (status, closed) = w.app.patch(&path, &bob, json!({"status": "resolved"})).await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!((closed["status"].clone(), closed["closed_by"].as_str()), (json!("resolved"), Some(bob_id.as_str())));
    assert!(closed["closed_at"].is_string());
    assert_eq!(ids(&w.reports(&bob, "").await.1), [id(&by_member)]);
    assert_eq!(ids(&w.reports(&bob, "?status=resolved").await.1), [id(&by_message)]);
    let hidden_path = format!("/guilds/{}/reports/{}", w.guild, id(&hidden));
    assert_eq!(w.app.patch(&hidden_path, &bob, json!({"status": "dismissed"})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.patch(&path, &alice, json!({"status": "open"})).await.0, StatusCode::FORBIDDEN);

    // Once closed, the reporter can report it again; reopening the old one then conflicts with the new open one.
    let (_, fresh) = w.app.post(&w.message_path(&w.general, &public), &bob, json!({"reason": "hate"})).await;
    assert_ne!(id(&fresh), id(&by_message));
    let (status, error) = w.app.patch(&path, &w.owner, json!({"status": "open"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    let (status, reopened) = w.app.patch(&format!("/guilds/{}/reports/{}", w.guild, id(&fresh)), &w.owner, json!({"status": "dismissed"})).await;
    assert_eq!((status, reopened["status"].clone()), (StatusCode::OK, json!("dismissed")));
    let (status, reopened) = w.app.patch(&path, &w.owner, json!({"status": "open"})).await;
    assert_eq!((status, reopened["closed_by"].clone(), reopened["closed_at"].clone()), (StatusCode::OK, Value::Null, Value::Null));
}

#[tokio::test]
async fn reporting_is_rate_limited_per_reporter() {
    let w = world().await;
    let (alice, _) = w.join("alice").await;
    let (bob, _) = w.join("bob").await;
    let mut messages = Vec::new();
    for index in 0..6 {
        messages.push(w.say(&alice, &w.general, &format!("spam {index}")).await);
    }
    for message in &messages[..5] {
        assert_eq!(w.app.post(&w.message_path(&w.general, message), &bob, json!({"reason": "spam"})).await.0, StatusCode::OK);
    }
    // Repeating an open report does not count, a new one is limited.
    assert_eq!(w.app.post(&w.message_path(&w.general, &messages[0]), &bob, json!({"reason": "spam"})).await.0, StatusCode::OK);
    let (status, error) = w.app.post(&w.message_path(&w.general, &messages[5]), &bob, json!({"reason": "spam"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(error["retry_after"].as_f64().expect("retry_after") > 0.0);
    assert_eq!(w.app.post(&w.message_path(&w.general, &messages[5]), &w.owner, json!({"reason": "spam"})).await.0, StatusCode::OK, "per reporter");
}

#[tokio::test]
async fn moderators_never_see_reports_about_themselves_or_deleted_channels_unless_admin() {
    let w = world().await;
    let (alice, _) = w.join("alice").await;
    let (bob, bob_id) = w.join("bob").await;
    w.grant(&bob_id, MODERATE_MEMBERS).await;
    let (_, about_bob) = w.app.post(&w.member_path(&bob_id), &alice, json!({"reason": "harassment"})).await;
    assert_eq!(ids(&w.reports(&bob, "").await.1), Vec::<String>::new(), "a moderator does not see reports about themselves");
    assert_eq!(ids(&w.reports(&w.owner, "").await.1), [id(&about_bob)]);
    let path = format!("/guilds/{}/reports/{}", w.guild, id(&about_bob));
    assert_eq!(w.app.patch(&path, &bob, json!({"status": "dismissed"})).await.0, StatusCode::NOT_FOUND);

    // A report from a channel that is deleted later: its snapshot may have been private, so only administrators keep seeing it.
    let (_, channel) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "doomed", "type": 0})).await;
    let channel = id(&channel);
    let message = w.say(&bob, &channel, "rude").await;
    let (_, gone) = w.app.post(&w.message_path(&channel, &message), &alice, json!({"reason": "hate"})).await;
    assert_eq!(w.app.delete(&format!("/channels/{channel}"), &w.owner).await.0, StatusCode::OK);
    let (carol, carol_id) = w.join("carol").await;
    w.grant(&carol_id, MANAGE_MESSAGES).await;
    assert_eq!(ids(&w.reports(&carol, "").await.1), [id(&about_bob)]);
    assert_eq!(ids(&w.reports(&w.owner, "").await.1), [id(&gone), id(&about_bob)]);
    let gone_path = format!("/guilds/{}/reports/{}", w.guild, id(&gone));
    assert_eq!(w.app.patch(&gone_path, &carol, json!({"status": "resolved"})).await.0, StatusCode::NOT_FOUND);

    // A report id is only reachable through its own guild.
    let (other_guild, _) = w.app.guild_with_channel(&w.owner).await;
    let other_path = format!("/guilds/{other_guild}/reports/{}", id(&gone));
    assert_eq!(w.app.patch(&other_path, &w.owner, json!({"status": "resolved"})).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn closing_and_reopening_a_report_is_audited_without_its_contents() {
    let w = world().await;
    let (alice, _) = w.join("alice").await;
    let (bob, bob_id) = w.join("bob").await;
    let message = w.say(&alice, &w.general, "rude").await;
    let (_, report) = w.app.post(&w.message_path(&w.general, &message), &bob, json!({"reason": "harassment", "details": "private details"})).await;
    let path = format!("/guilds/{}/reports/{}", w.guild, id(&report));
    assert_eq!(w.app.patch(&path, &w.owner, json!({"status": "dismissed"})).await.0, StatusCode::OK);
    assert_eq!(w.app.patch(&path, &w.owner, json!({"status": "dismissed"})).await.0, StatusCode::OK, "same status: no entry");
    assert_eq!(w.app.patch(&path, &w.owner, json!({"status": "open"})).await.0, StatusCode::OK);

    let (status, log) = w.app.get(&format!("/guilds/{}/audit-logs?action_type=250", w.guild), &w.owner).await;
    assert_eq!(status, StatusCode::OK, "{log}");
    let entries = log["audit_log_entries"].as_array().expect("entries");
    let statuses: Vec<(Value, Value)> = entries.iter().map(|e| (e["changes"][0]["old_value"].clone(), e["changes"][0]["new_value"].clone())).collect();
    assert_eq!(statuses, [(json!("dismissed"), json!("open")), (json!("open"), json!("dismissed"))], "newest first");
    for entry in entries {
        assert_eq!((entry["target_id"].as_str(), entry["changes"].as_array().map(Vec::len)), (Some(id(&report).as_str()), Some(1)));
        assert!(entry.get("options").is_none());
        assert!(!entry.to_string().contains("private details") && !entry.to_string().contains(&bob_id), "no report contents: {entry}");
    }
}
