#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Slowmode: `rate_limit_per_user` on guild text/voice channels, enforced on message create with 429 / 20016 unless the author may bypass it.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::json;
use vokko_protocol::api::permissions::{BYPASS_SLOWMODE, MANAGE_MESSAGES};

async fn give_role(app: &TestApp, guild: &str, user: &str, permissions: u64) {
    let role = app.state.ids.next();
    let guild: i64 = guild.parse().expect("guild id");
    sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $2, 'tester', 1, $3)")
        .bind(role)
        .bind(guild)
        .bind(permissions as i64)
        .execute(&app.state.db)
        .await
        .expect("insert role");
    sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)")
        .bind(guild)
        .bind(user.parse::<i64>().expect("user id"))
        .bind(role)
        .execute(&app.state.db)
        .await
        .expect("assign role");
}

async fn join(app: &TestApp, owner: &str, channel: &str, name: &str) -> (String, String) {
    let (token, user) = app.register(name).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), owner, json!({})).await;
    let code = invite["code"].as_str().expect("code").to_owned();
    assert_eq!(app.post(&format!("/invites/{code}"), &token, json!({})).await.0, StatusCode::OK);
    (token, user["id"].as_str().expect("id").to_owned())
}

#[tokio::test]
async fn slowmode_limits_members_and_lets_moderators_through() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    let (alice, _) = join(&app, &owner, &general, "alice").await;
    let (mod_token, mod_id) = join(&app, &owner, &general, "moddy").await;
    let (vip_token, vip_id) = join(&app, &owner, &general, "vip").await;
    give_role(&app, &guild, &mod_id, MANAGE_MESSAGES).await;
    give_role(&app, &guild, &vip_id, BYPASS_SLOWMODE).await;
    let path = format!("/channels/{general}/messages");

    // Off by default, and always sent on text channels.
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &owner).await;
    let found = channels.as_array().expect("channels").iter().find(|c| c["id"] == general.as_str()).expect("general").clone();
    assert_eq!(found["rate_limit_per_user"], 0);

    // Only MANAGE_CHANNELS sets it, within 0..=21600, on text and voice channels.
    assert_eq!(app.patch(&format!("/channels/{general}"), &alice, json!({"rate_limit_per_user": 10})).await.0, StatusCode::FORBIDDEN);
    let (status, body) = app.patch(&format!("/channels/{general}"), &owner, json!({"rate_limit_per_user": 21601})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (_, category) = app.post(&format!("/guilds/{guild}/channels"), &owner, json!({"name": "cat", "type": 4})).await;
    let category = category["id"].as_str().expect("category id");
    assert_eq!(app.patch(&format!("/channels/{category}"), &owner, json!({"rate_limit_per_user": 5})).await.0, StatusCode::BAD_REQUEST);
    let (status, channel) = app.patch(&format!("/channels/{general}"), &owner, json!({"rate_limit_per_user": 10})).await;
    assert_eq!(status, StatusCode::OK, "{channel}");
    assert_eq!(channel["rate_limit_per_user"], 10);

    // A member gets one message, then a 429 with the slowmode code and what is left of the wait.
    assert_eq!(app.post(&path, &alice, json!({"content": "one"})).await.0, StatusCode::OK);
    let (status, body) = app.post(&path, &alice, json!({"content": "two"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], 20016);
    let left = body["retry_after"].as_f64().expect("retry_after");
    assert!(left > 0.0 && left <= 10.0, "retry_after {left}");

    // Owner, MANAGE_MESSAGES and BYPASS_SLOWMODE are not limited.
    for token in [&owner, &mod_token, &vip_token] {
        assert_eq!(app.post(&path, token, json!({"content": "a"})).await.0, StatusCode::OK);
        assert_eq!(app.post(&path, token, json!({"content": "b"})).await.0, StatusCode::OK);
    }

    // The wait runs out.
    app.patch(&format!("/channels/{general}"), &owner, json!({"rate_limit_per_user": 1})).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(app.post(&path, &alice, json!({"content": "three"})).await.0, StatusCode::OK);
    assert_eq!(app.post(&path, &alice, json!({"content": "four"})).await.0, StatusCode::TOO_MANY_REQUESTS);

    // Turning it off lifts it at once.
    app.patch(&format!("/channels/{general}"), &owner, json!({"rate_limit_per_user": 0})).await;
    assert_eq!(app.post(&path, &alice, json!({"content": "five"})).await.0, StatusCode::OK);
}
