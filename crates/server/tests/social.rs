mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn friend_request_flow() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (alice, alice_user) = app.register("alice").await;
    let sam_id = sam_user["id"].as_str().expect("id");
    let alice_id = alice_user["id"].as_str().expect("id");

    // request by username
    let (status, _) = app.post("/users/@me/relationships", &sam, json!({"username": "Alice"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, mine) = app.get("/users/@me/relationships", &sam).await;
    assert_eq!(mine[0]["type"], 4);
    assert_eq!(mine[0]["id"], alice_id);
    assert_eq!(mine[0]["user"]["username"], "alice");
    let (_, theirs) = app.get("/users/@me/relationships", &alice).await;
    assert_eq!(theirs[0]["type"], 3);
    assert_eq!(theirs[0]["id"], sam_id);

    // accepting by PUT
    assert_eq!(app.put(&format!("/users/@me/relationships/{sam_id}"), &alice).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &sam).await.1[0]["type"], 1);
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1[0]["type"], 1);

    // removing
    assert_eq!(app.delete(&format!("/users/@me/relationships/{alice_id}"), &sam).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me/relationships", &alice).await.1, json!([]));

    // errors
    assert_eq!(app.put(&format!("/users/@me/relationships/{sam_id}"), &sam).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(app.post("/users/@me/relationships", &sam, json!({"username": "ghost"})).await.1["code"], 10013);
}

#[tokio::test]
async fn direct_and_group_messages_channels() {
    let app = TestApp::new().await;
    let (sam, sam_user) = app.register("sam").await;
    let (_, alice_user) = app.register("alice").await;
    let (_, bob_user) = app.register("bob").await;
    let (nova, nova_user) = app.register("nova").await;

    let (status, dm) = app.post("/users/@me/channels", &sam, json!({"recipient_id": alice_user["id"]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dm["type"], 1);
    assert_eq!(dm["name"], serde_json::Value::Null);
    assert_eq!(dm["recipients"].as_array().expect("recipients").len(), 1);
    assert_eq!(dm["recipients"][0]["username"], "alice");
    assert!(dm.get("owner_id").is_none());

    // same DM again
    let (_, again) = app.post("/users/@me/channels", &sam, json!({"recipient_id": alice_user["id"]})).await;
    assert_eq!(again["id"], dm["id"]);
    let (_, list) = app.get("/users/@me/channels", &sam).await;
    assert_eq!(list.as_array().expect("list").len(), 1);

    // group DM
    let (status, group) = app.post("/users/@me/channels", &sam, json!({"recipient_ids": [alice_user["id"], bob_user["id"]]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(group["type"], 3);
    assert_eq!(group["owner_id"], sam_user["id"]);
    assert_eq!(group["icon"], serde_json::Value::Null);
    assert_eq!(group["recipients"].as_array().expect("recipients").len(), 2);

    // outsiders cannot touch it
    let group_id = group["id"].as_str().expect("id");
    let (status, error) = app.patch(&format!("/channels/{group_id}"), &nova, json!({"name": "x"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], 50001);
    assert_eq!(nova_user["username"], "nova");

    // self DM is invalid
    assert_eq!(app.post("/users/@me/channels", &sam, json!({"recipient_id": sam_user["id"]})).await.0, StatusCode::BAD_REQUEST);

    // closing a DM removes it from the list for that user only
    let dm_id = dm["id"].as_str().expect("id");
    assert_eq!(app.delete(&format!("/channels/{dm_id}"), &sam).await.0, StatusCode::OK);
    let (_, list) = app.get("/users/@me/channels", &sam).await;
    assert_eq!(list.as_array().expect("list").len(), 1);
}
