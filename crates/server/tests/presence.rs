//! Chosen status persistence, invisible, and presence announcements around joining and leaving guilds.
mod common;

use std::time::Duration;

use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(address: &str, token: &str) -> (Self, Value) {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.recv().await;
        client.send(json!({"op": 2, "d": {"token": token}})).await;
        let ready = client.wait_for("READY").await;
        (client, ready)
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
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

    /// The next PRESENCE_UPDATE of `user_id` that has `status`.
    async fn wait_presence(&mut self, user_id: &str, status: &str) -> Value {
        loop {
            let data = self.wait_for("PRESENCE_UPDATE").await;
            if data["user_id"] == user_id && data["status"] == status {
                return data;
            }
        }
    }

    /// True if no PRESENCE_UPDATE of `user_id` with another status than `allowed` arrives within `window`.
    async fn only_presence(&mut self, user_id: &str, allowed: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Some(Ok(Message::Text(text))) = next {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == "PRESENCE_UPDATE" && frame["d"]["user_id"] == user_id && frame["d"]["status"] != allowed {
                    return false;
                }
            }
        }
        true
    }
}

fn find<'a>(presences: &'a Value, user_id: &str) -> Option<&'a Value> {
    presences.as_array().expect("presences").iter().find(|presence| presence["user_id"] == user_id)
}

struct World {
    app: TestApp,
    address: String,
    guild: String,
    invite: String,
    owner: (String, String),
    alice: (String, String),
    bob: (String, String),
}

async fn world() -> World {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner_token, owner) = app.register("sam").await;
    let (alice_token, alice) = app.register("alice").await;
    let (bob_token, bob) = app.register("bob").await;
    let (guild, channel) = app.guild_with_channel(&owner_token).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner_token, json!({})).await;
    let invite = invite["code"].as_str().expect("code").to_owned();
    app.post(&format!("/invites/{invite}"), &alice_token, json!({})).await;
    let id = |user: &Value| user["id"].as_str().expect("id").to_owned();
    World { address, guild, invite, owner: (owner_token, id(&owner)), alice: (alice_token, id(&alice)), bob: (bob_token, id(&bob)), app }
}

#[tokio::test]
async fn chosen_status_and_custom_status_survive_disconnects() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    alice.send(json!({"op": 3, "d": {"status": "dnd", "custom_status": "busy"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "dnd").await;
    assert_eq!(seen["custom_status"], "busy");

    drop(alice);
    let gone = owner.wait_presence(&w.alice.1, "offline").await;
    assert_eq!(gone["custom_status"], Value::Null);

    let (_alice, ready) = Client::connect(&w.address, &w.alice.0).await;
    let own = find(&ready["presences"], &w.alice.1).expect("own presence in READY");
    assert_eq!((own["status"].as_str(), own["custom_status"].as_str()), (Some("dnd"), Some("busy")), "alice sees her chosen status");
    let back = owner.wait_presence(&w.alice.1, "dnd").await;
    assert_eq!(back["custom_status"], "busy", "restored, not reset to online");
}

#[tokio::test]
async fn invisible_reads_offline_to_others_and_survives_reconnects() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut alice, _) = Client::connect(&w.address, &w.alice.0).await;
    owner.wait_presence(&w.alice.1, "online").await;

    alice.send(json!({"op": 3, "d": {"status": "invisible", "custom_status": "secret"}})).await;
    let seen = owner.wait_presence(&w.alice.1, "offline").await;
    assert_eq!(seen["custom_status"], Value::Null, "custom status is hidden while invisible");
    let own = alice.wait_presence(&w.alice.1, "invisible").await;
    assert_eq!(own["custom_status"], "secret", "her own sessions still see it");

    // a fresh READY of someone else shows her offline although she is connected
    let (mut bob_owner, ready) = Client::connect(&w.address, &w.owner.0).await;
    let seen = find(&ready["presences"], &w.alice.1).expect("alice in READY");
    assert_eq!((seen["status"].as_str(), seen["custom_status"].is_null()), (Some("offline"), true));
    drop(bob_owner.ws.close(None).await);

    // reconnecting keeps her invisible: nobody ever sees her online
    drop(alice);
    let (_alice, ready) = Client::connect(&w.address, &w.alice.0).await;
    assert_eq!(find(&ready["presences"], &w.alice.1).expect("own presence")["status"], "invisible");
    assert!(owner.only_presence(&w.alice.1, "offline", Duration::from_millis(600)).await, "invisible user never appears online");
}

#[tokio::test]
async fn joining_and_leaving_announces_presence_to_new_strangers() {
    let w = world().await;
    let (mut owner, _) = Client::connect(&w.address, &w.owner.0).await;
    let (mut bob, ready) = Client::connect(&w.address, &w.bob.0).await;
    assert!(find(&ready["presences"], &w.owner.1).is_none(), "bob shares nothing with sam yet");

    let (status, _) = w.app.post(&format!("/invites/{}", w.invite), &w.bob.0, json!({})).await;
    assert_eq!(status, 200);
    let created = bob.wait_for("GUILD_CREATE").await;
    let presences = &created["presences"];
    assert_eq!(find(presences, &w.owner.1).expect("sam online in GUILD_CREATE")["status"], "online");
    assert!(created["presences"].as_array().is_some_and(|list| list.iter().all(|entry| entry["status"] != "offline")));

    owner.wait_for("GUILD_MEMBER_ADD").await;
    owner.wait_presence(&w.bob.1, "online").await;

    let (status, _) = w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &w.bob.0).await;
    assert_eq!(status, 204);
    owner.wait_presence(&w.bob.1, "offline").await;
    bob.wait_presence(&w.owner.1, "offline").await;
}
