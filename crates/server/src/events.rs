//! Building gateway payloads and resolving who receives them.
use vokko_protocol::api::{Channel, GatewayEvent, GuildWithState};

use crate::access;
use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;
use crate::store::{self, ChannelRow};
use crate::threads;

/// A guild with the channels `viewer` can see, all members and the member count (READY entries and GUILD_CREATE).
pub async fn guild_with_state(state: &AppState, guild_id: i64, viewer: i64) -> ApiResult<GuildWithState> {
    let guild = store::guild(state, guild_id).await?.ok_or_else(ApiErr::unknown_guild)?;
    let rows = access::visible_guild_channels(state, viewer, guild_id).await?;
    let visible: std::collections::HashSet<i64> = rows.iter().map(|row| row.id).collect();
    let voice_states = state.voice.states_in(&visible);
    let stage_instances = crate::voice::stage::instances_in(state, guild_id, &visible).await?;
    let watch_together = state.voice.watch_in(&visible);
    let stremio = crate::voice::stremio::states_in(state, &visible);
    let channels = store::channels_to_api(state, rows, Some(viewer)).await?;
    let members = store::members(state, guild_id, 10_000, None).await?;
    let member_count = store::member_count(state, guild_id).await?;
    let stickers = crate::stickers::of_guild(state, guild_id).await?;
    let soundboard_sounds = crate::soundboard::of_guild(state, guild_id).await?;
    let thread_rows = threads::active_threads(state, viewer, guild_id).await?;
    let threads = store::channels_to_api(state, thread_rows, Some(viewer)).await?;
    let emojis = crate::emojis::guild_emojis(state, guild_id, false).await?;
    Ok(GuildWithState {
        guild,
        channels,
        members,
        member_count,
        stickers,
        soundboard_sounds,
        threads,
        emojis,
        presences: None,
        voice_states,
        stage_instances,
        watch_together,
        stremio,
    })
}

/// Sends a channel-shaped event (CREATE/UPDATE/DELETE) to everyone who can see the channel; DM recipient lists are per receiver.
pub async fn dispatch_channel(state: &AppState, row: &ChannelRow, make: fn(Channel) -> GatewayEvent) -> ApiResult<()> {
    let viewers = access::channel_viewers(state, row).await?;
    if row.is_dm() {
        for viewer in viewers {
            if let Some(channel) = store::channel(state, row.id, Some(viewer)).await? {
                state.hub.send(&[viewer], &make(channel));
            }
        }
    } else if let Some(channel) = store::channel(state, row.id, None).await? {
        state.hub.send(&viewers, &make(channel));
    }
    Ok(())
}

/// The symmetric "who shares presence with `user_id`" set, used for both directions (who receives this user's
/// PRESENCE_UPDATE / USER_UPDATE, and whose presences go into this user's READY): the user, members of shared guilds,
/// accepted friends (kind 1) and peers of DMs that are open on BOTH sides. Pending requests, blocks and DMs the other
/// side never opened (closed row) do not count, so an unsolicited DM cannot be used to track someone's presence.
pub async fn user_audience(state: &AppState, user_id: i64) -> ApiResult<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT m2.user_id FROM guild_members m1 JOIN guild_members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1 \
         UNION SELECT other_id FROM relationships WHERE user_id = $1 AND kind = 1 \
         UNION SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id \
               WHERE r1.user_id = $1 AND NOT r1.closed AND NOT r2.closed \
         UNION SELECT $1",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
