//! Embed images (link preview thumbnails, bot embed images) served through the server, so clients never load a third-party
//! host (the CSP's `img-src` blocks them, and a direct load would hand every viewer's address to that site).
//!
//! `proxy_url` is `{public_url}/api/v1/embed-media/{sig}/{target}`: `target` is the image URL as base64url, `sig` its
//! HMAC-SHA256 under a key derived from `VOKKO_SECRETS_KEY` (random per process without it), so only URLs this server put
//! in an embed are fetched. It is computed whenever a message is serialized, never stored, so old embeds get one too.
//!
//! The download uses the link-preview SSRF guard (public addresses only, every redirect hop checked again), at most
//! 3 redirects, 10 s, 8 MiB, no cookies or credentials, and only PNG, JPEG, GIF and WebP by their magic bytes.
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Url;
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION};
use vokko_protocol::api::{Embed, EmbedMedia};

use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;
use crate::unfurl::{GuardedResolver, host_allowed};

pub const KEY_LABEL: &str = "vokko embed media v1";
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 3;
const MAX_URL_LEN: usize = 2048;
/// Server-wide cap on downloads in flight (each holds up to `MAX_BYTES` in memory).
const MAX_DOWNLOADS: usize = 16;

/// The signed same-origin URL for `url`, or `None` when it is not something the proxy would fetch.
pub fn proxy_url(state: &AppState, url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if url.len() > MAX_URL_LEN || !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let sig = URL_SAFE_NO_PAD.encode(state.config.embed_media_key.mac(url.as_bytes()));
    Some(format!("{}/api/v1/embed-media/{sig}/{}", state.config.public_url, URL_SAFE_NO_PAD.encode(url)))
}

/// Sets `proxy_url` on every image and thumbnail. Always overwritten: a stored or client-sent value is never passed on.
pub fn fill(state: &AppState, embeds: &mut [Embed]) {
    for embed in embeds {
        for media in [&mut embed.image, &mut embed.thumbnail].into_iter().flatten() {
            media.proxy_url = proxy_url(state, &media.url);
        }
        // Videos are not proxied (not an image); no stored value goes out either.
        if let Some(EmbedMedia { proxy_url, .. }) = &mut embed.video {
            *proxy_url = None;
        }
    }
}

/// The target URL of a signed path, or `None` for a bad signature or encoding.
pub fn verify(state: &AppState, sig: &str, target: &str) -> Option<Url> {
    let url = String::from_utf8(URL_SAFE_NO_PAD.decode(target).ok()?).ok()?;
    let given = URL_SAFE_NO_PAD.decode(sig).ok()?;
    let expected = state.config.embed_media_key.mac(url.as_bytes());
    // constant time
    if given.len() != expected.len() || given.iter().zip(expected).fold(0_u8, |acc, (a, b)| acc | (a ^ b)) != 0 {
        return None;
    }
    Url::parse(&url).ok()
}

pub struct EmbedMediaProxy {
    client: Option<reqwest::Client>,
    allow_private: bool,
    downloads: tokio::sync::Semaphore,
}

fn bad_gateway() -> ApiErr {
    let mut error = ApiErr::internal();
    error.status = axum::http::StatusCode::BAD_GATEWAY;
    error.body.message = "The image could not be loaded.".to_owned();
    error
}

impl EmbedMediaProxy {
    /// `allow_private` is the link-preview test seam (`UnfurlConfig::allow_private`).
    pub fn new(allow_private: bool) -> Self {
        // reqwest is built without a bundled provider; installing twice is harmless.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(GuardedResolver { allow_private })
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(TIMEOUT)
            .user_agent(crate::unfurl::USER_AGENT)
            .build()
            .ok();
        Self { client, allow_private, downloads: tokio::sync::Semaphore::new(MAX_DOWNLOADS) }
    }

    /// The image's content type (from its bytes) and bytes. Any refusal or upstream failure is a 502.
    pub async fn fetch(&self, url: Url) -> ApiResult<(&'static str, Vec<u8>)> {
        let client = self.client.as_ref().ok_or_else(bad_gateway)?;
        tokio::time::timeout(TIMEOUT, async {
            let _slot = self.downloads.acquire().await.map_err(|_| bad_gateway())?;
            self.fetch_hops(client, url).await
        })
        .await
        .map_err(|_| bad_gateway())?
    }

    async fn fetch_hops(&self, client: &reqwest::Client, mut url: Url) -> ApiResult<(&'static str, Vec<u8>)> {
        for _ in 0..=MAX_REDIRECTS {
            if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() || !host_allowed(&url, self.allow_private) {
                return Err(bad_gateway());
            }
            let mut response = client.get(url.clone()).header(ACCEPT, "image/png,image/jpeg,image/gif,image/webp").send().await.map_err(|_| bad_gateway())?;
            let status = response.status();
            if status.is_redirection() {
                let location = response.headers().get(LOCATION).and_then(|value| value.to_str().ok()).ok_or_else(bad_gateway)?;
                url = url.join(location).map_err(|_| bad_gateway())?;
                continue;
            }
            let declared = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("").trim().to_ascii_lowercase();
            if !status.is_success() || !declared.starts_with("image/") || response.content_length().is_some_and(|length| length > MAX_BYTES as u64) {
                return Err(bad_gateway());
            }
            let mut bytes: Vec<u8> = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| bad_gateway())? {
                if bytes.len() + chunk.len() > MAX_BYTES {
                    return Err(bad_gateway());
                }
                bytes.extend_from_slice(&chunk);
            }
            // The declared type is not trusted: only recognised raster formats go out (never SVG or HTML).
            let sniffed = crate::media::sniff_image(&bytes).ok_or_else(bad_gateway)?;
            return Ok((sniffed.content_type, bytes));
        }
        Err(bad_gateway())
    }
}
