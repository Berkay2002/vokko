//! Reads the streams an addon returns and ranks them (docs/design/stremio-bot.md section 4.3). Pure functions, no I/O.
use std::collections::BTreeMap;

use serde_json::Value;

use crate::crypto::Secret;
use crate::voice::watch::hidden_char;

pub const LABEL_MAX_CHARS: usize = 120;
pub const DETAILS_MAX_CHARS: usize = 300;
const GIB: u64 = 1 << 30;

/// What a stream can be played from. The URL is a secret: it may be a resolver URL that carries the user's debrid setup.
#[derive(Clone, Debug)]
pub enum Source {
    Url {
        url: Secret,
        headers: BTreeMap<String, String>,
    },
    /// `torrent`, `youtube` or `external`: listed, but not playable.
    Unsupported(&'static str),
}

/// A stream as the server keeps it (never sent to a client as is).
#[derive(Clone, Debug)]
pub struct Candidate {
    pub addon: String,
    pub label: String,
    pub details: String,
    pub size_bytes: Option<u64>,
    pub resolution: Option<u32>,
    pub flags: Vec<&'static str>,
    pub source: Source,
}

impl Candidate {
    pub fn playable(&self) -> bool {
        matches!(self.source, Source::Url { .. })
    }

    fn has(&self, flag: &str) -> bool {
        self.flags.contains(&flag)
    }
}

/// Text for a label: line breaks become `separator`, control, bidi and invisible characters go, then it is cut to `max` characters.
pub fn clean_text(text: &str, separator: &str, max: usize) -> String {
    let joined = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(separator);
    let cleaned: String = joined.chars().filter(|c| !hidden_char(*c)).collect();
    cleaned.trim().chars().take(max).collect()
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()).map(str::to_lowercase).collect()
}

fn resolution_of(words: &[String]) -> Option<u32> {
    let has = |names: &[&str]| words.iter().any(|word| names.contains(&word.as_str()));
    if has(&["2160p", "4k", "uhd"]) {
        Some(2160)
    } else if has(&["1440p"]) {
        Some(1440)
    } else if has(&["1080p", "1080i"]) {
        Some(1080)
    } else if has(&["720p"]) {
        Some(720)
    } else if has(&["576p", "480p"]) {
        Some(480)
    } else {
        None
    }
}

/// `22.4 GB`, `700MB`, `1.2 TiB`: the first size in the text, in bytes.
fn size_of(text: &str) -> Option<u64> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let unit = |unit: &str| match unit.to_ascii_lowercase().as_str() {
        "mb" | "mib" => Some(1_u64 << 20),
        "gb" | "gib" => Some(GIB),
        "tb" | "tib" => Some(1_u64 << 40),
        _ => None,
    };
    for (index, part) in parts.iter().enumerate() {
        let split = part.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(part.len());
        let (number, glued) = part.split_at(split);
        let Ok(number) = number.parse::<f64>() else { continue };
        let multiplier = if glued.is_empty() { parts.get(index + 1).and_then(|next| unit(next)) } else { unit(glued) };
        if let Some(multiplier) = multiplier.filter(|_| number.is_finite() && number >= 0.0) {
            return Some((number * multiplier as f64) as u64);
        }
    }
    None
}

/// `User-Agent` and `Referer` are the only request headers handed to the bot.
fn proxy_headers(hints: &Value) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    for (name, value) in hints["proxyHeaders"]["request"].as_object().into_iter().flatten() {
        let name = match name.to_ascii_lowercase().as_str() {
            "user-agent" => "User-Agent",
            "referer" => "Referer",
            _ => continue,
        };
        if let Some(value) = value.as_str().filter(|value| value.len() <= 1024 && !value.chars().any(char::is_control)) {
            headers.insert(name.to_owned(), value.to_owned());
        }
    }
    headers
}

/// One entry of an addon's `streams`. `None` when it names no source at all.
pub fn parse_stream(addon: &str, stream: &Value) -> Option<Candidate> {
    let hints = &stream["behaviorHints"];
    let name = stream["name"].as_str().unwrap_or("");
    let description = stream["description"].as_str().or_else(|| stream["title"].as_str()).unwrap_or("");
    let filename = hints["filename"].as_str().unwrap_or("");
    let source = if let Some(url) = stream["url"].as_str() {
        // The scheme and host are judged by the fetcher (`addons::fetch_streams`), which knows the allow-list.
        if (url.starts_with("https://") || url.starts_with("http://")) && url.len() <= super::fetch::MAX_URL_LEN {
            Source::Url { url: Secret::new(url), headers: proxy_headers(hints) }
        } else {
            Source::Unsupported("external")
        }
    } else if stream["ytId"].is_string() {
        Source::Unsupported("youtube")
    } else if stream["infoHash"].is_string() {
        Source::Unsupported("torrent")
    } else if ["externalUrl", "nzbUrl", "rarUrls", "zipUrls", "7zipUrls", "tgzUrls", "tarUrls"].iter().any(|key| !stream[*key].is_null()) {
        Source::Unsupported("external")
    } else {
        return None;
    };
    let text = format!("{name}\n{description}\n{filename}");
    let words = words(&text);
    let lower = text.to_lowercase();
    let any = |names: &[&str]| words.iter().any(|word| names.contains(&word.as_str()));
    let mut flags = Vec::new();
    if any(&["remux"]) {
        flags.push("remux");
    }
    if words.iter().any(|word| word.starts_with("hdr")) {
        flags.push("hdr");
    }
    if any(&["dv", "dovi"]) || lower.contains("dolby vision") {
        flags.push("dv");
    }
    if any(&["hevc", "x265", "h265"]) || lower.contains("h.265") {
        flags.push("hevc");
    }
    if any(&["10bit"]) || lower.contains("10-bit") || lower.contains("10 bit") {
        flags.push("10bit");
    }
    let label = clean_text(name, " ", LABEL_MAX_CHARS);
    Some(Candidate {
        addon: clean_text(addon, " ", 60),
        label: if label.is_empty() { clean_text(addon, " ", LABEL_MAX_CHARS) } else { label },
        details: clean_text(description, " | ", DETAILS_MAX_CHARS),
        size_bytes: hints["videoSize"].as_u64().or_else(|| size_of(&text)),
        resolution: resolution_of(&words),
        flags,
        source,
    })
}

/// Playable first, then the resolution closest to `max_height`, then no HDR or Dolby Vision, no REMUX and a size that suits the
/// kind of title (1 to 15 GB for a movie, 0.3 to 4 GB for an episode). Ties keep the addons' order.
pub fn rank(candidates: &mut [Candidate], max_height: u32, series: bool) {
    let (low, high) = if series { (GIB * 3 / 10, 4 * GIB) } else { (GIB, 15 * GIB) };
    candidates.sort_by_key(|candidate| {
        (
            !candidate.playable(),
            candidate.resolution.map_or(u32::MAX, |resolution| resolution.abs_diff(max_height)),
            candidate.has("hdr") || candidate.has("dv"),
            candidate.has("remux"),
            candidate.size_bytes.is_some_and(|size| size < low || size > high),
        )
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // Shapes of real Torrentio TB answers, with the URLs replaced.
    fn torrentio(name: &str, title: &str) -> Value {
        json!({"name": name, "title": title, "url": "https://torrentio.example/resolve/torbox/KEY/abc/null/0/file.mkv", "behaviorHints": {"bingeGroup": "x", "filename": "file.mkv"}})
    }

    #[test]
    fn reads_torrentio_streams() {
        let stream = parse_stream(
            "Torrentio TB",
            &torrentio("[TB+] Torrentio\n1080p", "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP\n👤 52 💾 2.15 GB ⚙️ ThePirateBay"),
        )
        .expect("stream");
        assert_eq!((stream.label.as_str(), stream.resolution, stream.flags.is_empty()), ("[TB+] Torrentio 1080p", Some(1080), true));
        assert_eq!(stream.size_bytes, Some((2.15 * GIB as f64) as u64));
        assert!(stream.details.starts_with("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP | "));
        assert!(stream.playable());

        let heavy = parse_stream("T", &torrentio("[TB] 4k", "Movie.2160p.UHD.BluRay.REMUX.HDR10.DV.HEVC.10bit-GRP\n💾 58.3 GB")).expect("stream");
        assert_eq!(heavy.resolution, Some(2160));
        assert_eq!(heavy.flags, ["remux", "hdr", "dv", "hevc", "10bit"]);
        assert_eq!(heavy.size_bytes, Some((58.3 * GIB as f64) as u64));
        let dolby = parse_stream("T", &torrentio("[TB] 1080p", "Movie 1080p Dolby Vision H.265 10-bit\n700MB")).expect("stream");
        assert_eq!(dolby.flags, ["dv", "hevc", "10bit"]);
        assert_eq!(dolby.size_bytes, Some(700 << 20));
        let hint = json!({"name": "x", "url": "https://a.example/f", "behaviorHints": {"videoSize": 1234567}});
        assert_eq!(parse_stream("A", &hint).and_then(|stream| stream.size_bytes), Some(1_234_567));
    }

    #[test]
    fn classifies_sources() {
        let kind = |value: Value| {
            parse_stream("A", &value).map(|stream| match stream.source {
                Source::Url { .. } => "url",
                Source::Unsupported(kind) => kind,
            })
        };
        assert_eq!(kind(json!({"infoHash": "abc", "fileIdx": 1})), Some("torrent"));
        assert_eq!(kind(json!({"ytId": "dQw4w9WgXcQ"})), Some("youtube"));
        assert_eq!(kind(json!({"externalUrl": "https://x.example"})), Some("external"));
        assert_eq!(kind(json!({"nzbUrl": "https://x.example/a.nzb"})), Some("external"));
        assert_eq!(kind(json!({"url": "ftp://insecure.example/a.mp4"})), Some("external"));
        assert_eq!(kind(json!({"url": "https://a.example/a.mp4"})), Some("url"));
        assert_eq!(kind(json!({"name": "no source"})), None);
    }

    #[test]
    fn only_user_agent_and_referer_pass() {
        let stream = json!({"url": "https://a.example/f", "behaviorHints": {"notWebReady": true, "proxyHeaders": {"request": {
            "User-Agent": "UA", "referer": "https://r.example/", "Authorization": "Bearer x", "Cookie": "c", "X-Bad": "y"}}}});
        let Some(Candidate { source: Source::Url { headers, .. }, .. }) = parse_stream("A", &stream) else { unreachable!("url stream") };
        assert_eq!(
            headers.into_iter().collect::<Vec<_>>(),
            [("Referer".to_owned(), "https://r.example/".to_owned()), ("User-Agent".to_owned(), "UA".to_owned())]
        );
    }

    #[test]
    fn labels_lose_control_and_invisible_characters_and_are_cut() {
        let stream = parse_stream(
            "Add\u{202E}on",
            &json!({"url": "https://a.example/f", "name": format!("A\u{200B}B\u{0007}C\n{}", "x".repeat(500)), "description": "l1\nl2\u{2066}"}),
        )
        .expect("stream");
        assert_eq!(stream.addon, "Addon");
        assert!(stream.label.starts_with("ABC xxx") && stream.label.chars().count() == LABEL_MAX_CHARS);
        assert_eq!(stream.details, "l1 | l2");
    }

    #[test]
    fn ranks_by_cap_weight_and_size() {
        let make = |name: &str, title: &str, source: Value| {
            let mut value = torrentio(name, title);
            value.as_object_mut().expect("object").extend(source.as_object().cloned().unwrap_or_default());
            parse_stream("A", &value).expect("stream")
        };
        let mut list = vec![
            make("4k", "M 2160p HDR\n💾 20 GB", json!({})),
            make("torrent", "M 1080p", json!({"url": null, "infoHash": "abc"})),
            make("remux", "M 1080p REMUX\n💾 30 GB", json!({})),
            make("720", "M 720p\n💾 2 GB", json!({})),
            make("hdr", "M 1080p HDR\n💾 8 GB", json!({})),
            make("huge", "M 1080p\n💾 40 GB", json!({})),
            make("good", "M 1080p BluRay\n💾 6 GB", json!({})),
        ];
        rank(&mut list, 1080, false);
        let order: Vec<&str> = list.iter().map(|stream| stream.label.as_str()).collect();
        assert_eq!(order, ["good", "huge", "remux", "hdr", "720", "4k", "torrent"]);
        // An episode of 6 GB is out of range, so the smaller one wins at the same resolution.
        let mut episodes = vec![make("big", "E 1080p\n💾 6 GB", json!({})), make("small", "E 1080p\n💾 1 GB", json!({}))];
        rank(&mut episodes, 1080, true);
        assert_eq!(episodes[0].label, "small");
        // 1080 beats 2160 under a 720 cap.
        let mut capped = vec![make("4k", "M 2160p", json!({})), make("1080", "M 1080p", json!({}))];
        rank(&mut capped, 720, false);
        assert_eq!(capped[0].label, "1080");
    }
}
