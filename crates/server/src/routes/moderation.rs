//! Guild moderation: kick, bans, member edits (nick / roles / timeout) and role management.
use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, put};
use sqlx::{Postgres, QueryBuilder, Transaction};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use vokko_protocol::api::permissions::{
    ADMINISTRATOR, ALL, BAN_MEMBERS, CHANGE_NICKNAME, KICK_MEMBERS, MANAGE_GUILD, MANAGE_NICKNAMES, MANAGE_ROLES, MODERATE_MEMBERS,
};
use vokko_protocol::api::{
    AuditEntryInfo, AuditLogChange, AuditLogEvent, Ban, BanRequest, EditMemberRequest, EditOwnMemberRequest, GatewayEvent, GuildMember, GuildMemberAdd,
    GuildMemberRemove, GuildRoleDelete, GuildRoleEvent, IdOnly, MessageDeleteBulk, PruneRequest, PruneResponse, Role, RolePositionUpdate, RoleRequest,
    Snowflake,
};

use crate::access::{self, GuildAccess, RoleRank, compare_roles, guild_access, highest_role};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::media;
use crate::routes::auth::clean_text;
use crate::routes::join_requests;
use crate::routes::users::{self, ImageKind};
use crate::state::AppState;
use crate::store;

/// Longest communication timeout, like Discord.
const MAX_TIMEOUT_DAYS: i64 = 28;
pub const MAX_ROLES: i64 = 250;
const MAX_BAN_DELETE_SECONDS: u32 = 604_800;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/members/@me", patch(edit_own_member))
        .route("/guilds/{id}/members/{uid}", patch(edit_member).delete(kick_member))
        .route("/guilds/{id}/bans", get(list_bans))
        .route("/guilds/{id}/bans/{uid}", put(ban_member).delete(unban_member))
        .route("/guilds/{id}/roles", axum::routing::post(create_role).patch(update_role_positions))
        .route("/guilds/{id}/roles/member-counts", get(role_member_counts))
        .route("/guilds/{id}/roles/{rid}", patch(update_role).delete(delete_role))
        .route("/guilds/{id}/prune", get(prune_count).post(prune))
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

fn user_id_of(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_member)
}

fn role_id_of(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_role)
}

#[derive(sqlx::FromRow, Clone)]
struct RoleRow {
    id: i64,
    name: String,
    color: i32,
    hoist: bool,
    position: i32,
    permissions: i64,
    mentionable: bool,
    unicode_emoji: Option<String>,
}

const ROLE_COLS: &str = "id, name, color, hoist, position, permissions, mentionable, unicode_emoji";

impl RoleRow {
    fn api(&self) -> Role {
        Role {
            id: Snowflake::from(self.id),
            name: self.name.clone(),
            color: self.color.max(0) as u32,
            hoist: self.hoist,
            position: self.position,
            permissions: (self.permissions as u64).to_string(),
            mentionable: self.mentionable,
            unicode_emoji: self.unicode_emoji.clone(),
        }
    }
}

/// The actor's membership, permissions and the guild's roles, loaded once per request.
struct Ctx {
    user_id: i64,
    guild_id: i64,
    access: GuildAccess,
    roles: Vec<RoleRow>,
}

impl Ctx {
    async fn load(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<Self> {
        let access = guild_access(state, user_id, guild_id).await?;
        let roles = load_roles(state, guild_id).await?;
        Ok(Self { user_id, guild_id, access, roles })
    }

    fn owner(&self) -> bool {
        self.access.owner_id == self.user_id
    }

    fn rank(&self, row: &RoleRow) -> RoleRank {
        RoleRank { id: row.id, position: row.position, everyone: row.id == self.guild_id }
    }

    fn ranks_of(&self, role_ids: &[i64]) -> Vec<RoleRank> {
        self.roles.iter().filter(|row| role_ids.contains(&row.id)).map(|row| self.rank(row)).collect()
    }

    fn role(&self, id: i64) -> Option<&RoleRow> {
        self.roles.iter().find(|row| row.id == id)
    }

    /// Whether the actor outranks `role` (the owner outranks every role).
    fn outranks(&self, role: &RoleRow) -> bool {
        if self.owner() {
            return true;
        }
        match highest_role(&self.ranks_of(&self.access.roles)) {
            Some(actor) => compare_roles(&actor, &self.rank(role)) == std::cmp::Ordering::Greater,
            None => false,
        }
    }

    /// Hierarchy check for acting on another member. Two members without any role are of equal rank, so nobody but the owner acts on them.
    fn can_act_on(&self, target_id: i64, target_roles: &[i64]) -> bool {
        let actor_ranks = self.ranks_of(&self.access.roles);
        let target_ranks = self.ranks_of(target_roles);
        if !self.owner() && actor_ranks.is_empty() && target_ranks.is_empty() {
            return false;
        }
        access::can_act_on(self.owner(), target_id == self.access.owner_id, &actor_ranks, &target_ranks)
    }

    /// Guild-wide permissions of a member, as the permission resolution computes them (owner and administrators get everything).
    fn permissions_of(&self, user_id: i64, role_ids: &[i64]) -> u64 {
        let map: HashMap<i64, u64> = self.roles.iter().map(|row| (row.id, row.permissions as u64)).collect();
        access::base_permissions(self.guild_id, self.access.owner_id, user_id, &map, role_ids)
    }
}

async fn load_roles(state: &AppState, guild_id: i64) -> ApiResult<Vec<RoleRow>> {
    Ok(sqlx::query_as(&format!("SELECT {ROLE_COLS} FROM roles WHERE guild_id = $1 ORDER BY position, id")).bind(guild_id).fetch_all(&state.db).await?)
}

async fn member_role_ids(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<Vec<i64>> {
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// 404 unless `user_id` is a member of the guild.
async fn require_member(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).fetch_optional(&state.db).await?;
    found.map(|_| ()).ok_or_else(ApiErr::unknown_member)
}

/// Removes a member the way leaving does (no owner check): row, read states, GUILD_DELETE to them, GUILD_MEMBER_REMOVE to the rest.
/// A running timeout is kept for when they rejoin.
pub async fn remove_member(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    let removed = delete_member(&mut tx, guild_id, user_id, true).await?;
    tx.commit().await?;
    if let Some(removed) = removed {
        announce_removal(state, guild_id, user_id, removed).await?;
    }
    Ok(())
}

/// A member row that went away; for a bot, the role made for it went too.
#[derive(Clone, Copy)]
pub struct Removed {
    pub bot_role: Option<i64>,
}

/// Deletes the member row inside `tx`; `None` if there was none. With `keep_timeout` a running timeout is stored for a rejoin
/// (a stored one that no longer applies is dropped), otherwise any stored timeout goes (a ban).
/// A bot (kicked, banned, removed from Integrations or leaving) takes its integration, its role and its guild commands along.
pub async fn delete_member(tx: &mut Transaction<'_, Postgres>, guild_id: i64, user_id: i64, keep_timeout: bool) -> ApiResult<Option<Removed>> {
    sqlx::query("DELETE FROM guild_timeouts WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).execute(&mut **tx).await?;
    if keep_timeout {
        sqlx::query(
            "INSERT INTO guild_timeouts (guild_id, user_id, until) \
             SELECT guild_id, user_id, timeout_until FROM guild_members WHERE guild_id = $1 AND user_id = $2 AND timeout_until > now()",
        )
        .bind(guild_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query("DELETE FROM thread_members WHERE user_id = $2 AND thread_id IN (SELECT id FROM channels WHERE guild_id = $1 AND kind IN (10, 11, 12))")
        .bind(guild_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    let deleted = sqlx::query("DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).execute(&mut **tx).await?;
    if deleted.rows_affected() == 0 {
        return Ok(None);
    }
    let integration: Option<(Option<i64>,)> = sqlx::query_as("DELETE FROM guild_integrations WHERE guild_id = $1 AND application_id = $2 RETURNING role_id")
        .bind(guild_id)
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some((role,)) = integration else { return Ok(Some(Removed { bot_role: None })) };
    sqlx::query("DELETE FROM application_commands WHERE application_id = $1 AND guild_id = $2").bind(user_id).bind(guild_id).execute(&mut **tx).await?;
    let mut bot_role = None;
    if let Some(role) = role.filter(|role| *role != guild_id) {
        let dropped = sqlx::query("DELETE FROM roles WHERE id = $1 AND guild_id = $2").bind(role).bind(guild_id).execute(&mut **tx).await?;
        bot_role = (dropped.rows_affected() > 0).then_some(role);
    }
    Ok(Some(Removed { bot_role }))
}

/// A bot's role (made when the bot was added): like Discord's `managed` roles, nobody assigns, removes, edits or deletes it.
pub async fn is_managed_role<'e>(db: impl sqlx::PgExecutor<'e>, guild_id: i64, role_id: i64) -> ApiResult<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT application_id FROM guild_integrations WHERE guild_id = $1 AND role_id = $2")
        .bind(guild_id)
        .bind(role_id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// What follows the member row going away: read states, GUILD_DELETE to them, GUILD_MEMBER_REMOVE (and a bot role's GUILD_ROLE_DELETE) to the rest.
pub async fn announce_removal(state: &AppState, guild_id: i64, user_id: i64, removed: Removed) -> ApiResult<()> {
    crate::voice::state::member_removed(state, guild_id, user_id).await;
    // The user no longer shows this guild's tag: forget the choice (so it does not reappear on a rejoin) and tell their audience.
    let dropped_tag: Option<(i64,)> = sqlx::query_as("UPDATE users SET primary_guild_id = NULL WHERE id = $1 AND primary_guild_id = $2 RETURNING id")
        .bind(user_id)
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await?;
    if dropped_tag.is_some() {
        crate::routes::users::publish_user(state, user_id).await?;
    }
    let user = store::user(state, user_id).await?.ok_or_else(ApiErr::unknown_user)?;
    sqlx::query("DELETE FROM read_states WHERE user_id = $1 AND channel_id IN (SELECT id FROM channels WHERE guild_id = $2)")
        .bind(user_id)
        .bind(guild_id)
        .execute(&state.db)
        .await?;
    state.hub.send(&[user_id], &GatewayEvent::GuildDelete(IdOnly { id: Snowflake::from(guild_id) }));
    let remaining = access::guild_member_ids(state, guild_id).await?;
    state.hub.send(&remaining, &GatewayEvent::GuildMemberRemove(GuildMemberRemove { guild_id: Snowflake::from(guild_id), user }));
    if let Some(role_id) = removed.bot_role {
        state.hub.send(&remaining, &GatewayEvent::GuildRoleDelete(GuildRoleDelete { guild_id: Snowflake::from(guild_id), role_id: Snowflake::from(role_id) }));
    }
    crate::presence::announce_leave(state, guild_id, user_id).await?;
    Ok(())
}

/// Sends the member's current state to the whole guild as GUILD_MEMBER_UPDATE and returns it.
async fn publish_member(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<GuildMember> {
    let member = store::member(state, guild_id, user_id).await?.ok_or_else(ApiErr::unknown_member)?;
    let members = access::guild_member_ids(state, guild_id).await?;
    state.hub.send(&members, &GatewayEvent::GuildMemberUpdate(GuildMemberAdd { member: member.clone(), guild_id: Snowflake::from(guild_id) }));
    Ok(member)
}

/// Members who see ban events: the owner and everyone with BAN_MEMBERS or ADMINISTRATOR.
async fn ban_audience(state: &AppState, ctx: &Ctx) -> ApiResult<Vec<i64>> {
    let (members, roles) = access::guild_members_with_roles(state, ctx.guild_id).await?;
    Ok(members
        .into_iter()
        .filter(|user| {
            let role_ids = roles.get(user).map(Vec::as_slice).unwrap_or(&[]);
            ctx.permissions_of(*user, role_ids) & (BAN_MEMBERS | ADMINISTRATOR) != 0
        })
        .collect())
}

// ---- kick ----

async fn kick_member(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, uid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let target = user_id_of(&uid)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(KICK_MEMBERS)?;
    require_member(&state, guild, target).await?;
    if target == user_id || !ctx.can_act_on(target, &member_role_ids(&state, guild, target).await?) {
        return Err(ApiErr::missing_permissions());
    }
    remove_member(&state, guild, target).await?;
    audit::record(&state, Entry::new(guild, user_id, AuditLogEvent::MemberKick, target).reason(reason)).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- bans ----

async fn list_bans(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Ban>>> {
    let guild = guild_id(&id)?;
    guild_access(&state, user_id, guild).await?.require(BAN_MEMBERS)?;
    let rows: Vec<(i64, Option<String>)> = sqlx::query_as("SELECT user_id, reason FROM guild_bans WHERE guild_id = $1 ORDER BY created_at, user_id LIMIT 1000")
        .bind(guild)
        .fetch_all(&state.db)
        .await?;
    let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
    let mut users = store::users(&state, &ids).await?;
    Ok(Json(rows.into_iter().filter_map(|(id, reason)| users.remove(&id).map(|user| Ban { user, reason })).collect()))
}

async fn ban_member(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, uid)): Path<(String, String)>,
    AuditReason(header_reason): AuditReason,
    ApiJson(body): ApiJson<BanRequest>,
) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let target = parse_id(&uid).ok_or_else(ApiErr::unknown_user)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(BAN_MEMBERS)?;
    let delete_seconds = body.delete_message_seconds.unwrap_or(0);
    if delete_seconds > MAX_BAN_DELETE_SECONDS {
        return Err(ApiErr::invalid("delete_message_seconds", "Must be between 0 and 604800."));
    }
    let reason = clean_text(body.reason, 512, "reason")?.or(header_reason);
    if target == user_id || target == ctx.access.owner_id {
        return Err(ApiErr::missing_permissions());
    }
    let user = store::user(&state, target).await?.ok_or_else(ApiErr::unknown_user)?;
    let was_member = require_member(&state, guild, target).await.is_ok();
    if was_member && !ctx.can_act_on(target, &member_role_ids(&state, guild, target).await?) {
        return Err(ApiErr::missing_permissions());
    }
    // Ban row first, then the member row, under the guild row lock invite accepts take shared: an accept either finished
    // before (and is removed here) or sees the ban, so a banned user never stays a member.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR NO KEY UPDATE").bind(guild).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO guild_bans (guild_id, user_id, reason, banned_by) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, created_at = now()",
    )
    .bind(guild)
    .bind(target)
    .bind(&reason)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    let removed = delete_member(&mut tx, guild, target, false).await?;
    let request = join_requests::delete_for_ban(&mut tx, guild, target).await?;
    tx.commit().await?;
    if let Some(removed) = removed {
        announce_removal(&state, guild, target, removed).await?;
    }
    if let Some(request) = request {
        join_requests::announce_ban_removal(&state, guild, request, target).await?;
    }
    if delete_seconds > 0 {
        delete_recent_messages(&state, guild, target, delete_seconds).await?;
    }
    let audience = ban_audience(&state, &ctx).await?;
    state.hub.send(&audience, &GatewayEvent::GuildBanAdd(GuildMemberRemove { guild_id: Snowflake::from(guild), user }));
    audit::record(&state, Entry::new(guild, user_id, AuditLogEvent::MemberBanAdd, target).reason(reason)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes the user's messages in the guild's channels from the last `seconds` seconds and announces each deletion like a manual delete.
async fn delete_recent_messages(state: &AppState, guild_id: i64, user_id: i64, seconds: u32) -> ApiResult<()> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT m.id, m.channel_id FROM messages m JOIN channels c ON c.id = m.channel_id \
         WHERE c.guild_id = $1 AND m.author_id = $2 AND m.created_at > now() - make_interval(secs => $3::double precision) ORDER BY m.id",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(seconds as f64)
    .fetch_all(&state.db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let message_ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
    let files: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE message_id = ANY($1) RETURNING id").bind(&message_ids).fetch_all(&state.db).await?;
    sqlx::query("DELETE FROM messages WHERE id = ANY($1)").bind(&message_ids).execute(&state.db).await?;
    media::remove_files(state, &files.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    let channels: HashSet<i64> = rows.iter().map(|(_, channel)| *channel).collect();
    for channel_id in channels {
        sqlx::query("UPDATE channels SET last_message_id = (SELECT max(id) FROM messages WHERE channel_id = $1) WHERE id = $1")
            .bind(channel_id)
            .execute(&state.db)
            .await?;
        let Some(channel) = store::channel_row(state, channel_id).await? else { continue };
        let viewers = access::channel_viewers(state, &channel).await?;
        let ids = rows.iter().filter(|(_, channel)| *channel == channel_id).map(|(message_id, _)| Snowflake::from(*message_id)).collect();
        let event =
            GatewayEvent::MessageDeleteBulk(MessageDeleteBulk { ids, channel_id: Snowflake::from(channel_id), guild_id: Some(Snowflake::from(guild_id)) });
        state.hub.send(&viewers, &event);
    }
    Ok(())
}

async fn unban_member(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, uid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let target = parse_id(&uid).ok_or_else(ApiErr::unknown_ban)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(BAN_MEMBERS)?;
    let removed = sqlx::query("DELETE FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(target).execute(&state.db).await?;
    if removed.rows_affected() == 0 {
        return Err(ApiErr::unknown_ban());
    }
    let user = store::user(&state, target).await?.ok_or_else(ApiErr::unknown_user)?;
    let audience = ban_audience(&state, &ctx).await?;
    state.hub.send(&audience, &GatewayEvent::GuildBanRemove(GuildMemberRemove { guild_id: Snowflake::from(guild), user }));
    audit::record(&state, Entry::new(guild, user_id, AuditLogEvent::MemberBanRemove, target).reason(reason)).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- member edits ----

/// Empty or whitespace-only clears the nickname.
fn clean_nick(value: Option<String>) -> ApiResult<Option<String>> {
    clean_text(value, 32, "nick")
}

async fn edit_own_member(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditOwnMemberRequest>,
) -> ApiResult<Json<GuildMember>> {
    let guild = guild_id(&id)?;
    let access = guild_access(&state, user_id, guild).await?;
    // Validate every key first so a rejected request changes nothing. Outer `None` = key absent, inner `None` = clear.
    let nick = match body.nick {
        Some(nick) => {
            access.require(CHANGE_NICKNAME)?;
            Some(clean_nick(nick)?)
        }
        None => None,
    };
    let bio = body.bio.map(|value| clean_text(value, users::MAX_BIO_CHARS, "bio")).transpose()?;
    let pronouns = body.pronouns.map(|value| clean_text(value, users::MAX_PRONOUNS_CHARS, "pronouns")).transpose()?;
    let theme = match body.theme_colors {
        None => None,
        Some(None) => Some(None),
        Some(Some(colors)) => Some(Some(users::theme_pair(colors, "theme_colors")?)),
    };
    // the claims and the write share one transaction: an account delete waits for both or sees neither
    let mut tx = state.db.begin().await?;
    // both uploads are locked up front in one statement by ascending id, so this never deadlocks with another transaction locking them
    let mut uploads: Vec<i64> = [body.avatar_attachment_id, body.banner_attachment_id].into_iter().flatten().flatten().map(|upload| upload.db()).collect();
    uploads.sort_unstable();
    crate::media::lock_uploads(&mut tx, &uploads).await?;
    let avatar = match body.avatar_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(id)) => Some(Some(users::image_path_on(&mut tx, id.db(), user_id, ImageKind::Avatar, "avatar_attachment_id", false).await?)),
    };
    let banner = match body.banner_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(id)) => Some(Some(users::image_path_on(&mut tx, id.db(), user_id, ImageKind::Banner, "banner_attachment_id", false).await?)),
    };

    let mut update = QueryBuilder::<Postgres>::new("UPDATE guild_members SET ");
    let mut sets = update.separated(", ");
    let mut any = false;
    if let Some(value) = nick {
        sets.push("nick = ").push_bind_unseparated(value);
        any = true;
    }
    if let Some(value) = avatar {
        sets.push("avatar_path = ").push_bind_unseparated(value);
        any = true;
    }
    if let Some(value) = banner {
        sets.push("banner_path = ").push_bind_unseparated(value);
        any = true;
    }
    if let Some(value) = bio {
        sets.push("bio = ").push_bind_unseparated(value);
        any = true;
    }
    if let Some(value) = pronouns {
        sets.push("pronouns = ").push_bind_unseparated(value);
        any = true;
    }
    if let Some(value) = theme {
        sets.push("theme_primary = ").push_bind_unseparated(value.map(|(primary, _)| primary));
        sets.push("theme_accent = ").push_bind_unseparated(value.map(|(_, accent)| accent));
        any = true;
    }
    if any {
        update.push(" WHERE guild_id = ").push_bind(guild).push(" AND user_id = ").push_bind(user_id);
        update.build().execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(publish_member(&state, guild, user_id).await?))
}

async fn edit_member(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, uid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<EditMemberRequest>,
) -> ApiResult<Json<GuildMember>> {
    let guild = guild_id(&id)?;
    let target = user_id_of(&uid)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    // Lock the member row and read their roles under it: every hierarchy check below and the role delete work on this one snapshot.
    let mut tx = state.db.begin().await?;
    let locked: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE")
        .bind(guild)
        .bind(target)
        .fetch_optional(&mut *tx)
        .await?;
    if locked.is_none() {
        return Err(ApiErr::unknown_member());
    }
    let own = target == user_id;
    let previous: (Option<String>, Option<OffsetDateTime>) =
        sqlx::query_as("SELECT nick, CASE WHEN timeout_until > now() THEN timeout_until END FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(guild)
            .bind(target)
            .fetch_one(&mut *tx)
            .await?;
    let current_roles: Vec<i64> = sqlx::query_as::<_, (i64,)>("SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2")
        .bind(guild)
        .bind(target)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|(id,)| id)
        .collect();
    let on_others = |ctx: &Ctx| -> ApiResult<()> { if own || ctx.can_act_on(target, &current_roles) { Ok(()) } else { Err(ApiErr::missing_permissions()) } };

    // Validate and authorise everything first so a rejected request changes nothing.
    let voice = crate::voice::moderation::authorize(&state, user_id, &ctx.access, guild, target, &body).await?;
    let nick = match body.nick {
        Some(nick) => {
            let nick = clean_nick(nick)?;
            if own && ctx.access.permissions & CHANGE_NICKNAME != 0 {
                // changing one's own nickname through this route is the same as PATCH /members/@me
            } else {
                ctx.access.require(MANAGE_NICKNAMES)?;
                on_others(&ctx)?;
            }
            Some(nick)
        }
        None => None,
    };
    let roles = match &body.roles {
        Some(requested) => {
            ctx.access.require(MANAGE_ROLES)?;
            on_others(&ctx)?;
            let mut wanted: Vec<i64> = Vec::new();
            for raw in requested {
                let role = raw.db();
                if role == guild {
                    return Err(ApiErr::invalid("roles", "The @everyone role cannot be assigned."));
                }
                if ctx.role(role).is_none() {
                    return Err(ApiErr::unknown_role());
                }
                if !wanted.contains(&role) {
                    wanted.push(role);
                }
            }
            let changed: Vec<i64> =
                wanted.iter().filter(|role| !current_roles.contains(role)).chain(current_roles.iter().filter(|role| !wanted.contains(role))).copied().collect();
            for role in changed {
                let row = ctx.role(role).ok_or_else(ApiErr::unknown_role)?;
                if is_managed_role(&mut *tx, guild, role).await? {
                    return Err(ApiErr::invalid("roles", "A bot's role cannot be assigned or removed."));
                }
                if !ctx.outranks(row) {
                    return Err(ApiErr::missing_permissions());
                }
            }
            Some(wanted)
        }
        None => None,
    };
    let timeout = match body.communication_disabled_until {
        Some(value) => {
            ctx.access.require(MODERATE_MEMBERS)?;
            if target == ctx.access.owner_id || ctx.permissions_of(target, &current_roles) & ADMINISTRATOR != 0 {
                return Err(ApiErr::missing_permissions());
            }
            // Timing out oneself is never allowed (equal rank), clearing one's own timeout needs a higher role as well.
            if !ctx.can_act_on(target, &current_roles) {
                return Err(ApiErr::missing_permissions());
            }
            match value {
                None => Some(None),
                Some(raw) => {
                    let until = OffsetDateTime::parse(raw.trim(), &Rfc3339)
                        .map_err(|_| ApiErr::invalid("communication_disabled_until", "Must be an ISO 8601 timestamp."))?;
                    let now = OffsetDateTime::now_utc();
                    if until <= now {
                        return Err(ApiErr::invalid("communication_disabled_until", "Must be in the future."));
                    }
                    if until > now + Duration::days(MAX_TIMEOUT_DAYS) {
                        return Err(ApiErr::invalid("communication_disabled_until", "Must be within 28 days."));
                    }
                    Some(Some(until))
                }
            }
        }
        None => None,
    };
    let permissions_changed = roles.is_some() || timeout.is_some();

    let iso = |value: Option<OffsetDateTime>| value.and_then(|at| at.format(&Rfc3339).ok());
    let mut member_entry = Entry::new(guild, user_id, AuditLogEvent::MemberUpdate, target).reason(reason.clone());
    if let Some(nick) = &nick {
        member_entry = member_entry.change("nick", &previous.0, nick);
    }
    if let Some(timeout) = &timeout {
        member_entry = member_entry.change("communication_disabled_until", iso(previous.1), iso(*timeout));
    }
    let mut role_entry = Entry::new(guild, user_id, AuditLogEvent::MemberRoleUpdate, target).reason(reason);
    if let Some(wanted) = &roles {
        let named = |ids: Vec<&i64>| -> Vec<serde_json::Value> {
            ids.into_iter().filter_map(|id| ctx.role(*id)).map(|row| serde_json::json!({"id": row.id.to_string(), "name": row.name})).collect()
        };
        let added = named(wanted.iter().filter(|role| !current_roles.contains(role)).collect());
        let removed = named(current_roles.iter().filter(|role| !wanted.contains(role)).collect());
        for (key, list) in [("$add", added), ("$remove", removed)] {
            if !list.is_empty() {
                role_entry = role_entry.push(AuditLogChange { key: key.to_owned(), old_value: None, new_value: Some(serde_json::Value::Array(list)) });
            }
        }
    }
    if let Some(nick) = nick {
        sqlx::query("UPDATE guild_members SET nick = $3 WHERE guild_id = $1 AND user_id = $2").bind(guild).bind(target).bind(nick).execute(&mut *tx).await?;
    }
    if let Some(timeout) = timeout {
        sqlx::query("UPDATE guild_members SET timeout_until = $3 WHERE guild_id = $1 AND user_id = $2")
            .bind(guild)
            .bind(target)
            .bind(timeout)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(wanted) = roles {
        // Only roles of the checked snapshot go; the hierarchy check covered exactly those.
        let dropped: Vec<i64> = current_roles.iter().filter(|role| !wanted.contains(role)).copied().collect();
        sqlx::query("DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = ANY($3)")
            .bind(guild)
            .bind(target)
            .bind(&dropped)
            .execute(&mut *tx)
            .await?;
        // A role a moderator takes away or hands out is theirs from now on: onboarding must not take it back later.
        let changed: Vec<i64> = dropped.iter().copied().chain(wanted.iter().filter(|role| !current_roles.contains(role)).copied()).collect();
        sqlx::query("DELETE FROM member_onboarding_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = ANY($3)")
            .bind(guild)
            .bind(target)
            .bind(&changed)
            .execute(&mut *tx)
            .await?;
        for role in wanted {
            sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
                .bind(guild)
                .bind(target)
                .bind(role)
                .execute(&mut *tx)
                .await?;
        }
    }
    voice.store(&mut tx, guild, target).await?;
    tx.commit().await?;
    voice.apply(&state, guild, target, permissions_changed).await?;
    let member = publish_member(&state, guild, target).await?;
    for entry in [member_entry, role_entry] {
        if !entry.changes.is_empty() {
            audit::record(&state, entry).await?;
        }
    }
    Ok(Json(member))
}

// ---- roles ----

fn role_name(value: &str) -> ApiResult<String> {
    let name = value.trim().to_owned();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
    }
    Ok(name)
}

fn role_color(value: u32) -> ApiResult<i32> {
    if value > 0xFF_FFFF {
        return Err(ApiErr::invalid("color", "Must be a 24-bit colour."));
    }
    Ok(value as i32)
}

/// A role icon: any emoji-ish text of 1-32 characters (trimmed); blank clears it.
fn role_emoji(value: Option<String>) -> ApiResult<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 32 || trimmed.chars().any(char::is_whitespace) {
        return Err(ApiErr::invalid("unicode_emoji", "Must be an emoji of at most 32 characters."));
    }
    Ok(Some(trimmed.to_owned()))
}

type RoleField = fn(&RoleRow) -> serde_json::Value;

/// Audit changes between two role states (only keys that differ).
fn role_changes(entry: Entry, old: Option<&RoleRow>, new: Option<&RoleRow>) -> Entry {
    let field = |row: Option<&RoleRow>, pick: fn(&RoleRow) -> serde_json::Value| row.map(pick).unwrap_or(serde_json::Value::Null);
    let keys: [(&str, RoleField); 6] = [
        ("name", |row| row.name.clone().into()),
        ("color", |row| row.color.into()),
        ("hoist", |row| row.hoist.into()),
        ("mentionable", |row| row.mentionable.into()),
        ("permissions", |row| (row.permissions as u64).to_string().into()),
        ("unicode_emoji", |row| row.unicode_emoji.clone().into()),
    ];
    keys.into_iter().fold(entry, |entry, (key, pick)| entry.change(key, field(old, pick), field(new, pick)))
}

fn role_permissions(value: &str) -> ApiResult<u64> {
    let bits = value.trim().parse::<u64>().map_err(|_| ApiErr::invalid("permissions", "Must be a decimal bitfield string."))?;
    if bits & !ALL != 0 {
        return Err(ApiErr::invalid("permissions", "Contains unknown permission bits."));
    }
    Ok(bits)
}

/// A role edit may only add or remove permission bits the actor holds (owner and administrators hold all).
fn check_grant(ctx: &Ctx, old: u64, new: u64) -> ApiResult<()> {
    if (old ^ new) & !ctx.access.permissions != 0 { Err(ApiErr::missing_permissions()) } else { Ok(()) }
}

async fn publish_role(state: &AppState, guild_id: i64, role: Role, create: bool) -> ApiResult<()> {
    let members = access::guild_member_ids(state, guild_id).await?;
    let event = GuildRoleEvent { guild_id: Snowflake::from(guild_id), role };
    state.hub.send(&members, &if create { GatewayEvent::GuildRoleCreate(event) } else { GatewayEvent::GuildRoleUpdate(event) });
    Ok(())
}

async fn create_role(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<RoleRequest>,
) -> ApiResult<Json<Role>> {
    let guild = guild_id(&id)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(MANAGE_ROLES)?;
    let emoji = role_emoji(body.unicode_emoji.clone().flatten())?;
    let name = role_name(body.name.as_deref().unwrap_or("new role"))?;
    let color = role_color(body.color.unwrap_or(0))?;
    let permissions = match &body.permissions {
        Some(raw) => role_permissions(raw)?,
        // like Discord, a new role starts with @everyone's current permissions
        None => ctx.role(guild).map(|row| row.permissions as u64).unwrap_or(0),
    };
    check_grant(&ctx, 0, permissions)?;
    if ctx.roles.len() as i64 >= MAX_ROLES {
        return Err(ApiErr::conflict(30005, "Maximum number of guild roles reached (250)"));
    }
    // Position 1 sits just above @everyone; equal positions rank by age, so a new role never outranks an older one at 1.
    let role_id = state.ids.next();
    let row: RoleRow = sqlx::query_as(&format!(
        "INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable, unicode_emoji) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8) \
         RETURNING {ROLE_COLS}"
    ))
    .bind(role_id)
    .bind(guild)
    .bind(&name)
    .bind(color)
    .bind(body.hoist.unwrap_or(false))
    .bind(permissions as i64)
    .bind(body.mentionable.unwrap_or(false))
    .bind(&emoji)
    .fetch_one(&state.db)
    .await?;
    let role = row.api();
    publish_role(&state, guild, role.clone(), true).await?;
    audit::record(&state, role_changes(Entry::new(guild, user_id, AuditLogEvent::RoleCreate, role_id).reason(reason), None, Some(&row))).await?;
    Ok(Json(role))
}

async fn update_role(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, rid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<RoleRequest>,
) -> ApiResult<Json<Role>> {
    let guild = guild_id(&id)?;
    let role_id = role_id_of(&rid)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(MANAGE_ROLES)?;
    let current = ctx.role(role_id).ok_or_else(ApiErr::unknown_role)?.clone();
    let everyone = role_id == guild;
    if is_managed_role(&state.db, guild, role_id).await? {
        return Err(ApiErr::invalid("role", "A bot's role cannot be edited. Change the bot's permissions by adding it again."));
    }
    if !everyone && !ctx.outranks(&current) {
        return Err(ApiErr::missing_permissions());
    }
    let permissions = match &body.permissions {
        Some(raw) => role_permissions(raw)?,
        None => current.permissions as u64,
    };
    check_grant(&ctx, current.permissions as u64, permissions)?;
    // @everyone keeps its name, colour, hoist and mentionable flag; only its permissions change.
    let (name, color, hoist, mentionable, emoji) = if everyone {
        (current.name.clone(), current.color, current.hoist, current.mentionable, current.unicode_emoji.clone())
    } else {
        (
            match &body.name {
                Some(name) => role_name(name)?,
                None => current.name.clone(),
            },
            match body.color {
                Some(color) => role_color(color)?,
                None => current.color,
            },
            body.hoist.unwrap_or(current.hoist),
            body.mentionable.unwrap_or(current.mentionable),
            match body.unicode_emoji {
                Some(value) => role_emoji(value)?,
                None => current.unicode_emoji.clone(),
            },
        )
    };
    let row: RoleRow = sqlx::query_as(&format!(
        "UPDATE roles SET name = $2, color = $3, hoist = $4, permissions = $5, mentionable = $6, unicode_emoji = $7 WHERE id = $1 RETURNING {ROLE_COLS}"
    ))
    .bind(role_id)
    .bind(&name)
    .bind(color)
    .bind(hoist)
    .bind(permissions as i64)
    .bind(mentionable)
    .bind(&emoji)
    .fetch_one(&state.db)
    .await?;
    let role = row.api();
    publish_role(&state, guild, role.clone(), false).await?;
    // Cosmetic edits leave voice rights alone; recomputing holds the instance-wide admission lock.
    if permissions != current.permissions as u64 {
        crate::voice::state::recompute_guild(&state, guild).await;
    }
    let entry = role_changes(Entry::new(guild, user_id, AuditLogEvent::RoleUpdate, role_id).reason(reason), Some(&current), Some(&row));
    if !entry.changes.is_empty() {
        audit::record(&state, entry).await?;
    }
    Ok(Json(role))
}

async fn update_role_positions(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Vec<RolePositionUpdate>>,
) -> ApiResult<Json<Vec<Role>>> {
    let guild = guild_id(&id)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(MANAGE_ROLES)?;
    let actor_top = highest_role(&ctx.ranks_of(&ctx.access.roles));
    let mut wanted: HashMap<i64, i32> = HashMap::new();
    for update in &body {
        let role_id = update.id.db();
        if role_id == guild {
            return Err(ApiErr::invalid("id", "The @everyone role cannot be moved."));
        }
        let row = ctx.role(role_id).ok_or_else(ApiErr::unknown_role)?;
        if !(1..=1000).contains(&update.position) {
            return Err(ApiErr::invalid("position", "Must be between 1 and 1000."));
        }
        if !ctx.owner() {
            // Only roles strictly below the actor's highest, and only to positions strictly below it.
            let top = actor_top.ok_or_else(ApiErr::missing_permissions)?;
            if !ctx.outranks(row) || update.position >= top.position {
                return Err(ApiErr::missing_permissions());
            }
        }
        wanted.insert(role_id, update.position);
    }
    let mut changed = Vec::new();
    for (role_id, position) in wanted {
        if ctx.role(role_id).is_some_and(|row| row.position != position) {
            sqlx::query("UPDATE roles SET position = $2 WHERE id = $1").bind(role_id).bind(position).execute(&state.db).await?;
            changed.push(role_id);
        }
    }
    let roles = load_roles(&state, guild).await?;
    changed.sort_unstable();
    for role_id in changed {
        if let Some(row) = roles.iter().find(|row| row.id == role_id) {
            publish_role(&state, guild, row.api(), false).await?;
        }
    }
    Ok(Json(roles.iter().map(RoleRow::api).collect()))
}

async fn delete_role(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, rid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let guild = guild_id(&id)?;
    let role_id = role_id_of(&rid)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    ctx.access.require(MANAGE_ROLES)?;
    let current = ctx.role(role_id).ok_or_else(ApiErr::unknown_role)?.clone();
    if role_id == guild {
        return Err(ApiErr::invalid_role());
    }
    if is_managed_role(&state.db, guild, role_id).await? {
        return Err(ApiErr::invalid("role", "A bot's role cannot be deleted. Remove the bot from Integrations instead."));
    }
    if !ctx.outranks(&current) {
        return Err(ApiErr::missing_permissions());
    }
    // Overwrites naming the role go with it (member_roles rows cascade); the affected channels are re-sent.
    let channels: Vec<(i64,)> = sqlx::query_as("DELETE FROM permission_overwrites WHERE target_type = 0 AND target_id = $1 RETURNING channel_id")
        .bind(role_id)
        .fetch_all(&state.db)
        .await?;
    sqlx::query("DELETE FROM roles WHERE id = $1").bind(role_id).execute(&state.db).await?;
    let members = access::guild_member_ids(&state, guild).await?;
    state.hub.send(&members, &GatewayEvent::GuildRoleDelete(GuildRoleDelete { guild_id: Snowflake::from(guild), role_id: Snowflake::from(role_id) }));
    for (channel_id,) in channels {
        if let Some(row) = store::channel_row(&state, channel_id).await? {
            events::dispatch_channel(&state, &row, GatewayEvent::ChannelUpdate).await?;
        }
    }
    crate::voice::state::recompute_guild(&state, guild).await;
    audit::record(&state, role_changes(Entry::new(guild, user_id, AuditLogEvent::RoleDelete, role_id).reason(reason), Some(&current), None)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /guilds/{id}/roles/member-counts`: how many members hold each role (@everyone left out).
async fn role_member_counts(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<HashMap<String, i64>>> {
    let guild = guild_id(&id)?;
    guild_access(&state, user_id, guild).await?;
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT r.id, count(m.user_id) FROM roles r LEFT JOIN member_roles m ON m.role_id = r.id WHERE r.guild_id = $1 AND r.id <> $1 GROUP BY r.id",
    )
    .bind(guild)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(|(id, count)| (id.to_string(), count)).collect()))
}

// ---- prune ----

const DEFAULT_PRUNE_DAYS: u32 = 7;

/// Query form of `PruneRequest`: `include_roles` is comma-separated.
#[derive(serde::Deserialize)]
struct PruneQuery {
    days: Option<u32>,
    include_roles: Option<String>,
}

/// Validated prune parameters: (days, included roles).
fn prune_params(ctx: &Ctx, days: Option<u32>, include_roles: Vec<i64>) -> ApiResult<(u32, Vec<i64>)> {
    ctx.access.require(KICK_MEMBERS | MANAGE_GUILD)?;
    let days = days.unwrap_or(DEFAULT_PRUNE_DAYS);
    if !(1..=30).contains(&days) {
        return Err(ApiErr::invalid("days", "Must be between 1 and 30."));
    }
    for role in &include_roles {
        let row = ctx.role(*role).filter(|row| row.id != ctx.guild_id).ok_or_else(|| ApiErr::invalid("include_roles", "Unknown role."))?;
        if !ctx.outranks(row) {
            return Err(ApiErr::missing_permissions());
        }
    }
    Ok((days, include_roles))
}

/// Members a prune removes: joined more than `days` ago, no message of their own (join notices do not count) in the guild for `days`, not the owner or the caller,
/// and holding no role outside `include_roles`.
async fn prunable(state: &AppState, ctx: &Ctx, days: u32, include_roles: &[i64]) -> ApiResult<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT m.user_id FROM guild_members m WHERE m.guild_id = $1 AND m.user_id <> $2 AND m.user_id <> $3          AND m.joined_at < now() - make_interval(days => $4)          AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id AND NOT (r.role_id = ANY($5)))          AND NOT EXISTS (SELECT 1 FROM messages x JOIN channels c ON c.id = x.channel_id                          WHERE c.guild_id = m.guild_id AND x.author_id = m.user_id AND x.kind IN (0, 19) AND x.created_at > now() - make_interval(days => $4))          ORDER BY m.user_id",
    )
    .bind(ctx.guild_id)
    .bind(ctx.access.owner_id)
    .bind(ctx.user_id)
    .bind(days as i32)
    .bind(include_roles)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

async fn prune_count(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<PruneQuery>,
) -> ApiResult<Json<PruneResponse>> {
    let guild = guild_id(&id)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    let mut include = Vec::new();
    for raw in query.include_roles.as_deref().unwrap_or("").split(',').map(str::trim).filter(|raw| !raw.is_empty()) {
        include.push(parse_id(raw).ok_or_else(|| ApiErr::invalid("include_roles", "Must be role ids."))?);
    }
    let (days, include) = prune_params(&ctx, query.days, include)?;
    let members = prunable(&state, &ctx, days, &include).await?;
    Ok(Json(PruneResponse { pruned: Some(members.len() as u32) }))
}

async fn prune(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<PruneRequest>,
) -> ApiResult<Json<PruneResponse>> {
    let guild = guild_id(&id)?;
    let ctx = Ctx::load(&state, user_id, guild).await?;
    let include = body.include_roles.unwrap_or_default().into_iter().map(Snowflake::db).collect();
    let (days, include) = prune_params(&ctx, body.days, include)?;
    let members = prunable(&state, &ctx, days, &include).await?;
    for member in &members {
        remove_member(&state, guild, *member).await?;
    }
    let options = AuditEntryInfo { delete_member_days: Some(days.to_string()), members_removed: Some(members.len().to_string()), ..Default::default() };
    let mut entry = Entry::new(guild, user_id, AuditLogEvent::MemberPrune, guild).reason(reason).options(options);
    entry.target_id = None;
    audit::record(&state, entry).await?;
    Ok(Json(PruneResponse { pruned: body.compute_prune_count.unwrap_or(true).then_some(members.len() as u32) }))
}
