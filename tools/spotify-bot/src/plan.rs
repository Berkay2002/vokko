//! The pure parts of a session: request validation, lease expiry and the rule that turns a `PUT` into a player command.
//! No I/O, so all of it is unit-tested.

use std::fmt;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// A session is dropped when the server has not renewed it for this long (docs/api.md "Bot contract").
pub const LEASE_TTL: Duration = Duration::from_secs(150);
/// A `PUT` for the track already playing only seeks when the bot is further than this from `position_ms`. Below the server's
/// 3 s "previous restarts" rule, above the drift a lease or an advance acknowledgement carries.
pub const DRIFT_MS: u64 = 2_000;
const MAX_POSITION_MS: u64 = 24 * 3_600_000;

/// What the server wants the bot to be doing (`PUT /session`).
#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct Desired {
    pub channel_id: String,
    pub livekit_url: String,
    pub token: String,
    pub track: String,
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default = "yes")]
    pub playing: bool,
    pub seq: u64,
}

fn yes() -> bool {
    true
}

/// The token is a secret, so it never reaches a log line.
impl fmt::Debug for Desired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Desired")
            .field("channel_id", &self.channel_id)
            .field("position_ms", &self.position_ms)
            .field("playing", &self.playing)
            .field("seq", &self.seq)
            .finish_non_exhaustive()
    }
}

/// `spotify:track:` and 22 letters or digits: the only thing the player is ever asked to load (design §9.4).
pub fn valid_track_uri(uri: &str) -> bool {
    uri.strip_prefix("spotify:track:").is_some_and(crate::catalog::valid_id)
}

pub fn valid_channel_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

impl Desired {
    pub fn validate(&mut self) -> Result<(), &'static str> {
        if !valid_channel_id(&self.channel_id) {
            return Err("channel_id must be a number");
        }
        let scheme = self.livekit_url.split_once("://").map(|(scheme, rest)| (scheme, rest.split(['/', '?']).next().unwrap_or("")));
        if !matches!(scheme, Some(("ws" | "wss" | "http" | "https", host)) if !host.is_empty()) {
            return Err("livekit_url must be ws(s) or http(s)");
        }
        if self.token.is_empty() {
            return Err("token is missing");
        }
        if !valid_track_uri(&self.track) || self.next.as_deref().is_some_and(|next| !valid_track_uri(next)) {
            return Err("track and next must be spotify:track: URIs");
        }
        self.position_ms = self.position_ms.min(MAX_POSITION_MS);
        Ok(())
    }
}

pub struct Lease {
    renewed: Instant,
}

impl Lease {
    pub fn new(now: Instant) -> Self {
        Self { renewed: now }
    }
    pub fn renew(&mut self, now: Instant) {
        self.renewed = now;
    }
    pub fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.renewed) > LEASE_TTL
    }
}

/// What the player is doing right now, as the session sees it.
pub struct Now<'a> {
    /// The newest `seq` applied.
    pub seq: u64,
    /// The track the player has loaded (`None` before the first load).
    pub track: Option<&'a str>,
    /// The track the bot just moved away from on its own (gapless advance) until the server confirms the move.
    pub advanced_from: Option<&'a str>,
    pub position_ms: u64,
    pub playing: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Older than what was applied: newest seq wins.
    Stale,
    /// Nothing to change in the player; take the new `next`.
    Keep,
    Load,
    /// Same track: change only what differs.
    Steer {
        play: Option<bool>,
        seek: Option<u64>,
    },
}

pub fn reconcile(now: &Now<'_>, d: &Desired) -> Step {
    if d.seq < now.seq {
        return Step::Stale;
    }
    let Some(track) = now.track else { return Step::Load };
    // A lease re-send, or a change the server made before it heard of the bot's own advance to `next`.
    if d.seq == now.seq || (now.advanced_from == Some(d.track.as_str()) && track != d.track) {
        return Step::Keep;
    }
    if track != d.track {
        return Step::Load;
    }
    let play = (d.playing != now.playing).then_some(d.playing);
    let seek = (now.position_ms.abs_diff(d.position_ms) > DRIFT_MS).then_some(d.position_ms);
    if play.is_none() && seek.is_none() { Step::Keep } else { Step::Steer { play, seek } }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
    const B: &str = "spotify:track:0VjIjW4GlUZAMYd2vXMi3b";

    fn desired(track: &str, seq: u64) -> Desired {
        Desired {
            channel_id: "42".into(),
            livekit_url: "ws://127.0.0.1:27880".into(),
            token: "t".into(),
            track: track.into(),
            next: None,
            position_ms: 0,
            playing: true,
            seq,
        }
    }

    fn now(track: Option<&'static str>, seq: u64) -> Now<'static> {
        Now { seq, track, advanced_from: None, position_ms: 10_000, playing: true }
    }

    #[test]
    fn validation() {
        assert!(desired(A, 1).validate().is_ok());
        assert!(desired("spotify:album:4uLU6hMCjMI75M1A2tKUQC", 1).validate().is_err());
        assert!(desired("spotify:track:short", 1).validate().is_err());
        let mut d = desired(A, 1);
        d.next = Some("spotify:track:../../etc/passwd/xxxxxxx".into());
        assert!(d.validate().is_err());
        let mut d = desired(A, 1);
        d.channel_id = "12a".into();
        assert!(d.validate().is_err());
        let mut d = desired(A, 1);
        d.livekit_url = "file:///x".into();
        assert!(d.validate().is_err());
        let mut d = desired(A, 1);
        d.livekit_url = "ws://".into();
        assert!(d.validate().is_err());
        let mut d = desired(A, 1);
        d.position_ms = u64::MAX;
        assert!(d.validate().is_ok() && d.position_ms == MAX_POSITION_MS);
    }

    #[test]
    fn debug_hides_the_token() {
        let mut d = desired(A, 1);
        d.token = "secret-token".into();
        assert!(!format!("{d:?}").contains("secret-token"));
    }

    #[test]
    fn lease_runs_out_after_150_s() {
        let start = Instant::now();
        let mut lease = Lease::new(start);
        assert!(!lease.expired(start + Duration::from_secs(150)));
        assert!(lease.expired(start + Duration::from_secs(151)));
        lease.renew(start + Duration::from_secs(100));
        assert!(!lease.expired(start + Duration::from_secs(240)));
    }

    #[test]
    fn first_put_loads_and_newest_seq_wins() {
        assert_eq!(reconcile(&now(None, 0), &desired(A, 1)), Step::Load);
        assert_eq!(reconcile(&now(Some(A), 5), &desired(B, 4)), Step::Stale);
        assert_eq!(reconcile(&now(Some(A), 5), &desired(B, 6)), Step::Load);
    }

    #[test]
    fn a_lease_changes_nothing() {
        // Same seq, even if the server's position estimate is off or the bot has moved on.
        let mut d = desired(B, 5);
        d.position_ms = 90_000;
        assert_eq!(reconcile(&now(Some(A), 5), &d), Step::Keep);
    }

    #[test]
    fn same_track_steers() {
        let mut d = desired(A, 6);
        d.playing = false;
        d.position_ms = 10_500;
        assert_eq!(reconcile(&now(Some(A), 5), &d), Step::Steer { play: Some(false), seek: None });
        d.playing = true;
        d.position_ms = 60_000;
        assert_eq!(reconcile(&now(Some(A), 5), &d), Step::Steer { play: None, seek: Some(60_000) });
        d.position_ms = 11_000;
        assert_eq!(reconcile(&now(Some(A), 5), &d), Step::Keep);
        // "previous" past 3 s restarts the track.
        d.position_ms = 0;
        let mut n = now(Some(A), 5);
        n.position_ms = 3_100;
        assert_eq!(reconcile(&n, &d), Step::Steer { play: None, seek: Some(0) });
    }

    #[test]
    fn gapless_advance_is_not_undone_by_a_late_change() {
        // The bot moved A -> B on its own; a queue change the server made before it heard keeps A as the track.
        let mut n = now(Some(B), 5);
        n.advanced_from = Some(A);
        assert_eq!(reconcile(&n, &desired(A, 6)), Step::Keep);
        // The server's acknowledgement: B, position near 0.
        n.position_ms = 400;
        assert_eq!(reconcile(&n, &desired(B, 7)), Step::Keep);
        // Loop `track`: the bot replayed A; a seek on it still works before the acknowledgement.
        let mut n = now(Some(A), 5);
        n.advanced_from = Some(A);
        let mut d = desired(A, 6);
        d.position_ms = 60_000;
        assert_eq!(reconcile(&n, &d), Step::Steer { play: None, seek: Some(60_000) });
    }
}
