#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Onboarding: configuration permissions, role/channel validation, joining flags, answers that grant and revoke roles.
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};
use vokko_protocol::api::permissions::{MANAGE_GUILD, MANAGE_ROLES};

struct World {
    app: TestApp,
    guild: String,
    general: String,
    owner: String,
}

impl World {
    async fn new() -> Self {
        let app = TestApp::new().await;
        let (owner, _) = app.register("owner").await;
        let (guild, general) = app.guild_with_channel(&owner).await;
        Self { app, guild, general, owner }
    }

    fn path(&self, tail: &str) -> String {
        format!("/guilds/{}{tail}", self.guild)
    }

    async fn member(&self, name: &str) -> (String, String) {
        let (token, user) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.general), &self.owner, json!({})).await;
        let (status, body) = self.app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &token, json!({})).await;
        assert_eq!(status, StatusCode::OK, "join: {body}");
        (token, user["id"].as_str().expect("id").to_owned())
    }

    async fn role(&self, name: &str, permissions: u64) -> String {
        let (status, role) = self.app.post(&self.path("/roles"), &self.owner, json!({"name": name, "permissions": permissions.to_string()})).await;
        assert_eq!(status, StatusCode::OK, "role: {role}");
        role["id"].as_str().expect("id").to_owned()
    }

    async fn channel(&self, name: &str, kind: u8) -> String {
        let (status, channel) = self.app.post(&self.path("/channels"), &self.owner, json!({"name": name, "type": kind})).await;
        assert_eq!(status, StatusCode::OK, "channel: {channel}");
        channel["id"].as_str().expect("id").to_owned()
    }

    async fn member_json(&self, user: &str) -> Value {
        let (_, members) = self.app.get(&self.path("/members"), &self.owner).await;
        members.as_array().expect("members").iter().find(|m| m["user"]["id"] == user).expect("member").clone()
    }
}

fn roles_of(member: &Value) -> Vec<String> {
    let mut roles: Vec<String> = member["roles"].as_array().expect("roles").iter().map(|r| r.as_str().expect("role").to_owned()).collect();
    roles.sort();
    roles
}

fn option_id(config: &Value, prompt: usize, option: usize) -> String {
    config["prompts"][prompt]["options"][option]["id"].as_str().expect("option id").to_owned()
}

#[tokio::test]
async fn only_editors_with_both_permissions_configure_and_roles_must_be_below_them() {
    let w = World::new().await;
    let (alice, alice_id) = w.member("alice").await;
    let low = w.role("low", 0).await;
    let high = w.role("high", 0).await;
    let editor = w.role("editor", MANAGE_GUILD | MANAGE_ROLES).await;
    let guild_only = w.role("guild-only", MANAGE_GUILD).await;
    // editor outranks low but not high
    for (role, position) in [(&high, 5), (&editor, 3), (&low, 1)] {
        let (status, body) = w.app.patch(&w.path("/roles"), &w.owner, json!([{"id": role, "position": position}])).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let prompt = |role: &str| json!({"prompts": [{"type": 0, "title": "Pick", "options": [{"title": "A", "role_ids": [role]}]}], "enabled": true});

    // a plain member and a MANAGE_GUILD-only member are refused
    assert_eq!(w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(&alice), Some(prompt(&low))).await.0, StatusCode::FORBIDDEN);
    let patch = w.app.patch(&w.path(&format!("/members/{alice_id}")), &w.owner, json!({"roles": [guild_only]})).await;
    assert_eq!(patch.0, StatusCode::OK);
    assert_eq!(w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(&alice), Some(prompt(&low))).await.0, StatusCode::FORBIDDEN);

    // with both permissions alice can hand out roles below her top role, not above it, not @everyone
    assert_eq!(w.app.patch(&w.path(&format!("/members/{alice_id}")), &w.owner, json!({"roles": [editor]})).await.0, StatusCode::OK);
    let put = |body: Value| {
        let (w, alice) = (&w, &alice);
        async move { w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(alice), Some(body)).await }
    };
    let (status, config) = put(prompt(&low)).await;
    assert_eq!(status, StatusCode::OK, "{config}");
    assert_eq!(config["prompts"][0]["options"][0]["role_ids"], json!([low]));
    assert_eq!(put(prompt(&high)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(put(prompt(&w.guild)).await.0, StatusCode::BAD_REQUEST);
    // an option that already grants a role keeps it when the editor resubmits (id kept), even if it outranks them
    let owner_put = w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(&w.owner), Some(prompt(&high))).await;
    assert_eq!(owner_put.0, StatusCode::OK, "{}", owner_put.1);
    let resubmit = json!({"prompts": [{"id": owner_put.1["prompts"][0]["id"], "type": 0, "title": "Renamed", "options": [{"id": option_id(&owner_put.1, 0, 0), "title": "A", "role_ids": [high]}]}]});
    let (status, kept) = put(resubmit).await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["prompts"][0]["options"][0]["id"], option_id(&owner_put.1, 0, 0));
    assert_eq!(kept["prompts"][0]["title"], "Renamed");

    // channels must be channels of the guild; limits hold
    for (what, body) in [
        ("unknown channel", json!({"default_channel_ids": ["12345"]})),
        ("channel in option", json!({"prompts": [{"type": 0, "title": "x", "options": [{"title": "A", "channel_ids": ["12345"]}]}]})),
        ("no options", json!({"prompts": [{"type": 0, "title": "x", "options": []}]})),
        ("blank title", json!({"prompts": [{"type": 0, "title": " ", "options": [{"title": "A"}]}]})),
        (
            "too many prompts",
            json!({"prompts": (0..16).map(|i| json!({"type": 0, "title": format!("p{i}"), "options": [{"title": "A"}]})).collect::<Vec<_>>()}),
        ),
        ("empty rules", json!({"rules": {"description": null, "items": []}})),
        ("long rule", json!({"rules": {"description": null, "items": ["x".repeat(301)]}})),
    ] {
        let (status, error) = put(body).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{what}: {error}");
    }
    // outsiders cannot even read it
    let (outsider, _) = w.app.register("bob").await;
    assert_eq!(w.app.get(&w.path("/onboarding"), &outsider).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn joining_flags_answers_grant_and_revoke_roles() {
    let w = World::new().await;
    let gaming = w.channel("gaming", 0).await;
    let art = w.channel("art", 0).await;
    let secret = w.channel("secret", 0).await;
    let (status, _) = w.app.put_json(&format!("/channels/{secret}/permissions/{}", w.guild), &w.owner, json!({"type": 0, "allow": "0", "deny": "1024"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let gamer = w.role("gamer", 0).await;
    let painter = w.role("painter", 0).await;
    let extra = w.role("extra", 0).await;

    // a member who joined before onboarding existed is never prompted
    let (early, early_id) = w.member("early").await;
    let (status, config) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({
                "enabled": true, "mode": 1, "default_channel_ids": [w.general],
                "rules": {"description": "Be nice", "items": ["No spam", "Be kind"]},
                "prompts": [
                    {"type": 0, "title": "What do you play?", "required": true, "single_select": true, "options": [
                        {"title": "Games", "emoji": {"id": null, "name": "🎮"}, "role_ids": [gamer], "channel_ids": [gaming, secret]},
                        {"title": "Art", "description": "Drawing", "role_ids": [painter], "channel_ids": [art]}]},
                    {"type": 1, "title": "Extras", "options": [{"title": "Both", "role_ids": [gamer, painter]}]}
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{config}");
    assert_eq!((config["enabled"].clone(), config["mode"].clone()), (json!(true), json!(1)));
    assert_eq!(config["rules"]["items"], json!(["No spam", "Be kind"]));
    assert_eq!(config["prompts"][0]["options"][0]["emoji"], json!({"id": null, "name": "🎮"}));
    let (_, read) = w.app.get(&w.path("/onboarding"), &early).await;
    // members read the configuration minus the channels they cannot view (the private one in the first answer)
    let mut visible = config.clone();
    visible["prompts"][0]["options"][0]["channel_ids"] = json!([gaming]);
    assert_eq!(read, visible);
    assert_eq!(w.member_json(&early_id).await["flags"], Value::Null, "joined before onboarding: no flags");

    let (newcomer, newcomer_id) = w.member("newcomer").await;
    assert_eq!(w.member_json(&newcomer_id).await["flags"], 8, "STARTED_ONBOARDING");
    let (games, art_option, both) = (option_id(&config, 0, 0), option_id(&config, 0, 1), option_id(&config, 1, 0));
    let path = w.path("/onboarding-responses");
    let answer = |options: &[&str], rules: Option<bool>| {
        let (w, newcomer, path) = (&w, &newcomer, &path);
        let mut body = json!({"option_ids": options});
        if let Some(accepted) = rules {
            body["rules_accepted"] = json!(accepted);
        }
        async move { w.app.put_json(path, newcomer, body).await }
    };

    // refusals: rules not accepted, required prompt unanswered, two answers to a single-select, unknown option
    for (what, result) in [
        ("rules missing", answer(&[&games], None).await),
        ("rules declined", answer(&[&games], Some(false)).await),
        ("required missing", answer(&[&both], Some(true)).await),
        ("two answers", answer(&[&games, &art_option], Some(true)).await),
        ("unknown option", answer(&["999"], Some(true)).await),
    ] {
        assert_eq!((result.0, result.1["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{what}: {}", result.1);
    }
    assert_eq!(roles_of(&w.member_json(&newcomer_id).await), Vec::<String>::new(), "nothing granted by refused answers");
    assert_eq!(w.member_json(&newcomer_id).await["flags"], 8);

    // success: roles granted, flags completed, channels = defaults then answers the member can see (not the private one)
    let (status, done) = answer(&[&games, &both], Some(true)).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(roles_of(&done["member"]), {
        let mut roles = vec![gamer.clone(), painter.clone()];
        roles.sort();
        roles
    });
    assert_eq!(done["member"]["flags"], 10, "STARTED | COMPLETED");
    assert_eq!(done["channel_ids"], json!([w.general, gaming]));
    let (_, mine) = w.app.get(&path, &newcomer).await;
    assert_eq!(mine["option_ids"].as_array().expect("ids").len(), 2);

    // an unrelated role the owner handed out stays when answers change; roles of dropped answers go
    let (status, _) = w.app.patch(&w.path(&format!("/members/{newcomer_id}")), &w.owner, json!({"roles": [gamer, painter, extra]})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, changed) = answer(&[&art_option], Some(true)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(roles_of(&changed["member"]), {
        let mut roles = vec![painter.clone(), extra.clone()];
        roles.sort();
        roles
    });
    assert_eq!(changed["channel_ids"], json!([w.general, art]));

    // disabling onboarding closes the endpoint; deleted roles disappear from the options
    let (status, _) = w.app.delete(&w.path(&format!("/roles/{painter}")), &w.owner).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, after) = w.app.get(&w.path("/onboarding"), &newcomer).await;
    assert_eq!(after["prompts"][0]["options"][1]["role_ids"], json!([]));
    let (status, _) = w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(&w.owner), Some(json!({"enabled": false, "rules": null}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = answer(&[&games], None).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)));
    let (late, late_id) = w.member("late").await;
    assert_eq!(w.member_json(&late_id).await["flags"], Value::Null, "disabled onboarding starts nobody");
    assert_eq!(w.app.get(&path, &late).await.1["option_ids"], json!([]));
}

#[tokio::test]
async fn removing_options_and_prompts_drops_answers() {
    let w = World::new().await;
    let gamer = w.role("gamer", 0).await;
    let (_, config) = {
        let (status, config) = w
            .app
            .send(
                axum::http::Method::PUT,
                &w.path("/onboarding"),
                Some(&w.owner),
                Some(json!({"enabled": true, "prompts": [{"type": 0, "title": "Q", "options": [{"title": "A", "role_ids": [gamer]}, {"title": "B"}]}]})),
            )
            .await;
        (status, config)
    };
    let (member, member_id) = w.member("alice").await;
    let a = option_id(&config, 0, 0);
    assert_eq!(w.app.put_json(&w.path("/onboarding-responses"), &member, json!({"option_ids": [a]})).await.0, StatusCode::OK);
    // replace the list keeping only option B: A's answer is gone, the role it granted stays
    let b = option_id(&config, 0, 1);
    let (status, next) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({"prompts": [{"id": config["prompts"][0]["id"], "type": 0, "title": "Q", "options": [{"id": b, "title": "B"}]}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{next}");
    assert_eq!(next["prompts"][0]["options"].as_array().expect("options").len(), 1);
    assert_eq!(w.app.get(&w.path("/onboarding-responses"), &member).await.1["option_ids"], json!([]));
    assert_eq!(roles_of(&w.member_json(&member_id).await), vec![gamer]);
    // no prompts at all
    let (_, empty) = w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(&w.owner), Some(json!({"prompts": []}))).await;
    assert_eq!(empty["prompts"], json!([]));
}

#[tokio::test]
async fn only_roles_that_onboarding_added_are_taken_back() {
    let w = World::new().await;
    let gamer = w.role("gamer", 0).await;
    let painter = w.role("painter", 0).await;
    let (status, config) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({"enabled": true, "prompts": [{"type": 0, "title": "Q", "options": [
                {"title": "Games", "role_ids": [gamer]}, {"title": "Art", "role_ids": [painter]}, {"title": "Neither"}]}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{config}");
    let (games, art, neither) = (option_id(&config, 0, 0), option_id(&config, 0, 1), option_id(&config, 0, 2));
    let (member, member_id) = w.member("alice").await;
    let answer = |option: &str| {
        let (w, member) = (&w, &member);
        let option = option.to_owned();
        async move { w.app.put_json(&w.path("/onboarding-responses"), member, json!({"option_ids": [option]})).await }
    };

    // a role the member already had is not onboarding's to take away
    assert_eq!(w.app.patch(&w.path(&format!("/members/{member_id}")), &w.owner, json!({"roles": [painter]})).await.0, StatusCode::OK);
    assert_eq!(answer(&art).await.0, StatusCode::OK);
    let (status, moved) = answer(&games).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(
        roles_of(&moved["member"]),
        {
            let mut roles = vec![gamer.clone(), painter.clone()];
            roles.sort();
            roles
        },
        "painter was theirs already"
    );
    assert_eq!(roles_of(&answer(&neither).await.1["member"]), vec![painter.clone()], "gamer came from onboarding and goes, painter stays");

    // editing an option does not lose track of what it granted: Games now grants painter instead of gamer
    assert_eq!(answer(&games).await.0, StatusCode::OK);
    assert_eq!(roles_of(&w.member_json(&member_id).await), {
        let mut roles = vec![gamer.clone(), painter.clone()];
        roles.sort();
        roles
    });
    let (status, _) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({"prompts": [{"id": config["prompts"][0]["id"], "type": 0, "title": "Q", "options": [
                {"id": games, "title": "Games", "role_ids": [painter]}, {"id": art, "title": "Art", "role_ids": [painter]}, {"id": neither, "title": "Neither"}]}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(roles_of(&answer(&neither).await.1["member"]), vec![painter.clone()], "the gamer role granted earlier is taken back though the option changed");
}

#[tokio::test]
async fn a_role_a_moderator_gave_back_is_not_taken_by_onboarding_again() {
    let w = World::new().await;
    let gamer = w.role("gamer", 0).await;
    let (status, config) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({"enabled": true, "prompts": [{"type": 0, "title": "Q", "options": [{"title": "Games", "role_ids": [gamer]}, {"title": "Neither"}]}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{config}");
    let (games, neither) = (option_id(&config, 0, 0), option_id(&config, 0, 1));
    let (member, member_id) = w.member("alice").await;
    let answer = |option: &str| {
        let (w, member) = (&w, &member);
        let option = option.to_owned();
        async move { w.app.put_json(&w.path("/onboarding-responses"), member, json!({"option_ids": [option]})).await }
    };
    let set_roles = |roles: Vec<String>| {
        let (w, member_id) = (&w, &member_id);
        async move { w.app.patch(&w.path(&format!("/members/{member_id}")), &w.owner, json!({"roles": roles})).await.0 }
    };

    assert_eq!(roles_of(&answer(&games).await.1["member"]), vec![gamer.clone()]);
    // a moderator takes the role away and, later, gives it back on purpose
    assert_eq!(set_roles(vec![]).await, StatusCode::OK);
    assert_eq!(set_roles(vec![gamer.clone()]).await, StatusCode::OK);
    // changing the answer must leave a role that is now the moderator's alone
    let (status, moved) = answer(&neither).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(roles_of(&moved["member"]), vec![gamer.clone()], "the role was handed out by a moderator, not by onboarding");
}

#[tokio::test]
async fn default_mode_lands_in_the_default_channels_and_advanced_adds_the_answers() {
    let w = World::new().await;
    let art = w.channel("art", 0).await;
    let (status, config) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({"enabled": true, "default_channel_ids": [w.general], "prompts": [{"type": 0, "title": "Q", "options": [{"title": "Art", "channel_ids": [art]}]}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{config}");
    assert_eq!(config["mode"], 0, "Default is the starting mode");
    let option = option_id(&config, 0, 0);
    let (member, _) = w.member("alice").await;
    let path = w.path("/onboarding-responses");
    let answer = || w.app.put_json(&path, &member, json!({"option_ids": [option]}));

    let (status, done) = answer().await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["channel_ids"], json!([w.general]), "Default mode ignores the channels of the answers");

    let (status, _) = w.app.send(axum::http::Method::PUT, &w.path("/onboarding"), Some(&w.owner), Some(json!({"mode": 1}))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, done) = answer().await;
    assert_eq!(done["channel_ids"], json!([w.general, art]), "Advanced mode adds them");
}

#[tokio::test]
async fn members_only_read_the_channels_they_can_view() {
    let w = World::new().await;
    let secret = w.channel("staff", 0).await;
    let open = w.channel("lounge", 0).await;
    let (status, _) = w.app.put_json(&format!("/channels/{secret}/permissions/{}", w.guild), &w.owner, json!({"type": 0, "allow": "0", "deny": "1024"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, config) = w
        .app
        .send(
            axum::http::Method::PUT,
            &w.path("/onboarding"),
            Some(&w.owner),
            Some(json!({"enabled": true, "default_channel_ids": [w.general, secret], "prompts": [
                {"type": 0, "title": "Q", "options": [{"title": "Staff", "channel_ids": [secret, open]}]}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{config}");
    assert_eq!(config["default_channel_ids"], json!([w.general, secret]), "the editor gets everything back");
    let (member, _) = w.member("alice").await;
    let (_, seen) = w.app.get(&w.path("/onboarding"), &member).await;
    assert_eq!(seen["default_channel_ids"], json!([w.general]));
    assert_eq!(seen["prompts"][0]["options"][0]["channel_ids"], json!([open]));
    let (_, whole) = w.app.get(&w.path("/onboarding"), &w.owner).await;
    assert_eq!(whole["default_channel_ids"], json!([w.general, secret]));
    assert_eq!(whole["prompts"][0]["options"][0]["channel_ids"], json!([secret, open]));
}
