#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! App icons: `POST /app-icons` re-encodes an uploaded PNG to 64x64 and returns `app:<sha256>`, `GET /app-icons/{hash}` serves it publicly.
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TestApp;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage};
use tower::ServiceExt;

fn png(width: u32, height: u32, shade: u8) -> Vec<u8> {
    let image = RgbaImage::from_pixel(width, height, image::Rgba([shade, 40, 90, 255]));
    let mut out = Vec::new();
    PngEncoder::new(&mut out).write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8).unwrap();
    out
}

async fn fetch(app: &TestApp, hash: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = app.router.clone().oneshot(Request::builder().uri(format!("/api/v1/app-icons/{hash}")).body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    (status, headers, axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
}

#[tokio::test]
async fn upload_re_encodes_to_64_square_and_serves_publicly() {
    let app = TestApp::new().await;
    let (token, _) = app.register("alice").await;
    let (status, body) = app.post_bytes("/app-icons", Some(&token), "image/png", png(256, 256, 200)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let asset = body["asset"].as_str().unwrap().to_owned();
    let hash = asset.strip_prefix("app:").expect("app: prefix");
    assert_eq!(hash.len(), 64);

    let (status, headers, bytes) = fetch(&app, hash).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["cache-control"], "public, max-age=31536000, immutable");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (64, 64), "the stored icon is the 64x64 re-encode, not the upload");
    assert_ne!(bytes, png(256, 256, 200));

    // the hash is of the stored bytes; the same image (even uploaded by someone else) gives the same one
    use sha2::{Digest, Sha256};
    assert_eq!(hash, Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>());
    let (other, _) = app.register("bob").await;
    let (_, again) = app.post_bytes("/app-icons", Some(&other), "image/png", png(256, 256, 200)).await;
    assert_eq!(again["asset"], asset);
    let (_, different) = app.post_bytes("/app-icons", Some(&token), "image/png", png(256, 256, 10)).await;
    assert_ne!(different["asset"], asset);
}

#[tokio::test]
async fn bad_uploads_are_refused() {
    let app = TestApp::new().await;
    let (token, _) = app.register("alice").await;
    let mut jpeg_like = vec![0xff, 0xd8, 0xff, 0xe0];
    jpeg_like.extend_from_slice(&[0; 64]);
    let cases: [(&str, Option<&str>, &str, Vec<u8>, StatusCode); 7] = [
        ("no token", None, "image/png", png(64, 64, 1), StatusCode::UNAUTHORIZED),
        ("not a PNG", Some(&token), "image/png", jpeg_like.clone(), StatusCode::BAD_REQUEST),
        ("wrong content type", Some(&token), "image/jpeg", png(64, 64, 1), StatusCode::BAD_REQUEST),
        ("no content type match", Some(&token), "application/octet-stream", png(64, 64, 1), StatusCode::BAD_REQUEST),
        ("too many pixels", Some(&token), "image/png", png(600, 600, 1), StatusCode::BAD_REQUEST),
        ("oversize body", Some(&token), "image/png", vec![0; 200 * 1024], StatusCode::PAYLOAD_TOO_LARGE),
        ("empty", Some(&token), "image/png", Vec::new(), StatusCode::BAD_REQUEST),
    ];
    for (what, auth, content_type, body, expected) in cases {
        let (status, _) = app.post_bytes("/app-icons", auth, content_type, body).await;
        assert_eq!(status, expected, "{what}");
    }
}

#[tokio::test]
async fn unknown_or_malformed_hashes_are_404() {
    let app = TestApp::new().await;
    for hash in ["0".repeat(64), "short".to_owned(), "G".repeat(64), "A".repeat(64)] {
        assert_eq!(fetch(&app, &hash).await.0, StatusCode::NOT_FOUND, "{hash}");
    }
}

#[tokio::test]
async fn one_user_can_add_a_limited_number_of_icons() {
    let app = TestApp::new().await;
    let (token, _) = app.register("alice").await;
    let mut first = String::new();
    for shade in 0..64_u8 {
        let (status, body) = app.post_bytes("/app-icons", Some(&token), "image/png", png(64, 64, shade)).await;
        assert_eq!(status, StatusCode::OK);
        if shade == 0 {
            first = body["asset"].as_str().unwrap().to_owned();
        }
    }
    let (status, body) = app.post_bytes("/app-icons", Some(&token), "image/png", png(64, 64, 200)).await;
    assert_eq!((status, body["code"].as_u64()), (StatusCode::BAD_REQUEST, Some(30008)), "the 65th distinct icon");
    let (status, body) = app.post_bytes("/app-icons", Some(&token), "image/png", png(64, 64, 0)).await;
    assert_eq!((status, body["asset"].as_str()), (StatusCode::OK, Some(first.as_str())), "an icon that exists costs nothing");
}

#[tokio::test]
async fn concurrent_uploads_cannot_pass_the_cap() {
    let app = TestApp::new().await;
    let (token, _) = app.register("alice").await;
    let results = futures_util::future::join_all((0..80_u8).map(|shade| {
        let (app, token) = (&app, token.clone());
        async move { app.post_bytes("/app-icons", Some(&token), "image/png", png(64, 64, shade)).await.0 }
    }))
    .await;
    assert_eq!(results.iter().filter(|status| **status == StatusCode::OK).count(), 64, "exactly the cap got in");
}
