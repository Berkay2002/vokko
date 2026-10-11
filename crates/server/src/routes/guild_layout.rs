//! Per-user guild layout stored on the server: server folders and the rail order.
use std::collections::HashSet;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::get;
use vokko_protocol::api::{GatewayEvent, GuildFolder, GuildLayout, Snowflake, UpdateGuildLayoutRequest};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me/guild-layout", get(get_settings).patch(update_settings))
}

const MAX_FOLDERS: usize = 100;
const MAX_GUILDS: usize = 200;
/// Across all folders, and the length of `guild_positions`.
const MAX_LAYOUT_GUILDS: usize = 1000;
const MAX_FOLDER_NAME_CHARS: usize = 32;
const MAX_RGB: u32 = 0xff_ffff;

/// The stored settings, or the defaults (no folders, no explicit order).
pub async fn load(state: &AppState, user_id: i64) -> ApiResult<GuildLayout> {
    let row: Option<(String, Vec<i64>)> =
        sqlx::query_as("SELECT guild_folders, guild_positions FROM user_guild_layout WHERE user_id = $1").bind(user_id).fetch_optional(&state.db).await?;
    let Some((folders, positions)) = row else { return Ok(GuildLayout::default()) };
    // Only valid JSON is ever written; a broken value reads as no folders rather than failing READY.
    let guild_folders = serde_json::from_str(&folders).unwrap_or_default();
    Ok(GuildLayout { guild_folders, guild_positions: positions.into_iter().map(Snowflake::from).collect() })
}

async fn get_settings(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<GuildLayout>> {
    Ok(Json(load(&state, user_id).await?))
}

fn clean_folders(folders: Vec<GuildFolder>) -> ApiResult<Vec<GuildFolder>> {
    if folders.len() > MAX_FOLDERS {
        return Err(ApiErr::invalid("guild_folders", &format!("At most {MAX_FOLDERS} folders.")));
    }
    if folders.iter().map(|folder| folder.guild_ids.len()).sum::<usize>() > MAX_LAYOUT_GUILDS {
        return Err(ApiErr::invalid("guild_folders", &format!("At most {MAX_LAYOUT_GUILDS} servers in folders.")));
    }
    let mut ids = HashSet::new();
    let mut guilds = HashSet::new();
    let mut out = Vec::with_capacity(folders.len());
    for folder in folders {
        if !ids.insert(folder.id) {
            return Err(ApiErr::invalid("guild_folders", "Folder ids must be unique."));
        }
        let name = folder.name.map(|name| name.trim().to_owned()).filter(|name| !name.is_empty());
        if name.as_ref().is_some_and(|name| name.chars().count() > MAX_FOLDER_NAME_CHARS) {
            return Err(ApiErr::invalid("guild_folders", &format!("Folder names are at most {MAX_FOLDER_NAME_CHARS} characters.")));
        }
        if folder.color.is_some_and(|color| color > MAX_RGB) {
            return Err(ApiErr::invalid("guild_folders", "Folder colours are RGB ints between 0 and 16777215."));
        }
        if folder.guild_ids.is_empty() || folder.guild_ids.len() > MAX_GUILDS {
            return Err(ApiErr::invalid("guild_folders", &format!("A folder holds 1-{MAX_GUILDS} servers.")));
        }
        if !folder.guild_ids.iter().all(|id| guilds.insert(*id)) {
            return Err(ApiErr::invalid("guild_folders", "A server can be in one folder only."));
        }
        out.push(GuildFolder { id: folder.id, name, color: folder.color, guild_ids: folder.guild_ids });
    }
    Ok(out)
}

fn clean_positions(positions: Vec<Snowflake>) -> ApiResult<Vec<i64>> {
    if positions.len() > MAX_LAYOUT_GUILDS {
        return Err(ApiErr::invalid("guild_positions", &format!("At most {MAX_LAYOUT_GUILDS} servers.")));
    }
    let mut seen = HashSet::new();
    if !positions.iter().all(|id| seen.insert(*id)) {
        return Err(ApiErr::invalid("guild_positions", "No server can be listed twice."));
    }
    Ok(positions.into_iter().map(Snowflake::db).collect())
}

async fn update_settings(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<UpdateGuildLayoutRequest>,
) -> ApiResult<Json<GuildLayout>> {
    // Validate every key first so a rejected request changes nothing.
    let folders = body.guild_folders.map(clean_folders).transpose()?;
    let positions = body.guild_positions.map(clean_positions).transpose()?;
    let folders_json = folders.map(|folders| serde_json::to_string(&folders)).transpose().map_err(|_| ApiErr::internal())?;
    sqlx::query(
        "INSERT INTO user_guild_layout (user_id, guild_folders, guild_positions) VALUES ($1, COALESCE($2, '[]'), COALESCE($3, '{}')) \
         ON CONFLICT (user_id) DO UPDATE SET guild_folders = COALESCE($2, user_guild_layout.guild_folders), \
           guild_positions = COALESCE($3, user_guild_layout.guild_positions)",
    )
    .bind(user_id)
    .bind(folders_json)
    .bind(positions)
    .execute(&state.db)
    .await?;
    let settings = load(&state, user_id).await?;
    state.hub.send(&[user_id], &GatewayEvent::GuildLayoutUpdate(settings.clone()));
    Ok(Json(settings))
}
