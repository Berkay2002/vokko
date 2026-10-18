#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Server admin parity: role hierarchy, prune, ban with message history deletion, audit log and its visibility,
//! the overwrite tri-state round trip, verification level, the Access page fields and AutoMod keyword rules.
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
        client.recv(common::WAIT).await.expect("hello");
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
            let frame = self.recv(common::WAIT).await.unwrap_or_else(|| panic!("timed out waiting for {name}"));
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
        Self::with_app(TestApp::new().await).await
    }

    async fn with_app(app: TestApp) -> Self {
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
    let (status, body) = w.app.post(&rules, &w.owner, json!({"name": "x", "event_type": 1, "trigger_type": 2, "actions": [{"type": 1}]})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "trigger type 2 (harmful links) does not exist");

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
    let poll = |question: &str, answer: &str| json!({"poll": {"question": {"text": question}, "answers": [{"poll_media": {"text": answer}}]}});
    let (status, body) = w.app.post(&messages, &member, poll("Who is bad?", "nobody")).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 200000), "poll questions are checked: {body}");
    let (status, body) = w.app.post(&messages, &member, poll("Lunch?", "free money")).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 200000), "poll answers are checked: {body}");
    let (status, body) = w.app.post(&messages, &member, poll("Lunch?", "pizza")).await;
    assert_eq!(status, StatusCode::OK, "a clean poll: {body}");

    let blocks = w.audit("?action_type=143").await;
    assert_eq!(blocks.len(), 5);
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
    let (status, body) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50009), "and a verified email");
    assert!(body["message"].as_str().unwrap_or_default().contains("Verify your email"), "{body}");
    sqlx::query("UPDATE users SET email_verified = true WHERE id = $1")
        .bind(member_id.parse::<i64>().expect("id"))
        .execute(&w.app.state.db)
        .await
        .expect("verify");
    let (status, _) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::OK);

    // Low: only the verified email; an instance without SMTP (mails only logged) lets everyone through
    let (status, _) = w.app.patch(&w.path(""), &w.owner, json!({"verification_level": 1})).await;
    assert_eq!(status, StatusCode::OK);
    let (newbie, _) = w.member("newbie").await;
    let (status, _) = w.app.post(&messages, &newbie, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "Low needs a verified email");
    let _ = w.owner_id;
}

#[tokio::test]
async fn verification_level_low_without_smtp_lets_unverified_accounts_talk() {
    let w = World::with_app(TestApp::with_config(|config| config.accounts.mail = vokko_server::account::config::MailConfig::Log).await).await;
    let (status, _) = w.app.patch(&w.path(""), &w.owner, json!({"verification_level": 1})).await;
    assert_eq!(status, StatusCode::OK);
    let (member, _) = w.member("unverified").await;
    let (status, body) = w.app.post(&format!("/channels/{}/messages", w.channel), &member, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, guild) = w.app.get(&w.path(""), &member).await;
    assert_eq!(guild["verification_level"], 1);
    let (status, _) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let _ = w.owner_id;
}

#[tokio::test]
async fn access_settings_age_restriction_and_rules_channel() {
    let w = World::new().await;
    let (member, _) = w.member("plain").await;
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!((guild["nsfw_level"].clone(), guild["rules_channel_id"].clone()), (json!(0), Value::Null));

    let (_, rules) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "rules", "type": 0})).await;
    let (_, voice) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "Lounge", "type": 2})).await;
    let (_, other_guild) = w.app.post("/guilds", &w.owner, json!({"name": "Elsewhere"})).await;
    let (_, foreign) = w.app.post(&format!("/guilds/{}/channels", other_guild["id"].as_str().expect("id")), &w.owner, json!({"name": "x", "type": 0})).await;

    // Discord's staff ratings (1 explicit, 2 safe) are not settable, nor are other kinds of channel or another guild's channel.
    for (body, field) in [
        (json!({"name": "Not applied", "nsfw_level": 1}), "nsfw_level"),
        (json!({"name": "Not applied", "nsfw_level": 2}), "nsfw_level"),
        (json!({"name": "Not applied", "rules_channel_id": voice["id"]}), "rules_channel_id"),
        (json!({"name": "Not applied", "rules_channel_id": foreign["id"]}), "rules_channel_id"),
    ] {
        let (status, error) = w.app.patch(&w.path(""), &w.owner, body.clone()).await;
        assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, 50035), "{body}: {error}");
        assert!(error["errors"][field].is_object(), "{error}");
    }
    let (status, _) = w.app.patch(&w.path(""), &member, json!({"nsfw_level": 3})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "needs MANAGE_GUILD");
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!((guild["name"].clone(), guild["nsfw_level"].clone()), (json!("Test guild"), json!(0)), "a refused request changes nothing");

    let (status, guild) = w.app.patch(&w.path(""), &w.owner, json!({"nsfw_level": 3, "rules_channel_id": rules["id"]})).await;
    assert_eq!((status, guild["nsfw_level"].clone(), guild["rules_channel_id"].clone()), (StatusCode::OK, json!(3), rules["id"].clone()));
    let (_, seen) = w.app.get(&w.path(""), &member).await;
    assert_eq!((seen["nsfw_level"].clone(), seen["rules_channel_id"].clone()), (json!(3), rules["id"].clone()));
    let changes = &w.audit("?action_type=1").await[0]["changes"];
    assert_eq!(changes, &json!([{"key": "rules_channel_id", "new_value": rules["id"]}, {"key": "nsfw_level", "old_value": 0, "new_value": 3}]));

    // A missing key leaves it alone; null clears the rules channel; deleting the channel clears it too.
    let (_, guild) = w.app.patch(&w.path(""), &w.owner, json!({"name": "Still"})).await;
    assert_eq!((guild["nsfw_level"].clone(), guild["rules_channel_id"].clone()), (json!(3), rules["id"].clone()));
    let (_, guild) = w.app.patch(&w.path(""), &w.owner, json!({"rules_channel_id": null, "nsfw_level": 0})).await;
    assert_eq!((guild["nsfw_level"].clone(), guild["rules_channel_id"].clone()), (json!(0), Value::Null));
    w.app.patch(&w.path(""), &w.owner, json!({"rules_channel_id": rules["id"]})).await;
    let address = w.app.serve().await;
    let mut member_ws = Client::connect(&address, &member).await;
    let (status, _) = w.app.delete(&format!("/channels/{}", rules["id"].as_str().expect("id")), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member_ws.wait_for("GUILD_UPDATE").await["rules_channel_id"], Value::Null, "members learn it was cleared");
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!(guild["rules_channel_id"], Value::Null);
}

#[tokio::test]
async fn community_needs_channels_and_safety_checks() {
    let w = World::new().await;
    let (member, _) = w.member("plain").await;
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!((guild["features"].clone(), guild["public_updates_channel_id"].clone()), (json!([]), Value::Null));
    let (_, rules) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "rules", "type": 0})).await;
    let (_, updates) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "updates", "type": 0})).await;
    let (_, voice) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "Lounge", "type": 2})).await;

    let (status, _) = w.app.patch(&w.path(""), &member, json!({"features": ["COMMUNITY"]})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "needs MANAGE_GUILD");
    // Other features are not client-settable, the updates channel must be a text channel, and each missing prerequisite is named.
    for (body, field) in [
        (json!({"features": ["DISCOVERABLE"]}), "features"),
        (json!({"public_updates_channel_id": voice["id"]}), "public_updates_channel_id"),
        (json!({"features": ["COMMUNITY"]}), "rules_channel_id"),
        (json!({"features": ["COMMUNITY"], "rules_channel_id": rules["id"]}), "public_updates_channel_id"),
        (json!({"features": ["COMMUNITY"], "rules_channel_id": rules["id"], "public_updates_channel_id": updates["id"]}), "verification_level"),
        (
            json!({"features": ["COMMUNITY"], "rules_channel_id": rules["id"], "public_updates_channel_id": updates["id"], "verification_level": 1}),
            "explicit_content_filter",
        ),
    ] {
        let (status, error) = w.app.patch(&w.path(""), &w.owner, body.clone()).await;
        assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, 50035), "{body}: {error}");
        assert!(error["errors"][field].is_object(), "{body}: {error}");
    }
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!((guild["features"].clone(), guild["rules_channel_id"].clone()), (json!([]), Value::Null), "a refused request changes nothing");

    let address = w.app.serve().await;
    let mut member_ws = Client::connect(&address, &member).await;
    let enable = json!({"features": ["COMMUNITY"], "rules_channel_id": rules["id"], "public_updates_channel_id": updates["id"], "verification_level": 1, "explicit_content_filter": 2});
    let (status, guild) = w.app.patch(&w.path(""), &w.owner, enable).await;
    assert_eq!((status, guild["features"].clone(), guild["public_updates_channel_id"].clone()), (StatusCode::OK, json!(["COMMUNITY"]), updates["id"].clone()));
    assert_eq!(member_ws.wait_for("GUILD_UPDATE").await["features"], json!(["COMMUNITY"]));
    let changes = &w.audit("?action_type=1").await[0]["changes"];
    assert!(changes.as_array().expect("changes").iter().any(|c| c["key"] == "features"), "{changes}");

    // While on, the prerequisites can't be taken away; unrelated edits are fine.
    let (status, _) = w.app.patch(&w.path(""), &w.owner, json!({"rules_channel_id": null})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = w.app.patch(&w.path(""), &w.owner, json!({"explicit_content_filter": 0})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, guild) = w.app.patch(&w.path(""), &w.owner, json!({"name": "Renamed"})).await;
    assert_eq!((status, guild["features"].clone()), (StatusCode::OK, json!(["COMMUNITY"])));

    // While on, the rules and updates channels can't be deleted (Discord's 50074).
    for channel in [&rules, &updates] {
        let (status, error) = w.app.delete(&format!("/channels/{}", channel["id"].as_str().expect("id")), &w.owner).await;
        assert_eq!((status, code(&error)), (StatusCode::BAD_REQUEST, 50074), "{error}");
    }
    // Disabling keeps the channels; then deleting the updates channel clears it.
    let (status, guild) = w.app.patch(&w.path(""), &w.owner, json!({"features": []})).await;
    assert_eq!((status, guild["features"].clone(), guild["rules_channel_id"].clone()), (StatusCode::OK, json!([]), rules["id"].clone()));
    let (status, _) = w.app.delete(&format!("/channels/{}", updates["id"].as_str().expect("id")), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    assert_eq!(guild["public_updates_channel_id"], Value::Null);
}

#[tokio::test]
async fn automod_mention_spam_blocks_alerts_and_times_out() {
    let w = World::new().await;
    let (member, member_id) = w.member("pinger").await;
    let rules = w.path("/auto-moderation/rules");
    let messages = format!("/channels/{}/messages", w.channel);
    let (status, alerts) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "mod-log", "type": 0})).await;
    assert_eq!(status, StatusCode::OK, "{alerts}");
    let alerts = alerts["id"].as_str().expect("id").to_owned();

    let body = |limit: Value| {
        json!({
            "name": "Mentions", "event_type": 1, "trigger_type": 5, "trigger_metadata": {"mention_total_limit": limit},
            "actions": [{"type": 1}, {"type": 2, "metadata": {"channel_id": alerts}}, {"type": 3, "metadata": {"duration_seconds": 60}}]
        })
    };
    for bad in [json!(0), json!(51), Value::Null] {
        let (status, rule) = w.app.post(&rules, &w.owner, body(bad.clone())).await;
        assert_eq!((status, code(&rule)), (StatusCode::BAD_REQUEST, 50035), "limit {bad}");
    }
    let mut no_channel = body(json!(2));
    no_channel["actions"][1]["metadata"]["channel_id"] = json!("12345");
    let (status, rule) = w.app.post(&rules, &w.owner, no_channel).await;
    assert_eq!((status, code(&rule)), (StatusCode::BAD_REQUEST, 50035), "the alert channel must be in the guild");
    let (status, rule) = w.app.post(&rules, &w.owner, body(json!(2))).await;
    assert_eq!(status, StatusCode::OK, "{rule}");
    assert_eq!(rule["trigger_metadata"]["mention_total_limit"], 2);
    assert_eq!(rule["actions"].as_array().expect("actions").len(), 3);
    let (status, again) = w.app.post(&rules, &w.owner, body(json!(3))).await;
    assert_eq!((status, code(&again)), (StatusCode::BAD_REQUEST, 30035), "one mention spam rule per server");

    let (_, a) = w.app.register("alpha").await;
    let (_, b) = w.app.register("bravo").await;
    let mention = |user: &Value| format!("<@{}>", user["id"].as_str().expect("id"));
    let two = format!("hi {} {} {}", mention(&a), mention(&b), mention(&a));
    let (status, _) = w.app.post(&messages, &member, json!({"content": two})).await;
    assert_eq!(status, StatusCode::OK, "a repeated mention counts once");
    let three = format!("{two} <@&{}>", w.guild);
    let (status, blocked) = w.app.post(&messages, &member, json!({"content": three})).await;
    assert_eq!((status, code(&blocked)), (StatusCode::BAD_REQUEST, 200000), "{blocked}");

    let (_, list) = w.app.get(&format!("/channels/{alerts}/messages"), &w.owner).await;
    let alert = &list[0];
    assert_eq!((alert["type"].clone(), alert["author"]["id"].clone()), (json!(24), json!(member_id)));
    assert_eq!(alert["embeds"][0]["type"], "auto_moderation_message");
    assert_eq!(alert["embeds"][0]["description"], three.as_str());
    let field = |name: &str| alert["embeds"][0]["fields"].as_array().expect("fields").iter().find(|f| f["name"] == name).map(|f| f["value"].clone());
    assert_eq!(field("rule_name"), Some(json!("Mentions")));
    assert_eq!(field("channel_id"), Some(json!(w.channel)));
    assert_eq!(field("decision_outcome"), Some(json!("blocked")));
    let alert_path = format!("/channels/{alerts}/messages/{}", alert["id"].as_str().expect("id"));
    let (status, _) = w.app.delete(&alert_path, &member).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the flagged member cannot delete the alert");
    let (status, _) = w.app.patch(&alert_path, &member, json!({ "content": "nothing to see" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "nor edit it (a system message)");

    let (timed_out,): (bool,) = sqlx::query_as("SELECT timeout_until > now() + interval '50 seconds' FROM guild_members WHERE user_id = $1")
        .bind(member_id.parse::<i64>().expect("id"))
        .fetch_one(&w.app.state.db)
        .await
        .expect("member");
    assert!(timed_out, "a 60 second timeout");
    let (status, _) = w.app.post(&messages, &member, json!({"content": "hello"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a timed-out member cannot send");
    assert_eq!(w.audit("?action_type=143").await.len(), 1);
    assert_eq!(w.audit("?action_type=144").await.len(), 1);
    let timeouts = w.audit("?action_type=145").await;
    assert_eq!(timeouts[0]["options"]["auto_moderation_rule_trigger_type"], "5");

    // timeout only fits keyword and mention spam rules; a rule needs an action
    let timeout = json!({"name": "s", "event_type": 1, "trigger_type": 3, "actions": [{"type": 3, "metadata": {"duration_seconds": 60}}]});
    let (status, body) = w.app.post(&rules, &w.owner, timeout).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));
    let (status, body) = w.app.post(&rules, &w.owner, json!({"name": "s", "event_type": 1, "trigger_type": 3, "actions": []})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "at least one action");
}

#[tokio::test]
async fn automod_spam_blocks_the_third_copy_across_channels() {
    let w = World::new().await;
    let (member, _) = w.member("spammer").await;
    let rules = w.path("/auto-moderation/rules");
    let (_, other) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "other", "type": 0})).await;
    let other = format!("/channels/{}/messages", other["id"].as_str().expect("id"));
    let messages = format!("/channels/{}/messages", w.channel);
    let rule = json!({"name": "Spam", "event_type": 1, "trigger_type": 3, "actions": [{"type": 1, "metadata": {"custom_message": "Slow down"}}]});
    let (status, rule) = w.app.post(&rules, &w.owner, rule).await;
    assert_eq!(status, StatusCode::OK, "{rule}");

    let text = "Join my server at example.org";
    let (status, first) = w.app.post(&messages, &member, json!({"content": text})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = w.app.post(&other, &member, json!({"content": text.to_uppercase()})).await;
    assert_eq!(status, StatusCode::OK, "the second copy passes");
    let (status, body) = w.app.post(&messages, &member, json!({"content": format!("  {text} ")})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 200000), "the third copy within 30 s: {body}");
    assert_eq!(body["errors"]["content"]["_errors"][0]["message"], "Slow down");
    for _ in 0..3 {
        let (status, _) = w.app.post(&messages, &member, json!({"content": "ok"})).await;
        assert_eq!(status, StatusCode::OK, "short messages never count as spam");
    }
    let (status, _) = w.app.patch(&format!("{messages}/{}", first["id"].as_str().expect("id")), &member, json!({"content": text})).await;
    assert_eq!(status, StatusCode::OK, "an edit is no new copy");
    for _ in 0..3 {
        let (status, _) = w.app.post(&messages, &w.owner, json!({"content": text})).await;
        assert_eq!(status, StatusCode::OK, "managers are exempt");
    }
    let (status, body) = w.app.post(&rules, &w.owner, json!({"name": "Spam 2", "event_type": 1, "trigger_type": 3, "actions": [{"type": 1}]})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 30035), "one spam rule");
}

#[tokio::test]
async fn automod_keyword_presets_with_allow_list() {
    let w = World::new().await;
    let (member, _) = w.member("talker").await;
    let rules = w.path("/auto-moderation/rules");
    let messages = format!("/channels/{}/messages", w.channel);
    let rule = json!({
        "name": "Flagged words", "event_type": 1, "trigger_type": 4,
        "trigger_metadata": {"presets": [1, 1], "allow_list": ["bullshit"], "keyword_filter": ["ignored"]}, "actions": [{"type": 1}]
    });
    let (status, rule) = w.app.post(&rules, &w.owner, rule).await;
    assert_eq!(status, StatusCode::OK, "{rule}");
    assert_eq!(rule["trigger_metadata"], json!({"keyword_filter": [], "allow_list": ["bullshit"], "presets": [1]}));
    let rule_id = rule["id"].as_str().expect("id").to_owned();

    let (status, _) = w.app.post(&messages, &member, json!({"content": "oh SHIT"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "profanity");
    let (status, _) = w.app.post(&messages, &member, json!({"content": "that is bullshit"})).await;
    assert_eq!(status, StatusCode::OK, "allow list");
    let (status, _) = w.app.post(&messages, &member, json!({"content": "check out this porn"})).await;
    assert_eq!(status, StatusCode::OK, "sexual content is not on");
    let (status, rule) = w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"trigger_metadata": {"presets": [1, 2]}})).await;
    assert_eq!((status, rule["trigger_metadata"]["presets"].clone()), (StatusCode::OK, json!([1, 2])));
    let (status, _) = w.app.post(&messages, &member, json!({"content": "check out this porn"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "sexual content now on");
    let (status, body) = w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"trigger_type": 1})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "the type never changes");
    let (status, body) = w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"trigger_metadata": {"presets": [4]}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "unknown preset: {body}");
    let (status, body) = w.app.patch(&format!("{rules}/{rule_id}"), &w.owner, json!({"trigger_metadata": {"presets": []}})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "at least one category");
}

#[tokio::test]
async fn automod_spam_counts_parallel_sends_and_alerts_once_a_minute() {
    let w = World::new().await;
    let (member, _) = w.member("flooder").await;
    let (_, alerts) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "mod-log", "type": 0})).await;
    let alerts = alerts["id"].as_str().expect("id").to_owned();
    let actions = json!([{"type": 1}, {"type": 2, "metadata": {"channel_id": alerts}}]);
    let (status, rule) =
        w.app.post(&w.path("/auto-moderation/rules"), &w.owner, json!({"name": "Spam", "event_type": 1, "trigger_type": 3, "actions": actions})).await;
    assert_eq!(status, StatusCode::OK, "{rule}");

    let messages = format!("/channels/{}/messages", w.channel);
    let sends = (0..10).map(|_| w.app.post(&messages, &member, json!({"content": "Join my server at example.org"})));
    let statuses: Vec<StatusCode> = futures_util::future::join_all(sends).await.into_iter().map(|(status, _)| status).collect();
    assert_eq!(statuses.iter().filter(|status| **status == StatusCode::OK).count(), 2, "only two copies get through: {statuses:?}");

    let (_, list) = w.app.get(&format!("/channels/{alerts}/messages"), &w.owner).await;
    assert_eq!(list.as_array().expect("list").len(), 1, "eight blocks, one alert: {list}");
    assert_eq!(w.audit("?action_type=143").await.len(), 8);
    assert_eq!(w.audit("?action_type=144").await.len(), 1);

    // Deleting the alert channel takes the alert off the rule.
    let (status, _) = w.app.delete(&format!("/channels/{alerts}"), &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let (_, rule) = w.app.get(&w.path(&format!("/auto-moderation/rules/{}", rule["id"].as_str().expect("id"))), &w.owner).await;
    assert_eq!(rule["actions"], json!([{"type": 1}]), "{rule}");
}
