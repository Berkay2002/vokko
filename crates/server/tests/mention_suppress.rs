#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! "Suppress @everyone and @here" / "Suppress All Role @mentions" (user guild settings) keep those mentions out of the unread
//! mention counter, in the database and so in READY; names and replies always count, and a message that is both counts once.
mod common;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

struct User {
    token: String,
    id: String,
}

async fn join(app: &TestApp, owner: &str, channel: &str, name: &str, role: Option<(&str, &str)>) -> User {
    let (token, user) = app.register(name).await;
    let id = user["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &token, json!({})).await;
    if let Some((guild, role)) = role {
        let (status, _) = app.patch(&format!("/guilds/{guild}/members/{id}"), owner, json!({"roles": [role]})).await;
        assert_eq!(status, StatusCode::OK);
    }
    User { token, id }
}

async fn suppress(app: &TestApp, guild: &str, user: &User, body: Value) {
    let (status, _) = app.patch(&format!("/users/@me/guilds/{guild}/settings"), &user.token, body).await;
    assert_eq!(status, StatusCode::OK);
}

async fn counter(app: &TestApp, user: &User, channel: &str) -> i32 {
    let row: Option<(i32,)> = sqlx::query_as("SELECT mention_count FROM read_states WHERE user_id = $1 AND channel_id = $2")
        .bind(user.id.parse::<i64>().expect("id"))
        .bind(channel.parse::<i64>().expect("id"))
        .fetch_optional(&app.state.db)
        .await
        .expect("read state");
    row.map_or(0, |(count,)| count)
}

/// The `mention_count` READY carries for `channel`.
async fn ready_count(address: &str, token: &str, channel: &str) -> u64 {
    let (mut ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
    let mut identified = false;
    loop {
        let Some(Ok(Message::Text(text))) = ws.next().await else { continue };
        let frame: Value = serde_json::from_str(&text).expect("json frame");
        if frame["op"] == 10 && !identified {
            identified = true;
            ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        } else if frame["t"] == "READY" {
            let states = frame["d"]["read_states"].as_array().expect("read states");
            return states.iter().find(|state| state["channel_id"] == channel).map_or(0, |state| state["mention_count"].as_u64().expect("count"));
        }
    }
}

#[tokio::test]
async fn suppressed_everyone_and_role_mentions_do_not_count() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("sam").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    let (_, role) = app.post(&format!("/guilds/{guild}/roles"), &owner, json!({"name": "docs", "mentionable": true})).await;
    let role = role["id"].as_str().expect("role").to_owned();
    let held = Some((guild.as_str(), role.as_str()));
    let alice = join(&app, &owner, &general, "alice", held).await;
    let bob = join(&app, &owner, &general, "bob", held).await;
    let carol = join(&app, &owner, &general, "carol", held).await;
    let dave = join(&app, &owner, &general, "dave", None).await;
    suppress(&app, &guild, &alice, json!({"suppress_everyone": true})).await;
    suppress(&app, &guild, &carol, json!({"suppress_roles": true})).await;
    suppress(&app, &guild, &dave, json!({"suppress_everyone": true, "suppress_roles": true})).await;
    let say = |content: String| {
        let (app, owner, general) = (&app, &owner, &general);
        async move {
            let (status, message) = app.post(&format!("/channels/{general}/messages"), owner, json!({"content": content})).await;
            assert_eq!(status, StatusCode::OK, "{message}");
        }
    };
    let counts = || async {
        [
            counter(&app, &alice, &general).await,
            counter(&app, &bob, &general).await,
            counter(&app, &carol, &general).await,
            counter(&app, &dave, &general).await,
        ]
    };

    say("@everyone hello".into()).await;
    assert_eq!(counts().await, [0, 1, 1, 0], "@everyone skips the members who suppress it");
    say(format!("<@&{role}> docs")).await;
    assert_eq!(counts().await, [1, 2, 1, 0], "a role mention skips carol, who suppresses roles; dave has no role");
    say(format!("<@{}> @everyone", dave.id)).await;
    assert_eq!(counts().await, [1, 3, 2, 1], "a name counts even for someone who suppresses everything");
    say(format!("<@&{role}> <@{}> <@{}>", bob.id, dave.id)).await;
    assert_eq!(counts().await, [2, 4, 2, 2], "role plus name counts once; carol still skips the role");

    // A reply pings the author of the replied message whatever they suppress.
    let (status, theirs) = app.post(&format!("/channels/{general}/messages"), &dave.token, json!({"content": "question"})).await;
    assert_eq!(status, StatusCode::OK, "{theirs}");
    let (status, reply) =
        app.post(&format!("/channels/{general}/messages"), &owner, json!({"content": "answer", "message_reference": {"message_id": theirs["id"]}})).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(counts().await, [2, 4, 2, 1], "a reply to dave counts for dave (their own post had cleared the counter)");
    // The wire says which roles the server resolved, so clients count the same ones.
    let (_, pinged) = app.post(&format!("/channels/{general}/messages"), &owner, json!({"content": format!("<@&{role}> again")})).await;
    assert_eq!(pinged["mention_roles"], json!([role]));

    assert_eq!(ready_count(&address, &carol.token, &general).await, 2);
    assert_eq!(ready_count(&address, &dave.token, &general).await, 1);
    assert_eq!(ready_count(&address, &bob.token, &general).await, 5);
}
