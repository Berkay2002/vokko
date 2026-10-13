//! Link unfurling: finds URLs in a message, fetches them behind an SSRF guard and turns Open Graph / Twitter card meta
//! tags into `Embed`s. Results are stored on the message and arrive at clients as MESSAGE_UPDATE after the create.
//!
//! Limits: 5 URLs per message, 5 s per URL (connect, redirects and body together), 1 MiB of body, 3 redirects.
//! The guard rejects non-public addresses for URL literals and, through the resolver, for every hop's DNS answers.
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION};
use tokio::task::JoinSet;
use vokko_protocol::api::{Embed, EmbedMedia, EmbedProvider, EmbedType, SUPPRESS_EMBEDS};

use crate::routes::messages::broadcast_update;
use crate::state::AppState;
use crate::store::ChannelRow;

pub const MAX_URLS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BODY: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_URL_LEN: usize = 2048;
const MAX_TITLE: usize = 256;
const MAX_DESCRIPTION: usize = 350;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; VokkoBot/0.1; link preview)";
const ACCEPT_VALUE: &str = "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8";

#[derive(Clone, Copy, Debug)]
pub struct UnfurlConfig {
    pub enabled: bool,
    /// Test seam and LAN deployments: lets the fetcher reach loopback / private addresses.
    pub allow_private: bool,
}

impl Default for UnfurlConfig {
    fn default() -> Self {
        Self { enabled: true, allow_private: false }
    }
}

// ---- URL extraction ----

/// Replaces `code` and ```fenced``` spans with a space so URLs inside them are ignored.
fn strip_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find('`') {
        out.push_str(&rest[..start]);
        let ticks = rest[start..].bytes().take_while(|byte| *byte == b'`').count();
        let fence = &rest[start..start + ticks];
        let after = &rest[start + ticks..];
        match after.find(fence) {
            Some(end) => {
                out.push(' ');
                rest = &after[end + ticks..];
            }
            None => {
                out.push_str(&rest[start..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn trim_url(mut url: &str) -> &str {
    loop {
        let Some(last) = url.chars().next_back() else { return url };
        let strip = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '*' | '_' | '~' | '|' => true,
            ')' => url.matches(')').count() > url.matches('(').count(),
            ']' => url.matches(']').count() > url.matches('[').count(),
            '}' => url.matches('}').count() > url.matches('{').count(),
            _ => false,
        };
        if !strip {
            return url;
        }
        url = &url[..url.len() - last.len_utf8()];
    }
}

/// Up to [`MAX_URLS`] distinct http(s) URLs in order of appearance, skipping code, `<url>` and invite links.
pub fn extract_urls(content: &str) -> Vec<Url> {
    let text = strip_code(content);
    let lower = text.to_ascii_lowercase();
    let mut found: Vec<Url> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut from = 0;
    while found.len() < MAX_URLS {
        let Some(offset) = lower[from..].find("http") else { break };
        let start = from + offset;
        from = start + 4;
        if !(lower[start..].starts_with("https://") || lower[start..].starts_with("http://")) {
            continue;
        }
        let previous = text[..start].chars().next_back();
        if previous.is_some_and(char::is_alphanumeric) {
            continue;
        }
        if previous == Some('<') {
            // `<url>` opts out of the embed
            from = text[start..].find('>').map_or(text.len(), |end| start + end);
            continue;
        }
        let end = text[start..].find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c.is_control()).map_or(text.len(), |end| start + end);
        from = end.max(from);
        let candidate = trim_url(&text[start..end]);
        if candidate.len() > MAX_URL_LEN {
            continue;
        }
        let Ok(url) = Url::parse(candidate) else { continue };
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            continue;
        }
        let path = url.path().to_ascii_lowercase();
        if path.starts_with("/invite/") || path.starts_with("/invites/") {
            continue;
        }
        if seen.insert(url.to_string()) {
            found.push(url);
        }
    }
    found
}

// ---- SSRF guard ----

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

/// False for loopback, private, link-local, CGNAT, multicast, documentation and other non-routable addresses,
/// including IPv4 addresses wrapped in IPv6 (mapped, compatible, NAT64, 6to4).
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    // ::a.b.c.d (IPv4-compatible)
    if s[..6].iter().all(|segment| *segment == 0) {
        return false;
    }
    // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) carry an IPv4 address
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|segment| *segment == 0) {
        return is_public_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
    }
    if s[0] == 0x2002 {
        return is_public_v4(Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8));
    }
    let first = s[0];
    !((first & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (first & 0xffc0) == 0xfe80 // fe80::/10 link local
        || (first & 0xffc0) == 0xfec0 // fec0::/10 site local
        || (first & 0xff00) == 0xff00 // multicast
        || (first == 0x2001 && s[1] == 0x0db8) // documentation
        || (first == 0x2001 && s[1] == 0) // Teredo
        || (first == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0)) // discard-only
}

pub(crate) fn host_allowed(url: &Url, allow_private: bool) -> bool {
    if allow_private {
        return true;
    }
    let Some(host) = url.host_str() else { return false };
    // The URL parser has already normalised numeric hosts (2130706433, 0x7f.1) to dotted decimal.
    if let Ok(ip) = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        return is_public_ip(ip);
    }
    let domain = host.trim_end_matches('.').to_ascii_lowercase();
    domain != "localhost" && !domain.ends_with(".localhost") && !domain.ends_with(".local") && !domain.ends_with(".internal")
}

/// Resolves through the system resolver and drops every non-public answer, so each redirect hop is checked again.
pub(crate) struct GuardedResolver {
    pub(crate) allow_private: bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_private = self.allow_private;
        Box::pin(async move {
            let host = name.as_str().to_owned();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|addr| allow_private || is_public_ip(addr.ip())).collect();
            if addrs.is_empty() {
                return Err("host does not resolve to a public address".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

// ---- HTML → Embed ----

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest[1..].find(';').filter(|end| *end <= 10).and_then(|end| {
            let entity = &rest[1..1 + end];
            let character = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => entity.strip_prefix('#').and_then(|number| {
                    let code = match number.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => number.parse().ok()?,
                    };
                    char::from_u32(code)
                }),
            };
            character.map(|character| (character, end + 2))
        });
        match decoded {
            Some((character, consumed)) => {
                out.push(character);
                rest = &rest[consumed..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Collapses whitespace and cuts to `max` characters; `None` when nothing is left.
fn clean_text(text: &str, max: usize) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= max {
        return Some(collapsed);
    }
    let mut cut: String = collapsed.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    Some(cut)
}

fn parse_attrs(tag: &str) -> Vec<(String, String)> {
    let bytes = tag.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' && bytes[i] != b'/' {
            i += 1;
        }
        if name_start == i {
            i += 1;
            continue;
        }
        let name = tag[name_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = "";
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let value_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = &tag[value_start..i];
                i += 1;
            } else {
                let value_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = &tag[value_start..i];
            }
        }
        attrs.push((name, decode_entities(value)));
    }
    attrs
}

/// Index of the `>` that closes the tag opened at `start`, skipping quoted attribute values.
fn tag_end(html: &str, start: usize) -> usize {
    let bytes = html.as_bytes();
    let mut i = start + 1;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        match (quote, bytes[i]) {
            (Some(open), byte) if byte == open => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(bytes[i]),
            (None, b'>') => return i,
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

#[derive(Default)]
struct Head {
    /// `property` / `name` (lowercased) → `content`, in document order.
    tags: Vec<(String, String)>,
    title: Option<String>,
}

impl Head {
    fn first(&self, keys: &[&str]) -> Option<&str> {
        keys.iter().find_map(|key| self.tags.iter().find(|(name, value)| name == key && !value.trim().is_empty()).map(|(_, value)| value.as_str()))
    }
}

fn scan_head(html: &str) -> Head {
    let lower = html.to_ascii_lowercase();
    let mut head = Head::default();
    let mut position = 0;
    while let Some(offset) = lower[position..].find('<') {
        let start = position + offset;
        let rest = &lower[start..];
        if rest.starts_with("<!--") {
            position = lower[start + 4..].find("-->").map_or(lower.len(), |end| start + 4 + end + 3);
            continue;
        }
        if rest.starts_with("</head") || rest.starts_with("<body") {
            break;
        }
        let name_end = rest[1..].find(|c: char| c.is_whitespace() || c == '>' || c == '/').map_or(rest.len(), |end| end + 1);
        let name = &rest[1..name_end];
        let end = tag_end(html, start);
        match name {
            "meta" => {
                let attrs = parse_attrs(&html[(start + 1 + name.len()).min(end)..end]);
                let content = attrs.iter().find(|(key, _)| key == "content").map(|(_, value)| value.clone());
                if let Some(content) = content {
                    for (key, value) in &attrs {
                        if key == "property" || key == "name" {
                            head.tags.push((value.trim().to_ascii_lowercase(), content.clone()));
                        }
                    }
                }
            }
            "title" if head.title.is_none() => {
                let text_start = (end + 1).min(lower.len());
                let text_end = lower[text_start..].find("</title").map_or(lower.len(), |close| text_start + close);
                head.title = Some(decode_entities(&html[text_start..text_end]));
                position = text_end;
                continue;
            }
            "script" | "style" => {
                let text_start = (end + 1).min(lower.len());
                let closing = format!("</{name}");
                position = lower[text_start..].find(&closing).map_or(lower.len(), |close| text_start + close);
                continue;
            }
            _ => {}
        }
        position = (end + 1).min(lower.len());
    }
    head
}

fn media(base: &Url, value: Option<&str>, width: Option<&str>, height: Option<&str>) -> Option<EmbedMedia> {
    let url = base.join(value?.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.as_str().len() > MAX_URL_LEN {
        return None;
    }
    let dimension = |value: Option<&str>| value.and_then(|text| text.trim().parse::<u32>().ok()).filter(|size| (1..=16_384).contains(size));
    Some(EmbedMedia { url: url.to_string(), proxy_url: None, width: dimension(width), height: dimension(height) })
}

fn theme_color(value: &str) -> Option<u32> {
    let hex = value.trim().strip_prefix('#')?;
    match hex.len() {
        6 => u32::from_str_radix(hex, 16).ok(),
        3 => {
            let short = u32::from_str_radix(hex, 16).ok()?;
            let (r, g, b) = ((short >> 8) & 0xf, (short >> 4) & 0xf, short & 0xf);
            Some(((r * 17) << 16) | ((g * 17) << 8) | (b * 17))
        }
        _ => None,
    }
}

/// `original` is the URL as written in the message, `page` the final URL after redirects (base for relative media URLs).
fn embed_from_html(original: &Url, page: &Url, html: &str) -> Option<Embed> {
    let head = scan_head(html);
    let title = head.first(&["og:title", "twitter:title"]).or(head.title.as_deref()).and_then(|text| clean_text(text, MAX_TITLE));
    let description = head.first(&["og:description", "twitter:description", "description"]).and_then(|text| clean_text(text, MAX_DESCRIPTION));
    let image = media(
        page,
        head.first(&["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]),
        head.first(&["og:image:width"]),
        head.first(&["og:image:height"]),
    );
    let video = media(
        page,
        head.first(&["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"]),
        head.first(&["og:video:width"]),
        head.first(&["og:video:height"]),
    );
    if title.is_none() && description.is_none() && image.is_none() && video.is_none() {
        return None;
    }
    let og_type = head.first(&["og:type"]).map(str::to_ascii_lowercase).unwrap_or_default();
    let kind = if video.is_some() && og_type.starts_with("video") {
        EmbedType::Video
    } else if og_type == "article" {
        EmbedType::Article
    } else {
        EmbedType::Link
    };
    let large = head.first(&["twitter:card"]).is_some_and(|card| card.eq_ignore_ascii_case("summary_large_image"));
    let (image, thumbnail) = if large && video.is_none() { (image, None) } else { (None, image) };
    let provider = head
        .first(&["og:site_name"])
        .and_then(|name| clean_text(name, 100))
        .map(|name| EmbedProvider { name: Some(name), url: Some(page.origin().ascii_serialization()).filter(|origin| origin != "null") });
    Some(Embed {
        kind,
        title,
        description,
        url: Some(original.to_string()),
        timestamp: None,
        color: head.first(&["theme-color"]).and_then(theme_color),
        footer: None,
        image,
        thumbnail,
        video,
        provider,
        author: None,
        fields: None,
    })
}

fn embed_for_image(original: &Url, page: &Url) -> Embed {
    Embed {
        kind: EmbedType::Image,
        title: None,
        description: None,
        url: Some(original.to_string()),
        timestamp: None,
        color: None,
        footer: None,
        image: None,
        thumbnail: Some(EmbedMedia { url: page.to_string(), proxy_url: None, width: None, height: None }),
        video: None,
        provider: None,
        author: None,
        fields: None,
    }
}

// ---- fetching ----

pub struct Unfurler {
    client: Option<reqwest::Client>,
    allow_private: bool,
}

impl Unfurler {
    pub fn new(config: UnfurlConfig) -> Self {
        // reqwest is built without a bundled provider; installing twice is harmless.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(GuardedResolver { allow_private: config.allow_private })
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .ok();
        Self { client, allow_private: config.allow_private }
    }

    /// One embed for one URL, or `None` (blocked, unreachable, slow, not a page, nothing to show).
    pub async fn embed(&self, url: Url) -> Option<Embed> {
        let client = self.client.as_ref()?;
        tokio::time::timeout(TIMEOUT, self.fetch(client, url)).await.ok().flatten()
    }

    async fn fetch(&self, client: &reqwest::Client, original: Url) -> Option<Embed> {
        let mut url = original.clone();
        for _ in 0..=MAX_REDIRECTS {
            if !matches!(url.scheme(), "http" | "https") || !host_allowed(&url, self.allow_private) {
                return None;
            }
            let response = client.get(url.clone()).header(ACCEPT, ACCEPT_VALUE).send().await.ok()?;
            let status = response.status();
            if status.is_redirection() {
                let location = response.headers().get(LOCATION)?.to_str().ok()?;
                url = url.join(location).ok()?;
                continue;
            }
            if !status.is_success() {
                return None;
            }
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
                .unwrap_or_default();
            if content_type.starts_with("image/") {
                return Some(embed_for_image(&original, &url));
            }
            if content_type != "text/html" && content_type != "application/xhtml+xml" {
                return None;
            }
            let body = read_capped(response).await?;
            return embed_from_html(&original, &url, &String::from_utf8_lossy(&body));
        }
        None
    }
}

async fn read_capped(mut response: reqwest::Response) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        let room = MAX_BODY - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= MAX_BODY {
            break;
        }
    }
    Some(body)
}

// ---- message integration ----

/// Unfurls `content` in the background and delivers the result as MESSAGE_UPDATE. `keep` are embeds already on the
/// message whose URL is still present (not fetched again). Does nothing when there is nothing new to fetch.
pub fn spawn(state: &AppState, channel: ChannelRow, message_id: i64, content: String, keep: Vec<Embed>) {
    if !state.config.unfurl.enabled {
        return;
    }
    let urls = extract_urls(&content);
    if urls.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move { deliver(state, channel, message_id, content, urls, keep).await });
}

async fn deliver(state: AppState, channel: ChannelRow, message_id: i64, content: String, urls: Vec<Url>, keep: Vec<Embed>) {
    let have: HashSet<&str> = keep.iter().filter_map(|embed| embed.url.as_deref()).collect();
    let mut tasks = JoinSet::new();
    for (index, url) in urls.iter().enumerate() {
        if have.contains(url.as_str()) {
            continue;
        }
        let state = state.clone();
        let url = url.clone();
        tasks.spawn(async move { (index, state.unfurler.embed(url).await) });
    }
    if tasks.is_empty() {
        return;
    }
    let mut all: Vec<(usize, Embed)> = Vec::new();
    while let Some(done) = tasks.join_next().await {
        if let Ok((index, Some(embed))) = done {
            all.push((index, embed));
        }
    }
    if all.is_empty() {
        return;
    }
    for embed in keep {
        if let Some(index) = urls.iter().position(|url| embed.url.as_deref() == Some(url.as_str())) {
            all.push((index, embed));
        }
    }
    all.sort_by_key(|(index, _)| *index);
    let embeds: Vec<Embed> = all.into_iter().map(|(_, embed)| embed).collect();
    let Ok(json) = serde_json::to_string(&embeds) else { return };
    // Only if the message still has this content and was not suppressed meanwhile.
    let updated = sqlx::query("UPDATE messages SET embeds = $2::jsonb WHERE id = $1 AND content = $3 AND (flags & $4) = 0")
        .bind(message_id)
        .bind(json)
        .bind(&content)
        .bind(SUPPRESS_EMBEDS as i32)
        .execute(&state.db)
        .await;
    if updated.is_ok_and(|result| result.rows_affected() > 0)
        && let Err(error) = broadcast_update(&state, &channel, message_id).await
    {
        tracing::warn!("unfurl update for message {message_id} failed: {}", error.body.message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(content: &str) -> Vec<String> {
        extract_urls(content).into_iter().map(|url| url.to_string()).collect()
    }

    #[test]
    fn extracts_plain_urls_and_trims_punctuation() {
        assert_eq!(
            urls("see https://example.com/a, and (https://example.com/b_(c)). Also http://x.io!"),
            ["https://example.com/a", "https://example.com/b_(c)", "http://x.io/"]
        );
        assert_eq!(urls("**https://example.com/bold**"), ["https://example.com/bold"]);
        assert_eq!(urls("||https://example.com/spoiler||"), ["https://example.com/spoiler"]);
    }

    #[test]
    fn skips_code_wrapped_invite_and_duplicate_urls() {
        assert!(urls("`https://example.com/a`").is_empty());
        assert!(urls("```\nhttps://example.com/a\n```").is_empty());
        assert!(urls("<https://example.com/a>").is_empty());
        assert_eq!(urls("<https://example.com/a> https://example.com/b"), ["https://example.com/b"]);
        assert!(urls("https://vokko.example/invite/abc123").is_empty());
        assert_eq!(urls("https://example.com/a https://example.com/a"), ["https://example.com/a"]);
        assert!(urls("ftp://example.com/a and xhttps://example.com/b and https://user:pw@example.com/").is_empty());
        assert_eq!(urls("`https://example.com/a` https://example.com/b"), ["https://example.com/b"]);
    }

    #[test]
    fn caps_at_five_urls() {
        let content = (1..=9).map(|n| format!("https://example.com/{n}")).collect::<Vec<_>>().join(" ");
        assert_eq!(extract_urls(&content).len(), MAX_URLS);
    }

    #[test]
    fn public_address_table() {
        let blocked = [
            "0.0.0.0",
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "2001:db8::1",
        ];
        for text in blocked {
            let ip: IpAddr = text.parse().expect("ip literal");
            assert!(!is_public_ip(ip), "{text} must be blocked");
        }
        for text in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001::200e"] {
            let ip: IpAddr = text.parse().expect("ip literal");
            assert!(is_public_ip(ip), "{text} must be allowed");
        }
    }

    #[tokio::test]
    async fn resolver_drops_non_public_answers() {
        let name = || "localhost".parse::<Name>().expect("valid name");
        assert!(GuardedResolver { allow_private: false }.resolve(name()).await.is_err(), "loopback answers are filtered out");
        let addrs: Vec<SocketAddr> = GuardedResolver { allow_private: true }.resolve(name()).await.expect("resolves").collect();
        assert!(!addrs.is_empty() && addrs.iter().all(|addr| addr.ip().is_loopback()));
    }

    #[test]
    fn literal_hosts_are_checked_before_any_request() {
        let blocked = [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://[::1]/",
            "http://2130706433/",
            "http://0x7f.1/",
            "http://foo.localhost/",
            "http://169.254.169.254/latest",
        ];
        for text in blocked {
            let url = Url::parse(text).expect("url");
            assert!(!host_allowed(&url, false), "{text} must be blocked");
            assert!(host_allowed(&url, true), "{text} passes when private hosts are allowed");
        }
        assert!(host_allowed(&Url::parse("https://example.com/").expect("url"), false));
    }

    #[test]
    fn open_graph_page_becomes_a_link_embed() {
        let html = r##"<!doctype html><html><head>
            <title>Fallback &amp; title</title>
            <meta property="og:title" content="Vokko &quot;chat&quot;">
            <meta property='og:description' content="  Open   source
              chat  ">
            <meta property="og:image" content="/img/card.png">
            <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
            <meta property="og:site_name" content="Vokko">
            <meta name="twitter:card" content="summary_large_image">
            <meta name="theme-color" content="#5865f2">
            <script>var x = "<meta property='og:title' content='no'>";</script>
            </head><body><meta property="og:title" content="late"></body></html>"##;
        let original = Url::parse("https://vokko.example/x").expect("url");
        let page = Url::parse("https://vokko.example/x?r=1").expect("url");
        let embed = embed_from_html(&original, &page, html).expect("embed");
        assert_eq!(embed.kind, EmbedType::Link);
        assert_eq!(embed.title.as_deref(), Some("Vokko \"chat\""));
        assert_eq!(embed.description.as_deref(), Some("Open source chat"));
        assert_eq!(embed.url.as_deref(), Some("https://vokko.example/x"));
        let image = embed.image.expect("large card uses image");
        assert_eq!((image.url.as_str(), image.width, image.height), ("https://vokko.example/img/card.png", Some(1200), Some(630)));
        assert!(embed.thumbnail.is_none());
        assert_eq!(embed.color, Some(0x5865f2));
        let provider = embed.provider.expect("provider");
        assert_eq!((provider.name.as_deref(), provider.url.as_deref()), (Some("Vokko"), Some("https://vokko.example")));
    }

    #[test]
    fn title_tag_fallback_thumbnail_and_nothing_to_show() {
        let original = Url::parse("https://example.com/").expect("url");
        let embed = embed_from_html(
            &original,
            &original,
            "<html><head><title>Plain</title><meta property=og:image content=//cdn.example.com/a.jpg><meta property=og:type content=article></head>",
        )
        .expect("embed");
        assert_eq!(embed.kind, EmbedType::Article);
        assert_eq!(embed.title.as_deref(), Some("Plain"));
        assert_eq!(embed.thumbnail.expect("thumbnail").url, "https://cdn.example.com/a.jpg");
        assert!(embed_from_html(&original, &original, "<html><head></head><body>hi</body></html>").is_none());
        // javascript: and data: media are dropped
        assert!(embed_from_html(&original, &original, "<head><meta property=og:image content=\"javascript:alert(1)\"></head>").is_none());
    }

    #[test]
    fn entities_and_text_cleanup() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt; &#39;d&#39; &#x1F600; &bogus; &"), "a & b <c> 'd' 😀 &bogus; &");
        assert_eq!((theme_color("#fff"), theme_color("#5865f2"), theme_color("blue"), theme_color("#12")), (Some(0xffffff), Some(0x5865f2), None, None));
        assert_eq!(clean_text("   ", 10), None);
        assert_eq!(clean_text("abcdefghij", 5).as_deref(), Some("abcd…"));
    }
}
