//! Every outbound request of the Stremio feature goes through here (docs/design/stremio-bot.md section 6.7): https on port 443
//! only, DNS answered by our own resolver with every address checked (and the connection made to the checked address, so DNS
//! rebinding does not help), no cookies, no proxy, no automatic redirects (resolver URLs are followed by hand, each hop checked
//! again), and size and time limits. `VOKKO_STREMIO_FETCH_ALLOW` opens IP ranges, and an IP literal inside one may also use
//! http and any port, for an addon on the home network.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{CONTENT_TYPE, LOCATION, RANGE};
use reqwest::{StatusCode, Url};
use serde_json::Value;

use crate::config::Cidr;
use crate::crypto::Secret;
use crate::unfurl::is_public_ip;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(8);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
/// A whole library (`datastoreGet` with `all`) is one JSON array of every title the user ever opened.
const LIBRARY_JSON_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_URL_LEN: usize = 4096;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The URL or one of its redirects is not allowed.
    Blocked,
    Timeout,
    Status(u16),
    TooLarge,
    /// Not JSON, or not a media file.
    Invalid,
    Network,
}

#[derive(Clone)]
pub struct Fetcher {
    client: reqwest::Client,
    allow: Arc<Vec<Cidr>>,
}

struct StremioResolver {
    allow: Arc<Vec<Cidr>>,
}

impl Resolve for StremioResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow = self.allow.clone();
        Box::pin(async move {
            let host = name.as_str().to_owned();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|addr| is_public_ip(addr.ip()) || allow.iter().any(|cidr| cidr.contains(addr.ip())))
                .collect();
            if addrs.is_empty() {
                return Err("host does not resolve to a public address".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

impl Fetcher {
    pub fn new(allow: Vec<Cidr>) -> Self {
        // reqwest is built without a bundled provider; installing twice is harmless.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let allow = Arc::new(allow);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(StremioResolver { allow: allow.clone() })
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .user_agent("Mozilla/5.0 (compatible; Vokko; Stremio)")
            .build()
            .unwrap_or_default();
        Self { client, allow }
    }

    /// Whether `url` may be fetched: http(s) without credentials, at most `MAX_URL_LEN` characters, a host that is not local, and
    /// https on port 443 unless the host is an IP literal inside the allow list. Hostnames are checked again when they resolve.
    pub fn check_url(&self, url: &Url) -> Result<(), FetchError> {
        if url.as_str().len() > MAX_URL_LEN || !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
            return Err(FetchError::Blocked);
        }
        let host = url.host_str().ok_or(FetchError::Blocked)?;
        let literal = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().ok();
        match literal {
            Some(ip) if self.allow.iter().any(|cidr| cidr.contains(ip)) => Ok(()),
            Some(ip) if !is_public_ip(ip) => Err(FetchError::Blocked),
            None if !crate::unfurl::host_allowed(url, false) => Err(FetchError::Blocked),
            _ if url.scheme() == "https" && url.port_or_known_default() == Some(443) => Ok(()),
            _ => Err(FetchError::Blocked),
        }
    }

    fn parse(&self, url: &str) -> Result<Url, FetchError> {
        let url = Url::parse(url).map_err(|_| FetchError::Blocked)?;
        self.check_url(&url)?;
        Ok(url)
    }

    /// Follows redirects by hand, each hop checked: Cinemeta answers its browse catalogs with a 307 to another host.
    pub async fn get_json(&self, url: &str) -> Result<Value, FetchError> {
        let mut url = self.parse(url)?;
        for _ in 0..=MAX_REDIRECTS {
            let response = self.client.get(url.clone()).send().await.map_err(network)?;
            if !response.status().is_redirection() {
                return read_json(response).await;
            }
            let location = response.headers().get(LOCATION).and_then(|value| value.to_str().ok()).ok_or(FetchError::Invalid)?;
            url = url.join(location).map_err(|_| FetchError::Blocked)?;
            self.check_url(&url)?;
        }
        Err(FetchError::Blocked)
    }

    pub async fn post_json(&self, url: &str, body: &Value) -> Result<Value, FetchError> {
        let url = self.parse(url)?;
        self.json(self.client.post(url).json(body)).await
    }

    /// Like `post_json`, for the answers that can be big (a whole Stremio library): up to `LIBRARY_JSON_BYTES`.
    pub async fn post_json_large(&self, url: &str, body: &Value) -> Result<Value, FetchError> {
        let url = self.parse(url)?;
        read_json_up_to(self.client.post(url).json(body).send().await.map_err(network)?, LIBRARY_JSON_BYTES).await
    }

    async fn json(&self, request: reqwest::RequestBuilder) -> Result<Value, FetchError> {
        read_json(request.send().await.map_err(network)?).await
    }

    /// Follows a stream's resolver URL (it redirects to the CDN file) with `Range: bytes=0-0`: at most 5 hops, the guard on every
    /// hop, 10 s in all. Returns the final URL when it answers 200 or 206 with something that can be a video. The resolver URL
    /// (it carries the user's debrid configuration) stays on the server; only the result goes to the bot.
    pub async fn resolve_media(&self, start: &Secret, headers: &[(&str, &str)]) -> Result<Secret, FetchError> {
        tokio::time::timeout(RESOLVE_TIMEOUT, async {
            let mut url = self.parse(start.expose())?;
            for _ in 0..=MAX_REDIRECTS {
                let mut request = self.client.get(url.clone()).header(RANGE, "bytes=0-0");
                for (name, value) in headers {
                    request = request.header(*name, *value);
                }
                let response = request.send().await.map_err(network)?;
                let status = response.status();
                if matches!(
                    status,
                    StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER | StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT
                ) {
                    let location = response.headers().get(LOCATION).and_then(|value| value.to_str().ok()).ok_or(FetchError::Invalid)?;
                    url = url.join(location).map_err(|_| FetchError::Blocked)?;
                    self.check_url(&url)?;
                    continue;
                }
                if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
                    return Err(FetchError::Status(status.as_u16()));
                }
                let kind = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("").to_ascii_lowercase();
                if kind.starts_with("text/") || kind.contains("json") || kind.contains("html") || kind.contains("xml") || kind.contains("mpegurl") {
                    return Err(FetchError::Invalid);
                }
                return Ok(Secret::new(url.as_str()));
            }
            Err(FetchError::Blocked)
        })
        .await
        .unwrap_or(Err(FetchError::Timeout))
    }
}

async fn read_json(response: reqwest::Response) -> Result<Value, FetchError> {
    read_json_up_to(response, MAX_JSON_BYTES).await
}

async fn read_json_up_to(mut response: reqwest::Response, max: usize) -> Result<Value, FetchError> {
    if !response.status().is_success() {
        return Err(FetchError::Status(response.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if body.len() + chunk.len() > max {
            return Err(FetchError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| FetchError::Invalid)
}

fn network(error: reqwest::Error) -> FetchError {
    if error.is_timeout() { FetchError::Timeout } else { FetchError::Network }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(fetcher: &Fetcher, url: &str) -> Result<(), FetchError> {
        fetcher.check_url(&Url::parse(url).expect("url"))
    }

    #[test]
    fn urls_are_checked_before_any_request() {
        let strict = Fetcher::new(Vec::new());
        for good in
            ["https://v3-cinemeta.strem.io/manifest.json", "https://torrentio.strem.fun/x/manifest.json", "https://8.8.8.8/x", "https://example.com:443/x"]
        {
            assert_eq!(check(&strict, good), Ok(()), "{good}");
        }
        for bad in [
            "http://v3-cinemeta.strem.io/manifest.json",
            "https://example.com:8443/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://[::ffff:127.0.0.1]/x",
            "https://10.0.0.5/x",
            "https://169.254.169.254/latest",
            "https://2130706433/x",
            "https://0x7f.1/x",
            "https://localhost/x",
            "https://printer.local/x",
            "https://thing.internal/x",
            "https://user:pass@example.com/x",
            "ftp://example.com/x",
            "file:///etc/passwd",
        ] {
            assert_eq!(check(&strict, bad), Err(FetchError::Blocked), "{bad}");
        }
        assert_eq!(check(&strict, &format!("https://example.com/{}", "a".repeat(MAX_URL_LEN))), Err(FetchError::Blocked), "too long");
    }

    #[test]
    fn the_allow_list_opens_ranges_for_ip_literals_only() {
        let home = Fetcher::new(vec![Cidr::parse("192.168.1.0/24").expect("cidr"), Cidr::parse("127.0.0.1/32").expect("cidr")]);
        assert_eq!(check(&home, "http://192.168.1.20:7000/manifest.json"), Ok(()));
        assert_eq!(check(&home, "http://127.0.0.1:11470/x"), Ok(()));
        assert_eq!(check(&home, "http://192.168.2.20/x"), Err(FetchError::Blocked));
        assert_eq!(check(&home, "http://example.com/x"), Err(FetchError::Blocked), "hostnames still need https");
        assert_eq!(check(&home, "https://10.0.0.1/x"), Err(FetchError::Blocked));
    }
}
