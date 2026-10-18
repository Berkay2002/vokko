#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Inbox > Mentions: GET /users/@me/mentions (filters, paging, permission filtering) and DELETE /users/@me/mentions/{id}.
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

const VIEW_CHANNEL: u64 = 1 << 10;

fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("array").iter().map(|m| m["id"].as_str().expect("id").to_owned()).collect()
}

async fn say(app: &TestApp, token: &str, channel: &str, content: &str) -> String {
    let (status, message) = app.post(&format!("/channels/{channel}/messages"), token, json!({"content": content})).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    message["id"].as_str().expect("id").to_owned()
}

async fn mentions(app: &TestApp, token: &str, query: &str) -> Vec<String> {
    let (status, body) = app.get(&format!("/users/@me/mentions{query}"), token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    ids(&body)
}

#[tokio::test]
async fn lists_direct_role_and_everyone_mentions_newest_first() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, member_user) = app.register("alice").await;
    let member_id = member_user["id"].as_str().expect("id").to_owned();
    let (guild, general) = app.guild_with_channel(&owner).await;
    let (_, invite) = app.post(&format!("/channels/{general}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    let (_, role) = app.post(&format!("/guilds/{guild}/roles"), &owner, json!({"name": "docs", "mentionable": true})).await;
    let role = role["id"].as_str().expect("role").to_owned();
    let (status, _) = app.patch(&format!("/guilds/{guild}/members/{member_id}"), &owner, json!({"roles": [role]})).await;
    assert_eq!(status, StatusCode::OK);
    let body = json!({"name": "private", "type": 0, "permission_overwrites": [{"id": guild, "type": 0, "allow": "0", "deny": VIEW_CHANNEL.to_string()}]});
    let (_, private) = app.post(&format!("/guilds/{guild}/channels"), &owner, body).await;
    let private = private["id"].as_str().expect("id").to_owned();

    let direct = say(&app, &owner, &general, &format!("hi <@{member_id}>")).await;
    let _plain = say(&app, &owner, &general, "no mention here").await;
    let by_role = say(&app, &owner, &general, &format!("<@&{role}> read this")).await;
    let everyone = say(&app, &owner, &general, "@everyone meeting").await;
    let _hidden = say(&app, &owner, &private, &format!("secret <@{member_id}>")).await;
    let _own = say(&app, &member, &general, &format!("talking to myself <@{member_id}>")).await;

    assert_eq!(mentions(&app, &member, "").await, vec![everyone.clone(), by_role.clone(), direct.clone()]);
    assert_eq!(mentions(&app, &member, "?everyone=false").await, vec![by_role.clone(), direct.clone()]);
    assert_eq!(mentions(&app, &member, "?roles=false&everyone=false").await, vec![direct.clone()]);
    assert_eq!(mentions(&app, &member, "?limit=1").await, vec![everyone.clone()]);
    assert_eq!(mentions(&app, &member, &format!("?before={everyone}&limit=1")).await, vec![by_role.clone()]);
    assert_eq!(mentions(&app, &member, &format!("?guild_id={guild}")).await.len(), 3);
    assert!(mentions(&app, &member, "?guild_id=12345").await.is_empty());
    // The owner can read #private but was never mentioned.
    assert!(mentions(&app, &owner, "").await.is_empty());

    // Reading the channel keeps them; dismissing removes one for this user only.
    let (status, _) = app.delete(&format!("/users/@me/mentions/{by_role}"), &member).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(mentions(&app, &member, "").await, vec![everyone.clone(), direct.clone()]);
    let (status, _) = app.delete(&format!("/users/@me/mentions/{by_role}"), &member).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "dismissing twice is fine");
    let (status, _) = app.delete("/users/@me/mentions/999", &member).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "unknown ids say nothing");

    for bad in ["?limit=0", "?limit=101", "?before=abc", "?everyone=maybe"] {
        let (status, _) = app.get(&format!("/users/@me/mentions{bad}"), &member).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (status, _) = app.get("/users/@me/mentions", "bad-token").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
