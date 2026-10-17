//! Games in calls (docs/design/games-host.md section 5): one web game per voice channel or DM call, held in memory like Watch
//! Together, and a relay that carries the game's messages to the people in the call over the gateway. The game itself runs in a
//! sandboxed frame on each client; the server only knows which game runs, who is in the call and each player's app id.
//! `PUT|DELETE /channels/{id}/game`, `GET /channels/{id}/game/players`, `POST /channels/{id}/game/messages`, GAME_UPDATE and
//! GAME_MESSAGE.
use std::collections::HashSet;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use vokko_protocol::api::permissions::MANAGE_CHANNELS;
use vokko_protocol::api::{
    GAME_RELAY_MAX_BYTES, GameAspect, GameManifest, GameMessage, GamePlayer, GameRelayRequest, GameSession, GameStartRequest, GameUpdate, GatewayEvent,
    Snowflake,
};

use super::unix_millis;
use super::watch::require_in_voice;
use crate::access;
use crate::auth::{AuthUser, random_hex};
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

/// HKDF label of the app-id key under `VOKKO_SECRETS_KEY`.
pub const APP_ID_LABEL: &str = "vokko games app-id v1";
/// Relay sends per user: a burst of 40, then 20 per second.
pub const RELAY_BURST: f64 = 40.0;
pub const RELAY_PER_SECOND: f64 = 20.0;
/// Relay sends per channel, all senders together: bounds what one call adds to each member's gateway replay buffer.
pub const CHANNEL_RELAY_BURST: f64 = 60.0;
pub const CHANNEL_RELAY_PER_SECOND: f64 = 30.0;
/// Start / stop per user: a burst of 5, then 1 per second.
pub const CONTROL_BURST: f64 = 5.0;
pub const CONTROL_PER_SECOND: f64 = 1.0;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/game", put(start).delete(stop))
        .route("/channels/{id}/game/players", get(players))
        .route("/channels/{id}/game/messages", post(relay).layer(DefaultBodyLimit::max(GAME_RELAY_MAX_BYTES + 1024)))
}

/// The games every call may start (the desktop app ships them under `/games/<name>/`).
pub fn builtins() -> Vec<GameManifest> {
    [
        ("sketch", "Sketch", "✏️", 2, 12),
        ("chess", "Chess", "♟️", 2, 16),
        ("four-in-a-row", "Four in a Row", "🟡", 2, 16),
        ("codewords", "Codewords", "🗝️", 4, 16),
        ("telephone", "Telephone", "☎️", 3, 12),
        ("trivia", "Trivia", "❓", 1, 16),
        ("whos-the-spy", "Who's the Spy", "🕵️", 3, 16),
        ("same-wave", "Same Wave", "📡", 2, 16),
        ("crazy-eights", "Crazy Eights", "🃏", 2, 10),
        ("werewolf", "Werewolf", "🐺", 5, 16),
    ]
    .into_iter()
    .map(|(slug, name, icon, min_players, max_players)| GameManifest {
        id: format!("builtin:{slug}"),
        name: name.to_owned(),
        url: format!("/games/{slug}/index.html"),
        icon: Some(icon.to_owned()),
        min_players,
        max_players,
        aspect: GameAspect::Wide,
    })
    .collect()
}

/// `base64url(HMAC-SHA256(k, game_id ":" origin ":" user_id))[..22]`: stable per game, origin and user, different across games and
/// once a game moves to another origin, and it says nothing about the Vokko user id. Built-ins (relative URLs) use "builtin".
pub fn app_id(state: &AppState, game: &GameManifest, user_id: i64) -> String {
    let origin = reqwest::Url::parse(&game.url).map_or_else(|_| "builtin".to_owned(), |url| url.origin().ascii_serialization());
    let mac = state.config.games_app_key.mac(format!("{}:{origin}:{user_id}", game.id).as_bytes());
    let mut encoded = URL_SAFE_NO_PAD.encode(mac);
    encoded.truncate(22);
    encoded
}

fn unknown_game() -> ApiErr {
    ApiErr::new_unknown("Unknown Game", 10090)
}

fn no_game() -> ApiErr {
    ApiErr::new_unknown("No game is running in this channel", 10091)
}

/// Who may stop the game: the starter, anyone in a DM call, or in a guild someone with MANAGE_CHANNELS on the channel. The one
/// place the rule lives, so bot control can replace it.
pub async fn can_stop(state: &AppState, user_id: i64, channel: &ChannelRow, session: &GameSession) -> ApiResult<bool> {
    if channel.is_dm() || session.started_by.db() == user_id {
        return Ok(true);
    }
    Ok(access::channel_access(state, user_id, channel.id).await?.permissions & MANAGE_CHANNELS == MANAGE_CHANNELS)
}

fn limited_key(state: &AppState, user_id: i64, key: &str, burst: f64, per_second: f64) -> ApiResult<()> {
    if state.config.rate_limit.is_none() {
        return Ok(());
    }
    state.limiter.check_key(key, user_id, burst, per_second).map_err(ApiErr::rate_limited)
}

/// The users in the channel's voice right now.
fn in_call(state: &AppState, channel_id: i64) -> Vec<i64> {
    state.voice.states_in(&HashSet::from([channel_id])).iter().map(|voice| voice.user_id.db()).collect()
}

/// The game `game_id` names for this channel: a built-in, or (guild channels only) an entry of the guild's catalog.
async fn resolve(state: &AppState, channel: &ChannelRow, game_id: &str) -> ApiResult<GameManifest> {
    if let Some(game) = builtins().into_iter().find(|game| game.id == game_id) {
        return Ok(game);
    }
    let (Some(guild_id), Some(id)) = (channel.guild_id, parse_id(game_id)) else { return Err(unknown_game()) };
    crate::games::find(state, guild_id, id).await?.ok_or_else(unknown_game)
}

async fn start(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<GameStartRequest>,
) -> ApiResult<Json<GameSession>> {
    limited_key(&state, user_id, "game-control", CONTROL_BURST, CONTROL_PER_SECOND)?;
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    let channel = store::channel_row(&state, channel_id).await?.ok_or_else(ApiErr::missing_permissions)?;
    let game = resolve(&state, &channel, &body.game_id).await?;
    let session = GameSession { session_id: random_hex(8), game, started_by: Snowflake::from(user_id), started_at_ms: unix_millis() };
    state.voice.game_update(channel_id, |current| match current {
        Some(_) => Err(ApiErr::new(StatusCode::CONFLICT, 40090, "A game is already running")),
        None => Ok(Some(session.clone())),
    })?;
    // An edit or removal that ran between `resolve` and the insert missed this session: check again and take it back.
    if resolve(&state, &channel, &body.game_id).await.ok().is_none_or(|now| now.url != session.game.url) {
        let _ = state.voice.game_update(channel_id, |current| {
            Ok(if current.is_some_and(|current| current.session_id == session.session_id) { None } else { current.cloned() })
        });
        return Err(unknown_game());
    }
    announce(&state, channel_id, Some(session.clone())).await;
    Ok(Json(session))
}

async fn players(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<GamePlayer>>> {
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    let session = state.voice.game_get(channel_id).ok_or_else(no_game)?;
    let players = in_call(&state, channel_id)
        .into_iter()
        .map(|user| GamePlayer { user_id: Snowflake::from(user), app_id: app_id(&state, &session.game, user) })
        .collect();
    Ok(Json(players))
}

async fn relay(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<GameRelayRequest>,
) -> ApiResult<Response> {
    let channel_id = require_in_voice(&state, user_id, &id).await?;
    limited_key(&state, user_id, "game-relay", RELAY_BURST, RELAY_PER_SECOND)?;
    if state.config.rate_limit.is_some() {
        let limited = state.limiter.check_resource(channel_id, "game-relay", CHANNEL_RELAY_BURST, CHANNEL_RELAY_PER_SECOND);
        limited.map_err(|limited| ApiErr::rate_limited(limited.retry_after))?;
    }
    let session = state.voice.game_get(channel_id).ok_or_else(no_game)?;
    if serde_json::to_vec(&body.data).map_or(true, |bytes| bytes.len() > GAME_RELAY_MAX_BYTES) {
        return Err(ApiErr::invalid("data", &format!("Must be {GAME_RELAY_MAX_BYTES} bytes or fewer as JSON.")));
    }
    let mut recipients: Vec<(i64, String)> =
        in_call(&state, channel_id).into_iter().filter(|user| *user != user_id).map(|user| (user, app_id(&state, &session.game, user))).collect();
    if let Some(to) = &body.to {
        recipients.retain(|(_, app)| app == to);
        if recipients.is_empty() {
            return Err(ApiErr::invalid("to", "Not another player in this call."));
        }
    }
    // shortcut: relay frames use the replayed hub path; add a volatile (unreplayed) send when relay traffic shows up in resume gaps.
    let users: Vec<i64> = recipients.into_iter().map(|(user, _)| user).collect();
    let message =
        GameMessage { channel_id: Snowflake::from(channel_id), session_id: session.session_id, from: app_id(&state, &session.game, user_id), data: body.data };
    state.hub.send(&users, &GatewayEvent::GameMessage(message));
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn stop(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Response> {
    limited_key(&state, user_id, "game-control", CONTROL_BURST, CONTROL_PER_SECOND)?;
    // A guild member with MANAGE_CHANNELS on the channel may stop it from outside the call; everyone else must be in it.
    let channel_id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let moderator = match store::channel_row(&state, channel_id).await? {
        Some(row) if !row.is_dm() => {
            access::channel_access(&state, user_id, channel_id).await.is_ok_and(|access| access.permissions & MANAGE_CHANNELS == MANAGE_CHANNELS)
        }
        _ => false,
    };
    if !moderator {
        require_in_voice(&state, user_id, &id).await?;
    }
    let Some(session) = state.voice.game_get(channel_id) else { return Ok(StatusCode::NO_CONTENT.into_response()) };
    if !moderator {
        let channel = store::channel_row(&state, channel_id).await?.ok_or_else(ApiErr::missing_permissions)?;
        if !can_stop(&state, user_id, &channel, &session).await? {
            return Err(ApiErr::missing_permissions());
        }
    }
    // Only the session that was checked ends: one started in between by someone else stays.
    if let Ok((Some(_), None)) = state
        .voice
        .game_update(channel_id, |current| Ok(if current.is_some_and(|current| current.session_id == session.session_id) { None } else { current.cloned() }))
    {
        announce(&state, channel_id, None).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Ends the channel's game, if any, and tells everyone who can see the channel.
pub(crate) async fn end(state: &AppState, channel_id: i64) {
    if let Ok((Some(_), _)) = state.voice.game_update(channel_id, |_| Ok(None)) {
        announce(state, channel_id, None).await;
    }
}

/// Ends every running session of the game `game_id` (it was removed from its guild's catalog, or its URL changed).
pub(crate) async fn end_game(state: &AppState, game_id: &str) {
    for channel_id in state.voice.game_channels(game_id) {
        end(state, channel_id).await;
    }
}

/// GAME_UPDATE to everyone who can see the channel (`state: null` = the game ended).
async fn announce(state: &AppState, channel_id: i64, session: Option<GameSession>) {
    let Ok(Some(row)) = store::channel_row(state, channel_id).await else { return };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return };
    state.hub.send(&viewers, &GatewayEvent::GameUpdate(GameUpdate { channel_id: Snowflake::from(channel_id), state: session }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop app's list (apps/desktop/src/games/builtin.ts) and this one must match game for game, field for field.
    #[test]
    fn builtins_match_the_desktop_list() {
        let ts = include_str!("../../../../apps/desktop/src/games/builtin.ts");
        let client: Vec<&str> = ts.lines().filter(|line| line.contains(": GameManifest = {") && !line.contains("\"builtin:mock\"")).collect();
        let server = builtins();
        assert_eq!(client.len(), server.len(), "{client:#?}");
        for game in server {
            let aspect = serde_json::to_value(game.aspect).expect("aspect");
            let fields = format!(
                "{{ id: \"{}\", name: \"{}\", url: \"{}\", icon: \"{}\", min_players: {}, max_players: {}, aspect: {aspect} }}",
                game.id,
                game.name,
                game.url,
                game.icon.as_deref().unwrap_or_default(),
                game.min_players,
                game.max_players
            );
            assert!(client.iter().any(|line| line.ends_with(&format!("{fields};"))), "{fields} is not in builtin.ts");
        }
    }
}
