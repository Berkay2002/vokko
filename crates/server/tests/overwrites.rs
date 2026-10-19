#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Channel permission overwrites: PUT/DELETE, their effect on access, creation/move inheritance and category sync.
mod common;

use std::collections::HashSet;
use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use vokko_protocol::api::permissions::{
    ADMINISTRATOR, ATTACH_FILES, DEFAULT_EVERYONE, MANAGE_CHANNELS, MANAGE_MESSAGES, MANAGE_ROLES, SEND_MESSAGES, VIEW_CHANNEL,
};

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
            match tokio::time::timeout(common::WAIT, self.ws.next()).await {
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

    /// The next `name` event about `channel_id`.
    async fn wait_channel(&mut self, name: &str, channel_id: &str) -> Value {
        loop {
            let data = self.wait_for(name).await;
            if data["id"] == channel_id {
                return data;
            }
        }
    }

    /// Ids of every `name` event arriving within `window`.
    async fn collect_channels(&mut self, name: &str, window: Duration) -> HashSet<String> {
        let mut seen = HashSet::new();
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Some(Ok(Message::Text(text))) = next {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == name {
                    seen.insert(frame["d"]["id"].as_str().expect("channel id").to_owned());
                }
            }
        }
        seen
    }
}

struct World {
    app: TestApp,
    address: String,
    guild: String,
    general: String,
    category: String,
    owner: String,
    alice: (String, String),
    /// Registered but not in the guild.
    outsider: (String, String),
}

async fn world() -> World {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (alice_token, alice) = app.register("alice").await;
    let (outsider_token, outsider) = app.register("bob").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{general}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(app.post(&format!("/invites/{code}"), &alice_token, json!({})).await.0, StatusCode::OK);
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &owner).await;
    let category = channels.as_array().expect("channels").iter().find(|c| c["type"] == 4 && c["name"] == "Text Channels").expect("category")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let id = |user: &Value| user["id"].as_str().expect("id").to_owned();
    World { address, guild, general, category, owner, alice: (alice_token, id(&alice)), outsider: (outsider_token, id(&outsider)), app }
}

impl World {
    /// Creates a role with `permissions` and gives it to `user_id` (the role routes belong to the moderation work).
    async fn role_for(&self, user_id: &str, permissions: u64) -> String {
        let role = self.app.state.ids.next();
        let guild: i64 = self.guild.parse().expect("guild id");
        sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $2, 'tester', 1, $3)")
            .bind(role)
            .bind(guild)
            .bind(permissions as i64)
            .execute(&self.app.state.db)
            .await
            .expect("insert role");
        sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(guild)
            .bind(user_id.parse::<i64>().expect("user id"))
            .bind(role)
            .execute(&self.app.state.db)
            .await
            .expect("assign role");
        role.to_string()
    }

    async fn overwrites(&self, channel: &str) -> Vec<Value> {
        let (_, channels) = self.app.get(&format!("/guilds/{}/channels", self.guild), &self.owner).await;
        let found = channels.as_array().expect("channels").iter().find(|c| c["id"] == channel).expect("channel").clone();
        found["permission_overwrites"].as_array().expect("overwrites").clone()
    }

    async fn put(&self, channel: &str, target: &str, token: &str, kind: u8, allow: u64, deny: u64) -> (StatusCode, Value) {
        let body = json!({"type": kind, "allow": allow.to_string(), "deny": deny.to_string()});
        self.app.put_json(&format!("/channels/{channel}/permissions/{target}"), token, body).await
    }

    async fn new_channel(&self, body: Value) -> (StatusCode, Value) {
        self.app.post(&format!("/guilds/{}/channels", self.guild), &self.owner, body).await
    }
}

#[tokio::test]
async fn put_and_delete_change_access_and_emit_events() {
    let w = world().await;
    let mut owner = Client::connect(&w.address, &w.owner).await;
    let mut alice = Client::connect(&w.address, &w.alice.0).await;
    let post = |text: &str| json!({"content": text});
    let messages = format!("/channels/{}/messages", w.general);
    assert_eq!(w.app.post(&messages, &w.alice.0, post("hi")).await.0, StatusCode::OK);

    // @everyone loses SEND_MESSAGES (role id == guild id)
    let (status, _) = w.put(&w.general, &w.guild, &w.owner, 0, 0, SEND_MESSAGES).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let update = owner.wait_channel("CHANNEL_UPDATE", &w.general).await;
    assert_eq!(update["permission_overwrites"][0]["deny"], SEND_MESSAGES.to_string());
    let (status, error) = w.app.post(&messages, &w.alice.0, post("nope")).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));

    // a role that allows it gets it back
    let talker = w.role_for(&w.alice.1, DEFAULT_EVERYONE).await;
    assert_eq!(w.put(&w.general, &talker, &w.owner, 0, SEND_MESSAGES, 0).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&messages, &w.alice.0, post("back")).await.0, StatusCode::OK);

    // a member overwrite wins over the role; deleting it restores the role's result
    assert_eq!(w.put(&w.general, &w.alice.1, &w.owner, 1, 0, SEND_MESSAGES).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&messages, &w.alice.0, post("no")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/channels/{}/permissions/{}", w.general, w.alice.1), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&messages, &w.alice.0, post("yes")).await.0, StatusCode::OK);
    assert_eq!(w.overwrites(&w.general).await.len(), 2);

    // hiding the channel from @everyone and the role removes it for alice, un-hiding brings it back
    assert_eq!(w.put(&w.general, &w.guild, &w.owner, 0, 0, VIEW_CHANNEL).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.put(&w.general, &talker, &w.owner, 0, 0, VIEW_CHANNEL).await.0, StatusCode::NO_CONTENT);
    alice.wait_channel("CHANNEL_DELETE", &w.general).await;
    assert_eq!(w.app.get(&messages, &w.alice.0).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&format!("/channels/{}/permissions/{}", w.general, talker), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&format!("/channels/{}/permissions/{}", w.general, w.guild), &w.owner).await.0, StatusCode::NO_CONTENT);
    alice.wait_channel("CHANNEL_CREATE", &w.general).await;
    assert!(w.overwrites(&w.general).await.is_empty());
    // deleting what is not there is fine
    assert_eq!(w.app.delete(&format!("/channels/{}/permissions/{}", w.general, w.guild), &w.owner).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn role_changes_open_and_close_channels() {
    let w = world().await;
    let mut alice = Client::connect(&w.address, &w.alice.0).await;
    let guild = &w.guild;
    let (_, role) = w.app.post(&format!("/guilds/{guild}/roles"), &w.owner, json!({"name": "insiders"})).await;
    let role = role["id"].as_str().expect("role id").to_owned();
    // general is private: hidden from @everyone, open to the role
    assert_eq!(w.put(&w.general, guild, &w.owner, 0, 0, VIEW_CHANNEL).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.put(&w.general, &role, &w.owner, 0, VIEW_CHANNEL, 0).await.0, StatusCode::NO_CONTENT);
    alice.wait_channel("CHANNEL_DELETE", &w.general).await;
    let member = format!("/guilds/{guild}/members/{}", w.alice.1);

    // giving and taking the role opens and closes the channel for alice
    assert_eq!(w.app.patch(&member, &w.owner, json!({"roles": [role]})).await.0, StatusCode::OK);
    alice.wait_channel("CHANNEL_CREATE", &w.general).await;
    assert_eq!(w.app.patch(&member, &w.owner, json!({"roles": []})).await.0, StatusCode::OK);
    alice.wait_channel("CHANNEL_DELETE", &w.general).await;

    // deleting the role she holds closes it again
    assert_eq!(w.app.patch(&member, &w.owner, json!({"roles": [role]})).await.0, StatusCode::OK);
    alice.wait_channel("CHANNEL_CREATE", &w.general).await;
    assert_eq!(w.app.delete(&format!("/guilds/{guild}/roles/{role}"), &w.owner).await.0, StatusCode::NO_CONTENT);
    alice.wait_channel("CHANNEL_DELETE", &w.general).await;

    // editing @everyone's permissions closes and reopens a channel without overwrites
    let everyone = format!("/guilds/{guild}/roles/{guild}");
    let hidden = (DEFAULT_EVERYONE & !VIEW_CHANNEL).to_string();
    assert_eq!(w.app.patch(&everyone, &w.owner, json!({"permissions": hidden})).await.0, StatusCode::OK);
    alice.wait_channel("CHANNEL_DELETE", &w.category).await;
    assert_eq!(w.app.patch(&everyone, &w.owner, json!({"permissions": DEFAULT_EVERYONE.to_string()})).await.0, StatusCode::OK);
    alice.wait_channel("CHANNEL_CREATE", &w.category).await;
}

#[tokio::test]
async fn validation_and_authorisation() {
    let w = world().await;
    // alice may manage overwrites but only hands out what she has herself
    let manager = w.role_for(&w.alice.1, DEFAULT_EVERYONE | MANAGE_ROLES).await;
    assert_eq!(w.put(&w.general, &manager, &w.alice.0, 0, SEND_MESSAGES, 0).await.0, StatusCode::NO_CONTENT);
    for (allow, deny) in [(MANAGE_MESSAGES, 0), (0, MANAGE_MESSAGES)] {
        let (status, error) = w.put(&w.general, &w.guild, &w.alice.0, 0, allow, deny).await;
        assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)), "allow {allow} deny {deny}");
    }
    // a plain member cannot manage overwrites at all
    let (status, error) = w.put(&w.general, &w.guild, &w.outsider.0, 0, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50001)), "non-member cannot even see the channel");
    let (status, _) = w.app.delete(&format!("/channels/{}/permissions/{}", w.general, w.guild), &w.outsider.0).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // the owner: ADMINISTRATOR in an overwrite is ignored (stored stripped), other bits kept
    let (status, _) = w.put(&w.general, &w.guild, &w.owner, 0, ADMINISTRATOR | ATTACH_FILES, ADMINISTRATOR).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let stored = w.overwrites(&w.general).await;
    let everyone = stored.iter().find(|o| o["id"] == w.guild).expect("everyone overwrite");
    assert_eq!((everyone["allow"].as_str(), everyone["deny"].as_str()), (Some(ATTACH_FILES.to_string().as_str()), Some("0")));

    // a plain member without MANAGE_ROLES
    let (_, invite) = w.app.post(&format!("/channels/{}/invites", w.general), &w.owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(w.app.post(&format!("/invites/{code}"), &w.outsider.0, json!({})).await.0, StatusCode::OK);
    let (status, error) = w.put(&w.general, &w.guild, &w.outsider.0, 0, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));

    // a member who cannot see the channel gets missing access (50001), not missing permissions
    assert_eq!(w.put(&w.general, &w.guild, &w.owner, 0, 0, VIEW_CHANNEL).await.0, StatusCode::NO_CONTENT);
    let (status, error) = w.put(&w.general, &w.guild, &w.outsider.0, 0, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50001)));
    let (status, error) = w.app.delete(&format!("/channels/{}/permissions/{}", w.general, w.guild), &w.outsider.0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50001)));

    // unknown targets
    let (status, error) = w.put(&w.general, "999999999999", &w.owner, 0, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10011)));
    let (status, error) = w.put(&w.general, "999999999999", &w.owner, 1, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10007)));
    let (status, error) = w.put("999999999999", &w.guild, &w.owner, 0, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10003)));
    // a role of another guild is unknown here
    let (other_guild, _) = w.app.guild_with_channel(&w.owner).await;
    let (status, error) = w.put(&w.general, &other_guild, &w.owner, 0, 0, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10011)));
    // malformed bitfield
    let body = json!({"type": 0, "allow": "lots", "deny": "0"});
    let (status, _) = w.app.put_json(&format!("/channels/{}/permissions/{}", w.general, w.guild), &w.owner, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn creation_and_moves_inherit_from_the_category() {
    let w = world().await;
    assert_eq!(w.put(&w.category, &w.guild, &w.owner, 0, 0, SEND_MESSAGES).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.put(&w.category, &w.alice.1, &w.owner, 1, ATTACH_FILES, 0).await.0, StatusCode::NO_CONTENT);
    let category_overwrites = w.overwrites(&w.category).await;
    assert_eq!(category_overwrites.len(), 2);

    // absent: copy the category's overwrites
    let (status, copied) = w.new_channel(json!({"type": 0, "name": "copied", "parent_id": w.category})).await;
    assert_eq!(status, StatusCode::OK, "{copied}");
    assert_eq!(copied["permission_overwrites"], Value::Array(category_overwrites.clone()));
    // no parent, no overwrites
    let (_, loose) = w.new_channel(json!({"type": 0, "name": "loose"})).await;
    assert_eq!(loose["permission_overwrites"], json!([]));
    // explicit overwrites replace the copy; an empty list means none
    let explicit = json!([{"id": w.guild, "type": 0, "allow": "0", "deny": VIEW_CHANNEL.to_string()}]);
    let (status, private) = w.new_channel(json!({"type": 0, "name": "private", "parent_id": w.category, "permission_overwrites": explicit})).await;
    assert_eq!(status, StatusCode::OK, "{private}");
    assert_eq!(private["permission_overwrites"], explicit);
    let (_, bare) = w.new_channel(json!({"type": 0, "name": "bare", "parent_id": w.category, "permission_overwrites": []})).await;
    assert_eq!(bare["permission_overwrites"], json!([]));
    // explicit overwrites are validated like PUT
    let bad_target = json!([{"id": "999999999999", "type": 1, "allow": "0", "deny": "0"}]);
    let (status, error) = w.new_channel(json!({"type": 0, "name": "bad", "permission_overwrites": bad_target})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10007)));
    let admin = json!([{"id": w.guild, "type": 0, "allow": ADMINISTRATOR.to_string(), "deny": "0"}]);
    let (_, stripped) = w.new_channel(json!({"type": 0, "name": "stripped", "permission_overwrites": admin})).await;
    assert_eq!(stripped["permission_overwrites"][0]["allow"], "0");

    // moving: lock_permissions true adopts the new parent's overwrites, false/absent keeps its own
    let (_, other) = w.new_channel(json!({"type": 4, "name": "Other"})).await;
    let other_id = other["id"].as_str().expect("id").to_owned();
    assert_eq!(w.put(&other_id, &w.guild, &w.owner, 0, 0, VIEW_CHANNEL).await.0, StatusCode::NO_CONTENT);
    let loose_id = loose["id"].as_str().expect("id");
    let (status, moved) = w.app.patch(&format!("/channels/{loose_id}"), &w.owner, json!({"parent_id": other_id, "lock_permissions": false})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((moved["parent_id"].as_str(), moved["permission_overwrites"].clone()), (Some(other_id.as_str()), json!([])));
    let (_, moved) = w.app.patch(&format!("/channels/{loose_id}"), &w.owner, json!({"parent_id": w.category, "lock_permissions": true})).await;
    assert_eq!(moved["permission_overwrites"], Value::Array(category_overwrites));
    // lock_permissions without a parent change is ignored
    let private_id = private["id"].as_str().expect("id");
    let (_, same) = w.app.patch(&format!("/channels/{private_id}"), &w.owner, json!({"lock_permissions": true, "topic": "t"})).await;
    assert_eq!(same["permission_overwrites"], explicit);
}

#[tokio::test]
async fn category_edits_sync_equal_children_only() {
    let w = world().await;
    let mut owner = Client::connect(&w.address, &w.owner).await;
    // general is a child of the category with no overwrites (equal); `synced` copies; `diverged` has its own
    let (_, synced) = w.new_channel(json!({"type": 0, "name": "synced", "parent_id": w.category})).await;
    let (_, diverged) = w.new_channel(json!({"type": 0, "name": "diverged", "parent_id": w.category})).await;
    let synced = synced["id"].as_str().expect("id").to_owned();
    let diverged = diverged["id"].as_str().expect("id").to_owned();
    assert_eq!(w.put(&diverged, &w.alice.1, &w.owner, 1, ATTACH_FILES, 0).await.0, StatusCode::NO_CONTENT);
    owner.collect_channels("CHANNEL_UPDATE", Duration::from_millis(300)).await;

    assert_eq!(w.put(&w.category, &w.guild, &w.owner, 0, 0, SEND_MESSAGES).await.0, StatusCode::NO_CONTENT);
    let updated = owner.collect_channels("CHANNEL_UPDATE", Duration::from_millis(700)).await;
    let expected: HashSet<String> = [w.category.clone(), w.general.clone(), synced.clone()].into_iter().collect();
    assert_eq!(updated, expected, "the category and its equal children, not the diverged one");
    for channel in [&w.category, &w.general, &synced] {
        let list = w.overwrites(channel).await;
        assert_eq!(list.len(), 1, "{channel}");
        assert_eq!(list[0]["deny"], SEND_MESSAGES.to_string());
    }
    assert_eq!(w.overwrites(&diverged).await.len(), 1);
    assert_eq!(w.overwrites(&diverged).await[0]["id"], w.alice.1);

    // deleting syncs too; the diverged child is still left alone
    assert_eq!(w.app.delete(&format!("/channels/{}/permissions/{}", w.category, w.guild), &w.owner).await.0, StatusCode::NO_CONTENT);
    let updated = owner.collect_channels("CHANNEL_UPDATE", Duration::from_millis(700)).await;
    assert_eq!(updated, expected);
    assert!(w.overwrites(&synced).await.is_empty());
    assert_eq!(w.overwrites(&diverged).await.len(), 1);
}

#[tokio::test]
async fn lock_permissions_needs_manage_roles_and_every_flipped_bit() {
    let w = world().await;
    let (_, loose) = w.new_channel(json!({"type": 0, "name": "loose"})).await;
    let loose = loose["id"].as_str().expect("id").to_owned();
    let parent_of = |channels: &Value, id: &str| channels.as_array().expect("channels").iter().find(|c| c["id"] == id).expect("channel")["parent_id"].clone();
    // the category hides MANAGE_MESSAGES behind a deny alice does not hold herself
    assert_eq!(w.put(&w.category, &w.guild, &w.owner, 0, 0, MANAGE_MESSAGES).await.0, StatusCode::NO_CONTENT);
    let patch = json!({"parent_id": w.category, "lock_permissions": true});

    // MANAGE_CHANNELS alone: moving is fine, adopting the category's overwrites is not
    w.role_for(&w.alice.1, DEFAULT_EVERYONE | MANAGE_CHANNELS).await;
    let (status, error) = w.app.patch(&format!("/channels/{loose}"), &w.alice.0, patch.clone()).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));
    let (_, channels) = w.app.get(&format!("/guilds/{}/channels", w.guild), &w.owner).await;
    assert_eq!(parent_of(&channels, &loose), Value::Null, "the rejected request moved nothing");
    assert!(w.overwrites(&loose).await.is_empty());

    // MANAGE_ROLES too, but the category flips a bit alice lacks
    w.role_for(&w.alice.1, MANAGE_ROLES).await;
    let (status, error) = w.app.patch(&format!("/channels/{loose}"), &w.alice.0, patch.clone()).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));
    assert!(w.overwrites(&loose).await.is_empty());

    // the same category with a bit she does hold goes through, and the channel adopts it
    assert_eq!(w.put(&w.category, &w.guild, &w.owner, 0, 0, SEND_MESSAGES).await.0, StatusCode::NO_CONTENT);
    let (status, moved) = w.app.patch(&format!("/channels/{loose}"), &w.alice.0, patch).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["parent_id"], w.category.as_str());
    assert_eq!(w.overwrites(&loose).await, w.overwrites(&w.category).await);
}

#[tokio::test]
async fn overwrite_edits_need_the_bits_they_flip() {
    let w = world().await;
    w.role_for(&w.alice.1, DEFAULT_EVERYONE | MANAGE_ROLES).await;
    let delete = format!("/channels/{}/permissions/{}", w.general, w.guild);
    assert_eq!(w.put(&w.general, &w.guild, &w.owner, 0, 0, MANAGE_MESSAGES).await.0, StatusCode::NO_CONTENT);

    // removing a deny of a bit alice lacks is changing it
    let (status, error) = w.app.delete(&delete, &w.alice.0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)));
    let (status, error) = w.put(&w.general, &w.guild, &w.alice.0, 0, 0, SEND_MESSAGES).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)), "dropping the foreign deny");
    let (status, error) = w.put(&w.general, &w.guild, &w.alice.0, 0, MANAGE_MESSAGES, 0).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50013)), "flipping it to allow");
    let stored = w.overwrites(&w.general).await;
    assert_eq!((stored.len(), stored[0]["deny"].as_str()), (1, Some(MANAGE_MESSAGES.to_string().as_str())));

    // leaving it alone while changing a bit she holds is fine
    assert_eq!(w.put(&w.general, &w.guild, &w.alice.0, 0, 0, MANAGE_MESSAGES | SEND_MESSAGES).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.overwrites(&w.general).await[0]["deny"], (MANAGE_MESSAGES | SEND_MESSAGES).to_string());
    // and deleting an overwrite made only of bits she holds is too (she denied herself SEND_MESSAGES above, so not that one)
    assert_eq!(w.put(&w.general, &w.alice.1, &w.owner, 1, ATTACH_FILES, 0).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&format!("/channels/{}/permissions/{}", w.general, w.alice.1), &w.alice.0).await.0, StatusCode::NO_CONTENT);
    // the owner removes the rest
    assert_eq!(w.app.delete(&delete, &w.owner).await.0, StatusCode::NO_CONTENT);
    assert!(w.overwrites(&w.general).await.is_empty());
}
