mod common;

use axum::http::Method;
use common::TestApp;
use serde_json::{Value, json};

async fn count(app: &TestApp, table: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(&format!("SELECT count(*) FROM {table}")).fetch_one(&app.state.db).await.expect("count");
    n
}

#[tokio::test]
async fn seed_is_idempotent_and_usable() {
    let app = TestApp::new().await;
    let summary = vokko_server::seed::run(&app.state).await.expect("first seed");
    assert!(summary.contains("seeded 5 users"), "{summary}");
    let before = (count(&app, "users").await, count(&app, "messages").await, count(&app, "reactions").await, count(&app, "channels").await);
    let again = vokko_server::seed::run(&app.state).await.expect("second seed");
    assert!(again.contains("already present"), "{again}");
    let after = (count(&app, "users").await, count(&app, "messages").await, count(&app, "reactions").await, count(&app, "channels").await);
    assert_eq!(before, after);
    assert_eq!(before.0, 5);

    // the demo accounts log in with the documented password
    let (status, login) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "sam", "password": "vokko-dev"}))).await;
    assert_eq!(status, 200, "{login}");
    let token = login["token"].as_str().expect("token").to_owned();
    let (_, carol_login) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "carol", "password": "vokko-dev"}))).await;
    assert!(carol_login["token"].is_string());

    // DM sam <-> carol
    let (_, dms) = app.get("/users/@me/channels", &token).await;
    let dm = dms
        .as_array()
        .expect("dms")
        .iter()
        .find(|c| c["recipients"].as_array().is_some_and(|r| r.iter().any(|u| u["username"] == "carol")))
        .expect("dm")
        .clone();
    let dm_id = dm["id"].as_str().expect("id").to_owned();
    let mut all: Vec<Value> = Vec::new();
    let mut before_id: Option<String> = None;
    loop {
        let path = match &before_id {
            Some(id) => format!("/channels/{dm_id}/messages?limit=100&before={id}"),
            None => format!("/channels/{dm_id}/messages?limit=100"),
        };
        let (_, page) = app.get(&path, &token).await;
        let page = page.as_array().expect("page").clone();
        if page.is_empty() {
            break;
        }
        before_id = page.last().and_then(|m| m["id"].as_str()).map(str::to_owned);
        all.extend(page);
    }
    assert!(all.len() >= 60, "{} messages", all.len());
    assert!(all.iter().any(|m| m["type"] == 19 && m["referenced_message"].is_object()), "has replies");
    assert!(all.iter().any(|m| m["edited_timestamp"].is_string()), "has an edit");
    assert!(all.iter().any(|m| m["content"].as_str().is_some_and(|c| c.contains("```"))), "has a code block");
    assert!(all.iter().any(|m| m["reactions"].as_array().is_some_and(|r| !r.is_empty())), "has reactions");
    assert!(all.iter().any(|m| m["pinned"] == true), "has a pin");
    let with_image = all.iter().find(|m| m["attachments"].as_array().is_some_and(|a| !a.is_empty())).expect("image message");
    let image = &with_image["attachments"][0];
    assert_eq!((image["content_type"].clone(), image["width"].clone(), image["height"].clone()), (json!("image/png"), json!(256), json!(144)));
    let path = image["url"].as_str().expect("url").strip_prefix("http://test.local").expect("prefix").to_owned();
    let response = tower::ServiceExt::oneshot(app.router.clone(), axum::http::Request::builder().uri(path).body(axum::body::Body::empty()).expect("request"))
        .await
        .expect("response");
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "image/png");

    // guild, friends, pending request, presences
    let (_, guilds) = app.get("/users/@me/guilds", &token).await;
    assert_eq!(guilds[0]["name"], "Sam's server");
    let guild_id = guilds[0]["id"].as_str().expect("id").to_owned();
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &token).await;
    let names: Vec<&str> = channels.as_array().expect("channels").iter().filter_map(|c| c["name"].as_str()).collect();
    for expected in ["Information", "general", "dev-talk", "Lounge"] {
        assert!(names.contains(&expected), "{expected} in {names:?}");
    }
    let (_, relationships) = app.get("/users/@me/relationships", &token).await;
    let kinds: Vec<u64> = relationships.as_array().expect("relationships").iter().filter_map(|r| r["type"].as_u64()).collect();
    assert_eq!(kinds.iter().filter(|k| **k == 1).count(), 3);
    assert_eq!(kinds.iter().filter(|k| **k == 3).count(), 1);
    let (_, nova_login) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": "nova", "password": "vokko-dev"}))).await;
    assert!(nova_login["token"].is_string());
    let (status,): (String,) = sqlx::query_as("SELECT status FROM presences p JOIN users u ON u.id = p.user_id WHERE u.username = 'bob'")
        .fetch_one(&app.state.db)
        .await
        .expect("presence");
    assert_eq!(status, "dnd");
}
