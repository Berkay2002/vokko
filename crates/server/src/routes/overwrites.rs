//! Channel permission overwrites: PUT/DELETE per target, category sync, and the shared validation used on channel creation.
use std::collections::{HashMap, HashSet};

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::put;
use sqlx::{Postgres, Transaction};
use vokko_protocol::api::permissions::{ADMINISTRATOR, ALL, MANAGE_ROLES};
use vokko_protocol::api::{ChannelType, GatewayEvent, OverwriteRequest, OverwriteType};

use crate::access::{self, ChannelAccess, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/permissions/{oid}", put(put_overwrite).delete(delete_overwrite))
}

/// A validated overwrite ready to be stored.
#[derive(Clone, Copy, Debug)]
pub struct OverwriteWrite {
    pub target_id: i64,
    pub target_type: i16,
    pub allow: i64,
    pub deny: i64,
}

fn parse_bits(raw: &str, field: &str) -> ApiResult<u64> {
    raw.trim().parse::<u64>().map_err(|_| ApiErr::invalid(field, "Must be a permission bitfield as a decimal string."))
}

/// The permission bits (allow and deny) that differ between two `(allow, deny)` pairs.
fn flipped(old: (i64, i64), new: (i64, i64)) -> u64 {
    ((old.0 ^ new.0) | (old.1 ^ new.1)) as u64
}

/// 403 unless the actor holds every bit `flipped` names (`actor_permissions` = their permissions in the channel).
fn require_bits(actor_permissions: u64, flipped: u64) -> ApiResult<()> {
    if flipped & !actor_permissions != 0 { Err(ApiErr::missing_permissions()) } else { Ok(()) }
}

/// Validates one new overwrite: well-formed bits, ADMINISTRATOR and unknown bits stripped, nothing the actor lacks
/// (`actor_permissions` = their permissions in the guild, since the channel does not exist yet), and the target
/// is a role of the guild (`@everyone` included) or a member of it.
pub async fn validate(
    state: &AppState,
    guild_id: i64,
    actor_permissions: u64,
    target_id: i64,
    kind: OverwriteType,
    allow: &str,
    deny: &str,
) -> ApiResult<OverwriteWrite> {
    let write = parse_write(target_id, kind, allow, deny)?;
    require_bits(actor_permissions, flipped((0, 0), (write.allow, write.deny)))?;
    ensure_target(state, guild_id, target_id, kind).await?;
    Ok(write)
}

/// Well-formed bits with ADMINISTRATOR and unknown bits stripped. Whether the actor may set them is checked against what is stored.
fn parse_write(target_id: i64, kind: OverwriteType, allow: &str, deny: &str) -> ApiResult<OverwriteWrite> {
    let allow = parse_bits(allow, "allow")? & ALL & !ADMINISTRATOR;
    let deny = parse_bits(deny, "deny")? & ALL & !ADMINISTRATOR;
    Ok(OverwriteWrite { target_id, target_type: kind.as_u8() as i16, allow: allow as i64, deny: deny as i64 })
}

async fn ensure_target(state: &AppState, guild_id: i64, target_id: i64, kind: OverwriteType) -> ApiResult<()> {
    let exists: Option<(i64,)> = match kind {
        OverwriteType::Role => sqlx::query_as("SELECT id FROM roles WHERE id = $1 AND guild_id = $2"),
        OverwriteType::Member => sqlx::query_as("SELECT user_id FROM guild_members WHERE user_id = $1 AND guild_id = $2"),
    }
    .bind(target_id)
    .bind(guild_id)
    .fetch_optional(&state.db)
    .await?;
    if exists.is_none() {
        return Err(match kind {
            OverwriteType::Role => ApiErr::unknown_role(),
            OverwriteType::Member => ApiErr::unknown_member(),
        });
    }
    Ok(())
}

pub async fn store_overwrite(tx: &mut Transaction<'_, Postgres>, channel_id: i64, write: &OverwriteWrite) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (channel_id, target_id) DO UPDATE SET target_type = $3, allow = $4, deny = $5",
    )
    .bind(channel_id)
    .bind(write.target_id)
    .bind(write.target_type)
    .bind(write.allow)
    .bind(write.deny)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

type Rows = Vec<(i64, i16, i64, i64)>;

async fn overwrite_rows(tx: &mut Transaction<'_, Postgres>, channel_id: i64) -> ApiResult<Rows> {
    Ok(sqlx::query_as("SELECT target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = $1 ORDER BY target_id, target_type")
        .bind(channel_id)
        .fetch_all(&mut **tx)
        .await?)
}

/// Replaces `channel_id`'s overwrites with `parent_id`'s.
pub async fn copy_overwrites(tx: &mut Transaction<'_, Postgres>, parent_id: i64, channel_id: i64) -> ApiResult<()> {
    sqlx::query("DELETE FROM permission_overwrites WHERE channel_id = $1").bind(channel_id).execute(&mut **tx).await?;
    sqlx::query(
        "INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) \
         SELECT $2, target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = $1",
    )
    .bind(parent_id)
    .bind(channel_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// `lock_permissions` on a move: replaces the channel's overwrites with `parent_id`'s. When that changes anything the actor
/// needs MANAGE_ROLES in the channel and every bit that flips (allow and deny), exactly like editing those overwrites one by one.
pub async fn lock_to_parent(tx: &mut Transaction<'_, Postgres>, access: &ChannelAccess, parent_id: i64) -> ApiResult<()> {
    let channel_id = access.channel.id;
    // The channel first, then the parent: a concurrent edit of the category waits, so the compared rows are the ones copied.
    sqlx::query("SELECT id FROM channels WHERE id = $1 FOR UPDATE").bind(channel_id).execute(&mut **tx).await?;
    sqlx::query("SELECT id FROM channels WHERE id = $1 FOR SHARE").bind(parent_id).execute(&mut **tx).await?;
    let own = overwrite_rows(tx, channel_id).await?;
    let inherited = overwrite_rows(tx, parent_id).await?;
    if own != inherited {
        access.require(MANAGE_ROLES)?;
        let keyed =
            |rows: &Rows| -> HashMap<(i64, i16), (i64, i64)> { rows.iter().map(|(target, kind, allow, deny)| ((*target, *kind), (*allow, *deny))).collect() };
        let (own, inherited) = (keyed(&own), keyed(&inherited));
        let mut changed = 0;
        for key in own.keys().chain(inherited.keys()) {
            changed |= flipped(own.get(key).copied().unwrap_or((0, 0)), inherited.get(key).copied().unwrap_or((0, 0)));
        }
        require_bits(access.permissions, changed)?;
    }
    copy_overwrites(tx, parent_id, channel_id).await
}

/// CHANNEL_UPDATE to everyone who still sees the channel, CHANNEL_DELETE to those who lost VIEW_CHANNEL since
/// `before` (the viewers computed before the change) and CHANNEL_CREATE to those who gained it.
pub async fn dispatch_visibility(state: &AppState, row: &ChannelRow, before: &[i64]) -> ApiResult<()> {
    let after = access::channel_viewers(state, row).await?;
    let Some(channel) = store::channel(state, row.id, None).await? else { return Ok(()) };
    let before_set: HashSet<i64> = before.iter().copied().collect();
    let after_set: HashSet<i64> = after.iter().copied().collect();
    let lost: Vec<i64> = before.iter().copied().filter(|user| !after_set.contains(user)).collect();
    let gained: Vec<i64> = after.iter().copied().filter(|user| !before_set.contains(user)).collect();
    let kept: Vec<i64> = after.iter().copied().filter(|user| before_set.contains(user)).collect();
    state.hub.send(&lost, &GatewayEvent::ChannelDelete(channel.clone()));
    state.hub.send(&gained, &GatewayEvent::ChannelCreate(channel.clone()));
    state.hub.send(&kept, &GatewayEvent::ChannelUpdate(channel));
    Ok(())
}

enum Change {
    Put(OverwriteWrite),
    Delete(i64),
}

async fn apply(tx: &mut Transaction<'_, Postgres>, channel_id: i64, change: &Change) -> ApiResult<()> {
    match change {
        Change::Put(write) => store_overwrite(tx, channel_id, write).await,
        Change::Delete(target_id) => {
            sqlx::query("DELETE FROM permission_overwrites WHERE channel_id = $1 AND target_id = $2")
                .bind(channel_id)
                .bind(target_id)
                .execute(&mut **tx)
                .await?;
            Ok(())
        }
    }
}

/// Applies `change` to the channel and, for a category, to every child whose overwrites equalled the category's before it.
/// The actor must hold every bit the change flips in the channel (the stored overwrite, read under the channel lock, is the baseline);
/// children are synced without a second check, the change being the one validated on the category.
async fn change_overwrites(state: &AppState, channel: &ChannelRow, actor_permissions: u64, change: Change) -> ApiResult<()> {
    let mut changed = vec![channel.clone()];
    let mut before: Vec<Vec<i64>> = vec![access::channel_viewers(state, channel).await?];
    let mut tx = state.db.begin().await?;
    // Serialise concurrent edits of one channel so the baseline (and, for a category, the "equal before" comparison) stays meaningful.
    sqlx::query("SELECT id FROM channels WHERE id = $1 FOR UPDATE").bind(channel.id).execute(&mut *tx).await?;
    let (target_id, new) = match &change {
        Change::Put(write) => (write.target_id, (write.allow, write.deny)),
        Change::Delete(target_id) => (*target_id, (0, 0)),
    };
    let old: Option<(i64, i64)> = sqlx::query_as("SELECT allow, deny FROM permission_overwrites WHERE channel_id = $1 AND target_id = $2")
        .bind(channel.id)
        .bind(target_id)
        .fetch_optional(&mut *tx)
        .await?;
    require_bits(actor_permissions, flipped(old.unwrap_or((0, 0)), new))?;
    if channel.channel_type() == ChannelType::GuildCategory {
        let category = overwrite_rows(&mut tx, channel.id).await?;
        let children: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM channels WHERE parent_id = $1 ORDER BY position, id").bind(channel.id).fetch_all(&mut *tx).await?;
        for (child_id,) in children {
            if overwrite_rows(&mut tx, child_id).await? != category {
                continue;
            }
            apply(&mut tx, child_id, &change).await?;
            if let Some(row) = store::channel_row(state, child_id).await? {
                before.push(access::channel_viewers(state, &row).await?);
                changed.push(row);
            }
        }
    }
    apply(&mut tx, channel.id, &change).await?;
    tx.commit().await?;
    for (row, viewers) in changed.iter().zip(&before) {
        dispatch_visibility(state, row, viewers).await?;
    }
    Ok(())
}

/// The channel when the actor may manage its overwrites (MANAGE_ROLES there); DMs have none.
async fn manageable(state: &AppState, user_id: i64, raw_channel: &str) -> ApiResult<(ChannelAccess, i64)> {
    let id = parse_id(raw_channel).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(state, user_id, id).await?;
    let guild_id = match access.channel.guild_id {
        Some(guild_id) if !access.is_dm() => guild_id,
        _ => return Err(ApiErr::missing_permissions()),
    };
    access.require(MANAGE_ROLES)?;
    Ok((access, guild_id))
}

async fn put_overwrite(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, target)): Path<(String, String)>,
    ApiJson(body): ApiJson<OverwriteRequest>,
) -> ApiResult<StatusCode> {
    let (access, guild_id) = manageable(&state, user_id, &id).await?;
    let target_id = parse_id(&target).ok_or_else(|| match body.kind {
        OverwriteType::Role => ApiErr::unknown_role(),
        OverwriteType::Member => ApiErr::unknown_member(),
    })?;
    let write = parse_write(target_id, body.kind, &body.allow, &body.deny)?;
    ensure_target(&state, guild_id, target_id, body.kind).await?;
    change_overwrites(&state, &access.channel, access.permissions, Change::Put(write)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_overwrite(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, target)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let (access, _) = manageable(&state, user_id, &id).await?;
    // An id that cannot exist has nothing to delete; the call is idempotent.
    if let Some(target_id) = parse_id(&target) {
        change_overwrites(&state, &access.channel, access.permissions, Change::Delete(target_id)).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
