//! A guild's game catalog (docs/design/games-host.md section 4): web games members with MANAGE_GUILD allow in the guild's calls.
//! `GET|POST /guilds/{id}/games`, `PATCH|DELETE /guilds/{id}/games/{game_id}`, audit entries and GUILD_GAMES_UPDATE.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use reqwest::Url;
use unicode_segmentation::UnicodeSegmentation;
use vokko_protocol::api::permissions::MANAGE_GUILD;
use vokko_protocol::api::{
    AuditLogEvent, CreateGameRequest, EditGameRequest, GAME_NAME_MAX_CHARS, GAME_PLAYERS_MAX, GUILD_GAMES_MAX, GameAspect, GameKind, GameManifest,
    GatewayEvent, GuildGamesUpdate, Snowflake,
};

use crate::access::{self, guild_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::config::Config;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;
use crate::unfurl::host_allowed;
use crate::voice::watch::hidden_char;

/// Longest manifest URL, in bytes.
pub const GAME_URL_MAX_BYTES: usize = 512;
/// Longest icon, in bytes (one emoji, flags and ZWJ sequences included).
pub const GAME_ICON_MAX_BYTES: usize = 16;

pub fn routes() -> Router<AppState> {
    Router::new().route("/guilds/{id}/games", get(list).post(create)).route("/guilds/{id}/games/{game_id}", patch(edit).delete(remove))
}

fn unknown_game() -> ApiErr {
    ApiErr::new_unknown("Unknown Game", 10090)
}

fn aspect_text(aspect: GameAspect) -> &'static str {
    match aspect {
        GameAspect::Wide => "16:9",
        GameAspect::Standard => "4:3",
        GameAspect::Square => "1:1",
        GameAspect::Fill => "fill",
    }
}

fn kind_text(kind: GameKind) -> &'static str {
    match kind {
        GameKind::Sdk => "sdk",
        GameKind::Web => "web",
    }
}

fn aspect_of(text: &str) -> GameAspect {
    match text {
        "4:3" => GameAspect::Standard,
        "1:1" => GameAspect::Square,
        "fill" => GameAspect::Fill,
        _ => GameAspect::Wide,
    }
}

/// Trimmed, 1-32 characters, nothing invisible.
pub fn clean_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim();
    if !(1..=GAME_NAME_MAX_CHARS).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", &format!("Must be between 1 and {GAME_NAME_MAX_CHARS} in length.")));
    }
    if name.chars().any(hidden_char) {
        return Err(ApiErr::invalid("name", "Must not contain control or invisible characters."));
    }
    Ok(name.to_owned())
}

/// One emoji (a single grapheme of at most 16 bytes that is not a letter, digit or space), or none for blank. The joiner and
/// variation selectors that emoji sequences are made of are allowed; every other `hidden_char` is not.
pub fn clean_icon(raw: Option<&str>) -> ApiResult<Option<String>> {
    let Some(icon) = raw.map(str::trim).filter(|icon| !icon.is_empty()) else { return Ok(None) };
    let first = icon.chars().next().unwrap_or(' ');
    let emoji_like = icon.len() <= GAME_ICON_MAX_BYTES
        && icon.graphemes(true).count() == 1
        && !first.is_ascii()
        && !first.is_alphanumeric()
        && !first.is_whitespace()
        && icon.chars().all(|c| matches!(c, '\u{200D}' | '\u{FE0E}' | '\u{FE0F}') || !hidden_char(c));
    if emoji_like { Ok(Some(icon.to_owned())) } else { Err(ApiErr::invalid("icon", "Must be one emoji.")) }
}

fn check_players(min: u8, max: u8) -> ApiResult<()> {
    if !(1..=GAME_PLAYERS_MAX).contains(&min) {
        return Err(ApiErr::invalid("min_players", &format!("Must be between 1 and {GAME_PLAYERS_MAX}.")));
    }
    if !(min..=GAME_PLAYERS_MAX).contains(&max) {
        return Err(ApiErr::invalid("max_players", &format!("Must be between min_players and {GAME_PLAYERS_MAX}.")));
    }
    Ok(())
}

/// An absolute `https:` URL (with `VOKKO_DEV=1` also `http://127.0.0.1` / `http://localhost`), at most 512 bytes, without
/// userinfo or fragment, on another host than this server and its web app, whatever the port (a game there would share their
/// origin or their cookies). A trailing `.` does not make a host another one. In dev a loopback game only needs another port.
/// Outside dev, never a loopback, private or link-local IP or a `localhost` / `.local` / `.internal` name (link previews' rule): the
/// frame would load a page on the viewer's own machine or network. A public name that resolves privately is not caught here: the
/// server never fetches the URL and DNS can change later, so only the viewer's browser could check that.
pub fn check_url(config: &Config, raw: &str) -> ApiResult<String> {
    let raw = raw.trim();
    let bad = |message: &str| ApiErr::invalid("url", message);
    if raw.len() > GAME_URL_MAX_BYTES {
        return Err(bad(&format!("Must be {GAME_URL_MAX_BYTES} or fewer in length.")));
    }
    let url = Url::parse(raw).map_err(|_| bad("Not a well formed URL."))?;
    let host = |url: &Url| url.host_str().map(|host| host.trim_end_matches('.').to_owned());
    let local = matches!(host(&url).as_deref(), Some("127.0.0.1" | "localhost"));
    if !(url.scheme() == "https" || (config.dev && url.scheme() == "http" && local)) || url.host_str().is_none_or(str::is_empty) {
        return Err(bad("Must be an https URL."));
    }
    if !host_allowed(&url, config.dev) {
        return Err(bad("Must not be a local or private network address."));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(bad("Must not contain a user name, password or fragment."));
    }
    let own = [config.public_url.as_str(), config.accounts.web_url.as_str()];
    let dev_local = config.dev && local;
    if own.iter().filter_map(|own| Url::parse(own).ok()).any(|own| if dev_local { own.origin() == url.origin() } else { host(&own) == host(&url) }) {
        return Err(bad("Must not be this server's own address."));
    }
    if url.as_str().len() > GAME_URL_MAX_BYTES {
        return Err(bad(&format!("Must be {GAME_URL_MAX_BYTES} or fewer in length.")));
    }
    Ok(url.into())
}

type GameRow = (i64, String, String, Option<String>, i16, i16, String, String);

const GAME_COLS: &str = "id, name, url, icon, min_players, max_players, aspect, kind";

fn manifest((id, name, url, icon, min_players, max_players, aspect, kind): GameRow) -> GameManifest {
    let kind = if kind == "web" { GameKind::Web } else { GameKind::Sdk };
    GameManifest { id: id.to_string(), name, url, icon, min_players: min_players as u8, max_players: max_players as u8, aspect: aspect_of(&aspect), kind }
}

/// The guild's catalog, oldest first.
pub async fn of_guild(state: &AppState, guild_id: i64) -> ApiResult<Vec<GameManifest>> {
    let rows: Vec<GameRow> =
        sqlx::query_as(&format!("SELECT {GAME_COLS} FROM guild_games WHERE guild_id = $1 ORDER BY id")).bind(guild_id).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(manifest).collect())
}

pub async fn find(state: &AppState, guild_id: i64, game_id: i64) -> ApiResult<Option<GameManifest>> {
    let row: Option<GameRow> = sqlx::query_as(&format!("SELECT {GAME_COLS} FROM guild_games WHERE guild_id = $1 AND id = $2"))
        .bind(guild_id)
        .bind(game_id)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map(manifest))
}

/// GUILD_GAMES_UPDATE to every member, so open pickers refetch.
async fn broadcast(state: &AppState, guild_id: i64) -> ApiResult<()> {
    let members = access::guild_member_ids(state, guild_id).await?;
    state.hub.send(&members, &GatewayEvent::GuildGamesUpdate(GuildGamesUpdate { guild_id: Snowflake::from(guild_id) }));
    Ok(())
}

fn ids(guild: &str, game: Option<&str>) -> ApiResult<(i64, i64)> {
    let guild_id = parse_id(guild).ok_or_else(ApiErr::unknown_guild)?;
    let game_id = game.map(|game| parse_id(game).ok_or_else(unknown_game)).transpose()?.unwrap_or(0);
    Ok((guild_id, game_id))
}

fn changes(entry: Entry, old: Option<&GameManifest>, new: Option<&GameManifest>) -> Entry {
    entry
        .change("name", old.map(|g| &g.name), new.map(|g| &g.name))
        .change("url", old.map(|g| &g.url), new.map(|g| &g.url))
        .change("icon", old.and_then(|g| g.icon.as_ref()), new.and_then(|g| g.icon.as_ref()))
        .change("min_players", old.map(|g| g.min_players), new.map(|g| g.min_players))
        .change("max_players", old.map(|g| g.max_players), new.map(|g| g.max_players))
        .change("aspect", old.map(|g| g.aspect), new.map(|g| g.aspect))
        .change("kind", old.map(|g| g.kind), new.map(|g| g.kind))
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<GameManifest>>> {
    let (guild_id, _) = ids(&id, None)?;
    guild_access(&state, user_id, guild_id).await?;
    Ok(Json(of_guild(&state, guild_id).await?))
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<CreateGameRequest>,
) -> ApiResult<(StatusCode, Json<GameManifest>)> {
    let (guild_id, _) = ids(&id, None)?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD)?;
    let (min_players, max_players) = (body.min_players.unwrap_or(1), body.max_players.unwrap_or(GAME_PLAYERS_MAX));
    let game = GameManifest {
        id: state.ids.next().to_string(),
        name: clean_name(&body.name)?,
        url: check_url(&state.config, &body.url)?,
        icon: clean_icon(body.icon.as_deref())?,
        min_players,
        max_players,
        aspect: body.aspect.unwrap_or_default(),
        kind: body.kind.unwrap_or_default(),
    };
    check_players(min_players, max_players)?;
    let game_id: i64 = game.id.parse().map_err(|_| ApiErr::internal())?;
    // The guild row lock serializes concurrent adds, so the count and the insert see the same catalog.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR UPDATE").bind(guild_id).execute(&mut *tx).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM guild_games WHERE guild_id = $1").bind(guild_id).fetch_one(&mut *tx).await?;
    if count as usize >= GUILD_GAMES_MAX {
        return Err(ApiErr::conflict(30058, &format!("Maximum number of games reached ({GUILD_GAMES_MAX})")));
    }
    sqlx::query(
        "INSERT INTO guild_games (id, guild_id, name, url, icon, min_players, max_players, aspect, creator_id, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(game_id)
    .bind(guild_id)
    .bind(&game.name)
    .bind(&game.url)
    .bind(&game.icon)
    .bind(i16::from(game.min_players))
    .bind(i16::from(game.max_players))
    .bind(aspect_text(game.aspect))
    .bind(user_id)
    .bind(kind_text(game.kind))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    broadcast(&state, guild_id).await?;
    audit::record(&state, changes(Entry::new(guild_id, user_id, AuditLogEvent::GameAdd, game_id).reason(reason), None, Some(&game))).await?;
    Ok((StatusCode::CREATED, Json(game)))
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, game)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<EditGameRequest>,
) -> ApiResult<Json<GameManifest>> {
    let (guild_id, game_id) = ids(&id, Some(&game))?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD)?;
    let old = find(&state, guild_id, game_id).await?.ok_or_else(unknown_game)?;
    let mut next = old.clone();
    if let Some(name) = &body.name {
        next.name = clean_name(name)?;
    }
    if let Some(url) = &body.url {
        next.url = check_url(&state.config, url)?;
    }
    if let Some(icon) = &body.icon {
        next.icon = clean_icon(icon.as_deref())?;
    }
    next.min_players = body.min_players.unwrap_or(next.min_players);
    next.max_players = body.max_players.unwrap_or(next.max_players);
    next.aspect = body.aspect.unwrap_or(next.aspect);
    next.kind = body.kind.unwrap_or(next.kind);
    check_players(next.min_players, next.max_players)?;
    if next == old {
        return Ok(Json(next));
    }
    // Games already running keep the manifest they started with, unless the URL or kind changed: then they end (the app ids
    // change with the URL, the frame's sandbox with the kind).
    sqlx::query(
        "UPDATE guild_games SET name = $3, url = $4, icon = $5, min_players = $6, max_players = $7, aspect = $8, kind = $9 WHERE guild_id = $1 AND id = $2",
    )
    .bind(guild_id)
    .bind(game_id)
    .bind(&next.name)
    .bind(&next.url)
    .bind(&next.icon)
    .bind(i16::from(next.min_players))
    .bind(i16::from(next.max_players))
    .bind(aspect_text(next.aspect))
    .bind(kind_text(next.kind))
    .execute(&state.db)
    .await?;
    if next.url != old.url || next.kind != old.kind {
        crate::voice::games::end_game(&state, &old.id).await;
    }
    broadcast(&state, guild_id).await?;
    audit::record(&state, changes(Entry::new(guild_id, user_id, AuditLogEvent::GameUpdate, game_id).reason(reason), Some(&old), Some(&next))).await?;
    Ok(Json(next))
}

async fn remove(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, game)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let (guild_id, game_id) = ids(&id, Some(&game))?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD)?;
    let old = find(&state, guild_id, game_id).await?.ok_or_else(unknown_game)?;
    let deleted = sqlx::query("DELETE FROM guild_games WHERE guild_id = $1 AND id = $2").bind(guild_id).bind(game_id).execute(&state.db).await?;
    if deleted.rows_affected() == 0 {
        return Err(unknown_game());
    }
    crate::voice::games::end_game(&state, &old.id).await;
    broadcast(&state, guild_id).await?;
    audit::record(&state, changes(Entry::new(guild_id, user_id, AuditLogEvent::GameRemove, game_id).reason(reason), Some(&old), None)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_names_and_icons() {
        let mut config = Config::new("unused".into(), "127.0.0.1:0".into(), "/tmp".into(), "https://chat.example.com".into());
        assert_eq!(check_url(&config, " https://play.example.com/vokko/ ").expect("ok"), "https://play.example.com/vokko/");
        assert!(check_url(&config, "https://play.example.com").is_ok());
        for bad in [
            "http://play.example.com/",
            "http://localhost:5173/",
            "https://chat.example.com/game",
            "https://chat.example.com:443/",
            "https://user:pw@play.example.com/",
            "https://play.example.com/#x",
            "javascript:alert(1)",
            "/games/sketch/",
            "",
            "https://localhost/",
            "https://game.localhost/",
            "https://router.local/",
            "https://wiki.corp.internal/",
            "https://127.0.0.1/",
            "https://2130706433/",
            "https://10.0.0.5/",
            "https://192.168.1.1/",
            "https://169.254.169.254/",
            "https://[::1]/",
            "https://[fe80::1]/",
            "https://[::ffff:192.168.1.1]/",
        ] {
            assert!(check_url(&config, bad).is_err(), "{bad}");
        }
        assert!(check_url(&config, &format!("https://a.example/{}", "x".repeat(512 - 18))).is_ok());
        assert!(check_url(&config, &format!("https://a.example/{}", "x".repeat(513 - 18))).is_err(), "513 bytes");
        for own in ["https://chat.example.com:8443/", "https://chat.example.com./", "https://CHAT.example.com.:443/x", "http://chat.example.com/"] {
            assert!(check_url(&config, own).is_err(), "same host, any port or a trailing dot: {own}");
        }
        config.dev = true;
        assert!(check_url(&config, "http://localhost:5173/").is_ok() && check_url(&config, "http://127.0.0.1:1454/mock/").is_ok());
        assert!(check_url(&config, "http://play.example.com/").is_err(), "dev only opens up the loopback hosts");
        assert!(check_url(&config, "https://192.168.1.1/").is_ok(), "dev allows private hosts");

        assert_eq!(clean_name("  Codenames  ").expect("ok"), "Codenames");
        for bad in ["", "   ", "a\u{202E}b", "a\u{200B}b", "a\nb", &"x".repeat(33)] {
            assert!(clean_name(bad).is_err(), "{bad:?}");
        }
        for good in ["🕵️", "🎨", "🏳️‍🌈", "🇸🇪", "👍🏽"] {
            assert_eq!(clean_icon(Some(good)).expect(good).as_deref(), Some(good));
        }
        assert!(clean_icon(Some("  ")).expect("blank").is_none() && clean_icon(None).expect("none").is_none());
        for bad in ["a", "ab", "🎨🎨", "👨‍👩‍👧", "é", "\u{202E}🎨", "🎨\u{200B}", "1"] {
            assert!(clean_icon(Some(bad)).is_err(), "{bad:?}");
        }
        assert!(check_players(1, 16).is_ok() && check_players(4, 4).is_ok());
        assert!(check_players(0, 4).is_err() && check_players(5, 4).is_err() && check_players(2, 17).is_err());
    }
}
