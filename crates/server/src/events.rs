//! Building gateway payloads and resolving who receives them.
use vokko_protocol::api::{Channel, GatewayEvent, GuildWithState};

use crate::access;
use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

/// A guild with the channels `viewer` can see, all members and the member count (READY entries and GUILD_CREATE).
pub async fn guild_with_state(state: &AppState, guild_id: i64, viewer: i64) -> ApiResult<GuildWithState> {
    let guild = store::guild(state, guild_id).await?.ok_or_else(ApiErr::unknown_guild)?;
    let rows = access::visible_guild_channels(state, viewer, guild_id).await?;
    let channels = store::channels_to_api(state, rows, Some(viewer)).await?;
    let members = store::members(state, guild_id, 10_000, None).await?;
    let member_count = store::member_count(state, guild_id).await?;
    Ok(GuildWithState { guild, channels, members, member_count })
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

/// Everyone who should hear about `user_id`: themselves, members of shared guilds, DM co-recipients and relationships.
pub async fn user_audience(state: &AppState, user_id: i64) -> ApiResult<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT m2.user_id FROM guild_members m1 JOIN guild_members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1 \
         UNION SELECT other_id FROM relationships WHERE user_id = $1 \
         UNION SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = $1 \
         UNION SELECT $1",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
