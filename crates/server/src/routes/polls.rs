use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use serde::Deserialize;
use vokko_protocol::api::permissions::{READ_MESSAGE_HISTORY, VIEW_CHANNEL};
use vokko_protocol::api::{GatewayEvent, Message, PollAnswerVotersResponse, PollVote, Snowflake};

use crate::access::{self, ChannelAccess, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiQuery, parse_id};
use crate::polls;
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/polls/{mid}/answers/{answer}/@me", put(add_vote).delete(remove_vote))
        .route("/channels/{id}/polls/{mid}/answers/{answer}", get(list_voters))
        .route("/channels/{id}/polls/{mid}/expire", post(expire))
}

/// The channel and the message's author, after checking the message exists there; `None` author = the message has no poll.
async fn locate(state: &AppState, user_id: i64, channel: &str, message: &str) -> ApiResult<(ChannelAccess, i64, Option<i64>)> {
    let channel_id = parse_id(channel).ok_or_else(ApiErr::unknown_channel)?;
    let message_id = parse_id(message).ok_or_else(ApiErr::unknown_message)?;
    let access = channel_access(state, user_id, channel_id).await?;
    let found: Option<(i64, bool)> =
        sqlx::query_as("SELECT m.author_id, EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id) FROM messages m WHERE m.id = $1 AND m.channel_id = $2")
            .bind(message_id)
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await?;
    let (author, has_poll) = found.ok_or_else(ApiErr::unknown_message)?;
    Ok((access, message_id, has_poll.then_some(author)))
}

fn answer_id(raw: &str) -> ApiResult<i32> {
    raw.parse::<i32>().ok().filter(|id| *id > 0).ok_or_else(|| ApiErr::invalid("answer_id", "Unknown answer."))
}

fn vote_event(access: &ChannelAccess, user_id: i64, message_id: i64, answer_id: i32) -> PollVote {
    PollVote {
        user_id: Snowflake::from(user_id),
        channel_id: Snowflake::from(access.channel.id),
        message_id: Snowflake::from(message_id),
        guild_id: access.channel.guild_id.map(Snowflake::from),
        answer_id: answer_id.max(0) as u32,
    }
}

/// Checks the voter may vote at all; returns the message id and answer id.
async fn vote_target(state: &AppState, user_id: i64, id: &str, mid: &str, answer: &str) -> ApiResult<(ChannelAccess, i64, i32)> {
    let answer = answer_id(answer)?;
    let (access, message_id, poll_author) = locate(state, user_id, id, mid).await?;
    access.require(VIEW_CHANNEL | READ_MESSAGE_HISTORY)?;
    access.require_unarchived()?;
    if poll_author.is_none() {
        return Err(ApiErr::unknown_message());
    }
    Ok((access, message_id, answer))
}

/// Inside a vote transaction: holds the poll row (FOR SHARE, so finalising waits for us) and refuses ended polls. Returns allow_multiselect.
async fn open_poll(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, message_id: i64, user_id: i64, answer: i32) -> ApiResult<bool> {
    let poll: Option<(bool, bool)> = sqlx::query_as("SELECT allow_multiselect, finalized OR expiry <= now() FROM polls WHERE message_id = $1 FOR SHARE")
        .bind(message_id)
        .fetch_optional(&mut **tx)
        .await?;
    let (multiselect, ended) = poll.ok_or_else(ApiErr::unknown_message)?;
    if ended {
        return Err(polls::expired());
    }
    let exists: Option<(i32,)> = sqlx::query_as("SELECT answer_id FROM poll_answers WHERE message_id = $1 AND answer_id = $2")
        .bind(message_id)
        .bind(answer)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_none() {
        return Err(ApiErr::invalid("answer_id", "Unknown answer."));
    }
    // One voter at a time per poll: a single-choice vote move must not interleave with another vote by the same user.
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind((message_id ^ (message_id >> 32)) as i32)
        .bind((user_id ^ (user_id >> 32)) as i32)
        .execute(&mut **tx)
        .await?;
    Ok(multiselect)
}

async fn add_vote(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, answer)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let (access, message_id, answer) = vote_target(&state, user_id, &id, &mid, &answer).await?;
    // A vote reaches the other side of a 1:1 DM like a reaction (removing one stays open).
    if access.channel.channel_type() == vokko_protocol::api::ChannelType::Dm {
        crate::routes::messages::require_dm_open(&state, access.channel.id, user_id).await?;
    }
    let mut tx = state.db.begin().await?;
    let multiselect = open_poll(&mut tx, message_id, user_id, answer).await?;
    // Single choice: voting for another answer moves the vote.
    let moved: Vec<(i32,)> = if multiselect {
        Vec::new()
    } else {
        sqlx::query_as("DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2 AND answer_id <> $3 RETURNING answer_id")
            .bind(message_id)
            .bind(user_id)
            .bind(answer)
            .fetch_all(&mut *tx)
            .await?
    };
    let inserted = sqlx::query("INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(message_id)
        .bind(answer)
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    tx.commit().await?;
    if !moved.is_empty() || inserted {
        let viewers = access::channel_viewers(&state, &access.channel).await?;
        for (old,) in moved {
            state.hub.send(&viewers, &GatewayEvent::MessagePollVoteRemove(vote_event(&access, user_id, message_id, old)));
        }
        if inserted {
            state.hub.send(&viewers, &GatewayEvent::MessagePollVoteAdd(vote_event(&access, user_id, message_id, answer)));
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_vote(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, answer)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let (access, message_id, answer) = vote_target(&state, user_id, &id, &mid, &answer).await?;
    let mut tx = state.db.begin().await?;
    open_poll(&mut tx, message_id, user_id, answer).await?;
    let removed = sqlx::query("DELETE FROM poll_votes WHERE message_id = $1 AND answer_id = $2 AND user_id = $3")
        .bind(message_id)
        .bind(answer)
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    tx.commit().await?;
    if removed {
        let viewers = access::channel_viewers(&state, &access.channel).await?;
        state.hub.send(&viewers, &GatewayEvent::MessagePollVoteRemove(vote_event(&access, user_id, message_id, answer)));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct VotersQuery {
    after: Option<Snowflake>,
    limit: Option<i64>,
}

async fn list_voters(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, answer)): Path<(String, String, String)>,
    ApiQuery(query): ApiQuery<VotersQuery>,
) -> ApiResult<Json<PollAnswerVotersResponse>> {
    let answer = answer_id(&answer)?;
    let (access, message_id, poll_author) = locate(&state, user_id, &id, &mid).await?;
    access.require(READ_MESSAGE_HISTORY)?;
    if poll_author.is_none() {
        return Err(ApiErr::unknown_message());
    }
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let exists: Option<(i32,)> = sqlx::query_as("SELECT answer_id FROM poll_answers WHERE message_id = $1 AND answer_id = $2")
        .bind(message_id)
        .bind(answer)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiErr::invalid("answer_id", "Unknown answer."));
    }
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT user_id FROM poll_votes WHERE message_id = $1 AND answer_id = $2 AND user_id > $3 ORDER BY user_id LIMIT $4")
            .bind(message_id)
            .bind(answer)
            .bind(query.after.map(Snowflake::db).unwrap_or(0))
            .bind(limit)
            .fetch_all(&state.db)
            .await?;
    let ids: Vec<i64> = rows.into_iter().map(|(id,)| id).collect();
    let mut users = store::users(&state, &ids).await?;
    Ok(Json(PollAnswerVotersResponse { users: ids.iter().filter_map(|id| users.remove(id)).collect() }))
}

/// End Poll Now: the poll's author only.
async fn expire(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, mid)): Path<(String, String)>) -> ApiResult<Json<Message>> {
    let (_access, message_id, poll_author) = locate(&state, user_id, &id, &mid).await?;
    let author = poll_author.ok_or_else(polls::not_a_poll)?;
    if author != user_id {
        return Err(ApiErr::not_author());
    }
    if !polls::finalize(&state, message_id, true).await? {
        return Err(polls::expired());
    }
    if let Err(error) = polls::announce(&state, message_id).await {
        tracing::warn!("poll {message_id}: result message failed: {error:?}");
    }
    store::message_view(&state, message_id, Some(user_id)).await?.map(|view| Json(view.message)).ok_or_else(ApiErr::unknown_message)
}
