//! S3-compatible attachment storage (Cloudflare R2, Backblaze B2, Supabase Storage, MinIO, AWS S3) with path-style
//! addressing (`<endpoint>/<bucket>/<prefix><id>`) and a small AWS Signature V4 signer, so no SDK is needed.
use std::fmt;
use std::io;
use std::time::Duration;

use axum::body::{Body, Bytes};
use futures_util::future::BoxFuture;
use hmac::{Hmac, Mac};
use reqwest::{Method, StatusCode, Url};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use super::{DEFAULT_PRESIGN_TTL, MAX_PRESIGN_TTL, Object, Presign, Storage};
use crate::config::DotEnv;

/// `VOKKO_S3_*`.
#[derive(Clone)]
pub struct S3Config {
    /// `https://<account>.r2.cloudflarestorage.com`, `https://s3.<region>.backblazeb2.com`,
    /// `https://<project>.supabase.co/storage/v1/s3`, `http://minio:9000` (no bucket, no trailing slash).
    pub endpoint: String,
    pub bucket: String,
    /// `auto` for R2; the bucket's region elsewhere.
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Object key prefix (default `attachments/`).
    pub prefix: String,
    /// `Some` (`VOKKO_S3_SERVE=presigned`): downloads redirect to a presigned URL valid this long instead of streaming through the server.
    pub presign_ttl: Option<Duration>,
}

impl fmt::Debug for S3Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .field("prefix", &self.prefix)
            .field("presign_ttl", &self.presign_ttl)
            .finish()
    }
}

/// Characters that never need percent-encoding in a key or bucket we build URLs from.
fn plain(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

impl S3Config {
    pub fn from_env(env: &DotEnv) -> Result<Self, String> {
        let required = |key: &str| {
            env.get(key).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()).ok_or(format!("{key} is required with VOKKO_STORAGE=s3"))
        };
        let endpoint = required("VOKKO_S3_ENDPOINT")?.trim_end_matches('/').to_owned();
        let parsed = Url::parse(&endpoint).map_err(|_| format!("VOKKO_S3_ENDPOINT must be an http(s) URL, got {endpoint}"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() || parsed.query().is_some() || !plain(parsed.path()) {
            return Err(format!("VOKKO_S3_ENDPOINT must be an http(s) URL without a query, got {endpoint}"));
        }
        let bucket = required("VOKKO_S3_BUCKET")?;
        if bucket.contains('/') || !plain(&bucket) {
            return Err(format!("VOKKO_S3_BUCKET may only contain letters, digits, `.`, `-` and `_`, got {bucket}"));
        }
        let prefix = env.get("VOKKO_S3_PREFIX").unwrap_or_else(|| "attachments/".to_owned());
        // URL parsing would fold `.`/`..` segments (and the copy source would not), so they are refused along with empty ones.
        let odd_segment = prefix.trim_end_matches('/').split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..");
        if !plain(&prefix) || (!prefix.is_empty() && odd_segment) {
            return Err(format!("VOKKO_S3_PREFIX may only contain letters, digits, `.`, `-`, `_` and `/`, with no empty, `.` or `..` segments, got {prefix}"));
        }
        let presign_ttl = match env.get("VOKKO_S3_SERVE").map(|value| value.trim().to_ascii_lowercase()).as_deref() {
            None | Some("proxy") | Some("") => None,
            Some("presigned") => {
                let ttl = match env.get("VOKKO_S3_PRESIGN_TTL_SECS") {
                    Some(value) => Duration::from_secs(
                        value.trim().parse().map_err(|_| format!("VOKKO_S3_PRESIGN_TTL_SECS must be a whole number of seconds, got {value}"))?,
                    ),
                    None => DEFAULT_PRESIGN_TTL,
                };
                if ttl.is_zero() || ttl > MAX_PRESIGN_TTL {
                    return Err(format!("VOKKO_S3_PRESIGN_TTL_SECS must be between 1 and {}", MAX_PRESIGN_TTL.as_secs()));
                }
                Some(ttl)
            }
            Some(other) => return Err(format!("VOKKO_S3_SERVE must be `proxy` or `presigned`, got {other}")),
        };
        Ok(Self {
            endpoint,
            bucket,
            region: env.get("VOKKO_S3_REGION").map(|value| value.trim().to_owned()).unwrap_or_else(|| "auto".to_owned()),
            access_key_id: required("VOKKO_S3_ACCESS_KEY_ID")?,
            secret_access_key: required("VOKKO_S3_SECRET_ACCESS_KEY")?,
            prefix,
            presign_ttl,
        })
    }

    /// `<endpoint>/<bucket>/<prefix><id>`; every part is already URL-safe (checked in `from_env`).
    fn object_url(&self, id: i64) -> Result<Url, io::Error> {
        Url::parse(&format!("{}/{}/{}{id}", self.endpoint, self.bucket, self.prefix)).map_err(io::Error::other)
    }
}

pub struct S3Storage {
    config: S3Config,
    client: Option<reqwest::Client>,
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn not_found() -> io::Error {
    io::Error::from(io::ErrorKind::NotFound)
}

fn s3_error(method: &Method, status: StatusCode) -> io::Error {
    io::Error::other(format!("object storage {method} answered {status}"))
}

impl S3Storage {
    pub fn new(config: S3Config) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("vokko-server")
            .build()
            .ok();
        if client.is_none() {
            tracing::error!("object storage: cannot build the HTTP client; attachment reads and writes will fail");
        }
        Self { config, client }
    }

    fn signer(&self) -> Signer<'_> {
        Signer { access_key_id: &self.config.access_key_id, secret_access_key: &self.config.secret_access_key, region: &self.config.region }
    }

    /// A signed request for `id`; `copy_source` adds `x-amz-copy-source`.
    async fn send(&self, method: Method, id: i64, body: Option<Bytes>, copy_source: Option<String>) -> io::Result<reqwest::Response> {
        let client = self.client.as_ref().ok_or_else(|| io::Error::other("object storage client unavailable"))?;
        let url = self.config.object_url(id)?;
        let payload_hash = body.as_ref().map(|bytes| hex(&Sha256::digest(bytes))).unwrap_or_else(|| EMPTY_SHA256.to_owned());
        let amz_date = amz_date(OffsetDateTime::now_utc());
        let mut headers = vec![("x-amz-content-sha256", payload_hash.clone()), ("x-amz-date", amz_date.clone())];
        if let Some(source) = &copy_source {
            headers.push(("x-amz-copy-source", source.clone()));
        }
        let authorization = self.signer().authorization(method.as_str(), &host(&url), url.path(), &[], &headers, &payload_hash, &amz_date);
        let mut request = client.request(method, url).header("authorization", authorization);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(bytes) = body {
            request = request.body(bytes);
        }
        request.send().await.map_err(io::Error::other)
    }

    async fn get(&self, id: i64) -> io::Result<reqwest::Response> {
        let response = self.send(Method::GET, id, None, None).await?;
        match response.status() {
            status if status.is_success() => Ok(response),
            StatusCode::NOT_FOUND => Err(not_found()),
            status => Err(s3_error(&Method::GET, status)),
        }
    }

    async fn put_bytes(&self, id: i64, bytes: Bytes) -> io::Result<()> {
        let response = self.send(Method::PUT, id, Some(bytes), None).await?;
        if response.status().is_success() { Ok(()) } else { Err(s3_error(&Method::PUT, response.status())) }
    }
}

impl Storage for S3Storage {
    fn put(&self, id: i64, bytes: Bytes) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(self.put_bytes(id, bytes))
    }

    fn open(&self, id: i64) -> BoxFuture<'_, io::Result<Object>> {
        Box::pin(async move {
            let response = self.get(id).await?;
            let length = response.content_length().ok_or_else(|| io::Error::other("object storage sent no Content-Length"))?;
            Ok(Object { length, body: Body::from_stream(response.bytes_stream()) })
        })
    }

    fn read(&self, id: i64) -> BoxFuture<'_, io::Result<Bytes>> {
        Box::pin(async move { self.get(id).await?.bytes().await.map_err(io::Error::other) })
    }

    /// Server-side CopyObject; a provider that refuses it gets a download and re-upload instead.
    fn copy(&self, from: i64, to: i64) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            let source = format!("/{}/{}{from}", self.config.bucket, self.config.prefix);
            let response = self.send(Method::PUT, to, None, Some(source)).await?;
            let status = response.status();
            if status == StatusCode::NOT_FOUND {
                return Err(not_found());
            }
            // CopyObject can answer 200 with an <Error> body when it fails late.
            if status.is_success() && !response.text().await.unwrap_or_default().contains("<Error>") {
                return Ok(());
            }
            let bytes = self.read(from).await?;
            self.put_bytes(to, bytes).await
        })
    }

    fn delete(&self, id: i64) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            let response = self.send(Method::DELETE, id, None, None).await?;
            match response.status() {
                status if status.is_success() || status == StatusCode::NOT_FOUND => Ok(()),
                status => Err(s3_error(&Method::DELETE, status)),
            }
        })
    }

    fn presigned_url(&self, id: i64, presign: &Presign<'_>) -> Option<String> {
        let ttl = self.config.presign_ttl?;
        let mut url = self.config.object_url(id).ok()?;
        let query = self.signer().presign(
            "GET",
            &host(&url),
            url.path(),
            &[("response-content-disposition", presign.disposition), ("response-content-type", presign.content_type)],
            ttl.as_secs(),
            &amz_date(OffsetDateTime::now_utc()),
        );
        url.set_query(Some(&query));
        Some(url.into())
    }
}

/// `host[:port]` as reqwest sends it (the port only when it is not the scheme's default).
fn host(url: &Url) -> String {
    let name = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_owned(),
    }
}

/// `20130524T000000Z`.
pub fn amz_date(now: OffsetDateTime) -> String {
    format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", now.year(), u8::from(now.month()), now.day(), now.hour(), now.minute(), now.second())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    // HMAC accepts keys of any length, so `new_from_slice` cannot fail here.
    match Hmac::<Sha256>::new_from_slice(key) {
        Ok(mut mac) => {
            mac.update(data);
            mac.finalize().into_bytes().to_vec()
        }
        Err(_) => Vec::new(),
    }
}

/// RFC 3986 encoding as SigV4 wants it: everything but `A-Za-z0-9-_.~` (and `/` when `keep_slash`).
pub fn uri_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// AWS Signature Version 4 for the `s3` service.
pub struct Signer<'a> {
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
    pub region: &'a str,
}

impl Signer<'_> {
    fn scope(&self, amz_date: &str) -> String {
        format!("{}/{}/s3/aws4_request", &amz_date[..8.min(amz_date.len())], self.region)
    }

    fn signature(&self, amz_date: &str, canonical_request: &str) -> String {
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{}\n{}", self.scope(amz_date), hex(&Sha256::digest(canonical_request.as_bytes())));
        let date = &amz_date[..8.min(amz_date.len())];
        let key = [date.as_bytes(), self.region.as_bytes(), b"s3", b"aws4_request"]
            .iter()
            .fold(format!("AWS4{}", self.secret_access_key).into_bytes(), |key, part| hmac(&key, part));
        hex(&hmac(&key, string_to_sign.as_bytes()))
    }

    /// `path` is the already-encoded URL path; `query` holds raw (unencoded) pairs; header names are lowercase. `host` is signed too.
    fn canonical_request(method: &str, host: &str, path: &str, query: &[(&str, &str)], headers: &[(&str, String)], payload_hash: &str) -> (String, String) {
        let mut query: Vec<(String, String)> = query.iter().map(|(key, value)| (uri_encode(key, false), uri_encode(value, false))).collect();
        query.sort();
        let query = query.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&");
        let mut headers: Vec<(String, String)> =
            headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned())).chain([("host".to_owned(), host.to_owned())]).collect();
        headers.sort();
        let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{value}\n")).collect();
        let signed_headers = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(";");
        (format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"), signed_headers)
    }

    /// The `Authorization` header for a request carrying `headers` (which must include `x-amz-date` and `x-amz-content-sha256`).
    #[allow(clippy::too_many_arguments)]
    pub fn authorization(
        &self,
        method: &str,
        host: &str,
        path: &str,
        query: &[(&str, &str)],
        headers: &[(&str, String)],
        payload_hash: &str,
        amz_date: &str,
    ) -> String {
        let (canonical, signed_headers) = Self::canonical_request(method, host, path, query, headers, payload_hash);
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={signed_headers}, Signature={}",
            self.access_key_id,
            self.scope(amz_date),
            self.signature(amz_date, &canonical)
        )
    }

    /// The query string of a presigned URL (only `host` signed, unsigned payload).
    pub fn presign(&self, method: &str, host: &str, path: &str, extra: &[(&str, &str)], expires_secs: u64, amz_date: &str) -> String {
        let credential = format!("{}/{}", self.access_key_id, self.scope(amz_date));
        let expires = expires_secs.to_string();
        let mut query: Vec<(&str, &str)> = vec![
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
            ("X-Amz-Credential", &credential),
            ("X-Amz-Date", amz_date),
            ("X-Amz-Expires", &expires),
            ("X-Amz-SignedHeaders", "host"),
        ];
        query.extend_from_slice(extra);
        let (canonical, _) = Self::canonical_request(method, host, path, &query, &[], "UNSIGNED-PAYLOAD");
        let signature = self.signature(amz_date, &canonical);
        let mut pairs: Vec<String> = query.iter().map(|(key, value)| format!("{}={}", uri_encode(key, false), uri_encode(value, false))).collect();
        pairs.push(format!("X-Amz-Signature={signature}"));
        pairs.join("&")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The worked examples of AWS's "Signature Calculations for the Authorization Header" and "Query String Authentication" docs.
    const EXAMPLE: Signer<'static> =
        Signer { access_key_id: "AKIAIOSFODNN7EXAMPLE", secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };

    #[test]
    fn sigv4_get_object_example() {
        let headers = [("range", "bytes=0-9".to_owned()), ("x-amz-content-sha256", EMPTY_SHA256.to_owned()), ("x-amz-date", "20130524T000000Z".to_owned())];
        let authorization = EXAMPLE.authorization("GET", "examplebucket.s3.amazonaws.com", "/test.txt", &[], &headers, EMPTY_SHA256, "20130524T000000Z");
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn sigv4_presigned_example() {
        let query = EXAMPLE.presign("GET", "examplebucket.s3.amazonaws.com", "/test.txt", &[], 86400, "20130524T000000Z");
        assert!(query.ends_with("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"), "{query}");
        assert!(query.contains("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"));
    }

    #[test]
    fn encoding_and_dates() {
        assert_eq!(uri_encode("a b/ü~", false), "a%20b%2F%C3%BC~");
        assert_eq!(uri_encode("a/b", true), "a/b");
        let moment = OffsetDateTime::from_unix_timestamp(1_369_353_600).expect("timestamp");
        assert_eq!(amz_date(moment), "20130524T000000Z");
        let url = Url::parse("http://127.0.0.1:9000/b/k").expect("url");
        assert_eq!(host(&url), "127.0.0.1:9000");
        assert_eq!(host(&Url::parse("https://x.r2.cloudflarestorage.com/b").expect("url")), "x.r2.cloudflarestorage.com");
    }

    fn env(extra: &[(&'static str, &'static str)]) -> DotEnv {
        let mut pairs = vec![
            ("VOKKO_S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com/"),
            ("VOKKO_S3_BUCKET", "vokko"),
            ("VOKKO_S3_ACCESS_KEY_ID", "id"),
            ("VOKKO_S3_SECRET_ACCESS_KEY", "secret"),
        ];
        pairs.extend_from_slice(extra);
        DotEnv::from_pairs(&pairs)
    }

    #[test]
    fn config_from_env() {
        let config = S3Config::from_env(&env(&[])).expect("config");
        assert_eq!(config.endpoint, "https://acct.r2.cloudflarestorage.com");
        assert_eq!((config.region.as_str(), config.prefix.as_str(), config.presign_ttl), ("auto", "attachments/", None));
        assert_eq!(config.object_url(42).expect("url").as_str(), "https://acct.r2.cloudflarestorage.com/vokko/attachments/42");
        assert!(!format!("{config:?}").contains("secret\""), "the secret is redacted");
        let supabase = S3Config::from_env(&env(&[("VOKKO_S3_ENDPOINT", "https://p.supabase.co/storage/v1/s3"), ("VOKKO_S3_PREFIX", "")])).expect("config");
        assert_eq!(supabase.object_url(7).expect("url").path(), "/storage/v1/s3/vokko/7");
        let presigned = S3Config::from_env(&env(&[("VOKKO_S3_SERVE", "presigned"), ("VOKKO_S3_PRESIGN_TTL_SECS", "60")])).expect("config");
        assert_eq!(presigned.presign_ttl, Some(Duration::from_secs(60)));
        for bad in [
            ("VOKKO_S3_SERVE", "cdn"),
            ("VOKKO_S3_PRESIGN_TTL_SECS", "0"),
            ("VOKKO_S3_ENDPOINT", "ftp://x"),
            ("VOKKO_S3_BUCKET", "a/b"),
            ("VOKKO_S3_PREFIX", "a b"),
            ("VOKKO_S3_PREFIX", "./x/"),
            ("VOKKO_S3_PREFIX", "x/../y/"),
            ("VOKKO_S3_PREFIX", "/x/"),
            ("VOKKO_S3_PREFIX", "x//y/"),
        ] {
            let extra = if bad.0 == "VOKKO_S3_PRESIGN_TTL_SECS" { vec![("VOKKO_S3_SERVE", "presigned"), bad] } else { vec![bad] };
            assert!(S3Config::from_env(&env(&extra)).is_err(), "{bad:?} is rejected");
        }
    }

    #[test]
    fn presigned_url_carries_response_overrides() {
        let config = S3Config::from_env(&env(&[("VOKKO_S3_SERVE", "presigned")])).expect("config");
        let storage = S3Storage::new(config);
        let url = storage.presigned_url(5, &Presign { content_type: "image/png", disposition: "inline; filename=\"a b.png\"" }).expect("presigned");
        assert!(url.starts_with("https://acct.r2.cloudflarestorage.com/vokko/attachments/5?X-Amz-Algorithm=AWS4-HMAC-SHA256&"), "{url}");
        assert!(url.contains("X-Amz-Expires=300"));
        assert!(url.contains("response-content-type=image%2Fpng"));
        assert!(url.contains("response-content-disposition=inline%3B%20filename%3D%22a%20b.png%22"));
    }
}
