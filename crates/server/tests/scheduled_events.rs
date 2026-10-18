#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Guild scheduled events: lifecycle, permissions (CREATE_EVENTS / MANAGE_EVENTS), validation and gateway events.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use vokko_protocol::api::permissions::{CREATE_EVENTS, DEFAULT_EVERYONE, MANAGE_EVENTS};

struct World {
    app: TestApp,
    guild: String,
    channel: String,
    owner: String,
}

fn in_hours(hours: i64) -> String {
    (OffsetDateTime::now_utc() + time::Duration::hours(hours)).format(&Rfc3339).expect("format")
}

impl World {
    async fn new() -> Self {
        let app = TestApp::new().await;
        let (owner, _) = app.register("owner").await;
        let (guild, channel) = app.guild_with_channel(&owner).await;
        Self { app, guild, channel, owner }
    }

    fn path(&self, tail: &str) -> String {
        format!("/guilds/{}{tail}", self.guild)
    }

    async fn member(&self, name: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.channel), &self.owner, json!({})).await;
        let (status, body) = self.app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &token, json!({})).await;
        assert_eq!(status, StatusCode::OK, "join: {body}");
        (token, user["id"].as_str().expect("id").to_owned())
    }

    async fn voice_channel(&self) -> String {
        let (_, channels) = self.app.get(&self.path("/channels"), &self.owner).await;
        channels.as_array().expect("channels").iter().find(|c| c["type"] == 2).expect("voice channel")["id"].as_str().expect("id").to_owned()
    }

    async fn external(&self, token: &str, name: &str) -> Value {
        let body = json!({
            "name": name, "entity_type": 3, "entity_metadata": {"location": "The lounge"},
            "scheduled_start_time": in_hours(24), "scheduled_end_time": in_hours(26)
        });
        let (status, event) = self.app.post(&self.path("/scheduled-events"), token, body).await;
        assert_eq!(status, StatusCode::OK, "create event: {event}");
        event
    }
}

fn event_path(w: &World, event: &Value, tail: &str) -> String {
    w.path(&format!("/scheduled-events/{}{tail}", event["id"].as_str().expect("event id")))
}

#[tokio::test]
async fn lifecycle_interested_and_status_transitions() {
    let w = World::new().await;
    let (alice, alice_id) = w.member("alice").await;
    let event = w.external(&w.owner, "Movie night").await;
    assert_eq!(event["status"], 1);
    assert_eq!(event["entity_type"], 3);
    assert_eq!(event["entity_metadata"]["location"], "The lounge");
    assert_eq!(event["channel_id"], Value::Null);
    assert_eq!((event["privacy_level"].clone(), event["user_count"].clone(), event["user_rsvp"].clone()), (json!(2), json!(0), json!(false)));
    assert_eq!(event["creator"]["username"], "owner");

    // listed for members, soonest first, not for outsiders
    let second = w.external(&w.owner, "Later").await;
    let (_, listed) = w.app.get(&w.path("/scheduled-events"), &alice).await;
    assert_eq!(listed.as_array().expect("list").len(), 2);
    assert_eq!(listed[0]["id"], event["id"]);
    assert_eq!(listed[1]["id"], second["id"]);
    let (outsider, _) = w.app.register("bob").await;
    assert_eq!(w.app.get(&w.path("/scheduled-events"), &outsider).await.0, StatusCode::FORBIDDEN);

    // Interested: counts, per-viewer flag, listing of users
    assert_eq!(w.app.put(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.put(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT, "idempotent");
    let (_, as_alice) = w.app.get(&event_path(&w, &event, ""), &alice).await;
    let (_, as_owner) = w.app.get(&event_path(&w, &event, ""), &w.owner).await;
    assert_eq!((as_alice["user_count"].clone(), as_alice["user_rsvp"].clone()), (json!(1), json!(true)));
    assert_eq!((as_owner["user_count"].clone(), as_owner["user_rsvp"].clone()), (json!(1), json!(false)));
    let (_, users) = w.app.get(&event_path(&w, &event, "/users?with_member=true"), &w.owner).await;
    assert_eq!(users.as_array().expect("users").len(), 1);
    assert_eq!(users[0]["user"]["id"], alice_id);
    assert_eq!(users[0]["guild_scheduled_event_id"], event["id"]);
    assert_eq!(users[0]["member"]["user"]["id"], alice_id);

    // edit, then the status machine: Scheduled -> Completed is not allowed
    let (status, edited) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"name": "Movie night!", "description": "Bring snacks"})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!((edited["name"].clone(), edited["description"].clone()), (json!("Movie night!"), json!("Bring snacks")));
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 3})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    let (status, active) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 2})).await;
    assert_eq!((status, active["status"].clone()), (StatusCode::OK, json!(2)));
    // once started the entity is frozen but the name is not
    let (status, _) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"entity_type": 2})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, done) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 3, "name": "Movie night (done)"})).await;
    assert_eq!((status, done["status"].clone(), done["name"].clone()), (StatusCode::OK, json!(3), json!("Movie night (done)")));

    // finished events are frozen, cannot be joined, and drop out of the list; withdrawing still works
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"name": "again"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(180000)));
    let (bob_token, _) = w.member("carol").await;
    let (status, error) = w.app.put(&event_path(&w, &event, "/users/@me"), &bob_token).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(180000)));
    let (_, listed) = w.app.get(&w.path("/scheduled-events"), &alice).await;
    assert_eq!(listed.as_array().expect("list").len(), 1);
    assert_eq!(w.app.get(&event_path(&w, &event, ""), &alice).await.1["status"], 3);
    assert_eq!(w.app.delete(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&event_path(&w, &event, ""), &alice).await.1["user_count"], 0);

    // canceling from Scheduled, then deleting
    let (status, canceled) = w.app.patch(&event_path(&w, &second, ""), &w.owner, json!({"status": 4})).await;
    assert_eq!((status, canceled["status"].clone()), (StatusCode::OK, json!(4)));
    assert_eq!(w.app.delete(&event_path(&w, &second, ""), &w.owner).await.0, StatusCode::NO_CONTENT);
    let (status, error) = w.app.get(&event_path(&w, &second, ""), &w.owner).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10065)));
}

#[tokio::test]
async fn permissions_create_events_and_manage_events() {
    let w = World::new().await;
    let (alice, _) = w.member("alice").await;
    let (bob, bob_id) = w.member("bob").await;

    // CREATE_EVENTS is in the default @everyone set: members create, and manage their own events only
    let mine = w.external(&alice, "Alice's event").await;
    assert_eq!(w.app.patch(&event_path(&w, &mine, ""), &alice, json!({"name": "Renamed"})).await.0, StatusCode::OK);
    let (status, error) = w.app.patch(&event_path(&w, &mine, ""), &bob, json!({"name": "Hijack"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)));
    assert_eq!(w.app.delete(&event_path(&w, &mine, ""), &bob).await.0, StatusCode::FORBIDDEN);

    // take CREATE_EVENTS away from @everyone
    let without = (DEFAULT_EVERYONE & !CREATE_EVENTS).to_string();
    let (status, _) = w.app.patch(&w.path(&format!("/roles/{}", w.guild)), &w.owner, json!({"permissions": without})).await;
    assert_eq!(status, StatusCode::OK);
    let body =
        json!({"name": "Nope", "entity_type": 3, "entity_metadata": {"location": "x"}, "scheduled_start_time": in_hours(5), "scheduled_end_time": in_hours(6)});
    assert_eq!(w.app.post(&w.path("/scheduled-events"), &bob, body.clone()).await.0, StatusCode::FORBIDDEN);
    // without CREATE_EVENTS even the creator cannot edit their own event any more
    assert_eq!(w.app.patch(&event_path(&w, &mine, ""), &alice, json!({"name": "Late edit"})).await.0, StatusCode::FORBIDDEN);

    // a MANAGE_EVENTS role lets bob create and edit anybody's event
    let (_, role) = w.app.post(&w.path("/roles"), &w.owner, json!({"name": "events", "permissions": MANAGE_EVENTS.to_string()})).await;
    let role_id = role["id"].as_str().expect("role id");
    let (status, _) = w.app.patch(&w.path(&format!("/members/{bob_id}")), &w.owner, json!({"roles": [role_id]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(w.app.post(&w.path("/scheduled-events"), &bob, body).await.0, StatusCode::OK);
    assert_eq!(w.app.patch(&event_path(&w, &mine, ""), &bob, json!({"name": "Moderated"})).await.0, StatusCode::OK);
    assert_eq!(w.app.delete(&event_path(&w, &mine, ""), &bob).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn validation_and_voice_events() {
    let w = World::new().await;
    let voice = w.voice_channel().await;
    let post = |body: Value| {
        let w = &w;
        async move { w.app.post(&w.path("/scheduled-events"), &w.owner, body).await }
    };
    let ok_external =
        json!({"name": "x", "entity_type": 3, "entity_metadata": {"location": "x"}, "scheduled_start_time": in_hours(2), "scheduled_end_time": in_hours(3)});
    let with = |key: &str, value: Value| {
        let mut body = ok_external.clone();
        body[key] = value;
        body
    };
    for (what, body) in [
        ("empty name", with("name", json!("  "))),
        ("past start", with("scheduled_start_time", json!(in_hours(-1)))),
        ("end before start", with("scheduled_end_time", json!(in_hours(1)))),
        ("external without end", with("scheduled_end_time", Value::Null)),
        ("external without location", with("entity_metadata", Value::Null)),
        ("external with a channel", with("channel_id", json!(voice.clone()))),
        ("voice without channel", with("entity_type", json!(2))),
        ("garbage time", with("scheduled_start_time", json!("tomorrow"))),
        ("privacy level 1", with("privacy_level", json!(1))),
        (
            "bad recurrence",
            with("recurrence_rule", json!({"start": in_hours(2), "end": null, "frequency": 3, "interval": 0, "by_weekday": null, "count": null})),
        ),
        (
            "weekday on a daily rule",
            with("recurrence_rule", json!({"start": in_hours(2), "end": null, "frequency": 3, "interval": 1, "by_weekday": [1], "count": null})),
        ),
    ] {
        let (status, error) = post(body).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{what}: {error}");
    }
    // a text channel is not a voice channel
    let (status, error) = post(json!({"name": "x", "entity_type": 2, "channel_id": w.channel, "scheduled_start_time": in_hours(2)})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");

    // a voice event with a recurrence rule; the stage type also points at a voice channel
    let rule = json!({"start": in_hours(2), "end": null, "frequency": 2, "interval": 1, "by_weekday": [4, 1, 4], "count": 10});
    let (status, event) =
        post(json!({"name": "Game night", "entity_type": 2, "channel_id": voice, "scheduled_start_time": in_hours(2), "recurrence_rule": rule})).await;
    assert_eq!(status, StatusCode::OK, "{event}");
    assert_eq!((event["channel_id"].clone(), event["entity_metadata"].clone(), event["scheduled_end_time"].clone()), (json!(voice), Value::Null, Value::Null));
    assert_eq!(event["recurrence_rule"]["by_weekday"], json!([1, 4]));
    assert_eq!(post(json!({"name": "Stage", "entity_type": 1, "channel_id": voice, "scheduled_start_time": in_hours(3)})).await.0, StatusCode::OK);

    // switching a scheduled event to external needs a location and drops the channel
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"entity_type": 3})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    let (status, moved) = w
        .app
        .patch(
            &event_path(&w, &event, ""),
            &w.owner,
            json!({"entity_type": 3, "entity_metadata": {"location": "Park"}, "scheduled_end_time": in_hours(4), "recurrence_rule": null}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(
        (moved["channel_id"].clone(), moved["entity_metadata"]["location"].clone(), moved["recurrence_rule"].clone()),
        (Value::Null, json!("Park"), Value::Null)
    );

    // deleting the channel an event points at clears channel_id and keeps the event
    let (status, other) = post(json!({"name": "Back to voice", "entity_type": 2, "channel_id": voice, "scheduled_start_time": in_hours(6)})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(w.app.delete(&format!("/channels/{voice}"), &w.owner).await.0, StatusCode::OK);
    let (status, after) = w.app.get(&event_path(&w, &other, ""), &w.owner).await;
    assert_eq!((status, after["channel_id"].clone(), after["status"].clone()), (StatusCode::OK, Value::Null, json!(1)));
}

#[tokio::test]
async fn leaving_the_guild_removes_interest() {
    let w = World::new().await;
    let (alice, _) = w.member("alice").await;
    let event = w.external(&w.owner, "Meetup").await;
    assert_eq!(w.app.put(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&event_path(&w, &event, ""), &w.owner).await.1["user_count"], 1);
    assert_eq!(w.app.delete(&format!("/users/@me/guilds/{}", w.guild), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&event_path(&w, &event, ""), &w.owner).await.1["user_count"], 0);
    assert_eq!(w.app.put(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::FORBIDDEN);
}

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.next_frame().await;
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        client.wait_for("READY").await;
        client
    }

    async fn next_frame(&mut self) -> Value {
        loop {
            match tokio::time::timeout(common::WAIT, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return serde_json::from_str(&text).expect("json frame"),
                Ok(Some(Ok(_))) => continue,
                other => panic!("gateway closed or timed out: {other:?}"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.next_frame().await;
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }
}

#[tokio::test]
async fn gateway_events_carry_a_per_receiver_rsvp() {
    let w = World::new().await;
    let address = w.app.serve().await;
    let (alice, alice_id) = w.member("alice").await;
    let (outsider, _) = w.app.register("bob").await;
    let mut owner_ws = Client::identify(&address, &w.owner).await;
    let mut alice_ws = Client::identify(&address, &alice).await;
    let mut outsider_ws = Client::identify(&address, &outsider).await;

    let event = w.external(&w.owner, "Launch party").await;
    for ws in [&mut owner_ws, &mut alice_ws] {
        let created = ws.wait_for("GUILD_SCHEDULED_EVENT_CREATE").await;
        assert_eq!((created["id"].clone(), created["name"].clone(), created["user_rsvp"].clone()), (event["id"].clone(), json!("Launch party"), json!(false)));
    }

    assert_eq!(w.app.put(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT);
    for ws in [&mut owner_ws, &mut alice_ws] {
        let added = ws.wait_for("GUILD_SCHEDULED_EVENT_USER_ADD").await;
        assert_eq!(added, json!({"guild_scheduled_event_id": event["id"], "user_id": alice_id, "guild_id": w.guild}));
    }

    assert_eq!(w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 2})).await.0, StatusCode::OK);
    let for_owner = owner_ws.wait_for("GUILD_SCHEDULED_EVENT_UPDATE").await;
    let for_alice = alice_ws.wait_for("GUILD_SCHEDULED_EVENT_UPDATE").await;
    assert_eq!((for_owner["status"].clone(), for_owner["user_rsvp"].clone(), for_owner["user_count"].clone()), (json!(2), json!(false), json!(1)));
    assert_eq!(for_alice["user_rsvp"], true);

    assert_eq!(w.app.delete(&event_path(&w, &event, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_USER_REMOVE").await["user_id"], alice_id);

    assert_eq!(w.app.delete(&event_path(&w, &event, ""), &w.owner).await.0, StatusCode::NO_CONTENT);
    let deleted = alice_ws.wait_for("GUILD_SCHEDULED_EVENT_DELETE").await;
    assert_eq!(deleted["id"], event["id"]);

    // the outsider heard nothing at all
    let silent = tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            let frame = outsider_ws.next_frame().await;
            if frame["t"].as_str().is_some_and(|name| name.starts_with("GUILD_SCHEDULED_EVENT")) {
                return frame;
            }
        }
    })
    .await;
    assert!(silent.is_err(), "non-members get no event dispatches");
}

// ---- covers ----

fn png() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&4_u32.to_be_bytes());
    bytes.extend_from_slice(&3_u32.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

/// Uploads a PNG through `channel`; returns the attachment id.
async fn upload(app: &TestApp, token: &str, channel: &str) -> String {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cover.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(&png());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", token)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice::<Value>(&bytes).expect("json")["id"].as_str().expect("attachment id").to_owned()
}

fn api_path(url: &Value) -> String {
    url.as_str().expect("image url").strip_prefix("http://test.local/api/v1").expect("served by the test server").to_owned()
}

async fn with_cover(w: &World, attachment: &str, name: &str) -> (StatusCode, Value) {
    let body = json!({
        "name": name, "entity_type": 3, "entity_metadata": {"location": "x"}, "scheduled_start_time": in_hours(5), "scheduled_end_time": in_hours(6),
        "image_attachment_id": attachment
    });
    w.app.post(&w.path("/scheduled-events"), &w.owner, body).await
}

#[tokio::test]
async fn covers_belong_to_their_event_and_outlive_the_upload_channel() {
    let w = World::new().await;
    let (_, scratch) = {
        let (status, channel) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "scratch", "type": 0})).await;
        assert_eq!(status, StatusCode::OK);
        ((), channel["id"].as_str().expect("id").to_owned())
    };
    let first = upload(&w.app, &w.owner, &scratch).await;
    let (status, event) = with_cover(&w, &first, "With cover").await;
    assert_eq!(status, StatusCode::OK, "{event}");
    let cover = api_path(&event["image"]);
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::OK);

    // one upload, one event: it cannot serve twice
    let (status, error) = with_cover(&w, &first, "Reuse").await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");

    // deleting the channel the file came through leaves the cover alone
    assert_eq!(w.app.delete(&format!("/channels/{scratch}"), &w.owner).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::OK, "cover survives its upload channel");

    // a replaced cover is released, and so is the last one when the event goes
    let second = upload(&w.app, &w.owner, &w.channel).await;
    let (status, edited) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"image_attachment_id": second})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::NOT_FOUND, "the replaced cover is gone");
    let replacement = api_path(&edited["image"]);
    assert_eq!(w.app.get(&replacement, &w.owner).await.0, StatusCode::OK);
    let (_, cleared) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"image_attachment_id": null})).await;
    assert_eq!(cleared["image"], Value::Null);
    assert_eq!(w.app.get(&replacement, &w.owner).await.0, StatusCode::NOT_FOUND, "a cleared cover is gone");

    let third = upload(&w.app, &w.owner, &w.channel).await;
    let (_, again) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"image_attachment_id": third})).await;
    let last = api_path(&again["image"]);
    assert_eq!(w.app.delete(&event_path(&w, &event, ""), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&last, &w.owner).await.0, StatusCode::NOT_FOUND, "deleting the event deletes its cover");
}

#[tokio::test]
async fn deleting_a_guild_deletes_covers_uploaded_elsewhere() {
    let w = World::new().await;
    // the file goes through a channel of another guild
    let (_, other_channel) = w.app.guild_with_channel(&w.owner).await;
    let upload_id = upload(&w.app, &w.owner, &other_channel).await;
    let (status, event) = with_cover(&w, &upload_id, "Elsewhere").await;
    assert_eq!(status, StatusCode::OK, "{event}");
    let cover = api_path(&event["image"]);
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::OK);
    assert_eq!(w.app.delete(&w.path(""), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::NOT_FOUND);
}

// ---- channel visibility ----

const VIEW: u64 = 1 << 10;
const CONNECT_BIT: u64 = 1 << 20;

impl World {
    /// A voice channel that @everyone cannot see; `allowed` members get VIEW_CHANNEL | CONNECT through member overwrites.
    async fn private_voice(&self, name: &str, allowed: &[&str]) -> String {
        let mut overwrites = vec![json!({"id": self.guild, "type": 0, "allow": "0", "deny": VIEW.to_string()})];
        for user in allowed {
            overwrites.push(json!({"id": user, "type": 1, "allow": (VIEW | CONNECT_BIT).to_string(), "deny": "0"}));
        }
        let (status, channel) =
            self.app.post(&self.path("/channels"), &self.owner, json!({"name": name, "type": 2, "permission_overwrites": overwrites})).await;
        assert_eq!(status, StatusCode::OK, "{channel}");
        channel["id"].as_str().expect("id").to_owned()
    }

    async fn voice_event(&self, token: &str, channel: &str, name: &str) -> Value {
        let body = json!({"name": name, "entity_type": 2, "channel_id": channel, "scheduled_start_time": in_hours(3)});
        let (status, event) = self.app.post(&self.path("/scheduled-events"), token, body).await;
        assert_eq!(status, StatusCode::OK, "voice event: {event}");
        event
    }
}

fn names(list: &Value) -> Vec<String> {
    list.as_array().expect("list").iter().map(|e| e["name"].as_str().expect("name").to_owned()).collect()
}

#[tokio::test]
async fn events_in_a_hidden_voice_channel_are_hidden_over_rest() {
    let w = World::new().await;
    let (alice, _) = w.member("alice").await;
    let (carol, carol_id) = w.member("carol").await;
    let secret = w.private_voice("staff-voice", &[&carol_id]).await;
    let hidden = w.voice_event(&w.owner, &secret, "Staff sync").await;
    let open = w.external(&w.owner, "Open house").await;

    // the member who cannot view the channel sees only the external event, and every route on the hidden one says 10065
    let (_, list) = w.app.get(&w.path("/scheduled-events"), &alice).await;
    assert_eq!(names(&list), vec!["Open house"]);
    let (_, list) = w.app.get(&w.path("/scheduled-events"), &carol).await;
    assert_eq!(names(&list).len(), 2);
    for (what, status, error) in [
        ("get", w.app.get(&event_path(&w, &hidden, ""), &alice).await.0, w.app.get(&event_path(&w, &hidden, ""), &alice).await.1),
        ("users", w.app.get(&event_path(&w, &hidden, "/users"), &alice).await.0, w.app.get(&event_path(&w, &hidden, "/users"), &alice).await.1),
        ("interest", w.app.put(&event_path(&w, &hidden, "/users/@me"), &alice).await.0, w.app.put(&event_path(&w, &hidden, "/users/@me"), &alice).await.1),
        (
            "withdraw",
            w.app.delete(&event_path(&w, &hidden, "/users/@me"), &alice).await.0,
            w.app.delete(&event_path(&w, &hidden, "/users/@me"), &alice).await.1,
        ),
        (
            "edit",
            w.app.patch(&event_path(&w, &hidden, ""), &alice, json!({"name": "x"})).await.0,
            w.app.patch(&event_path(&w, &hidden, ""), &alice, json!({"name": "x"})).await.1,
        ),
        ("delete", w.app.delete(&event_path(&w, &hidden, ""), &alice).await.0, w.app.delete(&event_path(&w, &hidden, ""), &alice).await.1),
    ] {
        assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10065)), "{what}: {error}");
    }
    // the visible one is unaffected, and the viewer of the hidden channel can use theirs
    assert_eq!(w.app.put(&event_path(&w, &open, "/users/@me"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.put(&event_path(&w, &hidden, "/users/@me"), &carol).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&event_path(&w, &hidden, ""), &carol).await.1["user_count"], 1);

    // the owner (administrator by ownership) sees both; once the channel is deleted the event is only for its creator and managers
    assert_eq!(names(&w.app.get(&w.path("/scheduled-events"), &w.owner).await.1).len(), 2);
    assert_eq!(w.app.delete(&format!("/channels/{secret}"), &w.owner).await.0, StatusCode::OK);
    assert_eq!(names(&w.app.get(&w.path("/scheduled-events"), &carol).await.1), vec!["Open house"], "carol only saw it through the channel");
    assert_eq!(w.app.get(&event_path(&w, &hidden, ""), &carol).await.0, StatusCode::NOT_FOUND);
    let (status, orphan) = w.app.get(&event_path(&w, &hidden, ""), &w.owner).await;
    assert_eq!((status, orphan["channel_id"].clone()), (StatusCode::OK, Value::Null));
}

#[tokio::test]
async fn gateway_events_of_a_hidden_channel_reach_only_its_viewers() {
    let w = World::new().await;
    let address = w.app.serve().await;
    let (alice, _) = w.member("alice").await;
    let (carol, carol_id) = w.member("carol").await;
    let secret = w.private_voice("staff-voice", &[&carol_id]).await;
    let mut alice_ws = Client::identify(&address, &alice).await;
    let mut carol_ws = Client::identify(&address, &carol).await;

    let hidden = w.voice_event(&w.owner, &secret, "Staff sync").await;
    let open = w.external(&w.owner, "Open house").await;
    // carol hears both in order; alice's first create is the external one, so the hidden one was never sent to her
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_CREATE").await["id"], hidden["id"]);
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_CREATE").await["id"], open["id"]);
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_CREATE").await["id"], open["id"]);

    // interest in the hidden event is not announced to alice; the next announcement she gets is for the open one
    assert_eq!(w.app.put(&event_path(&w, &hidden, "/users/@me"), &carol).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.put(&event_path(&w, &open, "/users/@me"), &carol).await.0, StatusCode::NO_CONTENT);
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_USER_ADD").await["guild_scheduled_event_id"], hidden["id"]);
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_USER_ADD").await["guild_scheduled_event_id"], open["id"]);
    assert_eq!(w.app.delete(&event_path(&w, &hidden, "/users/@me"), &carol).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&event_path(&w, &open, "/users/@me"), &carol).await.0, StatusCode::NO_CONTENT);
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_USER_REMOVE").await["guild_scheduled_event_id"], hidden["id"]);
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_USER_REMOVE").await["guild_scheduled_event_id"], open["id"]);

    // update and delete follow the same rule
    assert_eq!(w.app.patch(&event_path(&w, &hidden, ""), &w.owner, json!({"name": "Staff sync 2"})).await.0, StatusCode::OK);
    assert_eq!(w.app.patch(&event_path(&w, &open, ""), &w.owner, json!({"name": "Open house 2"})).await.0, StatusCode::OK);
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_UPDATE").await["name"], "Staff sync 2");
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_UPDATE").await["name"], "Open house 2");
    assert_eq!(w.app.delete(&event_path(&w, &hidden, ""), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.delete(&event_path(&w, &open, ""), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_DELETE").await["id"], hidden["id"]);
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_DELETE").await["id"], open["id"]);
}

#[tokio::test]
async fn deleting_a_hidden_channel_tells_its_viewers_the_event_is_gone() {
    let w = World::new().await;
    let address = w.app.serve().await;
    let (carol, carol_id) = w.member("carol").await;
    let secret = w.private_voice("staff-voice", &[&carol_id]).await;
    let hidden = w.voice_event(&w.owner, &secret, "Staff sync").await;
    let mut carol_ws = Client::identify(&address, &carol).await;
    let mut owner_ws = Client::identify(&address, &w.owner).await;
    assert_eq!(w.app.delete(&format!("/channels/{secret}"), &w.owner).await.0, StatusCode::OK);
    // the creator keeps it (channel_id null); carol, who only saw it through the channel, is told it is gone
    let update = owner_ws.wait_for("GUILD_SCHEDULED_EVENT_UPDATE").await;
    assert_eq!((update["id"].clone(), update["channel_id"].clone()), (hidden["id"].clone(), Value::Null));
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_DELETE").await["id"], hidden["id"]);
}

// ---- edit rules ----

#[tokio::test]
async fn editing_an_event_whose_channel_was_removed_does_not_ask_for_a_channel() {
    let w = World::new().await;
    let voice = w.voice_channel().await;
    let event = w.voice_event(&w.owner, &voice, "Game night").await;
    assert_eq!(w.app.delete(&format!("/channels/{voice}"), &w.owner).await.0, StatusCode::OK);
    let (status, renamed) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"name": "Game night!", "description": "somewhere"})).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!((renamed["name"].clone(), renamed["channel_id"].clone()), (json!("Game night!"), Value::Null));
    // picking the entity again does need one, and an orphan cannot be started
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"entity_type": 2})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 2})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    assert_eq!(w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 4})).await.0, StatusCode::OK, "canceling needs no channel");
}

#[tokio::test]
async fn status_changes_need_connect_and_cannot_move_the_start() {
    let w = World::new().await;
    let voice = w.voice_channel().await;
    let event = w.voice_event(&w.owner, &voice, "Game night").await;
    let (bob, bob_id) = w.member("bob").await;
    let (_, role) = w.app.post(&w.path("/roles"), &w.owner, json!({"name": "events", "permissions": MANAGE_EVENTS.to_string()})).await;
    let role_id = role["id"].as_str().expect("role id");
    assert_eq!(w.app.patch(&w.path(&format!("/members/{bob_id}")), &w.owner, json!({"roles": [role_id]})).await.0, StatusCode::OK);
    // bob manages events and sees the channel, but may not connect to it
    let (status, _) =
        w.app.put_json(&format!("/channels/{voice}/permissions/{bob_id}"), &w.owner, json!({"type": 1, "allow": "0", "deny": CONNECT_BIT.to_string()})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        w.app.patch(&event_path(&w, &event, ""), &bob, json!({"name": "Renamed by bob"})).await.0,
        StatusCode::OK,
        "plain edits are not channel actions"
    );
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &bob, json!({"status": 2})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)), "{error}");
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &bob, json!({"status": 4})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)), "canceling is a status change too: {error}");

    // starting and moving the start in one request is refused, in either order of intent
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 2, "scheduled_start_time": in_hours(10)})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    let (_, unchanged) = w.app.get(&event_path(&w, &event, ""), &w.owner).await;
    assert_eq!(unchanged["status"], 1, "nothing was applied");
    // the same start time next to a status change is not a move
    let (status, started) =
        w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"status": 2, "scheduled_start_time": unchanged["scheduled_start_time"]})).await;
    assert_eq!((status, started["status"].clone()), (StatusCode::OK, json!(2)), "{started}");
}

#[tokio::test]
async fn the_open_event_limit_holds_under_concurrent_creates() {
    let w = World::new().await;
    for index in 0..99 {
        let body = json!({"name": format!("e{index}"), "entity_type": 3, "entity_metadata": {"location": "x"}, "scheduled_start_time": in_hours(5), "scheduled_end_time": in_hours(6)});
        assert_eq!(w.app.post(&w.path("/scheduled-events"), &w.owner, body).await.0, StatusCode::OK);
    }
    let body = |name: &str| json!({"name": name, "entity_type": 3, "entity_metadata": {"location": "x"}, "scheduled_start_time": in_hours(5), "scheduled_end_time": in_hours(6)});
    let path = w.path("/scheduled-events");
    let results = futures_util::future::join_all((0..6).map(|i| w.app.post(&path, &w.owner, body(&format!("race{i}"))))).await;
    let created = results.iter().filter(|(status, _)| *status == StatusCode::OK).count();
    assert_eq!(created, 1, "exactly one create takes the last slot: {:?}", results.iter().map(|(s, _)| s.as_u16()).collect::<Vec<_>>());
    assert!(results.iter().filter(|(status, _)| *status != StatusCode::OK).all(|(_, error)| error["code"] == 30038));
    assert_eq!(w.app.get(&path, &w.owner).await.1.as_array().expect("list").len(), 100);
}

// ---- covers shared with avatars, locks, moving an event ----

#[tokio::test]
async fn a_cover_and_an_avatar_never_share_an_upload() {
    let w = World::new().await;
    // cover first: the upload cannot become an avatar, so deleting the event cannot delete a file that is somebody's avatar
    let first = upload(&w.app, &w.owner, &w.channel).await;
    let (status, event) = with_cover(&w, &first, "Cover first").await;
    assert_eq!(status, StatusCode::OK, "{event}");
    let (status, error) = w.app.patch("/users/@me", &w.owner, json!({"avatar_attachment_id": first})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    let (status, error) = w.app.patch(&w.path(""), &w.owner, json!({"icon_attachment_id": first})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");

    // sending the event's own cover again is accepted and changes nothing
    let cover = api_path(&event["image"]);
    let (status, same) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"image_attachment_id": first, "name": "Renamed"})).await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(api_path(&same["image"]), cover);
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::OK, "the cover was not released by being sent again");

    // avatar first: the upload cannot become a cover
    let avatar = upload(&w.app, &w.owner, &w.channel).await;
    assert_eq!(w.app.patch("/users/@me", &w.owner, json!({"avatar_attachment_id": avatar})).await.0, StatusCode::OK);
    let (_, avatar_user) = w.app.get("/users/@me", &w.owner).await;
    let avatar_url = api_path(&avatar_user["avatar"]);
    let (status, error) = with_cover(&w, &avatar, "Avatar as cover").await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"image_attachment_id": avatar})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");

    // the event goes with its cover; the avatar stays
    assert_eq!(w.app.delete(&event_path(&w, &event, ""), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.get(&avatar_url, &w.owner).await.0, StatusCode::OK, "the avatar's file is untouched");
}

#[tokio::test]
async fn a_failed_write_rolls_the_cover_claim_back() {
    let w = World::new().await;
    // the insert/update itself fails, after the claim has been made: the database refuses this one name
    sqlx::query("ALTER TABLE scheduled_events ADD CONSTRAINT refuse_explode CHECK (name <> 'explode')").execute(&w.app.state.db).await.expect("constraint");

    // create: the upload is not left claimed (it still serves as an avatar)
    let spare = upload(&w.app, &w.owner, &w.channel).await;
    let (status, error) = with_cover(&w, &spare, "explode").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{error}");
    assert_eq!(w.app.patch("/users/@me", &w.owner, json!({"avatar_attachment_id": spare})).await.0, StatusCode::OK, "the failed create claimed nothing");

    // edit: the event keeps its cover, and the new upload is not left claimed
    let first = upload(&w.app, &w.owner, &w.channel).await;
    let (status, event) = with_cover(&w, &first, "Kept").await;
    assert_eq!(status, StatusCode::OK, "{event}");
    let cover = api_path(&event["image"]);
    let next = upload(&w.app, &w.owner, &w.channel).await;
    let (status, error) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"name": "explode", "image_attachment_id": next})).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{error}");
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::OK, "the old cover is still served");
    let (_, unchanged) = w.app.get(&event_path(&w, &event, ""), &w.owner).await;
    assert_eq!((unchanged["name"].clone(), api_path(&unchanged["image"])), (json!("Kept"), cover));
    let (status, replaced) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"image_attachment_id": next})).await;
    assert_eq!(status, StatusCode::OK, "the new upload was still free to claim: {replaced}");
}

#[tokio::test]
async fn concurrent_cover_replacements_leave_exactly_one_cover() {
    let w = World::new().await;
    let first = upload(&w.app, &w.owner, &w.channel).await;
    let (_, event) = with_cover(&w, &first, "Race").await;
    let old = api_path(&event["image"]);
    let (a, b) = (upload(&w.app, &w.owner, &w.channel).await, upload(&w.app, &w.owner, &w.channel).await);
    let path = event_path(&w, &event, "");
    let (left, right) =
        tokio::join!(w.app.patch(&path, &w.owner, json!({"image_attachment_id": a})), w.app.patch(&path, &w.owner, json!({"image_attachment_id": b})));
    assert_eq!((left.0, right.0), (StatusCode::OK, StatusCode::OK), "{} {}", left.1, right.1);
    let (_, now) = w.app.get(&path, &w.owner).await;
    assert_eq!(w.app.get(&old, &w.owner).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.get(&api_path(&now["image"]), &w.owner).await.0, StatusCode::OK, "the winner's cover is served");
    // the loser's file went with the cover it was replaced by: no claimed upload is left that no event points at
    let (leftover,): (i64,) = sqlx::query_as("SELECT count(*) FROM attachments WHERE event_cover").fetch_one(&w.app.state.db).await.expect("count");
    assert_eq!(leftover, 1);
}

#[tokio::test]
async fn deleting_threads_channels_and_guilds_keeps_claimed_covers() {
    let w = World::new().await;
    let (_, side) = w.app.post(&w.path("/channels"), &w.owner, json!({"name": "side", "type": 0})).await;
    let side = side["id"].as_str().expect("id").to_owned();
    let thread = |parent: String, name: &'static str| {
        let w = &w;
        async move {
            let (status, message) = w.app.post(&format!("/channels/{parent}/messages"), &w.owner, json!({"content": name})).await;
            assert_eq!(status, StatusCode::OK, "{message}");
            let mid = message["id"].as_str().expect("id").to_owned();
            let (status, thread) = w.app.post(&format!("/channels/{parent}/messages/{mid}/threads"), &w.owner, json!({"name": name})).await;
            assert_eq!(status, StatusCode::OK, "{thread}");
            mid
        }
    };
    let cover_through = |channel: String, name: &'static str| {
        let w = &w;
        async move {
            let attachment = upload(&w.app, &w.owner, &channel).await;
            let (status, event) = with_cover(w, &attachment, name).await;
            assert_eq!(status, StatusCode::OK, "{event}");
            api_path(&event["image"])
        }
    };

    // a thread deleted on its own, and threads that go with their deleted parent channel
    let lone = thread(w.channel.clone(), "lone").await;
    let under_side = thread(side.clone(), "under side").await;
    let (lone_cover, side_cover) = (cover_through(lone.clone(), "Via thread").await, cover_through(under_side.clone(), "Via thread of side").await);
    assert_eq!(w.app.delete(&format!("/channels/{lone}"), &w.owner).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&lone_cover, &w.owner).await.0, StatusCode::OK, "deleting the thread keeps the cover");
    assert_eq!(w.app.delete(&format!("/channels/{side}"), &w.owner).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&side_cover, &w.owner).await.0, StatusCode::OK, "deleting the parent channel keeps the cover of its thread");

    // another guild's channel: deleting that guild leaves this guild's cover alone
    let (other, other_channel) = w.app.guild_with_channel(&w.owner).await;
    let elsewhere = cover_through(other_channel, "Via another guild").await;
    assert_eq!(w.app.delete(&format!("/guilds/{other}"), &w.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.get(&elsewhere, &w.owner).await.0, StatusCode::OK, "deleting the guild the file came through keeps the cover");
}

#[tokio::test]
async fn a_claimed_upload_cannot_be_attached_to_a_message() {
    let w = World::new().await;
    let attachment = upload(&w.app, &w.owner, &w.channel).await;
    let (status, event) = with_cover(&w, &attachment, "Cover").await;
    assert_eq!(status, StatusCode::OK, "{event}");
    let cover = api_path(&event["image"]);
    // an avatar is claimed too
    let avatar = upload(&w.app, &w.owner, &w.channel).await;
    assert_eq!(w.app.patch("/users/@me", &w.owner, json!({"avatar_attachment_id": avatar})).await.0, StatusCode::OK);
    for claimed in [&attachment, &avatar] {
        let (status, error) = w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": "mine", "attachment_ids": [claimed]})).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    }
    // so deleting messages cannot take the cover's file with it, and the cover is still served
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", w.channel), &w.owner).await;
    assert!(messages.as_array().expect("messages").iter().all(|m| m["attachments"].as_array().is_none_or(Vec::is_empty)));
    assert_eq!(w.app.get(&cover, &w.owner).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_event_limit_lock_does_not_block_new_channels() {
    let w = World::new().await;
    // a create in flight holds the guild row; adding a channel (which only references it) must not wait for it
    let mut tx = w.app.state.db.begin().await.expect("tx");
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR NO KEY UPDATE").bind(w.guild.parse::<i64>().expect("id")).execute(&mut *tx).await.expect("lock");
    let created = tokio::time::timeout(common::WAIT, w.app.post(&w.path("/channels"), &w.owner, json!({"name": "more", "type": 0})))
        .await
        .expect("channel creation waited for the event lock");
    assert_eq!(created.0, StatusCode::OK, "{}", created.1);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn moving_an_event_into_a_hidden_channel_tells_the_old_viewers_it_is_gone() {
    let w = World::new().await;
    let address = w.app.serve().await;
    let (alice, _) = w.member("alice").await;
    let (carol, carol_id) = w.member("carol").await;
    let voice = w.voice_channel().await;
    let secret = w.private_voice("staff-voice", &[&carol_id]).await;
    let event = w.voice_event(&w.owner, &voice, "Game night").await;
    let mut alice_ws = Client::identify(&address, &alice).await;
    let mut carol_ws = Client::identify(&address, &carol).await;

    let (status, moved) = w.app.patch(&event_path(&w, &event, ""), &w.owner, json!({"channel_id": secret})).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    // alice saw it in the public channel and cannot see the new one; carol sees it either way
    assert_eq!(alice_ws.wait_for("GUILD_SCHEDULED_EVENT_DELETE").await["id"], event["id"]);
    assert_eq!(carol_ws.wait_for("GUILD_SCHEDULED_EVENT_UPDATE").await["channel_id"], json!(secret));
    assert!(names(&w.app.get(&w.path("/scheduled-events"), &alice).await.1).is_empty());
}

#[tokio::test]
async fn two_managers_changing_the_status_at_once_cannot_both_win() {
    let w = World::new().await;
    let event = w.external(&w.owner, "Contested").await;
    let path = event_path(&w, &event, "");
    for _ in 0..5 {
        let event = w.external(&w.owner, "Contested").await;
        let path = event_path(&w, &event, "");
        let (start, cancel) = tokio::join!(w.app.patch(&path, &w.owner, json!({"status": 2})), w.app.patch(&path, &w.owner, json!({"status": 4})));
        let wins = [start.0, cancel.0].iter().filter(|status| **status == StatusCode::OK).count();
        assert_eq!(wins, 1, "start: {} {} / cancel: {} {}", start.0, start.1, cancel.0, cancel.1);
        let (_, now) = w.app.get(&path, &w.owner).await;
        let expected = if start.0 == StatusCode::OK { 2 } else { 4 };
        assert_eq!(now["status"], expected, "the stored status is the winner's, never a canceled event started afterwards");
    }
    // the untouched one is still open
    assert_eq!(w.app.get(&path, &w.owner).await.1["status"], 1);
}
