//! Addons: the protocol (`/{resource}/{type}/{id}.json`) as the server needs it. Cinemeta is the catalog; the stream lists come
//! from the addons the user installed in their own Stremio account, whose transport URLs are secrets.
use futures_util::future::join_all;
use reqwest::Url;
use serde_json::Value;
use vokko_protocol::api::{StremioMeta, StremioTitle, StremioVideo};

use super::fetch::{FetchError, Fetcher};
use super::rank::{self, Candidate, clean_text};
use crate::crypto::Secret;

const MAX_STREAMS_PER_ADDON: usize = 300;
const MAX_VIDEOS: usize = 2000;
const MAX_RESULTS: usize = 100;
/// Hosts Stremio's artwork lives on; any other image URL is dropped (the desktop CSP allows exactly these).
const IMAGE_HOSTS: [&str; 3] = ["images.metahub.space", "episodes.metahub.space", "m.media-amazon.com"];

pub fn valid_kind(kind: &str) -> bool {
    matches!(kind, "movie" | "series")
}

/// `tt` and 1 to 10 digits.
pub fn valid_title_id(id: &str) -> bool {
    id.strip_prefix("tt").is_some_and(|digits| (1..=10).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// A title id, optionally `:season:episode` (1 to 4 digits each).
pub fn valid_video_id(id: &str) -> bool {
    let mut parts = id.split(':');
    let title = parts.next().is_some_and(valid_title_id);
    let numbers: Vec<&str> = parts.collect();
    let number = |part: &&str| (1..=4).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    title && (numbers.is_empty() || (numbers.len() == 2 && numbers.iter().all(number)))
}

/// The URL when it is https on one of the Stremio image hosts.
pub fn allowed_image(url: Option<&str>) -> Option<String> {
    let url = Url::parse(url?).ok()?;
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|host| IMAGE_HOSTS.contains(&host));
    (ok && url.as_str().len() <= 500).then(|| url.to_string())
}

/// An installed addon: its name, where it lives (secret) and which streams it can answer.
#[derive(Clone, Debug)]
pub struct Addon {
    pub name: String,
    base: Secret,
    resources: Vec<Resource>,
}

#[derive(Clone, Debug)]
struct Resource {
    name: String,
    types: Vec<String>,
    id_prefixes: Option<Vec<String>>,
}

fn strings(value: &Value) -> Option<Vec<String>> {
    Some(value.as_array()?.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
}

impl Addon {
    /// An entry of `addonCollectionGet`: `{transportUrl, manifest: {name, resources, types, idPrefixes}}`.
    pub fn from_collection(entry: &Value) -> Option<Self> {
        let transport = entry["transportUrl"].as_str()?;
        let base = transport.strip_suffix("/manifest.json").unwrap_or(transport).trim_end_matches('/');
        let manifest = &entry["manifest"];
        let (types, prefixes) = (strings(&manifest["types"]).unwrap_or_default(), strings(&manifest["idPrefixes"]));
        let resources = manifest["resources"]
            .as_array()?
            .iter()
            .filter_map(|resource| match resource {
                Value::String(name) => Some(Resource { name: name.clone(), types: types.clone(), id_prefixes: prefixes.clone() }),
                Value::Object(_) => Some(Resource {
                    name: resource["name"].as_str()?.to_owned(),
                    types: strings(&resource["types"]).unwrap_or_else(|| types.clone()),
                    id_prefixes: strings(&resource["idPrefixes"]).or_else(|| prefixes.clone()),
                }),
                _ => None,
            })
            .collect();
        let name = clean_text(manifest["name"].as_str().unwrap_or("Addon"), " ", 60);
        Some(Self { name: if name.is_empty() { "Addon".to_owned() } else { name }, base: Secret::new(base), resources })
    }

    /// Whether the addon answers `resource` for this type and id.
    pub fn serves(&self, resource: &str, kind: &str, id: &str) -> bool {
        self.resources.iter().any(|entry| {
            entry.name == resource
                && entry.types.iter().any(|candidate| candidate == kind)
                && entry.id_prefixes.as_ref().is_none_or(|prefixes| prefixes.iter().any(|prefix| id.starts_with(prefix.as_str())))
        })
    }

    /// Whether the fetcher would ever call this addon (https on a public host; the local "Local Files" addon is dropped here).
    pub fn reachable(&self, fetcher: &Fetcher) -> bool {
        Url::parse(self.base.expose()).is_ok_and(|url| fetcher.check_url(&url).is_ok())
    }
}

/// Streams of every addon that serves `video_id`, fetched in parallel (8 s each, 2 MiB, 300 streams), plus the names of the
/// addons that failed. Not ranked.
pub async fn fetch_streams(fetcher: &Fetcher, addons: &[Addon], kind: &str, video_id: &str) -> (Vec<Candidate>, Vec<String>) {
    let calls = addons.iter().filter(|addon| addon.serves("stream", kind, video_id)).map(|addon| async move {
        let url = format!("{}/stream/{kind}/{video_id}.json", addon.base.expose());
        let answer = fetcher.get_json(&url).await;
        (addon, answer)
    });
    let mut candidates = Vec::new();
    let mut failed = Vec::new();
    for (addon, answer) in join_all(calls).await {
        match answer {
            Ok(body) => {
                let streams = body["streams"].as_array().map(Vec::as_slice).unwrap_or_default();
                candidates.extend(streams.iter().take(MAX_STREAMS_PER_ADDON).filter_map(|stream| rank::parse_stream(&addon.name, stream)));
            }
            Err(error) => {
                // The addon's name only; its URL path carries the user's configuration.
                tracing::info!("stremio: addon {} failed for {kind}: {error:?}", addon.name);
                failed.push(addon.name.clone());
            }
        }
    }
    (candidates, failed)
}

fn catalog_url(base: &str, segments: &[&str]) -> Result<Url, FetchError> {
    let mut url = Url::parse(base).map_err(|_| FetchError::Blocked)?;
    url.path_segments_mut().map_err(|()| FetchError::Blocked)?.pop_if_empty().extend(segments);
    Ok(url)
}

fn text(value: &Value, key: &str, max: usize) -> Option<String> {
    Some(clean_text(value[key].as_str()?, " ", max)).filter(|text| !text.is_empty())
}

fn title_of(meta: &Value, kind: &str) -> Option<StremioTitle> {
    let id = meta["id"].as_str().filter(|id| valid_title_id(id))?;
    Some(StremioTitle {
        id: id.to_owned(),
        kind: kind.to_owned(),
        name: text(meta, "name", 200)?,
        poster: allowed_image(meta["poster"].as_str()),
        year: text(meta, "releaseInfo", 20),
    })
}

/// Cinemeta `top` search or browse. `extra` is the part after the catalog name (`search=heat`, `genre=Action&skip=20`).
pub async fn catalog(fetcher: &Fetcher, cinemeta: &str, kind: &str, extra: Option<String>) -> Result<Vec<StremioTitle>, FetchError> {
    let url = match extra {
        Some(extra) => catalog_url(cinemeta, &["catalog", kind, "top", &format!("{extra}.json")])?,
        None => catalog_url(cinemeta, &["catalog", kind, "top.json"])?,
    };
    let body = fetcher.get_json(url.as_str()).await?;
    Ok(body["metas"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|meta| title_of(meta, kind)).take(MAX_RESULTS).collect())
}

pub async fn meta(fetcher: &Fetcher, cinemeta: &str, kind: &str, id: &str) -> Result<StremioMeta, FetchError> {
    let url = catalog_url(cinemeta, &["meta", kind, &format!("{id}.json")])?;
    let body = fetcher.get_json(url.as_str()).await?;
    let meta = &body["meta"];
    let name = text(meta, "name", 200).ok_or(FetchError::Invalid)?;
    let videos = meta["videos"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|video| {
            let id = video["id"].as_str().filter(|id| valid_video_id(id) && id.contains(':'))?;
            let season = u32::try_from(video["season"].as_u64()?).ok()?;
            let episode = u32::try_from(video["episode"].as_u64()?).ok()?;
            Some(StremioVideo {
                id: id.to_owned(),
                season,
                episode,
                name: text(video, "name", 200).or_else(|| text(video, "title", 200)).unwrap_or_else(|| format!("Episode {episode}")),
                released: text(video, "released", 40),
                thumbnail: allowed_image(video["thumbnail"].as_str()),
            })
        })
        .take(MAX_VIDEOS)
        .collect();
    Ok(StremioMeta {
        id: id.to_owned(),
        kind: kind.to_owned(),
        name,
        poster: allowed_image(meta["poster"].as_str()),
        background: allowed_image(meta["background"].as_str()),
        description: text(meta, "description", 2000),
        year: text(meta, "releaseInfo", 20).or_else(|| text(meta, "year", 20)),
        runtime: text(meta, "runtime", 40),
        videos,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn ids_and_images_are_validated() {
        for good in ["tt0111161", "tt1", "tt0903747:1:2", "tt0903747:12:1234"] {
            assert!(valid_video_id(good), "{good}");
        }
        for bad in ["", "tt", "tt12345678901", "xx123", "tt1:1", "tt1:1:2:3", "tt1:a:2", "tt1:12345:1", "tt1/../x", "tt1:1:2 ", "TT1"] {
            assert!(!valid_video_id(bad), "{bad}");
        }
        assert!(valid_title_id("tt0111161") && !valid_title_id("tt0111161:1:2"));
        for good in ["https://images.metahub.space/poster/small/tt1/img", "https://m.media-amazon.com/images/M/x.jpg", "https://episodes.metahub.space/a.jpg"] {
            assert!(allowed_image(Some(good)).is_some(), "{good}");
        }
        for bad in [
            "http://images.metahub.space/x",
            "https://evil.example/x.jpg",
            "https://images.metahub.space.evil.example/x",
            "https://user@images.metahub.space/x",
            "https://images.metahub.space:8443/x",
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
            "//images.metahub.space/x",
        ] {
            assert!(allowed_image(Some(bad)).is_none(), "{bad}");
        }
        assert!(allowed_image(None).is_none());
    }

    fn addon(manifest: Value) -> Addon {
        Addon::from_collection(&json!({"transportUrl": "https://torrentio.example/KEY/manifest.json", "manifest": manifest})).expect("addon")
    }

    #[test]
    fn addons_serve_what_their_manifest_says() {
        let torrentio = addon(json!({"name": "Torrentio", "resources": ["catalog", "stream"], "types": ["movie", "series"], "idPrefixes": ["tt", "kitsu"]}));
        assert!(torrentio.serves("stream", "movie", "tt1") && torrentio.serves("stream", "series", "tt1:1:2"));
        assert!(!torrentio.serves("meta", "movie", "tt1") && !torrentio.serves("stream", "anime", "tt1") && !torrentio.serves("stream", "movie", "yt1"));
        assert_eq!(torrentio.base.expose(), "https://torrentio.example/KEY");
        let objects = addon(
            json!({"name": "Obj", "resources": [{"name": "stream", "types": ["movie"], "idPrefixes": ["tt"]}, {"name": "meta", "types": ["series"]}], "types": ["series"]}),
        );
        assert!(objects.serves("stream", "movie", "tt9") && !objects.serves("stream", "series", "tt9"));
        assert!(objects.serves("meta", "series", "anything"), "no idPrefixes: every id");
        let local = Addon::from_collection(
            &json!({"transportUrl": "http://127.0.0.1:11470/local-addon/manifest.json", "manifest": {"name": "Local Files", "resources": ["stream"], "types": ["movie"]}}),
        )
        .expect("addon");
        assert!(!local.reachable(&Fetcher::new(Vec::new())) && torrentio.reachable(&Fetcher::new(Vec::new())));
        assert!(Addon::from_collection(&json!({"manifest": {}})).is_none());
    }

    #[test]
    fn catalog_urls_encode_the_query() {
        let url = catalog_url("https://v3-cinemeta.strem.io", &["catalog", "movie", "top", "search=a b/c?d&e.json"]).expect("url");
        assert_eq!(url.as_str(), "https://v3-cinemeta.strem.io/catalog/movie/top/search=a%20b%2Fc%3Fd&e.json");
        let url = catalog_url("http://127.0.0.1:9/base/", &["meta", "movie", "tt1.json"]).expect("url");
        assert_eq!(url.path(), "/base/meta/movie/tt1.json");
    }

    #[test]
    fn titles_keep_only_safe_fields() {
        let meta = json!({"id": "tt1", "name": "Heat", "poster": "https://evil.example/p.jpg", "releaseInfo": "1995"});
        let title = title_of(&meta, "movie").expect("title");
        assert_eq!((title.name.as_str(), title.poster, title.year.as_deref()), ("Heat", None, Some("1995")));
        assert!(title_of(&json!({"id": "yt_x", "name": "X"}), "movie").is_none());
        assert!(title_of(&json!({"id": "tt1"}), "movie").is_none());
    }
}
