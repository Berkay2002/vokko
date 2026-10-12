//! Invites: create (with expiry, use limit, temporary membership, reuse), preview, accept, list and revoke.
use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use vokko_protocol::api::permissions::{CREATE_INSTANT_INVITE, MANAGE_CHANNELS, MANAGE_GUILD};
use vokko_protocol::api::{
    AuditLogEvent, CreateInviteRequest, GatewayEvent, Guild, GuildMemberAdd, Invite, InviteChannel, InviteDelete, InviteGuild, InviteMetadata, JoinMode,
    MessageType, Snowflake,
};

use crate::access::{self, channel_access, guild_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::{AuthUser, random_hex};
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::parse_id;
use crate::presence;
use crate::routes::messages::{Draft, Resolved, insert_message};
use crate::state::AppState;
use crate::store::{self, iso};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/invites", post(create_invite).get(list_channel_invites))
        .route("/guilds/{id}/invites", get(list_guild_invites))
        .route("/invites/{code}", get(preview).post(accept).delete(revoke))
}

/// Longest `max_age` (7 days) and highest `max_uses`.
const MAX_AGE_SECONDS: u32 = 604_800;
const MAX_USES: u32 = 100;
const DEFAULT_MAX_AGE_SECONDS: u32 = 86_400;
/// SQL condition (on alias `i`) for an invite that has neither expired nor been used up.
const LIVE: &str = "(i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses = 0 OR i.uses < i.max_uses)";

pub fn invite_code() -> String {
    // 8 alphanumerics drawn from random hex pairs mapped onto the alphabet.
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let hex = random_hex(8);
    (0..8)
        .map(|index| {
            let byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap_or(0);
            ALPHABET[byte as usize % ALPHABET.len()] as char
        })
        .collect()
}

#[derive(sqlx::FromRow)]
pub(crate) struct InviteRow {
    pub(crate) code: String,
    pub(crate) guild_id: i64,
    channel_id: i64,
    pub(crate) inviter_id: i64,
    guild_name: String,
    icon_path: Option<String>,
    channel_name: Option<String>,
    expires_at: Option<time::OffsetDateTime>,
    created_at: time::OffsetDateTime,
    uses: i32,
    max_uses: i32,
    max_age: i32,
    temporary: bool,
    join_mode: i16,
}

/// Which live invites to load.
enum Filter<'a> {
    Code(&'a str),
    Guild(i64),
    Channel(i64),
}

/// Live invites matching `filter`, oldest first.
async fn live_rows(state: &AppState, filter: Filter<'_>) -> ApiResult<Vec<InviteRow>> {
    let column = match filter {
        Filter::Code(_) => "i.code",
        Filter::Guild(_) => "i.guild_id",
        Filter::Channel(_) => "i.channel_id",
    };
    let sql = format!(
        "SELECT i.code, i.guild_id, i.channel_id, i.inviter_id, g.name AS guild_name, g.icon_path, c.name AS channel_name, i.expires_at, i.created_at, \
         i.uses, i.max_uses, i.max_age, i.temporary, g.join_mode \
         FROM invites i JOIN guilds g ON g.id = i.guild_id JOIN channels c ON c.id = i.channel_id \
         WHERE {column} = $1 AND {LIVE} ORDER BY i.created_at, i.code LIMIT 1000"
    );
    let query = sqlx::query_as::<_, InviteRow>(&sql);
    let query = match filter {
        Filter::Code(code) => query.bind(code.to_owned()),
        Filter::Guild(id) | Filter::Channel(id) => query.bind(id),
    };
    Ok(query.fetch_all(&state.db).await?)
}

pub(crate) async fn live_row(state: &AppState, code: &str) -> ApiResult<InviteRow> {
    live_rows(state, Filter::Code(code)).await?.into_iter().next().ok_or_else(ApiErr::unknown_invite)
}

fn preview_of(state: &AppState, row: &InviteRow, member_count: u32) -> Invite {
    Invite {
        code: row.code.clone(),
        guild: InviteGuild {
            id: Snowflake::from(row.guild_id),
            name: row.guild_name.clone(),
            icon: row.icon_path.as_ref().map(|path| state.asset_url(path)),
            member_count,
            join_mode: JoinMode::from_u8(row.join_mode as u8).unwrap_or_default(),
        },
        channel: InviteChannel { id: Snowflake::from(row.channel_id), name: row.channel_name.clone() },
        expires_at: row.expires_at.map(iso),
    }
}

async fn metadata(state: &AppState, rows: Vec<InviteRow>) -> ApiResult<Vec<InviteMetadata>> {
    let inviter_ids: Vec<i64> = rows.iter().map(|row| row.inviter_id).collect();
    let users = store::users(state, &inviter_ids).await?;
    let mut counts: HashMap<i64, u32> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let member_count = match counts.get(&row.guild_id) {
            Some(count) => *count,
            None => {
                let count = store::member_count(state, row.guild_id).await?;
                counts.insert(row.guild_id, count);
                count
            }
        };
        out.push(InviteMetadata {
            invite: preview_of(state, &row, member_count),
            inviter: users.get(&row.inviter_id).cloned(),
            uses: row.uses.max(0) as u32,
            max_uses: row.max_uses.max(0) as u32,
            max_age: row.max_age.max(0) as u32,
            temporary: row.temporary,
            created_at: iso(row.created_at),
        });
    }
    Ok(out)
}

/// Guild members who may list (and revoke) invites of `channel_id`: MANAGE_GUILD, or MANAGE_CHANNELS on the channel.
async fn invite_audience(state: &AppState, guild_id: i64, channel_id: i64) -> ApiResult<Vec<i64>> {
    let mut audience = access::members_with_permission(state, guild_id, MANAGE_GUILD).await?;
    if let Some(channel) = store::channel_row(state, channel_id).await? {
        for (user_id, bits) in access::viewer_permissions(state, &channel).await? {
            if bits & MANAGE_CHANNELS != 0 && !audience.contains(&user_id) {
                audience.push(user_id);
            }
        }
    }
    Ok(audience)
}

fn bounded(value: Option<u32>, default: u32, max: u32, field: &str) -> ApiResult<i32> {
    let value = value.unwrap_or(default);
    if value > max {
        return Err(ApiErr::invalid(field, &format!("Must be between 0 and {max}.")));
    }
    Ok(value as i32)
}

async fn create_invite(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    body: axum::body::Bytes,
) -> ApiResult<Json<InviteMetadata>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, id).await?;
    let Some(guild_id) = access.channel.guild_id else { return Err(ApiErr::invalid("channel_id", "Invites need a guild channel.")) };
    if access.channel.is_thread() || access.channel.channel_type() == vokko_protocol::api::ChannelType::GuildCategory {
        return Err(ApiErr::invalid("channel_id", "Invites need a text, voice, announcement or forum channel."));
    }
    access.require(CREATE_INSTANT_INVITE)?;
    let request: CreateInviteRequest = if body.is_empty() {
        CreateInviteRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|error| ApiErr::invalid("body", &error.to_string()))?
    };
    let max_age = bounded(request.max_age, DEFAULT_MAX_AGE_SECONDS, MAX_AGE_SECONDS, "max_age")?;
    let max_uses = bounded(request.max_uses, 0, MAX_USES, "max_uses")?;
    let temporary = request.temporary.unwrap_or(false);
    if !request.unique.unwrap_or(false) {
        let sql = format!(
            "SELECT i.code FROM invites i WHERE i.channel_id = $1 AND i.inviter_id = $2 AND i.max_age = $3 AND i.max_uses = $4 AND i.temporary = $5 \
             AND {LIVE} ORDER BY i.created_at DESC LIMIT 1"
        );
        let existing: Option<(String,)> =
            sqlx::query_as(&sql).bind(id).bind(user_id).bind(max_age).bind(max_uses).bind(temporary).fetch_optional(&state.db).await?;
        if let Some((code,)) = existing {
            let rows = live_rows(&state, Filter::Code(&code)).await?;
            if let Some(found) = metadata(&state, rows).await?.into_iter().next() {
                return Ok(Json(found));
            }
        }
    }
    let code = invite_code();
    sqlx::query(
        "INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_age, max_uses, temporary, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5::int > 0 THEN now() + ($5::int * interval '1 second') END)",
    )
    .bind(&code)
    .bind(guild_id)
    .bind(id)
    .bind(user_id)
    .bind(max_age)
    .bind(max_uses)
    .bind(temporary)
    .execute(&state.db)
    .await?;
    let entry = Entry::new(guild_id, user_id, AuditLogEvent::InviteCreate, &code)
        .reason(reason)
        .change("code", (), &code)
        .change("channel_id", (), id.to_string())
        .change("inviter_id", (), user_id.to_string())
        .change("max_age", (), max_age)
        .change("max_uses", (), max_uses)
        .change("temporary", (), temporary);
    audit::record(&state, entry).await?;
    let created = metadata(&state, vec![live_row(&state, &code).await?]).await?.into_iter().next().ok_or_else(ApiErr::internal)?;
    let audience = invite_audience(&state, guild_id, id).await?;
    state.hub.send(&audience, &GatewayEvent::InviteCreate(Box::new(created.clone())));
    Ok(Json(created))
}

async fn list_channel_invites(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<InviteMetadata>>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, id).await?;
    if access.channel.guild_id.is_none() {
        return Err(ApiErr::missing_permissions());
    }
    access.require(MANAGE_CHANNELS)?;
    let rows = live_rows(&state, Filter::Channel(id)).await?;
    Ok(Json(metadata(&state, rows).await?))
}

async fn list_guild_invites(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<InviteMetadata>>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(&state, user_id, id).await?.require(MANAGE_GUILD)?;
    let rows = live_rows(&state, Filter::Guild(id)).await?;
    Ok(Json(metadata(&state, rows).await?))
}

/// `DELETE /invites/{code}`: MANAGE_GUILD, or MANAGE_CHANNELS on the invite's channel.
async fn revoke(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(code): Path<String>,
    AuditReason(reason): AuditReason,
) -> ApiResult<Json<InviteMetadata>> {
    let row = live_row(&state, &code).await?;
    let (guild_id, channel_id) = (row.guild_id, row.channel_id);
    let guild = guild_access(&state, user_id, guild_id).await?;
    if guild.permissions & MANAGE_GUILD == 0 {
        channel_access(&state, user_id, channel_id).await?.require(MANAGE_CHANNELS)?;
    }
    let revoked = metadata(&state, vec![row]).await?.into_iter().next().ok_or_else(ApiErr::internal)?;
    let deleted = sqlx::query("DELETE FROM invites WHERE code = $1").bind(&code).execute(&state.db).await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiErr::unknown_invite());
    }
    let entry = Entry::new(guild_id, user_id, AuditLogEvent::InviteDelete, &code)
        .reason(reason)
        .change("code", &code, ())
        .change("channel_id", channel_id.to_string(), ())
        .change("inviter_id", revoked.inviter.as_ref().map(|user| user.id.to_string()), ())
        .change("uses", revoked.uses, ())
        .change("max_age", revoked.max_age, ())
        .change("max_uses", revoked.max_uses, ());
    audit::record(&state, entry).await?;
    let audience = invite_audience(&state, guild_id, channel_id).await?;
    state.hub.send(
        &audience,
        &GatewayEvent::InviteDelete(InviteDelete { code: code.clone(), guild_id: Snowflake::from(guild_id), channel_id: Snowflake::from(channel_id) }),
    );
    Ok(Json(revoked))
}

/// After the user's last gateway connection closed: their temporary memberships without a role end like a kick.
/// The owner is never removed. A user who is online again (reconnected or resumed meanwhile) keeps every membership.
pub async fn remove_temporary_memberships(state: &AppState, user_id: i64) -> ApiResult<()> {
    if state.hub.is_online(user_id) {
        return Ok(());
    }
    let guilds: Vec<(i64,)> = sqlx::query_as(
        "SELECT m.guild_id FROM guild_members m JOIN guilds g ON g.id = m.guild_id \
         WHERE m.user_id = $1 AND m.temporary AND g.owner_id <> $1 \
         AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id)",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    for (guild_id,) in guilds {
        if state.hub.is_online(user_id) {
            return Ok(());
        }
        // One failed guild must not keep the user in the others.
        if let Err(error) = crate::routes::moderation::remove_member(state, guild_id, user_id).await {
            tracing::warn!("removing temporary membership of {user_id} in {guild_id} failed: {error:?}");
        }
    }
    Ok(())
}

/// Open to anonymous callers (the invite landing page before sign-in): `Invite` only carries the public card fields, so both
/// get the same body. Anonymous callers are held to a stricter per-address limit (`ratelimit::ANON_INVITE_*`).
async fn preview(State(state): State<AppState>, _caller: Option<AuthUser>, Path(code): Path<String>) -> ApiResult<Json<Invite>> {
    let row = live_row(&state, &code).await?;
    let member_count = store::member_count(&state, row.guild_id).await?;
    Ok(Json(preview_of(&state, &row, member_count)))
}

async fn accept(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(code): Path<String>) -> ApiResult<Json<Guild>> {
    let invite = live_row(&state, &code).await?;
    let (guild_id, temporary) = (invite.guild_id, invite.temporary);
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
    // The join mode is read under the same lock, so a switch to Apply to Join cannot race an accept: an invite alone then lets no one in.
    let locked: Option<(i16,)> = sqlx::query_as("SELECT join_mode FROM guilds WHERE id = $1 FOR SHARE").bind(guild_id).fetch_optional(&mut *tx).await?;
    let (join_mode,) = locked.ok_or_else(ApiErr::unknown_invite)?;
    if join_mode == i16::from(JoinMode::Apply.as_u8()) {
        let member: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(guild_id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
        if member.is_none() {
            return Err(ApiErr::application_required());
        }
    }
    let joined = Via { code: Some(&invite.code), inviter_id: Some(invite.inviter_id), temporary };
    let is_new = insert_member(&mut tx, guild_id, user_id, &joined).await?;
    if !is_new {
        // Nothing inserted: already a member, or banned since the check above.
        let banned: Option<(i64,)> =
            sqlx::query_as("SELECT user_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).fetch_optional(&mut *tx).await?;
        if banned.is_some() {
            return Err(ApiErr::banned());
        }
        // A temporary member who accepts a normal invite becomes a permanent one.
        if !temporary {
            sqlx::query("UPDATE guild_members SET temporary = FALSE WHERE guild_id = $1 AND user_id = $2 AND temporary")
                .bind(guild_id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
    } else {
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
    if is_new {
        announce_new_member(&state, guild_id, user_id).await?;
    }
    store::guild(&state, guild_id).await?.map(Json).ok_or_else(ApiErr::unknown_guild)
}

/// How a new member came in, recorded for the members page.
pub struct Via<'a> {
    pub code: Option<&'a str>,
    pub inviter_id: Option<i64>,
    pub temporary: bool,
}

/// Inserts the member inside `tx` (callers hold the shared guild row lock) unless banned or already a member; `false` then.
/// A new member also gets the onboarding flag and a timeout still running from before they left.
pub async fn insert_member(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, guild_id: i64, user_id: i64, via: &Via<'_>) -> ApiResult<bool> {
    let inserted = sqlx::query(
        "INSERT INTO guild_members (guild_id, user_id, temporary, source_invite_code, inviter_id, join_source_type) SELECT $1, $2, $3, $4, $5, $6 \
         WHERE NOT EXISTS (SELECT 1 FROM guild_bans WHERE guild_id = $1 AND user_id = $2) ON CONFLICT DO NOTHING",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(via.temporary)
    .bind(via.code)
    .bind(via.inviter_id)
    .bind(i16::from(vokko_protocol::api::join_source_type::INVITE))
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Ok(false);
    }
    // Guilds with onboarding switched on show new members the flow until they finish it.
    sqlx::query(
        "UPDATE guild_members SET flags = flags | $3 WHERE guild_id = $1 AND user_id = $2 \
         AND EXISTS (SELECT 1 FROM guild_onboarding WHERE guild_id = $1 AND enabled)",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(vokko_protocol::api::member_flags::STARTED_ONBOARDING as i32)
    .execute(&mut **tx)
    .await?;
    // A timeout still running from before they left or were kicked comes back with them.
    sqlx::query(
        "UPDATE guild_members m SET timeout_until = t.until FROM guild_timeouts t \
         WHERE m.guild_id = $1 AND m.user_id = $2 AND t.guild_id = $1 AND t.user_id = $2 AND t.until > now()",
    )
    .bind(guild_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM guild_timeouts WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).execute(&mut **tx).await?;
    Ok(true)
}

/// After the commit of a new member: read states, GUILD_CREATE to them, GUILD_MEMBER_ADD to the others, presence and the join message.
pub async fn announce_new_member(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    sqlx::query("INSERT INTO read_states (user_id, channel_id, last_message_id) SELECT $1, id, last_message_id FROM channels WHERE guild_id = $2 AND kind IN (0, 2, 5) ON CONFLICT DO NOTHING")
        .bind(user_id)
        .bind(guild_id)
        .execute(&state.db)
        .await?;
    let mut full = events::guild_with_state(state, guild_id, user_id).await?;
    full.presences = Some(presence::guild_presences(state, guild_id, user_id).await?);
    state.hub.send(&[user_id], &GatewayEvent::GuildCreate(Box::new(full)));
    if let Some(member) = store::member(state, guild_id, user_id).await? {
        let others: Vec<i64> = access::guild_member_ids(state, guild_id).await?.into_iter().filter(|id| *id != user_id).collect();
        state.hub.send(&others, &GatewayEvent::GuildMemberAdd(GuildMemberAdd { member, guild_id: Snowflake::from(guild_id) }));
    }
    presence::announce_join(state, guild_id, user_id).await?;
    if let Err(error) = post_join_message(state, guild_id, user_id).await {
        tracing::warn!("join message failed: {error:?}");
    }
    Ok(())
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
