//! GIF search proxied through the server so the provider key never reaches a client. Results of every provider are
//! normalised to `Gif`; a failing or malformed provider answer is a 502.
use std::time::Duration;

use reqwest::Url;
use serde_json::Value;
use vokko_protocol::api::{Gif, GifCategories, GifCategory, GifPage, GifProvider};

use crate::config::GifConfig;
use crate::error::{ApiErr, ApiResult};

const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub struct GifProxy {
    client: Option<reqwest::Client>,
    config: GifConfig,
}

fn bad_gateway() -> ApiErr {
    let mut error = ApiErr::internal();
    error.status = axum::http::StatusCode::BAD_GATEWAY;
    error.body.message = "The GIF provider did not answer.".to_owned();
    error
}

/// The error text that may be logged. reqwest's Display includes the request URL, which carries the API key (query
/// for Giphy and Tenor, path for Klipy), so the URL is stripped first.
fn loggable(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

impl GifProxy {
    pub fn new(config: GifConfig) -> Self {
        // reqwest is built without a bundled provider; installing twice is harmless.
        let _ = rustls::crypto::ring::default_provider().install_default();
        // No redirects: the key is part of the request URL and must not follow a redirect to another host.
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(TIMEOUT).user_agent("vokko-server").build().ok();
        Self { client, config }
    }

    pub fn provider(&self) -> GifProvider {
        self.config.provider
    }

    fn base(&self, default: &str) -> String {
        self.config.base_url.clone().unwrap_or_else(|| default.to_owned())
    }

    async fn fetch(&self, url: Url) -> ApiResult<Value> {
        let client = self.client.as_ref().ok_or_else(bad_gateway)?;
        let response = client.get(url).send().await.map_err(|error| {
            tracing::warn!("gif provider request failed: {}", loggable(error));
            bad_gateway()
        })?;
        if !response.status().is_success() {
            tracing::warn!("gif provider answered {}", response.status());
            return Err(bad_gateway());
        }
        if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
            return Err(bad_gateway());
        }
        // Read chunk by chunk so a provider that streams without a length cannot make us buffer an unbounded body.
        let mut response = response;
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| bad_gateway())? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(bad_gateway());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| bad_gateway())
    }

    fn url(&self, path: &str, default_base: &str, params: &[(&str, &str)]) -> ApiResult<Url> {
        Url::parse_with_params(&format!("{}{path}", self.base(default_base)), params).map_err(|_| bad_gateway())
    }

    pub async fn search(&self, query: &str, limit: u32, pos: Option<&str>) -> ApiResult<GifPage> {
        self.listing(Some(query), limit, pos).await
    }

    pub async fn trending(&self, limit: u32, pos: Option<&str>) -> ApiResult<GifPage> {
        self.listing(None, limit, pos).await
    }

    async fn listing(&self, query: Option<&str>, limit: u32, pos: Option<&str>) -> ApiResult<GifPage> {
        let provider = self.config.provider;
        let key = self.config.api_key.as_str();
        let limit_text = limit.to_string();
        let pos_text = pos.unwrap_or("");
        let page = match provider {
            GifProvider::None => return Ok(GifPage { provider, results: Vec::new(), next: None }),
            GifProvider::Giphy => {
                let offset = if pos_text.is_empty() { "0" } else { pos_text };
                let mut params = vec![("api_key", key), ("limit", limit_text.as_str()), ("offset", offset), ("rating", "pg-13")];
                if let Some(query) = query {
                    params.push(("q", query));
                }
                let path = if query.is_some() { "/v1/gifs/search" } else { "/v1/gifs/trending" };
                parse_giphy(&self.fetch(self.url(path, "https://api.giphy.com", &params)?).await?)
            }
            GifProvider::Tenor => {
                let mut params = vec![("key", key), ("client_key", "vokko"), ("limit", limit_text.as_str()), ("media_filter", "gif,tinygif")];
                if !pos_text.is_empty() {
                    params.push(("pos", pos_text));
                }
                if let Some(query) = query {
                    params.push(("q", query));
                }
                let path = if query.is_some() { "/v2/search" } else { "/v2/featured" };
                parse_tenor(&self.fetch(self.url(path, "https://tenor.googleapis.com", &params)?).await?)
            }
            GifProvider::Klipy => {
                let page = if pos_text.is_empty() { "1" } else { pos_text };
                let mut params = vec![("page", page), ("per_page", limit_text.as_str()), ("customer_id", "vokko")];
                if let Some(query) = query {
                    params.push(("q", query));
                }
                let path = format!("/api/v1/{}/gifs/{}", encode_segment(key), if query.is_some() { "search" } else { "trending" });
                parse_klipy(&self.fetch(self.url(&path, "https://api.klipy.com", &params)?).await?, page)
            }
        };
        page.map(|(results, next)| GifPage { provider, results, next }).ok_or_else(bad_gateway)
    }

    pub async fn categories(&self) -> ApiResult<GifCategories> {
        let provider = self.config.provider;
        let key = self.config.api_key.as_str();
        let categories = match provider {
            GifProvider::None => Vec::new(),
            GifProvider::Giphy => parse_giphy_categories(&self.fetch(self.url("/v1/gifs/categories", "https://api.giphy.com", &[("api_key", key)])?).await?),
            GifProvider::Tenor => parse_tenor_categories(
                &self.fetch(self.url("/v2/categories", "https://tenor.googleapis.com", &[("key", key), ("client_key", "vokko")])?).await?,
            ),
            GifProvider::Klipy => {
                let path = format!("/api/v1/{}/gifs/categories", encode_segment(key));
                parse_klipy_categories(&self.fetch(self.url(&path, "https://api.klipy.com", &[("customer_id", "vokko")])?).await?)
            }
        };
        Ok(GifCategories { provider, categories })
    }
}

fn encode_segment(raw: &str) -> String {
    raw.bytes()
        .map(|byte| if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') { (byte as char).to_string() } else { format!("%{byte:02X}") })
        .collect()
}

fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn dimension(value: Option<&Value>) -> u32 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0).min(u64::from(u32::MAX)) as u32,
        Some(Value::String(text)) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

fn http_url(value: Option<&Value>) -> Option<String> {
    let url = text(value)?;
    (url.starts_with("https://") || url.starts_with("http://")).then_some(url)
}

pub fn parse_giphy(body: &Value) -> Option<(Vec<Gif>, Option<String>)> {
    let items = body.get("data")?.as_array()?;
    let results = items
        .iter()
        .filter_map(|item| {
            let images = item.get("images")?;
            let original = images.get("original")?;
            let url = http_url(original.get("url"))?;
            let preview = ["fixed_width_small", "fixed_width", "fixed_height_small"]
                .iter()
                .find_map(|name| http_url(images.get(*name)?.get("url")))
                .unwrap_or_else(|| url.clone());
            Some(Gif {
                id: format!("giphy:{}", text(item.get("id"))?),
                title: text(item.get("title")).unwrap_or_default(),
                url,
                preview_url: preview,
                width: dimension(original.get("width")),
                height: dimension(original.get("height")),
            })
        })
        .collect::<Vec<_>>();
    let pagination = body.get("pagination");
    let next = pagination.and_then(|page| {
        let offset = page.get("offset")?.as_u64()?;
        let count = page.get("count")?.as_u64()?;
        let total = page.get("total_count")?.as_u64()?;
        (count > 0 && offset + count < total).then(|| (offset + count).to_string())
    });
    Some((results, next))
}

pub fn parse_giphy_categories(body: &Value) -> Vec<GifCategory> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let image = http_url(item.get("gif")?.get("images")?.get("fixed_width_small")?.get("url"))
                        .or_else(|| http_url(item.get("gif")?.get("images")?.get("original")?.get("url")))?;
                    Some(GifCategory { name: text(item.get("name"))?, image })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_tenor(body: &Value) -> Option<(Vec<Gif>, Option<String>)> {
    let items = body.get("results")?.as_array()?;
    let results = items
        .iter()
        .filter_map(|item| {
            let formats = item.get("media_formats")?;
            let full = formats.get("gif")?;
            let url = http_url(full.get("url"))?;
            let dims = full.get("dims").and_then(Value::as_array);
            Some(Gif {
                id: format!("tenor:{}", text(item.get("id"))?),
                title: text(item.get("content_description")).or_else(|| text(item.get("title"))).unwrap_or_default(),
                preview_url: http_url(formats.get("tinygif").and_then(|format| format.get("url"))).unwrap_or_else(|| url.clone()),
                url,
                width: dimension(dims.and_then(|dims| dims.first())),
                height: dimension(dims.and_then(|dims| dims.get(1))),
            })
        })
        .collect::<Vec<_>>();
    let next = text(body.get("next")).filter(|next| !next.is_empty() && next != "0");
    Some((results, next))
}

pub fn parse_tenor_categories(body: &Value) -> Vec<GifCategory> {
    body.get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(GifCategory { name: text(item.get("searchterm")).or_else(|| text(item.get("name")))?, image: http_url(item.get("image"))? })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_klipy(body: &Value, page: &str) -> Option<(Vec<Gif>, Option<String>)> {
    let data = body.get("data")?;
    let items = data.get("data").unwrap_or(data).as_array()?;
    let pick = |file: &Value, sizes: &[&str]| -> Option<(String, u32, u32)> {
        sizes.iter().find_map(|size| {
            let format = file.get(*size)?.get("gif").or_else(|| file.get(*size)?.get("webp"))?;
            Some((http_url(format.get("url"))?, dimension(format.get("width")), dimension(format.get("height"))))
        })
    };
    let results = items
        .iter()
        .filter_map(|item| {
            let file = item.get("file")?;
            let (url, width, height) = pick(file, &["hd", "md", "sm", "xs"])?;
            let preview = pick(file, &["sm", "xs", "md", "hd"]).map(|(url, _, _)| url).unwrap_or_else(|| url.clone());
            Some(Gif {
                id: format!("klipy:{}", text(item.get("id")).or_else(|| text(item.get("slug")))?),
                title: text(item.get("title")).unwrap_or_default(),
                url,
                preview_url: preview,
                width,
                height,
            })
        })
        .collect::<Vec<_>>();
    let has_next = data.get("has_next").and_then(Value::as_bool).unwrap_or(false);
    let next = has_next.then(|| page.parse::<u64>().unwrap_or(1) + 1).map(|number| number.to_string());
    Some((results, next))
}

pub fn parse_klipy_categories(body: &Value) -> Vec<GifCategory> {
    let data = body.get("data");
    let items = data.and_then(|data| data.get("data")).or(data).and_then(Value::as_array);
    items
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(name) => Some(GifCategory { name: name.clone(), image: String::new() }),
                    Value::Object(_) => {
                        let name = text(item.get("name")).or_else(|| text(item.get("category"))).or_else(|| text(item.get("title")))?;
                        let image = ["preview_url", "image", "preview", "thumbnail"].iter().find_map(|key| http_url(item.get(*key))).unwrap_or_default();
                        Some(GifCategory { name, image })
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A request that fails to connect, with the key in the query (Giphy, Tenor) and in the path (Klipy).
    #[tokio::test]
    async fn logged_errors_never_contain_the_api_key() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().expect("client");
        for url in ["http://127.0.0.1:9/v1/gifs/search?api_key=SECRETKEY123&q=cat", "http://127.0.0.1:9/api/v1/SECRETKEY123/gifs/trending"] {
            let error = client.get(url).send().await.expect_err("nothing listens on port 9");
            assert!(error.to_string().contains("SECRETKEY123"), "the unstripped error does leak the URL, which is why loggable() exists");
            assert!(!loggable(error).contains("SECRETKEY123"));
        }
    }

    #[test]
    fn giphy_results_and_cursor() {
        let body = json!({
            "data": [
                {"id": "abc", "title": "cat", "images": {"original": {"url": "https://m.giphy.com/o.gif", "width": "480", "height": "270"}, "fixed_width_small": {"url": "https://m.giphy.com/s.gif"}}},
                {"id": "nourl", "title": "x", "images": {}}
            ],
            "pagination": {"total_count": 100, "count": 2, "offset": 0}
        });
        let (results, next) = parse_giphy(&body).expect("parses");
        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0],
            Gif {
                id: "giphy:abc".into(),
                title: "cat".into(),
                url: "https://m.giphy.com/o.gif".into(),
                preview_url: "https://m.giphy.com/s.gif".into(),
                width: 480,
                height: 270
            }
        );
        assert_eq!(next.as_deref(), Some("2"));
        let (_, last) = parse_giphy(&json!({"data": [], "pagination": {"total_count": 2, "count": 2, "offset": 0}})).expect("parses");
        assert_eq!(last, None);
        assert!(parse_giphy(&json!({"meta": {}})).is_none());
    }

    #[test]
    fn tenor_results_and_cursor() {
        let body = json!({"results": [{"id": "9", "content_description": "dog", "media_formats": {
            "gif": {"url": "https://media.tenor.com/a.gif", "dims": [320, 200]}, "tinygif": {"url": "https://media.tenor.com/t.gif"}}}], "next": "CAoQ"});
        let (results, next) = parse_tenor(&body).expect("parses");
        assert_eq!((results[0].id.as_str(), results[0].width, results[0].height), ("tenor:9", 320, 200));
        assert_eq!(results[0].preview_url, "https://media.tenor.com/t.gif");
        assert_eq!(next.as_deref(), Some("CAoQ"));
        assert_eq!(parse_tenor(&json!({"results": [], "next": ""})).expect("parses").1, None);
        let tags = parse_tenor_categories(&json!({"tags": [{"searchterm": "happy", "image": "https://x/h.gif"}, {"searchterm": "no image"}]}));
        assert_eq!(tags, vec![GifCategory { name: "happy".into(), image: "https://x/h.gif".into() }]);
    }

    #[test]
    fn klipy_results_and_cursor() {
        let body = json!({"result": true, "data": {"data": [{"id": 7, "title": "wave", "file": {
            "hd": {"gif": {"url": "https://static.klipy.com/hd.gif", "width": 400, "height": 300}},
            "sm": {"gif": {"url": "https://static.klipy.com/sm.gif", "width": 100, "height": 75}}}}], "current_page": 1, "has_next": true}});
        let (results, next) = parse_klipy(&body, "1").expect("parses");
        assert_eq!(
            (results[0].id.as_str(), results[0].url.as_str(), results[0].preview_url.as_str()),
            ("klipy:7", "https://static.klipy.com/hd.gif", "https://static.klipy.com/sm.gif")
        );
        assert_eq!(next.as_deref(), Some("2"));
        assert_eq!(parse_klipy(&json!({"data": {"data": [], "has_next": false}}), "3").expect("parses").1, None);
    }

    #[test]
    fn javascript_urls_are_dropped() {
        let body = json!({"data": [{"id": "x", "title": "", "images": {"original": {"url": "javascript:alert(1)"}}}], "pagination": {}});
        assert!(parse_giphy(&body).expect("parses").0.is_empty());
    }
}
