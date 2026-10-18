//! Friend requests and DM / group DM channels of the current user.
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use vokko_protocol::api::{
    Channel, CreateDmRequest, CreateRelationshipRequest, GatewayEvent, IdOnly, PutRelationshipRequest, Relationship, RelationshipType, Snowflake, user_settings,
};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, parse_id};
use crate::routes::guild_privacy::may_dm;
use crate::state::AppState;
use crate::store::{self, CHANNEL_COLS, ChannelRow};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/channels", get(list_dms).post(create_dm))
        .route("/users/@me/relationships", get(list_relationships).post(request_by_username))
        .route("/users/@me/relationships/{id}", put(add_relationship).delete(remove_relationship))
}

pub async fn relationships_of(state: &AppState, user_id: i64) -> ApiResult<Vec<Relationship>> {
    let rows: Vec<(i64, i16)> =
        sqlx::query_as("SELECT other_id, kind FROM relationships WHERE user_id = $1 ORDER BY created_at, other_id").bind(user_id).fetch_all(&state.db).await?;
    let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
    let users = store::users(state, &ids).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, kind)| {
            let user = users.get(&id)?.clone();
            Some(Relationship { id: Snowflake::from(id), kind: RelationshipType::from_u8(kind as u8)?, user })
        })
        .collect())
}

pub async fn open_dms(state: &AppState, user_id: i64) -> ApiResult<Vec<Channel>> {
    let rows: Vec<ChannelRow> = sqlx::query_as(&format!(
        "SELECT {} FROM channels c JOIN channel_recipients r ON r.channel_id = c.id WHERE r.user_id = $1 AND NOT r.closed ORDER BY c.last_message_id DESC NULLS LAST, c.id DESC",
        CHANNEL_COLS.split(", ").map(|column| format!("c.{column}")).collect::<Vec<_>>().join(", ")
    ))
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    store::channels_to_api(state, rows, Some(user_id)).await
}

async fn list_dms(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<Channel>>> {
    Ok(Json(open_dms(&state, user_id).await?))
}

async fn create_dm(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<CreateDmRequest>) -> ApiResult<Json<Channel>> {
    let (bot,): (bool,) = sqlx::query_as("SELECT bot FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if bot {
        // Bots open one-to-one DMs with people they share a guild with, nothing else.
        let recipient = body.recipient_id.ok_or_else(ApiErr::bots_forbidden)?.db();
        let (shared,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id WHERE a.user_id = $1 AND b.user_id = $2)",
        )
        .bind(user_id)
        .bind(recipient)
        .fetch_one(&state.db)
        .await?;
        if !shared {
            return Err(ApiErr::cannot_message_user());
        }
        return one_to_one(&state, user_id, recipient).await;
    }
    if let Some(recipient) = body.recipient_id {
        return one_to_one(&state, user_id, recipient.db()).await;
    }
    let Some(ids) = body.recipient_ids else { return Err(ApiErr::invalid("recipient_id", "Provide recipient_id or recipient_ids.")) };
    let mut ids: Vec<i64> = ids.into_iter().map(Snowflake::db).filter(|id| *id != user_id).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() == 1 {
        return one_to_one(&state, user_id, ids[0]).await;
    }
    let most = usize::try_from(state.config.group_dm_max - 1).unwrap_or(0);
    if !(2..=most).contains(&ids.len()) {
        return Err(ApiErr::invalid("recipient_ids", &format!("A group DM needs between 2 and {most} other people.")));
    }
    let known = store::users(&state, &ids).await?;
    if known.len() != ids.len() {
        return Err(ApiErr::unknown_user());
    }
    // Only accepted friends of the creator can be added to a new group DM.
    let (friends,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM relationships WHERE user_id = $1 AND other_id = ANY($2) AND kind = 1")
        .bind(user_id)
        .bind(&ids)
        .fetch_one(&state.db)
        .await?;
    if friends != ids.len() as i64 {
        return Err(ApiErr::cannot_message_user());
    }
    let channel_id = state.ids.next();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO channels (id, kind, owner_id) VALUES ($1, 3, $2)").bind(channel_id).bind(user_id).execute(&mut *tx).await?;
    let mut everyone = ids.clone();
    everyone.push(user_id);
    for member in &everyone {
        sqlx::query("INSERT INTO channel_recipients (channel_id, user_id) VALUES ($1, $2)").bind(channel_id).bind(member).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO read_states (user_id, channel_id) VALUES ($1, $2)").bind(member).bind(channel_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let row = store::channel_row(&state, channel_id).await?.ok_or_else(ApiErr::internal)?;
    events::dispatch_channel(&state, &row, GatewayEvent::ChannelCreate).await?;
    store::channel(&state, channel_id, Some(user_id)).await?.map(Json).ok_or_else(ApiErr::internal)
}

async fn one_to_one(state: &AppState, user_id: i64, other: i64) -> ApiResult<Json<Channel>> {
    if other == user_id {
        return Err(ApiErr::invalid("recipient_id", "You cannot open a DM with yourself."));
    }
    if store::user(state, other).await?.is_none() {
        return Err(ApiErr::unknown_user());
    }
    let (blocked,): (bool,) =
        sqlx::query_as("SELECT EXISTS (SELECT 1 FROM relationships WHERE kind = 2 AND ((user_id = $1 AND other_id = $2) OR (user_id = $2 AND other_id = $1)))")
            .bind(user_id)
            .bind(other)
            .fetch_one(&state.db)
            .await?;
    if blocked {
        return Err(ApiErr::cannot_message_user());
    }
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT c.id FROM channels c WHERE c.kind = 1 \
         AND EXISTS (SELECT 1 FROM channel_recipients r WHERE r.channel_id = c.id AND r.user_id = $1) \
         AND EXISTS (SELECT 1 FROM channel_recipients r WHERE r.channel_id = c.id AND r.user_id = $2) LIMIT 1",
    )
    .bind(user_id)
    .bind(other)
    .fetch_optional(&state.db)
    .await?;
    let channel_id = match existing {
        Some((id,)) => {
            let reopened = sqlx::query("UPDATE channel_recipients SET closed = FALSE WHERE channel_id = $1 AND user_id = $2 AND closed")
                .bind(id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
            if reopened.rows_affected() > 0
                && let Some(channel) = store::channel(state, id, Some(user_id)).await?
            {
                state.hub.send(&[user_id], &GatewayEvent::ChannelCreate(channel));
            }
            id
        }
        None => {
            // A new DM needs an accepted friendship or a shared guild the other side lets DM them (guild_privacy::may_dm).
            if !may_dm(state, user_id, other).await? {
                return Err(ApiErr::cannot_message_user());
            }
            let id = state.ids.next();
            let mut tx = state.db.begin().await?;
            sqlx::query("INSERT INTO channels (id, kind) VALUES ($1, 1)").bind(id).execute(&mut *tx).await?;
            // The other side only sees the DM once the first message arrives.
            sqlx::query("INSERT INTO channel_recipients (channel_id, user_id, closed) VALUES ($1, $2, FALSE), ($1, $3, TRUE)")
                .bind(id)
                .bind(user_id)
                .bind(other)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO read_states (user_id, channel_id) VALUES ($1, $3), ($2, $3)").bind(user_id).bind(other).bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            if let Some(channel) = store::channel(state, id, Some(user_id)).await? {
                state.hub.send(&[user_id], &GatewayEvent::ChannelCreate(channel));
            }
            id
        }
    };
    store::channel(state, channel_id, Some(user_id)).await?.map(Json).ok_or_else(ApiErr::internal)
}

/// Whether `target`'s friend request sources (Data & Privacy) let `sender` send them a request.
async fn accepts_friend_request(state: &AppState, target: i64, sender: i64) -> ApiResult<bool> {
    let settings = crate::routes::settings::load(state, target).await?.settings;
    let allowed = |key: &str| user_settings::flag(&settings, key, true);
    if allowed("friend_requests_everyone") {
        return Ok(true);
    }
    if allowed("friend_requests_mutual_friends") {
        let (mutual,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM relationships a JOIN relationships b ON a.other_id = b.other_id \
             WHERE a.user_id = $1 AND a.kind = 1 AND b.user_id = $2 AND b.kind = 1)",
        )
        .bind(target)
        .bind(sender)
        .fetch_one(&state.db)
        .await?;
        if mutual {
            return Ok(true);
        }
    }
    if allowed("friend_requests_mutual_guilds") {
        let (shared,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = $1 AND b.user_id = $2)",
        )
        .bind(target)
        .bind(sender)
        .fetch_one(&state.db)
        .await?;
        if shared {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn list_relationships(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<Relationship>>> {
    Ok(Json(relationships_of(&state, user_id).await?))
}

async fn send_view(state: &AppState, viewer: i64, other: i64, kind: RelationshipType) -> ApiResult<()> {
    if let Some(user) = store::user(state, other).await? {
        state.hub.send(&[viewer], &GatewayEvent::RelationshipAdd(Relationship { id: Snowflake::from(other), kind, user }));
    }
    Ok(())
}

async fn befriend(state: &AppState, user_id: i64, other: i64) -> ApiResult<()> {
    if other == user_id {
        return Err(ApiErr::invalid("user_id", "You cannot befriend yourself."));
    }
    if store::user(state, other).await?.is_none() {
        return Err(ApiErr::unknown_user());
    }
    let current: Option<(i16,)> =
        sqlx::query_as("SELECT kind FROM relationships WHERE user_id = $1 AND other_id = $2").bind(user_id).bind(other).fetch_optional(&state.db).await?;
    match current.map(|(kind,)| kind as u8) {
        None => {
            let reverse: Option<(i16,)> = sqlx::query_as("SELECT kind FROM relationships WHERE user_id = $1 AND other_id = $2")
                .bind(other)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;
            if reverse.is_some_and(|(kind,)| kind == RelationshipType::Blocked.as_u8() as i16) {
                return Err(ApiErr::missing_access());
            }
            if !accepts_friend_request(state, other, user_id).await? {
                return Err(ApiErr::friend_requests_disabled());
            }
            sqlx::query("INSERT INTO relationships (user_id, other_id, kind) VALUES ($1, $2, 4), ($2, $1, 3) ON CONFLICT DO NOTHING")
                .bind(user_id)
                .bind(other)
                .execute(&state.db)
                .await?;
            send_view(state, user_id, other, RelationshipType::OutgoingRequest).await?;
            send_view(state, other, user_id, RelationshipType::IncomingRequest).await?;
        }
        Some(kind) if kind == RelationshipType::IncomingRequest.as_u8() => {
            sqlx::query("UPDATE relationships SET kind = 1 WHERE (user_id = $1 AND other_id = $2) OR (user_id = $2 AND other_id = $1)")
                .bind(user_id)
                .bind(other)
                .execute(&state.db)
                .await?;
            send_view(state, user_id, other, RelationshipType::Friend).await?;
            send_view(state, other, user_id, RelationshipType::Friend).await?;
        }
        Some(kind) if kind == RelationshipType::Blocked.as_u8() => return Err(ApiErr::missing_access()),
        Some(_) => {}
    }
    Ok(())
}

async fn block(state: &AppState, user_id: i64, other: i64) -> ApiResult<()> {
    if other == user_id {
        return Err(ApiErr::invalid("user_id", "You cannot block yourself."));
    }
    if store::user(state, other).await?.is_none() {
        return Err(ApiErr::unknown_user());
    }
    let mut tx = state.db.begin().await?;
    let mine: Option<(i16,)> = sqlx::query_as("SELECT kind FROM relationships WHERE user_id = $1 AND other_id = $2 FOR UPDATE")
        .bind(user_id)
        .bind(other)
        .fetch_optional(&mut *tx)
        .await?;
    if mine.is_some_and(|(kind,)| kind == RelationshipType::Blocked.as_u8() as i16) {
        return Ok(());
    }
    // Their half of a friendship / request goes away; their own block of me (if any) stays.
    let theirs =
        sqlx::query("DELETE FROM relationships WHERE user_id = $2 AND other_id = $1 AND kind <> 2").bind(user_id).bind(other).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO relationships (user_id, other_id, kind) VALUES ($1, $2, 2) \
         ON CONFLICT (user_id, other_id) DO UPDATE SET kind = 2, created_at = now()",
    )
    .bind(user_id)
    .bind(other)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    send_view(state, user_id, other, RelationshipType::Blocked).await?;
    if theirs.rows_affected() > 0 {
        state.hub.send(&[other], &GatewayEvent::RelationshipRemove(IdOnly { id: Snowflake::from(user_id) }));
    }
    if mine.is_some_and(|(kind,)| kind == RelationshipType::Friend.as_u8() as i16) {
        crate::presence::hide_where_hidden(state, user_id, other).await?;
    }
    Ok(())
}

async fn add_relationship(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>, body: Bytes) -> ApiResult<StatusCode> {
    let other = parse_id(&id).ok_or_else(ApiErr::unknown_user)?;
    // The body is optional: none, `{}` and `{"type": 1}` mean friend request / accept, `{"type": 2}` blocks.
    let request: PutRelationshipRequest = if body.iter().all(u8::is_ascii_whitespace) {
        PutRelationshipRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|_| ApiErr::invalid("body", "Expected a JSON object like {\"type\": 2}."))?
    };
    match request.kind {
        None => befriend(&state, user_id, other).await?,
        Some(kind) if kind == RelationshipType::Friend.as_u8() => befriend(&state, user_id, other).await?,
        Some(kind) if kind == RelationshipType::Blocked.as_u8() => block(&state, user_id, other).await?,
        Some(_) => return Err(ApiErr::invalid("type", "Must be 1 (friend) or 2 (blocked).")),
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn request_by_username(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<CreateRelationshipRequest>,
) -> ApiResult<StatusCode> {
    let username = body.username.trim().trim_start_matches('@').to_lowercase();
    let row: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE username = $1").bind(&username).fetch_optional(&state.db).await?;
    let (other,) = row.ok_or_else(ApiErr::unknown_user)?;
    befriend(&state, user_id, other).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove friend / cancel / decline / unblock. Only the caller's own row goes, plus the counterpart row of a
/// friendship or request; the other person's block of the caller is never touched.
async fn remove_relationship(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let other = parse_id(&id).ok_or_else(ApiErr::unknown_user)?;
    let mine: Option<(i16,)> = sqlx::query_as("DELETE FROM relationships WHERE user_id = $1 AND other_id = $2 RETURNING kind")
        .bind(user_id)
        .bind(other)
        .fetch_optional(&state.db)
        .await?;
    let was_block = mine.is_some_and(|(kind,)| kind == RelationshipType::Blocked.as_u8() as i16);
    let theirs = if was_block {
        0
    } else {
        sqlx::query("DELETE FROM relationships WHERE user_id = $2 AND other_id = $1 AND kind <> 2")
            .bind(user_id)
            .bind(other)
            .execute(&state.db)
            .await?
            .rows_affected()
    };
    if mine.is_some() {
        state.hub.send(&[user_id], &GatewayEvent::RelationshipRemove(IdOnly { id: Snowflake::from(other) }));
    }
    if theirs > 0 {
        state.hub.send(&[other], &GatewayEvent::RelationshipRemove(IdOnly { id: Snowflake::from(user_id) }));
    }
    // only an ended friendship changes what the two share (anything else would tell a stranger about the setting)
    if mine.is_some_and(|(kind,)| kind == RelationshipType::Friend.as_u8() as i16) {
        crate::presence::hide_where_hidden(&state, user_id, other).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
