//! Who controls media in a call (docs/design/bot-control.md): the shared rules of Watch Together, Stremio and Spotify. A
//! controller is someone in the call who is in a DM call, holds CONTROL_MEDIA in the channel, or is the session's host; everyone
//! else in the call votes to skip, skips what they added, and queues up to a per-user quota.
use vokko_protocol::api::permissions::CONTROL_MEDIA;
use vokko_protocol::api::{ChannelType, MediaControl, Snowflake, skip_needed};

use super::state::VoiceEntry;
use crate::acting::Actor;
use crate::error::{ApiErr, ApiResult};
use crate::extract::parse_id;
use crate::state::AppState;
use crate::store;

/// A caller who is in the call right now, with what they may do in its channel.
pub(crate) struct InVoice {
    pub channel_id: i64,
    pub user_id: i64,
    pub is_dm: bool,
    pub permissions: u64,
}

/// The caller, if they are connected to the channel's voice right now and would still be admitted to it: the voice join path's
/// checks run again (VIEW_CHANNEL + CONNECT and not timed out in a guild; still a recipient and not blocked in a DM call), so
/// someone who lost access while connected cannot keep steering. Else 403, like a missing permission.
pub(crate) async fn in_voice(state: &AppState, user_id: i64, raw: &str) -> ApiResult<InVoice> {
    let id = parse_id(raw).ok_or_else(ApiErr::unknown_channel)?;
    if !super::state::in_channel(state, user_id, id) {
        return Err(ApiErr::missing_permissions());
    }
    let row = store::channel_row(state, id).await?.ok_or_else(ApiErr::missing_permissions)?;
    if row.channel_type() == ChannelType::GuildStage {
        return Err(ApiErr::wrong_channel_type());
    }
    let admitted = if row.is_dm() { super::state::admit_dm(state, user_id, &row).await } else { super::state::admit_guild(state, user_id, &row).await };
    let (_, permissions) = admitted.map_err(|_| ApiErr::missing_permissions())?;
    Ok(InVoice { channel_id: id, user_id, is_dm: row.is_dm(), permissions })
}

/// Whether the caller controls a session whose host is `host_id`.
pub(crate) fn controls(ctx: &InVoice, host_id: Snowflake) -> bool {
    ctx.is_dm || ctx.permissions & CONTROL_MEDIA != 0 || ctx.user_id == host_id.db()
}

/// 403 50013 unless the caller controls the session.
pub(crate) fn require_control(ctx: &InVoice, control: &MediaControl) -> ApiResult<()> {
    if controls(ctx, control.host_id) { Ok(()) } else { Err(ApiErr::missing_permissions()) }
}

/// Who is in a channel's call, earliest joiner first.
pub(crate) struct Room {
    inside: Vec<VoiceEntry>,
}

pub(crate) fn room(state: &AppState, channel_id: i64) -> Room {
    let mut inside: Vec<VoiceEntry> = state.voice.all().into_iter().filter(|entry| entry.channel_id == channel_id).collect();
    inside.sort_by_key(|entry| (entry.connected_at, entry.user_id));
    Room { inside }
}

impl Room {
    pub fn is_empty(&self) -> bool {
        self.inside.is_empty()
    }

    /// People in the call who can hear it (neither self- nor server-deafened). Deliberately not everyone in the call: a deafened
    /// person cannot vote (their vote goes), so counting them would let an AFK, deafened majority block every skip. A controller
    /// can always skip, and undeafening puts someone back in the count.
    fn listeners(&self) -> impl Iterator<Item = i64> + '_ {
        self.inside.iter().filter(|entry| !entry.self_deaf && !entry.deaf).map(|entry| entry.user_id)
    }
}

/// A new session: the caller hosts it and added its first item.
pub(crate) fn new_session(actor: Actor, room: &Room) -> MediaControl {
    MediaControl {
        host_id: Snowflake::from(actor.user_id),
        added_by: Some(Snowflake::from(actor.user_id)),
        via_bot_id: actor.via_bot.map(Snowflake::from),
        skip_votes: Vec::new(),
        skip_needed: skip_needed(room.listeners().count()),
        item_seq: 0,
    }
}

/// The current item changed: its votes go and `added_by` names whoever put it in play.
pub(crate) fn new_item(control: &mut MediaControl, added_by: Option<Actor>) {
    control.skip_votes.clear();
    control.added_by = added_by.map(|actor| Snowflake::from(actor.user_id));
    control.via_bot_id = added_by.and_then(|actor| actor.via_bot).map(Snowflake::from);
    control.item_seq = control.item_seq.wrapping_add(1);
}

/// Brings `control` in line with who is in the call: a host who left is replaced by the earliest joiner, the votes of people who
/// left or deafened go, and `skip_needed` is counted again. Returns whether the remaining votes skip the current item.
pub(crate) fn sync(control: &mut MediaControl, room: &Room) -> bool {
    if !room.inside.iter().any(|entry| entry.user_id == control.host_id.db())
        && let Some(first) = room.inside.first()
    {
        control.host_id = Snowflake::from(first.user_id);
    }
    let listeners: Vec<i64> = room.listeners().collect();
    control.skip_votes.retain(|voter| listeners.contains(&voter.db()));
    control.skip_needed = skip_needed(listeners.len());
    !control.skip_votes.is_empty() && control.skip_votes.len() as u32 >= control.skip_needed
}

/// `skip: true|false` from the caller, for the item `item_seq` names (any when `None`; another one: nothing happens). A
/// controller, or whoever added the current item, skips at once (`false` does nothing); anyone else votes or withdraws their
/// vote. Returns whether the item is skipped now.
pub(crate) fn skip_request(control: &mut MediaControl, ctx: &InVoice, skip: bool, item_seq: Option<u64>, room: &Room) -> bool {
    if item_seq.is_some_and(|seq| seq != control.item_seq) {
        return false;
    }
    let me = Snowflake::from(ctx.user_id);
    if controls(ctx, control.host_id) || control.added_by == Some(me) {
        return skip;
    }
    control.skip_votes.retain(|voter| *voter != me);
    if skip {
        control.skip_votes.push(me);
    }
    sync(control, room)
}

/// How many more entries the caller may queue: unbounded for a controller, else what is left of `per_user` given the `mine`
/// entries they already have (400 50035 `queue_add` when none).
pub(crate) fn quota(ctx: &InVoice, control: &MediaControl, mine: usize, per_user: usize) -> ApiResult<usize> {
    if controls(ctx, control.host_id) {
        return Ok(usize::MAX);
    }
    match per_user.saturating_sub(mine) {
        0 => Err(ApiErr::invalid("queue_add", &format!("You can have at most {per_user} entries in the queue at once."))),
        left => Ok(left),
    }
}

/// Someone joined, left, or (un)deafened in `channel_id`: each media session there moves its host, drops lost votes, counts
/// again and skips when the votes now suffice. Spawned: a skip can start the next Stremio item, which waits on the network. Each
/// takes the call's snapshot under its session's lock, so refreshes that run out of order still count who is in the call now.
pub(crate) fn refresh(state: &AppState, channel_id: i64) {
    let state = state.clone();
    tokio::spawn(async move {
        super::watch::refresh(&state, channel_id).await;
        super::stremio::refresh(&state, channel_id).await;
        super::spotify::refresh(&state, channel_id).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(user_id: i64, permissions: u64) -> InVoice {
        InVoice { channel_id: 1, user_id, is_dm: false, permissions }
    }

    #[test]
    fn controllers_are_dm_callers_holders_of_the_bit_and_the_host() {
        let host = Snowflake::from(7);
        assert!(controls(&ctx(7, 0), host));
        assert!(controls(&ctx(8, CONTROL_MEDIA), host));
        assert!(!controls(&ctx(8, 0), host));
        assert!(controls(&InVoice { is_dm: true, ..ctx(8, 0) }, host));
    }

    #[test]
    fn the_quota_binds_only_non_controllers() {
        let control = MediaControl { host_id: Snowflake::from(7), ..MediaControl::default() };
        assert_eq!(quota(&ctx(7, 0), &control, 50, 3).ok(), Some(usize::MAX));
        assert_eq!(quota(&ctx(8, 0), &control, 1, 3).ok(), Some(2));
        assert!(quota(&ctx(8, 0), &control, 3, 3).is_err());
    }

    fn entry(user_id: i64, self_deaf: bool, deaf: bool) -> VoiceEntry {
        VoiceEntry {
            guild_id: Some(1),
            channel_id: 1,
            backend: 0,
            user_id,
            session_id: String::new(),
            token_nonce: String::new(),
            issued_at: std::time::Instant::now(),
            gateway_session: None,
            self_mute: self_deaf,
            self_deaf,
            self_video: false,
            self_stream: false,
            suppress: false,
            permissions: 0,
            stage: false,
            mute: deaf,
            deaf,
            request_to_speak: None,
            connected: true,
            connected_at: time::OffsetDateTime::UNIX_EPOCH,
            unbound_since: None,
        }
    }

    #[test]
    fn deafened_people_neither_count_nor_vote() {
        // host 7 and listener 8 can hear it; 9 is self-deafened and 10 server-deafened
        let room = Room { inside: vec![entry(7, false, false), entry(8, false, false), entry(9, true, false), entry(10, false, true)] };
        let mut control = new_session(Actor::from(7), &room);
        assert_eq!(control.skip_needed, 1, "two listeners");
        assert!(!skip_request(&mut control, &ctx(9, 0), true, None, &room), "a deafened vote does not count");
        assert!(control.skip_votes.is_empty(), "and is dropped");
        assert!(!skip_request(&mut control, &ctx(10, 0), true, None, &room));
        assert!(skip_request(&mut control, &ctx(8, 0), true, None, &room), "one of two listeners skips");
        // undeafened, 9 and 10 count again: 4 listeners need 2 votes
        let room = Room { inside: vec![entry(7, false, false), entry(8, false, false), entry(9, false, false), entry(10, false, false)] };
        let mut control = new_session(Actor::from(7), &room);
        assert_eq!(control.skip_needed, 2);
        assert!(!skip_request(&mut control, &ctx(8, 0), true, None, &room));
        assert!(skip_request(&mut control, &ctx(9, 0), true, None, &room));
    }

    #[test]
    fn a_skip_for_another_item_does_nothing() {
        let mut control = MediaControl { host_id: Snowflake::from(7), item_seq: 4, ..MediaControl::default() };
        let empty = Room { inside: Vec::new() };
        assert!(!skip_request(&mut control, &ctx(7, 0), true, Some(3), &empty), "the host's skip for an old item");
        assert!(skip_request(&mut control, &ctx(7, 0), true, Some(4), &empty));
        assert!(skip_request(&mut control, &ctx(7, 0), true, None, &empty));
        new_item(&mut control, None);
        assert_eq!(control.item_seq, 5);
    }
}
