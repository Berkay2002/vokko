//! Presence: the status a user chose survives disconnects, `invisible` reads as offline to everyone else, and the
//! people who start or stop sharing a guild with a user are told about it.
//!
//! `presences.preferred` is the choice (online, idle, dnd, invisible); `presences.status` is what others see now
//! (offline while nobody is connected or the user is invisible).
use std::collections::HashSet;

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
    fn view(&self, viewer: i64) -> Presence {
        let user_id = Snowflake::from(self.user_id);
        let invisible = self.preferred == "invisible";
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
    state.hub.send_with(&audience, "PRESENCE_UPDATE", |viewer| GatewayEvent::PresenceUpdate(row.view(viewer)).data());
    Ok(())
}

/// Presences of `ids` as `viewer` sees them (READY).
pub async fn presences_for(state: &AppState, viewer: i64, ids: &[i64]) -> ApiResult<Vec<Presence>> {
    Ok(rows(state, ids).await?.iter().map(|row| row.view(viewer)).collect())
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
    Ok(found.into_iter().map(Row::from_raw).map(|row| row.view(viewer)).filter(|presence| presence.status != PresenceStatus::Offline).collect())
}

/// Users who share something with `user_id` apart from membership of `guild_id`.
async fn audience_without_guild(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<HashSet<i64>> {
    let found: Vec<(i64,)> = sqlx::query_as(
        "SELECT m2.user_id FROM guild_members m1 JOIN guild_members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1 AND m1.guild_id <> $2 \
         UNION SELECT other_id FROM relationships WHERE user_id = $1 AND kind = 1 \
         UNION SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id \
               WHERE r1.user_id = $1 AND NOT r1.closed AND NOT r2.closed",
    )
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
    let shown = row.view(0);
    if shown.status == PresenceStatus::Offline {
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
    let still_shared: HashSet<i64> = events::user_audience(state, user_id).await?.into_iter().collect();
    let strangers: Vec<i64> = member_ids(state, guild_id, user_id).await?.into_iter().filter(|id| !still_shared.contains(id)).collect();
    if strangers.is_empty() {
        return Ok(());
    }
    let offline = |id: i64| {
        GatewayEvent::PresenceUpdate(Presence { user_id: Snowflake::from(id), status: PresenceStatus::Offline, custom_status: None, activities: Vec::new() })
    };
    state.hub.send(&strangers, &offline(user_id));
    for id in strangers {
        state.hub.send(&[user_id], &offline(id));
    }
    Ok(())
}
