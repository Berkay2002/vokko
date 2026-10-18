//! Bots acting for the member who asked (docs/design/bot-control.md §9). A bot is never in a call itself: on the media routes it
//! sends `X-Vokko-Acting-For: <message_id>`, naming a fresh message in which a person asked it for something, and the request then
//! runs as that person, with exactly their rights, limits, voice state and Stremio account.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, MatchedPath, RawPathParams};
use axum::http::request::Parts;
use vokko_protocol::api::ChannelType;

use crate::access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::parse_id;
use crate::state::AppState;
use crate::store;
use crate::stremio::lock;

pub const ACTING_FOR: &str = "x-vokko-acting-for";
/// A message older than this no longer lets a bot act for its author.
const MAX_AGE: Duration = Duration::from_secs(10 * 60);
/// Acting requests one message allows, so a looping model cannot spam the call.
pub const MAX_PER_MESSAGE: u32 = 30;

/// Whose request this is: the caller, or, for a bot with a valid `X-Vokko-Acting-For`, the member it acts for (`via_bot` = the bot).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Actor {
    pub user_id: i64,
    pub via_bot: Option<i64>,
}

impl From<i64> for Actor {
    fn from(user_id: i64) -> Self {
        Self { user_id, via_bot: None }
    }
}

/// Acting requests per message and when the message was first used.
// ponytail: in memory, per process; a restart resets the counts (the 10 minute window still bounds every message).
static USES: LazyLock<Mutex<HashMap<i64, (u32, Instant)>>> = LazyLock::new(Mutex::default);

fn count_use(message_id: i64) -> ApiResult<()> {
    let mut uses = lock(&USES);
    uses.retain(|_, (_, first)| first.elapsed() < MAX_AGE);
    let (count, first) = uses.entry(message_id).or_insert((0, Instant::now()));
    if *count >= MAX_PER_MESSAGE {
        return Err(ApiErr::rate_limited(MAX_AGE.saturating_sub(first.elapsed()).as_secs_f64()));
    }
    *count += 1;
    Ok(())
}

impl FromRequestParts<AppState> for Actor {
    type Rejection = ApiErr;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let AuthUser(caller) = AuthUser::from_request_parts(parts, state).await?;
        let Some(header) = parts.headers.get(ACTING_FOR) else { return Ok(Self::from(caller)) };
        let message_id = header.to_str().ok().and_then(|raw| parse_id(raw.trim())).ok_or_else(ApiErr::missing_permissions)?;
        // `/channels/{id}/...`: the channel the request acts on; it must be where the member asked.
        let on_channel = parts.extensions.get::<MatchedPath>().is_some_and(|path| path.as_str().trim_start_matches("/api/v1").starts_with("/channels/{id}"));
        let target = match on_channel {
            true => {
                let params = RawPathParams::from_request_parts(parts, state).await.map_err(|_| ApiErr::missing_permissions())?;
                let raw = params.iter().find(|(key, _)| *key == "id").map(|(_, value)| value.to_owned());
                Some(raw.and_then(|raw| parse_id(&raw)).ok_or_else(ApiErr::missing_permissions)?)
            }
            false => None,
        };
        let member = asker(state, caller, message_id, target).await?;
        count_use(message_id)?;
        Ok(Self { user_id: member, via_bot: Some(caller) })
    }
}

/// The author of `message_id` if the bot `bot` may act for them (else 403 50013): the message exists, is a person's own
/// message (not a bot's, a webhook's or a system message), at most 10 minutes old, addressed to the bot (mentions it, replies to
/// it, or is in a DM with it), both can still see its channel, and `target` (the channel acted on) is that channel or one of its guild.
async fn asker(state: &AppState, bot: i64, message_id: i64, target: Option<i64>) -> ApiResult<i64> {
    // The caller is a bot, the author a person other than it, and the message mentions the bot, replies to it, or is in a 1:1 DM with it.
    let row: Option<(i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT m.channel_id, m.author_id, c.guild_id \
         FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users a ON a.id = m.author_id JOIN users b ON b.id = $2 \
         WHERE m.id = $1 AND m.webhook_id IS NULL AND m.kind IN (0, 19) AND m.created_at > now() - make_interval(secs => $3) \
         AND b.bot AND NOT a.bot AND m.author_id <> $2 \
         AND (EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = $2) \
              OR EXISTS (SELECT 1 FROM messages r WHERE r.id = m.reference_message_id AND r.channel_id = m.channel_id AND r.author_id = $2) \
              OR (c.kind = $4 AND EXISTS (SELECT 1 FROM channel_recipients cr WHERE cr.channel_id = m.channel_id AND cr.user_id = $2)))",
    )
    .bind(message_id)
    .bind(bot)
    .bind(MAX_AGE.as_secs_f64())
    .bind(ChannelType::Dm as i16)
    .fetch_optional(&state.db)
    .await?;
    let Some((channel_id, author, guild_id)) = row else { return Err(ApiErr::missing_permissions()) };
    if access::channel_access(state, bot, channel_id).await.is_err() || access::channel_access(state, author, channel_id).await.is_err() {
        return Err(ApiErr::missing_permissions());
    }
    if let Some(target) = target.filter(|target| *target != channel_id) {
        let target_guild = store::channel_row(state, target).await?.and_then(|row| row.guild_id);
        // The bot must see the channel it acts on too, or it could read a hidden call's queue into the channel it was asked in.
        if guild_id.is_none() || target_guild != guild_id || access::channel_access(state, bot, target).await.is_err() {
            return Err(ApiErr::missing_permissions());
        }
    }
    Ok(author)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_allows_thirty_uses() {
        let message = i64::MAX - 1;
        for _ in 0..MAX_PER_MESSAGE {
            assert!(count_use(message).is_ok());
        }
        assert!(count_use(message).is_err());
        assert!(count_use(message - 1).is_ok(), "another message has its own count");
    }
}
