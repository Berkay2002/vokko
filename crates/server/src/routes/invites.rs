use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use vokko_protocol::api::{GatewayEvent, Guild, GuildMemberAdd, Invite, MessageType, Snowflake};

use crate::access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::presence;
use crate::routes::channels::invite_view;
use crate::routes::messages::{Draft, Resolved, insert_message};
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
    let banned: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).fetch_optional(&state.db).await?;
    if banned.is_some() {
        return Err(ApiErr::banned());
    }
    // The member insert and the use are one transaction; the conditional UPDATE re-checks max_uses / expiry under the row lock,
    // so concurrent accepts of the last use cannot both succeed. An existing member does not consume a use.
    let mut tx = state.db.begin().await?;
    // The shared guild row lock orders this against a ban (which takes it exclusively before writing the ban row and removing
    // the member): the ban is either visible to the conditional insert below or removes the member inserted here.
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR SHARE").bind(guild_id).execute(&mut *tx).await?;
    let inserted = sqlx::query(
        "INSERT INTO guild_members (guild_id, user_id) SELECT $1, $2 \
         WHERE NOT EXISTS (SELECT 1 FROM guild_bans WHERE guild_id = $1 AND user_id = $2) ON CONFLICT DO NOTHING",
    )
    .bind(guild_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        // Nothing inserted: already a member, or banned since the check above.
        let banned: Option<(i64,)> =
            sqlx::query_as("SELECT user_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).fetch_optional(&mut *tx).await?;
        if banned.is_some() {
            return Err(ApiErr::banned());
        }
    }
    if inserted.rows_affected() > 0 {
        // A timeout still running from before they left or were kicked comes back with them.
        sqlx::query(
            "UPDATE guild_members m SET timeout_until = t.until FROM guild_timeouts t \
             WHERE m.guild_id = $1 AND m.user_id = $2 AND t.guild_id = $1 AND t.user_id = $2 AND t.until > now()",
        )
        .bind(guild_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM guild_timeouts WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).execute(&mut *tx).await?;
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
        sqlx::query("INSERT INTO read_states (user_id, channel_id, last_message_id) SELECT $1, id, last_message_id FROM channels WHERE guild_id = $2 AND kind IN (0, 2, 5) ON CONFLICT DO NOTHING")
            .bind(user_id)
            .bind(guild_id)
            .execute(&state.db)
            .await?;
        let mut full = events::guild_with_state(&state, guild_id, user_id).await?;
        full.presences = Some(presence::guild_presences(&state, guild_id, user_id).await?);
        state.hub.send(&[user_id], &GatewayEvent::GuildCreate(Box::new(full)));
        if let Some(member) = store::member(&state, guild_id, user_id).await? {
            let others: Vec<i64> = access::guild_member_ids(&state, guild_id).await?.into_iter().filter(|id| *id != user_id).collect();
            state.hub.send(&others, &GatewayEvent::GuildMemberAdd(GuildMemberAdd { member, guild_id: Snowflake::from(guild_id) }));
        }
        presence::announce_join(&state, guild_id, user_id).await?;
        if let Err(error) = post_join_message(&state, guild_id, user_id).await {
            tracing::warn!("join message failed: {error:?}");
        }
    }
    store::guild(&state, guild_id).await?.map(Json).ok_or_else(ApiErr::unknown_guild)
}

/// A UserJoin (type 7) system message from the joiner in the guild's system channel, when one is set.
async fn post_join_message(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    let channel: Option<(Option<i64>,)> = sqlx::query_as("SELECT system_channel_id FROM guilds WHERE id = $1").bind(guild_id).fetch_optional(&state.db).await?;
    let Some((Some(channel_id),)) = channel else { return Ok(()) };
    let Some(channel) = store::channel_row(state, channel_id).await? else { return Ok(()) };
    if channel.guild_id != Some(guild_id) {
        return Ok(());
    }
    let draft = Draft {
        content: String::new(),
        kind: MessageType::UserJoin,
        reference: None,
        attachments: Vec::new(),
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    };
    insert_message(state, &channel, user_id, draft).await?;
    Ok(())
}
