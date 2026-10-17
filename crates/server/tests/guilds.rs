#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

fn id_of(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

#[tokio::test]
async fn guild_creation_has_defaults() {
    let app = TestApp::new().await;
    let (token, user) = app.register("sam").await;
    let (status, guild) = app.post("/guilds", &token, json!({"name": "Sam's server"})).await;
    assert_eq!(status, StatusCode::OK);
    let guild_id = id_of(&guild);
    assert_eq!(guild["owner_id"], user["id"]);
    let roles = guild["roles"].as_array().expect("roles");
    assert_eq!(roles.len(), 1);
    assert_eq!(roles[0]["id"], guild["id"], "@everyone id == guild id");
    assert_eq!(roles[0]["name"], "@everyone");
    let permissions: u64 = roles[0]["permissions"].as_str().expect("permissions string").parse().expect("number");
    assert_ne!(permissions & (1 << 10), 0, "VIEW_CHANNEL");
    assert_eq!(permissions & (1 << 3), 0, "no ADMINISTRATOR");
    assert_ne!(permissions & (1 << 60), 0, "CONTROL_MEDIA");
    // Bit 60 is a known bit a role may carry; the bit above it is not.
    let role = format!("/guilds/{guild_id}/roles/{guild_id}");
    assert_eq!(app.patch(&role, &token, json!({"permissions": permissions.to_string()})).await.0, StatusCode::OK);
    assert_eq!(app.patch(&role, &token, json!({"permissions": (permissions | 1 << 61).to_string()})).await.0, StatusCode::BAD_REQUEST);

    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &token).await;
    let channels = channels.as_array().expect("channels");
    let names: Vec<(&str, u64)> = channels.iter().map(|channel| (channel["name"].as_str().expect("name"), channel["type"].as_u64().expect("type"))).collect();
    assert!(names.contains(&("Text Channels", 4)));
    assert!(names.contains(&("Voice Channels", 4)));
    assert!(names.contains(&("general", 0)));
    assert!(names.contains(&("General", 2)));
    let general = channels.iter().find(|channel| channel["name"] == "general").expect("general");
    assert_eq!(guild["system_channel_id"], general["id"]);
    let text_category = channels.iter().find(|channel| channel["name"] == "Text Channels").expect("category");
    assert_eq!(general["parent_id"], text_category["id"]);

    let (_, mine) = app.get("/users/@me/guilds", &token).await;
    assert_eq!(mine.as_array().expect("guilds").len(), 1);
    let (_, members) = app.get(&format!("/guilds/{guild_id}/members"), &token).await;
    assert_eq!(members[0]["user"]["username"], "sam");
}

#[tokio::test]
async fn non_members_are_denied_and_invites_work() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (outsider, outsider_user) = app.register("alice").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Private place"})).await;
    let guild_id = id_of(&guild);
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    let general = channels.as_array().expect("channels").iter().find(|channel| channel["name"] == "general").expect("general").clone();
    let general_id = id_of(&general);

    for path in [format!("/guilds/{guild_id}"), format!("/guilds/{guild_id}/channels"), format!("/guilds/{guild_id}/members")] {
        let (status, error) = app.get(&path, &outsider).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(error["code"], 50001);
    }
    let (status, error) = app.post(&format!("/channels/{general_id}/invites"), &outsider, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50001);
    assert_eq!(app.get("/guilds/999999", &owner).await.1["code"], 10004);

    let (status, invite) = app.post(&format!("/channels/{general_id}/invites"), &owner, json!({"max_uses": 1})).await;
    assert_eq!(status, StatusCode::OK);
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(invite["guild"]["name"], "Private place");
    assert_eq!(invite["channel"]["id"], general["id"]);
    assert!(invite["expires_at"].is_string());
    assert_eq!(app.get(&format!("/invites/{code}"), &outsider).await.0, StatusCode::OK);

    let (status, joined) = app.post(&format!("/invites/{code}"), &outsider, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(joined["id"], guild["id"]);
    assert_eq!(app.get(&format!("/guilds/{guild_id}/channels"), &outsider).await.0, StatusCode::OK);
    let (_, members) = app.get(&format!("/guilds/{guild_id}/members"), &owner).await;
    assert_eq!(members.as_array().expect("members").len(), 2);

    // single-use invite is now spent
    let (third, _) = app.register("bob").await;
    let (status, error) = app.get(&format!("/invites/{code}"), &third).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], 10006);

    // a plain member cannot manage channels or the guild
    let (status, error) = app.post(&format!("/guilds/{guild_id}/channels"), &outsider, json!({"name": "nope", "type": 0})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50013);
    assert_eq!(app.patch(&format!("/guilds/{guild_id}"), &outsider, json!({"name": "mine now"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&format!("/guilds/{guild_id}"), &outsider).await.0, StatusCode::FORBIDDEN);

    // members can leave, owners cannot
    assert_eq!(app.delete(&format!("/users/@me/guilds/{guild_id}"), &owner).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.delete(&format!("/users/@me/guilds/{guild_id}"), &outsider).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get(&format!("/guilds/{guild_id}"), &outsider).await.0, StatusCode::FORBIDDEN);
    assert!(outsider_user["id"].is_string());
}

#[tokio::test]
async fn channel_management_and_overwrites() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Workshop"})).await;
    let guild_id = id_of(&guild);
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    let general_id = id_of(channels.as_array().expect("channels").iter().find(|channel| channel["name"] == "general").expect("general"));
    let (_, invite) = app.post(&format!("/channels/{general_id}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;

    let (status, created) = app.post(&format!("/guilds/{guild_id}/channels"), &owner, json!({"name": "Dev Talk", "type": 0, "topic": "code"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["name"], "dev-talk", "text channel names are normalised");
    assert_eq!(created["topic"], "code");
    let dev_id = id_of(&created);

    // a role/member overwrite hides the channel from the member only
    let member_id: i64 = member_user["id"].as_str().expect("id").parse().expect("number");
    sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 1, 0, $3)")
        .bind(dev_id.parse::<i64>().expect("id"))
        .bind(member_id)
        .bind(1_i64 << 10)
        .execute(&app.state.db)
        .await
        .expect("overwrite");
    let (_, visible) = app.get(&format!("/guilds/{guild_id}/channels"), &member).await;
    assert!(!visible.as_array().expect("channels").iter().any(|channel| channel["id"] == created["id"]));
    let (_, owner_visible) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    assert!(owner_visible.as_array().expect("channels").iter().any(|channel| channel["id"] == created["id"]));
    let (status, error) = app.patch(&format!("/channels/{dev_id}"), &member, json!({"name": "x"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50001);

    let (status, renamed) = app.patch(&format!("/channels/{dev_id}"), &owner, json!({"name": "Dev Chat", "topic": ""})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["name"], "dev-chat");
    assert_eq!(renamed["topic"], Value::Null);

    let (status, deleted) = app.delete(&format!("/channels/{dev_id}"), &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["id"], created["id"]);
    assert_eq!(app.patch(&format!("/channels/{dev_id}"), &owner, json!({"name": "x"})).await.1["code"], 10003);

    // owner deletes the guild
    assert_eq!(app.delete(&format!("/guilds/{guild_id}"), &owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get(&format!("/guilds/{guild_id}"), &owner).await.1["code"], 10004);
}

#[tokio::test]
async fn concurrent_accepts_consume_a_single_use_exactly_once() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (first, _) = app.register("alice").await;
    let (second, _) = app.register("bob").await;
    let (_, channel_id) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{channel_id}/invites"), &owner, json!({"max_uses": 1})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    let path = format!("/invites/{code}");

    let ((status_a, _), (status_b, _)) = tokio::join!(app.post(&path, &first, json!({})), app.post(&path, &second, json!({})));
    let mut statuses = [status_a, status_b];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::NOT_FOUND]);
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = $1").bind(&code).fetch_one(&app.state.db).await.expect("invite");
    assert_eq!(uses, 1);
    let (members,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM guild_members WHERE guild_id = (SELECT guild_id FROM invites WHERE code = $1)")
        .bind(&code)
        .fetch_one(&app.state.db)
        .await
        .expect("members");
    assert_eq!(members, 2, "owner plus exactly one joiner");
}

#[tokio::test]
async fn accepting_again_does_not_consume_a_use() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, _) = app.register("alice").await;
    let (_, channel_id) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{channel_id}/invites"), &owner, json!({"max_uses": 5})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    for _ in 0..2 {
        assert_eq!(app.post(&format!("/invites/{code}"), &member, json!({})).await.0, StatusCode::OK);
    }
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = $1").bind(&code).fetch_one(&app.state.db).await.expect("invite");
    assert_eq!(uses, 1);
}

/// Connects, identifies and returns the socket once READY has arrived.
async fn gateway(address: &str, token: &str) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    use futures_util::SinkExt;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
    next_event(&mut ws, None).await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
    next_event(&mut ws, Some("READY")).await;
    ws
}

/// The next dispatch (named `name` when given); panics after 5 seconds.
async fn next_event(ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, name: Option<&str>) -> Value {
    use futures_util::StreamExt;
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                let frame: Value = serde_json::from_str(&text).expect("json frame");
                if name.is_none() || (frame["op"] == 0 && frame["t"] == name.unwrap_or_default()) {
                    return frame["d"].clone();
                }
            }
            Ok(Some(Ok(_))) => continue,
            other => panic!("gateway ended or timed out: {other:?}"),
        }
    }
}

#[tokio::test]
async fn channel_nsfw_flag_is_created_toggled_and_broadcast() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (guild_id, general_id) = app.guild_with_channel(&owner).await;
    let address = app.serve().await;
    let mut ws = gateway(&address, &owner).await;
    let path = format!("/guilds/{guild_id}/channels");

    let (status, created) = app.post(&path, &owner, json!({"name": "spicy", "type": 0, "nsfw": true})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["nsfw"], json!(true));
    let (_, listed) = app.get(&path, &owner).await;
    let general = listed.as_array().expect("channels").iter().find(|channel| channel["id"] == general_id.as_str()).expect("general");
    assert_eq!(general["nsfw"], json!(false), "always serialised");

    let spicy = id_of(&created);
    let (status, updated) = app.patch(&format!("/channels/{spicy}"), &owner, json!({"nsfw": false})).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["nsfw"], json!(false));
    loop {
        let event = next_event(&mut ws, Some("CHANNEL_UPDATE")).await;
        if event["id"] == spicy.as_str() {
            assert_eq!(event["nsfw"], json!(false));
            break;
        }
    }
    let (_, listed) = app.get(&path, &owner).await;
    assert!(listed.as_array().expect("channels").iter().all(|channel| channel["nsfw"] == json!(false)));
    let (_, toggled) = app.patch(&format!("/channels/{spicy}"), &owner, json!({"nsfw": true})).await;
    assert_eq!(toggled["nsfw"], json!(true));
    let (_, voice) = app.post(&path, &owner, json!({"name": "Quiet", "type": 2, "nsfw": true})).await;
    assert_eq!(voice["nsfw"], json!(true));

    // categories take no flag, on create or on edit
    let (status, error) = app.post(&path, &owner, json!({"name": "Cat", "type": 4, "nsfw": true})).await;
    assert_eq!((status, &error["code"]), (StatusCode::BAD_REQUEST, &json!(50035)));
    let (_, category) = app.post(&path, &owner, json!({"name": "Cat", "type": 4})).await;
    assert_eq!(app.patch(&format!("/channels/{}", id_of(&category)), &owner, json!({"nsfw": true})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(category["nsfw"], json!(false));
}

fn position_of(channels: &Value, id: &str) -> Value {
    channels.as_array().expect("channels").iter().find(|channel| channel["id"] == id).expect("channel listed")["position"].clone()
}

#[tokio::test]
async fn modify_channel_positions_reorders_and_reparents() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Order"})).await;
    let guild_id = id_of(&guild);
    let path = format!("/guilds/{guild_id}/channels");
    let (_, one) = app.post(&path, &owner, json!({"name": "one", "type": 0})).await;
    let (_, two) = app.post(&path, &owner, json!({"name": "two", "type": 0})).await;
    let (_, category) = app.post(&path, &owner, json!({"name": "Stuff", "type": 4})).await;
    let (one_id, two_id, category_id) = (id_of(&one), id_of(&two), id_of(&category));

    let (status, _) = app.patch(&path, &owner, json!([{"id": one_id, "position": 7}, {"id": two_id, "position": 3}])).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, channels) = app.get(&path, &owner).await;
    assert_eq!(position_of(&channels, &one_id), json!(7));
    assert_eq!(position_of(&channels, &two_id), json!(3));
    let (status, log) = app.get(&format!("/guilds/{guild_id}/audit-logs?action_type=11"), &owner).await;
    assert_eq!(status, StatusCode::OK, "{log}");
    let entries = log["audit_log_entries"].as_array().expect("entries");
    for target in [&one_id, &two_id] {
        let entry = entries.iter().find(|entry| entry["target_id"] == target.as_str()).expect("reorder audited");
        assert!(entry["changes"].as_array().expect("changes").iter().any(|change| change["key"] == "position"), "{entry}");
    }

    let (status, _) = app.patch(&path, &owner, json!([{"id": one_id, "parent_id": category_id, "position": 0}])).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, channels) = app.get(&path, &owner).await;
    let moved = channels.as_array().expect("channels").iter().find(|channel| channel["id"] == one_id.as_str()).expect("one");
    assert_eq!(moved["parent_id"], category["id"]);
    assert_eq!(position_of(&channels, &two_id), json!(3), "untouched channel keeps its position");

    let (status, _) = app.patch(&path, &owner, json!([{"id": one_id, "parent_id": null}])).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, channels) = app.get(&path, &owner).await;
    let cleared = channels.as_array().expect("channels").iter().find(|channel| channel["id"] == one_id.as_str()).expect("one");
    assert!(cleared["parent_id"].is_null());

    // categories cannot be nested, non-categories cannot be parents, an empty body is rejected
    assert_eq!(app.patch(&path, &owner, json!([{"id": category_id, "parent_id": category_id}])).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.patch(&path, &owner, json!([{"id": one_id, "parent_id": two_id}])).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.patch(&path, &owner, json!([])).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn modify_channel_positions_requires_manage_channels() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, _) = app.register("alice").await;
    let (guild_id, general_id) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{general_id}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(app.post(&format!("/invites/{code}"), &member, json!({})).await.0, StatusCode::OK);
    let path = format!("/guilds/{guild_id}/channels");
    let (status, error) = app.patch(&path, &member, json!([{"id": general_id, "position": 9}])).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50013);
    let (_, channels) = app.get(&path, &owner).await;
    assert_ne!(position_of(&channels, &general_id), json!(9));
}

#[tokio::test]
async fn modify_channel_positions_honours_a_channel_overwrite_denying_manage_channels() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let (guild_id, general_id) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{general_id}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(app.post(&format!("/invites/{code}"), &member, json!({})).await.0, StatusCode::OK);
    let path = format!("/guilds/{guild_id}/channels");
    let manage_channels: u64 = 1 << 4;
    let (_, role) = app.post(&format!("/guilds/{guild_id}/roles"), &owner, json!({"name": "movers", "permissions": manage_channels.to_string()})).await;
    let member_id = id_of(&member_user);
    let (status, _) = app.patch(&format!("/guilds/{guild_id}/members/{member_id}"), &owner, json!({"roles": [role["id"]]})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, category) = app.post(&path, &owner, json!({"name": "Stuff", "type": 4})).await;
    let (_, locked) = app.post(&path, &owner, json!({"name": "mod-log", "type": 0})).await;
    let (_, free) = app.post(&path, &owner, json!({"name": "free", "type": 0})).await;
    let (locked_id, free_id, category_id) = (id_of(&locked), id_of(&free), id_of(&category));
    // the role may manage channels guild-wide, but not this one
    sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 0, 0, $3)")
        .bind(locked_id.parse::<i64>().expect("id"))
        .bind(role["id"].as_str().expect("role id").parse::<i64>().expect("id"))
        .bind(manage_channels as i64)
        .execute(&app.state.db)
        .await
        .expect("overwrite");
    let (_, before) = app.get(&path, &owner).await;

    for body in [
        json!([{"id": free_id, "position": 20}, {"id": locked_id, "position": 30}]),
        json!([{"id": free_id, "position": 20}, {"id": locked_id, "parent_id": category_id}]),
    ] {
        let (status, error) = app.patch(&path, &member, body).await;
        assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50013)), "{error}");
        let (_, after) = app.get(&path, &owner).await;
        assert_eq!(before, after, "a rejected request changes nothing");
    }
    // the unrestricted channel alone is fine
    assert_eq!(app.patch(&path, &member, json!([{"id": free_id, "position": 20}])).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn moving_into_a_category_the_caller_cannot_see_is_refused() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let (guild_id, general_id) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{general_id}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(app.post(&format!("/invites/{code}"), &member, json!({})).await.0, StatusCode::OK);
    let path = format!("/guilds/{guild_id}/channels");
    let manage_channels: u64 = 1 << 4;
    let (_, role) = app.post(&format!("/guilds/{guild_id}/roles"), &owner, json!({"name": "movers", "permissions": manage_channels.to_string()})).await;
    let member_id = id_of(&member_user);
    assert_eq!(app.patch(&format!("/guilds/{guild_id}/members/{member_id}"), &owner, json!({"roles": [role["id"]]})).await.0, StatusCode::OK);
    let (_, secret) = app.post(&path, &owner, json!({"name": "Secret", "type": 4})).await;
    let (_, free) = app.post(&path, &owner, json!({"name": "free", "type": 0})).await;
    let (secret_id, free_id) = (id_of(&secret), id_of(&free));
    sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 0, 0, $3)")
        .bind(secret_id.parse::<i64>().expect("id"))
        .bind(role["id"].as_str().expect("role id").parse::<i64>().expect("id"))
        .bind(1_i64 << 10)
        .execute(&app.state.db)
        .await
        .expect("overwrite");
    let (_, before) = app.get(&path, &owner).await;

    for lock in [false, true] {
        let (status, error) = app.patch(&path, &member, json!([{"id": free_id, "parent_id": secret_id, "lock_permissions": lock}])).await;
        assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50001)), "bulk, lock {lock}: {error}");
        let (status, error) = app.patch(&format!("/channels/{free_id}"), &member, json!({"parent_id": secret_id, "lock_permissions": lock})).await;
        assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50001)), "single, lock {lock}: {error}");
    }
    let (_, after) = app.get(&path, &owner).await;
    assert_eq!(before, after, "nothing moved");
    // the owner still can
    assert_eq!(app.patch(&path, &owner, json!([{"id": free_id, "parent_id": secret_id}])).await.0, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn modify_channel_positions_rejects_foreign_channels_atomically() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (guild_id, general_id) = app.guild_with_channel(&owner).await;
    let (_, other_channel) = app.guild_with_channel(&owner).await;
    let path = format!("/guilds/{guild_id}/channels");
    let (_, before) = app.get(&path, &owner).await;

    let (status, error) = app.patch(&path, &owner, json!([{"id": general_id, "position": 42}, {"id": other_channel, "position": 1}])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], 50035);
    assert_eq!(app.patch(&path, &owner, json!([{"id": general_id, "position": 42}, {"id": "999999999", "position": 1}])).await.0, StatusCode::BAD_REQUEST);
    let (_, after) = app.get(&path, &owner).await;
    assert_eq!(before, after, "a rejected request changes nothing");
}
