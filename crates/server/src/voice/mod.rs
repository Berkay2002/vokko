//! Voice channels (docs/design/voice.md, milestone V1): permission checks, LiveKit tokens, the in-memory voice-state table,
//! LiveKit webhooks and reconciliation. Media never passes through vokko-server.
pub mod backends;
pub mod calls;
pub mod control;
pub mod games;
pub mod livekit;
pub mod moderation;
pub mod spotify;
pub mod stage;
pub mod state;
pub mod status;
pub mod stremio;
pub mod token;
pub mod watch;
pub mod webhook;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use vokko_protocol::api::{InstanceMediaConfig, VOICE_BITRATE_DEFAULT, VOICE_BITRATE_MIN, VOICE_USER_LIMIT_MAX};

use crate::config::{Config, LiveKitConfig};
use crate::error::{ApiErr, ApiResult};
use livekit::{HttpRoomService, NoRoomService, RoomService};

pub use state::{Voice, handle_command, reconcile, restore, restore_with_retry, spawn_tasks};

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0)
}

pub fn unix_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

/// LiveKit room of a channel.
pub fn room_name(channel_id: i64) -> String {
    format!("v{channel_id}")
}

pub fn room_channel(room: &str) -> Option<i64> {
    room.strip_prefix('v')?.parse().ok()
}

/// The RoomServices the config asks for, one per LiveKit backend in config order: HTTP to LiveKit (none when voice is off).
pub fn room_services(config: &Config) -> Vec<Arc<dyn RoomService>> {
    let service = |livekit: &LiveKitConfig| -> Arc<dyn RoomService> {
        match HttpRoomService::new(&livekit.api_url, &livekit.api_key, &livekit.api_secret) {
            Ok(service) => Arc::new(service),
            Err(error) => {
                tracing::error!("LiveKit RoomService client of {}: {error}; its voice moderation calls are disabled", livekit.label);
                Arc::new(NoRoomService)
            }
        }
    };
    config.livekit.iter().map(service).collect()
}

pub fn media_config(config: &Config) -> InstanceMediaConfig {
    InstanceMediaConfig {
        voice_enabled: !config.livekit.is_empty(),
        voice_bitrate_ceiling: config.voice_bitrate_max,
        // Screen share and camera arrive in V4/V5; the qualities are what the instance would allow.
        screenshare_qualities: vec!["720p30".to_owned(), "1080p60".to_owned()],
        video_enabled: false,
    }
}

/// `bitrate` / `user_limit` of a create or PATCH: only on voice channels, within 8000..=ceiling and 0..=99.
pub fn validate_channel_settings(config: &Config, is_voice: bool, bitrate: Option<u32>, user_limit: Option<u32>) -> ApiResult<()> {
    if !is_voice {
        if bitrate.is_some() {
            return Err(ApiErr::invalid("bitrate", "Only voice channels have a bitrate."));
        }
        if user_limit.is_some() {
            return Err(ApiErr::invalid("user_limit", "Only voice channels have a user limit."));
        }
        return Ok(());
    }
    if let Some(bitrate) = bitrate
        && !(VOICE_BITRATE_MIN..=config.voice_bitrate_max).contains(&bitrate)
    {
        return Err(ApiErr::invalid("bitrate", &format!("Must be between {VOICE_BITRATE_MIN} and {}.", config.voice_bitrate_max)));
    }
    if user_limit.is_some_and(|limit| limit > VOICE_USER_LIMIT_MAX) {
        return Err(ApiErr::invalid("user_limit", &format!("Must be between 0 and {VOICE_USER_LIMIT_MAX}.")));
    }
    Ok(())
}

/// Stored values → wire values for a guild voice channel (columns are NULL until edited).
pub fn channel_settings(bitrate: Option<i32>, user_limit: Option<i32>) -> (u32, u32) {
    (bitrate.map(|value| value.max(0) as u32).unwrap_or(VOICE_BITRATE_DEFAULT), user_limit.map(|value| value.max(0) as u32).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_and_channel_settings() {
        assert_eq!(room_name(42), "v42");
        assert_eq!((room_channel("v42"), room_channel("x42"), room_channel("v")), (Some(42), None, None));
        assert_eq!(channel_settings(None, None), (64_000, 0));
        let config = Config::new(String::new(), String::new(), "/tmp".into(), String::new());
        assert!(validate_channel_settings(&config, true, Some(128_000), Some(99)).is_ok());
        assert!(validate_channel_settings(&config, true, Some(128_001), None).is_err(), "above the default ceiling");
        assert!(validate_channel_settings(&config, true, Some(7_999), None).is_err());
        assert!(validate_channel_settings(&config, true, None, Some(100)).is_err());
        assert!(validate_channel_settings(&config, false, Some(64_000), None).is_err(), "text channels have no bitrate");
        assert!(validate_channel_settings(&config, false, None, None).is_ok());
    }
}
