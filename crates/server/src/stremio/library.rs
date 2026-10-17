//! The linked account's Stremio library (`datastoreGet` / `datastorePut`, collection `libraryItem`): the "Continue watching" row
//! read from it, and the position written back to it when a session item ends or stops, so Stremio on the user's TV continues there.
//!
//! The library API is undocumented. Shape and update rules come from stremio-core at commit
//! c4806e8614452fd49d5dbb22db74afa88959b554 (github.com/Stremio/stremio-core):
//! - `src/types/library/library_item.rs`: `LibraryItem` / `LibraryItemState` (camelCase keys, `_id`, `_ctime`, `_mtime`; the one
//!   snake_case key is `state.video_id`), `is_in_continue_watching`, `advance_to_video`;
//! - `src/models/player.rs`: `TimeChanged` (what playing does to the state) and `item_state_update` (what passing the credits does);
//! - `src/models/ctx/update_library.rs` (`push_items_to_api`, the `Put { changes }` body), `src/models/ctx/ctx.rs` (the full read is
//!   `Get { ids: [], all: true }`) and `src/models/continue_watching_preview.rs` (newest `_mtime` first);
//! - `src/constants.rs`: `WATCHED_THRESHOLD_COEF` 0.7, `CREDITS_THRESHOLD_COEF` 0.9.
//!
//! Items are handled as raw JSON, never through a typed struct: a write changes only the fields below and keeps every other field
//! (a typed round trip would drop what this server does not know). An item that does not have the expected shape is not written.
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::{StremioContinueItem, StremioMeta};

use super::addons::{allowed_image, valid_kind, valid_title_id, valid_video_id};
use super::client::AccountError;
use super::rank::clean_text;
use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::store::iso;
use crate::stremio::{account_error, active, cached_meta, drop_key, limit, load_key};
use axum::Json;
use axum::extract::State;

/// Cards in the row.
const MAX_ROW: usize = 20;
/// stremio-core `WATCHED_THRESHOLD_COEF`: watching this share of the duration flags the video as watched.
const WATCHED_COEF: f64 = 0.7;
/// stremio-core `CREDITS_THRESHOLD_COEF`: past this share the video is over and the next one is queued up.
const CREDITS_COEF: f64 = 0.9;
/// Shorter positions are not saved: someone who tried a stream and left should not create a library item.
const MIN_SAVE_MS: u64 = 10_000;

// ---- the row ----

/// `GET /stremio/continue`: the caller's own Continue watching. Unlinked (or a dead key) is an empty row.
pub async fn continue_watching(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<StremioContinueItem>>> {
    let active = active(&state)?;
    limit(&state, "stremio-continue", user_id, 5.0, 0.2)?;
    let Some((key, _)) = load_key(&state, &active, user_id).await? else { return Ok(Json(Vec::new())) };
    match active.clients.account.library_all(&key).await {
        Ok(items) => Ok(Json(continue_row(&items))),
        Err(AccountError::SessionGone) => {
            drop_key(&state, user_id).await;
            Ok(Json(Vec::new()))
        }
        Err(error) => Err(account_error(error)),
    }
}

/// Titles with progress, newest first. The rule is stremio-core's `is_in_continue_watching`: not removed, or temporary (watched
/// without being added to the library), with a time offset. Only ids the Stremio panel can open (`tt…`) are kept.
pub fn continue_row(items: &[Value]) -> Vec<StremioContinueItem> {
    let mut rows: Vec<(OffsetDateTime, StremioContinueItem)> = items.iter().filter_map(row).collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.0));
    rows.into_iter().take(MAX_ROW).map(|(_, row)| row).collect()
}

fn row(item: &Value) -> Option<(OffsetDateTime, StremioContinueItem)> {
    let kind = item["type"].as_str().filter(|kind| valid_kind(kind))?;
    let id = item["_id"].as_str().filter(|id| valid_title_id(id))?;
    let (removed, temp) = (item["removed"].as_bool()?, item["temp"].as_bool()?);
    let state = item["state"].as_object()?;
    let offset = state.get("timeOffset")?.as_u64()?;
    if offset == 0 || (removed && !temp) {
        return None;
    }
    let name = Some(clean_text(item["name"].as_str()?, " ", 200)).filter(|name| !name.is_empty())?;
    let modified = OffsetDateTime::parse(item["_mtime"].as_str()?, &Rfc3339).ok()?;
    let episode_id = (kind == "series")
        .then(|| state.get("video_id").and_then(Value::as_str))
        .flatten()
        .filter(|video| valid_video_id(video) && video.split(':').next() == Some(id) && video.contains(':'));
    let numbers = episode_id.map(|video| video.split(':').skip(1).filter_map(|part| part.parse::<u32>().ok()).collect::<Vec<_>>());
    // A time offset of 1 is stremio-core's "the next episode is waiting"; the duration still belongs to the previous one.
    let waiting = offset <= 1;
    Some((
        modified,
        StremioContinueItem {
            id: id.to_owned(),
            kind: kind.to_owned(),
            name,
            poster: allowed_image(item["poster"].as_str()),
            video_id: episode_id.map(str::to_owned),
            season: numbers.as_ref().and_then(|numbers| numbers.first().copied()),
            episode: numbers.as_ref().and_then(|numbers| numbers.get(1).copied()),
            position_ms: if waiting { 0 } else { offset },
            duration_ms: if waiting { 0 } else { state.get("duration").and_then(Value::as_u64).unwrap_or(0) },
        },
    ))
}

// ---- write-back ----

/// A session item that ended or was stopped, and who started it.
#[derive(Clone, Debug)]
pub struct Finished {
    /// The user whose library gets the position: the one who started this item, never the session's other members.
    pub owner: i64,
    pub kind: String,
    /// `tt<imdb>` for a movie, `tt<imdb>:<season>:<episode>` for an episode.
    pub video_id: String,
    pub name: String,
    pub poster: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// Where the item started (a resume starts past 0); only what was played after it counts as time watched.
    pub began_ms: u64,
}

impl Finished {
    fn title_id(&self) -> &str {
        self.video_id.split(':').next().unwrap_or_default()
    }

    /// Whether this is worth a library write: the bot played it (the duration is known) and it got past the first seconds.
    pub fn worth_saving(&self) -> bool {
        self.duration_ms > 0 && self.position_ms >= MIN_SAVE_MS
    }

    fn credits(&self) -> bool {
        self.position_ms as f64 > self.duration_ms as f64 * CREDITS_COEF
    }
}

/// Saves `done` to its owner's library in the background; failures are only logged without any content.
pub fn save(state: &AppState, done: Finished) {
    if !done.worth_saving() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        if write(&state, done).await.is_none() {
            tracing::info!("stremio: the library was not updated");
        }
    });
}

/// Get, merge, put. `None` when nothing was written. A failed read never leads to a create: only an answer that says the item is
/// missing does.
async fn write(state: &AppState, done: Finished) -> Option<()> {
    let active = active(state).ok()?;
    let (key, _) = load_key(state, &active, done.owner).await.ok()??;
    let account = &active.clients.account;
    let existing = match account.library_item(&key, done.title_id()).await {
        Ok(existing) => existing,
        Err(AccountError::SessionGone) => {
            drop_key(state, done.owner).await;
            return None;
        }
        Err(_) => return None,
    };
    let now = OffsetDateTime::now_utc();
    let next = if done.kind == "series" && done.credits() {
        cached_meta(state, &active, &done.kind, done.title_id()).await.ok().and_then(|meta| next_video(&meta, &done.video_id, now))
    } else {
        None
    };
    let item = merge(existing.as_ref(), &done, next.as_deref(), now)?;
    account.library_put(&key, item).await.ok()
}

/// stremio-core `MetaItem::next_video`: the video after `current`, unless it is not released yet or crosses back out of season 0.
fn next_video(meta: &StremioMeta, current: &str, now: OffsetDateTime) -> Option<String> {
    let position = meta.videos.iter().position(|video| video.id == current)?;
    let (this, next) = (&meta.videos[position], meta.videos.get(position + 1)?);
    let released = next.released.as_deref().and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok()).is_none_or(|at| at <= now);
    ((next.season != 0 || this.season == next.season) && released).then(|| next.id.clone())
}

fn stamp(now: OffsetDateTime) -> String {
    iso(now.replace_nanosecond(now.nanosecond() / 1_000_000 * 1_000_000).unwrap_or(now))
}

/// The counters of `LibraryItemState` this server changes.
struct Counters {
    time_watched: u64,
    time_offset: u64,
    overall: u64,
    times_watched: u64,
    flagged: u64,
    duration: u64,
}

impl Counters {
    fn read(state: &Map<String, Value>) -> Option<Self> {
        let number = |key: &str| state.get(key)?.as_u64();
        Some(Self {
            time_watched: number("timeWatched")?,
            time_offset: number("timeOffset")?,
            overall: number("overallTimeWatched")?,
            times_watched: number("timesWatched")?,
            flagged: number("flaggedWatched")?,
            duration: number("duration")?,
        })
    }

    fn write(&self, state: &mut Map<String, Value>) {
        for (key, value) in [
            ("timeWatched", self.time_watched),
            ("timeOffset", self.time_offset),
            ("overallTimeWatched", self.overall),
            ("timesWatched", self.times_watched),
            ("flaggedWatched", self.flagged),
            ("duration", self.duration),
        ] {
            state.insert(key.to_owned(), json!(value));
        }
    }
}

/// What stremio-core's `From<(&MetaItemPreview, PhantomData<E>)>` makes of a title that was watched without being in the library:
/// removed and temporary (it shows in Continue watching, not in the library), empty state.
fn created(done: &Finished, stamp: &str) -> Value {
    json!({
        "_id": done.title_id(),
        "name": done.name,
        "type": done.kind,
        "poster": done.poster,
        "posterShape": "poster",
        "removed": true,
        "temp": true,
        "_ctime": stamp,
        "_mtime": stamp,
        "state": {
            "lastWatched": stamp,
            "timeWatched": 0,
            "timeOffset": 0,
            "overallTimeWatched": 0,
            "timesWatched": 0,
            "flaggedWatched": 0,
            "duration": 0,
            "video_id": null,
            "watched": null,
            "noNotif": false,
        },
        "behaviorHints": {"defaultVideoId": null, "featuredVideoId": null, "hasScheduledVideos": false},
    })
}

/// Whether `item` has what `merge` reads and writes; anything else is somebody else's data we do not understand.
fn expected_shape(item: &Value, title_id: &str) -> bool {
    let state = &item["state"];
    item["_id"] == title_id
        && item["type"].is_string()
        && item["removed"].is_boolean()
        && item["temp"].is_boolean()
        && item["_mtime"].is_string()
        && state.as_object().is_some_and(|state| Counters::read(state).is_some())
        && (state["video_id"].is_null() || state["video_id"].is_string())
}

/// `existing` (or a new item when the account has none) with the position of `done` applied, the way stremio-core's player applies
/// a playing video to its library item, in one step. `None` when `existing` does not have the expected shape.
///
/// shortcut: `state.watched` (the compressed per-episode bitfield) is left as it is, so Stremio shows a finished episode through
/// `timesWatched` / `flaggedWatched` and the continue pointer but not with its own checkmark in the episode list; encoding it
/// needs the zlib bitfield format of stremio-watched-bitfield, worth adding if the checkmarks matter.
pub fn merge(existing: Option<&Value>, done: &Finished, next_video: Option<&str>, now: OffsetDateTime) -> Option<Value> {
    let stamp = stamp(now);
    let mut item = match existing {
        Some(item) if expected_shape(item, done.title_id()) => item.clone(),
        Some(_) => return None,
        // Without Cinemeta's meta the "name" is the id (see `title_info`): no new item with that for a name.
        None if done.name == done.video_id => return None,
        None => created(done, &stamp),
    };
    let (mut removed, mut temp) = (item["removed"].as_bool()?, item["temp"].as_bool()?);
    let state = item["state"].as_object_mut()?;
    let mut c = Counters::read(state)?;
    state.insert("lastWatched".to_owned(), json!(stamp));
    // A different video than the one the item pointed at: its time starts over (TimeChanged).
    if state.get("video_id").and_then(Value::as_str) != Some(done.video_id.as_str()) {
        c.overall = c.overall.saturating_add(c.time_watched);
        c.time_watched = 0;
        c.flagged = 0;
        state.insert("video_id".to_owned(), json!(done.video_id));
    }
    let played = done.position_ms.saturating_sub(done.began_ms);
    c.time_watched = c.time_watched.saturating_add(played);
    c.overall = c.overall.saturating_add(played);
    c.time_offset = done.position_ms;
    c.duration = done.duration_ms;
    // stremio-core flags a video at 70% of its duration watched; reaching the credits (90%) counts as watched too, which is what
    // someone who resumed at 85% and watched the rest expects.
    if c.flagged == 0 && c.duration > 0 && (c.time_watched as f64 > c.duration as f64 * WATCHED_COEF || done.credits()) {
        c.flagged = 1;
        c.times_watched = c.times_watched.saturating_add(1);
    }
    if temp && c.times_watched == 0 {
        removed = true;
    }
    if removed {
        temp = true;
    }
    // item_state_update: past the credits nothing is left to continue; a series moves on to the next episode (`advance_to_video`).
    if done.credits() {
        c.time_offset = 0;
        if let Some(next) = next_video {
            state.insert("video_id".to_owned(), json!(next));
            c.overall = c.overall.saturating_add(c.time_watched);
            c.time_watched = 0;
            c.flagged = 0;
            c.time_offset = 1;
        }
    }
    c.write(state);
    item["removed"] = json!(removed);
    item["temp"] = json!(temp);
    item["_mtime"] = json!(stamp);
    Some(item)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-10-17 12:00:00.123456 UTC);

    fn done(video_id: &str, position_ms: u64, began_ms: u64) -> Finished {
        Finished {
            owner: 1,
            kind: if video_id.contains(':') { "series" } else { "movie" }.to_owned(),
            video_id: video_id.to_owned(),
            name: "Heat".to_owned(),
            poster: Some("https://images.metahub.space/poster/small/tt0113277/img".to_owned()),
            position_ms,
            duration_ms: 1_000_000,
            began_ms,
        }
    }

    fn stored(id: &str, video_id: Value) -> Value {
        json!({
            "_id": id, "name": "Heat", "type": "movie", "poster": null, "posterShape": "poster", "removed": false, "temp": false,
            "_ctime": "2020-01-01T00:00:00Z", "_mtime": "2020-01-01T00:00:00Z", "somethingNew": {"keep": [1, 2]},
            "state": {"lastWatched": null, "timeWatched": 50, "timeOffset": 40, "overallTimeWatched": 500, "timesWatched": 2, "flaggedWatched": 0,
                      "duration": 900, "video_id": video_id, "watched": "tt:1:1:eJwDAAAAAAE=", "noNotif": false, "alsoNew": true},
            "behaviorHints": {"defaultVideoId": null, "extra": 1},
        })
    }

    #[test]
    fn a_merge_keeps_what_it_does_not_own() {
        let existing = stored("tt0113277", json!("tt0113277"));
        let merged = merge(Some(&existing), &done("tt0113277", 300_000, 0), None, NOW).expect("merged");
        assert_eq!(merged["somethingNew"], json!({"keep": [1, 2]}));
        assert_eq!(merged["state"]["alsoNew"], json!(true));
        assert_eq!(merged["state"]["watched"], existing["state"]["watched"]);
        assert_eq!(merged["behaviorHints"], existing["behaviorHints"]);
        assert_eq!(merged["_ctime"], existing["_ctime"]);
        assert_eq!(merged["state"]["timeOffset"], json!(300_000));
        assert_eq!(merged["state"]["duration"], json!(1_000_000));
        assert_eq!(merged["state"]["timeWatched"], json!(300_050));
        assert_eq!(merged["state"]["flaggedWatched"], json!(0));
        assert_eq!(merged["state"]["video_id"], json!("tt0113277"));
        assert_eq!(merged["_mtime"], json!("2026-10-17T12:00:00.123Z"));
        assert_eq!(merged["removed"], json!(false));
    }

    #[test]
    fn a_missing_item_is_created_as_stremio_does() {
        let merged = merge(None, &done("tt0113277", 300_000, 0), None, NOW).expect("created");
        assert_eq!(merged["_id"], json!("tt0113277"));
        assert_eq!((&merged["removed"], &merged["temp"]), (&json!(true), &json!(true)));
        assert_eq!(merged["state"]["timeOffset"], json!(300_000));
        assert_eq!(merged["state"]["timesWatched"], json!(0));
        assert_eq!(merged["poster"], json!("https://images.metahub.space/poster/small/tt0113277/img"));
        assert!(continue_row(std::slice::from_ref(&merged)).iter().any(|row| row.id == "tt0113277"), "it shows in Continue watching");
    }

    #[test]
    fn an_unexpected_shape_is_not_written() {
        let mut broken: Vec<Value> = (0..5).map(|_| stored("tt0113277", json!("tt0113277"))).collect();
        broken[0]["state"]["timeOffset"] = json!("40");
        broken[1]["state"] = json!(null);
        broken[2]["removed"] = json!("no");
        broken[3]["_id"] = json!("tt0000001");
        broken[4]["state"]["video_id"] = json!(7);
        for item in &broken {
            assert!(merge(Some(item), &done("tt0113277", 300_000, 0), None, NOW).is_none(), "{item}");
        }
    }

    #[test]
    fn past_the_credits_a_movie_is_watched_and_nothing_is_left_to_continue() {
        let existing = stored("tt0113277", json!("tt0113277"));
        let merged = merge(Some(&existing), &done("tt0113277", 980_000, 900_000), None, NOW).expect("merged");
        assert_eq!(merged["state"]["timeOffset"], json!(0));
        assert_eq!((merged["state"]["flaggedWatched"].clone(), merged["state"]["timesWatched"].clone()), (json!(1), json!(3)));
        assert!(continue_row(&[merged]).is_empty());
    }

    #[test]
    fn past_the_credits_an_episode_moves_the_pointer_to_the_next_one() {
        let mut existing = stored("tt0903747", json!("tt0903747:1:2"));
        existing["type"] = json!("series");
        let merged = merge(Some(&existing), &done("tt0903747:1:2", 990_000, 0), Some("tt0903747:1:3"), NOW).expect("merged");
        assert_eq!(merged["state"]["video_id"], json!("tt0903747:1:3"));
        assert_eq!(
            (merged["state"]["timeOffset"].clone(), merged["state"]["timeWatched"].clone(), merged["state"]["flaggedWatched"].clone()),
            (json!(1), json!(0), json!(0))
        );
        assert_eq!(merged["state"]["timesWatched"], json!(3));
        let row = &continue_row(&[merged])[0];
        assert_eq!((row.video_id.as_deref(), row.season, row.episode, row.position_ms, row.duration_ms), (Some("tt0903747:1:3"), Some(1), Some(3), 0, 0));
    }

    #[test]
    fn a_new_episode_starts_its_time_over_and_a_temp_item_that_was_never_finished_stays_removed() {
        let mut existing = stored("tt0903747", json!("tt0903747:1:1"));
        existing["type"] = json!("series");
        existing["removed"] = json!(true);
        existing["temp"] = json!(true);
        existing["state"]["timesWatched"] = json!(0);
        let merged = merge(Some(&existing), &done("tt0903747:1:2", 100_000, 0), None, NOW).expect("merged");
        assert_eq!((merged["state"]["timeWatched"].clone(), merged["state"]["overallTimeWatched"].clone()), (json!(100_000), json!(100_550)));
        assert_eq!((merged["removed"].clone(), merged["temp"].clone()), (json!(true), json!(true)));
    }

    #[test]
    fn the_row_is_newest_first_and_follows_stremio_cores_rule() {
        let item = |id: &str, mtime: &str, offset: u64, removed: bool, temp: bool| {
            let mut item = stored(id, json!(id));
            item["_mtime"] = json!(mtime);
            item["removed"] = json!(removed);
            item["temp"] = json!(temp);
            item["state"]["timeOffset"] = json!(offset);
            item
        };
        let mut other = item("kitsu:1", "2026-01-01T00:00:00Z", 5000, false, false);
        other["_id"] = json!("kitsu:1");
        let row = continue_row(&[
            item("tt0000001", "2026-01-01T00:00:00Z", 5000, false, false),
            item("tt0000002", "2026-03-01T00:00:00Z", 5000, false, false),
            item("tt0000003", "2026-04-01T00:00:00Z", 0, false, false),
            item("tt0000004", "2026-05-01T00:00:00Z", 5000, true, false),
            item("tt0000005", "2026-02-01T00:00:00Z", 5000, true, true),
            other,
        ]);
        assert_eq!(row.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["tt0000002", "tt0000005", "tt0000001"]);
        let many: Vec<Value> = (1..=40).map(|n| item(&format!("tt{n:07}"), "2026-01-01T00:00:00Z", 5000, false, false)).collect();
        assert_eq!(continue_row(&many).len(), MAX_ROW);
    }

    #[test]
    fn the_next_video_skips_unreleased_episodes_and_season_zero() {
        let video = |id: &str, season: u32, released: Option<&str>| vokko_protocol::api::StremioVideo {
            id: id.to_owned(),
            season,
            episode: 1,
            name: String::new(),
            released: released.map(str::to_owned),
            thumbnail: None,
        };
        let meta = StremioMeta {
            id: "tt1".into(),
            kind: "series".into(),
            name: "S".into(),
            poster: None,
            background: None,
            description: None,
            year: None,
            runtime: None,
            videos: vec![
                video("tt1:1:1", 1, None),
                video("tt1:1:2", 1, Some("2020-01-01T00:00:00Z")),
                video("tt1:1:3", 1, Some("2030-01-01T00:00:00Z")),
                video("tt1:0:1", 0, None),
            ],
        };
        assert_eq!(next_video(&meta, "tt1:1:1", NOW).as_deref(), Some("tt1:1:2"));
        assert_eq!(next_video(&meta, "tt1:1:2", NOW), None, "unreleased");
        assert_eq!(next_video(&meta, "tt1:1:3", NOW), None, "season 0 after season 1");
        assert_eq!(next_video(&meta, "tt1:9:9", NOW), None);
    }
}
