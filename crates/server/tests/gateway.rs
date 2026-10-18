#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
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
    async fn connect(address: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        Self { ws }
    }

    async fn send(&mut self, value: Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send frame");
    }

    /// Next text frame, or `Err(close code)` when the server closes.
    async fn recv(&mut self) -> Result<Value, Option<u16>> {
        loop {
            match tokio::time::timeout(common::WAIT, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return Ok(serde_json::from_str(&text).expect("json frame")),
                Ok(Some(Ok(Message::Close(frame)))) => return Err(frame.map(|frame| u16::from(frame.code))),
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => return Err(None),
                Err(_) => panic!("timed out waiting for a gateway frame"),
            }
        }
    }

    async fn hello(&mut self) -> Value {
        let frame = self.recv().await.expect("hello");
        assert_eq!(frame["op"], 10);
        frame["d"].clone()
    }

    async fn identify(&mut self, token: &str) -> Value {
        self.hello().await;
        self.send(json!({"op": 2, "d": {"token": token}})).await;
        self.wait_for("READY").await
    }

    /// Skips unrelated dispatches until `name` arrives; returns the whole payload.
    async fn wait_for_payload(&mut self, name: &str) -> Value {
        loop {
            let frame = self.recv().await.unwrap_or_else(|code| panic!("closed ({code:?}) while waiting for {name}"));
            if frame["op"] == 0 && frame["t"] == name {
                return frame;
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        self.wait_for_payload(name).await["d"].clone()
    }

    /// True if no dispatch named `name` arrives within `window`.
    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Some(Ok(Message::Text(text))) = next {
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
    address: String,
    owner: String,
    member: String,
    outsider: String,
    channel: String,
}

async fn world() -> World {
    world_with_heartbeat(60_000).await
}

async fn world_with_heartbeat(interval_ms: u64) -> World {
    world_with_config(move |config| config.heartbeat_interval_ms = interval_ms).await
}

async fn world_with_config(adjust: impl FnOnce(&mut vokko_server::Config)) -> World {
    let app = TestApp::with_config(adjust).await;
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (member, _) = app.register("alice").await;
    let (outsider, _) = app.register("bob").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Gateway guild"})).await;
    let guild_id = guild["id"].as_str().expect("id").to_owned();
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    let channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    World { app, address, owner, member, outsider, channel }
}

#[tokio::test]
async fn login_send_and_gateway_receive() {
    let w = world().await;
    // login over REST like a real client
    let (status, login) = w.app.send(axum::http::Method::POST, "/auth/login", None, Some(json!({"login": "alice", "password": "correct horse battery"}))).await;
    assert_eq!(status, 200);
    let member_token = login["token"].as_str().expect("token").to_owned();

    let mut alice = Client::connect(&w.address).await;
    let hello = alice.hello().await;
    assert_eq!(hello["heartbeat_interval"], 60_000);
    alice.send(json!({"op": 2, "d": {"token": member_token}})).await;
    let ready_frame = alice.wait_for_payload("READY").await;
    assert_eq!(ready_frame["s"], 1);
    let ready = &ready_frame["d"];
    assert_eq!(ready["v"], 1);
    assert_eq!(ready["user"]["username"], "alice");
    assert!(ready["session_id"].is_string());
    assert_eq!(ready["guilds"][0]["name"], "Gateway guild");
    assert_eq!(ready["guilds"][0]["member_count"], 2);
    assert!(ready["guilds"][0]["channels"].as_array().expect("channels").len() >= 4);

    let mut bob = Client::connect(&w.address).await;
    bob.identify(&w.outsider).await;

    let (status, sent) = w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": "hello gateway", "nonce": "abc"})).await;
    assert_eq!(status, 200);

    let frame = alice.wait_for_payload("MESSAGE_CREATE").await;
    assert!(frame["s"].as_u64().expect("seq") > 1, "sequence numbers increase after READY");
    assert_eq!(frame["d"]["id"], sent["id"]);
    assert_eq!(frame["d"]["content"], "hello gateway");
    assert_eq!(frame["d"]["author"]["username"], "sam");
    assert_eq!(frame["d"]["nonce"], "abc");
    // not a member: nothing is delivered
    assert!(bob.silent_for("MESSAGE_CREATE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn reaction_events_carry_the_type() {
    let w = world().await;
    let mut alice = Client::connect(&w.address).await;
    alice.identify(&w.member).await;
    let (_, sent) = w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": "react"})).await;
    let base = format!("/channels/{}/messages/{}/reactions/%F0%9F%8E%89/@me", w.channel, sent["id"].as_str().expect("id"));

    assert_eq!(w.app.put(&format!("{base}?type=1"), &w.owner).await.0, 204);
    let add = alice.wait_for("MESSAGE_REACTION_ADD").await;
    assert_eq!((add["type"].clone(), add["burst"].clone(), add["emoji"]["name"].clone()), (json!(1), json!(true), json!("🎉")));
    // The message author rides along on adds (reaction notifications), not on removes.
    assert_eq!(add["message_author_id"], sent["author"]["id"]);
    assert_eq!(w.app.put(&base, &w.owner).await.0, 204);
    let add = alice.wait_for("MESSAGE_REACTION_ADD").await;
    assert_eq!((add["type"].clone(), add["burst"].clone()), (json!(0), json!(false)));

    assert_eq!(w.app.delete(&format!("{base}?type=1"), &w.owner).await.0, 204);
    let removed = alice.wait_for("MESSAGE_REACTION_REMOVE").await;
    assert_eq!((removed["type"].clone(), removed["burst"].clone()), (json!(1), json!(true)));
    assert!(removed.get("message_author_id").is_none());
    // deleting a burst that is not there sends nothing
    assert_eq!(w.app.delete(&format!("{base}?type=1"), &w.owner).await.0, 204);
    assert!(alice.silent_for("MESSAGE_REACTION_REMOVE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn resume_replays_missed_events() {
    let w = world().await;
    let mut alice = Client::connect(&w.address).await;
    let ready = alice.identify(&w.member).await;
    let session_id = ready["session_id"].as_str().expect("session").to_owned();
    let mut last_seq = 1;

    // one live event, then the socket drops
    w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": "live"})).await;
    let live = alice.wait_for_payload("MESSAGE_CREATE").await;
    last_seq = last_seq.max(live["s"].as_u64().expect("seq"));
    drop(alice);
    tokio::time::sleep(Duration::from_millis(100)).await;

    for content in ["missed one", "missed two"] {
        w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": content})).await;
    }

    let mut again = Client::connect(&w.address).await;
    again.hello().await;
    again.send(json!({"op": 6, "d": {"token": w.member, "session_id": session_id, "seq": last_seq}})).await;
    let first = again.wait_for_payload("MESSAGE_CREATE").await;
    let second = again.wait_for_payload("MESSAGE_CREATE").await;
    assert_eq!(first["d"]["content"], "missed one");
    assert_eq!(second["d"]["content"], "missed two");
    let (first_seq, second_seq) = (first["s"].as_u64().expect("seq"), second["s"].as_u64().expect("seq"));
    assert!(first_seq > last_seq && second_seq > first_seq, "replayed in order after the last seen sequence");
    again.wait_for("RESUMED").await;

    // and the session keeps working
    w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": "after resume"})).await;
    assert_eq!(again.wait_for("MESSAGE_CREATE").await["content"], "after resume");

    // unknown session → InvalidSession
    let mut stranger = Client::connect(&w.address).await;
    stranger.hello().await;
    stranger.send(json!({"op": 6, "d": {"token": w.member, "session_id": "nope", "seq": 1}})).await;
    assert_eq!(stranger.recv().await.expect("frame")["op"], 9);
    // someone else's token cannot resume it
    stranger.send(json!({"op": 6, "d": {"token": w.outsider, "session_id": session_id, "seq": 1}})).await;
    assert_eq!(stranger.recv().await.expect("frame")["op"], 9);
}

/// Messages keep arriving while the resume is processed: every dispatch comes exactly once, in sequence order, RESUMED included.
#[tokio::test]
async fn resume_during_live_traffic_has_no_duplicates_or_reordering() {
    let w = world().await;
    let mut alice = Client::connect(&w.address).await;
    let ready = alice.identify(&w.member).await;
    let session_id = ready["session_id"].as_str().expect("session").to_owned();
    drop(alice);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let path = format!("/channels/{}/messages", w.channel);
    for index in 0..20 {
        w.app.post(&path, &w.owner, json!({"content": format!("m-{index}")})).await;
    }
    let poster = async {
        for index in 20..50 {
            w.app.post(&path, &w.owner, json!({"content": format!("m-{index}")})).await;
        }
    };
    let reader = async {
        let mut again = Client::connect(&w.address).await;
        again.hello().await;
        again.send(json!({"op": 6, "d": {"token": w.member, "session_id": session_id, "seq": 1}})).await;
        let mut seqs = Vec::new();
        let mut contents = Vec::new();
        let mut resumed_at = None;
        while contents.len() < 50 {
            let frame = again.recv().await.expect("frame");
            assert_eq!(frame["op"], 0, "{frame}");
            let seq = frame["s"].as_u64().expect("seq");
            match frame["t"].as_str().expect("event") {
                "MESSAGE_CREATE" => contents.push(frame["d"]["content"].as_str().expect("content").to_owned()),
                "RESUMED" => resumed_at = Some(seqs.len()),
                _ => {}
            }
            seqs.push(seq);
        }
        (seqs, contents, resumed_at)
    };
    let (_, (seqs, contents, resumed_at)) = tokio::join!(poster, reader);

    let expected: Vec<u64> = (seqs[0]..seqs[0] + seqs.len() as u64).collect();
    assert_eq!(seqs, expected, "consecutive sequence numbers, no repeats");
    assert_eq!(seqs[0], 2, "starts right after the last sequence the client had");
    let wanted: Vec<String> = (0..50).map(|index| format!("m-{index}")).collect();
    assert_eq!(contents, wanted, "every message once, in order");
    assert!(resumed_at.is_some_and(|at| at >= 20), "RESUMED follows the replayed backlog: {resumed_at:?}");
}

#[tokio::test]
async fn a_resume_gap_is_invalid_session_and_ends_the_old_connection() {
    let w = world_with_config(|config| config.replay_capacity = 5).await;
    let mut old = Client::connect(&w.address).await;
    let ready = old.identify(&w.member).await;
    let session_id = ready["session_id"].as_str().expect("session").to_owned();
    for index in 0..10 {
        w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": format!("m-{index}")})).await;
    }
    // the replay buffer (5) no longer reaches back to seq 1, while the old socket is still attached
    let mut late = Client::connect(&w.address).await;
    late.hello().await;
    late.send(json!({"op": 6, "d": {"token": w.member, "session_id": session_id, "seq": 1}})).await;
    assert_eq!(late.recv().await.expect("frame")["op"], 9);
    loop {
        match old.recv().await {
            Ok(_) => continue,
            Err(code) => {
                assert_eq!(code, Some(4000), "the old connection is closed like a replaced one");
                break;
            }
        }
    }
    // the session is gone for good
    late.send(json!({"op": 6, "d": {"token": w.member, "session_id": session_id, "seq": 100}})).await;
    assert_eq!(late.recv().await.expect("frame")["op"], 9);
}

#[tokio::test]
async fn bad_token_and_heartbeats() {
    let w = world_with_heartbeat(400).await;
    let mut bad = Client::connect(&w.address).await;
    bad.hello().await;
    bad.send(json!({"op": 2, "d": {"token": "wrong"}})).await;
    assert_eq!(bad.recv().await.expect_err("closed"), Some(4004));

    // heartbeats are acknowledged
    let mut client = Client::connect(&w.address).await;
    client.identify(&w.member).await;
    client.send(json!({"op": 1, "d": 1})).await;
    let mut acked = false;
    for _ in 0..5 {
        if client.recv().await.expect("frame")["op"] == 11 {
            acked = true;
            break;
        }
    }
    assert!(acked, "op 11 after op 1");

    // ... and silence ends in close code 4009 (interval is 400 ms in tests)
    let mut silent = Client::connect(&w.address).await;
    silent.identify(&w.owner).await;
    loop {
        match silent.recv().await {
            Err(code) => {
                assert_eq!(code, Some(4009));
                break;
            }
            Ok(_) => continue,
        }
    }
}

#[tokio::test]
async fn presence_follows_connections_and_typing_is_relayed() {
    let w = world().await;
    let mut owner = Client::connect(&w.address).await;
    owner.identify(&w.owner).await;
    let mut alice = Client::connect(&w.address).await;
    let ready = alice.identify(&w.member).await;
    let owner_presence = ready["presences"].as_array().expect("presences").iter().find(|p| p["status"] == "online").cloned();
    assert!(owner_presence.is_some(), "owner is already online in alice's READY");

    w.app.post(&format!("/channels/{}/typing", w.channel), &w.owner, json!({})).await;
    let typing = alice.wait_for("TYPING_START").await;
    assert_eq!(typing["channel_id"], w.channel);
    assert!(typing["timestamp"].is_u64());

    // alice goes away → owner sees offline
    alice.send(json!({"op": 1, "d": null})).await;
    drop(alice);
    let update = loop {
        let frame = owner.recv().await.expect("frame");
        if frame["t"] == "PRESENCE_UPDATE" && frame["d"]["status"] == "offline" {
            break frame;
        }
    };
    assert_eq!(update["d"]["custom_status"], Value::Null);
}

#[tokio::test]
async fn blocking_is_announced_to_the_blocker_and_hides_the_friendship_from_the_blocked() {
    let w = world().await;
    let (_, owner_user) = w.app.get("/users/@me", &w.owner).await;
    let (_, member_user) = w.app.get("/users/@me", &w.member).await;
    let (owner_id, member_id) = (owner_user["id"].as_str().expect("id"), member_user["id"].as_str().expect("id"));
    let mut owner = Client::connect(&w.address).await;
    owner.identify(&w.owner).await;
    let mut alice = Client::connect(&w.address).await;
    alice.identify(&w.member).await;

    w.app.post("/users/@me/relationships", &w.owner, json!({"username": "alice"})).await;
    w.app.put(&format!("/users/@me/relationships/{owner_id}"), &w.member).await;
    assert_eq!(owner.wait_for("RELATIONSHIP_ADD").await["type"], 4);
    assert_eq!(owner.wait_for("RELATIONSHIP_ADD").await["type"], 1);
    assert_eq!(alice.wait_for("RELATIONSHIP_ADD").await["type"], 3);
    assert_eq!(alice.wait_for("RELATIONSHIP_ADD").await["type"], 1);

    let (status, _) = w.app.put_json(&format!("/users/@me/relationships/{member_id}"), &w.owner, json!({"type": 2})).await;
    assert_eq!(status, 204);
    let added = owner.wait_for("RELATIONSHIP_ADD").await;
    assert_eq!((added["id"].as_str(), added["type"].as_u64()), (Some(member_id), Some(2)));
    assert_eq!(added["user"]["username"], "alice");
    let removed = alice.wait_for("RELATIONSHIP_REMOVE").await;
    assert_eq!(removed, json!({"id": owner_id}));
    assert!(alice.silent_for("RELATIONSHIP_ADD", Duration::from_millis(300)).await, "the blocked user is never told about the block");

    // unblocking only concerns the blocker
    w.app.delete(&format!("/users/@me/relationships/{member_id}"), &w.owner).await;
    assert_eq!(owner.wait_for("RELATIONSHIP_REMOVE").await, json!({"id": member_id}));
    assert!(alice.silent_for("RELATIONSHIP_REMOVE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn link_embeds_follow_the_message_as_message_update() {
    let app = TestApp::with_config(|config| {
        config.heartbeat_interval_ms = 60_000;
        config.unfurl.enabled = true;
        config.unfurl.allow_private = true;
    })
    .await;
    let address = app.serve().await;
    let pages = common::PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let mut client = Client::connect(&address).await;
    client.identify(&token).await;

    let (_, sent) = app.post(&format!("/channels/{channel}/messages"), &token, json!({"content": format!("see {}", pages.url("/page"))})).await;
    let created = client.wait_for("MESSAGE_CREATE").await;
    assert_eq!(created["id"], sent["id"]);
    assert_eq!(created["author"]["username"], "sam", "MESSAGE_CREATE always carries the author");
    assert_eq!(created["embeds"], json!([]));

    let updated = client.wait_for("MESSAGE_UPDATE").await;
    assert_eq!(updated["id"], sent["id"]);
    assert_eq!(updated["content"], created["content"], "MESSAGE_UPDATE carries the whole message");
    assert_eq!(updated["author"]["username"], "sam");
    assert_eq!(updated["embeds"][0]["title"], "Vokko & friends");
    assert_eq!(updated["embeds"][0]["url"], pages.url("/page"));
    assert_eq!(updated["edited_timestamp"], Value::Null, "an unfurl is not an edit");
}

/// Waits for the server to close the connection; returns the close code.
async fn closed_with(client: &mut Client) -> Option<u16> {
    loop {
        match client.recv().await {
            Ok(_) => continue,
            Err(code) => return code,
        }
    }
}

fn presence(status: &str, custom_status: &str) -> Value {
    json!({"op": 3, "d": {"status": status, "custom_status": custom_status}})
}

#[tokio::test]
async fn invalid_activities_are_a_decode_error() {
    let w = world().await;
    let too_many = json!([{"name": "A", "type": 0}, {"name": "B", "type": 0}]);
    let streaming = json!([{"name": "A", "type": 1}]);
    let blank = json!([{"name": "  ", "type": 0}]);
    let long = json!([{"name": "x".repeat(129), "type": 0}]);
    let newline = json!([{"name": "A\nB", "type": 0}]);
    let zero_width = json!([{"name": "\u{200B}", "type": 0}]);
    let bidi = json!([{"name": "\u{202E}gnihtemos", "type": 0}]);
    let negative_start = json!([{"name": "A", "type": 0, "timestamps": {"start": -1}}]);
    for activities in [too_many, streaming, blank, long, newline, zero_width, bidi, negative_start] {
        let mut client = Client::connect(&w.address).await;
        client.identify(&w.member).await;
        client.send(json!({"op": 3, "d": {"status": "online", "activities": activities}})).await;
        assert_eq!(closed_with(&mut client).await, Some(4002), "{activities}");
    }
}

#[tokio::test]
async fn invalid_spotify_activities_are_a_decode_error() {
    let w = world().await;
    let spotify = json!({"name": "Spotify", "type": 2, "details": "Song", "state": "Artist", "sync_id": "4uLU6hMCjMI75M1A2tKUQC",
        "assets": {"large_image": format!("spotify:{}", "ab".repeat(20))}, "timestamps": {"start": 1000, "end": 2000}});
    let with = |key: &str, value: Value| {
        let mut changed = spotify.clone();
        changed[key] = value;
        json!([changed])
    };
    let two_games_of_a_kind = json!([spotify, spotify]);
    let not_spotify = json!([{"name": "Apple Music", "type": 2}]);
    let blank_title = with("details", json!(" "));
    let bad_image = with("assets", json!({"large_image": "https://i.scdn.co/image/ab"}));
    let bad_track = with("sync_id", json!("short"));
    let end_before_start = with("timestamps", json!({"start": 2000, "end": 1000}));
    let game_with_title = json!([{"name": "A", "type": 0, "details": "x"}]);
    for activities in [two_games_of_a_kind, not_spotify, blank_title, bad_image, bad_track, end_before_start, game_with_title] {
        let mut client = Client::connect(&w.address).await;
        client.identify(&w.member).await;
        client.send(json!({"op": 3, "d": {"status": "online", "activities": activities}})).await;
        assert_eq!(closed_with(&mut client).await, Some(4002), "{activities}");
    }
}

#[tokio::test]
async fn presence_updates_are_bounded_in_size_and_rate() {
    let w = world().await;
    let mut client = Client::connect(&w.address).await;
    client.identify(&w.member).await;

    // the longest allowed custom status is accepted and echoed to the user's own sessions
    client.send(presence("idle", &"x".repeat(128))).await;
    let update = loop {
        let update = client.wait_for("PRESENCE_UPDATE").await;
        if update["status"] == "idle" {
            break update;
        }
    };
    assert_eq!(update["custom_status"].as_str().map(str::len), Some(128));
    // one more character is a decode error
    client.send(presence("idle", &"x".repeat(129))).await;
    assert_eq!(closed_with(&mut client).await, Some(4002));

    // a frame beyond 16 KiB ends the connection before it is parsed
    let mut big = Client::connect(&w.address).await;
    big.identify(&w.member).await;
    big.send(presence("online", &"y".repeat(20 * 1024))).await;
    // (a dispatch of the other session's update may still arrive first)
    closed_with(&mut big).await;

    // five updates per minute per session, the sixth is rate limited (4008)
    let mut chatty = Client::connect(&w.address).await;
    chatty.identify(&w.member).await;
    for n in 0..6 {
        chatty.send(presence("online", &format!("round {n}"))).await;
    }
    assert_eq!(closed_with(&mut chatty).await, Some(4008));
}

#[tokio::test]
async fn identifies_are_throttled_per_user() {
    let w = world_with_config(|config| config.identify_per_minute = 2).await;
    for _ in 0..2 {
        let mut client = Client::connect(&w.address).await;
        client.identify(&w.member).await;
    }
    let mut third = Client::connect(&w.address).await;
    third.hello().await;
    third.send(json!({"op": 2, "d": {"token": w.member}})).await;
    assert_eq!(third.recv().await.expect_err("closed"), Some(4008));
    // another user has their own allowance
    let mut other = Client::connect(&w.address).await;
    other.identify(&w.owner).await;
}

#[tokio::test]
async fn unidentified_sockets_are_capped_per_address() {
    // A window nothing here waits for: with a short one the first socket could time out before it identifies on a busy machine.
    let w = world_with_config(|config| {
        config.max_preauth_per_ip = 2;
        config.handshake_timeout = Duration::from_secs(60);
    })
    .await;
    let mut first = Client::connect(&w.address).await;
    first.hello().await;
    let mut second = Client::connect(&w.address).await;
    second.hello().await;
    let refused = connect_async(format!("ws://{}/gateway", w.address)).await;
    assert!(refused.is_err(), "the third unidentified socket is refused");

    // identifying frees the slot
    first.send(json!({"op": 2, "d": {"token": w.member}})).await;
    first.wait_for("READY").await;
    let mut third = loop {
        match connect_async(format!("ws://{}/gateway", w.address)).await {
            Ok((ws, _)) => break Client { ws },
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    };
    third.hello().await;
}

#[tokio::test]
async fn an_unidentified_socket_is_dropped_when_the_window_ends() {
    let w = world_with_config(|config| config.handshake_timeout = Duration::from_millis(1500)).await;
    let mut socket = Client::connect(&w.address).await;
    socket.hello().await;
    assert!(socket.recv().await.is_err());
}

#[tokio::test]
async fn logout_closes_that_tokens_gateway_sessions_only() {
    let w = world().await;
    let (status, login) = w.app.send(axum::http::Method::POST, "/auth/login", None, Some(json!({"login": "alice", "password": "correct horse battery"}))).await;
    assert_eq!(status, 200);
    let second_token = login["token"].as_str().expect("token").to_owned();

    let mut kept = Client::connect(&w.address).await;
    kept.identify(&w.member).await;
    let mut ended = Client::connect(&w.address).await;
    let ready = ended.identify(&second_token).await;
    let ended_session = ready["session_id"].as_str().expect("session").to_owned();

    assert_eq!(w.app.post("/auth/logout", &second_token, json!({})).await.0, 204);
    assert_eq!(closed_with(&mut ended).await, Some(4004));
    assert!(w.app.state.hub.session(&ended_session).is_none(), "the session cannot be resumed either");

    w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": "still here"})).await;
    assert_eq!(kept.wait_for("MESSAGE_CREATE").await["content"], "still here");
}

#[tokio::test]
async fn a_client_that_stops_reading_is_dropped_without_blocking_the_server() {
    let w = world_with_config(|config| config.write_timeout = Duration::from_millis(500)).await;
    let (_, member) = w.app.get("/users/@me", &w.member).await;
    let member_id: i64 = member["id"].as_str().expect("id").parse().expect("snowflake");

    // a client with a tiny receive buffer that reads READY and then never reads again
    let socket = tokio::net::TcpSocket::new_v4().expect("socket");
    socket.set_recv_buffer_size(4096).expect("buffer size");
    let stream = socket.connect(w.address.parse().expect("address")).await.expect("connect");
    let (ws, _) = tokio_tungstenite::client_async(format!("ws://{}/gateway", w.address), MaybeTlsStream::Plain(stream)).await.expect("handshake");
    let mut slow = Client { ws };
    slow.identify(&w.member).await;
    let deadline = tokio::time::Instant::now() + common::WAIT;
    while tokio::time::Instant::now() < deadline {
        if w.app.state.hub.is_online(member_id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(w.app.state.hub.is_online(member_id));

    // the rest of the server keeps working while events pile up for it
    let filler = "x".repeat(2000);
    let mut dropped = false;
    for _ in 0..1500 {
        let (status, _) = w.app.post(&format!("/channels/{}/messages", w.channel), &w.owner, json!({"content": filler})).await;
        assert_eq!(status, 200);
        if !w.app.state.hub.is_online(member_id) {
            dropped = true;
            break;
        }
    }
    let deadline = tokio::time::Instant::now() + common::WAIT;
    while tokio::time::Instant::now() < deadline {
        if dropped || !w.app.state.hub.is_online(member_id) {
            dropped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(dropped, "the stalled connection was closed by the write timeout");
}

#[tokio::test]
async fn client_close_is_answered_with_a_close_frame() {
    let w = world().await;
    let mut client = Client::connect(&w.address).await;
    client.identify(&w.member).await;
    client.ws.send(Message::Close(None)).await.expect("send close");
    loop {
        match tokio::time::timeout(common::WAIT, client.ws.next()).await.expect("server answers") {
            Some(Ok(Message::Close(_))) => break,
            Some(Ok(_)) => continue,
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn desktop_release_reaches_every_session() {
    let w = world_with_config(|config| config.desktop_latest_json = Some(config.data_dir.join("latest.json"))).await;
    let manifest = w.app.state.config.desktop_latest_json.clone().expect("configured");
    let mut alice = Client::connect(&w.address).await;
    assert!(alice.identify(&w.member).await.get("desktop_version").is_none(), "no file yet, no field");

    std::fs::write(&manifest, r#"{"version":"0.1.8","platforms":{}}"#).expect("write latest.json");
    vokko_server::desktop_version::refresh(&w.app.state).await;
    assert_eq!(alice.wait_for("DESKTOP_VERSION").await, json!({"version": "0.1.8"}));
    let mut bob = Client::connect(&w.address).await;
    assert_eq!(bob.identify(&w.outsider).await["desktop_version"], "0.1.8");

    // Unchanged or half-written files announce nothing.
    vokko_server::desktop_version::refresh(&w.app.state).await;
    std::fs::write(&manifest, r#"{"version":"0.1."#).expect("write partial");
    vokko_server::desktop_version::refresh(&w.app.state).await;
    assert!(bob.silent_for("DESKTOP_VERSION", Duration::from_millis(300)).await);

    std::fs::write(&manifest, r#"{"version":"0.1.9","platforms":{}}"#).expect("write latest.json");
    vokko_server::desktop_version::refresh(&w.app.state).await;
    assert_eq!(alice.wait_for("DESKTOP_VERSION").await["version"], "0.1.9");
    assert_eq!(bob.wait_for("DESKTOP_VERSION").await["version"], "0.1.9");
}

#[tokio::test]
async fn ready_carries_the_upload_limit() {
    let w = world_with_config(|config| config.max_upload_bytes = 95 * 1024 * 1024).await;
    let mut alice = Client::connect(&w.address).await;
    assert_eq!(alice.identify(&w.member).await["max_upload_bytes"], 95 * 1024 * 1024);
}
