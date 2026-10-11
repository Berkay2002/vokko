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
