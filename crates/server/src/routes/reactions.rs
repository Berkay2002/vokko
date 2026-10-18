use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use serde::Deserialize;
use vokko_protocol::api::permissions::{ADD_REACTIONS, READ_MESSAGE_HISTORY, USE_EXTERNAL_EMOJIS};
use vokko_protocol::api::{GatewayEvent, MessageReaction, ReactionEmoji, ReactionType, Snowflake, User};

use crate::access::{self, channel_access};
use crate::auth::AuthUser;
use crate::emojis;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiQuery, parse_id};
use crate::state::AppState;
use crate::store;

const MAX_DISTINCT_REACTIONS: i64 = 20;
/// Row filter for one reaction emoji (`$2` name, `$3` id): a custom emoji matches by id alone, so a renamed emoji stays one reaction.
const SAME_EMOJI: &str = "emoji_id = $3 AND ($3 <> 0 OR emoji_name = $2)";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/messages/{mid}/reactions/{emoji}/@me", put(add_reaction).delete(remove_reaction))
        .route("/channels/{id}/messages/{mid}/reactions/{emoji}", get(list_reactors))
}

/// `😀` for unicode emoji, `name:id` for custom emoji (the path segment is already percent-decoded).
pub fn parse_emoji(raw: &str) -> ApiResult<ReactionEmoji> {
    let invalid = || ApiErr::invalid("emoji", "Unknown Emoji");
    if let Some((name, id)) = raw.split_once(':') {
        let id = parse_id(id).ok_or_else(invalid)?;
        let valid_name = (2..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_name {
            return Err(invalid());
        }
        return Ok(ReactionEmoji { id: Some(Snowflake::from(id)), name: name.to_owned(), animated: None });
    }
    let name = raw.trim();
    if name.is_empty() || name.len() > 64 || (!is_keycap(name) && name.chars().any(|c| c.is_ascii_alphanumeric() || c.is_control() || c.is_whitespace())) {
        return Err(invalid());
    }
    Ok(ReactionEmoji { id: None, name: name.to_owned(), animated: None })
}

/// A keycap emoji (`1️⃣`, `#️⃣`, `*️⃣`): `0`-`9`, `#` or `*`, an optional U+FE0F, then U+20E3. The only emoji with an ASCII
/// digit in them; the unqualified form without U+FE0F (`1⃣`) is still the same keycap, so it is accepted too.
fn is_keycap(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(base) = chars.next() else { return false };
    (base.is_ascii_digit() || base == '#' || base == '*') && matches!(chars.as_str(), "\u{20E3}" | "\u{FE0F}\u{20E3}")
}

/// `?type=0|1` on the reaction routes; absent = 0 (normal), like Discord.
#[derive(Deserialize)]
struct TypeQuery {
    #[serde(rename = "type")]
    kind: Option<u8>,
}

fn reaction_type(kind: Option<u8>) -> ApiResult<ReactionType> {
    match kind {
        None | Some(0) => Ok(ReactionType::Normal),
        Some(1) => Ok(ReactionType::Burst),
        Some(_) => Err(ApiErr::invalid("type", "Must be 0 (normal) or 1 (burst).")),
    }
}

fn reaction_event(user_id: i64, channel_id: i64, message_id: i64, emoji: ReactionEmoji, kind: ReactionType) -> MessageReaction {
    MessageReaction {
        user_id: Snowflake::from(user_id),
        channel_id: Snowflake::from(channel_id),
        message_id: Snowflake::from(message_id),
        emoji,
        kind,
        burst: kind == ReactionType::Burst,
        message_author_id: None,
    }
}

/// The channel access and the message's `(id, author_id)`.
async fn locate(state: &AppState, user_id: i64, channel: &str, message: &str) -> ApiResult<(access::ChannelAccess, (i64, i64))> {
    let channel_id = parse_id(channel).ok_or_else(ApiErr::unknown_channel)?;
    let message_id = parse_id(message).ok_or_else(ApiErr::unknown_message)?;
    let access = channel_access(state, user_id, channel_id).await?;
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2").bind(message_id).bind(channel_id).fetch_optional(&state.db).await?;
    let (author_id,) = found.ok_or_else(ApiErr::unknown_message)?;
    Ok((access, (message_id, author_id)))
}

async fn add_reaction(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, emoji)): Path<(String, String, String)>,
    ApiQuery(query): ApiQuery<TypeQuery>,
) -> ApiResult<StatusCode> {
    let mut emoji = parse_emoji(&emoji)?;
    let kind = reaction_type(query.kind)?;
    let (access, (message_id, author_id)) = locate(&state, user_id, &id, &mid).await?;
    access.require(READ_MESSAGE_HISTORY)?;
    access.require(ADD_REACTIONS)?;
    access.require_unarchived()?;
    if let Some(guild_id) = access.channel.guild_id {
        crate::safety::check_rules_accepted(&state, guild_id, user_id).await?;
    }
    // A reaction reaches the other side of a 1:1 DM like a message does: blocks and their DM privacy apply.
    if access.channel.channel_type() == vokko_protocol::api::ChannelType::Dm {
        crate::routes::messages::require_dm_open(&state, access.channel.id, user_id).await?;
    }
    let emoji_id = emoji.id.map(Snowflake::db).unwrap_or(0);
    if emoji_id != 0 {
        let (name, animated, emoji_guild) = emojis::usable_by(&state, user_id, emoji_id).await?;
        // Another guild's emoji in a guild channel needs USE_EXTERNAL_EMOJIS there (on for @everyone by default); DMs never do.
        if access.channel.guild_id.is_some_and(|guild_id| guild_id != emoji_guild) {
            access.require(USE_EXTERNAL_EMOJIS)?;
        }
        emoji.name = name;
        emoji.animated = Some(animated);
    }
    let (distinct, existing): (i64, bool) = sqlx::query_as(&format!(
        "SELECT count(DISTINCT CASE WHEN emoji_id = 0 THEN emoji_name ELSE emoji_id::TEXT END), COALESCE(bool_or({SAME_EMOJI}), FALSE) FROM reactions WHERE message_id = $1"
    ))
    .bind(message_id)
    .bind(&emoji.name)
    .bind(emoji_id)
    .fetch_one(&state.db)
    .await?;
    if !existing && distinct >= MAX_DISTINCT_REACTIONS {
        return Err(ApiErr::conflict(30010, "Maximum number of reactions reached (20)"));
    }
    // Burst reactions have no weekly limit in Vokko; the 20 distinct emoji cap covers both types together.
    let inserted = sqlx::query(
        "INSERT INTO reactions (message_id, user_id, emoji_name, emoji_id, burst) SELECT $1, $4, $2, $3, $5
         WHERE NOT EXISTS (SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $4 AND emoji_id = $3 AND ($3 <> 0 OR emoji_name = $2) AND burst = $5)
         ON CONFLICT DO NOTHING",
    )
    .bind(message_id)
    .bind(&emoji.name)
    .bind(emoji_id)
    .bind(user_id)
    .bind(kind == ReactionType::Burst)
    .execute(&state.db)
    .await?;
    if inserted.rows_affected() > 0 {
        let viewers = access::channel_viewers(&state, &access.channel).await?;
        let event =
            MessageReaction { message_author_id: Some(Snowflake::from(author_id)), ..reaction_event(user_id, access.channel.id, message_id, emoji, kind) };
        state.hub.send(&viewers, &GatewayEvent::MessageReactionAdd(event));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_reaction(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, emoji)): Path<(String, String, String)>,
    ApiQuery(query): ApiQuery<TypeQuery>,
) -> ApiResult<StatusCode> {
    let mut emoji = parse_emoji(&emoji)?;
    let kind = reaction_type(query.kind)?;
    let (access, (message_id, _)) = locate(&state, user_id, &id, &mid).await?;
    let emoji_id = emoji.id.map(Snowflake::db).unwrap_or(0);
    let removed: Vec<(String,)> =
        sqlx::query_as(&format!("DELETE FROM reactions WHERE message_id = $1 AND user_id = $4 AND {SAME_EMOJI} AND burst = $5 RETURNING emoji_name"))
            .bind(message_id)
            .bind(&emoji.name)
            .bind(emoji_id)
            .bind(user_id)
            .bind(kind == ReactionType::Burst)
            .fetch_all(&state.db)
            .await?;
    if let Some((name,)) = removed.into_iter().next() {
        emoji.name = name;
        emoji.animated = emojis::animated_flags(&state, &[emoji_id]).await?.get(&emoji_id).copied();
        let viewers = access::channel_viewers(&state, &access.channel).await?;
        let event = reaction_event(user_id, access.channel.id, message_id, emoji, kind);
        state.hub.send(&viewers, &GatewayEvent::MessageReactionRemove(event));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ReactorsQuery {
    limit: Option<i64>,
    after: Option<Snowflake>,
    #[serde(rename = "type")]
    kind: Option<u8>,
}

async fn list_reactors(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, emoji)): Path<(String, String, String)>,
    ApiQuery(query): ApiQuery<ReactorsQuery>,
) -> ApiResult<Json<Vec<User>>> {
    let emoji = parse_emoji(&emoji)?;
    let kind = reaction_type(query.kind)?;
    let (access, (message_id, _)) = locate(&state, user_id, &id, &mid).await?;
    access.require(READ_MESSAGE_HISTORY)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let rows: Vec<(i64,)> = sqlx::query_as(&format!(
        "SELECT user_id FROM reactions WHERE message_id = $1 AND {SAME_EMOJI} AND burst = $4 AND user_id > $5 ORDER BY user_id LIMIT $6"
    ))
    .bind(message_id)
    .bind(&emoji.name)
    .bind(emoji.id.map(Snowflake::db).unwrap_or(0))
    .bind(kind == ReactionType::Burst)
    .bind(query.after.map(Snowflake::db).unwrap_or(0))
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let ids: Vec<i64> = rows.into_iter().map(|(id,)| id).collect();
    let mut users = store::users(&state, &ids).await?;
    Ok(Json(ids.into_iter().filter_map(|id| users.remove(&id)).collect()))
}

#[cfg(test)]
mod tests {
    use super::parse_emoji;

    #[test]
    fn keycaps_are_unicode_emoji() {
        for raw in ["1\u{FE0F}\u{20E3}", "0\u{FE0F}\u{20E3}", "9\u{FE0F}\u{20E3}", "#\u{FE0F}\u{20E3}", "*\u{FE0F}\u{20E3}", "1\u{20E3}", "#\u{20E3}"] {
            let emoji = parse_emoji(raw).unwrap_or_else(|_| panic!("{raw:?} should parse"));
            assert_eq!((emoji.id, emoji.name.as_str()), (None, raw));
        }
    }

    #[test]
    fn plain_ascii_and_broken_keycaps_are_rejected() {
        let bad = [
            "",
            " ",
            "1",
            "a",
            "abc",
            "12\u{20E3}",
            "a\u{20E3}",
            "a\u{FE0F}\u{20E3}",
            "1\u{FE0F}",
            "1\u{20E3}\u{20E3}",
            "1\u{FE0F}\u{20E3}1",
            "1 \u{20E3}",
            "\u{1F600}a",
            "\u{1F600} \u{1F600}",
            "\u{1F600}\u{7}\u{1F600}",
        ];
        for raw in bad {
            assert!(parse_emoji(raw).is_err(), "{raw:?} should be rejected");
        }
        assert!(parse_emoji(&"\u{1F600}".repeat(17)).is_err(), "over 64 bytes");
    }

    #[test]
    fn plain_unicode_and_custom_emoji_still_parse() {
        assert_eq!(parse_emoji("\u{1F600}").unwrap().name, "\u{1F600}");
        assert_eq!(parse_emoji("\u{1F44D}\u{1F3FD}").unwrap().name, "\u{1F44D}\u{1F3FD}");
        let custom = parse_emoji("party_1:123").unwrap();
        assert_eq!((custom.id.map(|id| id.db()), custom.name.as_str()), (Some(123), "party_1"));
        assert!(parse_emoji("1\u{FE0F}\u{20E3}:123").is_err(), "a keycap is not a custom emoji name");
    }
}
