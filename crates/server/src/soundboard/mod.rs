//! Soundboard and entrance sounds (docs/api.md "Soundboard and entrance sounds"): guild sounds, the default sounds, who may
//! pick which sound, the per-channel play limit and VOICE_CHANNEL_EFFECT_SEND fan-out to the users in the voice channel.
pub mod audio;
pub mod defaults;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sqlx::FromRow;
use vokko_protocol::api::permissions::{SPEAK, USE_EXTERNAL_SOUNDS, USE_SOUNDBOARD};
use vokko_protocol::api::{EffectEmoji, EntranceSound, EntranceSounds, GatewayEvent, Snowflake, SoundboardSound, VoiceChannelEffectSend};

use crate::access;
use crate::error::{ApiErr, ApiResult};
use crate::media;
use crate::state::AppState;
use crate::store;

/// One play per user and channel in this interval.
pub const PLAY_INTERVAL: Duration = Duration::from_secs(3);

pub fn unknown_sound() -> ApiErr {
    ApiErr::new_unknown("Unknown Sound", 10097)
}

#[derive(FromRow)]
struct SoundRow {
    id: i64,
    guild_id: i64,
    name: String,
    volume: f64,
    emoji_id: Option<i64>,
    emoji_name: Option<String>,
    asset_path: String,
    creator_id: Option<i64>,
}

const COLS: &str = "id, guild_id, name, volume, emoji_id, emoji_name, asset_path, creator_id";

pub fn default_url(state: &AppState, id: i64) -> String {
    format!("{}/api/v1/soundboard-default-sounds/{id}/file", state.config.public_url)
}

fn default_to_api(state: &AppState, sound: &defaults::DefaultSound) -> SoundboardSound {
    SoundboardSound {
        sound_id: Snowflake::from(sound.id),
        name: sound.name.to_owned(),
        volume: sound.volume,
        emoji_id: None,
        emoji_name: Some(sound.emoji.to_owned()),
        guild_id: None,
        available: true,
        user: None,
        url: default_url(state, sound.id),
    }
}

pub fn default_sounds(state: &AppState) -> Vec<SoundboardSound> {
    defaults::DEFAULT_SOUNDS.iter().map(|sound| default_to_api(state, sound)).collect()
}

async fn to_api(state: &AppState, rows: Vec<SoundRow>) -> ApiResult<Vec<SoundboardSound>> {
    let mut creators: Vec<i64> = rows.iter().filter_map(|row| row.creator_id).collect();
    creators.sort_unstable();
    creators.dedup();
    let users = store::users(state, &creators).await?;
    Ok(rows
        .into_iter()
        .map(|row| SoundboardSound {
            sound_id: Snowflake::from(row.id),
            name: row.name,
            volume: row.volume,
            emoji_id: row.emoji_id.map(Snowflake::from),
            emoji_name: row.emoji_name,
            guild_id: Some(Snowflake::from(row.guild_id)),
            available: true,
            user: row.creator_id.and_then(|id| users.get(&id).cloned()),
            url: state.asset_url(&row.asset_path),
        })
        .collect())
}

/// Sounds of the given guilds, oldest first.
pub async fn of_guilds(state: &AppState, guild_ids: &[i64]) -> ApiResult<HashMap<i64, Vec<SoundboardSound>>> {
    let rows: Vec<SoundRow> =
        sqlx::query_as(&format!("SELECT {COLS} FROM soundboard_sounds WHERE guild_id = ANY($1) ORDER BY id")).bind(guild_ids).fetch_all(&state.db).await?;
    let mut map: HashMap<i64, Vec<SoundboardSound>> = HashMap::new();
    for sound in to_api(state, rows).await? {
        if let Some(guild_id) = sound.guild_id {
            map.entry(guild_id.db()).or_default().push(sound);
        }
    }
    Ok(map)
}

pub async fn of_guild(state: &AppState, guild_id: i64) -> ApiResult<Vec<SoundboardSound>> {
    Ok(of_guilds(state, &[guild_id]).await?.remove(&guild_id).unwrap_or_default())
}

/// A guild sound and its uploader id.
pub async fn find(state: &AppState, guild_id: i64, id: i64) -> ApiResult<Option<(SoundboardSound, Option<i64>)>> {
    let row: Option<SoundRow> = sqlx::query_as(&format!("SELECT {COLS} FROM soundboard_sounds WHERE id = $1 AND guild_id = $2"))
        .bind(id)
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let creator = row.creator_id;
    Ok(to_api(state, vec![row]).await?.pop().map(|sound| (sound, creator)))
}

/// A GUILD_SOUNDBOARD_SOUND_* event to every member of the guild.
pub async fn announce(state: &AppState, guild_id: i64, event: &GatewayEvent) -> ApiResult<()> {
    let members = access::guild_member_ids(state, guild_id).await?;
    state.hub.send(&members, event);
    Ok(())
}

/// Deletes sound files no sound refers to any more (deleted sounds, deleted guilds).
pub async fn sweep_assets(state: &AppState) {
    let deleted: Result<Vec<(i64,)>, _> = sqlx::query_as(
        "DELETE FROM attachments a WHERE a.sound_asset AND NOT EXISTS (SELECT 1 FROM soundboard_sounds s WHERE s.attachment_id = a.id) RETURNING a.id",
    )
    .fetch_all(&state.db)
    .await;
    match deleted {
        Ok(rows) => media::remove_files(state, &rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await,
        Err(error) => tracing::warn!("sound asset sweep failed: {error}"),
    }
}

/// A sound someone may play: what VOICE_CHANNEL_EFFECT_SEND needs.
#[derive(Clone, Debug)]
pub struct Playable {
    pub sound_id: i64,
    /// `None` = a default sound.
    pub source_guild_id: Option<i64>,
    pub volume: f64,
    pub emoji: Option<EffectEmoji>,
    pub url: String,
}

/// The sound `sound_id` of `source_guild_id` (`None` = a default sound) if `user_id` may pick it: defaults always, guild
/// sounds only while the user is a member of that guild. Anything else is `None` (callers answer "Unknown Sound").
pub async fn playable(state: &AppState, user_id: i64, sound_id: i64, source_guild_id: Option<i64>) -> ApiResult<Option<Playable>> {
    let Some(guild_id) = source_guild_id else {
        return Ok(defaults::find(sound_id).map(|sound| Playable {
            sound_id,
            source_guild_id: None,
            volume: sound.volume,
            emoji: Some(EffectEmoji { id: None, name: Some(sound.emoji.to_owned()) }),
            url: default_url(state, sound_id),
        }));
    };
    let row: Option<(f64, Option<i64>, Option<String>, String)> = sqlx::query_as(
        "SELECT s.volume, s.emoji_id, s.emoji_name, s.asset_path FROM soundboard_sounds s \
         JOIN guild_members m ON m.guild_id = s.guild_id AND m.user_id = $3 WHERE s.id = $1 AND s.guild_id = $2",
    )
    .bind(sound_id)
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|(volume, emoji_id, emoji_name, asset_path)| Playable {
        sound_id,
        source_guild_id: Some(guild_id),
        volume,
        emoji: (emoji_id.is_some() || emoji_name.is_some()).then(|| EffectEmoji { id: emoji_id.map(Snowflake::from), name: emoji_name }),
        url: state.asset_url(&asset_path),
    }))
}

/// Whether `permissions` (resolved in the voice channel of `channel_guild`) allow playing `sound` there.
pub fn may_play(permissions: u64, channel_guild: i64, sound: &Playable) -> bool {
    let external = sound.source_guild_id.is_some_and(|guild| guild != channel_guild);
    permissions & (USE_SOUNDBOARD | SPEAK) == USE_SOUNDBOARD | SPEAK && (!external || permissions & USE_EXTERNAL_SOUNDS != 0)
}

/// VOICE_CHANNEL_EFFECT_SEND to the users connected to the voice channel (the sender included).
pub fn send_effect(state: &AppState, channel_id: i64, guild_id: i64, user_id: i64, sound: Playable, entrance: bool) {
    let mut listeners: Vec<i64> = state.voice.all().into_iter().filter(|entry| entry.channel_id == channel_id).map(|entry| entry.user_id).collect();
    listeners.sort_unstable();
    let event = GatewayEvent::VoiceChannelEffectSend(VoiceChannelEffectSend {
        channel_id: Snowflake::from(channel_id),
        guild_id: Snowflake::from(guild_id),
        user_id: Snowflake::from(user_id),
        sound_id: Snowflake::from(sound.sound_id),
        sound_volume: sound.volume,
        emoji: sound.emoji,
        source_guild_id: sound.source_guild_id.map(Snowflake::from),
        sound_url: sound.url,
        entrance,
    });
    state.hub.send(&listeners, &event);
}

/// Last play per (user, channel), for the one-play-per-3-seconds rule.
#[derive(Default)]
pub struct Plays {
    last: Mutex<HashMap<(i64, i64), Instant>>,
}

impl Plays {
    /// Records a play at `now`, or returns how long the user still has to wait in that channel.
    pub fn try_play(&self, user_id: i64, channel_id: i64, now: Instant) -> Result<(), Duration> {
        let mut last = self.last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = last.get(&(user_id, channel_id)) {
            let elapsed = now.saturating_duration_since(*previous);
            if elapsed < PLAY_INTERVAL {
                return Err(PLAY_INTERVAL - elapsed);
            }
        }
        if last.len() > 1024 {
            last.retain(|_, at| now.saturating_duration_since(*at) < PLAY_INTERVAL);
        }
        last.insert((user_id, channel_id), now);
        Ok(())
    }
}

/// The user's entrance sounds; guild scopes of guilds they left are not listed (and never play).
pub async fn entrance_sounds(state: &AppState, user_id: i64) -> ApiResult<EntranceSounds> {
    let rows: Vec<(i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT e.scope_guild_id, e.sound_id, e.source_guild_id FROM entrance_sounds e WHERE e.user_id = $1 \
         AND (e.scope_guild_id = 0 OR EXISTS (SELECT 1 FROM guild_members m WHERE m.guild_id = e.scope_guild_id AND m.user_id = $1)) \
         ORDER BY e.scope_guild_id",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let entrance_sounds = rows
        .into_iter()
        .map(|(scope, sound_id, source)| EntranceSound {
            guild_id: (scope != 0).then(|| Snowflake::from(scope)),
            sound_id: Snowflake::from(sound_id),
            source_guild_id: source.map(Snowflake::from),
        })
        .collect();
    Ok(EntranceSounds { entrance_sounds })
}

/// The joiner's entrance sound for `guild_id` (else the global one) to everyone in the channel, if they may play it there.
pub async fn play_entrance(state: &AppState, user_id: i64, guild_id: i64, channel_id: i64, permissions: u64) {
    let picked: Result<Option<(i64, Option<i64>)>, _> = sqlx::query_as(
        "SELECT sound_id, source_guild_id FROM entrance_sounds WHERE user_id = $1 AND scope_guild_id IN ($2, 0) ORDER BY scope_guild_id DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(guild_id)
    .fetch_optional(&state.db)
    .await;
    let Ok(Some((sound_id, source))) = picked else { return };
    let Ok(Some(sound)) = playable(state, user_id, sound_id, source).await else { return };
    if !may_play(permissions, guild_id, &sound) {
        return;
    }
    // Still in that channel (the join may have been undone while we looked the sound up).
    if crate::voice::state::in_channel(state, user_id, channel_id) {
        // Joining over and over must not get round the play limit: extra joins stay silent.
        if state.entrances.try_play(user_id, channel_id, Instant::now()).is_err() {
            return;
        }
        send_effect(state, channel_id, guild_id, user_id, sound, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_play_per_user_and_channel_every_three_seconds() {
        let plays = Plays::default();
        let start = Instant::now();
        assert!(plays.try_play(1, 10, start).is_ok());
        let wait = plays.try_play(1, 10, start + Duration::from_secs(1)).expect_err("limited");
        assert_eq!(wait, Duration::from_secs(2));
        assert!(plays.try_play(1, 11, start).is_ok(), "another channel");
        assert!(plays.try_play(2, 10, start).is_ok(), "another user");
        assert!(plays.try_play(1, 10, start + PLAY_INTERVAL).is_ok());
    }

    #[test]
    fn external_sounds_need_their_own_permission() {
        let sound = |guild: Option<i64>| Playable { sound_id: 1, source_guild_id: guild, volume: 1.0, emoji: None, url: String::new() };
        let base = USE_SOUNDBOARD | SPEAK;
        assert!(may_play(base, 5, &sound(None)), "default sounds are never external");
        assert!(may_play(base, 5, &sound(Some(5))));
        assert!(!may_play(base, 5, &sound(Some(6))));
        assert!(may_play(base | USE_EXTERNAL_SOUNDS, 5, &sound(Some(6))));
        assert!(!may_play(USE_SOUNDBOARD, 5, &sound(None)), "SPEAK is needed");
        assert!(!may_play(SPEAK | USE_EXTERNAL_SOUNDS, 5, &sound(None)), "USE_SOUNDBOARD is needed");
    }
}
