//! Guild stickers: loading, validation of uploads, resolution for messages and cleanup of their image files.
use std::collections::HashMap;

use sqlx::FromRow;
use vokko_protocol::api::permissions::USE_EXTERNAL_STICKERS;
use vokko_protocol::api::{GatewayEvent, GuildStickersUpdate, Snowflake, Sticker, StickerFormat};

use crate::access;
use crate::error::{ApiErr, ApiResult};
use crate::media;
use crate::state::AppState;
use crate::store::{self, ChannelRow};

pub const MAX_STICKER_BYTES: i64 = 512 * 1024;
pub const MAX_STICKER_DIMENSION: u32 = 512;
pub const MAX_STICKERS_PER_MESSAGE: usize = 3;

#[derive(FromRow)]
struct StickerRow {
    id: i64,
    guild_id: i64,
    name: String,
    description: Option<String>,
    tags: String,
    format: i16,
    asset_path: String,
    creator_id: Option<i64>,
}

const COLS: &str = "id, guild_id, name, description, tags, format, asset_path, creator_id";

fn format_of(value: i16) -> StickerFormat {
    StickerFormat::from_u8(value as u8).unwrap_or(StickerFormat::Png)
}

async fn to_api(state: &AppState, rows: Vec<StickerRow>) -> ApiResult<Vec<Sticker>> {
    let mut creators: Vec<i64> = rows.iter().filter_map(|row| row.creator_id).collect();
    creators.sort_unstable();
    creators.dedup();
    let users = store::users(state, &creators).await?;
    Ok(rows
        .into_iter()
        .map(|row| Sticker {
            id: Snowflake::from(row.id),
            guild_id: Snowflake::from(row.guild_id),
            name: row.name,
            description: row.description,
            tags: row.tags,
            format_type: format_of(row.format),
            url: state.asset_url(&row.asset_path),
            available: true,
            user: row.creator_id.and_then(|id| users.get(&id).cloned()),
        })
        .collect())
}

/// Stickers of the given guilds, oldest first.
pub async fn of_guilds(state: &AppState, guild_ids: &[i64]) -> ApiResult<HashMap<i64, Vec<Sticker>>> {
    let rows: Vec<StickerRow> =
        sqlx::query_as(&format!("SELECT {COLS} FROM stickers WHERE guild_id = ANY($1) ORDER BY id")).bind(guild_ids).fetch_all(&state.db).await?;
    let mut map: HashMap<i64, Vec<Sticker>> = HashMap::new();
    for sticker in to_api(state, rows).await? {
        map.entry(sticker.guild_id.db()).or_default().push(sticker);
    }
    Ok(map)
}

pub async fn of_guild(state: &AppState, guild_id: i64) -> ApiResult<Vec<Sticker>> {
    Ok(of_guilds(state, &[guild_id]).await?.remove(&guild_id).unwrap_or_default())
}

pub async fn find(state: &AppState, guild_id: i64, id: i64) -> ApiResult<Option<(Sticker, Option<i64>)>> {
    let row: Option<StickerRow> =
        sqlx::query_as(&format!("SELECT {COLS} FROM stickers WHERE id = $1 AND guild_id = $2")).bind(id).bind(guild_id).fetch_optional(&state.db).await?;
    let Some(row) = row else { return Ok(None) };
    let creator = row.creator_id;
    Ok(to_api(state, vec![row]).await?.pop().map(|sticker| (sticker, creator)))
}

/// GUILD_STICKERS_UPDATE with the full list to every member.
pub async fn broadcast(state: &AppState, guild_id: i64) -> ApiResult<()> {
    let stickers = of_guild(state, guild_id).await?;
    let members = access::guild_member_ids(state, guild_id).await?;
    state.hub.send(&members, &GatewayEvent::GuildStickersUpdate(GuildStickersUpdate { guild_id: Snowflake::from(guild_id), stickers }));
    Ok(())
}

/// Deletes sticker image files nothing refers to any more (deleted stickers, deleted guilds, deleted messages).
pub async fn sweep_assets(state: &AppState) {
    let deleted: Result<Vec<(i64,)>, _> = sqlx::query_as(
        "DELETE FROM attachments a WHERE a.sticker_asset \
         AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.attachment_id = a.id) \
         AND NOT EXISTS (SELECT 1 FROM message_stickers ms WHERE ms.attachment_id = a.id) RETURNING a.id",
    )
    .fetch_all(&state.db)
    .await;
    match deleted {
        Ok(rows) => media::remove_files(state, &rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await,
        Err(error) => tracing::warn!("sticker asset sweep failed: {error}"),
    }
}

/// PNG, GIF and WebP by content type; a PNG with an `acTL` chunk before its image data is an APNG.
pub fn detect_format(content_type: &str, bytes: &[u8]) -> Option<StickerFormat> {
    match content_type {
        "image/png" => Some(if is_apng(bytes) { StickerFormat::Apng } else { StickerFormat::Png }),
        "image/gif" => Some(StickerFormat::Gif),
        "image/webp" => Some(StickerFormat::Webp),
        _ => None,
    }
}

fn is_apng(bytes: &[u8]) -> bool {
    let mut at = 8;
    while at + 8 <= bytes.len() {
        let length = u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        match &bytes[at + 4..at + 8] {
            b"acTL" => return true,
            b"IDAT" | b"IEND" => return false,
            _ => {}
        }
        at = at.saturating_add(12).saturating_add(length);
    }
    false
}

/// A sticker as attached to a message (a copy of what the message needs to keep).
pub struct StickerRef {
    pub sticker_id: i64,
    pub name: String,
    pub format: StickerFormat,
    pub attachment_id: i64,
    pub asset_path: String,
}

/// Validates `sticker_ids` of a new message for `user_id` in `channel` with `permissions`.
/// Unknown stickers and stickers of guilds the sender is not in are the same "Unknown sticker." error.
pub async fn resolve_for_message(state: &AppState, user_id: i64, channel: &ChannelRow, permissions: u64, ids: &[Snowflake]) -> ApiResult<Vec<StickerRef>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut unique: Vec<i64> = Vec::new();
    for id in ids {
        if !unique.contains(&id.db()) {
            unique.push(id.db());
        }
    }
    if unique.len() > MAX_STICKERS_PER_MESSAGE {
        return Err(ApiErr::invalid("sticker_ids", "A message can have at most 3 stickers."));
    }
    let unknown = || ApiErr::invalid("sticker_ids", "Unknown sticker.");
    let rows: Vec<(i64, i64, String, i16, i64, String)> = sqlx::query_as(
        "SELECT s.id, s.guild_id, s.name, s.format, s.attachment_id, s.asset_path FROM stickers s \
         JOIN guild_members m ON m.guild_id = s.guild_id AND m.user_id = $2 WHERE s.id = ANY($1)",
    )
    .bind(&unique)
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let mut refs = Vec::with_capacity(unique.len());
    for id in &unique {
        let (_, guild_id, name, format, attachment_id, asset_path) = rows.iter().find(|row| row.0 == *id).cloned().ok_or_else(unknown)?;
        if !channel.is_dm() && channel.guild_id != Some(guild_id) && permissions & USE_EXTERNAL_STICKERS == 0 {
            return Err(ApiErr::missing_permissions());
        }
        refs.push(StickerRef { sticker_id: *id, name, format: format_of(format), attachment_id, asset_path });
    }
    Ok(refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0; 4]);
        out
    }

    #[test]
    fn apng_is_a_png_with_an_actl_chunk_before_the_data() {
        let signature = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let mut plain = signature.to_vec();
        plain.extend(chunk(b"IHDR", &[0; 13]));
        plain.extend(chunk(b"IDAT", &[1, 2, 3]));
        plain.extend(chunk(b"acTL", &[0; 8]));
        assert_eq!(detect_format("image/png", &plain), Some(StickerFormat::Png));
        let mut animated = signature.to_vec();
        animated.extend(chunk(b"IHDR", &[0; 13]));
        animated.extend(chunk(b"acTL", &[0; 8]));
        animated.extend(chunk(b"IDAT", &[1, 2, 3]));
        assert_eq!(detect_format("image/png", &animated), Some(StickerFormat::Apng));
        assert_eq!(detect_format("image/gif", b"GIF89a"), Some(StickerFormat::Gif));
        assert_eq!(detect_format("image/jpeg", b""), None);
    }
}
