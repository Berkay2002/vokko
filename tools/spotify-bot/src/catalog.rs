//! The two catalog reads the Web API refuses a client-credentials app (design §4.3): the tracks of a playlist and an artist's top
//! tracks, read over the librespot session. Both take a public id and have no "own" form; nothing of the account is read.

use futures_util::{StreamExt, stream};
use librespot_core::date::Date;
use librespot_core::error::ErrorKind;
use librespot_core::{Error, Session, SpotifyId, SpotifyUri};
use librespot_metadata::restriction::Restriction;
use librespot_metadata::{Artist, Metadata, Playlist, Track};
use serde::Serialize;

const TEXT_MAX_CHARS: usize = 200;
pub const PAGE_MAX: usize = 100;
/// Track metadata requests in flight at once for one read.
const PARALLEL: usize = 10;
/// And for all reads together: the account's session is shared with playback, so many catalog reads at once must not crowd it.
static METADATA: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(PARALLEL);
/// The 300 px album cover (the 64 px one is `ab67616d00004851`, 640 px `ab67616d0000b273`).
const COVER_300: &str = "ab67616d00001e02";

/// The server's `SpotifyTrack`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TrackOut {
    pub uri: String,
    pub title: String,
    pub artists: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    pub duration_ms: u64,
    pub explicit: bool,
}

#[derive(Debug, Serialize)]
pub struct PlaylistPage {
    pub name: String,
    pub total: u64,
    /// Whether Spotify itself owns the playlist: the server shows a playlist that its own Web API token cannot see only if this is true.
    pub spotify_owned: bool,
    pub tracks: Vec<TrackOut>,
}

#[derive(Debug, Serialize)]
pub struct TopTracks {
    pub tracks: Vec<TrackOut>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CatalogError {
    NotFound,
    Unavailable,
}

/// 22 letters or digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn valid_market(market: &str) -> bool {
    market.len() == 2 && market.bytes().all(|b| b.is_ascii_uppercase())
}

/// Control, bidi and invisible characters (the server's `hidden_char`, the Watch Together rule).
fn hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'
                | '\u{1160}'
                | '\u{17B4}'
                | '\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{2800}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E0FFF}'
        )
}

/// Text from Spotify: hidden characters removed, trimmed, cut to 200 characters.
pub fn clean(text: &str) -> String {
    text.chars().filter(|c| !hidden_char(*c)).collect::<String>().trim().chars().take(TEXT_MAX_CHARS).collect()
}

/// The 300 px cover's 40-hex id, else the first well-formed one.
pub fn pick_cover(ids: impl IntoIterator<Item = String>) -> Option<String> {
    let ids: Vec<String> = ids.into_iter().filter(|id| id.len() == 40 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).collect();
    ids.iter().find(|id| id.starts_with(COVER_300)).or(ids.first()).cloned()
}

/// librespot's own rule for the premium catalogue (`allowed_for_user`), with the market in place of the account's country.
pub fn playable_in<'a>(restrictions: impl IntoIterator<Item = &'a Restriction>, market: &str) -> bool {
    for restriction in restrictions.into_iter().filter(|r| r.catalogue_strs.iter().any(|c| c == "premium")) {
        if let Some(allowed) = &restriction.countries_allowed {
            return allowed.iter().any(|c| c == market);
        }
        if let Some(forbidden) = &restriction.countries_forbidden {
            return !forbidden.iter().any(|c| c == market);
        }
    }
    true
}

fn track_out(track: &Track) -> TrackOut {
    let title = clean(&track.name);
    TrackOut {
        uri: track.id.to_uri(),
        title: if title.is_empty() { "Untitled".to_owned() } else { title },
        artists: track.artists.iter().map(|a| clean(&a.name)).filter(|name| !name.is_empty()).collect(),
        album: Some(clean(&track.album.name)).filter(|name| !name.is_empty()),
        art: pick_cover(track.album.covers.iter().map(|c| c.id.to_base16())),
        duration_ms: u64::try_from(track.duration).unwrap_or(0),
        explicit: track.is_explicit,
    }
}

fn read_error(error: &Error) -> CatalogError {
    tracing::debug!(kind = ?error.kind, "catalog read failed");
    match error.kind {
        // An unknown artist comes back as FailedPrecondition, an unknown playlist as NotFound.
        ErrorKind::NotFound | ErrorKind::FailedPrecondition | ErrorKind::PermissionDenied | ErrorKind::InvalidArgument => CatalogError::NotFound,
        _ => CatalogError::Unavailable,
    }
}

/// Track metadata for `uris` in order, without what is not a track, failed to load or cannot play in `market`.
async fn tracks(session: &Session, uris: Vec<SpotifyUri>, market: &str) -> Vec<TrackOut> {
    let now = Date::now_utc();
    stream::iter(uris.into_iter().filter(|uri| matches!(uri, SpotifyUri::Track { .. })))
        .map(|uri| async move {
            let _slot = METADATA.acquire().await.ok()?;
            Track::get(session, &uri).await.ok()
        })
        .buffered(PARALLEL)
        .filter_map(|track| async move { track })
        .filter(|track| std::future::ready(track.earliest_live_timestamp <= now && playable_in(track.restrictions.iter(), market)))
        .map(|track| track_out(&track))
        .collect()
        .await
}

fn id_of(id: &str) -> Result<SpotifyId, CatalogError> {
    SpotifyId::from_base62(id).map_err(|_| CatalogError::NotFound)
}

pub async fn playlist(session: &Session, id: &str, offset: usize, limit: usize, market: &str) -> Result<PlaylistPage, CatalogError> {
    let uri = SpotifyUri::Playlist { id: id_of(id)?, user: None };
    let list = Playlist::get_range(session, &uri, offset, limit.min(PAGE_MAX)).await.map_err(|e| read_error(&e))?;
    let uris = list.contents.items.iter().map(|item| item.id.clone()).take(PAGE_MAX).collect();
    let spotify_owned = is_spotify_owner(match &list.id {
        SpotifyUri::Playlist { user: Some(owner), .. } => owner,
        _ => "",
    });
    Ok(PlaylistPage { name: clean(list.name()), total: u64::try_from(list.length).unwrap_or(0), spotify_owned, tracks: tracks(session, uris, market).await })
}

/// Playlists made by Spotify itself (Today's Top Hits, ...) have the user name `spotify`.
fn is_spotify_owner(username: &str) -> bool {
    username == "spotify"
}

pub async fn top_tracks(session: &Session, id: &str, market: &str) -> Result<TopTracks, CatalogError> {
    let artist = Artist::get(session, &SpotifyUri::Artist { id: id_of(id)? }).await.map_err(|e| read_error(&e))?;
    let top = artist.top_tracks.iter().find(|t| t.country == market).or_else(|| artist.top_tracks.iter().find(|t| t.country.is_empty()));
    let uris = top.map(|t| t.tracks.iter().take(PAGE_MAX).cloned().collect()).unwrap_or_default();
    Ok(TopTracks { tracks: tracks(session, uris, market).await })
}

#[cfg(test)]
mod tests {
    use librespot_metadata::restriction::RestrictionCatalogues;

    use super::*;

    fn restriction(catalogue: &str, allowed: Option<&[&str]>, forbidden: Option<&[&str]>) -> Restriction {
        let list = |l: &[&str]| l.iter().map(|c| (*c).to_owned()).collect();
        Restriction {
            catalogues: RestrictionCatalogues(Vec::new()),
            restriction_type: Default::default(),
            catalogue_strs: vec![catalogue.to_owned()],
            countries_allowed: allowed.map(list),
            countries_forbidden: forbidden.map(list),
        }
    }

    #[test]
    fn ids_and_markets() {
        assert!(valid_id("4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!valid_id("4uLU6hMCjMI75M1A2tKUQ"));
        assert!(!valid_id("4uLU6hMCjMI75M1A2tKUQ/"));
        assert!(!valid_id("me"));
        assert!(valid_market("SE") && !valid_market("se") && !valid_market("SWE"));
    }

    #[test]
    fn only_spotifys_own_playlists_are_spotify_owned() {
        assert!(is_spotify_owner("spotify"));
        assert!(!is_spotify_owner("Spotify") && !is_spotify_owner("spotify2") && !is_spotify_owner("") && !is_spotify_owner("someone"));
    }

    #[test]
    fn text_is_cleaned_and_cut() {
        assert_eq!(clean(" a\u{202E}b\u{0007}c "), "abc");
        assert_eq!(clean(&"x".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn the_300_px_cover_wins() {
        let small = "ab67616d00004851aaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
        let mid = "ab67616d00001e02bbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
        assert_eq!(pick_cover([small.clone(), mid.clone()]), Some(mid));
        assert_eq!(pick_cover([small.clone()]), Some(small));
        assert_eq!(pick_cover(["not hex".to_owned(), "AB67616D00001E02BBBBBBBBBBBBBBBBBBBBBBBB".to_owned()]), None);
        assert_eq!(pick_cover(Vec::new()), None);
    }

    #[test]
    fn market_restrictions() {
        assert!(playable_in(&[], "SE"));
        assert!(playable_in(&[restriction("premium", Some(&["SE", "NO"]), None)], "SE"));
        assert!(!playable_in(&[restriction("premium", Some(&["US"]), None)], "SE"));
        assert!(!playable_in(&[restriction("premium", None, Some(&["SE"]))], "SE"));
        assert!(playable_in(&[restriction("premium", None, Some(&["US"]))], "SE"));
        // Restrictions for another catalogue do not apply to the premium house account.
        assert!(playable_in(&[restriction("free", Some(&["US"]), None)], "SE"));
    }

    #[test]
    fn track_json_matches_the_server_shape() {
        let t = TrackOut {
            uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC".into(),
            title: "T".into(),
            artists: vec!["A".into()],
            album: None,
            art: Some("ab67616d00001e02bbbbbbbbbbbbbbbbbbbbbbbb".into()),
            duration_ms: 1000,
            explicit: false,
        };
        assert_eq!(
            serde_json::to_string(&t).expect("json"),
            r#"{"uri":"spotify:track:4uLU6hMCjMI75M1A2tKUQC","title":"T","artists":["A"],"art":"ab67616d00001e02bbbbbbbbbbbbbbbbbbbbbbbb","duration_ms":1000,"explicit":false}"#
        );
    }
}
