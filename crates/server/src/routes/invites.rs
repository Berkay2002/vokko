use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use vokko_protocol::api::{GatewayEvent, Guild, GuildMemberAdd, Invite, Snowflake};

use crate::access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::routes::channels::invite_view;
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new().route("/invites/{code}", get(preview).post(accept))
}

/// An invite that is unknown, expired or used up does not exist.
async fn live_invite(state: &AppState, code: &str) -> ApiResult<(i64, i64)> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT guild_id, channel_id FROM invites WHERE code = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses = 0 OR uses < max_uses)",
    )
    .bind(code)
    .fetch_optional(&state.db)
    .await?;
    row.ok_or_else(ApiErr::unknown_invite)
}

async fn preview(State(state): State<AppState>, AuthUser(_): AuthUser, Path(code): Path<String>) -> ApiResult<Json<Invite>> {
    live_invite(&state, &code).await?;
    invite_view(&state, &code).await?.map(Json).ok_or_else(ApiErr::unknown_invite)
}

async fn accept(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(code): Path<String>) -> ApiResult<Json<Guild>> {
    let (guild_id, _) = live_invite(&state, &code).await?;
    // The member insert and the use are one transaction; the conditional UPDATE re-checks max_uses / expiry under the row lock,
    // so concurrent accepts of the last use cannot both succeed. An existing member does not consume a use.
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(guild_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    if inserted.rows_affected() > 0 {
        let consumed = sqlx::query(
            "UPDATE invites SET uses = uses + 1 WHERE code = $1 AND (max_uses = 0 OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(&code)
        .execute(&mut *tx)
        .await?;
        if consumed.rows_affected() == 0 {
            tx.rollback().await?;
            return Err(ApiErr::unknown_invite());
        }
    }
    tx.commit().await?;
    if inserted.rows_affected() > 0 {
        sqlx::query("INSERT INTO read_states (user_id, channel_id, last_message_id) SELECT $1, id, last_message_id FROM channels WHERE guild_id = $2 AND kind IN (0, 2) ON CONFLICT DO NOTHING")
            .bind(user_id)
            .bind(guild_id)
            .execute(&state.db)
            .await?;
        let full = events::guild_with_state(&state, guild_id, user_id).await?;
        state.hub.send(&[user_id], &GatewayEvent::GuildCreate(Box::new(full)));
        if let Some(member) = store::member(&state, guild_id, user_id).await? {
            let others: Vec<i64> = access::guild_member_ids(&state, guild_id).await?.into_iter().filter(|id| *id != user_id).collect();
            state.hub.send(&others, &GatewayEvent::GuildMemberAdd(GuildMemberAdd { member, guild_id: Snowflake::from(guild_id) }));
        }
    }
    store::guild(&state, guild_id).await?.map(Json).ok_or_else(ApiErr::unknown_guild)
}
