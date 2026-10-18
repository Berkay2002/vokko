//! Permission resolution (Discord's algorithm) and channel access checks. The server is authoritative for every check.
use std::collections::HashMap;

use std::cmp::Ordering;

use vokko_protocol::api::permissions::{
    ADD_REACTIONS, ADMINISTRATOR, ALL, ATTACH_FILES, EMBED_LINKS, READ_MESSAGE_HISTORY, SEND_MESSAGES, SEND_TTS_MESSAGES, SEND_VOICE_MESSAGES, TIMEOUT_ALLOWED,
    VIEW_CHANNEL,
};

use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;
use crate::store::{self, ChannelRow};
use crate::threads;

/// What participants of a DM or group DM may do.
pub const DM_PERMISSIONS: u64 =
    VIEW_CHANNEL | SEND_MESSAGES | SEND_TTS_MESSAGES | ATTACH_FILES | ADD_REACTIONS | READ_MESSAGE_HISTORY | EMBED_LINKS | SEND_VOICE_MESSAGES;

#[derive(Clone, Debug)]
pub struct Overwrite {
    pub target_id: i64,
    /// 0 role, 1 member
    pub target_type: i16,
    pub allow: u64,
    pub deny: u64,
}

/// Guild-wide permissions: owner and ADMINISTRATOR get everything, otherwise `@everyone` (role id == guild id) plus the member's roles.
pub fn base_permissions(guild_id: i64, owner_id: i64, user_id: i64, role_permissions: &HashMap<i64, u64>, member_roles: &[i64]) -> u64 {
    if owner_id == user_id {
        return ALL;
    }
    let mut permissions = role_permissions.get(&guild_id).copied().unwrap_or(0);
    for role in member_roles {
        permissions |= role_permissions.get(role).copied().unwrap_or(0);
    }
    if permissions & ADMINISTRATOR != 0 { ALL } else { permissions }
}

/// Applies channel overwrites: `@everyone`, then the member's roles (all denies, then all allows), then the member itself.
pub fn channel_permissions(base: u64, guild_id: i64, user_id: i64, member_roles: &[i64], overwrites: &[Overwrite]) -> u64 {
    if base & ADMINISTRATOR != 0 {
        return ALL;
    }
    let mut permissions = base;
    if let Some(everyone) = overwrites.iter().find(|overwrite| overwrite.target_type == 0 && overwrite.target_id == guild_id) {
        permissions &= !everyone.deny;
        permissions |= everyone.allow;
    }
    let (mut allow, mut deny) = (0_u64, 0_u64);
    for overwrite in overwrites.iter().filter(|overwrite| overwrite.target_type == 0 && member_roles.contains(&overwrite.target_id)) {
        allow |= overwrite.allow;
        deny |= overwrite.deny;
    }
    permissions &= !deny;
    permissions |= allow;
    if let Some(member) = overwrites.iter().find(|overwrite| overwrite.target_type == 1 && overwrite.target_id == user_id) {
        permissions &= !member.deny;
        permissions |= member.allow;
    }
    // ADMINISTRATOR only ever comes from the base (role) permissions, which returned ALL above; an overwrite cannot grant it.
    permissions &= !ADMINISTRATOR;
    // Without VIEW_CHANNEL nothing else in the channel is usable.
    if permissions & VIEW_CHANNEL == 0 { 0 } else { permissions }
}

/// A timed-out member keeps only view + history; owner and administrators are exempt.
pub fn clamp_timeout(permissions: u64, timed_out: bool) -> u64 {
    if timed_out && permissions & ADMINISTRATOR == 0 { permissions & TIMEOUT_ALLOWED } else { permissions }
}

/// A role as far as ranking is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoleRank {
    pub id: i64,
    pub position: i32,
    /// `@everyone` (role id == guild id) always ranks lowest.
    pub everyone: bool,
}

/// `Greater` when `a` outranks `b`: higher position wins, ties go to the older (smaller) snowflake.
pub fn compare_roles(a: &RoleRank, b: &RoleRank) -> Ordering {
    match (a.everyone, b.everyone) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.position.cmp(&b.position).then_with(|| b.id.cmp(&a.id)),
    }
}

pub fn highest_role(roles: &[RoleRank]) -> Option<RoleRank> {
    roles.iter().copied().max_by(compare_roles)
}

/// Moderation hierarchy: the owner can act on everyone but nobody acts on the owner; otherwise the actor's highest role must
/// outrank the target's highest role (a target without roles can always be acted on). The caller checks the permission itself.
pub fn can_act_on(actor_is_owner: bool, target_is_owner: bool, actor_roles: &[RoleRank], target_roles: &[RoleRank]) -> bool {
    if target_is_owner {
        return false;
    }
    if actor_is_owner {
        return true;
    }
    match (highest_role(actor_roles), highest_role(target_roles)) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(actor), Some(target)) => compare_roles(&actor, &target) == Ordering::Greater,
    }
}

pub struct GuildAccess {
    pub owner_id: i64,
    pub timed_out: bool,
    pub permissions: u64,
    pub roles: Vec<i64>,
}

async fn role_permissions(state: &AppState, guild_id: i64) -> ApiResult<HashMap<i64, u64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT id, permissions FROM roles WHERE guild_id = $1").bind(guild_id).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|(id, permissions)| (id, permissions as u64)).collect())
}

/// Membership + guild-wide permissions. 404 unknown guild, 403 not a member.
pub async fn guild_access(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<GuildAccess> {
    let owner: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1").bind(guild_id).fetch_optional(&state.db).await?;
    let Some((owner_id,)) = owner else { return Err(ApiErr::unknown_guild()) };
    let member: Option<(bool,)> = sqlx::query_as("SELECT COALESCE(timeout_until > now(), FALSE) FROM guild_members WHERE guild_id = $1 AND user_id = $2")
        .bind(guild_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((timed_out,)) = member else { return Err(ApiErr::missing_access()) };
    let roles: Vec<(i64,)> =
        sqlx::query_as("SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(user_id).fetch_all(&state.db).await?;
    let roles: Vec<i64> = roles.into_iter().map(|(id,)| id).collect();
    let base = base_permissions(guild_id, owner_id, user_id, &role_permissions(state, guild_id).await?, &roles);
    // The owner is never clamped (Discord returns before the timeout step).
    let permissions = if owner_id == user_id { base } else { clamp_timeout(base, timed_out) };
    Ok(GuildAccess { owner_id, timed_out, permissions, roles })
}

impl GuildAccess {
    pub fn require(&self, bit: u64) -> ApiResult<()> {
        if self.permissions & bit == bit { Ok(()) } else { Err(ApiErr::missing_permissions()) }
    }
}

pub struct ChannelAccess {
    pub channel: ChannelRow,
    pub permissions: u64,
    /// Threads: the parent channel the permissions were resolved on.
    pub parent: Option<ChannelRow>,
}

impl ChannelAccess {
    pub fn require(&self, bit: u64) -> ApiResult<()> {
        if self.permissions & bit == bit { Ok(()) } else { Err(ApiErr::missing_permissions()) }
    }

    pub fn is_dm(&self) -> bool {
        self.channel.is_dm()
    }

    /// Archived threads are read-only: editing, reacting, joining and adding members need them unarchived first.
    pub fn require_unarchived(&self) -> ApiResult<()> {
        if self.channel.is_thread() && self.channel.archived { Err(ApiErr::thread_archived()) } else { Ok(()) }
    }
}

async fn overwrites_for(state: &AppState, channel_id: i64) -> ApiResult<Vec<Overwrite>> {
    let rows: Vec<(i64, i16, i64, i64)> = sqlx::query_as("SELECT target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_all(&state.db)
        .await?;
    Ok(rows.into_iter().map(|(target_id, target_type, allow, deny)| Overwrite { target_id, target_type, allow: allow as u64, deny: deny as u64 }).collect())
}

/// Resolves what `user_id` may do in a channel. 404 unknown channel; 403 (50001) when they cannot see it.
pub async fn channel_access(state: &AppState, user_id: i64, channel_id: i64) -> ApiResult<ChannelAccess> {
    let channel = store::channel_row(state, channel_id).await?.ok_or_else(ApiErr::unknown_channel)?;
    if channel.is_dm() {
        // A bot only reaches DMs whose other recipients still share a guild with it.
        let member: Option<(bool, bool)> = sqlx::query_as(
            "SELECT u.bot, NOT EXISTS (SELECT 1 FROM channel_recipients o WHERE o.channel_id = $1 AND o.user_id <> $2 \
             AND NOT EXISTS (SELECT 1 FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id WHERE a.user_id = $2 AND b.user_id = o.user_id)) \
             FROM channel_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = $1 AND r.user_id = $2",
        )
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
        match member {
            Some((false, _)) | Some((true, true)) => {}
            _ => return Err(ApiErr::missing_access()),
        }
        return Ok(ChannelAccess { channel, permissions: DM_PERMISSIONS, parent: None });
    }
    if channel.is_thread() {
        return threads::thread_access(state, user_id, channel).await;
    }
    guild_channel_access(state, user_id, channel).await
}

/// `channel_access` for a guild channel that is not a thread (threads resolve on their parent).
pub async fn guild_channel_access(state: &AppState, user_id: i64, channel: ChannelRow) -> ApiResult<ChannelAccess> {
    let channel_id = channel.id;
    let guild_id = channel.guild_id.ok_or_else(ApiErr::unknown_channel)?;
    let guild = guild_access(state, user_id, guild_id).await?;
    let overwrites = overwrites_for(state, channel_id).await?;
    // Overwrites may allow more than the clamp lets through, so clamp again.
    let resolved = channel_permissions(guild.permissions, guild_id, user_id, &guild.roles, &overwrites);
    let permissions = if guild.owner_id == user_id { resolved } else { clamp_timeout(resolved, guild.timed_out) };
    if permissions & VIEW_CHANNEL == 0 {
        return Err(ApiErr::missing_access());
    }
    Ok(ChannelAccess { channel, permissions, parent: None })
}

/// Which of `channel_ids` `user_id` can see (same rules as `channel_access`, VIEW_CHANNEL after overwrites), in a
/// constant number of queries. Unknown channels and channels of guilds the user is not in are left out.
pub async fn viewable_channels(state: &AppState, user_id: i64, channel_ids: &[i64]) -> ApiResult<std::collections::HashSet<i64>> {
    use std::collections::HashSet;
    let mut visible = HashSet::new();
    let all: Vec<(i64, Option<i64>, i16)> =
        sqlx::query_as("SELECT id, guild_id, kind FROM channels WHERE id = ANY($1)").bind(channel_ids).fetch_all(&state.db).await?;
    // Threads resolve on their parent (and membership), which the batch below does not know about.
    for (id, _, kind) in &all {
        if threads::is_thread_kind(*kind) && channel_access(state, user_id, *id).await.is_ok() {
            visible.insert(*id);
        }
    }
    let channels: Vec<(i64, Option<i64>)> =
        all.into_iter().filter(|(_, _, kind)| !threads::is_thread_kind(*kind)).map(|(id, guild_id, _)| (id, guild_id)).collect();
    let dm_ids: Vec<i64> = channels.iter().filter(|(_, guild_id)| guild_id.is_none()).map(|(id, _)| *id).collect();
    if !dm_ids.is_empty() {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT channel_id FROM channel_recipients WHERE user_id = $1 AND channel_id = ANY($2)")
            .bind(user_id)
            .bind(&dm_ids)
            .fetch_all(&state.db)
            .await?;
        visible.extend(rows.into_iter().map(|(id,)| id));
    }
    let guild_channels: Vec<(i64, i64)> = channels.iter().filter_map(|(id, guild_id)| guild_id.map(|g| (*id, g))).collect();
    if guild_channels.is_empty() {
        return Ok(visible);
    }
    let mut guild_ids: Vec<i64> = guild_channels.iter().map(|(_, guild_id)| *guild_id).collect();
    guild_ids.sort_unstable();
    guild_ids.dedup();
    let guild_channel_ids: Vec<i64> = guild_channels.iter().map(|(id, _)| *id).collect();
    // Only guilds the user is a member of; owner per guild.
    let guilds: Vec<(i64, i64)> =
        sqlx::query_as("SELECT g.id, g.owner_id FROM guilds g JOIN guild_members m ON m.guild_id = g.id AND m.user_id = $1 WHERE g.id = ANY($2)")
            .bind(user_id)
            .bind(&guild_ids)
            .fetch_all(&state.db)
            .await?;
    let member_role_rows: Vec<(i64, i64)> = sqlx::query_as("SELECT guild_id, role_id FROM member_roles WHERE user_id = $1 AND guild_id = ANY($2)")
        .bind(user_id)
        .bind(&guild_ids)
        .fetch_all(&state.db)
        .await?;
    let role_rows: Vec<(i64, i64, i64)> =
        sqlx::query_as("SELECT guild_id, id, permissions FROM roles WHERE guild_id = ANY($1)").bind(&guild_ids).fetch_all(&state.db).await?;
    let overwrite_rows: Vec<(i64, i64, i16, i64, i64)> =
        sqlx::query_as("SELECT channel_id, target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = ANY($1)")
            .bind(&guild_channel_ids)
            .fetch_all(&state.db)
            .await?;
    let mut roles_by_guild: HashMap<i64, HashMap<i64, u64>> = HashMap::new();
    for (guild_id, id, permissions) in role_rows {
        roles_by_guild.entry(guild_id).or_default().insert(id, permissions as u64);
    }
    let mut member_roles: HashMap<i64, Vec<i64>> = HashMap::new();
    for (guild_id, role_id) in member_role_rows {
        member_roles.entry(guild_id).or_default().push(role_id);
    }
    let mut overwrites: HashMap<i64, Vec<Overwrite>> = HashMap::new();
    for (channel_id, target_id, target_type, allow, deny) in overwrite_rows {
        overwrites.entry(channel_id).or_default().push(Overwrite { target_id, target_type, allow: allow as u64, deny: deny as u64 });
    }
    let owners: HashMap<i64, i64> = guilds.into_iter().collect();
    let no_roles = HashMap::new();
    for (channel_id, guild_id) in guild_channels {
        let Some(owner_id) = owners.get(&guild_id) else { continue };
        let roles = member_roles.get(&guild_id).map(Vec::as_slice).unwrap_or(&[]);
        let base = base_permissions(guild_id, *owner_id, user_id, roles_by_guild.get(&guild_id).unwrap_or(&no_roles), roles);
        let channel_overwrites = overwrites.get(&channel_id).map(Vec::as_slice).unwrap_or(&[]);
        if channel_permissions(base, guild_id, user_id, roles, channel_overwrites) & VIEW_CHANNEL != 0 {
            visible.insert(channel_id);
        }
    }
    Ok(visible)
}

/// Everyone who may see the channel: DM recipients, or guild members with VIEW_CHANNEL after overwrites. A thread is seen by
/// everyone who sees its parent, private ones only by their members and holders of MANAGE_THREADS.
pub async fn channel_viewers(state: &AppState, channel: &ChannelRow) -> ApiResult<Vec<i64>> {
    if channel.is_dm() {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM channel_recipients WHERE channel_id = $1").bind(channel.id).fetch_all(&state.db).await?;
        return Ok(rows.into_iter().map(|(id,)| id).collect());
    }
    if channel.is_thread() {
        return threads::thread_viewers(state, channel).await;
    }
    Ok(viewer_permissions(state, channel).await?.into_iter().map(|(user_id, _)| user_id).collect())
}

/// Guild members who can see a (non-thread) guild channel, with their permissions in it.
pub async fn viewer_permissions(state: &AppState, channel: &ChannelRow) -> ApiResult<Vec<(i64, u64)>> {
    let Some(guild_id) = channel.guild_id else { return Ok(Vec::new()) };
    let owner: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1").bind(guild_id).fetch_optional(&state.db).await?;
    let Some((owner_id,)) = owner else { return Ok(Vec::new()) };
    let role_permissions = role_permissions(state, guild_id).await?;
    let overwrites = overwrites_for(state, channel.id).await?;
    let (members, roles) = guild_members_with_roles(state, guild_id).await?;
    let timed_out: Vec<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND timeout_until > now()").bind(guild_id).fetch_all(&state.db).await?;
    let timed_out: std::collections::HashSet<i64> = timed_out.into_iter().map(|(id,)| id).collect();
    Ok(members
        .into_iter()
        .filter_map(|user_id| {
            let member_roles = roles.get(&user_id).map(Vec::as_slice).unwrap_or(&[]);
            let base = base_permissions(guild_id, owner_id, user_id, &role_permissions, member_roles);
            let resolved = channel_permissions(base, guild_id, user_id, member_roles, &overwrites);
            // A timed-out member keeps only view + history (the owner is never clamped), so e.g. MANAGE_THREADS does not apply.
            let permissions = if owner_id == user_id { resolved } else { clamp_timeout(resolved, timed_out.contains(&user_id)) };
            (permissions & VIEW_CHANNEL != 0).then_some((user_id, permissions))
        })
        .collect())
}

/// Guild members whose guild-wide permissions (timeouts applied, as in `guild_access`) include `bit`; a few queries for the whole guild.
pub async fn members_with_permission(state: &AppState, guild_id: i64, bit: u64) -> ApiResult<Vec<i64>> {
    let owner: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1").bind(guild_id).fetch_optional(&state.db).await?;
    let Some((owner_id,)) = owner else { return Ok(Vec::new()) };
    let role_permissions = role_permissions(state, guild_id).await?;
    let (members, roles) = guild_members_with_roles(state, guild_id).await?;
    let timed_out: Vec<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND timeout_until > now()").bind(guild_id).fetch_all(&state.db).await?;
    let timed_out: std::collections::HashSet<i64> = timed_out.into_iter().map(|(id,)| id).collect();
    Ok(members
        .into_iter()
        .filter(|user_id| {
            let member_roles = roles.get(user_id).map(Vec::as_slice).unwrap_or(&[]);
            let base = base_permissions(guild_id, owner_id, *user_id, &role_permissions, member_roles);
            let permissions = if owner_id == *user_id { base } else { clamp_timeout(base, timed_out.contains(user_id)) };
            permissions & bit != 0
        })
        .collect())
}

pub async fn guild_members_with_roles(state: &AppState, guild_id: i64) -> ApiResult<(Vec<i64>, HashMap<i64, Vec<i64>>)> {
    let members: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1").bind(guild_id).fetch_all(&state.db).await?;
    let role_rows: Vec<(i64, i64)> =
        sqlx::query_as("SELECT user_id, role_id FROM member_roles WHERE guild_id = $1").bind(guild_id).fetch_all(&state.db).await?;
    let mut roles: HashMap<i64, Vec<i64>> = HashMap::new();
    for (user_id, role_id) in role_rows {
        roles.entry(user_id).or_default().push(role_id);
    }
    Ok((members.into_iter().map(|(id,)| id).collect(), roles))
}

pub async fn guild_member_ids(state: &AppState, guild_id: i64) -> ApiResult<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1").bind(guild_id).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Guild channels `user_id` can see (VIEW_CHANNEL after overwrites), ordered by position. Threads are never listed here.
pub async fn visible_guild_channels(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<Vec<ChannelRow>> {
    Ok(guild_channels_with_permissions(state, user_id, guild_id)
        .await?
        .into_iter()
        .filter(|(_, permissions)| permissions & VIEW_CHANNEL != 0)
        .map(|(row, _)| row)
        .collect())
}

/// Every non-thread channel of the guild with what `user_id` may do in it (0 when it is hidden), ordered by position.
pub async fn guild_channels_with_permissions(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<Vec<(ChannelRow, u64)>> {
    let guild = guild_access(state, user_id, guild_id).await?;
    guild_channels_resolved(state, user_id, guild_id, &guild).await
}

/// `guild_channels_with_permissions` for a caller whose `GuildAccess` is already loaded.
pub async fn guild_channels_resolved(state: &AppState, user_id: i64, guild_id: i64, guild: &GuildAccess) -> ApiResult<Vec<(ChannelRow, u64)>> {
    let rows: Vec<ChannelRow> =
        sqlx::query_as(&format!("SELECT {} FROM channels WHERE guild_id = $1 AND kind NOT IN (10, 11, 12) ORDER BY position, id", store::CHANNEL_COLS))
            .bind(guild_id)
            .fetch_all(&state.db)
            .await?;
    let overwrite_rows: Vec<(i64, i64, i16, i64, i64)> = sqlx::query_as(
        "SELECT o.channel_id, o.target_id, o.target_type, o.allow, o.deny FROM permission_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = $1",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    let mut by_channel: HashMap<i64, Vec<Overwrite>> = HashMap::new();
    for (channel_id, target_id, target_type, allow, deny) in overwrite_rows {
        by_channel.entry(channel_id).or_default().push(Overwrite { target_id, target_type, allow: allow as u64, deny: deny as u64 });
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let overwrites = by_channel.get(&row.id).map(Vec::as_slice).unwrap_or(&[]);
            let resolved = channel_permissions(guild.permissions, guild_id, user_id, &guild.roles, overwrites);
            let permissions = if guild.owner_id == user_id { resolved } else { clamp_timeout(resolved, guild.timed_out) };
            (row, permissions)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vokko_protocol::api::permissions::*;

    const GUILD: i64 = 1;
    const OWNER: i64 = 2;
    const USER: i64 = 3;
    const MOD_ROLE: i64 = 10;

    fn roles() -> HashMap<i64, u64> {
        HashMap::from([(GUILD, DEFAULT_EVERYONE), (MOD_ROLE, MANAGE_MESSAGES)])
    }

    #[test]
    fn owner_and_admin_have_everything() {
        assert_eq!(base_permissions(GUILD, OWNER, OWNER, &roles(), &[]), ALL);
        let mut with_admin = roles();
        with_admin.insert(11, ADMINISTRATOR);
        assert_eq!(base_permissions(GUILD, OWNER, USER, &with_admin, &[11]), ALL);
    }

    #[test]
    fn everyone_plus_roles() {
        let base = base_permissions(GUILD, OWNER, USER, &roles(), &[MOD_ROLE]);
        assert_eq!(base, DEFAULT_EVERYONE | MANAGE_MESSAGES);
        assert_eq!(base_permissions(GUILD, OWNER, USER, &roles(), &[]), DEFAULT_EVERYONE);
    }

    #[test]
    fn overwrite_order_everyone_roles_member() {
        let base = DEFAULT_EVERYONE;
        let deny_everyone = Overwrite { target_id: GUILD, target_type: 0, allow: 0, deny: SEND_MESSAGES };
        let allow_role = Overwrite { target_id: MOD_ROLE, target_type: 0, allow: SEND_MESSAGES, deny: 0 };
        let deny_member = Overwrite { target_id: USER, target_type: 1, allow: 0, deny: ADD_REACTIONS };
        let denied = channel_permissions(base, GUILD, USER, &[], std::slice::from_ref(&deny_everyone));
        assert_eq!(denied & SEND_MESSAGES, 0);
        let regained = channel_permissions(base, GUILD, USER, &[MOD_ROLE], &[deny_everyone.clone(), allow_role]);
        assert_ne!(regained & SEND_MESSAGES, 0);
        let member_denied = channel_permissions(base, GUILD, USER, &[], &[deny_member]);
        assert_eq!(member_denied & ADD_REACTIONS, 0);
        assert_ne!(member_denied & SEND_MESSAGES, 0);
    }

    fn overwrite(target_id: i64, target_type: i16, allow: u64, deny: u64) -> Overwrite {
        Overwrite { target_id, target_type, allow, deny }
    }

    /// (case, base, member roles, overwrites, expected)
    #[test]
    fn resolution_order_table() {
        let role_a = 20;
        let role_b = 21;
        let ow = overwrite;
        type Case = (&'static str, i64, u64, Vec<i64>, Vec<Overwrite>, u64);
        let cases: Vec<Case> = vec![
            // administrators and the owner skip overwrites entirely
            ("admin ignores a hiding overwrite", USER, ADMINISTRATOR | VIEW_CHANNEL, vec![], vec![ow(GUILD, 0, 0, VIEW_CHANNEL | SEND_MESSAGES)], ALL),
            ("owner ignores a hiding overwrite", OWNER, 0, vec![], vec![ow(GUILD, 0, 0, VIEW_CHANNEL), ow(OWNER, 1, 0, VIEW_CHANNEL)], ALL),
            // @everyone overwrite: deny then allow
            ("everyone deny", USER, DEFAULT_EVERYONE, vec![], vec![ow(GUILD, 0, 0, SEND_MESSAGES)], DEFAULT_EVERYONE & !SEND_MESSAGES),
            ("everyone allow beats its own deny", USER, DEFAULT_EVERYONE, vec![], vec![ow(GUILD, 0, SEND_MESSAGES, SEND_MESSAGES)], DEFAULT_EVERYONE),
            // roles: all denies are removed, then all allows are added
            (
                "role allow beats another role's deny",
                USER,
                DEFAULT_EVERYONE,
                vec![role_a, role_b],
                vec![ow(role_a, 0, 0, ATTACH_FILES), ow(role_b, 0, ATTACH_FILES, 0)],
                DEFAULT_EVERYONE,
            ),
            (
                "role overwrite beats @everyone overwrite",
                USER,
                DEFAULT_EVERYONE,
                vec![role_a],
                vec![ow(GUILD, 0, 0, SEND_MESSAGES), ow(role_a, 0, SEND_MESSAGES, 0)],
                DEFAULT_EVERYONE,
            ),
            ("roles the member lacks are ignored", USER, DEFAULT_EVERYONE, vec![], vec![ow(role_a, 0, 0, SEND_MESSAGES)], DEFAULT_EVERYONE),
            // member overwrite wins over every role layer
            (
                "member allow beats role deny",
                USER,
                DEFAULT_EVERYONE,
                vec![role_a],
                vec![ow(role_a, 0, 0, SEND_MESSAGES), ow(USER, 1, SEND_MESSAGES, 0)],
                DEFAULT_EVERYONE,
            ),
            (
                "member deny beats role allow",
                USER,
                DEFAULT_EVERYONE,
                vec![role_a],
                vec![ow(role_a, 0, ADD_REACTIONS, 0), ow(USER, 1, 0, ADD_REACTIONS)],
                DEFAULT_EVERYONE & !ADD_REACTIONS,
            ),
            ("overwrite of another member is ignored", USER, DEFAULT_EVERYONE, vec![], vec![ow(99, 1, 0, SEND_MESSAGES)], DEFAULT_EVERYONE),
            // overwrites can grant what the base lacks
            ("allow adds a bit the base lacks", USER, VIEW_CHANNEL, vec![role_a], vec![ow(role_a, 0, MANAGE_MESSAGES, 0)], VIEW_CHANNEL | MANAGE_MESSAGES),
            // no VIEW_CHANNEL: nothing is usable
            ("hidden channel resolves to nothing", USER, DEFAULT_EVERYONE, vec![], vec![ow(GUILD, 0, 0, VIEW_CHANNEL)], 0),
        ];
        for (name, user, base, member_roles, overwrites, expected) in cases {
            let resolved = if user == OWNER {
                channel_permissions(
                    base_permissions(GUILD, OWNER, user, &HashMap::from([(GUILD, base)]), &member_roles),
                    GUILD,
                    user,
                    &member_roles,
                    &overwrites,
                )
            } else {
                channel_permissions(base, GUILD, user, &member_roles, &overwrites)
            };
            assert_eq!(resolved, expected, "{name}");
        }
    }

    #[test]
    fn overwrites_cannot_grant_administrator() {
        let allow_admin = |target_id, target_type| overwrite(target_id, target_type, ADMINISTRATOR | SEND_MESSAGES, 0);
        for overwrites in [vec![allow_admin(GUILD, 0)], vec![allow_admin(20, 0)], vec![allow_admin(USER, 1)]] {
            let resolved = channel_permissions(VIEW_CHANNEL, GUILD, USER, &[20], &overwrites);
            assert_eq!(resolved & ADMINISTRATOR, 0);
            assert_ne!(resolved & SEND_MESSAGES, 0, "the rest of the allow still applies");
        }
    }

    #[test]
    fn timeout_clamps_everyone_but_admins() {
        assert_eq!(clamp_timeout(DEFAULT_EVERYONE, true), VIEW_CHANNEL | READ_MESSAGE_HISTORY);
        assert_eq!(clamp_timeout(DEFAULT_EVERYONE, false), DEFAULT_EVERYONE);
        assert_eq!(clamp_timeout(ALL, true), ALL);
    }

    #[test]
    fn role_ranking_and_moderation_hierarchy() {
        let everyone = RoleRank { id: GUILD, position: 0, everyone: true };
        let low = RoleRank { id: 30, position: 1, everyone: false };
        let high = RoleRank { id: 31, position: 5, everyone: false };
        let older_tie = RoleRank { id: 20, position: 5, everyone: false };
        assert_eq!(compare_roles(&high, &low), Ordering::Greater);
        assert_eq!(compare_roles(&low, &everyone), Ordering::Greater, "@everyone is always lowest");
        assert_eq!(compare_roles(&older_tie, &high), Ordering::Greater, "same position: the older snowflake ranks higher");
        assert_eq!(highest_role(&[low, high, everyone]), Some(high));
        assert_eq!(highest_role(&[]), None);

        assert!(can_act_on(true, false, &[], &[high]), "owner acts on anyone");
        assert!(!can_act_on(true, true, &[], &[]), "nobody acts on the owner");
        assert!(!can_act_on(false, true, &[high], &[]), "not on the owner");
        assert!(can_act_on(false, false, &[high], &[low]));
        assert!(!can_act_on(false, false, &[low], &[high]));
        assert!(!can_act_on(false, false, &[high], &[high]), "equal rank cannot act");
        assert!(can_act_on(false, false, &[low], &[]), "a member without roles can be acted on");
        assert!(!can_act_on(false, false, &[], &[low]));
    }

    #[test]
    fn hidden_channel_grants_nothing() {
        let hide = Overwrite { target_id: GUILD, target_type: 0, allow: 0, deny: VIEW_CHANNEL };
        assert_eq!(channel_permissions(DEFAULT_EVERYONE, GUILD, USER, &[], std::slice::from_ref(&hide)), 0);
        assert_eq!(channel_permissions(ALL, GUILD, OWNER, &[], &[hide]), ALL);
    }
}
