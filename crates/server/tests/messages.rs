#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

struct Setup {
    app: TestApp,
    owner: String,
    member: String,
    outsider: String,
    channel: String,
    guild: String,
    owner_id: String,
    member_id: String,
}

async fn setup() -> Setup {
    let app = TestApp::new().await;
    let (owner, owner_user) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let (outsider, _) = app.register("bob").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Test guild"})).await;
    let guild_id = guild["id"].as_str().expect("id").to_owned();
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    let channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    Setup {
        app,
        owner,
        member,
        outsider,
        channel,
        guild: guild_id,
        owner_id: owner_user["id"].as_str().expect("id").to_owned(),
        member_id: member_user["id"].as_str().expect("id").to_owned(),
    }
}

async fn send(s: &Setup, token: &str, content: &str) -> Value {
    let (status, message) = s.app.post(&format!("/channels/{}/messages", s.channel), token, json!({"content": content})).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    message
}

#[tokio::test]
async fn permission_denial_for_non_members() {
    let s = setup().await;
    let message = send(&s, &s.owner, "secret").await;
    let mid = message["id"].as_str().expect("id");
    let base = format!("/channels/{}", s.channel);
    for (label, (status, error)) in [
        ("list", s.app.get(&format!("{base}/messages"), &s.outsider).await),
        ("send", s.app.post(&format!("{base}/messages"), &s.outsider, json!({"content": "hi"})).await),
        ("pins", s.app.get(&format!("{base}/messages/pins"), &s.outsider).await),
        ("typing", s.app.post(&format!("{base}/typing"), &s.outsider, json!({})).await),
        ("edit", s.app.patch(&format!("{base}/messages/{mid}"), &s.outsider, json!({"content": "x"})).await),
        ("delete", s.app.delete(&format!("{base}/messages/{mid}"), &s.outsider).await),
    ] {
        assert_eq!(status, StatusCode::FORBIDDEN, "{label}");
        assert_eq!(error["code"], 50001, "{label}");
    }
    let (status, error) = s.app.get("/channels/4242/messages", &s.owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], 10003);
    // a plain member cannot delete someone else's message or pin
    let (status, error) = s.app.delete(&format!("{base}/messages/{mid}"), &s.member).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50013);
    assert_eq!(s.app.put(&format!("{base}/messages/pins/{mid}"), &s.member).await.0, StatusCode::FORBIDDEN);
    // SEND_MESSAGES denied by overwrite
    sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 0, 0, $3)")
        .bind(s.channel.parse::<i64>().expect("id"))
        .bind(s.guild.parse::<i64>().expect("id"))
        .bind(1_i64 << 11)
        .execute(&s.app.state.db)
        .await
        .expect("overwrite");
    let (status, error) = s.app.post(&format!("{base}/messages"), &s.member, json!({"content": "muted"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50013);
    assert_eq!(s.app.post(&format!("{base}/messages"), &s.owner, json!({"content": "owner bypasses"})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn message_crud_and_validation() {
    let s = setup().await;
    let base = format!("/channels/{}/messages", s.channel);
    let (status, created) = s.app.post(&base, &s.owner, json!({"content": "  hello <@{}>  ".replace("{}", &s.member_id), "nonce": "n-1"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["content"], format!("hello <@{}>", s.member_id));
    assert_eq!(created["nonce"], "n-1");
    assert_eq!(created["type"], 0);
    assert_eq!(created["guild_id"], s.guild);
    assert_eq!(created["author"]["username"], "sam");
    assert_eq!(created["mentions"][0]["id"], s.member_id);
    assert_eq!(created["mention_everyone"], false);
    assert_eq!(created["reactions"], json!([]));
    assert_eq!(created["edited_timestamp"], Value::Null);
    assert!(created["member"]["roles"].is_array());
    let mid = created["id"].as_str().expect("id").to_owned();

    // edit: author only
    let (status, edited) = s.app.patch(&format!("{base}/{mid}"), &s.owner, json!({"content": "hello again"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["content"], "hello again");
    assert!(edited["edited_timestamp"].is_string());
    assert_eq!(edited["mentions"], json!([]), "mentions are re-parsed on edit");
    let (status, error) = s.app.patch(&format!("{base}/{mid}"), &s.member, json!({"content": "hijack"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50005);

    // validation
    let (status, error) = s.app.post(&base, &s.owner, json!({"content": "   "})).await;
    assert_eq!((status, &error["code"]), (StatusCode::BAD_REQUEST, &json!(50035)));
    let long = "x".repeat(2001);
    assert_eq!(s.app.post(&base, &s.owner, json!({"content": long})).await.0, StatusCode::BAD_REQUEST);
    let max = "y".repeat(2000);
    assert_eq!(s.app.post(&base, &s.owner, json!({"content": max})).await.0, StatusCode::OK);

    // mention_everyone needs the permission (members have MENTION_EVERYONE by default here)
    let (_, everyone) = s.app.post(&base, &s.owner, json!({"content": "@everyone hi"})).await;
    assert_eq!(everyone["mention_everyone"], true);

    // delete: author, then gone
    assert_eq!(s.app.delete(&format!("{base}/{mid}"), &s.owner).await.0, StatusCode::NO_CONTENT);
    let (status, error) = s.app.delete(&format!("{base}/{mid}"), &s.owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], 10008);
    // owner (MANAGE_MESSAGES via ownership) can delete a member's message
    let theirs = send(&s, &s.member, "mine").await;
    assert_eq!(s.app.delete(&format!("{base}/{}", theirs["id"].as_str().expect("id")), &s.owner).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn pagination_is_newest_first_in_every_mode() {
    let s = setup().await;
    let mut ids = Vec::new();
    for index in 0..10 {
        ids.push(send(&s, &s.owner, &format!("message {index}")).await["id"].as_str().expect("id").to_owned());
    }
    let base = format!("/channels/{}/messages", s.channel);
    // the member's join notice (type 7) sits below the test messages
    let list = |value: Value| -> Vec<String> {
        value.as_array().expect("array").iter().filter(|m| m["type"] != 7).map(|m| m["id"].as_str().expect("id").to_owned()).collect()
    };
    let newest_first: Vec<String> = ids.iter().rev().cloned().collect();

    let (_, all) = s.app.get(&base, &s.member).await;
    assert_eq!(list(all), newest_first);

    let (_, page) = s.app.get(&format!("{base}?limit=3"), &s.member).await;
    assert_eq!(list(page), newest_first[..3].to_vec());

    let (_, before) = s.app.get(&format!("{base}?before={}&limit=3", ids[5]), &s.member).await;
    assert_eq!(list(before), vec![ids[4].clone(), ids[3].clone(), ids[2].clone()]);

    // after=: the 3 messages right after the cursor, still newest first
    let (_, after) = s.app.get(&format!("{base}?after={}&limit=3", ids[2]), &s.member).await;
    assert_eq!(list(after), vec![ids[5].clone(), ids[4].clone(), ids[3].clone()]);

    // around: contains the target, newest first
    let (_, around) = s.app.get(&format!("{base}?around={}&limit=5", ids[5]), &s.member).await;
    let around = list(around);
    assert_eq!(around, vec![ids[7].clone(), ids[6].clone(), ids[5].clone(), ids[4].clone(), ids[3].clone()]);

    assert_eq!(s.app.get(&format!("{base}?limit=0"), &s.member).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(s.app.get(&format!("{base}?limit=101"), &s.member).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn reply_payload_and_deleted_reference() {
    let s = setup().await;
    let base = format!("/channels/{}/messages", s.channel);
    let original = send(&s, &s.owner, "original").await;
    let oid = original["id"].as_str().expect("id").to_owned();
    let (status, reply) = s.app.post(&base, &s.member, json!({"content": "replying", "message_reference": {"message_id": oid}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["type"], 19);
    assert_eq!(reply["message_reference"]["message_id"], oid);
    assert_eq!(reply["message_reference"]["channel_id"], s.channel);
    assert_eq!(reply["referenced_message"]["id"], oid);
    assert_eq!(reply["referenced_message"]["content"], "original");
    assert_eq!(reply["referenced_message"]["referenced_message"], Value::Null);
    assert_eq!(reply["mentions"][0]["id"], s.owner_id, "replied-to author is mentioned");

    let (_, listed) = s.app.get(&format!("{base}?limit=1"), &s.owner).await;
    assert_eq!(listed[0]["referenced_message"]["content"], "original");

    // unknown reference is rejected
    let (status, _) = s.app.post(&base, &s.member, json!({"content": "x", "message_reference": {"message_id": "5"}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // deleting the original leaves the reference with a null referenced_message
    assert_eq!(s.app.delete(&format!("{base}/{oid}"), &s.owner).await.0, StatusCode::NO_CONTENT);
    let (_, listed) = s.app.get(&format!("{base}?limit=1"), &s.owner).await;
    assert_eq!(listed[0]["message_reference"]["message_id"], oid);
    assert_eq!(listed[0]["referenced_message"], Value::Null);
}

#[tokio::test]
async fn pins_read_state_and_mention_counts() {
    let s = setup().await;
    let base = format!("/channels/{}", s.channel);
    let first = send(&s, &s.owner, "pin me").await;
    let fid = first["id"].as_str().expect("id").to_owned();

    assert_eq!(s.app.put(&format!("{base}/messages/pins/{fid}"), &s.owner).await.0, StatusCode::NO_CONTENT);
    let (_, pins) = s.app.get(&format!("{base}/messages/pins"), &s.member).await;
    assert_eq!(pins["items"].as_array().expect("pins").len(), 1);
    assert_eq!(pins["has_more"], false);
    assert_eq!(pins["items"][0]["message"]["pinned"], true);
    assert!(pins["items"][0]["pinned_at"].as_str().expect("pinned_at").contains('T'));
    let (_, latest) = s.app.get(&format!("{base}/messages?limit=1"), &s.member).await;
    assert_eq!(latest[0]["type"], 6, "pin notice");
    assert_eq!(latest[0]["message_reference"]["message_id"], fid);
    assert_eq!(s.app.delete(&format!("{base}/messages/pins/{fid}"), &s.owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.app.get(&format!("{base}/messages/pins"), &s.member).await.1, json!({"items": [], "has_more": false}));

    // a mention raises alice's counter, her own ack lowers it
    send(&s, &s.owner, &format!("hey <@{}>", s.member_id)).await;
    let newest = send(&s, &s.owner, "again").await;
    let rows: Vec<(i32,)> = sqlx::query_as("SELECT mention_count FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(s.member_id.parse::<i64>().expect("id"))
        .bind(s.channel.parse::<i64>().expect("id"))
        .fetch_all(&s.app.state.db)
        .await
        .expect("read state");
    assert_eq!(rows[0].0, 1);
    let nid = newest["id"].as_str().expect("id");
    assert_eq!(s.app.post(&format!("{base}/messages/{nid}/ack"), &s.member, json!({})).await.0, StatusCode::NO_CONTENT);
    let (last, count): (Option<i64>, i32) = sqlx::query_as("SELECT last_message_id, mention_count FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(s.member_id.parse::<i64>().expect("id"))
        .bind(s.channel.parse::<i64>().expect("id"))
        .fetch_one(&s.app.state.db)
        .await
        .expect("read state");
    assert_eq!(last, Some(nid.parse::<i64>().expect("id")));
    assert_eq!(count, 0);
}

#[tokio::test]
async fn pins_are_paginated_newest_pin_first() {
    let s = setup().await;
    let base = format!("/channels/{}", s.channel);
    let mut ids = Vec::new();
    for index in 0..3 {
        let message = send(&s, &s.owner, &format!("pin {index}")).await;
        ids.push(message["id"].as_str().expect("id").to_owned());
    }
    // pin order differs from message order
    for index in [1, 0, 2] {
        assert_eq!(s.app.put(&format!("{base}/messages/pins/{}", ids[index]), &s.owner).await.0, StatusCode::NO_CONTENT);
    }
    let (_, first) = s.app.get(&format!("{base}/messages/pins?limit=2"), &s.member).await;
    assert_eq!(first["has_more"], true);
    let order: Vec<&str> = first["items"].as_array().expect("items").iter().map(|item| item["message"]["id"].as_str().expect("id")).collect();
    assert_eq!(order, vec![ids[2].as_str(), ids[0].as_str()]);
    let cursor = first["items"][1]["pinned_at"].as_str().expect("pinned_at").replace('+', "%2B");
    let (_, second) = s.app.get(&format!("{base}/messages/pins?limit=2&before={cursor}"), &s.member).await;
    assert_eq!(second["has_more"], false);
    assert_eq!(second["items"][0]["message"]["id"], ids[1]);
    assert_eq!(s.app.get(&format!("{base}/messages/pins?limit=51"), &s.member).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn allowed_mentions_limit_who_gets_pinged() {
    let s = setup().await;
    let base = format!("/channels/{}/messages", s.channel);
    let original = send(&s, &s.member, "question").await;
    let oid = original["id"].as_str().expect("id").to_owned();
    // owner replies without pinging the replied-to author
    let (status, quiet) =
        s.app.post(&base, &s.owner, json!({"content": "answer", "message_reference": {"message_id": oid}, "allowed_mentions": {"replied_user": false}})).await;
    assert_eq!(status, StatusCode::OK, "{quiet}");
    assert_eq!(quiet["type"], 19);
    assert_eq!(quiet["mentions"], json!([]));
    // parse: [] drops explicit mentions too; an explicit users list keeps only those
    let content = format!("<@{}> and <@{}>", s.member_id, s.owner_id);
    let (_, none) = s.app.post(&base, &s.owner, json!({"content": content, "allowed_mentions": {"parse": []}})).await;
    assert_eq!(none["mentions"], json!([]));
    let (_, only) = s.app.post(&base, &s.owner, json!({"content": content, "allowed_mentions": {"users": [s.member_id]}})).await;
    let mentioned: Vec<&str> = only["mentions"].as_array().expect("mentions").iter().map(|user| user["id"].as_str().expect("id")).collect();
    assert_eq!(mentioned, vec![s.member_id.as_str()]);
    let (_, everyone) = s.app.post(&base, &s.owner, json!({"content": "@everyone hi", "allowed_mentions": {"parse": ["users"]}})).await;
    assert_eq!(everyone["mention_everyone"], false);
    // the default still pings
    let (_, loud) = s.app.post(&base, &s.owner, json!({"content": "@everyone hi"})).await;
    assert_eq!(loud["mention_everyone"], true);
}

#[tokio::test]
async fn bulk_ack_marks_channels_read() {
    let s = setup().await;
    let base = format!("/channels/{}/messages", s.channel);
    send(&s, &s.owner, &format!("hey <@{}>", s.member_id)).await;
    let newest = send(&s, &s.owner, "latest").await;
    let nid = newest["id"].as_str().expect("id");
    let (status, _) = s
        .app
        .post(
            "/read-states/ack-bulk",
            &s.member,
            json!({"read_states": [{"channel_id": s.channel, "message_id": nid}, {"channel_id": "4242", "message_id": "1"}]}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (last, count): (Option<i64>, i32) = sqlx::query_as("SELECT last_message_id, mention_count FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(s.member_id.parse::<i64>().expect("id"))
        .bind(s.channel.parse::<i64>().expect("id"))
        .fetch_one(&s.app.state.db)
        .await
        .expect("read state");
    assert_eq!((last, count), (Some(nid.parse::<i64>().expect("id")), 0));
    assert_eq!(s.app.get(&format!("{base}?limit=1"), &s.member).await.0, StatusCode::OK);

    // A duplicate entry for the same channel is fine and an older message never moves the read state back.
    let (status, _) = s
        .app
        .post(
            "/read-states/ack-bulk",
            &s.member,
            json!({"read_states": [{"channel_id": s.channel, "message_id": "1"}, {"channel_id": s.channel, "message_id": nid}]}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // More than 100 entries is a 400.
    let too_many: Vec<_> = (0..101).map(|_| json!({"channel_id": s.channel, "message_id": nid})).collect();
    let (status, _) = s.app.post("/read-states/ack-bulk", &s.member, json!({ "read_states": too_many })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn timed_out_members_can_read_but_not_write() {
    let s = setup().await;
    let base = format!("/channels/{}/messages", s.channel);
    send(&s, &s.owner, "before the timeout").await;
    sqlx::query("UPDATE guild_members SET timeout_until = now() + interval '1 hour' WHERE guild_id = $1 AND user_id = $2")
        .bind(s.guild.parse::<i64>().expect("id"))
        .bind(s.member_id.parse::<i64>().expect("id"))
        .execute(&s.app.state.db)
        .await
        .expect("timeout");
    assert_eq!(s.app.get(&format!("{base}?limit=1"), &s.member).await.0, StatusCode::OK);
    let (status, error) = s.app.post(&base, &s.member, json!({"content": "muted"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::FORBIDDEN, json!(50013)));
    // the owner is unaffected, and the timeout ending restores access
    sqlx::query("UPDATE guild_members SET timeout_until = now() - interval '1 minute' WHERE user_id = $1")
        .bind(s.member_id.parse::<i64>().expect("id"))
        .execute(&s.app.state.db)
        .await
        .expect("expire");
    assert_eq!(s.app.post(&base, &s.member, json!({"content": "back"})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn tts_needs_send_tts_messages() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
    let s = setup().await;
    let base = format!("/channels/{}/messages", s.channel);
    let address = s.app.serve().await;
    let (mut ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
    ws.next().await.expect("hello").expect("frame");
    ws.send(WsMessage::Text(json!({"op": 2, "d": {"token": s.member}}).to_string().into())).await.expect("identify");

    // omitted = false, in the response and on the stored row
    let (status, plain) = s.app.post(&base, &s.owner, json!({"content": "plain"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(plain["tts"], false);

    // the owner holds every permission
    let (status, spoken) = s.app.post(&base, &s.owner, json!({"content": "hello", "tts": true})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(spoken["tts"], true);
    let mut created = None;
    while created.is_none() {
        let frame = tokio::time::timeout(common::WAIT, ws.next()).await.expect("gateway frame").expect("open").expect("frame");
        if let WsMessage::Text(text) = frame {
            let frame: Value = serde_json::from_str(&text).expect("json");
            if frame["t"] == "MESSAGE_CREATE" && frame["d"]["id"] == spoken["id"] {
                created = Some(frame["d"].clone());
            }
        }
    }
    assert_eq!(created.expect("event")["tts"], true, "MESSAGE_CREATE carries tts");
    let (_, listed) = s.app.get(&base, &s.member).await;
    let by_id = |id: &Value| listed.as_array().expect("list").iter().find(|m| &m["id"] == id).cloned().expect("listed");
    assert_eq!(by_id(&spoken["id"])["tts"], true);
    assert_eq!(by_id(&plain["id"])["tts"], false);

    // @everyone does not have SEND_TTS_MESSAGES: still sent, flag dropped
    let (status, dropped) = s.app.post(&base, &s.member, json!({"content": "shout", "tts": true})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dropped["tts"], false);

    // allowed through a channel overwrite
    sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 0, $3, 0)")
        .bind(s.channel.parse::<i64>().expect("id"))
        .bind(s.guild.parse::<i64>().expect("id"))
        .bind(1_i64 << 12)
        .execute(&s.app.state.db)
        .await
        .expect("overwrite");
    let (status, allowed) = s.app.post(&base, &s.member, json!({"content": "now allowed", "tts": true})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(allowed["tts"], true);
    let (_, off) = s.app.post(&base, &s.member, json!({"content": "explicit off", "tts": false})).await;
    assert_eq!(off["tts"], false);

    // DMs allow tts, as on Discord
    let (status, dm) = s.app.post("/users/@me/channels", &s.member, json!({"recipient_id": s.owner_id})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm_messages = format!("/channels/{}/messages", dm["id"].as_str().expect("dm id"));
    let (status, in_dm) = s.app.post(&dm_messages, &s.member, json!({"content": "hi there", "tts": true})).await;
    assert_eq!(status, StatusCode::OK, "{in_dm}");
    assert_eq!(in_dm["tts"], true);
}
