//! Message search: `GET /guilds/{id}/messages/search` and `GET /channels/{id}/messages/search` (see docs/api.md).
use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::routing::get;
use sqlx::{Postgres, QueryBuilder};
use vokko_protocol::api::MessageSearchResponse;
use vokko_protocol::api::permissions::{READ_MESSAGE_HISTORY, VIEW_CHANNEL};

use crate::access::{self, Overwrite, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::parse_id;
use crate::state::AppState;
use crate::store::{self, MESSAGE_SELECT, MessageRow};

const MAX_LIMIT: i64 = 25;
const MAX_OFFSET: i64 = 9975;
const MAX_CONTENT_CHARS: usize = 1024;
/// Plain messages and replies; pin notices, joins and the like never match.
const SEARCHABLE_KINDS: &str = "(0, 19)";

pub fn routes() -> Router<AppState> {
    Router::new().route("/guilds/{id}/messages/search", get(search_guild)).route("/channels/{id}/messages/search", get(search_channel))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Has {
    Link,
    Embed,
    File,
    Image,
    Video,
    Sound,
    Sticker,
}

#[derive(Debug, Default)]
struct Params {
    content: Option<String>,
    author_ids: Vec<i64>,
    mentions: Vec<i64>,
    has: Vec<Has>,
    channel_ids: Vec<i64>,
    pinned: Option<bool>,
    min_id: Option<i64>,
    max_id: Option<i64>,
    offset: i64,
    limit: i64,
    relevance: bool,
    ascending: bool,
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok().and_then(|pair| u8::from_str_radix(pair, 16).ok());
                match hex {
                    Some(value) => {
                        out.push(value);
                        index += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            other => out.push(other),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn snowflake(field: &str, value: &str) -> ApiResult<i64> {
    parse_id(value).ok_or_else(|| ApiErr::invalid(field, "Must be a snowflake."))
}

fn parse_params(raw: Option<&str>) -> ApiResult<Params> {
    let mut params = Params { limit: MAX_LIMIT, ..Params::default() };
    for pair in raw.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let (key, value) = (percent_decode(key), percent_decode(value));
        match key.as_str() {
            "content" => {
                if value.chars().count() > MAX_CONTENT_CHARS {
                    return Err(ApiErr::invalid("content", "Must be 1024 or fewer in length."));
                }
                if !value.trim().is_empty() {
                    params.content = Some(value);
                }
            }
            "author_id" => params.author_ids.push(snowflake("author_id", &value)?),
            "mentions" => params.mentions.push(snowflake("mentions", &value)?),
            "channel_id" => params.channel_ids.push(snowflake("channel_id", &value)?),
            "has" => params.has.push(match value.as_str() {
                "link" => Has::Link,
                "embed" => Has::Embed,
                "file" => Has::File,
                "image" => Has::Image,
                "video" => Has::Video,
                "sound" => Has::Sound,
                "sticker" => Has::Sticker,
                _ => return Err(ApiErr::invalid("has", "Must be one of link, embed, file, image, video, sound, sticker.")),
            }),
            "pinned" => {
                params.pinned = Some(match value.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => return Err(ApiErr::invalid("pinned", "Must be true or false.")),
                });
            }
            "min_id" => params.min_id = Some(snowflake("min_id", &value)?),
            "max_id" => params.max_id = Some(snowflake("max_id", &value)?),
            "offset" => {
                params.offset = value
                    .parse::<i64>()
                    .ok()
                    .filter(|offset| (0..=MAX_OFFSET).contains(offset))
                    .ok_or_else(|| ApiErr::invalid("offset", "Must be between 0 and 9975."))?;
            }
            "limit" => {
                params.limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|limit| (1..=MAX_LIMIT).contains(limit))
                    .ok_or_else(|| ApiErr::invalid("limit", "Must be between 1 and 25."))?;
            }
            "sort_by" => {
                params.relevance = match value.as_str() {
                    "timestamp" => false,
                    "relevance" => true,
                    _ => return Err(ApiErr::invalid("sort_by", "Must be timestamp or relevance.")),
                };
            }
            "sort_order" => {
                params.ascending = match value.as_str() {
                    "desc" => false,
                    "asc" => true,
                    _ => return Err(ApiErr::invalid("sort_order", "Must be asc or desc.")),
                };
            }
            _ => {}
        }
    }
    Ok(params)
}

/// Appends ` WHERE ...` for the readable channels and every filter. Shared by the page query and the count query.
fn push_filters(builder: &mut QueryBuilder<'_, Postgres>, params: &Params, channels: &[i64]) {
    builder.push(" WHERE m.channel_id = ANY(").push_bind(channels.to_vec()).push(") AND m.kind IN ").push(SEARCHABLE_KINDS);
    if let Some(content) = &params.content {
        builder.push(" AND m.search_tsv @@ websearch_to_tsquery('simple', ").push_bind(content.clone()).push(")");
    }
    if !params.author_ids.is_empty() {
        builder.push(" AND m.author_id = ANY(").push_bind(params.author_ids.clone()).push(")");
    }
    if !params.mentions.is_empty() {
        builder
            .push(" AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ANY(")
            .push_bind(params.mentions.clone())
            .push("))");
    }
    for has in &params.has {
        builder.push(match has {
            Has::Link => " AND m.content ~* 'https?://'",
            Has::Embed => " AND jsonb_array_length(m.embeds) > 0",
            Has::File => " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)",
            Has::Image => {
                " AND (EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%') \
                 OR m.embeds @> '[{\"type\": \"image\"}]'::jsonb)"
            }
            Has::Video => {
                " AND (EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'video/%') \
                 OR m.embeds @> '[{\"type\": \"video\"}]'::jsonb OR m.embeds @> '[{\"type\": \"gifv\"}]'::jsonb)"
            }
            Has::Sound => " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'audio/%')",
            Has::Sticker => " AND FALSE",
        });
    }
    if let Some(pinned) = params.pinned {
        builder.push(" AND m.pinned = ").push_bind(pinned);
    }
    if let Some(min_id) = params.min_id {
        builder.push(" AND m.id > ").push_bind(min_id);
    }
    if let Some(max_id) = params.max_id {
        builder.push(" AND m.id < ").push_bind(max_id);
    }
}

async fn run(state: &AppState, user_id: i64, params: &Params, channels: Vec<i64>) -> ApiResult<Json<MessageSearchResponse>> {
    if channels.is_empty() {
        return Ok(Json(MessageSearchResponse { total_results: 0, messages: Vec::new() }));
    }
    let mut count = QueryBuilder::<Postgres>::new("SELECT count(*) FROM messages m");
    push_filters(&mut count, params, &channels);
    let total: i64 = count.build_query_scalar().fetch_one(&state.db).await?;

    let direction = if params.ascending { "ASC" } else { "DESC" };
    let mut page = QueryBuilder::<Postgres>::new(MESSAGE_SELECT);
    push_filters(&mut page, params, &channels);
    page.push(" ORDER BY ");
    if let (true, Some(content)) = (params.relevance, &params.content) {
        page.push("ts_rank(m.search_tsv, websearch_to_tsquery('simple', ").push_bind(content.clone()).push(")) ").push(direction).push(", ");
    }
    page.push("m.id ").push(direction).push(" LIMIT ").push_bind(params.limit).push(" OFFSET ").push_bind(params.offset);
    let rows: Vec<MessageRow> = page.build_query_as().fetch_all(&state.db).await?;
    let messages = store::load_messages(state, rows, Some(user_id)).await?.into_iter().map(|view| vec![view.message]).collect();
    Ok(Json(MessageSearchResponse { total_results: total.max(0) as u64, messages }))
}

/// Channels of the guild where `user_id` has VIEW_CHANNEL and READ_MESSAGE_HISTORY after overwrites and timeout.
async fn readable_guild_channels(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<Vec<i64>> {
    let guild = access::guild_access(state, user_id, guild_id).await?;
    let channels: Vec<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE guild_id = $1").bind(guild_id).fetch_all(&state.db).await?;
    let rows: Vec<(i64, i64, i16, i64, i64)> = sqlx::query_as(
        "SELECT o.channel_id, o.target_id, o.target_type, o.allow, o.deny FROM permission_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = $1",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    let mut overwrites: HashMap<i64, Vec<Overwrite>> = HashMap::new();
    for (channel_id, target_id, target_type, allow, deny) in rows {
        overwrites.entry(channel_id).or_default().push(Overwrite { target_id, target_type, allow: allow as u64, deny: deny as u64 });
    }
    let wanted = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
    Ok(channels
        .into_iter()
        .map(|(id,)| id)
        .filter(|id| {
            let list = overwrites.get(id).map(Vec::as_slice).unwrap_or(&[]);
            let resolved = access::channel_permissions(guild.permissions, guild_id, user_id, &guild.roles, list);
            // Same as `channel_access`: overwrites may allow more than the timeout clamp lets through.
            let permissions = if guild.owner_id == user_id { resolved } else { access::clamp_timeout(resolved, guild.timed_out) };
            permissions & wanted == wanted
        })
        .collect())
}

async fn search_guild(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<MessageSearchResponse>> {
    let guild_id = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    let params = parse_params(raw.as_deref())?;
    let mut channels = readable_guild_channels(&state, user_id, guild_id).await?;
    if !params.channel_ids.is_empty() {
        channels.retain(|id| params.channel_ids.contains(id));
    }
    run(&state, user_id, &params, channels).await
}

async fn search_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<MessageSearchResponse>> {
    let channel_id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let params = parse_params(raw.as_deref())?;
    let access = channel_access(&state, user_id, channel_id).await?;
    let channels = if access.permissions & READ_MESSAGE_HISTORY == 0 { Vec::new() } else { vec![channel_id] };
    run(&state, user_id, &params, channels).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_and_plus() {
        assert_eq!(percent_decode("a%20b+c%C3%A5%2"), "a b cå%2");
        assert_eq!(percent_decode("%"), "%");
    }

    #[test]
    fn repeated_keys_and_defaults() {
        let params = parse_params(Some("content=hej%20d%C3%A4r&has=image&has=link&author_id=1&author_id=2&min_id=5&unknown=x")).expect("params");
        assert_eq!(params.content.as_deref(), Some("hej där"));
        assert_eq!(params.has, vec![Has::Image, Has::Link]);
        assert_eq!(params.author_ids, vec![1, 2]);
        assert_eq!((params.limit, params.offset, params.min_id), (25, 0, Some(5)));
    }

    #[test]
    fn rejects_out_of_range() {
        for raw in ["limit=26", "limit=0", "offset=-1", "offset=9976", "has=gif", "min_id=abc", "pinned=maybe", "sort_by=best", "sort_order=up"] {
            assert!(parse_params(Some(raw)).is_err(), "{raw}");
        }
    }
}
