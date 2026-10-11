//! Server mute, server deafen, move and disconnect through `PATCH /guilds/{id}/members/{uid}` (Discord's `mute`, `deaf`,
//! `channel_id` keys), plus the voice side effects of other member edits (roles, timeout).
use sqlx::{Postgres, Transaction};
use vokko_protocol::api::permissions::{DEAFEN_MEMBERS, MOVE_MEMBERS, MUTE_MEMBERS};
use vokko_protocol::api::{ChannelType, EditMemberRequest};

use super::state;
use crate::access::{GuildAccess, channel_access};
use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;
use crate::store;

/// A validated voice part of a member edit.
#[derive(Debug, Default)]
pub struct VoiceEdit {
    mute: Option<bool>,
    deaf: Option<bool>,
    /// `Some(None)` disconnects; `Some(Some(..))` moves to that channel with the member's permissions there.
    channel: Option<Option<Target>>,
}

#[derive(Debug, Clone, Copy)]
struct Target {
    channel_id: i64,
    permissions: u64,
    stage: bool,
}

/// Checks the voice keys of `body` for `actor` acting on `target` in `guild_id`; changes nothing.
pub async fn authorize(state: &AppState, actor_id: i64, actor: &GuildAccess, guild_id: i64, target: i64, body: &EditMemberRequest) -> ApiResult<VoiceEdit> {
    if body.mute.is_some() {
        actor.require(MUTE_MEMBERS)?;
    }
    if body.deaf.is_some() {
        actor.require(DEAFEN_MEMBERS)?;
    }
    let channel = match body.channel_id {
        None => None,
        Some(wanted) => {
            let current = state.voice.get(target).filter(|entry| entry.guild_id == Some(guild_id));
            let Some(current) = current else { return Err(ApiErr::conflict(40032, "Target user is not connected to voice.")) };
            channel_access(state, actor_id, current.channel_id).await?.require(MOVE_MEMBERS)?;
            match wanted {
                None => Some(None),
                Some(raw) => {
                    let row = store::channel_row(state, raw.db()).await?.filter(|row| row.guild_id == Some(guild_id));
                    let Some(row) = row else { return Err(ApiErr::invalid("channel_id", "Unknown channel.")) };
                    let stage = match row.channel_type() {
                        ChannelType::GuildVoice => false,
                        ChannelType::GuildStage => true,
                        _ => return Err(ApiErr::invalid("channel_id", "Must be a voice or stage channel.")),
                    };
                    channel_access(state, actor_id, row.id).await?.require(MOVE_MEMBERS)?;
                    // The member must be allowed to be there (VIEW_CHANNEL + CONNECT, not timed out).
                    let permissions = state::voice_permissions(state, target, guild_id, row.id).await.ok_or_else(ApiErr::missing_permissions)?;
                    Some(Some(Target { channel_id: row.id, permissions, stage }))
                }
            }
        }
    };
    Ok(VoiceEdit { mute: body.mute, deaf: body.deaf, channel })
}

impl VoiceEdit {
    /// Stores server mute / deafen inside the member edit's transaction.
    pub async fn store(&self, tx: &mut Transaction<'_, Postgres>, guild_id: i64, user_id: i64) -> ApiResult<()> {
        if self.mute.is_some() || self.deaf.is_some() {
            sqlx::query("UPDATE guild_members SET mute = COALESCE($3, mute), deaf = COALESCE($4, deaf) WHERE guild_id = $1 AND user_id = $2")
                .bind(guild_id)
                .bind(user_id)
                .bind(self.mute)
                .bind(self.deaf)
                .execute(&mut **tx)
                .await?;
        }
        Ok(())
    }

    /// After the commit: applies the edit to the member's voice state. `permissions_changed` = roles or timeout were edited.
    pub async fn apply(&self, state: &AppState, guild_id: i64, user_id: i64, permissions_changed: bool) -> ApiResult<()> {
        if permissions_changed {
            state::recompute_member(state, guild_id, user_id).await;
        }
        if self.mute.is_some() || self.deaf.is_some() {
            let flags: Option<(bool, bool)> = sqlx::query_as("SELECT mute, deaf FROM guild_members WHERE guild_id = $1 AND user_id = $2")
                .bind(guild_id)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;
            if let Some((mute, deaf)) = flags {
                state::set_server_flags(state, guild_id, user_id, mute, deaf).await;
            }
        }
        match self.channel {
            Some(None) => state::disconnect(state, guild_id, user_id).await,
            Some(Some(target)) => {
                state::move_member(state, guild_id, user_id, target.channel_id, target.permissions, target.stage).await;
            }
            None => {}
        }
        Ok(())
    }
}
