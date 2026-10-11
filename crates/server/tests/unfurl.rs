mod common;

use std::time::{Duration, Instant};

use axum::http::StatusCode;
use common::{PageServer, TestApp};
use serde_json::{Value, json};
use vokko_server::unfurl::{UnfurlConfig, Unfurler};

async fn app_with_unfurl() -> TestApp {
    TestApp::with_config(|config| config.unfurl.allow_private = true).await
}

async fn message(app: &TestApp, token: &str, channel: &str, id: &str) -> Value {
    let (_, list) = app.get(&format!("/channels/{channel}/messages?limit=50"), token).await;
    list.as_array().expect("messages").iter().find(|message| message["id"] == id).expect("message in channel").clone()
}

/// Polls until the message has exactly `want` embeds (the unfurl runs in the background).
async fn wait_for_embeds(app: &TestApp, token: &str, channel: &str, id: &str, want: usize) -> Vec<Value> {
    for _ in 0..60 {
        let embeds = message(app, token, channel, id).await["embeds"].as_array().expect("embeds").clone();
        if embeds.len() == want {
            return embeds;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("message never reached {want} embeds");
}

async fn send(app: &TestApp, token: &str, channel: &str, content: &str) -> Value {
    let (status, message) = app.post(&format!("/channels/{channel}/messages"), token, json!({"content": content})).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    message
}

#[tokio::test]
async fn open_graph_links_arrive_as_embeds_and_code_or_wrapped_links_do_not() {
    let app = app_with_unfurl().await;
    let pages = PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;

    let content = format!("read {} but not `{}` nor <{}>", pages.url("/page"), pages.url("/text"), pages.url("/redirect"));
    let sent = send(&app, &token, &channel, &content).await;
    assert_eq!(sent["embeds"], json!([]), "the create response never waits for the fetch");
    let id = sent["id"].as_str().expect("id").to_owned();

    let embeds = wait_for_embeds(&app, &token, &channel, &id, 1).await;
    let embed = &embeds[0];
    assert_eq!(embed["type"], "link");
    assert_eq!(embed["title"], "Vokko & friends");
    assert_eq!(embed["description"], "An open source chat app");
    assert_eq!(embed["url"], pages.url("/page"));
    assert_eq!(embed["thumbnail"]["url"], pages.url("/card.png"), "relative image URLs are made absolute");
    assert_eq!(embed["provider"]["name"], "Vokko");
    assert_eq!(embed["color"], 0x5865f2);
    assert!(embed.get("author").is_none() && embed.get("footer").is_none(), "absent members are omitted");
    assert_eq!(pages.count("/page"), 1);
    assert_eq!(pages.count("/text") + pages.count("/redirect"), 0, "code and <url> are never fetched");
}

#[tokio::test]
async fn redirects_images_and_unusable_pages() {
    let app = app_with_unfurl().await;
    let pages = PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;

    let content = [pages.url("/image.png"), pages.url("/missing"), pages.url("/redirect"), pages.url("/text"), pages.url("/late")].join(" ");
    let sent = send(&app, &token, &channel, &content).await;
    let id = sent["id"].as_str().expect("id").to_owned();
    let embeds = wait_for_embeds(&app, &token, &channel, &id, 2).await;
    // in the order of the URLs in the message
    assert_eq!(embeds[0]["type"], "image");
    assert_eq!(embeds[0]["url"], pages.url("/image.png"));
    assert_eq!(embeds[0]["thumbnail"]["url"], pages.url("/image.png"));
    assert_eq!(embeds[1]["type"], "link");
    assert_eq!(embeds[1]["url"], pages.url("/redirect"), "the embed keeps the URL from the message");
    assert_eq!(embeds[1]["title"], "Vokko & friends");
    // the late meta tags are beyond the 1 MiB cap, the rest is not a page
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(message(&app, &token, &channel, &id).await["embeds"].as_array().expect("embeds").len(), 2);
}

#[tokio::test]
async fn at_most_five_urls_per_message() {
    let app = app_with_unfurl().await;
    let pages = PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let content = (0..8).map(|n| pages.url(&format!("/page?n={n}"))).collect::<Vec<_>>().join(" ");
    // `/page?n=…` is a 404 on the fixture server, so count requests instead of embeds.
    send(&app, &token, &channel, &content).await;
    for _ in 0..50 {
        if pages.total() >= 5 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(pages.total(), 5);
}

#[tokio::test]
async fn editing_keeps_suppresses_and_restores_embeds() {
    let app = app_with_unfurl().await;
    let pages = PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let url = pages.url("/page");
    let sent = send(&app, &token, &channel, &format!("first {url}")).await;
    let id = sent["id"].as_str().expect("id").to_owned();
    wait_for_embeds(&app, &token, &channel, &id, 1).await;
    let path = format!("/channels/{channel}/messages/{id}");

    // a content edit that keeps the URL keeps the embed and does not fetch again
    let (status, edited) = app.patch(&path, &token, json!({"content": format!("second {url} and more")})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["embeds"].as_array().expect("embeds").len(), 1);
    assert!(edited["edited_timestamp"].is_string());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(pages.count("/page"), 1);

    // SUPPRESS_EMBEDS clears them without marking the message edited again
    let before = edited["edited_timestamp"].clone();
    let (_, suppressed) = app.patch(&path, &token, json!({"content": format!("second {url} and more"), "flags": 4})).await;
    assert_eq!(suppressed["embeds"], json!([]));
    assert_eq!(suppressed["edited_timestamp"], before);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(message(&app, &token, &channel, &id).await["embeds"], json!([]), "stays suppressed");

    // clearing the flag fetches again
    let (_, restored) = app.patch(&path, &token, json!({"content": format!("second {url} and more"), "flags": 0})).await;
    assert_eq!(restored["embeds"], json!([]));
    wait_for_embeds(&app, &token, &channel, &id, 1).await;
    assert_eq!(pages.count("/page"), 2);

    // removing the URL removes the embed in the same response
    let (_, plain) = app.patch(&path, &token, json!({"content": "no links now"})).await;
    assert_eq!(plain["embeds"], json!([]));
    assert_eq!(message(&app, &token, &channel, &id).await["embeds"], json!([]));

    // only the author may edit
    let (other, _) = app.register("alice").await;
    assert_eq!(app.patch(&path, &other, json!({"content": "x", "flags": 4})).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn private_hosts_are_never_fetched_unless_allowed() {
    let pages = PageServer::start().await;
    let strict = Unfurler::new(UnfurlConfig::default());
    let url = reqwest_url(&pages.url("/page"));
    assert!(strict.embed(url.clone()).await.is_none());
    assert!(strict.embed(reqwest_url(&format!("http://localhost:{}/page", pages.address.rsplit(':').next().unwrap_or("0")))).await.is_none());
    assert_eq!(pages.total(), 0, "the guard stops the request before it leaves");
    let lenient = Unfurler::new(UnfurlConfig { enabled: true, allow_private: true });
    assert!(lenient.embed(url).await.is_some());
    assert_eq!(pages.count("/page"), 1);
}

#[tokio::test]
async fn slow_pages_time_out_and_redirect_loops_end() {
    let pages = PageServer::start().await;
    let unfurler = Unfurler::new(UnfurlConfig { enabled: true, allow_private: true });
    let started = Instant::now();
    assert!(unfurler.embed(reqwest_url(&pages.url("/slow"))).await.is_none());
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_secs(4) && elapsed < Duration::from_secs(7), "gave up after about 5 s, took {elapsed:?}");
    assert!(unfurler.embed(reqwest_url(&pages.url("/loop"))).await.is_none());
    assert!(pages.count("/loop") <= 4, "at most 3 redirects are followed");
}

#[tokio::test]
async fn unfurling_can_be_switched_off() {
    let app = TestApp::with_config(|config| {
        config.unfurl.allow_private = true;
        config.unfurl.enabled = false;
    })
    .await;
    let pages = PageServer::start().await;
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let sent = send(&app, &token, &channel, &pages.url("/page")).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(message(&app, &token, &channel, sent["id"].as_str().expect("id")).await["embeds"], json!([]));
    assert_eq!(pages.total(), 0);
}

fn reqwest_url(text: &str) -> reqwest::Url {
    reqwest::Url::parse(text).expect("url")
}
