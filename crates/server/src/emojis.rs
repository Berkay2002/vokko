//! Custom guild emoji: listing, the usage rule for reactions and the GUILD_EMOJIS_UPDATE fan-out.
use std::collections::HashMap;

use vokko_protocol::api::{GatewayEvent, GuildEmoji, GuildEmojisUpdate, Snowflake};

use crate::access;
use crate::error::{ApiErr, ApiResult};
use crate::media;
use crate::state::AppState;
use crate::store;

/// Static and animated emoji a guild may hold, each (Discord's top boost tier; free in Vokko).
pub const MAX_PER_KIND: i64 = 250;
/// Largest emoji image in bytes.
pub const MAX_BYTES: i64 = 256 * 1024;

#[derive(sqlx::FromRow)]
struct EmojiRow {
    id: i64,
    name: String,
    animated: bool,
    uploader_id: Option<i64>,
    attachment_id: i64,
    key: Option<String>,
    filename: String,
}

const SELECT: &str =
    "SELECT e.id, e.name, e.animated, e.uploader_id, e.attachment_id, a.key, a.filename FROM emojis e JOIN attachments a ON a.id = e.attachment_id";

async fn to_api(state: &AppState, rows: Vec<EmojiRow>, with_users: bool) -> ApiResult<Vec<GuildEmoji>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let role_rows: Vec<(i64, i64)> =
        sqlx::query_as("SELECT emoji_id, role_id FROM emoji_roles WHERE emoji_id = ANY($1) ORDER BY role_id").bind(&ids).fetch_all(&state.db).await?;
    let mut roles: HashMap<i64, Vec<Snowflake>> = HashMap::new();
    for (emoji_id, role_id) in role_rows {
        roles.entry(emoji_id).or_default().push(Snowflake::from(role_id));
    }
    let users = if with_users {
        let mut uploader_ids: Vec<i64> = rows.iter().filter_map(|row| row.uploader_id).collect();
        uploader_ids.sort_unstable();
        uploader_ids.dedup();
        store::users(state, &uploader_ids).await?
    } else {
        HashMap::new()
    };
    Ok(rows
        .into_iter()
        .map(|row| GuildEmoji {
            id: Snowflake::from(row.id),
            roles: roles.remove(&row.id).unwrap_or_default(),
            user: row.uploader_id.and_then(|id| users.get(&id).cloned()),
            require_colons: true,
            managed: false,
            animated: row.animated,
            available: true,
            url: state.asset_url(&media::asset_path(row.attachment_id, row.key.as_deref().unwrap_or_default(), &row.filename)),
            name: row.name,
        })
        .collect())
}

/// Every emoji of a guild, oldest first; `with_users` adds the uploader (REST only).
pub async fn guild_emojis(state: &AppState, guild_id: i64, with_users: bool) -> ApiResult<Vec<GuildEmoji>> {
    let rows: Vec<EmojiRow> = sqlx::query_as(&format!("{SELECT} WHERE e.guild_id = $1 ORDER BY e.id")).bind(guild_id).fetch_all(&state.db).await?;
    to_api(state, rows, with_users).await
}

/// One emoji of a guild with its uploader; 404 10014 when it is not there.
pub async fn guild_emoji(state: &AppState, guild_id: i64, emoji_id: i64) -> ApiResult<GuildEmoji> {
    let rows: Vec<EmojiRow> =
        sqlx::query_as(&format!("{SELECT} WHERE e.guild_id = $1 AND e.id = $2")).bind(guild_id).bind(emoji_id).fetch_all(&state.db).await?;
    to_api(state, rows, true).await?.pop().ok_or_else(ApiErr::unknown_emoji)
}

/// Sends the guild's full emoji list to every member.
pub async fn broadcast(state: &AppState, guild_id: i64) -> ApiResult<()> {
    let emojis = guild_emojis(state, guild_id, false).await?;
    let members = access::guild_member_ids(state, guild_id).await?;
    state.hub.send(&members, &GatewayEvent::GuildEmojisUpdate(GuildEmojisUpdate { guild_id: Snowflake::from(guild_id), emojis }));
    Ok(())
}

/// The rule for reacting with a custom emoji: it exists (400 10014), the user is a member of its guild and, when it is
/// role-restricted, holds one of its roles (403 50013). Returns the stored (name, animated, guild id).
pub async fn usable_by(state: &AppState, user_id: i64, emoji_id: i64) -> ApiResult<(String, bool, i64)> {
    let row: Option<(i64, String, bool)> =
        sqlx::query_as("SELECT guild_id, name, animated FROM emojis WHERE id = $1").bind(emoji_id).fetch_optional(&state.db).await?;
    let Some((guild_id, name, animated)) = row else { return Err(ApiErr::conflict(10014, "Unknown Emoji")) };
    let allowed: Option<(bool,)> = sqlx::query_as(
        "SELECT NOT EXISTS (SELECT 1 FROM emoji_roles WHERE emoji_id = $1)
             OR EXISTS (SELECT 1 FROM emoji_roles er JOIN member_roles mr ON mr.role_id = er.role_id WHERE er.emoji_id = $1 AND mr.guild_id = $2 AND mr.user_id = $3)
         FROM guild_members WHERE guild_id = $2 AND user_id = $3",
    )
    .bind(emoji_id)
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    match allowed {
        Some((true,)) => Ok((name, animated, guild_id)),
        _ => Err(ApiErr::missing_permissions()),
    }
}

/// `animated` for the given custom emoji ids that still exist.
pub async fn animated_flags(state: &AppState, emoji_ids: &[i64]) -> ApiResult<HashMap<i64, bool>> {
    if emoji_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(i64, bool)> = sqlx::query_as("SELECT id, animated FROM emojis WHERE id = ANY($1)").bind(emoji_ids).fetch_all(&state.db).await?;
    Ok(rows.into_iter().collect())
}

/// Whether an image is animated: every GIF (Discord's rule) and WebP files whose VP8X header has the animation flag.
pub fn is_animated(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/gif" => true,
        "image/webp" => bytes.get(12..16) == Some(b"VP8X") && bytes.get(20).is_some_and(|flags| flags & 0x02 != 0),
        _ => false,
    }
}

/// 2-32 characters of `A-Z a-z 0-9 _`.
pub fn valid_name(name: &str) -> bool {
    (2..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_animation() {
        assert!(valid_name("ok") && valid_name("blob_wave_2") && valid_name(&"a".repeat(32)));
        assert!(!valid_name("a") && !valid_name(&"a".repeat(33)) && !valid_name("no-dash") && !valid_name("spa ce") && !valid_name("åäö"));
        assert!(is_animated("image/gif", b"GIF89a"));
        assert!(!is_animated("image/png", b""));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
        webp.extend_from_slice(&[0x02, 0, 0, 0]);
        assert!(is_animated("image/webp", &webp));
        webp[20] = 0x10;
        assert!(!is_animated("image/webp", &webp));
    }
}
