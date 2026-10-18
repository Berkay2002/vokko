#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

// Every test freezes the limiter's clock: buckets drain but never refill, so a burst sent slowly (a busy machine) is limited
// at exactly its size.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::TestApp;
use serde_json::{Value, json};
use tower::ServiceExt;
use vokko_server::config::RateLimit;

fn lenient_global(route_burst: f64) -> RateLimit {
    RateLimit { route_burst, route_per_second: 0.5, global_burst: 1000.0, global_per_second: 1000.0, ..RateLimit::default() }
}

#[tokio::test]
async fn bursts_are_answered_with_429_and_retry_after() {
    let app = TestApp::with_config(|config| config.rate_limit = Some(lenient_global(3.0))).await;
    app.state.limiter.freeze_clock();
    let (token, _) = app.register("sam").await;
    for _ in 0..3 {
        assert_eq!(app.get("/users/@me", &token).await.0, 200);
    }
    let request = Request::builder().uri("/api/v1/users/@me").header("authorization", &token).body(Body::empty()).expect("request");
    let response = app.router.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), 429);
    let retry_header: u64 = response.headers()["retry-after"].to_str().expect("header").parse().expect("integer seconds");
    assert!(retry_header >= 1);
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body")).expect("json");
    assert_eq!(body["global"], false);
    assert!(body["retry_after"].as_f64().expect("seconds") > 0.0);
    assert!(body["message"].is_string());
    // other routes keep their own bucket
    let (status, _) = app.post("/guilds", &token, json!({"name": "still fine"})).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn limits_follow_the_user_not_the_header_text() {
    let app = TestApp::with_config(|config| config.rate_limit = Some(lenient_global(3.0))).await;
    app.state.limiter.freeze_clock();
    let (first, user) = app.register("sam").await;
    let (status, login) = app.send(Method::POST, "/auth/login", None, Some(json!({"login": user["username"], "password": "correct horse battery"}))).await;
    assert_eq!(status, StatusCode::OK);
    let second = login["token"].as_str().expect("token").to_owned();
    assert_ne!(first, second);

    // two tokens of one user share the user's buckets
    assert_eq!(app.get("/users/@me", &first).await.0, 200);
    assert_eq!(app.get("/users/@me", &second).await.0, 200);
    assert_eq!(app.get("/users/@me", &first).await.0, 200);
    assert_eq!(app.get("/users/@me", &second).await.0, 429);
    // another user is unaffected
    let (other, _) = app.register("alice").await;
    assert_eq!(app.get("/users/@me", &other).await.0, 200);
}

#[tokio::test]
async fn invented_tokens_share_the_clients_bucket() {
    let app = TestApp::with_config(|config| config.rate_limit = Some(lenient_global(3.0))).await;
    app.state.limiter.freeze_clock();
    // every request carries a different bogus Authorization value; none of them may get a fresh bucket
    let mut statuses = Vec::new();
    for n in 0..6 {
        statuses.push(app.get("/users/@me", &format!("bogus-token-{n}")).await.0);
    }
    assert_eq!(statuses[..3], [StatusCode::UNAUTHORIZED; 3]);
    assert_eq!(statuses[3..], [StatusCode::TOO_MANY_REQUESTS; 3]);
}

#[tokio::test]
async fn auth_routes_are_limited_per_client_address() {
    let app = TestApp::with_config(|config| {
        config.rate_limit = Some(RateLimit { auth_burst: 3.0, auth_per_second: 0.1, ..lenient_global(30.0) });
    })
    .await;
    app.state.limiter.freeze_clock();
    let attempt = |n: u32| {
        let app = &app;
        async move { app.send(Method::POST, "/auth/login", None, Some(json!({"login": format!("nobody{n}"), "password": "whatever you like"}))).await }
    };
    for n in 0..3 {
        assert_eq!(attempt(n).await.0, StatusCode::BAD_REQUEST, "wrong credentials are answered normally");
    }
    let (status, body) = attempt(3).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["global"], false);
    // registering shares the address but has its own route bucket
    let register = json!({"email": "a@example.test", "username": "newbie", "password": "correct horse battery", "date_of_birth": "1990-01-01"});
    assert_eq!(app.send(Method::POST, "/auth/register", None, Some(register)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn gif_routes_share_one_bucket_per_user_to_protect_the_provider_quota() {
    // default limits: 30 per route and 10 per second per route; the GIF bucket is 10 with 2 per second, shared by search/trending/categories
    let app = TestApp::with_config(|config| config.rate_limit = Some(RateLimit::default())).await;
    app.state.limiter.freeze_clock();
    let (token, _) = app.register("sam").await;
    let (other, _) = app.register("alice").await;
    let mut limited_at = None;
    for request in 0..14 {
        let path = match request % 3 {
            0 => "/gifs/trending",
            1 => "/gifs/categories",
            _ => "/gifs/search?q=cat",
        };
        if app.get(path, &token).await.0 == 429 {
            limited_at = Some(request);
            break;
        }
    }
    let limited_at = limited_at.expect("the shared GIF bucket ran dry");
    assert_eq!(limited_at, 10, "a burst of 10");
    assert_eq!(app.get("/gifs/trending", &other).await.0, 200, "another user has their own bucket");
    assert_eq!(app.get("/users/@me", &token).await.0, 200, "other routes are unaffected");
}

#[tokio::test]
async fn signed_out_invite_previews_have_a_small_bucket_per_address() {
    // default limits: 30 per route; a signed-out preview gets 10 and then one every 5 seconds
    let app = TestApp::with_config(|config| config.rate_limit = Some(RateLimit::default())).await;
    app.state.limiter.freeze_clock();
    let (token, _) = app.register("sam").await;
    let (_, channel) = app.guild_with_channel(&token).await;
    let (_, invite) = app.post(&format!("/channels/{channel}/invites"), &token, json!({})).await;
    let path = format!("/invites/{}", invite["code"].as_str().expect("code"));
    for _ in 0..10 {
        assert_eq!(app.send(Method::GET, &path, None, None).await.0, StatusCode::OK);
    }
    let (status, body) = app.send(Method::GET, &path, None, None).await;
    assert_eq!((status, body["global"].clone()), (StatusCode::TOO_MANY_REQUESTS, json!(false)));
    // Signed-in previews keep the normal route bucket.
    for _ in 0..15 {
        assert_eq!(app.get(&path, &token).await.0, StatusCode::OK);
    }
}

#[tokio::test]
async fn ipv6_clients_are_limited_per_64_and_per_48() {
    let app = TestApp::with_config(|config| {
        config.trust_proxy = true;
        config.rate_limit = Some(RateLimit { auth_burst: 1.0, auth_per_second: 0.01, ..lenient_global(30.0) });
    })
    .await;
    app.state.limiter.freeze_clock();
    let login = |from: String| {
        let app = &app;
        async move {
            let body = json!({"login": "nobody", "password": "whatever you like"}).to_string();
            let request = Request::builder()
                .method(Method::POST)
                .uri("/api/v1/auth/login")
                .header("content-type", "application/json")
                .header("x-forwarded-for", from)
                .body(Body::from(body))
                .expect("request");
            app.router.clone().oneshot(request).await.expect("response").status()
        }
    };
    assert_eq!(login("2001:db8:1:1::1".to_owned()).await, StatusCode::BAD_REQUEST);
    assert_eq!(login("2001:db8:1:1:ffff::2".to_owned()).await, StatusCode::TOO_MANY_REQUESTS, "same /64");
    // IPv4 and its IPv4-mapped IPv6 form are one client
    assert_eq!(login("203.0.113.9".to_owned()).await, StatusCode::BAD_REQUEST);
    assert_eq!(login("::ffff:203.0.113.9".to_owned()).await, StatusCode::TOO_MANY_REQUESTS);
    // other /64s of the same /48 get their own bucket, up to 16 times the budget for the whole /48
    for net in 2..17 {
        assert_eq!(login(format!("2001:db8:1:{net:x}::1")).await, StatusCode::BAD_REQUEST, "/64 number {net}");
    }
    assert_eq!(login("2001:db8:1:99::1".to_owned()).await, StatusCode::TOO_MANY_REQUESTS, "the /48 is used up");
    assert_eq!(login("2001:db8:2::1".to_owned()).await, StatusCode::BAD_REQUEST, "another /48");
}

#[tokio::test]
async fn avatar_and_banner_gif_imports_share_one_small_bucket_per_user() {
    // default limits: 30 per route; importing a GIF as an avatar or banner gets 3, then one every 5 seconds, across both routes
    let app = TestApp::with_config(|config| config.rate_limit = Some(RateLimit::default())).await;
    app.state.limiter.freeze_clock();
    let (token, _) = app.register("sam").await;
    let (other, _) = app.register("alice").await;
    let body = json!({"channel_id": "1", "url": "https://evil.example/a.gif"});
    let mut limited_at = None;
    for request in 0..8 {
        let path = if request % 2 == 0 { "/users/@me/avatars/gif" } else { "/users/@me/banners/gif" };
        if app.post(path, &token, body.clone()).await.0 == 429 {
            limited_at = Some(request);
            break;
        }
    }
    let limited_at = limited_at.expect("the shared import bucket ran dry");
    assert_eq!(limited_at, 3, "a burst of 3");
    assert_ne!(app.post("/users/@me/banners/gif", &other, body).await.0, 429, "another user has their own bucket");
}

#[tokio::test]
async fn app_icon_uploads_have_a_small_bucket_and_downloads_none() {
    // default limits: 30 per route; an icon upload decodes an image, so it gets 10, then one every 2 seconds
    let app = TestApp::with_config(|config| config.rate_limit = Some(RateLimit::default())).await;
    app.state.limiter.freeze_clock();
    let (token, _) = app.register("sam").await;
    let (other, _) = app.register("alice").await;
    let mut limited_at = None;
    for request in 0..14 {
        if app.post_bytes("/app-icons", Some(&token), "image/png", Vec::new()).await.0 == 429 {
            limited_at = Some(request);
            break;
        }
    }
    let limited_at = limited_at.expect("the upload bucket ran dry");
    assert_eq!(limited_at, 10, "a burst of 10");
    assert_ne!(app.post_bytes("/app-icons", Some(&other), "image/png", Vec::new()).await.0, 429, "another user has their own bucket");
    for _ in 0..40 {
        let request = Request::builder().uri(format!("/api/v1/app-icons/{}", "0".repeat(64))).body(Body::empty()).unwrap();
        assert_eq!(app.router.clone().oneshot(request).await.unwrap().status(), StatusCode::NOT_FOUND, "icon downloads are never limited");
    }
}
