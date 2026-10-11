#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Kick, bans, member edits and role management, with the gateway events they emit.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const KICK: u64 = 1 << 1;
const BAN: u64 = 1 << 2;
const ADMIN: u64 = 1 << 3;
const MANAGE_NICKNAMES: u64 = 1 << 27;
const MANAGE_ROLES: u64 = 1 << 28;
const MODERATE: u64 = 1 << 40;

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.recv().await;
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        client.wait_for("READY").await;
        client
    }

    async fn recv(&mut self) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return serde_json::from_str(&text).expect("json frame"),
                Ok(Some(Ok(_))) => continue,
                Ok(_) => panic!("gateway closed"),
                Err(_) => panic!("timed out waiting for a gateway frame"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.recv().await;
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
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

    fn invite_path(invite: &Value) -> String {
        format!("/invites/{}", invite["code"].as_str().expect("code"))
    }

    /// Registers a user and joins them to the guild; returns (token, id).
    async fn member(&self, name: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.channel), &self.owner, json!({})).await;
        let (status, body) = self.app.post(&Self::invite_path(&invite), &token, json!({})).await;
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
}

fn code(body: &Value) -> u64 {
    body["code"].as_u64().unwrap_or(0)
}

#[tokio::test]
async fn kick_checks_hierarchy_and_notifies() {
    let w = World::new().await;
    let mod_role = w.role("mods", KICK).await;
    let high_role = w.role("high", 0).await;
    w.set_position(&high_role, 5).await;
    let (moderator, mod_id) = w.member("mod").await;
    let (victim, victim_id) = w.member("victim").await;
    let (_, high_id) = w.member("high").await;
    let (plain, _) = w.member("plain").await;
    let (outsider, _) = w.app.register("outsider").await;
    w.give(&mod_id, &[&mod_role]).await;
    w.give(&high_id, &[&high_role]).await;

    let (status, body) = w.app.delete(&w.path(&format!("/members/{high_id}")), &moderator).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "above the actor");
    let (status, body) = w.app.delete(&w.path(&format!("/members/{}", w.owner_id)), &moderator).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "owner is immune");
    let (status, _) = w.app.delete(&w.path(&format!("/members/{mod_id}")), &moderator).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "not oneself");
    let (status, body) = w.app.delete(&w.path(&format!("/members/{victim_id}")), &plain).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "no KICK_MEMBERS");
    let (status, body) = w.app.delete(&w.path(&format!("/members/{victim_id}")), &outsider).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50001), "cannot see the guild");

    let address = w.app.serve().await;
    let mut victim_ws = Client::connect(&address, &victim).await;
    let mut owner_ws = Client::connect(&address, &w.owner).await;
    let (status, _) = w.app.delete(&w.path(&format!("/members/{victim_id}")), &moderator).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(victim_ws.wait_for("GUILD_DELETE").await["id"], w.guild.as_str());
    assert_eq!(owner_ws.wait_for("GUILD_MEMBER_REMOVE").await["user"]["id"], victim_id.as_str());
    let (status, _) = w.app.get(&w.path(""), &victim).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = w.app.delete(&w.path(&format!("/members/{victim_id}")), &moderator).await;
    assert_eq!((status, code(&body)), (StatusCode::NOT_FOUND, 10007));
}

#[tokio::test]
async fn bans_list_unban_and_block_invites() {
    let w = World::new().await;
    let ban_role = w.role("bans", BAN).await;
    let (moderator, mod_id) = w.member("mod").await;
    let (target, target_id) = w.member("target").await;
    let (plain, _) = w.member("plain").await;
    let (outsider, outsider_user) = w.app.register("outsider").await;
    let outsider_id = outsider_user["id"].as_str().expect("id").to_owned();
    w.give(&mod_id, &[&ban_role]).await;

    let (status, body) = w.app.get(&w.path("/bans"), &plain).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, body) = w.app.get(&w.path("/bans"), &outsider).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50001));
    let (status, body) = w.app.put_json(&w.path(&format!("/bans/{}", w.owner_id)), &moderator, json!({})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "owner");
    let (status, _) = w.app.put_json(&w.path(&format!("/bans/{mod_id}")), &moderator, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "self");
    let (status, body) = w.app.put_json(&w.path(&format!("/bans/{target_id}")), &moderator, json!({"delete_message_seconds": 999_999})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));

    // the target posts, then is banned with message deletion
    let (_, message) = w.app.post(&format!("/channels/{}/messages", w.channel), &target, json!({"content": "spam"})).await;
    let address = w.app.serve().await;
    let mut owner_ws = Client::connect(&address, &w.owner).await;
    let (status, _) = w.app.put_json(&w.path(&format!("/bans/{target_id}")), &moderator, json!({"reason": "spam", "delete_message_seconds": 3600})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(owner_ws.wait_for("GUILD_BAN_ADD").await["user"]["id"], target_id.as_str());
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", w.channel), &w.owner).await;
    assert!(messages.as_array().expect("messages").iter().all(|m| m["id"] != message["id"]), "messages deleted");
    let (status, _) = w.app.get(&w.path(""), &target).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no longer a member");

    let (status, bans) = w.app.get(&w.path("/bans"), &moderator).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bans.as_array().expect("bans").len(), 1);
    assert_eq!(bans[0]["user"]["id"], target_id.as_str());
    assert_eq!(bans[0]["reason"], "spam");

    // banned users cannot rejoin
    let (_, invite) = w.app.post(&format!("/channels/{}/invites", w.channel), &w.owner, json!({})).await;
    let invite_path = World::invite_path(&invite);
    let (status, body) = w.app.post(&invite_path, &target, json!({})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 40007));

    // banning a non-member works
    let (status, _) = w.app.put_json(&w.path(&format!("/bans/{outsider_id}")), &moderator, json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = w.app.post(&invite_path, &outsider, json!({})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 40007));
    let (_, bans) = w.app.get(&w.path("/bans"), &moderator).await;
    assert_eq!(bans.as_array().expect("bans").len(), 2);

    let (status, _) = w.app.delete(&w.path(&format!("/bans/{target_id}")), &moderator).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = w.app.delete(&w.path(&format!("/bans/{target_id}")), &moderator).await;
    assert_eq!((status, code(&body)), (StatusCode::NOT_FOUND, 10026));
    let (status, _) = w.app.post(&invite_path, &target, json!({})).await;
    assert_eq!(status, StatusCode::OK, "can rejoin after unban");
}

#[tokio::test]
async fn member_edits_nick_roles_timeout() {
    let w = World::new().await;
    let nick_role = w.role("nicks", MANAGE_NICKNAMES | MANAGE_ROLES | MODERATE).await;
    let low_role = w.role("low", 0).await;
    let high_role = w.role("high", 0).await;
    w.set_position(&high_role, 5).await;
    let (moderator, mod_id) = w.member("mod").await;
    let (_, target_id) = w.member("target").await;
    let (_, high_id) = w.member("high").await;
    let (plain, plain_id) = w.member("plain").await;
    w.give(&mod_id, &[&nick_role]).await;
    w.give(&high_id, &[&high_role]).await;
    let target_path = w.path(&format!("/members/{target_id}"));

    // nick
    let (status, member) = w.app.patch(&target_path, &moderator, json!({"nick": "  Tweety  "})).await;
    assert_eq!((status, member["nick"].clone()), (StatusCode::OK, json!("Tweety")), "{member}");
    assert!(member["communication_disabled_until"].is_null());
    let (_, member) = w.app.patch(&target_path, &moderator, json!({"nick": ""})).await;
    assert!(member["nick"].is_null());
    let (status, body) = w.app.patch(&target_path, &plain, json!({"nick": "x"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, body) = w.app.patch(&w.path(&format!("/members/{high_id}")), &moderator, json!({"nick": "x"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "target above");
    let (status, body) = w.app.patch(&target_path, &moderator, json!({"nick": "x".repeat(33)})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));
    let (status, _) = w.app.patch(&w.path("/members/999"), &moderator, json!({"nick": "x"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // @me
    let (status, member) = w.app.patch(&w.path("/members/@me"), &plain, json!({"nick": "Me"})).await;
    assert_eq!((status, member["nick"].clone()), (StatusCode::OK, json!("Me")), "{member}");
    assert_eq!(member["user"]["id"], plain_id.as_str());
    let (_, member) = w.app.patch(&w.path("/members/@me"), &plain, json!({"nick": null})).await;
    assert!(member["nick"].is_null());

    // roles
    let (status, member) = w.app.patch(&target_path, &moderator, json!({"roles": [low_role]})).await;
    assert_eq!((status, member["roles"].clone()), (StatusCode::OK, json!([low_role])), "{member}");
    let (status, body) = w.app.patch(&target_path, &moderator, json!({"roles": [low_role, high_role]})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "role above the actor");
    let (status, body) = w.app.patch(&target_path, &moderator, json!({"roles": [w.guild]})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "@everyone cannot be assigned");
    let (status, body) = w.app.patch(&target_path, &moderator, json!({"roles": ["424242"]})).await;
    assert_eq!((status, code(&body)), (StatusCode::NOT_FOUND, 10011));
    let (status, member) = w.app.patch(&target_path, &moderator, json!({"roles": []})).await;
    assert_eq!((status, member["roles"].clone()), (StatusCode::OK, json!([])));

    // timeout
    let in_days =
        |days: i64| (time::OffsetDateTime::now_utc() + time::Duration::days(days)).format(&time::format_description::well_known::Rfc3339).expect("fmt");
    let (status, member) = w.app.patch(&target_path, &moderator, json!({"communication_disabled_until": in_days(1)})).await;
    assert_eq!(status, StatusCode::OK, "{member}");
    assert!(member["communication_disabled_until"].is_string());
    let (status, body) = w.app.patch(&target_path, &moderator, json!({"communication_disabled_until": in_days(29)})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "over 28 days");
    let (status, body) = w.app.patch(&target_path, &plain, json!({"communication_disabled_until": in_days(1)})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, body) = w.app.patch(&w.path(&format!("/members/{}", w.owner_id)), &moderator, json!({"communication_disabled_until": in_days(1)})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "owner");
    let (status, body) = w.app.patch(&w.path(&format!("/members/{high_id}")), &moderator, json!({"communication_disabled_until": in_days(1)})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "hierarchy");
    let (status, member) = w.app.patch(&target_path, &moderator, json!({"communication_disabled_until": null})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(member["communication_disabled_until"].is_null());

    // administrators cannot be timed out
    let admin_role = w.role("admins", ADMIN).await;
    w.give(&target_id, &[&admin_role]).await;
    let (status, body) = w.app.patch(&target_path, &w.owner, json!({"communication_disabled_until": in_days(1)})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
}

#[tokio::test]
async fn role_edits_change_only_what_the_actor_may() {
    let w = World::new().await;
    let manage = w.role("managers", MANAGE_ROLES).await;
    let first = w.role("first", 0).await;
    let second = w.role("second", 0).await;
    let high = w.role("high", 0).await;
    w.set_position(&high, 5).await;
    let (manager, manager_id) = w.member("manager").await;
    let (_, target_id) = w.member("target").await;
    w.give(&manager_id, &[&manage]).await;
    w.give(&target_id, &[&first]).await;
    let target_path = w.path(&format!("/members/{target_id}"));
    let roles_of = |member: &Value| -> Vec<String> {
        let mut roles: Vec<String> = member["roles"].as_array().expect("roles").iter().map(|r| r.as_str().expect("id").to_owned()).collect();
        roles.sort();
        roles
    };
    let sorted = |mut roles: Vec<String>| {
        roles.sort();
        roles
    };

    // roles below the actor can be added and swapped
    let (status, member) = w.app.patch(&target_path, &manager, json!({"roles": [first, second]})).await;
    assert_eq!(status, StatusCode::OK, "{member}");
    assert_eq!(roles_of(&member), sorted(vec![first.clone(), second.clone()]));
    let (status, member) = w.app.patch(&target_path, &manager, json!({"roles": [second]})).await;
    assert_eq!((status, roles_of(&member)), (StatusCode::OK, vec![second.clone()]), "{member}");
    // a role above the actor is refused as a whole: nothing of the request is applied
    let (status, body) = w.app.patch(&target_path, &manager, json!({"roles": [first, high]})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    let stored = members.as_array().expect("members").iter().find(|m| m["user"]["id"] == target_id.as_str()).expect("target").clone();
    assert_eq!(roles_of(&stored), vec![second]);
}

#[tokio::test]
async fn timeouts_survive_leaving_and_being_kicked() {
    let w = World::new().await;
    let (token, user_id) = w.member("sleeper").await;
    let (_, invite) = w.app.post(&format!("/channels/{}/invites", w.channel), &w.owner, json!({})).await;
    let invite_path = World::invite_path(&invite);
    let member_path = w.path(&format!("/members/{user_id}"));
    let messages = format!("/channels/{}/messages", w.channel);
    let until = (time::OffsetDateTime::now_utc() + time::Duration::days(1)).format(&time::format_description::well_known::Rfc3339).expect("fmt");
    let (status, member) = w.app.patch(&member_path, &w.owner, json!({"communication_disabled_until": until})).await;
    assert_eq!(status, StatusCode::OK, "{member}");
    let set = member["communication_disabled_until"].clone();
    assert!(set.is_string());

    let address = w.app.serve().await;
    let mut owner_ws = Client::connect(&address, &w.owner).await;
    let member_until = |members: &Value| {
        members.as_array().expect("members").iter().find(|m| m["user"]["id"] == user_id.as_str()).expect("member")["communication_disabled_until"].clone()
    };

    // leave and come back: still timed out, in the add event and in the member list
    assert_eq!(w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &token).await.0, StatusCode::NO_CONTENT);
    let (status, body) = w.app.post(&invite_path, &token, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(owner_ws.wait_for("GUILD_MEMBER_ADD").await["communication_disabled_until"], set);
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert_eq!(member_until(&members), set);
    assert_eq!(w.app.post(&messages, &token, json!({"content": "hi"})).await.0, StatusCode::FORBIDDEN, "still muted");

    // kicked and back: same
    assert_eq!(w.app.delete(&member_path, &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&invite_path, &token, json!({})).await.0, StatusCode::OK);
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert_eq!(member_until(&members), set);

    // a cleared timeout stays cleared, and a stored one that ran out is not restored
    assert_eq!(w.app.patch(&member_path, &w.owner, json!({"communication_disabled_until": null})).await.0, StatusCode::OK);
    assert_eq!(w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&invite_path, &token, json!({})).await.0, StatusCode::OK);
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert!(member_until(&members).is_null());
    assert_eq!(w.app.patch(&member_path, &w.owner, json!({"communication_disabled_until": until})).await.0, StatusCode::OK);
    assert_eq!(w.app.delete(&member_path, &w.owner).await.0, StatusCode::NO_CONTENT);
    sqlx::query("UPDATE guild_timeouts SET until = now() - interval '1 minute'").execute(&w.app.state.db).await.expect("expire");
    assert_eq!(w.app.post(&invite_path, &token, json!({})).await.0, StatusCode::OK);
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert!(member_until(&members).is_null());

    // a ban removes the member and drops the stored timeout: unbanned and back, they are free
    assert_eq!(w.app.patch(&member_path, &w.owner, json!({"communication_disabled_until": until})).await.0, StatusCode::OK);
    assert_eq!(w.app.put_json(&w.path(&format!("/bans/{user_id}")), &w.owner, json!({})).await.0, StatusCode::NO_CONTENT);
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert!(members.as_array().expect("members").iter().all(|m| m["user"]["id"] != user_id.as_str()), "banned member is gone");
    let (stored,): (i64,) = sqlx::query_as("SELECT count(*) FROM guild_timeouts").fetch_one(&w.app.state.db).await.expect("count");
    assert_eq!(stored, 0);
    assert_eq!(w.app.delete(&w.path(&format!("/bans/{user_id}")), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&invite_path, &token, json!({})).await.0, StatusCode::OK);
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert!(member_until(&members).is_null());
}

#[tokio::test]
async fn role_lifecycle_and_limits() {
    let w = World::new().await;
    let manage = w.role("manager", MANAGE_ROLES | KICK).await;
    let (manager, manager_id) = w.member("manager").await;
    let (plain, _) = w.member("plain").await;
    let (outsider, _) = w.app.register("outsider").await;
    w.give(&manager_id, &[&manage]).await;
    let roles_path = w.path("/roles");

    // access checks
    let (status, body) = w.app.post(&roles_path, &plain, json!({"name": "x"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, body) = w.app.post(&roles_path, &outsider, json!({"name": "x"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50001));

    // defaults: name, @everyone's permissions, position just above @everyone
    let (_, guild) = w.app.get(&w.path(""), &w.owner).await;
    let everyone = guild["roles"].as_array().expect("roles").iter().find(|r| r["id"] == w.guild.as_str()).expect("@everyone").clone();
    let (status, role) = w.app.post(&roles_path, &manager, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{role}");
    assert_eq!(role["name"], "new role");
    assert_eq!(role["permissions"], everyone["permissions"]);
    assert_eq!(role["position"], 1);
    assert_eq!(role["hoist"], false);
    assert_eq!(role["color"], 0);
    let role_id = role["id"].as_str().expect("id").to_owned();

    // cannot grant bits the actor lacks, administrator included
    let (status, body) = w.app.post(&roles_path, &manager, json!({"name": "grab", "permissions": BAN.to_string()})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, body) = w.app.post(&roles_path, &manager, json!({"name": "grab", "permissions": ADMIN.to_string()})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, _) = w.app.post(&roles_path, &manager, json!({"name": "ok", "permissions": KICK.to_string()})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = w.app.post(&roles_path, &manager, json!({"name": "bad", "permissions": "abc"})).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035));

    // patch
    let (status, edited) =
        w.app.patch(&format!("{roles_path}/{role_id}"), &manager, json!({"name": "Helpers", "color": 255, "hoist": true, "mentionable": true})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!((edited["name"].clone(), edited["color"].clone(), edited["hoist"].clone()), (json!("Helpers"), json!(255), json!(true)));
    let (status, body) = w.app.patch(&format!("{roles_path}/{role_id}"), &manager, json!({"permissions": BAN.to_string()})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    let (status, body) = w.app.patch(&format!("{roles_path}/{manage}"), &manager, json!({"name": "mine"})).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "own highest role");
    let (status, body) = w.app.patch(&format!("{roles_path}/777"), &manager, json!({"name": "x"})).await;
    assert_eq!((status, code(&body)), (StatusCode::NOT_FOUND, 10011));

    // @everyone: permissions only
    let (status, edited) = w.app.patch(&format!("{roles_path}/{}", w.guild), &w.owner, json!({"name": "renamed", "permissions": "1024"})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["name"], "@everyone");
    assert_eq!(edited["permissions"], "1024");

    // positions: strictly below the actor's highest, returns every role in order
    let (_, top) = w.app.post(&roles_path, &w.owner, json!({"name": "top"})).await;
    let top_id = top["id"].as_str().expect("id").to_owned();
    let (status, all) = w.app.patch(&roles_path, &w.owner, json!([{"id": top_id, "position": 9}])).await;
    assert_eq!(status, StatusCode::OK, "{all}");
    let all = all.as_array().expect("roles");
    assert_eq!(all.len(), 5, "@everyone, manager, helpers, ok, top");
    let positions: Vec<i64> = all.iter().map(|r| r["position"].as_i64().expect("pos")).collect();
    assert!(positions.windows(2).all(|pair| pair[0] <= pair[1]), "ordered by position: {positions:?}");
    let (status, body) = w.app.patch(&roles_path, &manager, json!([{"id": top_id, "position": 1}])).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "role above the actor");
    let (status, body) = w.app.patch(&roles_path, &manager, json!([{"id": role_id, "position": 9}])).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013), "target position at or above the actor");
    let (status, body) = w.app.patch(&roles_path, &w.owner, json!([{"id": w.guild, "position": 3}])).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50035), "@everyone is fixed");

    // delete
    let (status, body) = w.app.delete(&format!("{roles_path}/{}", w.guild), &w.owner).await;
    assert_eq!((status, code(&body)), (StatusCode::BAD_REQUEST, 50028));
    let (status, body) = w.app.delete(&format!("{roles_path}/{top_id}"), &manager).await;
    assert_eq!((status, code(&body)), (StatusCode::FORBIDDEN, 50013));
    w.give(&manager_id, &[&manage, &role_id]).await;
    let address = w.app.serve().await;
    let mut ws = Client::connect(&address, &plain).await;
    let (status, _) = w.app.delete(&format!("{roles_path}/{role_id}"), &manager).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(ws.wait_for("GUILD_ROLE_DELETE").await["role_id"], role_id.as_str());
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    let manager_member = members.as_array().expect("members").iter().find(|m| m["user"]["id"] == manager_id.as_str()).expect("manager");
    assert_eq!(manager_member["roles"], json!([manage]), "deleted role is dropped from members");
}

#[tokio::test]
async fn role_events_reach_members() {
    let w = World::new().await;
    let (member, _) = w.member("watcher").await;
    let address = w.app.serve().await;
    let mut ws = Client::connect(&address, &member).await;
    let (_, role) = w.app.post(&w.path("/roles"), &w.owner, json!({"name": "events"})).await;
    let created = ws.wait_for("GUILD_ROLE_CREATE").await;
    assert_eq!(created["role"]["id"], role["id"]);
    w.app.patch(&format!("/guilds/{}/roles/{}", w.guild, role["id"].as_str().expect("id")), &w.owner, json!({"name": "renamed"})).await;
    let updated = ws.wait_for("GUILD_ROLE_UPDATE").await;
    assert_eq!(updated["role"]["name"], "renamed");
}

#[tokio::test]
async fn joining_posts_a_user_join_message() {
    let w = World::new().await;
    let (joiner, joiner_id) = w.member("joiner").await;
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", w.channel), &joiner).await;
    let join = messages.as_array().expect("messages").iter().find(|m| m["type"] == 7).expect("a UserJoin message");
    assert_eq!(join["author"]["id"], joiner_id.as_str());
    assert_eq!(join["content"], "");
}
