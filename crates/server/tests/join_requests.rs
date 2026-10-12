#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::TestApp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

/// KICK_MEMBERS and MANAGE_GUILD (Discord bits).
const KICK_MEMBERS: u64 = 1 << 1;
const MANAGE_GUILD: u64 = 1 << 5;

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn identify(address: &str, token: &str) -> Self {
        let (ws, _) = connect_async(format!("ws://{address}/gateway")).await.expect("websocket connects");
        let mut client = Self { ws };
        client.next().await;
        client.ws.send(Message::Text(json!({"op": 2, "d": {"token": token}}).to_string().into())).await.expect("identify");
        client.wait_for("READY").await;
        client
    }

    async fn next(&mut self) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => return serde_json::from_str(&text).expect("json frame"),
                Ok(Some(Ok(_))) => continue,
                other => panic!("gateway ended or timed out: {other:?}"),
            }
        }
    }

    async fn wait_for(&mut self, name: &str) -> Value {
        loop {
            let frame = self.next().await;
            if frame["op"] == 0 && frame["t"] == name {
                return frame["d"].clone();
            }
        }
    }

    async fn silent_for(&mut self, name: &str, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(text) = message {
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
    owner: String,
    guild: String,
    general: String,
}

async fn world() -> World {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (guild, general) = app.guild_with_channel(&owner).await;
    World { app, owner, guild, general }
}

fn code(body: &Value) -> String {
    body["code"].as_str().expect("code").to_owned()
}

fn error_code(body: &Value) -> u64 {
    body["code"].as_u64().unwrap_or(0)
}

impl World {
    fn path(&self, tail: &str) -> String {
        format!("/guilds/{}{tail}", self.guild)
    }

    async fn invite(&self, body: Value) -> String {
        let (status, invite) = self.app.post(&format!("/channels/{}/invites", self.general), &self.owner, body).await;
        assert_eq!(status, StatusCode::OK, "invite: {invite}");
        code(&invite)
    }

    /// A member who joined while the guild was still invite only; returns (token, user id).
    async fn member(&self, name: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let invite = self.invite(json!({"unique": true})).await;
        assert_eq!(self.app.post(&format!("/invites/{invite}"), &token, json!({})).await.0, StatusCode::OK);
        (token, user["id"].as_str().expect("id").to_owned())
    }

    async fn set_mode(&self, mode: u8) {
        let (status, guild) = self.app.patch(&self.path(""), &self.owner, json!({"join_mode": mode})).await;
        assert_eq!(status, StatusCode::OK, "join mode: {guild}");
        assert_eq!(guild["join_mode"], mode);
    }

    async fn role(&self, user: &str, permissions: u64) {
        let (status, role) = self.app.post(&self.path("/roles"), &self.owner, json!({"name": "mods", "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "role: {role}");
        let (status, _) = self.app.patch(&self.path(&format!("/members/{user}")), &self.owner, json!({"roles": [role["id"]]})).await;
        assert_eq!(status, StatusCode::OK);
    }

    async fn put_form(&self) -> Value {
        let (status, form) = self.app.put_json(&self.path("/member-verification"), &self.owner, self.form()).await;
        assert_eq!(status, StatusCode::OK, "form: {form}");
        form
    }

    fn form(&self) -> Value {
        json!({"description": "  Tell us about you  ", "form_fields": [
            {"field_type": "TERMS", "label": "Rules", "required": true, "values": ["Be kind", "No spam"]},
            {"field_type": "TEXT_INPUT", "label": "Why join?", "required": true, "placeholder": "a sentence", "response": "ignored"},
            {"field_type": "MULTIPLE_CHOICE", "label": "Pick", "required": false, "values": ["a", "b", "c"]}
        ]})
    }

    fn answers(&self) -> Value {
        json!([
            {"field_type": "TERMS", "label": "Rules", "required": true, "values": ["Be kind", "No spam"], "response": true},
            {"field_type": "TEXT_INPUT", "label": "Why join?", "required": true, "response": "  I like it  "},
            {"field_type": "MULTIPLE_CHOICE", "label": "Pick", "required": false, "response": 2}
        ])
    }

    async fn apply(&self, token: &str, invite: &str, fields: Value) -> (StatusCode, Value) {
        self.app.put_json(&self.path("/requests/@me"), token, json!({"invite_code": invite, "form_fields": fields})).await
    }

    async fn requests(&self, token: &str, query: &str) -> (StatusCode, Value) {
        self.app.get(&self.path(&format!("/requests{query}")), token).await
    }

    async fn audit_keys(&self) -> Vec<String> {
        let (_, log) = self.app.get(&self.path("/audit-logs"), &self.owner).await;
        log["audit_log_entries"]
            .as_array()
            .expect("entries")
            .iter()
            .flat_map(|entry| entry["changes"].as_array().cloned().unwrap_or_default())
            .map(|change| change["key"].as_str().expect("key").to_owned())
            .collect()
    }
}

#[tokio::test]
async fn switching_to_apply_gates_every_invite_but_keeps_members_and_bots() {
    let w = world().await;
    let (alice, _) = w.member("alice").await;
    let (bob, _) = w.app.register("bob").await;
    let normal = w.invite(json!({"unique": true})).await;
    let temporary = w.invite(json!({"unique": true, "temporary": true})).await;
    assert_eq!(w.app.get(&format!("/invites/{normal}"), &bob).await.1["guild"]["join_mode"], 0);

    assert_eq!(w.app.patch(&w.path(""), &w.owner, json!({"join_mode": 2})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&w.path(""), &alice, json!({"join_mode": 1})).await.0, StatusCode::FORBIDDEN);
    w.set_mode(1).await;
    assert!(w.audit_keys().await.contains(&"join_mode".to_owned()));
    assert_eq!(w.app.get(&format!("/invites/{normal}"), &bob).await.1["guild"]["join_mode"], 1);

    for invite in [&normal, &temporary] {
        let (status, body) = w.app.post(&format!("/invites/{invite}"), &bob, json!({})).await;
        assert_eq!((status, error_code(&body)), (StatusCode::FORBIDDEN, 150009), "{body}");
    }
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert_eq!(members.as_array().expect("members").len(), 2, "bob is not a member");
    // Members who accept an invite again are untouched (an invite use is not consumed either way).
    assert_eq!(w.app.post(&format!("/invites/{normal}"), &alice, json!({})).await.0, StatusCode::OK);

    // A server manager adds a bot through OAuth2.
    let (status, created) = w.app.post("/applications", &w.owner, json!({"name": "helper"})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let app_id = created["id"].as_str().expect("id");
    let (status, added) = w.app.post(&format!("/oauth2/authorize?client_id={app_id}"), &w.owner, json!({"guild_id": w.guild, "permissions": "2048"})).await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert_eq!(members.as_array().expect("members").len(), 3);

    // Back to invite only: the invite works again.
    w.set_mode(0).await;
    assert_eq!(w.app.post(&format!("/invites/{normal}"), &bob, json!({})).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_form_is_readable_with_an_invite_and_writable_by_managers() {
    let w = world().await;
    let (alice, alice_id) = w.member("alice").await;
    let (bob, _) = w.app.register("bob").await;
    let invite = w.invite(json!({})).await;
    let form_path = w.path("/member-verification");

    assert_eq!(w.app.get(&form_path, &alice).await.1, json!({"description": null, "form_fields": []}));
    let (status, body) = w.app.get(&form_path, &bob).await;
    assert_eq!((status, error_code(&body)), (StatusCode::NOT_FOUND, 10004));
    assert_eq!(w.app.get(&format!("{form_path}?invite_code=nope"), &bob).await.0, StatusCode::NOT_FOUND);
    // An invite of another guild does not open this one, and this one does not open the other.
    let (other, other_channel) = w.app.guild_with_channel(&bob).await;
    let (_, foreign) = w.app.post(&format!("/channels/{other_channel}/invites"), &bob, json!({})).await;
    let (carol, _) = w.app.register("carol").await;
    assert_eq!(w.app.get(&format!("{form_path}?invite_code={}", code(&foreign)), &carol).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.get(&format!("/guilds/{other}/member-verification?invite_code={invite}"), &carol).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.get(&format!("/guilds/{other}/member-verification?invite_code={}", code(&foreign)), &carol).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&format!("{form_path}?invite_code={invite}"), &bob).await.0, StatusCode::OK);

    assert_eq!(w.app.put_json(&form_path, &alice, w.form()).await.0, StatusCode::FORBIDDEN);
    w.role(&alice_id, MANAGE_GUILD).await;
    let stored = w.put_form().await;
    assert_eq!(stored["description"], "Tell us about you");
    assert_eq!(stored["form_fields"][1]["response"], Value::Null, "responses are not stored");
    assert_eq!(stored["form_fields"][2]["values"], json!(["a", "b", "c"]));
    assert_eq!(w.app.get(&format!("{form_path}?invite_code={invite}"), &bob).await.1, stored);
    assert!(w.audit_keys().await.contains(&"member_verification".to_owned()));

    let long = "x".repeat(301);
    let rules: Vec<String> = (0..17).map(|i| format!("rule {i}")).collect();
    let choices: Vec<String> = (0..9).map(|i| format!("c{i}")).collect();
    let terms = json!({"field_type": "TERMS", "label": "T", "required": true, "values": ["r"]});
    let text = json!({"field_type": "TEXT_INPUT", "label": "Q", "required": false});
    let invalid = [
        json!({"description": long, "form_fields": []}),
        json!({"form_fields": [terms, terms]}),
        json!({"form_fields": [text, text, text, text, text, text]}),
        json!({"form_fields": [{"field_type": "TEXT_INPUT", "label": " ", "required": false}]}),
        json!({"form_fields": [{"field_type": "TEXT_INPUT", "label": long, "required": false}]}),
        json!({"form_fields": [{"field_type": "TEXT_INPUT", "label": "Q", "required": false, "values": ["a"]}]}),
        json!({"form_fields": [{"field_type": "TEXT_INPUT", "label": "Q", "required": false, "placeholder": "p".repeat(101)}]}),
        json!({"form_fields": [{"field_type": "TERMS", "label": "T", "required": true}]}),
        json!({"form_fields": [{"field_type": "TERMS", "label": "T", "required": true, "values": rules}]}),
        json!({"form_fields": [{"field_type": "MULTIPLE_CHOICE", "label": "M", "required": true, "values": choices}]}),
        json!({"form_fields": [{"field_type": "MULTIPLE_CHOICE", "label": "M", "required": true, "values": [""]}]}),
        json!({"form_fields": [{"field_type": "NOPE", "label": "M", "required": true}]}),
        json!({"form_fields": [{"field_type": "TEXT_INPUT", "label": "a\u{0}b", "required": false}]}),
    ];
    for body in invalid {
        let (status, error) = w.app.put_json(&form_path, &w.owner, body.clone()).await;
        assert_eq!((status, error_code(&error)), (StatusCode::BAD_REQUEST, 50035), "{body}: {error}");
    }
    // Six fields (one TERMS and five others) are the limit.
    let six = json!({"form_fields": [terms, text, text, text, text, text]});
    assert_eq!(w.app.put_json(&form_path, &w.owner, six).await.0, StatusCode::OK);
    // A rejected edit changed nothing.
    assert_eq!(w.app.get(&form_path, &w.owner).await.1["form_fields"].as_array().expect("fields").len(), 6);
}

#[tokio::test]
async fn submitting_checks_the_answers_the_applicant_and_the_guild() {
    let w = world().await;
    w.put_form().await;
    let (alice, _) = w.member("alice").await;
    let (bob, bob_id) = w.app.register("bob").await.pipe_id();
    let invite = w.invite(json!({})).await;

    // Mode off: no applications.
    let (status, body) = w.apply(&bob, &invite, w.answers()).await;
    assert_eq!((status, error_code(&body)), (StatusCode::BAD_REQUEST, 50035), "{body}");
    assert!(body["errors"]["join_mode"].is_object());
    w.set_mode(1).await;

    assert_eq!(w.apply(&bob, "nope", w.answers()).await.0, StatusCode::NOT_FOUND);
    let (_, other_channel) = w.app.guild_with_channel(&bob).await;
    let (_, foreign) = w.app.post(&format!("/channels/{other_channel}/invites"), &bob, json!({})).await;
    let (status, body) = w.apply(&bob, &code(&foreign), w.answers()).await;
    assert_eq!((status, error_code(&body)), (StatusCode::NOT_FOUND, 10006));
    let (status, body) = w.apply(&alice, &invite, w.answers()).await;
    assert_eq!((status, body["errors"]["guild_id"].is_object()), (StatusCode::BAD_REQUEST, true), "a member cannot apply: {body}");

    let answers = w.answers();
    let mut wrong_count = answers.clone();
    wrong_count.as_array_mut().expect("array").pop();
    let mut wrong_order = answers.clone();
    wrong_order.as_array_mut().expect("array").swap(0, 1);
    let mut missing_terms = answers.clone();
    missing_terms[0]["response"] = json!(false);
    let mut blank_text = answers.clone();
    blank_text[1]["response"] = json!("   ");
    let mut text_as_number = answers.clone();
    text_as_number[1]["response"] = json!(3);
    let mut long_text = answers.clone();
    long_text[1]["response"] = json!("x".repeat(151));
    let mut nul_text = answers.clone();
    nul_text[1]["response"] = json!("a\u{0}b");
    let mut bad_choice = answers.clone();
    bad_choice[2]["response"] = json!(3);
    let mut choice_as_text = answers.clone();
    choice_as_text[2]["response"] = json!("a");
    for fields in [wrong_count, wrong_order, missing_terms, blank_text, text_as_number, long_text, nul_text, bad_choice, choice_as_text, json!([])] {
        let (status, error) = w.apply(&bob, &invite, fields.clone()).await;
        assert_eq!((status, error_code(&error)), (StatusCode::BAD_REQUEST, 50035), "{fields}: {error}");
    }
    // The optional field may stay empty.
    let mut skipped = answers.clone();
    skipped[2]["response"] = Value::Null;
    let (status, request) = w.apply(&bob, &invite, skipped).await;
    assert_eq!(status, StatusCode::OK, "{request}");
    assert_eq!((request["application_status"].clone(), request["user"]["id"].clone()), (json!("SUBMITTED"), json!(bob_id)));
    assert_eq!(request["form_responses"][1]["response"], "I like it");
    assert_eq!(request["form_responses"][1]["label"], "Why join?", "the stored form's fields carry the answers");

    // Banned users cannot apply.
    let (carol, carol_id) = w.app.register("carol").await.pipe_id();
    assert_eq!(w.app.put_json(&w.path(&format!("/bans/{carol_id}")), &w.owner, json!({})).await.0, StatusCode::NO_CONTENT);
    let (status, body) = w.apply(&carol, &invite, w.answers()).await;
    assert_eq!((status, error_code(&body)), (StatusCode::FORBIDDEN, 40007));
}

trait PipeId {
    fn pipe_id(self) -> (String, String);
}

impl PipeId for (String, Value) {
    fn pipe_id(self) -> (String, String) {
        (self.0, self.1["id"].as_str().expect("id").to_owned())
    }
}

#[tokio::test]
async fn an_applicant_sees_nothing_until_approved_and_then_joins_like_an_invite() {
    let w = world().await;
    let address = w.app.serve().await;
    w.put_form().await;
    let (alice, alice_id) = w.member("alice").await;
    let (bob, bob_id) = w.app.register("bob").await.pipe_id();
    let plain_invite = w.invite(json!({"unique": true})).await;
    w.set_mode(1).await;
    let mut owner_ws = Client::identify(&address, &w.owner).await;
    let mut alice_ws = Client::identify(&address, &alice).await;
    let mut bob_ws = Client::identify(&address, &bob).await;

    let (status, request) = w.apply(&bob, &plain_invite, w.answers()).await;
    assert_eq!(status, StatusCode::OK, "{request}");
    let request_id = request["id"].as_str().expect("id").to_owned();
    let created = owner_ws.wait_for("GUILD_JOIN_REQUEST_CREATE").await;
    assert_eq!(
        (created["guild_id"].clone(), created["status"].clone(), created["request"]["id"].clone()),
        (json!(w.guild), json!("SUBMITTED"), json!(request_id))
    );
    bob_ws.wait_for("GUILD_JOIN_REQUEST_CREATE").await;
    assert!(alice_ws.silent_for("GUILD_JOIN_REQUEST_CREATE", Duration::from_millis(300)).await, "a plain member hears nothing");
    assert_eq!(w.app.get(&w.path("/requests/@me"), &bob).await.1["id"], json!(request_id));

    // Not a member: nothing of the guild opens up.
    for path in [w.path(""), w.path("/channels"), w.path("/members"), format!("/channels/{}/messages", w.general)] {
        let (status, body) = w.app.get(&path, &bob).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
    }
    let (status, _) = w.app.post(&format!("/channels/{}/messages", w.general), &bob, json!({"content": "hi"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, mine) = w.app.get("/users/@me/guilds", &bob).await;
    assert_eq!(mine, json!([]));

    // Only KICK_MEMBERS or MANAGE_GUILD list and handle requests.
    assert_eq!(w.requests(&alice, "").await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.patch(&w.path(&format!("/requests/{request_id}")), &alice, json!({"action": "APPROVED"})).await.0, StatusCode::FORBIDDEN);
    w.role(&alice_id, KICK_MEMBERS).await;
    let (status, list) = w.requests(&alice, "").await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!((list["total"].clone(), list["guild_join_requests"][0]["id"].clone()), (json!(1), json!(request_id)));
    assert_eq!(w.requests(&alice, "?limit=0").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.requests(&alice, "?status=NOPE").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.requests(&alice, "?status=APPROVED").await.1["total"], 0);

    let bad = w.app.patch(&w.path(&format!("/requests/{request_id}")), &w.owner, json!({"action": "SUBMITTED"})).await;
    assert_eq!(bad.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.patch(&w.path("/requests/999"), &w.owner, json!({"action": "APPROVED"})).await.0, StatusCode::NOT_FOUND);
    let (status, approved) = w.app.patch(&w.path(&format!("/requests/{request_id}")), &alice, json!({"action": "APPROVED"})).await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!((approved["application_status"].clone(), approved["actioned_by_user"]["id"].clone()), (json!("APPROVED"), json!(alice_id)));
    let update = bob_ws.wait_for("GUILD_JOIN_REQUEST_UPDATE").await;
    assert_eq!(update["status"], "APPROVED");
    assert_eq!(update["request"]["actioned_by_user"], Value::Null, "the applicant is not told who handled it");
    let (_, mine) = w.app.get(&w.path("/requests/@me"), &bob).await;
    assert_eq!((mine["application_status"].clone(), mine["actioned_by_user"].clone()), (json!("APPROVED"), Value::Null));
    assert_eq!(owner_ws.wait_for("GUILD_JOIN_REQUEST_UPDATE").await["request"]["actioned_by_user"]["id"], json!(alice_id));
    let created = bob_ws.wait_for("GUILD_CREATE").await;
    assert_eq!(created["id"], json!(w.guild));
    assert_eq!(owner_ws.wait_for("GUILD_MEMBER_ADD").await["user"]["id"], json!(bob_id));

    // A second action finds the request settled.
    let (status, again) = w.app.patch(&w.path(&format!("/requests/{request_id}")), &w.owner, json!({"action": "APPROVED"})).await;
    assert_eq!((status, error_code(&again)), (StatusCode::BAD_REQUEST, 50035));
    let (_, members) = w.app.get(&w.path("/members"), &w.owner).await;
    assert_eq!(members.as_array().expect("members").len(), 3, "added once");
    for path in [w.path(""), w.path("/channels"), w.path("/members"), format!("/channels/{}/messages", w.general)] {
        assert_eq!(w.app.get(&path, &bob).await.0, StatusCode::OK, "{path}");
    }
    assert_eq!(w.requests(&w.owner, "?status=APPROVED").await.1["total"], 1);
    // The member now applying again is refused; the join source names the invite the request came with.
    assert_eq!(w.apply(&bob, &plain_invite, w.answers()).await.0, StatusCode::BAD_REQUEST);
    let (source, inviter): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT source_invite_code, inviter_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(w.guild.parse::<i64>().expect("id"))
            .bind(bob_id.parse::<i64>().expect("id"))
            .fetch_one(&w.app.state.db)
            .await
            .expect("member row");
    assert_eq!((source, inviter.is_some()), (Some(plain_invite), true));
}

#[tokio::test]
async fn rejected_applicants_can_reapply_and_withdraw() {
    let w = world().await;
    w.put_form().await;
    let (bob, _) = w.app.register("bob").await.pipe_id();
    let invite = w.invite(json!({})).await;
    w.set_mode(1).await;
    let (_, first) = w.apply(&bob, &invite, w.answers()).await;
    let first_id = first["id"].as_str().expect("id").to_owned();

    // A SUBMITTED request is replaced by a new one.
    let (_, second) = w.apply(&bob, &invite, w.answers()).await;
    assert_ne!(second["id"], json!(first_id));
    assert_eq!(w.requests(&w.owner, "").await.1["total"], 1);
    let second_id = second["id"].as_str().expect("id").to_owned();

    let too_long = "x".repeat(161);
    assert_eq!(
        w.app.patch(&w.path(&format!("/requests/{second_id}")), &w.owner, json!({"action": "REJECTED", "rejection_reason": too_long})).await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, rejected) =
        w.app.patch(&w.path(&format!("/requests/{second_id}")), &w.owner, json!({"action": "REJECTED", "rejection_reason": " not now "})).await;
    assert_eq!(status, StatusCode::OK, "{rejected}");
    assert_eq!((rejected["application_status"].clone(), rejected["rejection_reason"].clone()), (json!("REJECTED"), json!("not now")));
    assert_eq!(w.app.get(&w.path("/requests/@me"), &bob).await.1["rejection_reason"], "not now");
    assert_eq!(w.app.get(&w.path(""), &bob).await.0, StatusCode::FORBIDDEN);
    // A rejected request cannot be withdrawn; handled ones cannot be handled again.
    assert_eq!(w.app.delete(&w.path("/requests/@me"), &bob).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.patch(&w.path(&format!("/requests/{second_id}")), &w.owner, json!({"action": "APPROVED"})).await.0, StatusCode::BAD_REQUEST);

    let (status, third) = w.apply(&bob, &invite, w.answers()).await;
    assert_eq!(status, StatusCode::OK, "{third}");
    assert_eq!((third["application_status"].clone(), third["rejection_reason"].clone()), (json!("SUBMITTED"), Value::Null));
    assert_eq!(w.requests(&w.owner, "?status=REJECTED").await.1["total"], 0);

    let address = w.app.serve().await;
    let mut owner_ws = Client::identify(&address, &w.owner).await;
    assert_eq!(w.app.delete(&w.path("/requests/@me"), &bob).await.0, StatusCode::NO_CONTENT);
    let deleted = owner_ws.wait_for("GUILD_JOIN_REQUEST_DELETE").await;
    assert_eq!((deleted["id"].clone(), deleted["guild_id"].clone()), (third["id"].clone(), json!(w.guild)));
    assert_eq!(w.app.get(&w.path("/requests/@me"), &bob).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.app.delete(&w.path("/requests/@me"), &bob).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.requests(&w.owner, "").await.1["total"], 0);
}

#[tokio::test]
async fn bans_remove_requests_and_block_approval() {
    let w = world().await;
    let address = w.app.serve().await;
    let (bob, bob_id) = w.app.register("bob").await.pipe_id();
    let (carol, carol_id) = w.app.register("carol").await.pipe_id();
    let invite = w.invite(json!({})).await;
    w.set_mode(1).await;
    let (_, bob_request) = w.apply(&bob, &invite, json!([])).await;
    let (_, carol_request) = w.apply(&carol, &invite, json!([])).await;
    let mut owner_ws = Client::identify(&address, &w.owner).await;

    // Banning deletes the request and tells the handlers.
    assert_eq!(w.app.put_json(&w.path(&format!("/bans/{bob_id}")), &w.owner, json!({})).await.0, StatusCode::NO_CONTENT);
    let deleted = owner_ws.wait_for("GUILD_JOIN_REQUEST_DELETE").await;
    assert_eq!((deleted["id"].clone(), deleted["user_id"].clone()), (bob_request["id"].clone(), json!(bob_id)));
    assert_eq!(w.app.get(&w.path("/requests/@me"), &bob).await.0, StatusCode::NOT_FOUND);
    let bob_path = w.path(&format!("/requests/{}", bob_request["id"].as_str().expect("id")));
    assert_eq!(w.app.patch(&bob_path, &w.owner, json!({"action": "APPROVED"})).await.0, StatusCode::NOT_FOUND);

    // A ban that lands behind the request's back (here: written directly) still stops the approval, and the request stays.
    sqlx::query("INSERT INTO guild_bans (guild_id, user_id) VALUES ($1, $2)")
        .bind(w.guild.parse::<i64>().expect("id"))
        .bind(carol_id.parse::<i64>().expect("id"))
        .execute(&w.app.state.db)
        .await
        .expect("ban");
    let carol_path = w.path(&format!("/requests/{}", carol_request["id"].as_str().expect("id")));
    let (status, body) = w.app.patch(&carol_path, &w.owner, json!({"action": "APPROVED"})).await;
    assert_eq!((status, error_code(&body)), (StatusCode::FORBIDDEN, 40007));
    assert_eq!(w.app.get(&w.path("/requests/@me"), &carol).await.1["application_status"], "SUBMITTED");
    assert_eq!(w.app.get(&w.path(""), &carol).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn deleting_the_guild_deletes_its_form_and_requests() {
    let w = world().await;
    w.put_form().await;
    let (bob, _) = w.app.register("bob").await.pipe_id();
    let invite = w.invite(json!({})).await;
    w.set_mode(1).await;
    assert_eq!(w.apply(&bob, &invite, w.answers()).await.0, StatusCode::OK);
    assert_eq!(w.app.delete(&format!("/guilds/{}", w.guild), &w.owner).await.0, StatusCode::NO_CONTENT);
    for table in ["guild_join_requests", "guild_member_verification"] {
        let (left,): (i64,) = sqlx::query_as(&format!("SELECT count(*) FROM {table} WHERE guild_id = $1"))
            .bind(w.guild.parse::<i64>().expect("id"))
            .fetch_one(&w.app.state.db)
            .await
            .expect("count");
        assert_eq!(left, 0, "{table}");
    }
}
