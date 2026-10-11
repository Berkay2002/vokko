//! Shared harness for the thread, forum and follow tests: a guild with a few members, role helpers and a gateway client.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;

use crate::common::TestApp;

pub struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub ready: Value,
}

impl Client {
    pub async fn connect(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws, ready: Value::Null };
        client.recv().await;
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        client.ready = client.wait_for("READY").await;
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

    /// The next dispatch called `name`.
    pub async fn wait_for(&mut self, name: &str) -> Value {
        self.wait_match(name, |_| true).await
    }

    /// The next `name` dispatch whose data satisfies `accept`.
    pub async fn wait_match(&mut self, name: &str, accept: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.recv().await;
            if frame["op"] == 0 && frame["t"] == name && accept(&frame["d"]) {
                return frame["d"].clone();
            }
        }
    }

    /// The next `name` dispatch about the object with this `id`.
    pub async fn wait_id(&mut self, name: &str, id: &str) -> Value {
        self.wait_match(name, |data| data["id"] == id).await
    }

    /// True if no `name` dispatch satisfying `accept` arrives within `window`.
    pub async fn silent_for(&mut self, name: &str, window: Duration, accept: impl Fn(&Value) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Some(Ok(Message::Text(text))) = next {
                let frame: Value = serde_json::from_str(&text).expect("json");
                if frame["t"] == name && accept(&frame["d"]) {
                    return false;
                }
            }
        }
        true
    }
}

pub struct Member {
    pub token: String,
    pub id: String,
}

pub struct World {
    pub app: TestApp,
    pub address: String,
    pub guild: String,
    pub general: String,
    pub owner: Member,
    pub alice: Member,
    pub carol: Member,
    /// Registered, in no guild.
    pub bob: Member,
}

fn member((token, user): (String, Value)) -> Member {
    Member { token, id: user["id"].as_str().expect("user id").to_owned() }
}

pub fn code(error: &Value) -> Option<u64> {
    error["code"].as_u64()
}

pub async fn world() -> World {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let owner = member(app.register("sam").await);
    let alice = member(app.register("alice").await);
    let carol = member(app.register("carol").await);
    let bob = member(app.register("bob").await);
    let (guild, general) = app.guild_with_channel(&owner.token).await;
    let (_, invite) = app.post(&format!("/channels/{general}/invites"), &owner.token, json!({})).await;
    let invite = invite["code"].as_str().expect("code").to_owned();
    for joiner in [&alice, &carol] {
        assert_eq!(app.post(&format!("/invites/{invite}"), &joiner.token, json!({})).await.0, StatusCode::OK);
    }
    World { app, address, guild, general, owner, alice, carol, bob }
}

impl World {
    pub fn guild_id(&self) -> i64 {
        self.guild.parse().expect("guild id")
    }

    /// Replaces what @everyone may do in the guild.
    pub async fn set_everyone(&self, permissions: u64) {
        sqlx::query("UPDATE roles SET permissions = $2 WHERE id = $1")
            .bind(self.guild_id())
            .bind(permissions as i64)
            .execute(&self.app.state.db)
            .await
            .expect("set @everyone");
    }

    /// Creates a role with `permissions` and gives it to `user`.
    pub async fn role_for(&self, user: &Member, permissions: u64) -> String {
        let role = self.app.state.ids.next();
        sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $2, 'tester', 1, $3)")
            .bind(role)
            .bind(self.guild_id())
            .bind(permissions as i64)
            .execute(&self.app.state.db)
            .await
            .expect("insert role");
        sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(self.guild_id())
            .bind(user.id.parse::<i64>().expect("user id"))
            .bind(role)
            .execute(&self.app.state.db)
            .await
            .expect("assign role");
        role.to_string()
    }

    pub async fn channel(&self, body: Value) -> Value {
        let (status, channel) = self.app.post(&format!("/guilds/{}/channels", self.guild), &self.owner.token, body).await;
        assert_eq!(status, StatusCode::OK, "create channel: {channel}");
        channel
    }

    pub async fn say(&self, channel: &str, user: &Member, content: &str) -> Value {
        let (status, message) = self.app.post(&format!("/channels/{channel}/messages"), &user.token, json!({"content": content})).await;
        assert_eq!(status, StatusCode::OK, "send in {channel}: {message}");
        message
    }

    pub async fn messages(&self, channel: &str, user: &Member) -> Vec<Value> {
        let (status, messages) = self.app.get(&format!("/channels/{channel}/messages?limit=100"), &user.token).await;
        assert_eq!(status, StatusCode::OK, "list {channel}: {messages}");
        messages.as_array().expect("messages").clone()
    }

    /// Starts a thread from a message; returns the thread channel.
    pub async fn thread_from(&self, channel: &str, message: &str, user: &Member, name: &str) -> Value {
        let (status, thread) = self.app.post(&format!("/channels/{channel}/messages/{message}/threads"), &user.token, json!({"name": name})).await;
        assert_eq!(status, StatusCode::OK, "start thread: {thread}");
        thread
    }

    pub async fn thread(&self, channel: &str, user: &Member, body: Value) -> (StatusCode, Value) {
        self.app.post(&format!("/channels/{channel}/threads"), &user.token, body).await
    }

    pub async fn patch(&self, id: &str, user: &Member, body: Value) -> (StatusCode, Value) {
        self.app.patch(&format!("/channels/{id}"), &user.token, body).await
    }

    /// Uploads a small PNG as a pending attachment of `channel`; returns its id.
    pub async fn upload_png(&self, channel: &str, user: &Member, filename: &str) -> String {
        let boundary = "vokkothreadsboundary";
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
        let mut body =
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
        body.extend_from_slice(&png);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/channels/{channel}/attachments"))
            .header("authorization", &user.token)
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(Body::from(body))
            .expect("request");
        let response = self.app.router.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
        let attachment: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        assert_eq!(status, StatusCode::OK, "upload: {attachment}");
        attachment["id"].as_str().expect("attachment id").to_owned()
    }
}
