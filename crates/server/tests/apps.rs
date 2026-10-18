#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Bots, application commands, interactions, ephemeral messages and webhooks (docs/api.md "Apps").
mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
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
    async fn connect(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        let hello = client.recv().await.expect("hello");
        assert_eq!(hello["op"], 10);
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        client.wait_for("READY").await;
        client
    }

    async fn recv(&mut self) -> Result<Value, Option<u16>> {
        loop {
            match tokio::time::timeout(Duration::from_secs(8), self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return Ok(serde_json::from_str(&text).expect("json frame")),
                Ok(Some(Ok(Message::Close(frame)))) => return Err(frame.map(|frame| u16::from(frame.code))),
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => return Err(None),
                Err(_) => panic!("timed out waiting for a gateway frame"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.recv().await.unwrap_or_else(|code| panic!("closed ({code:?}) while waiting for {name}"));
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    /// The close code once the server ends the connection.
    async fn closed(&mut self) -> Option<u16> {
        loop {
            if let Err(code) = self.recv().await {
                return code;
            }
        }
    }

    /// True if no dispatch named `name` arrives within `window`.
    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(next) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            match next {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).expect("json");
                    if frame["t"] == name {
                        return false;
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
        true
    }
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
}

/// An application owned by `owner`; returns (application id, "Bot <token>").
async fn create_app(app: &TestApp, owner: &str, name: &str) -> (String, String) {
    let (status, created) = app.post("/applications", owner, json!({"name": name})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["bot"]["bot"], true);
    assert_eq!(created["bot"]["id"], created["id"], "the bot user id is the application id");
    (id(&created), format!("Bot {}", created["token"].as_str().expect("token")))
}

/// Adds the bot to the guild through the authorize flow.
async fn add_bot(app: &TestApp, owner: &str, app_id: &str, guild: &str) -> Value {
    let (status, added) = app.post(&format!("/oauth2/authorize?client_id={app_id}"), owner, json!({"guild_id": guild, "permissions": "2048"})).await;
    assert_eq!(status, StatusCode::OK, "{added}");
    added
}

/// `user` joins the guild of `channel` through an invite from `owner`.
async fn join(app: &TestApp, owner: &str, channel: &str, user: &str) {
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), owner, json!({})).await;
    let code = invite["code"].as_str().expect("code");
    let (status, body) = app.post(&format!("/invites/{code}"), user, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn echo_commands(app: &TestApp, bot: &str, app_id: &str) -> Vec<Value> {
    let (status, commands) = app
        .put_json(
            &format!("/applications/{app_id}/commands"),
            bot,
            json!([
                {"name": "echo", "description": "Repeat text", "options": [{"type": 3, "name": "text", "description": "What to say", "required": true}]},
                {"name": "roll", "description": "Roll a die", "options": [{"type": 4, "name": "sides", "description": "Sides", "min_value": 2, "max_value": 100}]},
                {"name": "Wave at", "type": 2}
            ]),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{commands}");
    commands.as_array().expect("commands").clone()
}

fn command<'a>(commands: &'a [Value], name: &str) -> &'a Value {
    commands.iter().find(|command| command["name"] == name).expect("command")
}

async fn invoke(app: &TestApp, user: &str, app_id: &str, channel: &str, command: &Value, options: Value) -> (StatusCode, Value) {
    app.post(
        "/interactions",
        user,
        json!({"type": 2, "application_id": app_id, "channel_id": channel, "nonce": "n1",
               "data": {"id": command["id"], "name": command["name"], "type": command["type"], "options": options}}),
    )
    .await
}

#[tokio::test]
async fn bot_tokens_authenticate_rest_and_gateway_only_with_the_prefix() {
    let app = TestApp::new().await;
    let (owner, owner_user) = app.register("owner").await;
    let (app_id, bot) = create_app(&app, &owner, "Echo Bot").await;
    let (status, me) = app.get("/users/@me", &bot).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((me["id"].as_str(), me["bot"].as_bool(), me["global_name"].as_str()), (Some(app_id.as_str()), Some(true), Some("Echo Bot")));
    let raw = bot.strip_prefix("Bot ").expect("prefix");
    assert_eq!(app.get("/users/@me", raw).await.0, StatusCode::UNAUTHORIZED, "a bot token without the prefix is rejected");
    assert_eq!(app.get("/users/@me", &format!("Bot {owner}")).await.0, StatusCode::UNAUTHORIZED, "a user token with the prefix is rejected");
    // people-only routes
    let (status, error) = app.post("/applications", &bot, json!({"name": "Spawn"})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(20001)));
    // a bot can never log in with a password
    let (status, _) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": me["username"], "password": ""}))).await;
    assert_ne!(status, StatusCode::OK);
    // gateway: READY as the bot, closed 4004 when the token is reset
    let address = app.serve().await;
    let mut gateway = Client::connect(&address, &bot).await;
    let (status, reset) = app.post(&format!("/applications/{app_id}/bot/reset"), &owner, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(gateway.closed().await, Some(4004));
    assert_eq!(app.get("/users/@me", &bot).await.0, StatusCode::UNAUTHORIZED, "the old token is revoked");
    let fresh = format!("Bot {}", reset["token"].as_str().expect("token"));
    assert_eq!(app.get("/users/@me", &fresh).await.0, StatusCode::OK);
    // the bot reads its own application (owner_id); a person gets 404
    let (status, own) = app.get("/applications/@me", &fresh).await;
    assert_eq!((status, own["id"].as_str(), own["owner_id"].as_str()), (StatusCode::OK, Some(app_id.as_str()), owner_user["id"].as_str()));
    assert_eq!(app.get("/applications/@me", &owner).await.0, StatusCode::NOT_FOUND);
    // only the owner sees and edits the application
    let (stranger, _) = app.register("stranger").await;
    assert_eq!(app.get(&format!("/applications/{app_id}"), &stranger).await.0, StatusCode::NOT_FOUND);
    let (status, edited) = app.patch(&format!("/applications/{app_id}"), &owner, json!({"name": "Echo", "bot_public": false})).await;
    assert_eq!((status, edited["bot"]["global_name"].as_str(), edited["bot_public"].as_bool()), (StatusCode::OK, Some("Echo"), Some(false)));
    let (_, list) = app.get("/applications", &owner).await;
    assert_eq!(list.as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn commands_show_only_where_the_bot_is_and_the_caller_may_use_them() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (member, _) = app.register("member").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &member).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let commands = echo_commands(&app, &bot, &app_id).await;
    assert_eq!(commands.len(), 3);

    // not in the guild yet: nothing to see, and the bot cannot register guild commands there
    let (_, index) = app.get(&format!("/channels/{channel}/application-commands"), &member).await;
    assert_eq!(index["application_commands"], json!([]));
    assert_eq!(
        app.post(&format!("/applications/{app_id}/guilds/{guild}/commands"), &bot, json!({"name": "g", "description": "g"})).await.0,
        StatusCode::FORBIDDEN
    );

    // adding needs MANAGE_GUILD
    let (status, _) = app.post(&format!("/oauth2/authorize?client_id={app_id}"), &member, json!({"guild_id": guild})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, info) = app.get(&format!("/oauth2/authorize?client_id={app_id}&permissions=2048"), &owner).await;
    assert_eq!((info["permissions"].as_str(), info["guilds"][0]["id"].as_str()), (Some("2048"), Some(guild.as_str())));
    let added = add_bot(&app, &owner, &app_id, &guild).await;
    assert!(added["role_id"].is_string(), "a role holds the granted bits");
    let (status, again) = app.post(&format!("/oauth2/authorize?client_id={app_id}"), &owner, json!({"guild_id": guild})).await;
    assert_eq!((status, again["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)));

    // a guild command and one limited to MANAGE_GUILD
    let (status, created) = app
        .post(
            &format!("/applications/{app_id}/guilds/{guild}/commands"),
            &bot,
            json!({"name": "admin", "description": "Admins only", "default_member_permissions": "32"}),
        )
        .await;
    assert_eq!((status, created["guild_id"].as_str()), (StatusCode::CREATED, Some(guild.as_str())));
    let names = |index: &Value| -> Vec<String> {
        let mut names: Vec<String> =
            index["application_commands"].as_array().expect("list").iter().map(|c| c["name"].as_str().expect("name").to_owned()).collect();
        names.sort();
        names
    };
    let (_, index) = app.get(&format!("/channels/{channel}/application-commands"), &member).await;
    assert_eq!(names(&index), ["Wave at", "echo", "roll"]);
    assert_eq!(index["applications"][0]["id"].as_str(), Some(app_id.as_str()));
    let (_, index) = app.get(&format!("/channels/{channel}/application-commands"), &owner).await;
    assert_eq!(names(&index), ["Wave at", "admin", "echo", "roll"]);
    let (status, _) = invoke(&app, &member, &app_id, &channel, &created, json!([])).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "default_member_permissions holds for running too");

    // another guild without the bot sees nothing
    let (_, elsewhere) = app.guild_with_channel(&member).await;
    let (_, index) = app.get(&format!("/channels/{elsewhere}/application-commands"), &member).await;
    assert_eq!(index["application_commands"], json!([]));
    let (status, error) = invoke(&app, &member, &app_id, &elsewhere, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "x"}])).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10063)));

    // without USE_APPLICATION_COMMANDS the index is empty and running fails
    let use_commands: u64 = 1 << 31;
    let everyone_bits: u64 = info["guilds"][0]["permissions"].as_str().expect("bits").parse::<u64>().expect("number");
    assert_ne!(everyone_bits & use_commands, 0);
    let (_, guild_json) = app.get(&format!("/guilds/{guild}"), &owner).await;
    let everyone = guild_json["roles"].as_array().expect("roles").iter().find(|role| role["id"] == guild.as_str()).expect("@everyone").clone();
    let reduced = everyone["permissions"].as_str().expect("perms").parse::<u64>().expect("number") & !use_commands;
    let (status, _) = app.patch(&format!("/guilds/{guild}/roles/{guild}"), &owner, json!({"permissions": reduced.to_string()})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, index) = app.get(&format!("/channels/{channel}/application-commands"), &member).await;
    assert_eq!(index["application_commands"], json!([]));
    let (status, _) = invoke(&app, &member, &app_id, &channel, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "x"}])).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // integrations: listed for MANAGE_GUILD, removing takes the bot, its role and its guild commands
    assert_eq!(app.get(&format!("/guilds/{guild}/integrations"), &member).await.0, StatusCode::FORBIDDEN);
    let (_, integrations) = app.get(&format!("/guilds/{guild}/integrations"), &owner).await;
    assert_eq!((integrations[0]["id"].as_str(), integrations[0]["user"]["username"].as_str()), (Some(app_id.as_str()), Some("owner")));
    assert_eq!(app.delete(&format!("/guilds/{guild}/integrations/{app_id}"), &owner).await.0, StatusCode::NO_CONTENT);
    let (_, integrations) = app.get(&format!("/guilds/{guild}/integrations"), &owner).await;
    assert_eq!(integrations, json!([]));
    let (_, guild_json) = app.get(&format!("/guilds/{guild}"), &owner).await;
    assert!(!guild_json["roles"].as_array().expect("roles").iter().any(|role| role["id"] == added["role_id"]));
    let (_, left) = app.get(&format!("/applications/{app_id}/guilds/{guild}/commands"), &owner).await;
    assert_eq!(left["code"].as_u64(), Some(50001), "the bot is gone from the guild");
}

#[tokio::test]
async fn command_bodies_are_validated_and_upserted_by_name() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let path = format!("/applications/{app_id}/commands");
    for bad in [
        json!({"name": "Echo", "description": "x"}),
        json!({"name": "echo"}),
        json!({"name": "echo", "description": "x", "options": [{"type": 3, "name": "a", "description": "a"}, {"type": 3, "name": "b", "description": "b", "required": true}]}),
        json!({"name": "echo", "description": "x", "options": [{"type": 5, "name": "a", "description": "a", "choices": [{"name": "y", "value": "y"}]}]}),
    ] {
        let (status, error) = app.post(&path, &bot, bad.clone()).await;
        assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)), "{bad}");
    }
    let (status, first) = app.post(&path, &owner, json!({"name": "echo", "description": "One"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, second) = app.post(&path, &bot, json!({"name": "echo", "description": "Two"})).await;
    assert_eq!((status, second["id"].clone()), (StatusCode::OK, first["id"].clone()), "same name and type replaces");
    assert_ne!(second["version"], first["version"]);
    let (status, patched) = app.patch(&format!("{path}/{}", id(&first)), &bot, json!({"description": "Three"})).await;
    assert_eq!((status, patched["name"].as_str(), patched["description"].as_str()), (StatusCode::OK, Some("echo"), Some("Three")));
    let (stranger, _) = app.register("stranger").await;
    assert_eq!(app.get(&path, &stranger).await.0, StatusCode::NOT_FOUND);
    for n in 0..5 {
        assert_eq!(app.post(&path, &bot, json!({"name": format!("User {n}"), "type": 2})).await.0, StatusCode::CREATED);
    }
    let (status, error) = app.post(&path, &bot, json!({"name": "User 6", "type": 2})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(30032)));
    assert_eq!(app.delete(&format!("{path}/{}", id(&first)), &bot).await.0, StatusCode::NO_CONTENT);
    let (_, list) = app.get(&path, &bot).await;
    assert_eq!(list.as_array().map(Vec::len), Some(5));
}

#[tokio::test]
async fn interaction_lifecycle_callback_followup_edit_and_expiry() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, owner_user) = app.register("owner").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let commands = echo_commands(&app, &bot, &app_id).await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let mut bot_gateway = Client::connect(&address, &bot).await;
    let mut user_gateway = Client::connect(&address, &owner).await;

    // bad options never reach the bot
    let (status, _) = invoke(&app, &owner, &app_id, &channel, command(&commands, "echo"), json!([])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = invoke(&app, &owner, &app_id, &channel, command(&commands, "roll"), json!([{"name": "sides", "type": 4, "value": 1000}])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, created) =
        invoke(&app, &owner, &app_id, &channel, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "hi there"}])).await;
    assert_eq!((status, created["nonce"].as_str()), (StatusCode::OK, Some("n1")));
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert_eq!(interaction["id"], created["id"]);
    assert_eq!((interaction["data"]["name"].as_str(), interaction["data"]["options"][0]["value"].as_str()), (Some("echo"), Some("hi there")));
    assert_eq!((interaction["user"]["id"].clone(), interaction["member"]["user"]["id"].clone()), (owner_user["id"].clone(), owner_user["id"].clone()));
    let token = interaction["token"].as_str().expect("token").to_owned();
    let callback = format!("/interactions/{}/{token}/callback", id(&interaction));
    // the callback needs no Authorization header; a wrong token is an unknown interaction
    let (status, error) =
        app.send(Method::POST, &format!("/interactions/{}/nope/callback", id(&interaction)), None, Some(json!({"type": 4, "data": {"content": "x"}}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10062)));
    let (status, _) = app.send(Method::POST, &callback, None, Some(json!({"type": 4, "data": {"content": "You said: hi there"}}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let message = user_gateway.wait_for("MESSAGE_CREATE").await;
    assert_eq!((message["type"].as_u64(), message["content"].as_str()), (Some(20), Some("You said: hi there")));
    assert_eq!((message["author"]["id"].as_str(), message["author"]["bot"].as_bool()), (Some(app_id.as_str()), Some(true)));
    assert_eq!((message["application_id"].as_str(), message["webhook_id"].as_str()), (Some(app_id.as_str()), Some(app_id.as_str())));
    assert_eq!(
        (message["interaction_metadata"]["name"].as_str(), message["interaction_metadata"]["user"]["id"].clone()),
        (Some("echo"), owner_user["id"].clone())
    );
    let (status, error) = app.send(Method::POST, &callback, None, Some(json!({"type": 4, "data": {"content": "again"}}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(40060)));
    // it is a normal message in the history
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert_eq!(history[0]["interaction_metadata"]["name"].as_str(), Some("echo"));

    // followup and edit of @original through the webhook URLs
    let base = format!("/webhooks/{app_id}/{token}");
    let (status, followup) = app.send(Method::POST, &base, None, Some(json!({"content": "and one more"}))).await;
    assert_eq!((status, followup["content"].as_str(), followup["application_id"].as_str()), (StatusCode::OK, Some("and one more"), Some(app_id.as_str())));
    let (status, edited) = app.send(Method::PATCH, &format!("{base}/messages/@original"), None, Some(json!({"content": "edited"}))).await;
    assert_eq!((status, edited["content"].as_str(), edited["id"].clone()), (StatusCode::OK, Some("edited"), message["id"].clone()));
    assert!(edited["edited_timestamp"].is_string());
    let (status, _) = app.send(Method::DELETE, &format!("{base}/messages/{}", id(&followup)), None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // the token is an interaction token, nothing else
    assert_eq!(app.get("/users/@me", &token).await.0, StatusCode::UNAUTHORIZED);

    // 15 minutes later the token is dead
    sqlx::query("UPDATE interactions SET created_at = now() - interval '16 minutes' WHERE id = $1")
        .bind(id(&interaction).parse::<i64>().expect("id"))
        .execute(&app.state.db)
        .await
        .expect("backdate");
    let (status, error) = app.send(Method::POST, &base, None, Some(json!({"content": "too late"}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10062)));
    let (status, _) = app.send(Method::PATCH, &format!("{base}/messages/@original"), None, Some(json!({"content": "too late"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // deferred: "thinking" until the bot edits @original
    let (_, deferred) = invoke(&app, &owner, &app_id, &channel, command(&commands, "roll"), json!([{"name": "sides", "type": 4, "value": 6}])).await;
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert_eq!(interaction["id"], deferred["id"]);
    let token = interaction["token"].as_str().expect("token").to_owned();
    let (status, _) = app.send(Method::POST, &format!("/interactions/{}/{token}/callback", id(&interaction)), None, Some(json!({"type": 5}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let thinking = loop {
        let created = user_gateway.wait_for("MESSAGE_CREATE").await;
        if created["type"] == 20 {
            break created;
        }
    };
    assert_eq!((thinking["flags"].as_u64(), thinking["content"].as_str()), (Some(128), Some("")));
    let (status, _) = app.send(Method::PATCH, &format!("/webhooks/{app_id}/{token}/messages/@original"), None, Some(json!({"content": "4"}))).await;
    assert_eq!(status, StatusCode::OK);
    let done = user_gateway.wait_for("MESSAGE_UPDATE").await;
    assert_eq!((done["id"].clone(), done["content"].as_str(), done.get("flags").cloned()), (thinking["id"].clone(), Some("4"), None));
    assert!(done["edited_timestamp"].is_null(), "filling in a deferred response is not an edit");

    // no answer within 3 seconds: the user is told, and a late callback is refused
    let (_, ignored) = invoke(&app, &owner, &app_id, &channel, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "anyone?"}])).await;
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    let failure = user_gateway.wait_for("INTERACTION_FAILURE").await;
    assert_eq!((failure["id"].clone(), failure["nonce"].as_str()), (ignored["id"].clone(), Some("n1")));
    let late = format!("/interactions/{}/{}/callback", id(&interaction), interaction["token"].as_str().expect("token"));
    let (status, error) = app.send(Method::POST, &late, None, Some(json!({"type": 4, "data": {"content": "sorry"}}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::NOT_FOUND, Some(10062)));
}

#[tokio::test]
async fn ephemeral_responses_never_reach_other_sessions() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("owner").await;
    let (other, _) = app.register("other").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &other).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let commands = echo_commands(&app, &bot, &app_id).await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let mut bot_gateway = Client::connect(&address, &bot).await;
    let mut owner_gateway = Client::connect(&address, &owner).await;
    let mut other_gateway = Client::connect(&address, &other).await;

    invoke(&app, &owner, &app_id, &channel, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "secret"}])).await;
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    let token = interaction["token"].as_str().expect("token").to_owned();
    let callback = format!("/interactions/{}/{token}/callback", id(&interaction));
    let (status, _) = app.send(Method::POST, &callback, None, Some(json!({"type": 4, "data": {"content": "only for you", "flags": 64}}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let mine = owner_gateway.wait_for("MESSAGE_CREATE").await;
    assert_eq!((mine["content"].as_str(), mine["flags"].as_u64()), (Some("only for you"), Some(64)));
    let (status, followup) = app.send(Method::POST, &format!("/webhooks/{app_id}/{token}"), None, Some(json!({"content": "also secret", "flags": 64}))).await;
    assert_eq!((status, followup["flags"].as_u64()), (StatusCode::OK, Some(64)));
    assert!(other_gateway.silent_for("MESSAGE_CREATE", Duration::from_millis(500)).await, "the other member never gets it");
    assert!(bot_gateway.silent_for("MESSAGE_CREATE", Duration::from_millis(100)).await, "nor does the bot's own session");

    // history: the caller sees it, the other member does not; search never does
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert!(history.as_array().expect("history").iter().any(|message| message["id"] == mine["id"]));
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &other).await;
    assert!(!history.as_array().expect("history").iter().any(|message| message["flags"] == 64));
    let (_, found) = app.get(&format!("/guilds/{guild}/messages/search?content=secret"), &owner).await;
    assert_eq!(found["total_results"].as_u64(), Some(0));
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &other).await;
    let general = channels.as_array().expect("channels").iter().find(|c| c["id"] == channel.as_str()).expect("general").clone();
    assert_ne!(general["last_message_id"], mine["id"], "an ephemeral message does not move the channel");

    // nobody else can touch it; its recipient can dismiss it
    let message_path = format!("/channels/{channel}/messages/{}", id(&mine));
    assert_eq!(app.delete(&message_path, &other).await.0, StatusCode::NOT_FOUND);
    assert_eq!(app.put(&format!("{message_path}/reactions/%F0%9F%91%8D/@me"), &owner).await.0, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&message_path, &owner).await.0, StatusCode::NO_CONTENT);
    let deleted = owner_gateway.wait_for("MESSAGE_DELETE").await;
    assert_eq!(deleted["id"], mine["id"]);
    assert!(other_gateway.silent_for("MESSAGE_DELETE", Duration::from_millis(300)).await);
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert!(!history.as_array().expect("history").iter().any(|message| message["id"] == mine["id"]));
    // the bot edits its ephemeral followup: only the recipient hears about it
    let (status, edited) =
        app.send(Method::PATCH, &format!("/webhooks/{app_id}/{token}/messages/{}", id(&followup)), None, Some(json!({"content": "changed"}))).await;
    assert_eq!((status, edited["content"].as_str()), (StatusCode::OK, Some("changed")));
    assert_eq!(owner_gateway.wait_for("MESSAGE_UPDATE").await["content"].as_str(), Some("changed"));
    assert!(other_gateway.silent_for("MESSAGE_UPDATE", Duration::from_millis(300)).await);
}

#[tokio::test]
async fn webhooks_execute_with_overrides_and_their_token_reaches_nothing_else() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("owner").await;
    let (member, _) = app.register("member").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &member).await;
    let mut owner_gateway = Client::connect(&address, &owner).await;
    let mut member_gateway = Client::connect(&address, &member).await;

    let (status, _) = app.post(&format!("/channels/{channel}/webhooks"), &member, json!({"name": "Hook"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "MANAGE_WEBHOOKS is needed");
    let (status, error) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Discord news"})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)));
    let (status, hook) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Alerts"})).await;
    assert_eq!((status, hook["type"].as_u64()), (StatusCode::OK, Some(1)));
    let update = owner_gateway.wait_for("WEBHOOKS_UPDATE").await;
    assert_eq!((update["guild_id"].as_str(), update["channel_id"].as_str()), (Some(guild.as_str()), Some(channel.as_str())));
    assert!(member_gateway.silent_for("WEBHOOKS_UPDATE", Duration::from_millis(300)).await, "only webhook managers are told");
    let token = hook["token"].as_str().expect("token").to_owned();
    assert!(hook["url"].as_str().expect("url").ends_with(&format!("/api/v1/webhooks/{}/{token}", id(&hook))));
    let execute = format!("/webhooks/{}/{token}", id(&hook));

    let (status, message) = app
        .send(
            Method::POST,
            &format!("{execute}?wait=true"),
            None,
            Some(json!({"content": "build passed", "username": "CI", "avatar_url": "https://example.com/ci.png"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{message}");
    assert_eq!((message["author"]["username"].as_str(), message["author"]["avatar"].as_str()), (Some("CI"), Some("https://example.com/ci.png")));
    assert_eq!(
        (message["author"]["id"].clone(), message["webhook_id"].clone(), message["author"]["bot"].as_bool()),
        (hook["id"].clone(), hook["id"].clone(), Some(true))
    );
    let seen = member_gateway.wait_for("MESSAGE_CREATE").await;
    assert_eq!(seen["id"], message["id"]);
    let (status, body) = app.send(Method::POST, &execute, None, Some(json!({"content": "no wait"}))).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let (status, error) = app.send(Method::POST, &execute, None, Some(json!({"content": "  "}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50006)));
    let (status, error) = app.send(Method::POST, &execute, None, Some(json!({"content": "x", "avatar_url": "javascript:alert(1)"}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)));
    // the stored name is used without an override, and history shows the identity it was sent with
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &member).await;
    assert_eq!(history[0]["author"]["username"].as_str(), Some("Alerts"));
    assert_eq!(history[1]["author"]["username"].as_str(), Some("CI"));

    // token isolation
    assert_eq!(app.get("/users/@me", &token).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get(&format!("/channels/{channel}/messages"), &token).await.0, StatusCode::UNAUTHORIZED);
    let (status, error) = app.send(Method::POST, &format!("/webhooks/{}/{}", id(&hook), "0".repeat(68)), None, Some(json!({"content": "x"}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::UNAUTHORIZED, Some(50027)));
    let (_, second) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Other"})).await;
    let (status, _) = app.send(Method::POST, &format!("/webhooks/{}/{token}", id(&second)), None, Some(json!({"content": "x"}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "one webhook's token does not unlock another");
    let (_, user_message) = app.post(&format!("/channels/{channel}/messages"), &member, json!({"content": "mine"})).await;
    let (status, _) = app.send(Method::PATCH, &format!("{execute}/messages/{}", id(&user_message)), None, Some(json!({"content": "hacked"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "the token only reaches its own messages");
    let (status, edited) = app.send(Method::PATCH, &format!("{execute}/messages/{}", id(&message)), None, Some(json!({"content": "build passed (2)"}))).await;
    assert_eq!((status, edited["content"].as_str()), (StatusCode::OK, Some("build passed (2)")));
    let (status, public) = app.send(Method::GET, &execute, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(public.get("token").is_none() && public.get("user").is_none(), "token views hide the secrets");

    // management
    let (_, list) = app.get(&format!("/guilds/{guild}/webhooks"), &owner).await;
    assert_eq!(list.as_array().map(Vec::len), Some(2));
    assert_eq!(app.get(&format!("/guilds/{guild}/webhooks"), &member).await.0, StatusCode::FORBIDDEN);
    let (status, renamed) = app.patch(&format!("/webhooks/{}", id(&hook)), &owner, json!({"name": "Builds"})).await;
    assert_eq!((status, renamed["name"].as_str()), (StatusCode::OK, Some("Builds")));
    assert_eq!(app.delete(&format!("/webhooks/{}", id(&second)), &owner).await.0, StatusCode::NO_CONTENT);
    let (status, _) =
        app.send(Method::POST, &format!("/webhooks/{}/{}", id(&second), second["token"].as_str().expect("token")), None, Some(json!({"content": "x"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // rate limit: burst 5 per webhook. The clock is stopped: each send looks the webhook up before the check, so on a slow
    // database the ten checks spread out and the refill (2.5/s) could keep up.
    app.state.limiter.freeze_clock();
    let sends = (0..10).map(|n| app.send(Method::POST, &execute, None, Some(json!({"content": format!("spam {n}")}))));
    let results = futures_util::future::join_all(sends).await;
    let limited: Vec<&Value> = results.iter().filter(|(status, _)| *status == StatusCode::TOO_MANY_REQUESTS).map(|(_, body)| body).collect();
    assert!(limited.len() >= 5, "at most a burst of five gets through (the sends above used some of it): {} limited", limited.len());
    assert!(limited.iter().all(|body| body["retry_after"].as_f64().is_some_and(|wait| wait > 0.0)));
}

#[tokio::test]
async fn deleting_an_application_removes_its_bot_everywhere() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let (_, sent) = app.post(&format!("/channels/{channel}/messages"), &bot, json!({"content": "hello from a bot"})).await;
    assert_eq!(sent["author"]["bot"].as_bool(), Some(true), "bots post with the regular message route");
    assert_eq!(app.delete(&format!("/applications/{app_id}"), &owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/users/@me", &bot).await.0, StatusCode::UNAUTHORIZED);
    let (_, members) = app.get(&format!("/guilds/{guild}/members"), &owner).await;
    assert!(!members.as_array().expect("members").iter().any(|member| member["user"]["id"] == app_id.as_str()));
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert!(history.as_array().expect("history").iter().any(|message| message["id"] == sent["id"]), "old messages keep their author");
}

const MANAGE_ROLES: &str = "268435456";

#[tokio::test]
async fn a_bots_role_is_managed_and_leaves_with_the_bot() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (moderator, moderator_user) = app.register("moderator").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &moderator).await;
    let moderator_id = id(&moderator_user);
    let (status, mods) = app.post(&format!("/guilds/{guild}/roles"), &owner, json!({"name": "Mods", "permissions": MANAGE_ROLES})).await;
    assert_eq!(status, StatusCode::OK, "{mods}");
    let mods = id(&mods);
    let (status, body) = app.patch(&format!("/guilds/{guild}/members/{moderator_id}"), &owner, json!({"roles": [mods]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (app_id, _) = create_app(&app, &owner, "Admin Bot").await;
    let (status, added) = app.post(&format!("/oauth2/authorize?client_id={app_id}"), &owner, json!({"guild_id": guild, "permissions": "8"})).await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let bot_role = added["role_id"].as_str().expect("bot role").to_owned();

    // a MANAGE_ROLES moderator cannot hand themselves the bot's ADMINISTRATOR role
    let (status, error) = app.patch(&format!("/guilds/{guild}/members/{moderator_id}"), &moderator, json!({"roles": [mods, bot_role]})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)), "{error}");
    assert_eq!(app.patch(&format!("/guilds/{guild}"), &moderator, json!({"name": "Mine now"})).await.0, StatusCode::FORBIDDEN);
    // nor can the owner assign, remove, edit or delete it
    let (status, _) = app.patch(&format!("/guilds/{guild}/members/{moderator_id}"), &owner, json!({"roles": [mods, bot_role]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.patch(&format!("/guilds/{guild}/members/{app_id}"), &owner, json!({"roles": []})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.patch(&format!("/guilds/{guild}/roles/{bot_role}"), &owner, json!({"name": "Mine", "permissions": "8"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, error) = app.delete(&format!("/guilds/{guild}/roles/{bot_role}"), &owner).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)));
    let (_, members) = app.get(&format!("/guilds/{guild}/members"), &owner).await;
    let theirs = members.as_array().expect("members").iter().find(|row| row["user"]["id"] == moderator_id.as_str()).expect("moderator").clone();
    assert_eq!(theirs["roles"], json!([mods]));

    // a kick takes the integration and the role along, so adding the bot again starts clean
    assert_eq!(app.delete(&format!("/guilds/{guild}/members/{app_id}"), &owner).await.0, StatusCode::NO_CONTENT);
    let (_, full) = app.get(&format!("/guilds/{guild}"), &owner).await;
    assert!(!full["roles"].as_array().expect("roles").iter().any(|role| role["id"] == bot_role.as_str()), "the bot role is gone");
    let (_, integrations) = app.get(&format!("/guilds/{guild}/integrations"), &owner).await;
    assert_eq!(integrations, json!([]));
    let (status, again) = app.post(&format!("/oauth2/authorize?client_id={app_id}"), &owner, json!({"guild_id": guild, "permissions": "8"})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let (_, full) = app.get(&format!("/guilds/{guild}"), &owner).await;
    assert_eq!(full["roles"].as_array().expect("roles").iter().filter(|role| role["name"] == "Admin Bot").count(), 1);
}

#[tokio::test]
async fn bot_tokens_only_reach_the_routes_listed_for_bots() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (member, member_user) = app.register("member").await;
    let (_, stranger_user) = app.register("stranger").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &member).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    let code = invite["code"].as_str().expect("code");
    let stranger_id = id(&stranger_user);
    let denied = [
        (Method::POST, format!("/invites/{code}"), Some(json!({}))),
        (Method::POST, "/users/@me/relationships".to_owned(), Some(json!({"username": "stranger"}))),
        (Method::PUT, format!("/users/@me/relationships/{stranger_id}"), Some(json!({}))),
        (Method::GET, "/users/@me/relationships".to_owned(), None),
        (Method::POST, "/guilds".to_owned(), Some(json!({"name": "Bot land"}))),
        (Method::DELETE, format!("/guilds/{guild}"), None),
        (Method::POST, "/auth/logout".to_owned(), Some(json!({}))),
        (Method::GET, "/auth/sessions".to_owned(), None),
        (Method::POST, "/auth/sessions/logout".to_owned(), Some(json!({}))),
        (Method::POST, "/auth/verify/resend".to_owned(), Some(json!({}))),
        (Method::GET, "/users/@me/account".to_owned(), None),
        (Method::PATCH, "/users/@me/account".to_owned(), Some(json!({"username": "taken"}))),
        (Method::POST, "/users/@me/disable".to_owned(), Some(json!({"password": ""}))),
        (Method::POST, "/users/@me/delete".to_owned(), Some(json!({"password": ""}))),
        (Method::POST, "/users/@me/mfa/totp/enable".to_owned(), Some(json!({"secret": "x", "code": "000000"}))),
        (Method::GET, "/users/@me/oauth".to_owned(), None),
        (Method::GET, "/users/@me/bookmarks".to_owned(), None),
        (Method::POST, "/interactions".to_owned(), Some(json!({}))),
        (Method::GET, "/applications".to_owned(), None),
        (Method::GET, format!("/channels/{channel}/messages/search?content=x"), None),
    ];
    for (method, path, body) in denied {
        let (status, error) = app.send(method.clone(), &path, Some(&bot), body).await;
        assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(20001)), "{method} {path}: {error}");
    }
    // DMs: one-to-one, and only with people the bot shares a guild with
    let (status, error) = app.post("/users/@me/channels", &bot, json!({"recipient_id": stranger_id})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50007)));
    let (status, _) = app.post("/users/@me/channels", &bot, json!({"recipient_ids": [id(&member_user), stranger_id]})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, dm) = app.post("/users/@me/channels", &bot, json!({"recipient_id": id(&member_user)})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let dm = id(&dm);
    assert_eq!(app.post(&format!("/channels/{dm}/messages"), &bot, json!({"content": "hi"})).await.0, StatusCode::OK);
    // once they no longer share a guild, the DM is closed to the bot
    assert_eq!(app.delete(&format!("/guilds/{guild}/members/{}", id(&member_user)), &owner).await.0, StatusCode::NO_CONTENT);
    assert_eq!(app.post(&format!("/channels/{dm}/messages"), &bot, json!({"content": "still there?"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(app.get(&format!("/channels/{dm}/messages"), &bot).await.0, StatusCode::FORBIDDEN);
    // the routes bots use still work
    assert_eq!(app.get("/users/@me", &bot).await.0, StatusCode::OK);
    assert_eq!(app.get(&format!("/guilds/{guild}"), &bot).await.0, StatusCode::OK);
    assert_eq!(app.post(&format!("/channels/{channel}/messages"), &bot, json!({"content": "hello"})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn deleting_the_owners_account_takes_their_bots_down() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("owner").await;
    let (developer, _) = app.register("developer").await;
    let (guild, _) = app.guild_with_channel(&owner).await;
    let (app_id, bot) = create_app(&app, &developer, "Their Bot").await;
    let added = add_bot(&app, &owner, &app_id, &guild).await;
    let bot_role = added["role_id"].as_str().expect("bot role").to_owned();
    let mut bot_gateway = Client::connect(&address, &bot).await;
    let mut owner_gateway = Client::connect(&address, &owner).await;

    let (status, body) = app.post("/users/@me/delete", &developer, json!({"password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(bot_gateway.closed().await, Some(4004), "the bot's gateway session ends");
    assert_eq!(app.get("/users/@me", &bot).await.0, StatusCode::UNAUTHORIZED, "the bot token is revoked");
    let removed = owner_gateway.wait_for("GUILD_MEMBER_REMOVE").await;
    assert_eq!(removed["user"]["id"].as_str(), Some(app_id.as_str()));
    let (_, members) = app.get(&format!("/guilds/{guild}/members"), &owner).await;
    assert!(!members.as_array().expect("members").iter().any(|member| member["user"]["id"] == app_id.as_str()));
    let (_, full) = app.get(&format!("/guilds/{guild}"), &owner).await;
    assert!(!full["roles"].as_array().expect("roles").iter().any(|role| role["id"] == bot_role.as_str()));
    let (_, integrations) = app.get(&format!("/guilds/{guild}/integrations"), &owner).await;
    assert_eq!(integrations, json!([]));
}

#[tokio::test]
async fn interaction_responses_ping_everyone_only_with_the_bots_permission() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("owner").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let commands = echo_commands(&app, &bot, &app_id).await;
    add_bot(&app, &owner, &app_id, &guild).await; // SEND_MESSAGES only
    // @everyone: view, send and read history, but no MENTION_EVERYONE
    let (status, body) = app.patch(&format!("/guilds/{guild}/roles/{guild}"), &owner, json!({"permissions": "68608"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut bot_gateway = Client::connect(&address, &bot).await;
    let everyone = json!({"content": "@everyone look", "allowed_mentions": {"parse": ["everyone"]}});

    invoke(&app, &owner, &app_id, &channel, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "x"}])).await;
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    let token = interaction["token"].as_str().expect("token").to_owned();
    let callback = format!("/interactions/{}/{token}/callback", id(&interaction));
    let (status, _) = app.send(Method::POST, &callback, None, Some(json!({"type": 4, "data": everyone}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, original) = app.send(Method::GET, &format!("/webhooks/{app_id}/{token}/messages/@original"), None, None).await;
    assert_eq!(original["mention_everyone"].as_bool(), Some(false), "the bot lacks MENTION_EVERYONE: {original}");
    let (_, followup) = app.send(Method::POST, &format!("/webhooks/{app_id}/{token}"), None, Some(everyone.clone())).await;
    assert_eq!(followup["mention_everyone"].as_bool(), Some(false));
    let (_, edited) = app.send(Method::PATCH, &format!("/webhooks/{app_id}/{token}/messages/@original"), None, Some(everyone.clone())).await;
    assert_eq!(edited["mention_everyone"].as_bool(), Some(false));

    // a channel webhook keeps the explicit opt-in (its creator needed MANAGE_WEBHOOKS)
    let (_, hook) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Alerts"})).await;
    let execute = format!("/webhooks/{}/{}?wait=true", id(&hook), hook["token"].as_str().expect("token"));
    let (_, message) = app.send(Method::POST, &execute, None, Some(everyone)).await;
    assert_eq!(message["mention_everyone"].as_bool(), Some(true));
}

#[tokio::test]
async fn webhook_and_bot_embeds_follow_discords_limits() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (_, channel) = app.guild_with_channel(&owner).await;
    let (_, hook) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Alerts"})).await;
    let execute = format!("/webhooks/{}/{}?wait=true", id(&hook), hook["token"].as_str().expect("token"));
    let (status, error) = app.send(Method::POST, &execute, None, Some(json!({"embeds": [{"type": "rich", "title": "x".repeat(257)}]}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(50035)));
    let big = json!({"type": "rich", "description": "x".repeat(4000)});
    let (status, _) = app.send(Method::POST, &execute, None, Some(json!({"embeds": [big.clone(), big]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "6000 characters across the embeds");
    let (status, message) = app
        .send(
            Method::POST,
            &execute,
            None,
            Some(json!({"embeds": [{"type": "article", "title": "Build", "url": "javascript:alert(1)", "image": {"url": "data:,x"},
                                    "thumbnail": {"url": "https://example.com/t.png"}}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{message}");
    let embed = &message["embeds"][0];
    assert_eq!((embed["type"].as_str(), embed["title"].as_str()), (Some("rich"), Some("Build")));
    assert!(embed.get("url").is_none() && embed.get("image").is_none(), "{embed}");
    assert_eq!(embed["thumbnail"]["url"].as_str(), Some("https://example.com/t.png"));
}

#[tokio::test]
async fn command_overwrites_are_all_or_nothing() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let before = echo_commands(&app, &bot, &app_id).await;
    // the second command is invalid: nothing of the set is applied, the old set stays
    let (status, _) = app
        .put_json(&format!("/applications/{app_id}/commands"), &bot, json!([{"name": "fresh", "description": "New"}, {"name": "Bad Name", "description": "x"}]))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, after) = app.get(&format!("/applications/{app_id}/commands"), &bot).await;
    assert_eq!(after.as_array().map(Vec::len), Some(before.len()));
    // concurrent creates never pass the 100 slash command limit
    let fill: Vec<Value> = (0..98).map(|n| json!({"name": format!("c{n}"), "description": "d"})).collect();
    let (status, body) = app.put_json(&format!("/applications/{app_id}/commands"), &bot, Value::Array(fill)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let path = format!("/applications/{app_id}/commands");
    let creates = (0..6).map(|n| app.post(&path, &bot, json!({"name": format!("extra{n}"), "description": "d"})));
    let results = futures_util::future::join_all(creates).await;
    assert_eq!(results.iter().filter(|(status, _)| *status == StatusCode::CREATED).count(), 2, "two slots were left");
    let (_, all) = app.get(&path, &bot).await;
    assert_eq!(all.as_array().map(Vec::len), Some(100));
}

#[tokio::test]
async fn followups_are_rate_limited_per_interaction() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("owner").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    let commands = echo_commands(&app, &bot, &app_id).await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let mut bot_gateway = Client::connect(&address, &bot).await;
    invoke(&app, &owner, &app_id, &channel, command(&commands, "echo"), json!([{"name": "text", "type": 3, "value": "x"}])).await;
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    let token = interaction["token"].as_str().expect("token").to_owned();
    let callback = format!("/interactions/{}/{token}/callback", id(&interaction));
    assert_eq!(app.send(Method::POST, &callback, None, Some(json!({"type": 4, "data": {"content": "ok"}}))).await.0, StatusCode::NO_CONTENT);
    let base = format!("/webhooks/{app_id}/{token}");
    // A stopped clock: a burst that runs slowly (a busy machine) would otherwise refill the bucket as it goes.
    app.state.limiter.freeze_clock();
    let sends = (0..10).map(|n| app.send(Method::POST, &base, None, Some(json!({"content": format!("flood {n}")}))));
    let results = futures_util::future::join_all(sends).await;
    let limited = results.iter().filter(|(status, _)| *status == StatusCode::TOO_MANY_REQUESTS).count();
    assert_eq!(limited, 5, "a burst of five followups, the rest rate limited: {results:?}");
}

#[tokio::test]
async fn moving_a_webhook_respects_the_target_channels_limit() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    let (_, full) = app.post(&format!("/guilds/{guild}/channels"), &owner, json!({"name": "full", "type": 0})).await;
    let full = id(&full);
    for n in 0..15 {
        let (status, body) = app.post(&format!("/channels/{full}/webhooks"), &owner, json!({"name": format!("Hook {n}")})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (_, hook) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Mover"})).await;
    let (status, error) = app.patch(&format!("/webhooks/{}", id(&hook)), &owner, json!({"channel_id": full})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(30007)), "{error}");
}

#[tokio::test]
async fn a_bot_dm_follows_the_members_guild_privacy() {
    let app = TestApp::new().await;
    let (owner, _) = app.register("owner").await;
    let (member, member_user) = app.register("member").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &member).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let privacy = format!("/users/@me/guilds/{guild}/privacy");
    // The member turns off DMs from the only guild they share with the bot: it may not open a DM.
    assert_eq!(app.patch(&privacy, &member, json!({"direct_messages": false})).await.0, StatusCode::OK);
    let (status, error) = app.post("/users/@me/channels", &bot, json!({"recipient_id": id(&member_user)})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50007)));
    // Back on, the bot opens and writes; off again, its next message is refused.
    assert_eq!(app.patch(&privacy, &member, json!({"direct_messages": true})).await.0, StatusCode::OK);
    let (status, dm) = app.post("/users/@me/channels", &bot, json!({"recipient_id": id(&member_user)})).await;
    assert_eq!(status, StatusCode::OK, "{dm}");
    let messages = format!("/channels/{}/messages", id(&dm));
    assert_eq!(app.post(&messages, &bot, json!({"content": "hi"})).await.0, StatusCode::OK);
    assert_eq!(app.patch(&privacy, &member, json!({"direct_messages": false})).await.0, StatusCode::OK);
    let (status, error) = app.post(&messages, &bot, json!({"content": "again"})).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::FORBIDDEN, Some(50007)));
}

fn row(components: Value) -> Value {
    json!({"type": 1, "components": components})
}

fn button(custom_id: &str, label: &str) -> Value {
    json!({"type": 2, "style": 1, "custom_id": custom_id, "label": label})
}

fn select(custom_id: &str) -> Value {
    json!({"type": 3, "custom_id": custom_id, "placeholder": "Pick one", "options": [{"label": "A", "value": "a"}, {"label": "B", "value": "b", "description": "the second"}]})
}

async fn click(app: &TestApp, user: &str, app_id: &str, channel: &str, message: &str, data: Value) -> (StatusCode, Value) {
    app.post("/interactions", user, json!({"type": 3, "application_id": app_id, "channel_id": channel, "message_id": message, "nonce": "c1", "data": data}))
        .await
}

#[tokio::test]
async fn message_components_are_validated_relayed_and_updated() {
    let app = TestApp::new().await;
    let address = app.serve().await;
    let (owner, _) = app.register("owner").await;
    let (fan, _) = app.register("fan").await;
    let (late, _) = app.register("late").await;
    let (guild, channel) = app.guild_with_channel(&owner).await;
    join(&app, &owner, &channel, &fan).await;
    join(&app, &owner, &channel, &late).await;
    let (app_id, bot) = create_app(&app, &owner, "Echo").await;
    add_bot(&app, &owner, &app_id, &guild).await;
    let (status, commands) = app.put_json(&format!("/applications/{app_id}/commands"), &bot, json!([{"name": "confirm", "description": "Ask"}])).await;
    assert_eq!(status, StatusCode::OK, "{commands}");
    let confirm = &commands[0];
    let mut bot_gateway = Client::connect(&address, &bot).await;
    let mut user_gateway = Client::connect(&address, &owner).await;

    let (_, created) = invoke(&app, &owner, &app_id, &channel, confirm, json!([])).await;
    let interaction = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert_eq!(interaction["id"], created["id"]);
    let callback = format!("/interactions/{}/{}/callback", id(&interaction), interaction["token"].as_str().expect("token"));
    let respond = |components: Value| app.send(Method::POST, &callback, None, Some(json!({"type": 4, "data": {"content": "Sure?", "components": components}})));

    // limits are checked before the interaction is claimed, so a corrected body still works
    let long = "x".repeat(101);
    let docs = json!({"type": 2, "style": 5, "label": "Docs", "url": "https://example.com/docs"});
    let bad = [
        json!(vec![row(json!([button("a", "A")])); 6]),
        json!([row(json!([button("a", "A"), button("b", "B"), button("c", "C"), button("d", "D"), button("e", "E"), button("f", "F")]))]),
        json!([row(json!([button(&long, "A")]))]),
        json!([row(json!([button("a", &"y".repeat(81))]))]),
        json!([row(json!([{"type": 2, "style": 5, "label": "Docs", "url": "http://example.com"}]))]),
        json!([row(json!([{"type": 2, "style": 5, "label": "Docs", "url": "https://example.com", "custom_id": "a"}]))]),
        json!([row(json!([{"type": 2, "style": 1, "label": "A"}]))]),
        json!([row(json!([button("a", "A")])), row(json!([button("a", "B")]))]),
        json!([row(json!([select("s"), button("a", "A")]))]),
        json!([row(json!([{"type": 3, "custom_id": "s", "options": []}]))]),
        json!([row(json!([{"type": 3, "custom_id": "s", "options": [{"label": "A", "value": "a"}], "max_values": 2}]))]),
        json!([button("a", "A")]),
    ];
    for components in bad {
        let (status, error) = respond(components.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{components}: {error}");
    }
    let layout = json!([
        row(
            json!([button("yes", "Confirm"), {"type": 2, "style": 4, "custom_id": "no", "label": "Cancel"}, docs, {"type": 2, "style": 2, "custom_id": "off", "label": "Off", "disabled": true}])
        ),
        row(json!([select("pick")])),
    ]);
    let (status, error) = respond(layout).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{error}");
    let message = user_gateway.wait_for("MESSAGE_CREATE").await;
    let rows = message["components"].as_array().expect("components");
    assert_eq!((rows.len(), rows[0]["components"].as_array().map(Vec::len), rows[1]["components"][0]["options"][1]["value"].as_str()), (2, Some(4), Some("b")));
    let (_, history) = app.get(&format!("/channels/{channel}/messages"), &owner).await;
    assert_eq!(history[0]["components"][1]["components"][0]["custom_id"].as_str(), Some("pick"));
    let message_id = id(&message);

    // a click is checked against the stored message
    let wrong = [
        json!({"custom_id": "nope", "component_type": 2}),
        json!({"custom_id": "off", "component_type": 2}),
        json!({"custom_id": "pick", "component_type": 3, "values": ["zzz"]}),
        json!({"custom_id": "yes", "component_type": 2, "values": ["x"]}),
        json!({"custom_id": "yes", "component_type": 3, "values": ["a"]}),
    ];
    for data in wrong {
        let (status, error) = click(&app, &fan, &app_id, &channel, &message_id, data.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{data}: {error}");
    }
    // another member: an unknown message, and a message of somebody else's application
    let (status, _) = click(&app, &late, &app_id, &channel, "1", json!({"custom_id": "yes", "component_type": 2})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = click(&app, &late, &other_id(&app_id), &channel, &message_id, json!({"custom_id": "yes", "component_type": 2})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // a select pick, answered by a deferred update: nothing changes, @original is the clicked message
    let (status, picked) = click(&app, &owner, &app_id, &channel, &message_id, json!({"custom_id": "pick", "component_type": 3, "values": ["b"]})).await;
    assert_eq!((status, picked["nonce"].as_str()), (StatusCode::OK, Some("c1")));
    let relayed = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert_eq!((relayed["type"].as_u64(), relayed["data"]["custom_id"].as_str(), relayed["data"]["values"][0].as_str()), (Some(3), Some("pick"), Some("b")));
    assert_eq!(
        (relayed["data"]["component_type"].as_u64(), relayed["message"]["id"].as_str(), relayed["data"].get("name")),
        (Some(3), Some(message_id.as_str()), None)
    );
    let token = relayed["token"].as_str().expect("token").to_owned();
    let (status, _) = app.send(Method::POST, &format!("/interactions/{}/{token}/callback", id(&relayed)), None, Some(json!({"type": 6}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let success = user_gateway.wait_for("INTERACTION_SUCCESS").await;
    assert_eq!((success["id"].clone(), success["nonce"].as_str()), (picked["id"].clone(), Some("c1")));
    let (status, edited) =
        app.send(Method::PATCH, &format!("/webhooks/{app_id}/{token}/messages/@original"), None, Some(json!({"content": "You picked B"}))).await;
    assert_eq!((status, edited["id"].as_str(), edited["components"].as_array().map(Vec::len)), (StatusCode::OK, Some(message_id.as_str()), Some(2)));
    user_gateway.wait_for("MESSAGE_UPDATE").await;

    // a button, answered by an update of the message that removes the components
    let (status, _) = click(&app, &owner, &app_id, &channel, &message_id, json!({"custom_id": "yes", "component_type": 2})).await;
    assert_eq!(status, StatusCode::OK);
    let relayed = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert!(relayed["data"].get("values").is_none());
    let update = format!("/interactions/{}/{}/callback", id(&relayed), relayed["token"].as_str().expect("token"));
    let (status, _) = app.send(Method::POST, &update, None, Some(json!({"type": 7, "data": {"content": "Confirmed", "components": []}}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let updated = user_gateway.wait_for("MESSAGE_UPDATE").await;
    assert_eq!((updated["id"].as_str(), updated["content"].as_str(), updated.get("components")), (Some(message_id.as_str()), Some("Confirmed"), None));
    user_gateway.wait_for("INTERACTION_SUCCESS").await;
    // it was one answer: the second is refused
    let (status, error) = app.send(Method::POST, &update, None, Some(json!({"type": 7, "data": {"content": "Again"}}))).await;
    assert_eq!((status, error["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(40060)));
    let (status, _) = click(&app, &late, &app_id, &channel, &message_id, json!({"custom_id": "yes", "component_type": 2})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "the buttons are gone");

    // update and deferred update belong to clicks; a command answers with 4 or 5
    let (_, created) = invoke(&app, &late, &app_id, &channel, confirm, json!([])).await;
    let command = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert_eq!(command["id"], created["id"]);
    let command_callback = format!("/interactions/{}/{}/callback", id(&command), command["token"].as_str().expect("token"));
    for kind in [6, 7] {
        let (status, _) = app.send(Method::POST, &command_callback, None, Some(json!({"type": kind, "data": {"content": "x"}}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // the bot's own messages carry components too (members and plain webhooks cannot send them)
    let messages = format!("/channels/{channel}/messages");
    let (status, _) = app.post(&messages, &owner, json!({"content": "hi", "components": [row(json!([button("go", "Go")]))]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, hook) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Hook"})).await;
    let hook_path = format!("/webhooks/{}/{}", id(&hook), hook["token"].as_str().expect("token"));
    let (status, _) = app.send(Method::POST, &hook_path, None, Some(json!({"content": "hi", "components": [row(json!([button("go", "Go")]))]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, posted) = app.post(&messages, &bot, json!({"components": [row(json!([button("go", "Go")]))]})).await;
    assert_eq!((status, posted["components"][0]["components"][0]["custom_id"].as_str()), (StatusCode::OK, Some("go")), "{posted}");
    let posted_id = id(&posted);
    let (status, patched) =
        app.patch(&format!("{messages}/{posted_id}"), &bot, json!({"components": [row(json!([button("go", "Go"), button("stop", "Stop")]))]})).await;
    assert_eq!((status, patched["components"][0]["components"].as_array().map(Vec::len)), (StatusCode::OK, Some(2)), "{patched}");
    user_gateway.wait_for("MESSAGE_UPDATE").await;

    // an ephemeral answer to a click reaches only the clicker and is not a command response
    let (status, _) = click(&app, &owner, &app_id, &channel, &posted_id, json!({"custom_id": "stop", "component_type": 2})).await;
    assert_eq!(status, StatusCode::OK);
    let relayed = bot_gateway.wait_for("INTERACTION_CREATE").await;
    assert_eq!(relayed["message"]["author"]["id"].as_str(), Some(app_id.as_str()));
    let reply = format!("/interactions/{}/{}/callback", id(&relayed), relayed["token"].as_str().expect("token"));
    let (status, _) = app.send(Method::POST, &reply, None, Some(json!({"type": 4, "data": {"content": "Stopped", "flags": 64}}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let private = user_gateway.wait_for("MESSAGE_CREATE").await;
    assert_eq!(
        (private["content"].as_str(), private["type"].as_u64(), private["flags"].as_u64(), private.get("interaction_metadata")),
        (Some("Stopped"), Some(0), Some(64), None)
    );
}

/// An application id that is not the message's.
fn other_id(app_id: &str) -> String {
    (app_id.parse::<i64>().expect("id") + 1).to_string()
}
