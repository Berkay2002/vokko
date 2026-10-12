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
