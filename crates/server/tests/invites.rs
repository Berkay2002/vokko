#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

/// MANAGE_CHANNELS and MANAGE_GUILD (Discord bits).
const MANAGE_CHANNELS: u64 = 1 << 4;
const MANAGE_GUILD: u64 = 1 << 5;

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> (Self, Value) {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        let hello = client.next().await;
        assert_eq!(hello["op"], 10);
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        let ready = client.wait_for("READY").await;
        (client, ready)
    }

    async fn next(&mut self) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return serde_json::from_str(&text).expect("json frame"),
                Ok(Some(Ok(_))) => continue,
                other => panic!("gateway ended or timed out: {other:?}"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.next().await;
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    /// True if no dispatch named `name` arrives within `window`.
    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(text) = message {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == name {
                    return false;
                }
            }
        }
        true
    }
}

struct World {
    app: TestApp,
    owner: String,
    guild: String,
    general: String,
}

async fn world() -> World {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    World { app, owner, guild, general }
}

impl World {
    async fn invite(&self, token: &str, body: Value) -> Value {
        let (status, invite) = self.app.post(&format!("/channels/{}/invites", self.general), token, body).await;
        assert_eq!(status, StatusCode::OK, "create invite: {invite}");
        invite
    }

    async fn join(&self, name: &str) -> String {
        let (token, _) = self.app.register(name).await;
        let invite = self.invite(&self.owner, json!({"unique": true})).await;
        assert_eq!(self.app.post(&format!("/invites/{}", code(&invite)), &token, json!({})).await.0, StatusCode::OK);
        token
    }

    async fn member_count(&self) -> usize {
        self.app.get(&format!("/guilds/{}/members", self.guild), &self.owner).await.1.as_array().expect("members").len()
    }

    /// A role with `permissions` given to the member behind `token`.
    async fn grant(&self, token: &str, permissions: u64) {
        let (_, me) = self.app.get("/users/@me", token).await;
        let (status, role) =
            self.app.post(&format!("/guilds/{}/roles", self.guild), &self.owner, json!({"name": "mods", "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "role: {role}");
        let path = format!("/guilds/{}/members/{}", self.guild, me["id"].as_str().expect("id"));
        assert_eq!(self.app.patch(&path, &self.owner, json!({"roles": [role["id"]]})).await.0, StatusCode::OK);
    }
}

fn code(invite: &Value) -> String {
    invite["code"].as_str().expect("code").to_owned()
}

fn codes(list: &Value) -> Vec<String> {
    list.as_array().expect("invite list").iter().map(code).collect()
}

#[tokio::test]
async fn create_options_are_validated_reused_and_reported() {
    let w = world().await;
    let invite = w.invite(&w.owner, json!({"max_age": 1800, "max_uses": 5, "temporary": true})).await;
    assert_eq!(
        (invite["max_age"].clone(), invite["max_uses"].clone(), invite["uses"].clone(), invite["temporary"].clone()),
        (json!(1800), json!(5), json!(0), json!(true))
    );
    assert_eq!(invite["inviter"]["username"], "sam");
    assert!(invite["created_at"].is_string() && invite["expires_at"].is_string());

    // Same settings without `unique`: the live invite comes back; `unique` or other settings make a new one.
    assert_eq!(code(&w.invite(&w.owner, json!({"max_age": 1800, "max_uses": 5, "temporary": true})).await), code(&invite));
    assert_ne!(code(&w.invite(&w.owner, json!({"max_age": 1800, "max_uses": 5, "temporary": true, "unique": true})).await), code(&invite));
    assert_ne!(code(&w.invite(&w.owner, json!({"max_age": 1800, "max_uses": 10, "temporary": true})).await), code(&invite));

    let never = w.invite(&w.owner, json!({"max_age": 0, "max_uses": 0})).await;
    assert_eq!(never["expires_at"], Value::Null);
    let default = w.invite(&w.owner, json!({})).await;
    assert_eq!((default["max_age"].clone(), default["temporary"].clone()), (json!(86400), json!(false)));

    for body in [json!({"max_age": 604_801}), json!({"max_uses": 101})] {
        let (status, error) = w.app.post(&format!("/channels/{}/invites", w.general), &w.owner, body.clone()).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{body}");
    }

    // A category leads nowhere: no invites.
    let (_, category) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "stuff", "type": 4})).await;
    let category = category["id"].as_str().expect("category id").to_owned();
    let (status, error) = w.app.post(&format!("/channels/{category}/invites"), &w.owner, json!({})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
}

#[tokio::test]
async fn expired_invites_are_gone_everywhere() {
    let w = world().await;
    let (alice, _) = w.app.register("alice").await;
    let invite = w.invite(&w.owner, json!({"max_age": 1800})).await;
    let code = code(&invite);
    assert_eq!(w.app.get(&format!("/invites/{code}"), &alice).await.0, StatusCode::OK);
    sqlx::query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1").bind(&code).execute(&w.app.state.db).await.expect("expire");

    let (status, error) = w.app.get(&format!("/invites/{code}"), &alice).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10006)));
    assert_eq!(w.app.post(&format!("/invites/{code}"), &alice, json!({})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.delete(&format!("/invites/{code}"), &w.owner).await.0, StatusCode::NOT_FOUND);
    assert!(!codes(&w.app.get(&format!("/guilds/{}/invites", w.guild), &w.owner).await.1).contains(&code));
    assert!(!codes(&w.app.get(&format!("/channels/{}/invites", w.general), &w.owner).await.1).contains(&code));
    assert_eq!(w.member_count().await, 1);
    // Reuse never hands out the expired one.
    let fresh = w.invite(&w.owner, json!({"max_age": 1800})).await;
    assert_ne!(fresh["code"].as_str(), Some(code.as_str()));
}

#[tokio::test]
async fn concurrent_accepts_never_exceed_max_uses() {
    let w = world().await;
    let invite = w.invite(&w.owner, json!({"max_uses": 3})).await;
    let code = code(&invite);
    let mut tokens = Vec::new();
    for index in 0..10 {
        tokens.push(w.app.register(&format!("racer{index}")).await.0);
    }
    let path = format!("/invites/{code}");
    let results = futures_util::future::join_all(tokens.iter().map(|token| w.app.post(&path, token, json!({})))).await;
    let joined = results.iter().filter(|(status, _)| *status == StatusCode::OK).count();
    assert_eq!(joined, 3, "exactly max_uses accepts win: {:?}", results.iter().map(|(status, _)| *status).collect::<Vec<_>>());
    assert!(results.iter().all(|(status, body)| *status == StatusCode::OK || body["code"] == 10006));
    assert_eq!(w.member_count().await, 4);
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = $1").bind(&code).fetch_one(&w.app.state.db).await.expect("uses");
    assert_eq!(uses, 3);
    // Used up: not listed.
    assert!(!codes(&w.app.get(&format!("/guilds/{}/invites", w.guild), &w.owner).await.1).contains(&code));
}

#[tokio::test]
async fn listing_and_revoking_follow_manage_guild_and_manage_channels() {
    let w = world().await;
    let alice = w.join("alice").await;
    let bob = w.join("bob").await;
    let (outsider, _) = w.app.register("carol").await;
    let mine = w.invite(&alice, json!({"max_uses": 1})).await;
    let guild_path = format!("/guilds/{}/invites", w.guild);
    let channel_path = format!("/channels/{}/invites", w.general);

    // A plain member: no lists, no revoking (even their own invite); an outsider is not a member at all.
    for path in [&guild_path, &channel_path] {
        let (status, error) = w.app.get(path, &alice).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)), "{path}");
        assert_eq!(w.app.get(path, &outsider).await.1["code"], 50001, "{path}");
    }
    assert_eq!(w.app.delete(&format!("/invites/{}", code(&mine)), &alice).await.1["code"], 50013);
    assert_eq!(w.app.delete(&format!("/invites/{}", code(&mine)), &outsider).await.1["code"], 50001);

    // The owner sees everything with inviter and uses, oldest first.
    let (_, listed) = w.app.get(&guild_path, &w.owner).await;
    let entry = listed.as_array().expect("list").iter().find(|invite| invite["code"] == mine["code"]).expect("alice's invite listed").clone();
    assert_eq!((entry["inviter"]["username"].clone(), entry["uses"].clone(), entry["max_uses"].clone()), (json!("alice"), json!(0), json!(1)));

    // MANAGE_CHANNELS: the channel list and revoking, not the guild list.
    w.grant(&bob, MANAGE_CHANNELS).await;
    assert_eq!(w.app.get(&channel_path, &bob).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&guild_path, &bob).await.1["code"], 50013);
    let (status, revoked) = w.app.delete(&format!("/invites/{}", code(&mine)), &bob).await;
    assert_eq!((status, revoked["code"].clone()), (StatusCode::OK, mine["code"].clone()));
    assert_eq!(w.app.get(&format!("/invites/{}", code(&mine)), &outsider).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.post(&format!("/invites/{}", code(&mine)), &outsider, json!({})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.delete(&format!("/invites/{}", code(&mine)), &bob).await.0, StatusCode::NOT_FOUND);

    // MANAGE_GUILD: the guild list and revoking.
    w.grant(&alice, MANAGE_GUILD).await;
    assert_eq!(w.app.get(&guild_path, &alice).await.0, StatusCode::OK);
    let other = w.invite(&w.owner, json!({"unique": true})).await;
    assert_eq!(w.app.delete(&format!("/invites/{}", code(&other)), &alice).await.0, StatusCode::OK);

    // Deleting the channel takes its invites with it.
    let invite = w.invite(&w.owner, json!({"unique": true})).await;
    assert_eq!(w.app.delete(&format!("/channels/{}", w.general), &w.owner).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&format!("/invites/{}", code(&invite)), &outsider).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invite_events_reach_managers_only() {
    let w = world().await;
    let address = w.app.serve().await;
    let alice = w.join("alice").await;
    let (mut owner, _) = Client::identify(&address, &w.owner).await;
    let (mut member, _) = Client::identify(&address, &alice).await;

    let invite = w.invite(&alice, json!({"max_age": 3600})).await;
    let created = owner.wait_for("INVITE_CREATE").await;
    assert_eq!(
        (created["code"].clone(), created["inviter"]["username"].clone(), created["max_age"].clone()),
        (invite["code"].clone(), json!("alice"), json!(3600))
    );
    assert_eq!(w.app.delete(&format!("/invites/{}", code(&invite)), &w.owner).await.0, StatusCode::OK);
    let deleted = owner.wait_for("INVITE_DELETE").await;
    assert_eq!(deleted, json!({"code": invite["code"], "guild_id": w.guild, "channel_id": w.general}));
    assert!(member.silent_for("INVITE_CREATE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn temporary_members_leave_with_their_last_connection_unless_given_a_role() {
    let w = world().await;
    let address = w.app.serve().await;
    let temporary = w.invite(&w.owner, json!({"temporary": true, "unique": true})).await;
    let (alice, _) = w.app.register("alice").await;
    let (bob, _) = w.app.register("bob").await;
    for token in [&alice, &bob] {
        assert_eq!(w.app.post(&format!("/invites/{}", code(&temporary)), token, json!({})).await.0, StatusCode::OK);
    }
    assert_eq!(w.member_count().await, 3);
    w.grant(&bob, 0).await;

    let (mut owner, _) = Client::identify(&address, &w.owner).await;
    let (alice_one, _) = Client::identify(&address, &alice).await;
    let (alice_two, _) = Client::identify(&address, &alice).await;
    let (bob_client, _) = Client::identify(&address, &bob).await;
    drop(alice_one);
    // One of two connections closed: still a member.
    assert!(owner.silent_for("GUILD_MEMBER_REMOVE", Duration::from_millis(300)).await);
    drop(alice_two);
    let removed = owner.wait_for("GUILD_MEMBER_REMOVE").await;
    assert_eq!(removed["user"]["username"], "alice");
    drop(bob_client);
    assert!(owner.silent_for("GUILD_MEMBER_REMOVE", Duration::from_millis(500)).await, "bob has a role and stays");
    assert_eq!(w.member_count().await, 2);

    // Re-joining through a normal invite makes the membership permanent.
    assert_eq!(w.app.post(&format!("/invites/{}", code(&temporary)), &alice, json!({})).await.0, StatusCode::OK);
    let normal = w.invite(&w.owner, json!({"unique": true})).await;
    assert_eq!(w.app.post(&format!("/invites/{}", code(&normal)), &alice, json!({})).await.0, StatusCode::OK);
    let (alice_again, _) = Client::identify(&address, &alice).await;
    drop(alice_again);
    assert!(owner.silent_for("GUILD_MEMBER_REMOVE", Duration::from_millis(500)).await);
    assert_eq!(w.member_count().await, 3);
}

#[tokio::test]
async fn user_guild_settings_round_trip_through_rest_ready_and_events() {
    let w = world().await;
    let address = w.app.serve().await;
    let path = format!("/users/@me/guilds/{}/settings", w.guild);
    let (_, empty) = w.app.get(&path, &w.owner).await;
    assert_eq!((empty["guild_id"].clone(), empty["message_notifications"].clone(), empty["channel_overrides"].clone()), (json!(w.guild), json!(3), json!([])));
    let (_, ready) = Client::identify(&address, &w.owner).await;
    assert_eq!(ready["user_guild_settings"], Value::Null, "omitted when nothing is saved");

    let (mut session, _) = Client::identify(&address, &w.owner).await;
    let body = json!({
        "muted": true, "mute_config": {"end_time": "2099-01-01T00:00:00Z"}, "message_notifications": 1, "flags": 2048, "suppress_everyone": true,
        "channel_overrides": {w.general.as_str(): {"muted": true, "mute_config": null, "message_notifications": 2}}
    });
    let (status, saved) = w.app.patch(&path, &w.owner, body).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["mute_config"], json!({"end_time": "2099-01-01T00:00:00Z"}));
    assert_eq!(
        saved["channel_overrides"],
        json!([{"channel_id": w.general, "muted": true, "mute_config": null, "message_notifications": 2, "flags": 0, "collapsed": false}])
    );
    assert_eq!(session.wait_for("USER_GUILD_SETTINGS_UPDATE").await, saved);

    // Overrides merge per channel; one back at the defaults is dropped; unmuting clears the mute config.
    let (_, other) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "other", "type": 0})).await;
    let other = other["id"].as_str().expect("id").to_owned();
    let (_, merged) = w.app.patch(&path, &w.owner, json!({"muted": false, "channel_overrides": {other.as_str(): {"message_notifications": 0}}})).await;
    assert_eq!((merged["muted"].clone(), merged["mute_config"].clone(), merged["suppress_everyone"].clone()), (json!(false), Value::Null, json!(true)));
    assert_eq!(merged["channel_overrides"].as_array().expect("overrides").len(), 2);
    let (_, dropped) = w.app.patch(&path, &w.owner, json!({"channel_overrides": {w.general.as_str(): {"muted": false, "message_notifications": 3}}})).await;
    assert_eq!(dropped["channel_overrides"].as_array().map(|o| o.iter().map(|e| e["channel_id"].clone()).collect::<Vec<_>>()), Some(vec![json!(other)]));

    // DMs live under @me; READY carries every saved entry.
    let (status, dms) = w.app.patch("/users/@me/guilds/@me/settings", &w.owner, json!({"suppress_roles": true})).await;
    assert_eq!((status, dms["guild_id"].clone()), (StatusCode::OK, Value::Null));
    let (_, ready) = Client::identify(&address, &w.owner).await;
    assert_eq!(ready["user_guild_settings"], json!([dms, dropped]));

    // Per user; non-members get 404; invalid input changes nothing.
    let (alice, _) = w.app.register("alice").await;
    assert_eq!(w.app.patch(&path, &alice, json!({"muted": true})).await.0, StatusCode::NOT_FOUND);
    for bad in [
        json!({"message_notifications": 4}),
        json!({"flags": 1}),
        json!({"mute_config": {"end_time": "soon"}}),
        json!({"channel_overrides": {"5": {"message_notifications": 9}}}),
    ] {
        assert_eq!(w.app.patch(&path, &w.owner, bad).await.0, StatusCode::BAD_REQUEST);
    }
    let too_many: serde_json::Map<String, Value> = (1..=501).map(|id| (id.to_string(), json!({"muted": true}))).collect();
    assert_eq!(w.app.patch(&path, &w.owner, json!({"channel_overrides": too_many})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.get(&path, &w.owner).await.1, dropped);
}

#[tokio::test]
async fn guild_layout_round_trip_through_rest_ready_and_events() {
    let w = world().await;
    let address = w.app.serve().await;
    let (_, empty) = w.app.get("/users/@me/guild-layout", &w.owner).await;
    assert_eq!(empty, json!({"guild_folders": [], "guild_positions": []}));

    let (mut session, _) = Client::identify(&address, &w.owner).await;
    let folders =
        json!([{"id": "7", "name": "  games  ", "color": 5793266, "guild_ids": [w.guild, "12"]}, {"id": "8", "name": "", "color": null, "guild_ids": ["13"]}]);
    let (status, saved) = w.app.patch("/users/@me/guild-layout", &w.owner, json!({"guild_folders": folders, "guild_positions": ["13", w.guild, "12"]})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let expected = json!({
        "guild_folders": [{"id": "7", "name": "games", "color": 5793266, "guild_ids": [w.guild, "12"]}, {"id": "8", "name": null, "color": null, "guild_ids": ["13"]}],
        "guild_positions": ["13", w.guild, "12"]
    });
    assert_eq!(saved, expected);
    assert_eq!(session.wait_for("GUILD_LAYOUT_UPDATE").await, expected);

    // Only sent keys change.
    let (_, positions_only) = w.app.patch("/users/@me/guild-layout", &w.owner, json!({"guild_positions": [w.guild]})).await;
    assert_eq!((positions_only["guild_folders"].clone(), positions_only["guild_positions"].clone()), (expected["guild_folders"].clone(), json!([w.guild])));
    let (_, ready) = Client::identify(&address, &w.owner).await;
    assert_eq!(ready["guild_layout"], positions_only);

    // Settings are per user.
    let (alice, _) = w.app.register("alice").await;
    assert_eq!(w.app.get("/users/@me/guild-layout", &alice).await.1["guild_folders"], json!([]));

    // Invalid input changes nothing.
    let long = "x".repeat(33);
    for body in [
        json!({"guild_positions": ["1", "1"]}),
        json!({"guild_folders": [{"id": "1", "name": null, "color": null, "guild_ids": []}]}),
        json!({"guild_folders": [{"id": "1", "name": long, "color": null, "guild_ids": ["2"]}]}),
        json!({"guild_folders": [{"id": "1", "name": null, "color": 16_777_216, "guild_ids": ["2"]}]}),
        json!({"guild_folders": [{"id": "1", "name": null, "color": null, "guild_ids": ["2"]}, {"id": "3", "name": null, "color": null, "guild_ids": ["2"]}]}),
        json!({"guild_folders": [{"id": "1", "name": null, "color": null, "guild_ids": ["2"]}, {"id": "1", "name": null, "color": null, "guild_ids": ["4"]}]}),
        json!({"guild_positions": (1..=1001).map(|id| id.to_string()).collect::<Vec<_>>()}),
        json!({"guild_folders": (0..6).map(|folder| json!({"id": (folder + 1).to_string(), "name": null, "color": null,
            "guild_ids": (0..200).map(|id| (10_000 + folder * 200 + id).to_string()).collect::<Vec<_>>()})).collect::<Vec<_>>()}),
    ] {
        let (status, error) = w.app.patch("/users/@me/guild-layout", &w.owner, body.clone()).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{body}");
    }
    assert_eq!(w.app.get("/users/@me/guild-layout", &w.owner).await.1, positions_only);
}

#[tokio::test]
async fn signed_out_callers_see_the_public_invite_card() {
    let w = world().await;
    let address = w.app.serve().await;
    let alice = w.join("alice").await;
    let invite = w.invite(&w.owner, json!({"max_age": 1800})).await;
    let path = format!("/invites/{}", code(&invite));
    let (status, signed_in) = w.app.get(&path, &w.owner).await;
    assert_eq!(status, StatusCode::OK);
    let (status, anonymous) = w.app.send(Method::GET, &path, None, None).await;
    assert_eq!(status, StatusCode::OK, "{anonymous}");
    // The same public card either way: the inviter and counts, no uses, member list or permissions.
    assert_eq!(anonymous, signed_in);
    let mut keys: Vec<&str> = anonymous.as_object().expect("invite").keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["channel", "code", "expires_at", "guild", "inviter"]);
    assert_eq!(anonymous["inviter"]["username"], "sam");
    let mut guild_keys: Vec<&str> = anonymous["guild"].as_object().expect("guild").keys().map(String::as_str).collect();
    guild_keys.sort_unstable();
    assert_eq!(guild_keys, ["icon", "id", "join_mode", "member_count", "name", "presence_count"]);
    assert_eq!((anonymous["guild"]["id"].as_str(), anonymous["guild"]["member_count"].clone()), (Some(w.guild.as_str()), json!(2)));
    assert_eq!(anonymous["guild"]["presence_count"], 0);
    // Online counts members with a live gateway connection.
    let (_alice_ws, _) = Client::identify(&address, &alice).await;
    assert_eq!(w.app.send(Method::GET, &path, None, None).await.1["guild"]["presence_count"], 1);
    assert_eq!(anonymous["channel"]["name"], "general");

    // A token that no longer works is still 401 (sign in again), not the signed-out view.
    assert_eq!(w.app.send(Method::GET, &path, Some("not-a-token"), None).await.0, StatusCode::UNAUTHORIZED);

    sqlx::query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1")
        .bind(code(&invite))
        .execute(&w.app.state.db)
        .await
        .expect("expire");
    let (status, error) = w.app.send(Method::GET, &path, None, None).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10006)));
    let (status, error) = w.app.send(Method::GET, "/invites/nosuchcode", None, None).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10006)));
    // Joining still needs an account.
    assert_eq!(w.app.send(Method::POST, &path, None, Some(json!({}))).await.0, StatusCode::UNAUTHORIZED);
}
