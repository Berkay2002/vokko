#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Profile perks: banner, pronouns, theme colours, decoration, effect, server tag / theme, per-server member profiles.
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;

/// (app, owner token, member token, general channel, guild id)
async fn setup() -> (TestApp, String, String, String, String) {
    let app = TestApp::new().await;
    let (owner, _) = app.register("sam").await;
    let (member, _) = app.register("alice").await;
    let (_, guild) = app.post("/guilds", &owner, json!({"name": "Profile guild"})).await;
    let guild_id = guild["id"].as_str().expect("id").to_owned();
    let (_, channels) = app.get(&format!("/guilds/{guild_id}/channels"), &owner).await;
    let channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    (app, owner, member, channel, guild_id)
}

fn png() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    bytes.extend_from_slice(&4_u32.to_be_bytes());
    bytes.extend_from_slice(&4_u32.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

async fn upload(app: &TestApp, token: &str, channel: &str, filename: &str, declared: &str, data: &[u8]) -> Value {
    let boundary = "vokkoboundary7MA4YWxkTrZu0gW";
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {declared}\r\n\r\n").into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/channels/{channel}/attachments"))
        .header("authorization", token)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("attachment json")
}

async fn status_of(app: &TestApp, url: &str) -> StatusCode {
    let path = url.strip_prefix("http://test.local").expect("test origin");
    app.router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).expect("request")).await.expect("response").status()
}

/// The key is present and `null`: the client merges update events by spreading, so an omitted key would leave stale data behind.
fn is_null(object: &Value, key: &str) -> bool {
    object.as_object().is_some_and(|fields| fields.get(key).is_some_and(Value::is_null))
}

fn user_id(app_user: &Value) -> String {
    app_user["id"].as_str().expect("id").to_owned()
}

#[tokio::test]
async fn user_profile_fields_round_trip_and_clear() {
    let (app, owner, member, channel, _) = setup().await;
    let banner = upload(&app, &owner, &channel, "banner.png", "image/png", &png()).await;

    // a fresh user has every perk as an explicit null
    let (_, me) = app.get("/users/@me", &owner).await;
    for key in ["banner", "pronouns", "theme_colors", "avatar_decoration", "profile_effect", "primary_guild"] {
        assert!(is_null(&me, key), "{key}: {me}");
    }

    let (status, updated) = app
        .patch(
            "/users/@me",
            &owner,
            json!({
                "banner_attachment_id": banner["id"],
                "pronouns": " they/them ",
                "theme_colors": [0x112233, 0xaabbcc],
                "avatar_decoration": "flame_ring",
                "profile_effect": "sparkle-1",
            }),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["banner"], banner["url"]);
    assert_eq!(updated["pronouns"], "they/them");
    assert_eq!(updated["theme_colors"], json!([0x112233, 0xaabbcc]));
    assert_eq!(updated["avatar_decoration"], "flame_ring");
    assert_eq!(updated["profile_effect"], "sparkle-1");
    assert_eq!(status_of(&app, updated["banner"].as_str().expect("banner")).await, 200);

    // another user sees the same
    let id = user_id(&updated);
    let (_, seen) = app.get(&format!("/users/{id}"), &member).await;
    assert_eq!(seen, updated);
    let (_, profile) = app.get(&format!("/users/{id}/profile"), &member).await;
    assert_eq!(profile["user"], updated);

    // absent keys are left alone, null clears just that key
    let (status, partial) = app.patch("/users/@me", &owner, json!({"pronouns": null, "bio": "hello"})).await;
    assert_eq!(status, 200, "{partial}");
    assert!(is_null(&partial, "pronouns"), "{partial}");
    assert_eq!(partial["bio"], "hello");
    assert_eq!(partial["banner"], banner["url"]);
    assert_eq!(partial["theme_colors"], json!([0x112233, 0xaabbcc]));
    let (_, cleared) =
        app.patch("/users/@me", &owner, json!({"banner_attachment_id": null, "theme_colors": null, "avatar_decoration": "", "profile_effect": null})).await;
    for key in ["banner", "theme_colors", "avatar_decoration", "profile_effect"] {
        assert!(is_null(&cleared, key), "{key}: {cleared}");
    }
}

#[tokio::test]
async fn user_profile_validation_rejects_without_changing_anything() {
    let (app, owner, _, channel, _) = setup().await;
    let text = upload(&app, &owner, &channel, "notes.txt", "text/plain", b"not an image").await;
    // bytes that are not an image never become one by declaring `image/png` or by their file name
    let disguised = upload(&app, &owner, &channel, "photo.png", "image/png", b"<html><script>alert(1)</script></html>").await;
    let huge = upload(&app, &owner, &channel, "huge.png", "image/png", &png()).await;
    let numeric: i64 = huge["id"].as_str().expect("id").parse().expect("id");
    sqlx::query("UPDATE attachments SET size = $2 WHERE id = $1").bind(numeric).bind(11_i64 * 1024 * 1024).execute(&app.state.db).await.expect("size");
    let (status, _) = app.patch("/users/@me", &owner, json!({"pronouns": "she/her"})).await;
    assert_eq!(status, 200);

    let bad = [
        ("banner_attachment_id", json!(text["id"])),
        ("banner_attachment_id", json!(huge["id"])),
        ("banner_attachment_id", json!("123456789")),
        ("banner_attachment_id", json!(disguised["id"])),
        ("avatar_attachment_id", json!(disguised["id"])),
        ("avatar_attachment_id", json!(text["id"])),
        ("pronouns", json!("p".repeat(41))),
        ("bio", json!("b".repeat(191))),
        ("theme_colors", json!([0x1000000, 0])),
        ("avatar_decoration", json!("Not Allowed!")),
        ("profile_effect", json!("e".repeat(65))),
        ("primary_guild_id", json!("123456789")),
    ];
    for (key, value) in bad {
        // sent together with a valid change that must not apply either
        let (status, error) = app.patch("/users/@me", &owner, json!({key: value, "global_name": "Changed"})).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{key}: {error}");
    }
    let (_, me) = app.get("/users/@me", &owner).await;
    assert_eq!(me["pronouns"], "she/her");
    assert!(is_null(&me, "global_name"), "{me}");
    assert!(is_null(&me, "banner"), "{me}");
}

#[tokio::test]
async fn server_tag_and_theme_and_primary_guild() {
    let (app, owner, member, _, guild) = setup().await;
    let owner_id = {
        let (_, me) = app.get("/users/@me", &owner).await;
        user_id(&me)
    };
    let member_id = {
        let (_, me) = app.get("/users/@me", &member).await;
        user_id(&me)
    };
    let tag = json!({"tag": "SAM", "badge": "bolt", "color_primary": 0xff0000, "color_secondary": 0x00ff00});

    // a guild without either sends them as explicit nulls
    let (_, plain) = app.get(&format!("/guilds/{guild}"), &member).await;
    assert!(is_null(&plain, "tag") && is_null(&plain, "theme"), "{plain}");

    // MANAGE_GUILD only
    let (status, _) = app.patch(&format!("/guilds/{guild}"), &member, json!({"tag": tag})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // a guild without a tag cannot be adopted
    let (status, error) = app.patch("/users/@me", &member, json!({"primary_guild_id": guild})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");

    let (status, updated) =
        app.patch(&format!("/guilds/{guild}"), &owner, json!({"tag": tag, "theme": {"preset": "ember", "primary": 0x331100, "accent": 0xffaa00}})).await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["tag"], tag);
    assert_eq!(updated["theme"], json!({"preset": "ember", "primary": 0x331100, "accent": 0xffaa00}));
    let (_, fetched) = app.get(&format!("/guilds/{guild}"), &member).await;
    assert_eq!(fetched["tag"], tag);
    let (_, listed) = app.get("/users/@me/guilds", &member).await;
    assert_eq!(listed[0]["tag"], tag);

    // bad tags
    for bad in [
        json!({"tag": "", "badge": "bolt", "color_primary": 0, "color_secondary": 0}),
        json!({"tag": "TOOLONG", "badge": "bolt", "color_primary": 0, "color_secondary": 0}),
        json!({"tag": "A B", "badge": "bolt", "color_primary": 0, "color_secondary": 0}),
        json!({"tag": "AB", "badge": "", "color_primary": 0, "color_secondary": 0}),
        json!({"tag": "AB", "badge": "bolt", "color_primary": 0x1000000, "color_secondary": 0}),
    ] {
        let (status, error) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"tag": bad})).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{bad}: {error}");
    }

    // the member wears it
    let (status, me) = app.patch("/users/@me", &member, json!({"primary_guild_id": guild})).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["primary_guild"], json!({"guild_id": guild, "tag": "SAM", "badge": "bolt", "color_primary": 0xff0000, "color_secondary": 0x00ff00}));
    // visible to others through the member list and the user object
    let (_, members) = app.get(&format!("/guilds/{guild}/members"), &owner).await;
    let listed = members.as_array().expect("members").iter().find(|m| m["user"]["id"] == member_id.as_str()).expect("member");
    assert_eq!(listed["user"]["primary_guild"]["tag"], "SAM");

    // an edited tag shows up for the people wearing it
    let (_, _) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"tag": {"tag": "RZ", "badge": "bolt", "color_primary": 1, "color_secondary": 2}})).await;
    let (_, me) = app.get("/users/@me", &member).await;
    assert_eq!(me["primary_guild"]["tag"], "RZ");

    // the owner is not wearing it
    let (_, owner_me) = app.get(&format!("/users/{owner_id}"), &member).await;
    assert!(is_null(&owner_me, "primary_guild"), "{owner_me}");

    // removing the tag clears it for the wearers
    let (status, no_tag) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"tag": null})).await;
    assert_eq!(status, 200);
    assert!(is_null(&no_tag, "tag"), "{no_tag}");
    assert_eq!(no_tag["theme"]["preset"], "ember", "theme untouched");
    let (_, me) = app.get("/users/@me", &member).await;
    assert!(is_null(&me, "primary_guild"), "{me}");
    let (_, no_theme) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"theme": null})).await;
    assert!(is_null(&no_theme, "theme"), "{no_theme}");
}

#[tokio::test]
async fn primary_guild_disappears_when_leaving() {
    let (app, owner, member, _, guild) = setup().await;
    app.patch(&format!("/guilds/{guild}"), &owner, json!({"tag": {"tag": "SAM", "badge": "bolt", "color_primary": 0, "color_secondary": 1}})).await;
    let (status, me) = app.patch("/users/@me", &member, json!({"primary_guild_id": guild})).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["primary_guild"]["tag"], "SAM");
    let id = user_id(&me);

    let (status, _) = app.delete(&format!("/users/@me/guilds/{guild}"), &member).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, me) = app.get("/users/@me", &member).await;
    assert!(is_null(&me, "primary_guild"), "{me}");
    let (_, seen) = app.get(&format!("/users/{id}"), &owner).await;
    assert!(is_null(&seen, "primary_guild"), "{seen}");
    // and it is not silently back after rejoining
    let (_, channels) = app.get(&format!("/guilds/{guild}/channels"), &owner).await;
    let channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;
    let (_, me) = app.get("/users/@me", &member).await;
    assert!(is_null(&me, "primary_guild"), "{me}");
}

#[tokio::test]
async fn per_server_member_profile_round_trips() {
    let (app, owner, member, channel, guild) = setup().await;
    let member_id = {
        let (_, me) = app.get("/users/@me", &member).await;
        user_id(&me)
    };
    let avatar = upload(&app, &member, &channel, "server-me.png", "image/png", &png()).await;
    let banner = upload(&app, &member, &channel, "server-banner.png", "image/png", &png()).await;

    // starts empty (explicit nulls)
    let (_, profile) = app.get(&format!("/users/{member_id}/profile?guild_id={guild}"), &owner).await;
    for key in ["avatar", "banner", "bio", "pronouns", "theme_colors"] {
        assert!(is_null(&profile["guild_member"], key), "{key}: {profile}");
    }

    let (status, edited) = app
        .patch(
            &format!("/guilds/{guild}/members/@me"),
            &member,
            json!({
                "avatar_attachment_id": avatar["id"],
                "banner_attachment_id": banner["id"],
                "bio": "only in this server",
                "pronouns": "xe/xem",
                "theme_colors": [1, 2],
                "nick": "Ali",
            }),
        )
        .await;
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["avatar"], avatar["url"]);
    assert_eq!(edited["banner"], banner["url"]);
    assert_eq!(edited["bio"], "only in this server");
    assert_eq!(edited["pronouns"], "xe/xem");
    assert_eq!(edited["theme_colors"], json!([1, 2]));
    assert_eq!(edited["nick"], "Ali");
    // the account's own profile is untouched
    assert!(is_null(&edited["user"], "avatar"), "{edited}");
    assert!(is_null(&edited["user"], "bio"), "{edited}");
    assert_eq!(status_of(&app, edited["avatar"].as_str().expect("avatar")).await, 200);

    let (_, profile) = app.get(&format!("/users/{member_id}/profile?guild_id={guild}"), &owner).await;
    assert_eq!(profile["guild_member"]["bio"], "only in this server");
    assert_eq!(profile["guild_member"]["avatar"], avatar["url"]);
    let (_, members) = app.get(&format!("/guilds/{guild}/members"), &owner).await;
    let listed = members.as_array().expect("members").iter().find(|m| m["user"]["id"] == member_id.as_str()).expect("member");
    assert_eq!(listed["pronouns"], "xe/xem");

    // a caller outside the guild gets no server profile
    let (outsider, _) = app.register("bob").await;
    let (_, hidden) = app.get(&format!("/users/{member_id}/profile?guild_id={guild}"), &outsider).await;
    assert!(hidden.get("guild_member").is_none() || hidden["guild_member"].is_null(), "{hidden}");

    // validation: nothing changes on a rejected request
    let text = upload(&app, &member, &channel, "n.txt", "text/plain", b"nope").await;
    let (status, error) = app.patch(&format!("/guilds/{guild}/members/@me"), &member, json!({"bio": "changed", "avatar_attachment_id": text["id"]})).await;
    assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{error}");
    let (status, _) = app.patch(&format!("/guilds/{guild}/members/@me"), &member, json!({"pronouns": "p".repeat(41)})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, profile) = app.get(&format!("/users/{member_id}/profile?guild_id={guild}"), &owner).await;
    assert_eq!(profile["guild_member"]["bio"], "only in this server");

    // null falls back to the account's own, absent keys stay
    let (status, cleared) = app.patch(&format!("/guilds/{guild}/members/@me"), &member, json!({"avatar_attachment_id": null, "bio": null})).await;
    assert_eq!(status, 200, "{cleared}");
    assert!(is_null(&cleared, "avatar"), "{cleared}");
    assert!(is_null(&cleared, "bio"), "{cleared}");
    assert_eq!(cleared["banner"], banner["url"]);
    assert_eq!(cleared["nick"], "Ali");
}

#[tokio::test]
async fn nameplate_and_display_name_styles_round_trip_and_validate() {
    let (app, owner, member, _, _) = setup().await;
    let (_, me) = app.get("/users/@me", &owner).await;
    assert!(is_null(&me, "nameplate") && is_null(&me, "display_name_styles"), "{me}");

    let style = json!({"font_id": "serif", "effect_id": "gradient", "colors": [0xff0000, 0x0000ff]});
    let (status, updated) = app.patch("/users/@me", &owner, json!({"nameplate": "aurora", "display_name_styles": style})).await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["nameplate"], "aurora");
    assert_eq!(updated["display_name_styles"], style);
    let (_, seen) = app.get(&format!("/users/{}", user_id(&updated)), &member).await;
    assert_eq!(seen["display_name_styles"], style);
    assert_eq!(seen["nameplate"], "aurora");

    let bad = [
        ("nameplate", json!("Bad Id")),
        ("display_name_styles", json!({"font_id": "serif", "effect_id": "solid", "colors": []})),
        ("display_name_styles", json!({"font_id": "serif", "effect_id": "solid", "colors": [1, 2, 3]})),
        ("display_name_styles", json!({"font_id": "serif", "effect_id": "solid", "colors": [0x1000000]})),
        ("display_name_styles", json!({"font_id": "", "effect_id": "solid", "colors": [1]})),
        ("display_name_styles", json!({"font_id": "serif", "effect_id": "NOPE!", "colors": [1]})),
        ("display_name_styles", json!({"font_id": "serif", "colors": [1]})),
    ];
    for (key, value) in bad {
        let (status, error) = app.patch("/users/@me", &owner, json!({key: value, "global_name": "Changed"})).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{key}: {error}");
    }
    let (_, me) = app.get("/users/@me", &owner).await;
    assert_eq!(me["nameplate"], "aurora", "rejected requests change nothing");
    assert!(is_null(&me, "global_name"), "{me}");

    // a single colour works; null clears both
    let (_, solid) = app.patch("/users/@me", &owner, json!({"display_name_styles": {"font_id": "mono", "effect_id": "solid", "colors": [7]}})).await;
    assert_eq!(solid["display_name_styles"]["colors"], json!([7]));
    let (_, cleared) = app.patch("/users/@me", &owner, json!({"display_name_styles": null, "nameplate": null})).await;
    assert!(is_null(&cleared, "display_name_styles") && is_null(&cleared, "nameplate"), "{cleared}");
}

#[tokio::test]
async fn profile_frame_round_trips_validates_and_clears() {
    let (app, owner, member, _, _) = setup().await;
    let (_, me) = app.get("/users/@me", &owner).await;
    assert!(is_null(&me, "profile_frame"), "a fresh user sends an explicit null: {me}");

    let (status, updated) = app.patch("/users/@me", &owner, json!({"profile_frame": "gold-filigree"})).await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["profile_frame"], "gold-filigree");
    let (_, seen) = app.get(&format!("/users/{}", user_id(&updated)), &member).await;
    assert_eq!(seen["profile_frame"], "gold-filigree");

    for value in [json!("Bad Id"), json!("f".repeat(65)), json!("frame!")] {
        let (status, error) = app.patch("/users/@me", &owner, json!({"profile_frame": value, "global_name": "Changed"})).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{value}: {error}");
    }
    let (_, me) = app.get("/users/@me", &owner).await;
    assert_eq!(me["profile_frame"], "gold-filigree", "rejected requests change nothing");
    assert!(is_null(&me, "global_name"), "{me}");

    // other keys leave it alone; null and "" clear it
    let (_, kept) = app.patch("/users/@me", &owner, json!({"bio": "hi"})).await;
    assert_eq!(kept["profile_frame"], "gold-filigree");
    let (_, cleared) = app.patch("/users/@me", &owner, json!({"profile_frame": null})).await;
    assert!(is_null(&cleared, "profile_frame"), "{cleared}");
    app.patch("/users/@me", &owner, json!({"profile_frame": "f".repeat(64)})).await;
    let (_, emptied) = app.patch("/users/@me", &owner, json!({"profile_frame": ""})).await;
    assert!(is_null(&emptied, "profile_frame"), "{emptied}");
}

#[tokio::test]
async fn profile_images_take_ten_mib_animated_or_not() {
    let (app, owner, _, channel, _) = setup().await;
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&[4, 0, 4, 0, 0, 0, 0, 0x3b]);
    // the stored size is set directly: what matters is the limit check, not shipping 10 MiB through the test
    for (name, bytes, size, ok) in [
        ("a.gif", gif.clone(), 9 * 1024 * 1024, true),
        ("b.gif", gif.clone(), 10 * 1024 * 1024, true),
        ("c.gif", gif.clone(), 10 * 1024 * 1024 + 1, false),
        ("d.png", png(), 10 * 1024 * 1024, true),
    ] {
        for field in ["avatar_attachment_id", "banner_attachment_id"] {
            let attachment = upload(&app, &owner, &channel, name, "image/gif", &bytes).await;
            let id: i64 = attachment["id"].as_str().expect("id").parse().expect("id");
            sqlx::query("UPDATE attachments SET size = $2 WHERE id = $1").bind(id).bind(size).execute(&app.state.db).await.expect("size");
            let (status, body) = app.patch("/users/@me", &owner, json!({field: attachment["id"]})).await;
            assert_eq!(status == StatusCode::OK, ok, "{name} {size} {field}: {body}");
        }
    }
}

#[tokio::test]
async fn per_server_profiles_stay_in_their_server() {
    let (app, owner, member, channel, guild) = setup().await;
    let member_id = {
        let (_, me) = app.patch("/users/@me", &member, json!({"bio": "global bio", "pronouns": "she/her"})).await;
        user_id(&me)
    };
    // a second guild the member also belongs to
    let (_, other) = app.post("/guilds", &owner, json!({"name": "Second guild"})).await;
    let other_id = other["id"].as_str().expect("id").to_owned();
    let (_, channels) = app.get(&format!("/guilds/{other_id}/channels"), &owner).await;
    let other_channel = channels.as_array().expect("channels").iter().find(|c| c["name"] == "general").expect("general")["id"].as_str().expect("id").to_owned();
    let (_, invite) = app.post(&format!("/channels/{other_channel}/invites"), &owner, json!({})).await;
    app.post(&format!("/invites/{}", invite["code"].as_str().expect("code")), &member, json!({})).await;

    let avatar = upload(&app, &member, &channel, "here.png", "image/png", &png()).await;
    let (status, _) = app.patch(&format!("/guilds/{guild}/members/@me"), &member, json!({"bio": "server bio", "avatar_attachment_id": avatar["id"]})).await;
    assert_eq!(status, 200);

    // the first guild has the override next to the unchanged global user
    let (_, here) = app.get(&format!("/users/{member_id}/profile?guild_id={guild}"), &owner).await;
    assert_eq!(here["guild_member"]["bio"], "server bio");
    assert_eq!(here["guild_member"]["avatar"], avatar["url"]);
    assert_eq!(here["user"]["bio"], "global bio");
    assert!(is_null(&here["user"], "avatar"), "{here}");
    // the second guild has none, so clients fall back to the user's own
    let (_, there) = app.get(&format!("/users/{member_id}/profile?guild_id={other_id}"), &owner).await;
    assert!(is_null(&there["guild_member"], "bio") && is_null(&there["guild_member"], "avatar"), "{there}");
    assert_eq!(there["user"]["bio"], "global bio");
    // the member list of the first guild carries the override, the second does not
    let (_, members) = app.get(&format!("/guilds/{guild}/members"), &owner).await;
    let listed = members.as_array().expect("members").iter().find(|m| m["user"]["id"] == member_id.as_str()).expect("member").clone();
    assert_eq!(listed["bio"], "server bio");
    let (_, members) = app.get(&format!("/guilds/{other_id}/members"), &owner).await;
    let listed = members.as_array().expect("members").iter().find(|m| m["user"]["id"] == member_id.as_str()).expect("member").clone();
    assert!(is_null(&listed, "bio"), "{listed}");
}

async fn claimed(app: &TestApp, attachment: &Value) -> Option<bool> {
    let id: i64 = attachment["id"].as_str().expect("id").parse().expect("numeric id");
    sqlx::query_scalar("SELECT claimed_at IS NOT NULL FROM attachments WHERE id = $1").bind(id).fetch_optional(&app.state.db).await.expect("claimed")
}

#[tokio::test]
async fn profile_widgets_round_trip_echo_and_clear() {
    let (app, owner, member, channel, _) = setup().await;
    let cover = upload(&app, &owner, &channel, "cover.png", "image/png", &png()).await;
    let tile = upload(&app, &owner, &channel, "tile.png", "image/png", &png()).await;

    let (_, me) = app.get("/users/@me", &owner).await;
    assert!(is_null(&me, "widgets"), "{me}");

    let (status, updated) = app
        .patch(
            "/users/@me",
            &owner,
            json!({"widgets": {
                "favorite_game": {"name": " Hades ", "image_attachment_id": cover["id"], "reason": " fast and stylish ", "tags": [" roguelike ", "action"]},
                "games_i_like": [{"name": "Celeste", "image_attachment_id": tile["id"]}, {"name": "Hollow Knight"}],
            }}),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    let widgets = updated["widgets"].clone();
    assert_eq!(widgets["favorite_game"]["name"], "Hades");
    assert_eq!(widgets["favorite_game"]["reason"], "fast and stylish");
    assert_eq!(widgets["favorite_game"]["tags"], json!(["roguelike", "action"]));
    assert_eq!(widgets["favorite_game"]["image"], cover["url"]);
    assert_eq!(widgets["favorite_game"]["image_attachment_id"], cover["id"]);
    assert_eq!(widgets["games_i_like"][0]["image"], tile["url"]);
    assert_eq!(widgets["games_i_like"][1], json!({"name": "Hollow Knight", "image": null, "image_attachment_id": null}));
    assert_eq!(status_of(&app, widgets["favorite_game"]["image"].as_str().expect("image")).await, 200);

    // everyone reads the same value
    let (_, mine) = app.get("/users/@me", &owner).await;
    assert_eq!(mine["widgets"], widgets);
    let (_, seen) = app.get(&format!("/users/{}", user_id(&updated)), &member).await;
    assert_eq!(seen["widgets"], widgets);

    // an unrelated change leaves them, and echoing the current value back (images by their ids) keeps the images
    let (_, partial) = app.patch("/users/@me", &owner, json!({"bio": "hi"})).await;
    assert_eq!(partial["widgets"], widgets);
    let echo = json!({"widgets": {
        "favorite_game": {"name": "Hades", "image_attachment_id": widgets["favorite_game"]["image_attachment_id"], "reason": "fast and stylish", "tags": ["roguelike", "action"]},
        "games_i_like": widgets["games_i_like"],
    }});
    let (status, echoed) = app.patch("/users/@me", &owner, echo).await;
    assert_eq!(status, 200, "{echoed}");
    assert_eq!(echoed["widgets"], widgets);
    assert_eq!(claimed(&app, &cover).await, Some(true));

    // replaced as a whole: the favourite is gone when it is left out
    let (_, replaced) = app.patch("/users/@me", &owner, json!({"widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": tile["id"]}]}})).await;
    assert!(replaced["widgets"].get("favorite_game").is_none_or(Value::is_null), "{replaced}");
    assert_eq!(replaced["widgets"]["games_i_like"].as_array().map(Vec::len), Some(1));

    let (status, cleared) = app.patch("/users/@me", &owner, json!({"widgets": null})).await;
    assert_eq!(status, 200, "{cleared}");
    assert!(is_null(&cleared, "widgets"), "{cleared}");
    let (_, member_view) = app.get(&format!("/users/{}", user_id(&updated)), &member).await;
    assert!(is_null(&member_view, "widgets"), "{member_view}");
}

#[tokio::test]
async fn profile_widgets_validation_rejects_without_changing_anything() {
    let (app, owner, member, channel, _) = setup().await;
    let mine = upload(&app, &owner, &channel, "mine.png", "image/png", &png()).await;
    let theirs = upload(&app, &member, &channel, "theirs.png", "image/png", &png()).await;
    let text = upload(&app, &owner, &channel, "notes.txt", "text/plain", b"not an image").await;
    let (status, _) = app.patch("/users/@me", &owner, json!({"widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": mine["id"]}]}})).await;
    assert_eq!(status, 200);

    let games: Vec<Value> = (0..21).map(|n| json!({"name": format!("Game {n}")})).collect();
    let bad = [
        json!({"favorite_game": {"name": "Hades", "reason": "r".repeat(191)}}),
        json!({"favorite_game": {"name": "Hades", "tags": ["a", "b", "c", "d", "e", "f"]}}),
        json!({"favorite_game": {"name": "Hades", "tags": ["a", ""]}}),
        json!({"favorite_game": {"name": "Hades", "tags": ["a", "A"]}}),
        json!({"favorite_game": {"name": "Hades", "tags": ["t".repeat(21)]}}),
        json!({"favorite_game": {"name": "  "}}),
        json!({"favorite_game": {"name": "n".repeat(65)}}),
        json!({"games_i_like": games}),
        json!({"games_i_like": [{"name": ""}]}),
        json!({"games_i_like": [{"name": "Celeste", "image_attachment_id": theirs["id"]}]}),
        json!({"games_i_like": [{"name": "Celeste", "image_attachment_id": text["id"]}]}),
        json!({"games_i_like": [{"name": "Celeste", "image_attachment_id": "123456789"}]}),
        json!({"favorite_game": {"name": "Hades", "image_attachment_id": theirs["id"]}}),
        json!({"favorite_game": null, "wishlist": []}),
    ];
    for widgets in bad {
        let (status, error) = app.patch("/users/@me", &owner, json!({"widgets": widgets, "global_name": "Changed"})).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{widgets}: {error}");
    }
    let (_, me) = app.get("/users/@me", &owner).await;
    assert!(is_null(&me, "global_name"), "{me}");
    assert_eq!(me["widgets"]["games_i_like"][0]["image_attachment_id"], mine["id"]);
    assert_eq!(claimed(&app, &theirs).await, Some(false), "somebody else's upload is never claimed through widgets");

    // a board at exactly the limits is fine
    let games: Vec<Value> = (0..20).map(|n| json!({"name": format!("Game {n}")})).collect();
    let limit =
        json!({"favorite_game": {"name": "n".repeat(64), "reason": "r".repeat(190), "tags": ["a", "b", "c", "d", "t".repeat(20)]}, "games_i_like": games});
    let (status, ok) = app.patch("/users/@me", &owner, json!({"widgets": limit})).await;
    assert_eq!(status, 200, "{ok}");
}

#[tokio::test]
async fn profile_widget_images_are_claimed_and_released() {
    let (app, owner, _, channel, _) = setup().await;
    let first = upload(&app, &owner, &channel, "first.png", "image/png", &png()).await;
    let second = upload(&app, &owner, &channel, "second.png", "image/png", &png()).await;
    let shared = upload(&app, &owner, &channel, "shared.png", "image/png", &png()).await;
    assert_eq!(claimed(&app, &first).await, Some(false));

    let board = json!({"widgets": {
        "favorite_game": {"name": "Hades", "image_attachment_id": first["id"]},
        "games_i_like": [{"name": "Celeste", "image_attachment_id": second["id"]}, {"name": "Tunic", "image_attachment_id": shared["id"]}],
    }});
    let (status, _) = app.patch("/users/@me", &owner, board).await;
    assert_eq!(status, 200);
    for attachment in [&first, &second, &shared] {
        assert_eq!(claimed(&app, attachment).await, Some(true));
    }

    // the avatar uses `shared` too, so dropping it from the board must not release it
    let (status, _) = app.patch("/users/@me", &owner, json!({"avatar_attachment_id": shared["id"]})).await;
    assert_eq!(status, 200);
    let (status, kept) = app.patch("/users/@me", &owner, json!({"widgets": {"games_i_like": [{"name": "Tunic", "image_attachment_id": first["id"]}]}})).await;
    assert_eq!(status, 200, "{kept}");
    assert_eq!(claimed(&app, &first).await, Some(true), "still shown");
    assert_eq!(claimed(&app, &second).await, Some(false), "no longer used: pending again");
    assert_eq!(claimed(&app, &shared).await, Some(true), "the avatar still uses it");

    // clearing releases the last widget image; the avatar upload stays
    let (status, _) = app.patch("/users/@me", &owner, json!({"widgets": null})).await;
    assert_eq!(status, 200);
    assert_eq!(claimed(&app, &first).await, Some(false));
    assert_eq!(claimed(&app, &shared).await, Some(true));
    let removed = vokko_server::media::cleanup_pending(&app.state, std::time::Duration::ZERO).await;
    assert_eq!(removed, 2, "the two released uploads are removed by the periodic cleanup");
    assert_eq!(claimed(&app, &first).await, None);
    assert_eq!(claimed(&app, &shared).await, Some(true));
}

#[tokio::test]
async fn an_upload_still_in_use_survives_cleanup_even_when_unclaimed() {
    let (app, owner, _, channel, _) = setup().await;
    let avatar = upload(&app, &owner, &channel, "avatar.png", "image/png", &png()).await;
    let tile = upload(&app, &owner, &channel, "tile.png", "image/png", &png()).await;
    let (status, _) = app
        .patch(
            "/users/@me",
            &owner,
            json!({"avatar_attachment_id": avatar["id"], "widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": tile["id"]}]}}),
        )
        .await;
    assert_eq!(status, 200);
    // a lost claim (the race the shared in-use check guards against) must not cost the profile its images
    sqlx::query("UPDATE attachments SET claimed_at = NULL WHERE id = ANY($1)")
        .bind(vec![avatar["id"].as_str().expect("id").parse::<i64>().expect("id"), tile["id"].as_str().expect("id").parse::<i64>().expect("id")])
        .execute(&app.state.db)
        .await
        .expect("unclaim");
    let removed = vokko_server::media::cleanup_pending(&app.state, std::time::Duration::ZERO).await;
    assert_eq!(removed, 0);
    assert_eq!(claimed(&app, &avatar).await, Some(false));
    assert_eq!(claimed(&app, &tile).await, Some(false));
}

#[tokio::test]
async fn deleting_the_account_takes_the_widgets_and_their_images() {
    let (app, owner, member, channel, _) = setup().await;
    let image = upload(&app, &member, &channel, "tile.png", "image/png", &png()).await;
    let style = json!({"font_id": "serif", "effect_id": "gradient", "colors": [0xff0000, 0x0000ff]});
    let (status, updated) = app
        .patch(
            "/users/@me",
            &member,
            json!({
                "widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": image["id"]}]},
                "nameplate": "aurora",
                "display_name_styles": style,
                "profile_frame": "vines",
            }),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(claimed(&app, &image).await, Some(true));
    // the owner shares a guild with the member, so the USER_UPDATE for the anonymised account reaches this session
    let (_, me) = app.get("/users/@me", &owner).await;
    let owner_id: i64 = user_id(&me).parse().expect("owner id");
    let (link, mut receiver) = vokko_server::hub::link(64);
    app.state.hub.open_session(owner_id, "profile-delete-watch".into(), Vec::new(), link, json!({}));
    let (status, _) = app.post("/users/@me/delete", &member, json!({"password": "correct horse battery"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(claimed(&app, &image).await, None, "the upload went with the account");
    let (_, gone) = app.get(&format!("/users/{}", user_id(&updated)), &owner).await;
    assert!(is_null(&gone, "widgets"), "{gone}");
    assert!(is_null(&gone, "nameplate") && is_null(&gone, "display_name_styles") && is_null(&gone, "profile_frame"), "{gone}");
    let member_id: i64 = user_id(&updated).parse().expect("member id");
    let row: (Option<String>, Option<String>, Option<String>, Option<Vec<i32>>) =
        sqlx::query_as("SELECT nameplate, name_font, name_effect, name_colors FROM users WHERE id = $1")
            .bind(member_id)
            .fetch_one(&app.state.db)
            .await
            .expect("row");
    assert_eq!(row, (None, None, None, None), "the cosmetics went with the account");
    let mut seen = 0;
    while let Ok(frame) = receiver.queue.try_recv() {
        let frame: Value = serde_json::from_str(&frame).expect("frame");
        if frame["t"] == "USER_UPDATE" && frame["d"]["id"] == updated["id"] {
            seen += 1;
            assert!(is_null(&frame["d"], "nameplate") && is_null(&frame["d"], "display_name_styles"), "{frame}");
        }
    }
    assert!(seen > 0, "the anonymised account was broadcast");
}

#[tokio::test]
async fn sticker_images_are_not_profile_images() {
    let (app, owner, _, channel, _) = setup().await;
    let image = upload(&app, &owner, &channel, "sticker.png", "image/png", &png()).await;
    let id: i64 = image["id"].as_str().expect("id").parse().expect("id");
    sqlx::query("UPDATE attachments SET sticker_asset = TRUE, claimed_at = now() WHERE id = $1").bind(id).execute(&app.state.db).await.expect("mark");
    for body in [
        json!({"avatar_attachment_id": image["id"]}),
        json!({"banner_attachment_id": image["id"]}),
        json!({"widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": image["id"]}]}}),
    ] {
        let (status, error) = app.patch("/users/@me", &owner, body.clone()).await;
        assert_eq!((status, error["code"].clone()), (StatusCode::BAD_REQUEST, json!(50035)), "{body}: {error}");
    }
}

#[tokio::test]
async fn deleting_the_account_keeps_an_avatar_a_concurrent_request_just_made_a_guild_icon() {
    let (app, _, member, channel, guild) = setup().await;
    let avatar = upload(&app, &member, &channel, "avatar.png", "image/png", &png()).await;
    let (status, updated) = app.patch("/users/@me", &member, json!({"avatar_attachment_id": avatar["id"]})).await;
    assert_eq!(status, 200, "{updated}");
    let avatar_id: i64 = avatar["id"].as_str().expect("id").parse().expect("id");
    let guild_id: i64 = guild.parse().expect("guild id");
    // what update_guild does for an icon: claim the row (locking it) and write the path in one transaction, here held open
    let mut claim = app.state.db.begin().await.expect("begin");
    sqlx::query("UPDATE attachments SET claimed_at = now() WHERE id = $1").bind(avatar_id).execute(&mut *claim).await.expect("claim");
    sqlx::query("UPDATE guilds SET icon_path = (SELECT avatar_path FROM users WHERE avatar_path LIKE $1 || '/%') WHERE id = $2")
        .bind(avatar_id.to_string())
        .bind(guild_id)
        .execute(&mut *claim)
        .await
        .expect("icon");
    let router = app.router.clone();
    let delete = tokio::spawn(async move {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/users/@me/delete")
            .header("authorization", member)
            .header("content-type", "application/json")
            .body(Body::from(json!({"password": "correct horse battery"}).to_string()))
            .expect("request");
        router.oneshot(request).await.expect("response").status()
    });
    // wait until the delete is blocked on the claimed row, then let the claim commit
    let mut waited = 0;
    loop {
        let (blocked,): (i64,) = sqlx::query_as("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")
            .fetch_one(&app.state.db)
            .await
            .expect("activity");
        if blocked > 0 {
            break;
        }
        waited += 1;
        assert!(waited < 200, "delete_account never blocked on the claimed upload");
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    claim.commit().await.expect("commit");
    assert_eq!(delete.await.expect("join"), StatusCode::NO_CONTENT);
    assert_eq!(claimed(&app, &avatar).await, Some(true), "the guild icon keeps its upload");
}

#[tokio::test]
async fn a_widget_image_that_is_also_a_webhook_avatar_stays_claimed_when_the_widget_goes() {
    let (app, owner, _, channel, _) = setup().await;
    let image = upload(&app, &owner, &channel, "tile.png", "image/png", &png()).await;
    let (status, updated) =
        app.patch("/users/@me", &owner, json!({"widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": image["id"]}]}})).await;
    assert_eq!(status, 200, "{updated}");
    let (status, hook) = app.post(&format!("/channels/{channel}/webhooks"), &owner, json!({"name": "Alerts", "avatar_attachment_id": image["id"]})).await;
    assert_eq!(status, 200, "{hook}");
    let (status, cleared) = app.patch("/users/@me", &owner, json!({"widgets": null})).await;
    assert_eq!(status, 200, "{cleared}");
    assert_eq!(claimed(&app, &image).await, Some(true), "the webhook still shows it");
    assert_eq!(vokko_server::media::cleanup_pending(&app.state, std::time::Duration::ZERO).await, 0);
    assert_eq!(claimed(&app, &image).await, Some(true));
}

#[tokio::test]
async fn guild_banner_set_replace_clear_and_rules() {
    let (app, owner, member, channel, guild) = setup().await;
    let (_, fresh) = app.get(&format!("/guilds/{guild}"), &owner).await;
    assert!(is_null(&fresh, "banner"), "{fresh}");

    let first = upload(&app, &owner, &channel, "one.png", "image/png", &png()).await;
    let (status, set) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"banner_attachment_id": first["id"]})).await;
    assert_eq!(status, 200, "{set}");
    assert_eq!(set["banner"], first["url"]);
    assert_eq!(status_of(&app, set["banner"].as_str().expect("banner")).await, 200);
    let (_, seen) = app.get(&format!("/guilds/{guild}"), &member).await;
    assert_eq!(seen["banner"], first["url"]);
    let (_, mine) = app.get("/users/@me/guilds", &member).await;
    assert_eq!(mine[0]["banner"], first["url"]);

    // replacing releases the old upload
    let second = upload(&app, &owner, &channel, "two.png", "image/png", &png()).await;
    let (status, replaced) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"banner_attachment_id": second["id"]})).await;
    assert_eq!(status, 200, "{replaced}");
    assert_eq!(replaced["banner"], second["url"]);
    assert_eq!(status_of(&app, first["url"].as_str().expect("url")).await, 404);
    assert_eq!(status_of(&app, second["url"].as_str().expect("url")).await, 200);

    // absent key leaves it alone; null clears and releases
    let (_, renamed) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"name": "Renamed"})).await;
    assert_eq!(renamed["banner"], second["url"]);
    let (status, cleared) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"banner_attachment_id": null})).await;
    assert_eq!(status, 200, "{cleared}");
    assert!(is_null(&cleared, "banner"), "{cleared}");
    assert_eq!(status_of(&app, second["url"].as_str().expect("url")).await, 404);

    // sticker assets, non-images and oversized files are refused; a rejected edit changes nothing
    let sticker = upload(&app, &owner, &channel, "s.png", "image/png", &png()).await;
    let numeric: i64 = sticker["id"].as_str().expect("id").parse().expect("id");
    sqlx::query("UPDATE attachments SET sticker_asset = TRUE, claimed_at = now() WHERE id = $1").bind(numeric).execute(&app.state.db).await.expect("mark");
    let text = upload(&app, &owner, &channel, "notes.txt", "text/plain", b"not an image").await;
    let huge = upload(&app, &owner, &channel, "huge.png", "image/png", &png()).await;
    let huge_id: i64 = huge["id"].as_str().expect("id").parse().expect("id");
    sqlx::query("UPDATE attachments SET size = $2 WHERE id = $1").bind(huge_id).bind(11_i64 * 1024 * 1024).execute(&app.state.db).await.expect("size");
    for bad in [&sticker, &text, &huge] {
        let (status, error) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"banner_attachment_id": bad["id"]})).await;
        assert_eq!((status, &error["code"]), (StatusCode::BAD_REQUEST, &json!(50035)), "{error}");
    }
    let (_, after) = app.get(&format!("/guilds/{guild}"), &owner).await;
    assert!(is_null(&after, "banner"), "{after}");

    // a rejected edit claims nothing: the upload stays pending and a later valid edit can still take it
    let pending = upload(&app, &owner, &channel, "p.png", "image/png", &png()).await;
    let pending_id: i64 = pending["id"].as_str().expect("id").parse().expect("id");
    let (status, error) = app
        .patch(
            &format!("/guilds/{guild}"),
            &owner,
            json!({"banner_attachment_id": pending["id"], "icon_attachment_id": pending["id"], "system_channel_id": "999999"}),
        )
        .await;
    assert_eq!((status, &error["code"]), (StatusCode::BAD_REQUEST, &json!(50035)), "{error}");
    let (claimed,): (bool,) =
        sqlx::query_as("SELECT claimed_at IS NOT NULL FROM attachments WHERE id = $1").bind(pending_id).fetch_one(&app.state.db).await.expect("row");
    assert!(!claimed, "a rejected PATCH leaves the upload unclaimed");
    let (status, _) = app.patch(&format!("/guilds/{guild}"), &owner, json!({"banner_attachment_id": pending["id"]})).await;
    assert_eq!(status, 200);

    // only managers may set it
    let mine = upload(&app, &member, &channel, "m.png", "image/png", &png()).await;
    let (status, error) = app.patch(&format!("/guilds/{guild}"), &member, json!({"banner_attachment_id": mine["id"]})).await;
    assert_eq!((status, &error["code"]), (StatusCode::FORBIDDEN, &json!(50013)));
}

/// A profile edit locks only the uploads it names: one that names none doesn't wait on an unsent upload another transaction holds
/// (a message send, guild edit or claim in flight), so the two can never deadlock over it.
#[tokio::test]
async fn profile_edit_without_images_does_not_wait_on_a_locked_upload() {
    let (app, owner, _, channel, _) = setup().await;
    let pending = upload(&app, &owner, &channel, "pending.png", "image/png", &png()).await;
    let pending_id: i64 = pending["id"].as_str().expect("id").parse().expect("id");
    let mut holder = app.state.db.begin().await.expect("begin");
    sqlx::query("SELECT id FROM attachments WHERE id = $1 FOR UPDATE").bind(pending_id).execute(&mut *holder).await.expect("lock");

    let edit = app.patch("/users/@me", &owner, json!({"bio": "not blocked", "pronouns": "they/them"}));
    let (status, me) = tokio::time::timeout(common::WAIT, edit).await.expect("the edit waited on a locked upload it never named");
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["bio"], "not blocked");

    // naming the held upload does wait for it (the claim and the write share a transaction), so the check above can tell the two apart
    let claim = app.patch("/users/@me", &owner, json!({"avatar_attachment_id": pending["id"]}));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(500), claim).await.is_err(), "claiming a locked upload did not wait for it");
    holder.rollback().await.expect("rollback");
    let (status, me) = app.patch("/users/@me", &owner, json!({"avatar_attachment_id": pending["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{me}");
}

/// Naming someone else's upload locks nothing: the request neither waits on it nor holds it, it is just rejected.
#[tokio::test]
async fn naming_another_users_upload_does_not_lock_it() {
    let (app, owner, member, channel, guild) = setup().await;
    let theirs = upload(&app, &owner, &channel, "theirs.png", "image/png", &png()).await;
    let theirs_id: i64 = theirs["id"].as_str().expect("id").parse().expect("id");
    let mut holder = app.state.db.begin().await.expect("begin");
    sqlx::query("SELECT id FROM attachments WHERE id = $1 FOR UPDATE").bind(theirs_id).execute(&mut *holder).await.expect("lock");
    let wait = common::WAIT;

    let profile = app.patch("/users/@me", &member, json!({"avatar_attachment_id": theirs["id"], "banner_attachment_id": theirs["id"]}));
    let (status, error) = tokio::time::timeout(wait, profile).await.expect("the profile edit waited on another user's upload");
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    let path = format!("/guilds/{guild}/members/@me");
    let server_profile = app.patch(&path, &member, json!({"avatar_attachment_id": theirs["id"]}));
    let (status, error) = tokio::time::timeout(wait, server_profile).await.expect("the server profile edit waited on another user's upload");
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    holder.rollback().await.expect("rollback");
}
