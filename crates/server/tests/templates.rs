#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};

const SEND_MESSAGES: u64 = 1 << 11;
const VIEW_CHANNEL: u64 = 1 << 10;

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_owned()
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

impl World {
    async fn join(&self, name: &str) -> String {
        let (token, _) = self.app.register(name).await;
        let (_, invite) = self.app.post(&format!("/channels/{}/invites", self.general), &self.owner, json!({})).await;
        let code = invite["code"].as_str().expect("code");
        assert_eq!(self.app.post(&format!("/invites/{code}"), &token, json!({})).await.0, StatusCode::OK);
        token
    }

    async fn template(&self) -> Value {
        let (status, template) =
            self.app.post(&format!("/guilds/{}/templates", self.guild), &self.owner, json!({"name": "Club", "description": "For clubs"})).await;
        assert_eq!(status, StatusCode::OK, "create template: {template}");
        template
    }
}

fn code(template: &Value) -> String {
    template["code"].as_str().expect("code").to_owned()
}

#[tokio::test]
async fn management_needs_manage_guild_and_anyone_signed_in_can_preview() {
    let w = world().await;
    let member = w.join("annie").await;
    let base = format!("/guilds/{}/templates", w.guild);
    assert_eq!(w.app.get(&base, &member).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.post(&base, &member, json!({"name": "Mine"})).await.0, StatusCode::FORBIDDEN);

    let template = w.template().await;
    let item = format!("{base}/{}", code(&template));
    assert_eq!(code(&template).len(), 12);
    assert_eq!(template["usage_count"], 0);
    assert_eq!(template["is_dirty"], false);
    assert_eq!(template["creator"]["username"], "sam");
    assert_eq!(template["source_guild_id"].as_str(), Some(w.guild.as_str()));
    assert_eq!(w.app.send(axum::http::Method::PUT, &item, Some(&member), None).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.patch(&item, &member, json!({"name": "x"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.app.delete(&item, &member).await.0, StatusCode::FORBIDDEN);

    // One template per guild, like Discord.
    let (status, error) = w.app.post(&base, &w.owner, json!({"name": "Second"})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(30031)));
    assert_eq!(w.app.post(&base, &w.owner, json!({"name": ""})).await.0, StatusCode::BAD_REQUEST);

    // A stranger with the code sees it; a template code used under another guild is unknown there.
    let (stranger, _) = w.app.register("teemo").await;
    let (status, seen) = w.app.get(&format!("/guilds/templates/{}", code(&template)), &stranger).await;
    assert_eq!((status, seen["name"].clone()), (StatusCode::OK, json!("Club")));
    assert_eq!(seen["is_dirty"], Value::Null, "only managers see whether the guild changed");
    let (other_guild, _) = w.app.guild_with_channel(&stranger).await;
    let (status, error) = w.app.delete(&format!("/guilds/{other_guild}/templates/{}", code(&template)), &stranger).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10057)));

    let (status, edited) = w.app.patch(&item, &w.owner, json!({"name": "Club 2", "description": null})).await;
    assert_eq!((status, edited["name"].clone(), edited["description"].clone()), (StatusCode::OK, json!("Club 2"), Value::Null));
    assert_eq!(w.app.get(&base, &w.owner).await.1.as_array().map(Vec::len), Some(1));

    let (status, gone) = w.app.delete(&item, &w.owner).await;
    assert_eq!((status, gone["code"].clone()), (StatusCode::OK, json!(code(&template))));
    let (status, error) = w.app.get(&format!("/guilds/templates/{}", code(&template)), &stranger).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::NOT_FOUND, json!(10057)));
    assert_eq!(w.app.get(&base, &w.owner).await.1, json!([]));
}

/// Builds a guild with a role, a category, a channel with topic / slowmode / nsfw and both a role and a member overwrite.
async fn furnished(w: &World) -> (String, String, String) {
    let (status, role) =
        w.app.post(&format!("/guilds/{}/roles", w.guild), &w.owner, json!({"name": "mods", "color": 0x3498db, "hoist": true, "permissions": "8"})).await;
    assert_eq!(status, StatusCode::OK, "role: {role}");
    let (status, category) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "Staff", "type": 4})).await;
    assert_eq!(status, StatusCode::OK, "category: {category}");
    let (status, staff) =
        w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "staff-chat", "type": 0, "parent_id": id(&category)})).await;
    assert_eq!(status, StatusCode::OK, "channel: {staff}");
    let (status, patched) =
        w.app.patch(&format!("/channels/{}", id(&staff)), &w.owner, json!({"topic": "staff only", "rate_limit_per_user": 30, "nsfw": true})).await;
    assert_eq!(status, StatusCode::OK, "patch: {patched}");
    let deny_everyone = json!({"type": 0, "allow": "0", "deny": VIEW_CHANNEL.to_string()});
    assert_eq!(w.app.put_json(&format!("/channels/{}/permissions/{}", id(&staff), w.guild), &w.owner, deny_everyone).await.0, StatusCode::NO_CONTENT);
    let allow_mods = json!({"type": 0, "allow": (VIEW_CHANNEL | SEND_MESSAGES).to_string(), "deny": "0"});
    assert_eq!(w.app.put_json(&format!("/channels/{}/permissions/{}", id(&staff), id(&role)), &w.owner, allow_mods).await.0, StatusCode::NO_CONTENT);
    let (_, me) = w.app.get("/users/@me", &w.owner).await;
    let member_overwrite = json!({"type": 1, "allow": VIEW_CHANNEL.to_string(), "deny": "0"});
    assert_eq!(w.app.put_json(&format!("/channels/{}/permissions/{}", id(&staff), id(&me)), &w.owner, member_overwrite).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.app.post(&format!("/channels/{}/messages", w.general), &w.owner, json!({"content": "secret plans"})).await.0, StatusCode::OK);
    assert_eq!(
        w.app.patch(&format!("/guilds/{}", w.guild), &w.owner, json!({"verification_level": 2, "default_message_notifications": 1})).await.0,
        StatusCode::OK
    );
    (id(&role), id(&category), id(&staff))
}

#[tokio::test]
async fn snapshot_carries_structure_and_settings_but_no_content() {
    let w = world().await;
    furnished(&w).await;
    let template = w.template().await;
    let source = &template["serialized_source_guild"];
    assert_eq!(
        (source["name"].clone(), source["verification_level"].clone(), source["default_message_notifications"].clone()),
        (json!("Test guild"), json!(2), json!(1))
    );

    let roles = source["roles"].as_array().expect("roles");
    assert_eq!(roles.iter().map(|r| (r["id"].clone(), r["name"].clone())).collect::<Vec<_>>(), vec![(json!(0), json!("@everyone")), (json!(1), json!("mods"))]);
    assert_eq!((roles[1]["color"].clone(), roles[1]["hoist"].clone(), roles[1]["permissions"].clone()), (json!(0x3498db), json!(true), json!("8")));

    let channels = source["channels"].as_array().expect("channels");
    let by_name = |name: &str| channels.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{name} in {channels:?}")).clone();
    let staff = by_name("staff-chat");
    let category = by_name("Staff");
    assert_eq!(staff["parent_id"], category["id"]);
    assert_eq!((staff["topic"].clone(), staff["rate_limit_per_user"].clone(), staff["nsfw"].clone()), (json!("staff only"), json!(30), json!(true)));
    // Role overwrites only, by template role id; the member overwrite is dropped.
    assert_eq!(
        staff["permission_overwrites"],
        json!([
            {"id": 0, "type": 0, "allow": "0", "deny": VIEW_CHANNEL.to_string()},
            {"id": 1, "type": 0, "allow": (VIEW_CHANNEL | SEND_MESSAGES).to_string(), "deny": "0"}
        ])
    );
    assert_eq!(source["system_channel_id"], by_name("general")["id"]);
    // Categories come first and ids count from 1.
    assert_eq!(channels[0]["type"], 4);
    assert_eq!(channels.iter().map(|c| c["id"].as_u64().expect("id")).min(), Some(1));
    let text = source.to_string();
    assert!(!text.contains("secret plans") && !text.contains("sam"), "no messages or members: {text}");
    assert_eq!(source.as_object().map(|o| o.contains_key("emojis") || o.contains_key("members")), Some(false));
}

#[tokio::test]
async fn is_dirty_follows_guild_changes_until_synced() {
    let w = world().await;
    let template = w.template().await;
    let item = format!("/guilds/{}/templates/{}", w.guild, code(&template));
    let list = format!("/guilds/{}/templates", w.guild);
    // Editing the template itself or posting messages changes nothing it copies.
    assert_eq!(w.app.post(&format!("/channels/{}/messages", w.general), &w.owner, json!({"content": "hi"})).await.0, StatusCode::OK);
    assert_eq!(w.app.patch(&item, &w.owner, json!({"name": "Renamed"})).await.1["is_dirty"], false);

    assert_eq!(w.app.patch(&format!("/channels/{}", w.general), &w.owner, json!({"topic": "new topic"})).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&list, &w.owner).await.1[0]["is_dirty"], true);

    let (status, synced) = w.app.send(axum::http::Method::PUT, &item, Some(&w.owner), None).await;
    assert_eq!((status, synced["is_dirty"].clone()), (StatusCode::OK, json!(false)));
    let general = synced["serialized_source_guild"]["channels"].as_array().expect("channels").iter().find(|c| c["name"] == "general").cloned();
    assert_eq!(general.map(|c| c["topic"].clone()), Some(json!("new topic")));
    assert!(synced["updated_at"].as_str() >= template["updated_at"].as_str());
}

#[tokio::test]
async fn snapshot_leaves_out_channels_the_creator_cannot_view() {
    const MANAGE_GUILD: u64 = 1 << 5;
    let w = world().await;
    let (_, _, staff) = furnished(&w).await;
    let deny_everyone = json!({"type": 0, "allow": "0", "deny": VIEW_CHANNEL.to_string()});
    let (_, vault) = w.app.post(&format!("/guilds/{}/channels", w.guild), &w.owner, json!({"name": "Vault", "type": 4})).await;
    assert_eq!(w.app.put_json(&format!("/channels/{}/permissions/{}", id(&vault), w.guild), &w.owner, deny_everyone).await.0, StatusCode::NO_CONTENT);
    // A manager without VIEW_CHANNEL on #staff-chat or the Vault category.
    let manager = w.join("annie").await;
    let (_, me) = w.app.get("/users/@me", &manager).await;
    let (_, role) = w.app.post(&format!("/guilds/{}/roles", w.guild), &w.owner, json!({"name": "managers", "permissions": MANAGE_GUILD.to_string()})).await;
    let assigned = w.app.patch(&format!("/guilds/{}/members/{}", w.guild, id(&me)), &w.owner, json!({"roles": [id(&role)]})).await;
    assert_eq!(assigned.0, StatusCode::OK, "{}", assigned.1);

    let base = format!("/guilds/{}/templates", w.guild);
    let (status, template) = w.app.post(&base, &manager, json!({"name": "Club"})).await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (_, preview) = w.app.get(&format!("/guilds/templates/{}", code(&template)), &w.owner).await;
    let source = &preview["serialized_source_guild"];
    let names: Vec<&str> = source["channels"].as_array().expect("channels").iter().map(|c| c["name"].as_str().expect("name")).collect();
    assert!(names.contains(&"general") && names.contains(&"Staff"), "visible channels and categories stay: {names:?}");
    assert!(!names.contains(&"staff-chat") && !names.contains(&"Vault"), "hidden ones are left out: {names:?}");
    assert!(!source.to_string().contains("staff only"));
    assert_eq!(template["is_dirty"], false);

    // Changes to hidden channels don't make the manager's template dirty, and a sync keeps them out.
    assert_eq!(w.app.patch(&format!("/channels/{staff}"), &w.owner, json!({"topic": "still secret"})).await.0, StatusCode::OK);
    assert_eq!(w.app.get(&base, &manager).await.1[0]["is_dirty"], false);
    let item = format!("{base}/{}", code(&template));
    let (status, synced) = w.app.send(axum::http::Method::PUT, &item, Some(&manager), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!synced["serialized_source_guild"].to_string().contains("staff-chat"));
}

#[tokio::test]
async fn creating_from_a_template_remaps_every_id() {
    let w = world().await;
    let (role, category, staff) = furnished(&w).await;
    let template = w.template().await;
    let (user, _) = w.app.register("teemo").await;
    let (status, guild) = w.app.post(&format!("/guilds/templates/{}", code(&template)), &user, json!({"name": "Teemo's club"})).await;
    assert_eq!(status, StatusCode::OK, "create from template: {guild}");
    let new_guild = id(&guild);
    assert_ne!(new_guild, w.guild);
    assert_eq!(guild["name"], "Teemo's club");
    let (_, me) = w.app.get("/users/@me", &user).await;
    assert_eq!(guild["owner_id"], me["id"]);
    assert_eq!(guild["verification_level"], 2);
    assert_eq!(guild["default_message_notifications"], 1);

    let roles = guild["roles"].as_array().expect("roles");
    assert_eq!(roles.len(), 2);
    let mods = roles.iter().find(|r| r["name"] == "mods").expect("mods role");
    assert!(roles.iter().any(|r| r["id"].as_str() == Some(new_guild.as_str()) && r["name"] == "@everyone"));
    assert_ne!(id(mods), role);
    assert_eq!((mods["color"].clone(), mods["hoist"].clone()), (json!(0x3498db), json!(true)));

    let (_, channels) = w.app.get(&format!("/guilds/{new_guild}/channels"), &user).await;
    let channels = channels.as_array().expect("channels");
    let by_name = |name: &str| channels.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{name}")).clone();
    let new_staff = by_name("staff-chat");
    let new_category = by_name("Staff");
    assert_ne!((id(&new_staff), id(&new_category)), (staff, category));
    assert_eq!(new_staff["parent_id"], new_category["id"]);
    assert_eq!(
        (new_staff["topic"].clone(), new_staff["rate_limit_per_user"].clone(), new_staff["nsfw"].clone()),
        (json!("staff only"), json!(30), json!(true))
    );
    let mut targets: Vec<String> = new_staff["permission_overwrites"].as_array().expect("overwrites").iter().map(id).collect();
    targets.sort();
    let mut expected = vec![new_guild.clone(), id(mods)];
    expected.sort();
    assert_eq!(targets, expected, "overwrites point at the new guild's roles, member overwrites are gone");
    assert_eq!(guild["system_channel_id"], by_name("general")["id"]);

    // A new guild with its creator as the only member and no messages.
    let (_, members) = w.app.get(&format!("/guilds/{new_guild}/members"), &user).await;
    assert_eq!(members.as_array().map(Vec::len), Some(1));
    let (_, messages) = w.app.get(&format!("/channels/{}/messages", id(&by_name("general"))), &user).await;
    assert_eq!(messages, json!([]));
    assert_eq!(w.app.get(&format!("/guilds/templates/{}", code(&template)), &user).await.1["usage_count"], 1);
    // The source guild is untouched, and short names are refused.
    assert_eq!(w.app.get(&format!("/guilds/{}/channels", w.guild), &w.owner).await.1.as_array().map(Vec::len), Some(channels.len()));
    assert_eq!(w.app.post(&format!("/guilds/templates/{}", code(&template)), &user, json!({"name": "x"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(w.app.post("/guilds/templates/nope", &user, json!({"name": "Fine name"})).await.0, StatusCode::NOT_FOUND);
}
