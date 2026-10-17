//! Embed images (link preview thumbnails, bot embed images) served through the server, so clients never load a third-party
//! host (the CSP's `img-src` blocks them, and a direct load would hand every viewer's address to that site).
//!
//! `proxy_url` is `{public_url}/api/v1/embed-media/{sig}/{target}`: `target` is the image URL as base64url, `sig` its
//! HMAC-SHA256 under a key derived from `VOKKO_SECRETS_KEY` (random per process without it), so only URLs this server put
//! in an embed are fetched. It is computed whenever a message is serialized, never stored, so old embeds get one too.
//!
//! The download uses the link-preview SSRF guard (public addresses only, every redirect hop checked again), at most
//! 3 redirects, 10 s, 8 MiB, no cookies or credentials, and only PNG, JPEG, GIF and WebP by their magic bytes.
//!
//! Fetched images are kept in a disk cache under `{data_dir}/embed-media` (see `Cache`), so one image is downloaded once
//! for all viewers, not once per viewer.
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use axum::body::Bytes;

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
pub const CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// A fetched image: its sniffed content type and bytes.
pub type Image = (&'static str, Bytes);
/// The content types a cached file may carry in its first line (what `sniff_image` returns).
const CACHED_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// An image ready to send: cache hits stream from disk, so a burst of hits does not hold every image in memory.
pub struct Served {
    pub content_type: &'static str,
    pub length: u64,
    pub body: axum::body::Body,
}

impl From<Image> for Served {
    fn from((content_type, bytes): Image) -> Self {
        Self { content_type, length: bytes.len() as u64, body: bytes.into() }
    }
}

/// The signed same-origin URL for `url`, or `None` when it is not something the proxy would fetch.
pub fn proxy_url(state: &AppState, url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if url.len() > MAX_URL_LEN || !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let sig = URL_SAFE_NO_PAD.encode(state.config.embed_media_key.mac(url.as_bytes()));
    Some(format!("{}/api/v1/embed-media/{sig}/{}", state.config.public_url, URL_SAFE_NO_PAD.encode(url)))
}

/// Sets `proxy_url` on every image and thumbnail and `proxy_icon_url` on the author and footer. Always overwritten: a
/// stored or client-sent value is never passed on.
pub fn fill(state: &AppState, embeds: &mut [Embed]) {
    for embed in embeds {
        for media in [&mut embed.image, &mut embed.thumbnail].into_iter().flatten() {
            media.proxy_url = proxy_url(state, &media.url);
        }
        if let Some(author) = &mut embed.author {
            author.proxy_icon_url = author.icon_url.as_deref().and_then(|url| proxy_url(state, url));
        }
        if let Some(footer) = &mut embed.footer {
            footer.proxy_icon_url = footer.icon_url.as_deref().and_then(|url| proxy_url(state, url));
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
    cache: Cache,
}

fn bad_gateway() -> ApiErr {
    let mut error = ApiErr::internal();
    error.status = axum::http::StatusCode::BAD_GATEWAY;
    error.body.message = "The image could not be loaded.".to_owned();
    error
}

impl EmbedMediaProxy {
    /// `allow_private` is the link-preview test seam (`UnfurlConfig::allow_private`); `cache_dir` holds the disk cache.
    pub fn new(allow_private: bool, cache_dir: PathBuf) -> Self {
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
        Self { client, allow_private, downloads: tokio::sync::Semaphore::new(MAX_DOWNLOADS), cache: Cache::open(cache_dir, CACHE_MAX_BYTES) }
    }

    /// The image from the cache, or fetched (once, however many requests ask at the same time) and cached.
    pub async fn get(&self, url: Url) -> ApiResult<Served> {
        let key = url.to_string();
        self.cache
            .get_or_fetch(&key, || async { self.fetch(url).await.ok().map(|(content_type, bytes)| (content_type, Bytes::from(bytes))) })
            .await
            .ok_or_else(bad_gateway)
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

/// The disk cache of fetched images: one file per target URL, named by its SHA-256 in hex (fine on filesystems that ignore
/// case), whose modification time is when it was fetched: the sniffed content type and a newline, then the image. At most
/// `max_bytes` in total, the oldest go first; entries older than `CACHE_TTL` are fetched again. A first line that is not
/// one of `CACHED_TYPES` is a miss. The index lives in memory and is rebuilt from the directory at startup.
struct Cache {
    dir: PathBuf,
    max_bytes: u64,
    index: Mutex<Index>,
    /// One cell per image being fetched: concurrent misses wait for the same download (and share its failure).
    inflight: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Option<Image>>>>>,
}

#[derive(Default)]
struct Index {
    entries: HashMap<String, (SystemTime, u64)>,
    total: u64,
}

impl Index {
    /// Drops `key`, but only while it is still the entry fetched at `fetched` (a newer copy may have replaced it).
    fn remove_if(&mut self, key: &str, fetched: SystemTime) -> bool {
        if self.entries.get(key).is_none_or(|entry| entry.0 != fetched) {
            return false;
        }
        if let Some((_, size)) = self.entries.remove(key) {
            self.total = self.total.saturating_sub(size);
        }
        true
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn cache_key(url: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(url.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Cache {
    fn open(dir: PathBuf, max_bytes: u64) -> Self {
        let mut index = Index::default();
        // A few thousand entries at most (512 MB of images), read once at startup.
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stamp = entry.metadata().ok().and_then(|meta| Some((meta.modified().ok()?, meta.len())));
            match stamp {
                Some(stamp) if name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
                    index.total += stamp.1;
                    index.entries.insert(name, stamp);
                }
                // an interrupted write (`.tmp`) or a stranger
                _ => {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Self { dir, max_bytes, index: Mutex::new(index), inflight: Mutex::default() }
    }

    async fn get_or_fetch<F: Future<Output = Option<Image>>>(&self, url: &str, fetch: impl FnOnce() -> F) -> Option<Served> {
        let key = cache_key(url);
        if let Some(hit) = self.read(&key).await {
            return Some(hit);
        }
        let cell = lock(&self.inflight).entry(key.clone()).or_default().clone();
        // it may have been cached between the read above and taking the cell
        let served = match self.read(&key).await {
            Some(hit) => Some(hit),
            None => cell
                .get_or_init(|| async {
                    let image = fetch().await?;
                    self.write(&key, &image).await;
                    Some(image)
                })
                .await
                .clone()
                .map(Served::from),
        };
        let mut inflight = lock(&self.inflight);
        if inflight.get(&key).is_some_and(|current| Arc::ptr_eq(current, &cell)) {
            inflight.remove(&key);
        }
        served
    }

    async fn read(&self, key: &str) -> Option<Served> {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt};
        let fetched = lock(&self.index).entries.get(key)?.0;
        let path = self.dir.join(key);
        if fetched.elapsed().unwrap_or_default() > CACHE_TTL {
            if lock(&self.index).remove_if(key, fetched) {
                let _ = tokio::fs::remove_file(&path).await;
            }
            return None;
        }
        let opened = async {
            let file = tokio::fs::File::open(&path).await.ok()?;
            let size = file.metadata().await.ok()?.len();
            let mut reader = tokio::io::BufReader::new(file);
            let mut line = Vec::new();
            (&mut reader).take(16).read_until(b'\n', &mut line).await.ok()?;
            let content_type = CACHED_TYPES.into_iter().find(|known| line.strip_suffix(b"\n") == Some(known.as_bytes()))?;
            let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(reader));
            Some(Served { content_type, length: size.checked_sub(line.len() as u64)?, body })
        };
        let served = opened.await;
        if served.is_none() {
            lock(&self.index).remove_if(key, fetched);
        }
        served
    }

    /// Stores the image (written to a temporary file and renamed, so a reader never sees half a file), then evicts the
    /// oldest entries until the total fits. A disk error only means the image is not cached.
    async fn write(&self, key: &str, (content_type, bytes): &Image) {
        let contents = [format!("{content_type}\n").as_bytes(), bytes].concat();
        let size = contents.len() as u64;
        if size > self.max_bytes {
            return;
        }
        let path = self.dir.join(key);
        let temporary = self.dir.join(format!("{key}.tmp"));
        if tokio::fs::create_dir_all(&self.dir).await.is_err()
            || tokio::fs::write(&temporary, contents).await.is_err()
            || tokio::fs::rename(&temporary, &path).await.is_err()
        {
            let _ = tokio::fs::remove_file(&temporary).await;
            return;
        }
        let evicted = {
            let mut index = lock(&self.index);
            if let Some((_, old)) = index.entries.insert(key.to_owned(), (SystemTime::now(), size)) {
                index.total = index.total.saturating_sub(old);
            }
            index.total += size;
            let mut evicted = Vec::new();
            while index.total > self.max_bytes {
                // ponytail: O(n) scan per eviction, fine for thousands of entries; a BTreeMap by time if it grows far past that
                let oldest =
                    index.entries.iter().filter(|(name, _)| name.as_str() != key).min_by_key(|(_, entry)| entry.0).map(|(name, entry)| (name.clone(), entry.0));
                let Some((oldest, fetched)) = oldest else {
                    break;
                };
                index.remove_if(&oldest, fetched);
                evicted.push(oldest);
            }
            evicted
        };
        for name in evicted {
            let _ = tokio::fs::remove_file(self.dir.join(name)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A PNG header `sniff_image` accepts, padded to `len` bytes.
    fn png(len: usize) -> Bytes {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1];
        bytes.resize(len.max(bytes.len()), 0);
        Bytes::from(bytes)
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vokko-embed-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    async fn get(cache: &Cache, url: &str, fetches: &AtomicUsize, len: usize) -> Option<Image> {
        let served = cache
            .get_or_fetch(url, || async {
                fetches.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Some(("image/png", png(len)))
            })
            .await?;
        let bytes = axum::body::to_bytes(served.body, usize::MAX).await.expect("body");
        assert_eq!(served.length, bytes.len() as u64);
        Some((served.content_type, bytes))
    }

    #[tokio::test]
    async fn concurrent_misses_fetch_once_then_hit_the_disk() {
        let dir = dir("once");
        let cache = Cache::open(dir.clone(), CACHE_MAX_BYTES);
        let fetches = AtomicUsize::new(0);
        let all = futures_util::future::join_all((0..8).map(|_| get(&cache, "https://example.com/a.png", &fetches, 100))).await;
        assert!(all.iter().all(|image| image.as_ref().is_some_and(|(content_type, bytes)| *content_type == "image/png" && bytes.len() == 100)));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        // a restarted server finds it on disk
        let reopened = Cache::open(dir.clone(), CACHE_MAX_BYTES);
        assert_eq!(get(&reopened, "https://example.com/a.png", &fetches, 100).await, Some(("image/png", png(100))));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        // a damaged first line is a miss, refetched and rewritten
        std::fs::write(dir.join(cache_key("https://example.com/a.png")), b"text/html\n<html>").expect("damage");
        assert_eq!(get(&reopened, "https://example.com/a.png", &fetches, 100).await, Some(("image/png", png(100))));
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_oldest_entries_are_evicted_past_the_size_cap() {
        let dir = dir("evict");
        let cache = Cache::open(dir.clone(), 250);
        let fetches = AtomicUsize::new(0);
        for name in ["a", "b", "c"] {
            get(&cache, &format!("https://example.com/{name}.png"), &fetches, 100).await;
        }
        assert_eq!(lock(&cache.index).total, 2 * (100 + "image/png\n".len() as u64));
        assert!(!dir.join(cache_key("https://example.com/a.png")).exists(), "the oldest went");
        assert!(dir.join(cache_key("https://example.com/c.png")).exists());
        get(&cache, "https://example.com/a.png", &fetches, 100).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 4, "a was fetched again");
        // an image larger than the whole cache is served but not kept
        assert!(get(&cache, "https://example.com/big.png", &fetches, 300).await.is_some());
        assert!(!dir.join(cache_key("https://example.com/big.png")).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn entries_past_the_ttl_are_fetched_again() {
        let dir = dir("ttl");
        let cache = Cache::open(dir.clone(), CACHE_MAX_BYTES);
        let fetches = AtomicUsize::new(0);
        get(&cache, "https://example.com/a.png", &fetches, 100).await;
        let file = std::fs::File::options().write(true).open(dir.join(cache_key("https://example.com/a.png"))).expect("cached file");
        file.set_modified(SystemTime::now() - CACHE_TTL - Duration::from_secs(60)).expect("backdate");
        drop(file);
        std::fs::write(dir.join("half.tmp"), b"x").expect("leftover");
        let reopened = Cache::open(dir.clone(), CACHE_MAX_BYTES);
        assert!(!dir.join("half.tmp").exists(), "leftovers are cleared at startup");
        get(&reopened, "https://example.com/a.png", &fetches, 100).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
        get(&reopened, "https://example.com/a.png", &fetches, 100).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 2, "the fresh copy is used");
        let _ = std::fs::remove_dir_all(dir);
    }
}
