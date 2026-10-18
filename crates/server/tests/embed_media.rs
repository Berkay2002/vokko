#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{PageServer, TINY_PNG, TestApp};
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_server::embed_media::proxy_url;

/// GET of an absolute proxy URL against the in-process router: status, content type and body bytes.
async fn fetch(app: &TestApp, url: &str) -> (StatusCode, Option<String>, Vec<u8>, axum::http::HeaderMap) {
    let path = url.strip_prefix(&app.state.config.public_url).expect("same origin");
    let response = app.router.clone().oneshot(Request::get(path).body(Body::empty()).expect("request")).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let content_type = headers.get("content-type").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body").to_vec();
    (status, content_type, bytes, headers)
}

async fn private_ok() -> TestApp {
    TestApp::with_config(|config| config.unfurl.allow_private = true).await
}

#[tokio::test]
async fn link_preview_thumbnails_come_back_through_the_signed_proxy() {
    let app = TestApp::with_config(|config| {
        config.unfurl.enabled = true;
        config.unfurl.allow_private = true;
    })
    .await;
    let pages = PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    app.post(&format!("/channels/{channel}/messages"), &token, json!({"content": pages.url("/page")})).await;
    let mut thumbnail = Value::Null;
    let deadline = tokio::time::Instant::now() + common::WAIT;
    while tokio::time::Instant::now() < deadline {
        let (_, list) = app.get(&format!("/channels/{channel}/messages?limit=5"), &token).await;
        thumbnail = list[0]["embeds"][0]["thumbnail"].clone();
        if !thumbnail.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(thumbnail["url"], pages.url("/card.png"));
    let proxied = thumbnail["proxy_url"].as_str().expect("proxy_url is filled when the message is read");
    assert!(proxied.starts_with("http://test.local/api/v1/embed-media/"), "{proxied}");

    let (status, content_type, bytes, headers) = fetch(&app, proxied).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("image/png"));
    assert_eq!(bytes, TINY_PNG);
    assert_eq!(headers["cache-control"], "public, max-age=86400");
    assert_eq!(headers["x-content-type-options"], "nosniff");
}

#[tokio::test]
async fn old_embeds_without_proxy_url_get_one_and_stored_values_are_not_trusted() {
    let app = private_ok().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let (_, sent) = app.post(&format!("/channels/{channel}/messages"), &token, json!({"content": "old"})).await;
    let id: i64 = sent["id"].as_str().expect("id").parse().expect("id");
    // as stored before this change, plus a forged proxy_url on the image
    let embeds = json!([{"type": "link", "thumbnail": {"url": "https://example.com/a.png"}, "image": {"url": "https://example.com/b.png", "proxy_url": "https://evil.example/x"}}]);
    sqlx::query("UPDATE messages SET embeds = $2::jsonb WHERE id = $1").bind(id).bind(embeds.to_string()).execute(&app.state.db).await.expect("update");
    let (_, list) = app.get(&format!("/channels/{channel}/messages?limit=1"), &token).await;
    let embed = &list[0]["embeds"][0];
    assert_eq!(embed["thumbnail"]["proxy_url"], proxy_url(&app.state, "https://example.com/a.png").expect("signed"));
    assert_eq!(embed["image"]["proxy_url"], proxy_url(&app.state, "https://example.com/b.png").expect("signed"));
}

#[tokio::test]
async fn author_and_footer_icons_get_a_proxy_icon_url() {
    let app = private_ok().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let (_, sent) = app.post(&format!("/channels/{channel}/messages"), &token, json!({"content": "icons"})).await;
    let id: i64 = sent["id"].as_str().expect("id").parse().expect("id");
    let embeds = json!([{"type": "rich",
        "author": {"name": "a", "icon_url": "https://example.com/a.png", "proxy_icon_url": "https://evil.example/x"},
        "footer": {"text": "f", "icon_url": "https://example.com/f.png"}},
        {"type": "rich", "footer": {"text": "no icon", "proxy_icon_url": "https://evil.example/y"}}]);
    sqlx::query("UPDATE messages SET embeds = $2::jsonb WHERE id = $1").bind(id).bind(embeds.to_string()).execute(&app.state.db).await.expect("update");
    let (_, list) = app.get(&format!("/channels/{channel}/messages?limit=1"), &token).await;
    let got = &list[0]["embeds"];
    assert_eq!(got[0]["author"]["proxy_icon_url"], proxy_url(&app.state, "https://example.com/a.png").expect("signed"));
    assert_eq!(got[0]["footer"]["proxy_icon_url"], proxy_url(&app.state, "https://example.com/f.png").expect("signed"));
    assert!(got[1]["footer"].get("proxy_icon_url").is_none(), "a stored value without an icon is dropped");
}

#[tokio::test]
async fn a_fetched_image_is_served_from_the_disk_cache_afterwards() {
    let app = private_ok().await;
    let pages = PageServer::start().await;
    let url = proxy_url(&app.state, &pages.url("/card.png")).expect("signed");
    for _ in 0..3 {
        let (status, content_type, bytes, _) = fetch(&app, &url).await;
        assert_eq!((status, content_type.as_deref(), bytes.as_slice()), (StatusCode::OK, Some("image/png"), &TINY_PNG[..]));
    }
    assert_eq!(pages.count("/card.png"), 1, "fetched once");
    assert_eq!(std::fs::read_dir(app.data_dir.join("embed-media")).expect("cache dir").count(), 1);
    // failures are not cached
    let missing = proxy_url(&app.state, &pages.url("/missing")).expect("signed");
    for _ in 0..2 {
        assert_eq!(fetch(&app, &missing).await.0, StatusCode::BAD_GATEWAY);
    }
    assert_eq!(pages.count("/missing"), 2);
}

#[tokio::test]
async fn bad_or_missing_signatures_are_404_and_never_fetch() {
    let app = private_ok().await;
    let pages = PageServer::start().await;
    let good = proxy_url(&app.state, &pages.url("/card.png")).expect("signed");
    let (sig, target) = good.rsplit_once('/').map(|(rest, target)| (rest.rsplit_once('/').expect("sig").1, target)).expect("parts");
    let other = proxy_url(&app.state, &pages.url("/icon.svg")).expect("signed");
    let other_target = other.rsplit('/').next().expect("target");
    for path in [
        format!("/api/v1/embed-media/{sig}/{other_target}"),       // a signature for another URL
        format!("/api/v1/embed-media/AAAA{}/{target}", &sig[4..]), // a damaged signature
        format!("/api/v1/embed-media/x/{target}"),                 // not a signature at all
        format!("/api/v1/embed-media/{target}"),                   // none
    ] {
        let (status, ..) = fetch(&app, &format!("http://test.local{path}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(pages.total(), 0);
    assert!(proxy_url(&app.state, "javascript:alert(1)").is_none() && proxy_url(&app.state, "https://u:p@example.com/a.png").is_none());
}

#[tokio::test]
async fn private_addresses_are_refused_even_when_signed() {
    let app = TestApp::new().await; // allow_private off: the production guard
    let pages = PageServer::start().await;
    for url in [pages.url("/card.png"), "http://localhost/a.png".to_owned(), "http://169.254.169.254/latest".to_owned()] {
        let (status, ..) = fetch(&app, &proxy_url(&app.state, &url).expect("signed")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{url}");
    }
    assert_eq!(pages.total(), 0, "nothing reached the loopback server");
}

#[tokio::test]
async fn only_raster_images_within_the_cap_are_served() {
    let app = private_ok().await;
    let pages = PageServer::start().await;
    for path in ["/text", "/fake.png", "/icon.svg", "/huge.png", "/page", "/missing", "/loop"] {
        let (status, ..) = fetch(&app, &proxy_url(&app.state, &pages.url(path)).expect("signed")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{path}");
    }
    // redirects are followed (and checked again)
    let (status, _, bytes, _) = fetch(&app, &proxy_url(&app.state, &pages.url("/to-card")).expect("signed")).await;
    assert_eq!((status, bytes), (StatusCode::OK, TINY_PNG.to_vec()));
}

/// The reported page end to end, with the production guard: unfurl, then load its og:image through the proxy route.
/// Run with `cargo test -p vokko-server --test embed_media -- --ignored`.
#[tokio::test]
#[ignore = "needs internet access"]
async fn a_real_link_preview_image_loads_through_the_proxy() {
    let app = TestApp::new().await;
    let page = "https://www.blocket.se/mobility/item/27417430?ci=2".parse().expect("url");
    let mut embed = app.state.unfurler.embed(page).await.expect("the page unfurls");
    vokko_server::embed_media::fill(&app.state, std::slice::from_mut(&mut embed));
    let thumbnail = embed.thumbnail.or(embed.image).expect("the page has an og:image");
    let (status, content_type, bytes, _) = fetch(&app, thumbnail.proxy_url.as_deref().expect("proxy_url")).await;
    assert_eq!(status, StatusCode::OK, "{}", thumbnail.url);
    assert!(content_type.is_some_and(|value| value.starts_with("image/")) && bytes.len() > 1000);
}
