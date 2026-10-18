//! Presence: the status a user chose survives disconnects, `invisible` reads as offline to everyone else, and the
//! people who start or stop sharing a guild with a user are told about it. "Appear offline in this server" (per guild) makes
//! the user read as offline to everyone who knows them only through such guilds.
//!
//! `presences.preferred` is the choice (online, idle, dnd, invisible); `presences.status` is what others see now
//! (offline while nobody is connected or the user is invisible).
use std::collections::HashSet;

use vokko_protocol::api::user_settings;
use vokko_protocol::api::{Activity, GatewayEvent, Presence, PresenceStatus, Snowflake};

use crate::error::ApiResult;
use crate::events;
use crate::state::AppState;

struct Row {
    user_id: i64,
    status: String,
    preferred: String,
    custom_status: Option<String>,
    activities: Vec<Activity>,
}

/// `activities` is a JSON array kept as text.
type RawRow = (i64, String, String, Option<String>, String);

const ROW_COLUMNS: &str = "user_id, status, preferred, custom_status, activities";

impl Row {
    fn from_raw((user_id, status, preferred, custom_status, activities): RawRow) -> Self {
        Self { user_id, status, preferred, custom_status, activities: serde_json::from_str(&activities).unwrap_or_default() }
    }

    /// What `viewer` sees. The user's own sessions see the chosen status (including `invisible`), connected or not.
    /// `hidden`: the user appears offline to this viewer through a per-guild setting (see [`hidden_pairs`]).
    fn view(&self, viewer: i64, hidden: bool) -> Presence {
        let user_id = Snowflake::from(self.user_id);
        let invisible = hidden || self.preferred == "invisible";
        if viewer == self.user_id {
            let status = PresenceStatus::parse(&self.preferred).unwrap_or(PresenceStatus::Online);
            return Presence { user_id, status, custom_status: self.custom_status.clone(), activities: self.activities.clone() };
        }
        let status = if invisible { PresenceStatus::Offline } else { PresenceStatus::parse(&self.status).unwrap_or(PresenceStatus::Offline) };
        // an offline user (disconnected or invisible) shows no custom status or activity to others
        let offline = status == PresenceStatus::Offline;
        let custom_status = if offline { None } else { self.custom_status.clone() };
        let activities = if offline { Vec::new() } else { self.activities.clone() };
        Presence { user_id, status, custom_status, activities }
    }
}

async fn rows(state: &AppState, ids: &[i64]) -> ApiResult<Vec<Row>> {
    let found: Vec<RawRow> = sqlx::query_as(&format!("SELECT {ROW_COLUMNS} FROM presences WHERE user_id = ANY($1)")).bind(ids).fetch_all(&state.db).await?;
    Ok(found.into_iter().map(Row::from_raw).collect())
}

/// The effective status for a stored preference.
fn effective(preferred: &str, connected: bool) -> &str {
    if !connected || preferred == "invisible" { "offline" } else { preferred }
}

/// What a user lets others see of what they do (synced settings, Settings > Activity Privacy). This is the one decision point
/// for showing others a user's activity: a new social feature adds a key here (and to the protocol's settings allow-list)
/// that defaults to `share_activity`, so the user's general choice covers it from day one, and checks it where it fans out.
pub struct Sharing {
    /// Playing (detected games and apps) and every other activity.
    pub activity: bool,
    /// Listening on Spotify.
    pub spotify: bool,
    pub typing: bool,
    /// Mutual servers and mutual friends on the profile others open.
    pub mutuals: bool,
}

pub async fn sharing(state: &AppState, user_id: i64) -> ApiResult<Sharing> {
    let settings = crate::routes::settings::load(state, user_id).await?.settings;
    let activity = user_settings::flag(&settings, "share_activity", true);
    let flag = |key: &str| user_settings::flag(&settings, key, activity);
    // Spotify is opt-in (off until the user turns it on), so a client that sends a track unasked publishes nothing
    let spotify = activity && user_settings::flag(&settings, "share_spotify", false);
    Ok(Sharing { activity, spotify, typing: flag("share_typing"), mutuals: flag("share_mutuals") })
}

/// The settings keys of [`Sharing`]: a change to one re-applies it (`reapply_sharing`).
pub const SHARING_KEYS: &[&str] = &["share_activity", "share_spotify", "share_typing", "share_mutuals"];

impl Sharing {
    /// The activities others may see.
    fn filter(&self, list: Vec<Activity>) -> Vec<Activity> {
        if !self.activity {
            return Vec::new();
        }
        list.into_iter().filter(|activity| self.spotify || activity.kind != LISTENING).collect()
    }
}

/// Activity type of a Spotify track.
const LISTENING: u8 = 2;

/// A sharing setting changed: what was already shared and is no longer allowed goes away now, for everyone.
pub async fn reapply_sharing(state: &AppState, user_id: i64) -> ApiResult<()> {
    if refilter(state, user_id).await? { publish(state, user_id).await } else { Ok(()) }
}

/// Filters the stored activities with the current settings; true if that removed something.
async fn refilter(state: &AppState, user_id: i64) -> ApiResult<bool> {
    let Some(row) = rows(state, &[user_id]).await?.pop() else { return Ok(false) };
    let kept = sharing(state, user_id).await?.filter(row.activities.clone());
    if kept == row.activities {
        return Ok(false);
    }
    let encoded = serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_owned());
    sqlx::query("UPDATE presences SET activities = $2 WHERE user_id = $1").bind(user_id).bind(encoded).execute(&state.db).await?;
    Ok(true)
}

/// Stores a change and tells everyone who shares something with the user. `preferred` of `None` keeps the choice;
/// `connected` says whether the user has a live gateway connection after this change. `offline` is read as `invisible`.
/// `activities` of `None` keeps the current ones, `Some(vec![])` clears them.
pub async fn update(
    state: &AppState,
    user_id: i64,
    preferred: Option<PresenceStatus>,
    custom_status: Option<Option<String>>,
    activities: Option<Vec<Activity>>,
    connected: bool,
) -> ApiResult<()> {
    let preferred = preferred.map(|status| if status == PresenceStatus::Offline { PresenceStatus::Invisible } else { status }.as_str());
    let first = preferred.unwrap_or("online");
    let filtered = activities.as_ref().is_some_and(|list| !list.is_empty());
    let activities = match activities {
        Some(list) if !list.is_empty() => Some(sharing(state, user_id).await?.filter(list)),
        other => other,
    };
    let encoded = activities.as_ref().map(|list| serde_json::to_string(list).unwrap_or_else(|_| "[]".to_owned()));
    sqlx::query(
        "INSERT INTO presences (user_id, status, preferred, custom_status, activities) VALUES ($1, $2, $3, $4, COALESCE($8, '[]')) \
         ON CONFLICT (user_id) DO UPDATE SET preferred = COALESCE($5, presences.preferred), \
           custom_status = CASE WHEN $6 THEN $4 ELSE presences.custom_status END, \
           activities = COALESCE($8, presences.activities), \
           status = CASE WHEN NOT $7 OR COALESCE($5, presences.preferred) = 'invisible' THEN 'offline' \
                         ELSE COALESCE($5, presences.preferred) END",
    )
    .bind(user_id)
    .bind(effective(first, connected))
    .bind(first)
    .bind(custom_status.clone().flatten())
    .bind(preferred)
    .bind(custom_status.is_some())
    .bind(connected)
    .bind(encoded)
    .execute(&state.db)
    .await?;
    // a sharing setting may have changed (and been re-applied) between the filter above and this write
    if filtered {
        refilter(state, user_id).await?;
    }
    publish(state, user_id).await
}

/// The first connection of a user opened: the chosen status comes back. Activities start empty (the client sends its own
/// after READY), so nothing stale survives a crash.
pub async fn connected(state: &AppState, user_id: i64) -> ApiResult<()> {
    update(state, user_id, None, None, Some(Vec::new()), true).await
}

/// The last connection of a user closed: everyone sees offline and the activity is gone, the choice stays.
pub async fn disconnected(state: &AppState, user_id: i64) -> ApiResult<()> {
    update(state, user_id, None, None, Some(Vec::new()), false).await
}

/// Sends the user's current presence to everyone who shares something with them, each in their own view.
pub async fn publish(state: &AppState, user_id: i64) -> ApiResult<()> {
    let Some(row) = rows(state, &[user_id]).await?.pop() else { return Ok(()) };
    let audience = events::user_audience(state, user_id).await?;
    let hidden = hidden_pairs(state, &[user_id], &audience).await?;
    state.hub.send_with(&audience, "PRESENCE_UPDATE", |viewer| GatewayEvent::PresenceUpdate(row.view(viewer, hidden.contains(&(user_id, viewer)))).data());
    Ok(())
}

/// The (user, viewer) pairs of `users` x `viewers` where the user appears offline to the viewer through "Appear offline in
/// this server": the user set it in at least one guild, and the viewer shares nothing else with them (no other guild, no
/// friendship, no open DM the user wrote in: a message reopens a DM on both sides, so receiving one must not lift the hide).
/// Typing follows the same rule, so anything that reveals presence should check it.
pub async fn hidden_pairs(state: &AppState, users: &[i64], viewers: &[i64]) -> ApiResult<HashSet<(i64, i64)>> {
    let hiding: Vec<(i64,)> =
        sqlx::query_as("SELECT DISTINCT user_id FROM guild_appear_offline WHERE user_id = ANY($1)").bind(users).fetch_all(&state.db).await?;
    if hiding.is_empty() || viewers.is_empty() {
        return Ok(HashSet::new());
    }
    let hiding: Vec<i64> = hiding.into_iter().map(|(id,)| id).collect();
    let pairs: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT u.id, v.id FROM unnest($1::bigint[]) AS u (id) CROSS JOIN unnest($2::bigint[]) AS v (id) WHERE u.id <> v.id \
         AND NOT EXISTS (SELECT 1 FROM guild_members m1 JOIN guild_members m2 ON m2.guild_id = m1.guild_id AND m2.user_id = v.id \
               WHERE m1.user_id = u.id AND NOT EXISTS (SELECT 1 FROM guild_appear_offline h WHERE h.user_id = u.id AND h.guild_id = m1.guild_id)) \
         AND NOT EXISTS (SELECT 1 FROM relationships r WHERE r.user_id = u.id AND r.other_id = v.id AND r.kind = 1) \
         AND NOT EXISTS (SELECT 1 FROM channel_recipients r1 JOIN channel_recipients r2 ON r2.channel_id = r1.channel_id AND r2.user_id = v.id \
               WHERE r1.user_id = u.id AND NOT r1.closed AND NOT r2.closed \
               AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = r1.channel_id AND m.author_id = u.id))",
    )
    .bind(&hiding)
    .bind(viewers)
    .fetch_all(&state.db)
    .await?;
    Ok(pairs.into_iter().collect())
}

/// Who of `viewers` may see `user_id` typing in a channel of `guild_id`: nobody while the user is invisible or appears offline
/// in that guild (not even viewers who see their status through something else), and nobody the user appears offline to.
pub async fn typing_audience(state: &AppState, user_id: i64, guild_id: Option<i64>, viewers: Vec<i64>) -> ApiResult<Vec<i64>> {
    let preferred: Option<(String,)> = sqlx::query_as("SELECT preferred FROM presences WHERE user_id = $1").bind(user_id).fetch_optional(&state.db).await?;
    if preferred.is_some_and(|(preferred,)| preferred == "invisible") || !sharing(state, user_id).await?.typing {
        return Ok(Vec::new());
    }
    if let Some(guild_id) = guild_id
        && hiding_in(state, user_id, guild_id).await?
    {
        return Ok(Vec::new());
    }
    let hidden = hidden_pairs(state, &[user_id], &viewers).await?;
    Ok(viewers.into_iter().filter(|viewer| !hidden.contains(&(user_id, *viewer))).collect())
}

/// Whether `user_id` appears offline in `guild_id`.
pub async fn hiding_in(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<bool> {
    let (hiding,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM guild_appear_offline WHERE user_id = $1 AND guild_id = $2)")
        .bind(user_id)
        .bind(guild_id)
        .fetch_one(&state.db)
        .await?;
    Ok(hiding)
}

/// Presences of `ids` as `viewer` sees them (READY).
pub async fn presences_for(state: &AppState, viewer: i64, ids: &[i64]) -> ApiResult<Vec<Presence>> {
    let hidden = hidden_pairs(state, ids, &[viewer]).await?;
    Ok(rows(state, ids).await?.iter().map(|row| row.view(viewer, hidden.contains(&(row.user_id, viewer)))).collect())
}

/// The presences of a guild's members that are not offline, for the GUILD_CREATE of `viewer`.
pub async fn guild_presences(state: &AppState, guild_id: i64, viewer: i64) -> ApiResult<Vec<Presence>> {
    let found: Vec<RawRow> = sqlx::query_as(
        "SELECT p.user_id, p.status, p.preferred, p.custom_status, p.activities FROM presences p JOIN guild_members m ON m.user_id = p.user_id \
         WHERE m.guild_id = $1 AND (p.status <> 'offline' OR p.user_id = $2)",
    )
    .bind(guild_id)
    .bind(viewer)
    .fetch_all(&state.db)
    .await?;
    let rows: Vec<Row> = found.into_iter().map(Row::from_raw).collect();
    let ids: Vec<i64> = rows.iter().map(|row| row.user_id).collect();
    let hidden = hidden_pairs(state, &ids, &[viewer]).await?;
    Ok(rows.iter().map(|row| row.view(viewer, hidden.contains(&(row.user_id, viewer)))).filter(|presence| presence.status != PresenceStatus::Offline).collect())
}

/// Users who share something with `user_id` apart from membership of `guild_id`.
async fn audience_without_guild(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<HashSet<i64>> {
    let found: Vec<(i64,)> = sqlx::query_as(&format!(
        "SELECT m2.user_id FROM guild_members m1 JOIN guild_members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1 AND m1.guild_id <> $2 \
         UNION SELECT other_id FROM relationships WHERE user_id = $1 AND kind = 1 \
         UNION SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id \
               WHERE r1.user_id = $1 AND NOT r1.closed AND NOT r2.closed AND {}",
        events::DM_TAKEN_PART
    ))
    .bind(user_id)
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    Ok(found.into_iter().map(|(id,)| id).collect())
}

async fn member_ids(state: &AppState, guild_id: i64, except: i64) -> ApiResult<Vec<i64>> {
    let found: Vec<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id <> $2").bind(guild_id).bind(except).fetch_all(&state.db).await?;
    Ok(found.into_iter().map(|(id,)| id).collect())
}

/// Call after `user_id` became a member of `guild_id` (and GUILD_MEMBER_ADD went out): members who had nothing in common
/// with the user yet receive the user's presence, if it is not offline. (The joiner gets theirs through `guild_presences`.)
pub async fn announce_join(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    let Some(row) = rows(state, &[user_id]).await?.pop() else { return Ok(()) };
    let shown = row.view(0, false);
    // strangers share only this guild with the user, so "Appear offline" here (kept from an earlier membership) hides them
    if shown.status == PresenceStatus::Offline || hiding_in(state, user_id, guild_id).await? {
        return Ok(());
    }
    let known = audience_without_guild(state, user_id, guild_id).await?;
    let strangers: Vec<i64> = member_ids(state, guild_id, user_id).await?.into_iter().filter(|id| !known.contains(id)).collect();
    state.hub.send(&strangers, &GatewayEvent::PresenceUpdate(shown));
    Ok(())
}

/// Call after `user_id` stopped being a member of `guild_id` (leave, kick, ban, guild already updated): everyone who
/// shares nothing with them any more sees them offline, and they see those people offline, so no stale presence stays.
pub async fn announce_leave(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<()> {
    announce_parted(state, user_id, &member_ids(state, guild_id, user_id).await?).await
}

/// Call after `user_id` stopped sharing a guild or group DM with `former` (already updated in the database): the same
/// clean-up as [`announce_leave`].
pub async fn announce_parted(state: &AppState, user_id: i64, former: &[i64]) -> ApiResult<()> {
    let still_shared: HashSet<i64> = events::user_audience(state, user_id).await?.into_iter().collect();
    let (shared, strangers): (Vec<i64>, Vec<i64>) = former.iter().copied().filter(|id| *id != user_id).partition(|id| still_shared.contains(id));
    state.hub.send(&strangers, &offline(user_id));
    for id in strangers {
        state.hub.send(&[user_id], &offline(id));
    }
    // those who still share something may now share only guilds where one of the two appears offline
    let mut hidden = hidden_pairs(state, &[user_id], &shared).await?;
    hidden.extend(hidden_pairs(state, &shared, &[user_id]).await?);
    for (user, viewer) in hidden {
        state.hub.send(&[viewer], &offline(user));
    }
    Ok(())
}

fn offline(id: i64) -> GatewayEvent {
    GatewayEvent::PresenceUpdate(Presence { user_id: Snowflake::from(id), status: PresenceStatus::Offline, custom_status: None, activities: Vec::new() })
}

/// Call after `a` and `b` stopped sharing something (a guild, a friendship): whoever of the two now appears offline to the
/// other through "Appear offline in this server" is shown offline, so no stale presence stays.
pub async fn hide_where_hidden(state: &AppState, a: i64, b: i64) -> ApiResult<()> {
    for (user, viewer) in hidden_pairs(state, &[a, b], &[a, b]).await? {
        state.hub.send(&[viewer], &offline(user));
    }
    Ok(())
}
