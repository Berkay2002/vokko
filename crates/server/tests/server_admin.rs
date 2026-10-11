#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Server admin parity: role hierarchy, prune, ban with message history deletion, audit log and its visibility,
//! the overwrite tri-state round trip, verification level and AutoMod keyword rules.
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;

const SEND_MESSAGES: u64 = 1 << 11;
const ATTACH_FILES: u64 = 1 << 15;
const ADD_REACTIONS: u64 = 1 << 6;
const KICK: u64 = 1 << 1;
const MANAGE_GUILD: u64 = 1 << 5;
const VIEW_AUDIT_LOG: u64 = 1 << 7;
const MANAGE_ROLES: u64 = 1 << 28;

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.recv(Duration::from_secs(5)).await.expect("hello");
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        client.wait_for("READY").await;
        client
    }

    async fn recv(&mut self, wait: Duration) -> Option<Value> {
        loop {
            match tokio::time::timeout(wait, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return Some(serde_json::from_str(&text).expect("json frame")),
                Ok(Some(Ok(_))) => continue,
                Ok(_) => panic!("gateway closed"),
                Err(_) => return None,
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.recv(Duration::from_secs(5)).await.unwrap_or_else(|| panic!("timed out waiting for {name}"));
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    /// Every dispatch name that arrives within `wait`.
    async fn drain(&mut self, wait: Duration) -> Vec<String> {
        let mut names = Vec::new();
        while let Some(frame) = self.recv(wait).await {
            if let Some(name) = frame["t"].as_str() {
                names.push(name.to_owned());
            }
        }
        names
    }
}

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

    async fn member(&self, name: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.channel), &self.owner, json!({})).await;
        let (status, body) = self.app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &token, json!({})).await;
        assert_eq!(status, StatusCode::OK, "join: {body}");
        (token, user["id"].as_str().expect("id").to_owned())
    }

    async fn role(&self, name: &str, permissions: u64) -> String {
        let (status, role) = self.app.post(&self.path("/roles"), &self.owner, json!({"name": name, "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "create role: {role}");
        role["id"].as_str().expect("id").to_owned()
    }

    async fn set_position(&self, role: &str, position: i32) {
        let (status, body) = self.app.patch(&self.path("/roles"), &self.owner, json!([{"id": role, "position": position}])).await;
        assert_eq!(status, StatusCode::OK, "positions: {body}");
    }

    async fn give(&self, user: &str, roles: &[&str]) {
        let (status, body) = self.app.patch(&self.path(&format!("/members/{user}")), &self.owner, json!({"roles": roles})).await;
        assert_eq!(status, StatusCode::OK, "give roles: {body}");
    }

    fn path(&self, tail: &str) -> String {
        format!("/guilds/{}{tail}", self.guild)
    }

    /// A request carrying `X-Audit-Log-Reason`.
    async fn with_reason(&self, method: Method, path: &str, token: &str, reason: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header("authorization", token)
            .header("x-audit-log-reason", reason)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        let response = self.app.router.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
        (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) })
    }

    async fn audit(&self, query: &str) -> Vec<Value> {
        let (status, log) = self.app.get(&self.path(&format!("/audit-logs{query}")), &self.owner).await;
        assert_eq!(status, StatusCode::OK, "audit log: {log}");
        log["audit_log_entries"].as_array().expect("entries").clone()
    }

    async fn age_members(&self, days: i32) {
        sqlx::query("UPDATE guild_members SET joined_at = now() - make_interval(days => $2) WHERE guild_id = $1")
            .bind(self.guild.parse::<i64>().expect("id"))
            .bind(days)
            .execute(&self.app.state.db)
            .await
            .expect("age members");
    }
}

fn code(body: &Value) -> u64 {
    body["code"].as_u64().unwrap_or(0)
}

#[tokio::test]
async fn hierarchy_limits_role_edits_assignment_and_reorder() {
    let w = World::new().await;
    let manager_role = w.role("managers", MANAGE_ROLES).await;
    let low = w.role("low", 0).await;
    let high = w.role("high", 0).await;
    w.set_position(&manager_role, 3).await;
    w.set_position(&high, 5).await;
    let (manager, manager_id) = w.member("manager").await;
    let (_, target_id) = w.member("target").await;
    w.give(&manager_id, &[&manager_role]).await;

    // above the actor's top role: no edit, no assignment, no move, no delete
    let (status, body) = w.app.patch(&w.path(&format!("/roles/{high}")), &manager, json!({"name": "mine"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "edit above");
    let (status, body) = w.app.patch(&w.path(&format!("/roles/{manager_role}")), &manager, json!({"name": "mine"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "own top role is not below itself");
    let (status, body) = w.app.patch(&w.path(&format!("/members/{target_id}")), &manager, json!({"roles": [high]})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "assign above");
    let (status, body) = w.app.patch(&w.path("/roles"), &manager, json!([{"id": high, "position": 1}])).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "move a role above");
    let (status, body) = w.app.patch(&w.path("/roles"), &manager, json!([{"id": low, "position": 4}])).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "move a role above oneself");
    let (status, body) = w.app.delete(&w.path(&format!("/roles/{high}")), &manager).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "delete above");

    // below: allowed, including a role icon
    let (status, role) = w.app.patch(&w.path(&format!("/roles/{low}")), &manager, json!({"name": "lower", "unicode_emoji": "🛡️"})).await;
    assert_eq!((status, role["name"].clone(), role["unicode_emoji"].clone()), (StatusCode::OK, json!("lower"), json!("🛡️")), "{role}");
    let (status, body) = w.app.patch(&w.path(&format!("/roles/{low}")), &manager, json!({"unicode_emoji": "x".repeat(40)})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));
    let (status, _) = w.app.patch(&w.path(&format!("/members/{target_id}")), &manager, json!({"roles": [low]})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = w.app.patch(&w.path("/roles"), &manager, json!([{"id": low, "position": 2}])).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // the owner bypasses every rule
    let (status, _) = w.app.patch(&w.path(&format!("/roles/{high}")), &w.owner, json!({"name": "top"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = w.app.patch(&w.path(&format!("/members/{target_id}")), &w.owner, json!({"roles": [low, high]})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, roles) = w.app.patch(&w.path("/roles"), &w.owner, json!([{"id": high, "position": 1}, {"id": low, "position": 6}])).await;
    assert_eq!(status, StatusCode::OK);
    let position = |id: &str| roles.as_array().expect("roles").iter().find(|r| r["id"] == id).expect("role")["position"].clone();
    assert_eq!((position(&high), position(&low)), (json!(1), json!(6)));

    let (status, counts) = w.app.get(&w.path("/roles/member-counts"), &manager).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((counts[&low].clone(), counts[&high].clone(), counts[&manager_role].clone()), (json!(1), json!(1), json!(1)), "{counts}");
    assert!(counts.get(&w.guild).is_none(), "@everyone is left out");
}

#[tokio::test]
async fn prune_counts_and_removes_inactive_members() {
    let w = World::new().await;
    let kept_role = w.role("kept", 0).await;
    let included_role = w.role("included", 0).await;
    let (talker, _) = w.member("talker").await;
    let (_, idle_id) = w.member("idle").await;
    let (_, included_id) = w.member("included").await;
    let (_, kept_id) = w.member("kept").await;
    w.give(&included_id, &[&included_role]).await;
    w.give(&kept_id, &[&kept_role, &included_role]).await;
    w.age_members(10).await;
    let (_, newcomer_id) = w.member("newcomer").await;
    let (status, _) = w.app.post(&format!("/channels/{}/messages", w.channel), &talker, json!({"content": "still here"})).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = w.app.get(&w.path("/prune?days=7"), &talker).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "needs KICK_MEMBERS + MANAGE_GUILD");
    let (status, body) = w.app.get(&w.path("/prune?days=0"), &w.owner).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));
    let (_, count) = w.app.get(&w.path("/prune?days=7"), &w.owner).await;
    assert_eq!(count, json!({"pruned": 1}), "only the idle member without roles");
    let (_, count) = w.app.get(&w.path(&format!("/prune?days=7&include_roles={included_role}")), &w.owner).await;
    assert_eq!(count, json!({"pruned": 2}), "plus the member holding only included roles");
    let (_, count) = w.app.get(&w.path("/prune?days=30"), &w.owner).await;
    assert_eq!(count, json!({"pruned": 0}), "nobody joined 30 days ago");

    // a moderator below the included role cannot include it
    let mods = w.role("mods", KICK | MANAGE_GUILD).await;
    let (moderator, moderator_id) = w.member("moderator").await;
    w.give(&moderator_id, &[&mods]).await;
    w.set_position(&included_role, 5).await;
    let (status, body) = w.app.get(&w.path(&format!("/prune?include_roles={included_role}")), &moderator).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));

    let (status, result) =
        w.with_reason(Method::POST, &w.path("/prune"), &w.owner, "spring%20cleaning", json!({"days": 7, "include_roles": [included_role]})).await;
    assert_eq!((status, result), (StatusCode::OK, json!({"pruned": 2})));
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    let ids: Vec<&str> = members.as_array().expect("members").iter().map(|m| m["user"]["id"].as_str().expect("id")).collect();
    assert!(!ids.contains(&idle_id.as_str()) && !ids.contains(&included_id.as_str()), "pruned");
    assert!(ids.contains(&kept_id.as_str()) && ids.contains(&newcomer_id.as_str()), "kept");
    let entries = w.audit("?action_type=21").await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["options"], json!({"delete_member_days": "7", "members_removed": "2"}));
    assert_eq!(entries[0]["reason"], "spring cleaning");

    let (_, result) = w.app.post(&w.path("/prune"), &w.owner, json!({"days": 7, "compute_prune_count": false})).await;
    assert_eq!(result, json!({"pruned": null}));
}

#[tokio::test]
async fn ban_deletes_message_history_in_bulk() {
    let w = World::new().await;
    let (spammer, spammer_id) = w.member("spammer").await;
    let messages = format!("/channels/{}/messages", w.channel);
    let mut ids = Vec::new();
    for content in ["old", "new 1", "new 2"] {
        let (_, message) = w.app.post(&messages, &spammer, json!({"content": content})).await;
        ids.push(message["id"].as_str().expect("id").to_owned());
    }
    sqlx::query("UPDATE messages SET created_at = now() - interval '2 hours' WHERE id = $1")
        .bind(ids[0].parse::<i64>().expect("id"))
        .execute(&w.app.state.db)
        .await
        .expect("backdate");

    let address = w.app.serve().await;
    let mut owner_ws = Client::connect(&address, &w.owner).await;
    let (status, _) =
        w.with_reason(Method::PUT, &w.path(&format!("/bans/{spammer_id}")), &w.owner, "header reason", json!({"delete_message_seconds": 3600})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let bulk = owner_ws.wait_for("MESSAGE_DELETE_BULK").await;
    let deleted: Vec<String> = bulk["ids"].as_array().expect("ids").iter().map(|id| id.as_str().expect("id").to_owned()).collect();
    assert!(deleted.contains(&ids[1]) && deleted.contains(&ids[2]), "the last hour: {deleted:?}");
    assert!(!deleted.contains(&ids[0]), "older messages stay");
    assert_eq!((bulk["channel_id"].as_str(), bulk["guild_id"].as_str()), (Some(w.channel.as_str()), Some(w.guild.as_str())));
    let (_, left) = w.app.get(&messages, &w.owner).await;
    let left: Vec<&str> =
        left.as_array().expect("messages").iter().filter(|m| m["author"]["id"] == spammer_id.as_str()).map(|m| m["id"].as_str().expect("id")).collect();
    assert_eq!(left, vec![ids[0].as_str()]);

    let (_, bans) = w.app.get(&w.path("/bans"), &w.owner).await;
    assert_eq!(bans[0]["reason"], "header reason", "the header is the fallback ban reason");
    let entries = w.audit("?action_type=22").await;
    assert_eq!((entries[0]["target_id"].as_str(), entries[0]["user_id"].as_str()), (Some(spammer_id.as_str()), Some(w.owner_id.as_str())));
    let (status, _) = w.app.delete(&w.path(&format!("/bans/{spammer_id}")), &w.owner).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(w.audit("?action_type=23").await.len(), 1);
}

#[tokio::test]
async fn audit_entries_record_changes_and_reach_only_auditors() {
    let w = World::new().await;
    let auditors = w.role("auditors", VIEW_AUDIT_LOG).await;
    let role = w.role("helpers", 0).await;
    let (auditor, auditor_id) = w.member("auditor").await;
    let (plain, plain_id) = w.member("plain").await;
    w.give(&auditor_id, &[&auditors]).await;

    let (status, body) = w.app.get(&w.path("/audit-logs"), &plain).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, _) = w.app.get(&w.path("/audit-logs"), &auditor).await;
    assert_eq!(status, StatusCode::OK);

    let address = w.app.serve().await;
    let mut auditor_ws = Client::connect(&address, &auditor).await;
    let mut plain_ws = Client::connect(&address, &plain).await;
    let (status, _) =
        w.with_reason(Method::PATCH, &w.path(&format!("/roles/{role}")), &w.owner, "rename%20for%20clarity", json!({"name": "helpers 2", "color": 255})).await;
    assert_eq!(status, StatusCode::OK);
    let entry = auditor_ws.wait_for("GUILD_AUDIT_LOG_ENTRY_CREATE").await;
    assert_eq!((entry["action_type"].clone(), entry["target_id"].clone(), entry["reason"].clone()), (json!(31), json!(role), json!("rename for clarity")));
    let changes = entry["changes"].as_array().expect("changes");
    assert!(changes.contains(&json!({"key": "name", "old_value": "helpers", "new_value": "helpers 2"})), "{entry}");
    assert!(changes.contains(&json!({"key": "color", "old_value": 0, "new_value": 255})));
    assert_eq!(changes.len(), 2, "unchanged keys are left out");
    plain_ws.wait_for("GUILD_ROLE_UPDATE").await;
    assert!(!plain_ws.drain(Duration::from_millis(400)).await.contains(&"GUILD_AUDIT_LOG_ENTRY_CREATE".to_owned()), "plain members get no audit events");

    // member role add, nick and timeout, kick, channel and guild edits
    let (status, _) = w.app.patch(&w.path(&format!("/members/{plain_id}")), &w.owner, json!({"roles": [role], "nick": "P"})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, channel) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "logs", "type": 0})).await;
    let channel_id = channel["id"].as_str().expect("id").to_owned();
    w.app.patch(&format!("/channels/{channel_id}"), &w.owner, json!({"topic": "audit me"})).await;
    w.app.delete(&format!("/channels/{channel_id}"), &w.owner).await;
    let (status, _) = w.app.patch(&w.path(""), &w.owner, json!({"name": "Renamed guild", "verification_level": 1})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, message) = w.app.post(&format!("/channels/{}/messages", w.channel), &plain, json!({"content": "pin me"})).await;
    let message_id = message["id"].as_str().expect("id");
    w.app.put(&format!("/channels/{}/messages/pins/{message_id}", w.channel), &w.owner).await;
    w.app.delete(&format!("/channels/{}/messages/{message_id}", w.channel), &w.owner).await;
    w.app.delete(&w.path(&format!("/members/{plain_id}")), &w.owner).await;

    let all = w.audit("").await;
    let actions: Vec<u64> = all.iter().map(|e| e["action_type"].as_u64().expect("type")).collect();
    assert_eq!(&actions[..10], &[20, 72, 74, 1, 12, 11, 10, 25, 24, 31], "newest first: {actions:?}");
    let role_update = &all[7];
    assert_eq!(role_update["changes"], json!([{"key": "$add", "new_value": [{"id": role, "name": "helpers 2"}]}]));
    assert_eq!(all[8]["changes"], json!([{"key": "nick", "new_value": "P"}]));
    assert_eq!(
        all[3]["changes"],
        json!([{"key": "name", "old_value": "Test guild", "new_value": "Renamed guild"}, {"key": "verification_level", "old_value": 0, "new_value": 1}])
    );
    assert_eq!(all[5]["changes"], json!([{"key": "topic", "new_value": "audit me"}]));
    assert_eq!((all[1]["target_id"].as_str(), all[1]["options"]["channel_id"].as_str()), (Some(plain_id.as_str()), Some(w.channel.as_str())));
    assert_eq!(all[2]["options"]["message_id"], message_id);

    // filters and paging
    let kicks = w.audit("?action_type=20").await;
    assert_eq!(kicks.len(), 1);
    let by_owner = w.audit(&format!("?user_id={}", w.owner_id)).await;
    assert_eq!(by_owner.len(), all.len(), "every entry here is the owner's");
    let page = w.audit(&format!("?before={}&limit=2", all[1]["id"].as_str().expect("id"))).await;
    assert_eq!(page.iter().map(|e| e["id"].clone()).collect::<Vec<_>>(), vec![all[2]["id"].clone(), all[3]["id"].clone()]);
    let (status, body) = w.app.get(&w.path("/audit-logs?limit=101"), &w.owner).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));
    let (_, log) = w.app.get(&w.path("/audit-logs?action_type=20"), &w.owner).await;
    let users: Vec<&str> = log["users"].as_array().expect("users").iter().map(|u| u["id"].as_str().expect("id")).collect();
    assert!(users.contains(&plain_id.as_str()) && users.contains(&w.owner_id.as_str()), "actor and target users: {users:?}");
}

#[tokio::test]
async fn invite_create_and_revoke_are_audited() {
    let w = World::new().await;
    let (status, invite) =
        w.with_reason(Method::POST, &format!("/channels/{}/invites", w.channel), &w.owner, "for%20friends", json!({"max_uses": 5, "unique": true})).await;
    assert_eq!(status, StatusCode::OK);
    let code = invite["code"].as_str().expect("code").to_owned();
    let created: Vec<Value> = w.audit("?action_type=40").await.into_iter().filter(|e| e["target_id"] == code.as_str()).collect();
    assert_eq!(created.len(), 1);
    assert_eq!((created[0]["target_id"].as_str(), created[0]["reason"].as_str()), (Some(code.as_str()), Some("for friends")));
    let changes = created[0]["changes"].as_array().expect("changes");
    assert!(changes.contains(&json!({"key": "code", "new_value": code})) && changes.contains(&json!({"key": "max_uses", "new_value": 5})), "{changes:?}");

    let (status, _) = w.app.delete(&format!("/invites/{code}"), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let deleted = w.audit("?action_type=42").await;
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0]["target_id"].as_str(), Some(code.as_str()));
    assert!(deleted[0]["changes"].as_array().expect("changes").contains(&json!({"key": "code", "old_value": code})));
}

#[tokio::test]
async fn timed_out_auditors_get_no_live_audit_entries() {
    let w = World::new().await;
    let auditors = w.role("auditors", VIEW_AUDIT_LOG).await;
    let role = w.role("helpers", 0).await;
    let (auditor, auditor_id) = w.member("auditor").await;
    w.give(&auditor_id, &[&auditors]).await;
    let until = (time::OffsetDateTime::now_utc() + time::Duration::days(1)).format(&time::format_description::well_known::Rfc3339).expect("fmt");
    let (status, _) = w.app.patch(&w.path(&format!("/members/{auditor_id}")), &w.owner, json!({"communication_disabled_until": until})).await;
    assert_eq!(status, StatusCode::OK);

    let address = w.app.serve().await;
    let mut auditor_ws = Client::connect(&address, &auditor).await;
    let (status, _) = w.app.patch(&w.path(&format!("/roles/{role}")), &w.owner, json!({"name": "helpers 2"})).await;
    assert_eq!(status, StatusCode::OK);
    let seen = auditor_ws.drain(Duration::from_millis(600)).await;
    assert!(seen.contains(&"GUILD_ROLE_UPDATE".to_owned()), "{seen:?}");
    assert!(!seen.contains(&"GUILD_AUDIT_LOG_ENTRY_CREATE".to_owned()), "a timed-out auditor gets no live audit entries: {seen:?}");
}

#[tokio::test]
async fn overwrite_tri_state_round_trips() {
    let w = World::new().await;
    let role = w.role("muted", 0).await;
    let (member, member_id) = w.member("member").await;
    w.give(&member_id, &[&role]).await;
    let path = format!("/channels/{}/permissions/{role}", w.channel);
    let overwrite_of = |channels: &Value| -> Option<Value> {
        let channel = channels.as_array().expect("channels").iter().find(|c| c["id"] == w.channel.as_str()).expect("channel").clone();
        channel["permission_overwrites"].as_array().expect("overwrites").iter().find(|o| o["id"] == role.as_str()).cloned()
    };

    // allow ATTACH_FILES, deny SEND_MESSAGES, ADD_REACTIONS neutral
    let (status, _) = w.app.put_json(&path, &w.owner, json!({"type": 0, "allow": ATTACH_FILES.to_string(), "deny": SEND_MESSAGES.to_string()})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, channels) = w.app.get(w.path("/channels").as_str(), &w.owner).await;
    assert_eq!(overwrite_of(&channels), Some(json!({"id": role, "type": 0, "allow": ATTACH_FILES.to_string(), "deny": SEND_MESSAGES.to_string()})));
    let (status, body) = w.app.post(&format!("/channels/{}/messages", w.channel), &member, json!({"content": "hi"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "deny applies");

    // flip: SEND allow, ATTACH back to neutral, ADD_REACTIONS deny
    let (status, _) = w.app.put_json(&path, &w.owner, json!({"type": 0, "allow": SEND_MESSAGES.to_string(), "deny": ADD_REACTIONS.to_string()})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, channels) = w.app.get(w.path("/channels").as_str(), &w.owner).await;
    assert_eq!(overwrite_of(&channels), Some(json!({"id": role, "type": 0, "allow": SEND_MESSAGES.to_string(), "deny": ADD_REACTIONS.to_string()})));
    let (status, _) = w.app.post(&format!("/channels/{}/messages", w.channel), &member, json!({"content": "hi"})).await;
    assert_eq!(status, StatusCode::OK, "allow applies");

    // all neutral = delete
    let (status, _) = w.app.delete(&path, &w.owner).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, channels) = w.app.get(w.path("/channels").as_str(), &w.owner).await;
    assert_eq!(overwrite_of(&channels), None);

    let entries = w.audit(&format!("?user_id={}", w.owner_id)).await;
    let overwrite_entries: Vec<&Value> = entries.iter().filter(|e| (13..=15).contains(&e["action_type"].as_u64().unwrap_or(0))).collect();
    assert_eq!(overwrite_entries.iter().map(|e| e["action_type"].clone()).collect::<Vec<_>>(), vec![json!(15), json!(14), json!(13)]);
    assert_eq!(overwrite_entries[1]["options"], json!({"id": role, "type": "0", "role_name": "muted"}));
    assert_eq!(
        overwrite_entries[1]["changes"],
        json!([
            {"key": "allow", "old_value": ATTACH_FILES.to_string(), "new_value": SEND_MESSAGES.to_string()},
            {"key": "deny", "old_value": SEND_MESSAGES.to_string(), "new_value": ADD_REACTIONS.to_string()}
        ])
    );
    assert_eq!(overwrite_entries[0]["target_id"], w.channel.as_str());
}

#[tokio::test]
async fn automod_blocks_keywords_except_for_exempt_roles() {
    let w = World::new().await;
    let trusted = w.role("trusted", 0).await;
    let (member, _) = w.member("member").await;
    let (veteran, veteran_id) = w.member("veteran").await;
    w.give(&veteran_id, &[&trusted]).await;
    let rules = w.path("/auto-moderation/rules");
    let messages = format!("/channels/{}/messages", w.channel);

    let rule_body = json!({
        "name": "No bad words", "event_type": 1, "trigger_type": 1,
        "trigger_metadata": {"keyword_filter": ["bad*", "free money"], "allow_list": ["badge"]},
        "actions": [{"type": 1, "metadata": {"custom_message": "Keep it friendly"}}], "exempt_roles": [trusted]
    });
    let (status, body) = w.app.post(&rules, &member, rule_body.clone()).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "MANAGE_GUILD only");
    let (status, body) = w.app.post(&rules, &w.owner, json!({"name": "x", "event_type": 1, "trigger_type": 3, "actions": [{"type": 1}]})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "only keyword rules");

    let address = w.app.serve().await;
    let mut owner_ws = Client::connect(&address, &w.owner).await;
    let (status, rule) = w.app.post(&rules, &w.owner, rule_body).await;
    assert_eq!(status, StatusCode::OK, "{rule}");
    assert_eq!(owner_ws.wait_for("AUTO_MODERATION_RULE_CREATE").await["id"], rule["id"]);
    assert_eq!(rule["actions"], json!([{"type": 1, "metadata": {"custom_message": "Keep it friendly"}}]));
    let rule_id = rule["id"].as_str().expect("id").to_owned();

    let (status, body) = w.app.post(&messages, &member, json!({"content": "This is BADLY done"})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 200000), "{body}");
    assert_eq!(body["errors"]["content"]["_errors"][0]["message"], "Keep it friendly");
    let (status, _) = w.app.post(&messages, &member, json!({"content": "want free  money?"})).await;
    assert_eq!(status, StatusCode::OK, "words must be adjacent as written");
    let (status, body) = w.app.post(&messages, &member, json!({"content": "get FREE MONEY now"})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 200000));
    let (status, ok) = w.app.post(&messages, &member, json!({"content": "nice badge"})).await;
    assert_eq!(status, StatusCode::OK, "allow list");
    let (status, _) = w.app.post(&messages, &veteran, json!({"content": "bad"})).await;
    assert_eq!(status, StatusCode::OK, "exempt role");
    let (status, _) = w.app.post(&messages, &w.owner, json!({"content": "bad"})).await;
    assert_eq!(status, StatusCode::OK, "owner");
    let (status, body) = w.app.patch(&format!("{messages}/{}", ok["id"].as_str().expect("id")), &member, json!({"content": "bad badge"})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 200000), "edits are checked too");

    let blocks = w.audit("?action_type=143").await;
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["options"]["auto_moderation_rule_name"], "No bad words");
    assert_eq!(blocks[0]["options"]["channel_id"], w.channel.as_str());

    // disabled rules do not block; exempt channels neither
    let (status, updated) = w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"enabled": false})).await;
    assert_eq!((status, updated["enabled"].clone()), (StatusCode::OK, json!(false)));
    let (status, _) = w.app.post(&messages, &member, json!({"content": "bad"})).await;
    assert_eq!(status, StatusCode::OK);
    w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"enabled": true, "exempt_channels": [w.channel]})).await;
    let (status, _) = w.app.post(&messages, &member, json!({"content": "bad"})).await;
    assert_eq!(status, StatusCode::OK, "exempt channel");
    let (status, body) = w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"exempt_roles": ["12345"]})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));

    // at most 6 rules; delete
    for index in 0..5 {
        let (status, body) =
            w.app.post(&rules, &w.owner, json!({"name": format!("r{index}"), "event_type": 1, "trigger_type": 1, "actions": [{"type": 1}]})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = w.app.post(&rules, &w.owner, json!({"name": "seventh", "event_type": 1, "trigger_type": 1, "actions": [{"type": 1}]})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 30035));
    let (status, _) = w.app.delete(&format!("{rules}/{rule_id}"), &w.owner).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = w.app.get(&format!("{rules}/{rule_id}"), &w.owner).await;
    assert_eq!((status, code(&body)), (StatusCode::NOT_FOUND, 10066));
    let (_, list) = w.app.get(&rules, &w.owner).await;
    assert_eq!(list.as_array().expect("rules").len(), 5);
    assert_eq!(w.audit("?action_type=142").await.len(), 1);
}

#[tokio::test]
async fn verification_level_gates_new_members_without_roles() {
    let w = World::new().await;
    let role = w.role("verified", 0).await;
    let (member, member_id) = w.member("fresh").await;
    let messages = format!("/channels/{}/messages", w.channel);
    let (status, guild) = w.app.patch(&w.path(""), &w.owner, json!({"verification_level": 3, "explicit_content_filter": 2})).await;
    assert_eq!((status, guild["verification_level"].clone(), guild["explicit_content_filter"].clone()), (StatusCode::OK, json!(3), json!(2)));
    let (status, body) = w.app.patch(&w.path(""), &w.owner, json!({"verification_level": 9})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50009), "a brand new account");
    let (status, _) = w.app.post(&messages, &w.owner, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::OK, "the owner bypasses it");
    w.give(&member_id, &[&role]).await;
    let (status, _) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::OK, "any role bypasses it");
    w.give(&member_id, &[]).await;

    // old enough account and membership
    sqlx::query("UPDATE users SET created_at = now() - interval '1 day' WHERE id = $1")
        .bind(member_id.parse::<i64>().expect("id"))
        .execute(&w.app.state.db)
        .await
        .expect("age");
    let (status, _) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "High also needs 10 minutes of membership");
    w.age_members(1).await;
    let (status, _) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, guild) = w.app.get(&w.path(""), &member).await;
    assert_eq!(guild["verification_level"], 3);
    let (status, _) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let _ = w.owner_id;
}
