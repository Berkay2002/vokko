//! Friend suggestions: people who share a small guild with the caller or are friends of their friends, minus everyone who
//! blocked or was blocked, opted out, or was dismissed.
use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch};
use serde::Deserialize;
use vokko_protocol::api::{FriendSuggestion, FriendSuggestionSettings, FriendSuggestionsResponse, MutualGuild, Snowflake};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::state::AppState;
use crate::store;

/// Guilds larger than this are not a reason to suggest anyone: in a big community everybody would see everybody.
const SMALL_GUILD_MEMBERS: i64 = 200;
const DEFAULT_LIMIT: i64 = 25;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/friend-suggestions", get(list))
        .route("/users/@me/friend-suggestions/{id}", delete(dismiss))
        .route("/users/@me/friend-suggestion-settings", patch(update_settings))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

async fn enabled(state: &AppState, user_id: i64) -> ApiResult<bool> {
    let row: Option<(bool,)> = sqlx::query_as("SELECT friend_suggestions FROM users WHERE id = $1").bind(user_id).fetch_optional(&state.db).await?;
    row.map(|(enabled,)| enabled).ok_or_else(ApiErr::unauthorized)
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiQuery(query): ApiQuery<ListQuery>) -> ApiResult<Json<FriendSuggestionsResponse>> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    if !enabled(&state, user_id).await? {
        return Ok(Json(FriendSuggestionsResponse { enabled: false, suggestions: Vec::new() }));
    }
    // `relationships` holds both directions, so one lookup on (caller, candidate) also finds people who blocked the caller.
    // `visible` is the profile's mutual friend count (users::mutual_friend_ids): candidates have no relationship with the
    // caller, so its context is a shared guild of any size or a DM with a message, and friendships never coexist with a block.
    // Ranking by it keeps hidden counts out of the order. `mutuals` is the candidate's share_mutuals (presence::sharing: unset
    // follows share_activity, default on); off, neither mutual friends nor shared guilds rank them.
    let ranked: Vec<(i64, i64, bool)> = sqlx::query_as(
        "WITH eligible AS ( \
             SELECT u.id, COALESCE((SELECT CASE WHEN jsonb_typeof(st.settings->'share_mutuals') = 'boolean' THEN (st.settings->>'share_mutuals')::boolean \
                                               WHEN jsonb_typeof(st.settings->'share_activity') = 'boolean' THEN (st.settings->>'share_activity')::boolean END \
                                    FROM user_settings st WHERE st.user_id = u.id), TRUE) AS mutuals \
             FROM users u WHERE u.id <> $1 AND NOT u.bot AND u.friend_suggestions \
               AND NOT EXISTS (SELECT 1 FROM relationships r WHERE (r.user_id = $1 AND r.other_id = u.id) OR (r.user_id = u.id AND r.other_id = $1)) \
               AND NOT EXISTS (SELECT 1 FROM friend_suggestion_dismissals d WHERE d.user_id = $1 AND d.other_id = u.id) \
         ), shared AS ( \
             SELECT m2.user_id AS other, count(*) AS guilds FROM guild_members m1 JOIN guild_members m2 ON m2.guild_id = m1.guild_id AND m2.user_id <> $1 \
             WHERE m1.user_id = $1 AND (SELECT count(*) FROM guild_members c WHERE c.guild_id = m1.guild_id) <= $3 GROUP BY m2.user_id \
         ), mutual AS ( \
             SELECT b.other_id AS other, count(*) AS friends FROM relationships a JOIN relationships b ON b.user_id = a.other_id AND b.kind = 1 \
             WHERE a.user_id = $1 AND a.kind = 1 AND b.other_id <> $1 GROUP BY b.other_id \
         ), context AS ( \
             SELECT g.user_id AS other FROM guild_members f JOIN guild_members g ON g.guild_id = f.guild_id WHERE f.user_id = $1 \
             UNION SELECT d.user_id FROM channel_recipients c JOIN channel_recipients d ON d.channel_id = c.channel_id \
                   JOIN channels ch ON ch.id = c.channel_id AND ch.last_message_id IS NOT NULL WHERE c.user_id = $1 \
         ) \
         SELECT e.id, CASE WHEN e.mutuals AND EXISTS (SELECT 1 FROM context x WHERE x.other = e.id) THEN COALESCE(m.friends, 0) ELSE 0 END AS visible, \
                e.mutuals \
         FROM eligible e LEFT JOIN shared s ON s.other = e.id LEFT JOIN mutual m ON m.other = e.id \
         WHERE s.other IS NOT NULL OR (m.other IS NOT NULL AND e.mutuals) \
         ORDER BY visible DESC, CASE WHEN e.mutuals THEN COALESCE(s.guilds, 0) ELSE 0 END DESC, e.id LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .bind(SMALL_GUILD_MEMBERS)
    .fetch_all(&state.db)
    .await?;
    let ids: Vec<i64> = ranked.iter().map(|(id, _, _)| *id).collect();
    let users = store::users(&state, &ids).await?;
    let shared: Vec<(i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT b.user_id, a.guild_id, b.nick FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id \
         WHERE a.user_id = $1 AND b.user_id = ANY($2) AND (SELECT count(*) FROM guild_members c WHERE c.guild_id = a.guild_id) <= $3 ORDER BY a.guild_id",
    )
    .bind(user_id)
    .bind(&ids)
    .bind(SMALL_GUILD_MEMBERS)
    .fetch_all(&state.db)
    .await?;
    let mut guilds: HashMap<i64, Vec<MutualGuild>> = HashMap::new();
    for (other, guild, nick) in shared {
        guilds.entry(other).or_default().push(MutualGuild { id: Snowflake::from(guild), nick });
    }
    let mut suggestions = Vec::new();
    for (id, visible, show) in ranked {
        let Some(user) = users.get(&id) else { continue };
        // the profile's "share mutuals" opt-out holds here too
        suggestions.push(FriendSuggestion {
            user: user.clone(),
            mutual_guilds: if show { guilds.remove(&id).unwrap_or_default() } else { Vec::new() },
            mutual_friends_count: if show { u32::try_from(visible).unwrap_or(0) } else { 0 },
        });
    }
    Ok(Json(FriendSuggestionsResponse { enabled: true, suggestions }))
}

async fn dismiss(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    // 204 whether or not the id belongs to anybody: dismissing must not tell which accounts exist.
    let Some(other) = parse_id(&id) else { return Ok(StatusCode::NO_CONTENT) };
    sqlx::query("INSERT INTO friend_suggestion_dismissals (user_id, other_id) SELECT $1, id FROM users WHERE id = $2 ON CONFLICT DO NOTHING")
        .bind(user_id)
        .bind(other)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_settings(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<FriendSuggestionSettings>,
) -> ApiResult<Json<FriendSuggestionSettings>> {
    sqlx::query("UPDATE users SET friend_suggestions = $2 WHERE id = $1").bind(user_id).bind(body.enabled).execute(&state.db).await?;
    Ok(Json(FriendSuggestionSettings { enabled: body.enabled }))
}
