//! The play queue of a Spotify session as plain data (docs/design/spotify-bot.md sections 4.2 and 10): the current track, what is
//! up next, a short history, the loop mode. No state, no I/O, so every rule here is a unit test.
use vokko_protocol::api::{SPOTIFY_QUEUE_MAX, SpotifyLoop, SpotifyTrack};

use crate::auth::random_hex;

/// Tracks `previous` can walk back through.
pub const HISTORY_MAX: usize = 20;
/// `previous` restarts the track when it has played longer than this.
pub const RESTART_AFTER_MS: u64 = 3000;

#[derive(Clone, Debug)]
pub struct Entry {
    pub qid: String,
    pub track: SpotifyTrack,
    pub added_by: i64,
}

impl Entry {
    fn new(track: SpotifyTrack, added_by: i64) -> Self {
        Self { qid: random_hex(8), track, added_by }
    }
}

/// Why the current track is being left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leave {
    /// It played to the end.
    Ended,
    /// Someone skipped it.
    Skipped,
    /// It cannot be played: it does not count as played.
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Back {
    /// Start the current track again.
    Restart,
    /// The previous track is current now.
    Played,
}

#[derive(Clone, Debug, Default)]
pub struct Queue {
    pub current: Option<SpotifyTrack>,
    /// Who put the current track in play (it keeps its adder when a looping queue appends it again).
    current_by: i64,
    pub entries: Vec<Entry>,
    /// Played tracks with who had put them in play.
    history: Vec<(SpotifyTrack, i64)>,
    pub loop_mode: SpotifyLoop,
}

impl Queue {
    pub fn current_by(&self) -> i64 {
        self.current_by
    }

    pub fn can_previous(&self) -> bool {
        !self.history.is_empty()
    }

    /// What plays after the current track, for the bot's gapless preload. `None` when the session will go idle.
    pub fn upcoming(&self) -> Option<&SpotifyTrack> {
        let current = self.current.as_ref()?;
        match self.loop_mode {
            SpotifyLoop::Track => Some(current),
            _ => self.entries.first().map(|entry| &entry.track).or((self.loop_mode == SpotifyLoop::Queue).then_some(current)),
        }
    }

    fn remember(&mut self, track: SpotifyTrack) {
        self.history.push((track, self.current_by));
        if self.history.len() > HISTORY_MAX {
            self.history.remove(0);
        }
    }

    /// Puts `tracks` at the front (in order) or the end of the queue as far as the cap allows; returns how many did not fit.
    pub fn add(&mut self, tracks: Vec<SpotifyTrack>, added_by: i64, front: bool) -> usize {
        let room = SPOTIFY_QUEUE_MAX.saturating_sub(self.entries.len());
        let left_out = tracks.len().saturating_sub(room);
        let entries = tracks.into_iter().take(room).map(|track| Entry::new(track, added_by));
        if front {
            self.entries.splice(0..0, entries);
        } else {
            self.entries.extend(entries);
        }
        left_out
    }

    /// `first` plays now (what played goes to the history) and `rest` goes to the front of the queue. Returns how many of `rest` did not fit.
    pub fn play_now(&mut self, first: SpotifyTrack, rest: Vec<SpotifyTrack>, added_by: i64) -> usize {
        if let Some(current) = self.current.replace(first) {
            self.remember(current);
        }
        self.current_by = added_by;
        self.add(rest, added_by, true)
    }

    pub fn remove(&mut self, qid: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.qid != qid);
        self.entries.len() != before
    }

    pub fn move_to(&mut self, qid: &str, to: usize) -> bool {
        let Some(from) = self.entries.iter().position(|entry| entry.qid == qid) else { return false };
        let entry = self.entries.remove(from);
        self.entries.insert(to.min(self.entries.len()), entry);
        true
    }

    pub fn shuffle(&mut self) {
        use rand::seq::SliceRandom;
        self.entries.shuffle(&mut rand::rng());
    }

    /// The current track is over; the next one (if any) is current now. Loop `track` replays a track that ended by itself.
    pub fn advance(&mut self, leave: Leave) -> Option<&SpotifyTrack> {
        if leave == Leave::Ended && self.loop_mode == SpotifyLoop::Track && self.current.is_some() {
            return self.current.as_ref();
        }
        if let Some(finished) = self.current.take()
            && leave != Leave::Unavailable
        {
            self.remember(finished.clone());
            if self.loop_mode == SpotifyLoop::Queue {
                // The cap is not enforced here: the track was in the list a moment ago.
                self.entries.push(Entry::new(finished, self.current_by));
            }
        }
        if !self.entries.is_empty() {
            let next = self.entries.remove(0);
            self.current_by = next.added_by;
            self.current = Some(next.track);
        }
        self.current.as_ref()
    }

    /// Restart the track when it has played for a while (or there is nothing before it), else step back one track.
    pub fn previous(&mut self, position_ms: u64) -> Back {
        if (position_ms > RESTART_AFTER_MS && self.current.is_some()) || self.history.is_empty() {
            return Back::Restart;
        }
        let Some((earlier, earlier_by)) = self.history.pop() else { return Back::Restart };
        if let Some(current) = self.current.replace(earlier) {
            self.entries.insert(0, Entry::new(current, self.current_by));
            self.entries.truncate(SPOTIFY_QUEUE_MAX);
        }
        self.current_by = earlier_by;
        Back::Played
    }

    #[cfg(test)]
    fn uris(&self) -> Vec<&str> {
        self.entries.iter().map(|entry| entry.track.uri.as_str()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(n: usize) -> SpotifyTrack {
        SpotifyTrack {
            uri: format!("spotify:track:{n:022}"),
            title: format!("t{n}"),
            artists: vec![],
            album: None,
            art: None,
            duration_ms: 1000,
            explicit: false,
        }
    }

    fn tracks(range: std::ops::Range<usize>) -> Vec<SpotifyTrack> {
        range.map(track).collect()
    }

    fn uri(n: usize) -> String {
        track(n).uri
    }

    fn playing(count: usize) -> Queue {
        let mut queue = Queue::default();
        queue.play_now(track(0), tracks(1..count), 7);
        queue
    }

    #[test]
    fn play_now_puts_the_rest_in_front_in_order() {
        let mut queue = playing(4);
        assert_eq!(queue.current.as_ref().map(|t| t.uri.clone()), Some(uri(0)));
        assert_eq!(queue.uris(), [uri(1), uri(2), uri(3)]);
        queue.add(tracks(10..11), 8, false);
        assert_eq!(queue.play_now(track(20), tracks(21..23), 9), 0);
        assert_eq!(queue.uris(), [uri(21), uri(22), uri(1), uri(2), uri(3), uri(10)]);
        assert!(queue.can_previous(), "the track that was replaced is in the history");
    }

    #[test]
    fn the_cap_leaves_the_rest_out() {
        let mut queue = Queue::default();
        assert_eq!(queue.add(tracks(0..195), 1, false), 0);
        assert_eq!(queue.add(tracks(200..210), 1, false), 5);
        assert_eq!(queue.entries.len(), SPOTIFY_QUEUE_MAX);
        assert_eq!(queue.add(tracks(300..301), 1, true), 1, "full means nothing more, in front or behind");
        assert_eq!(queue.entries[0].track.uri, uri(0));
    }

    #[test]
    fn remove_and_move_go_by_qid() {
        let mut queue = playing(5);
        let (a, b, c) = (queue.entries[0].qid.clone(), queue.entries[1].qid.clone(), queue.entries[3].qid.clone());
        assert!(queue.move_to(&c, 0) && queue.move_to(&a, 99));
        assert_eq!(queue.uris(), [uri(4), uri(2), uri(3), uri(1)]);
        assert!(queue.remove(&b) && !queue.remove(&b), "a second remove of the same row misses instead of hitting another");
        assert!(!queue.move_to("nope", 0));
        assert_eq!(queue.entries.len(), 3);
    }

    #[test]
    fn shuffle_keeps_the_set() {
        let mut queue = Queue::default();
        queue.add(tracks(0..50), 1, false);
        let mut before: Vec<String> = queue.entries.iter().map(|e| e.qid.clone()).collect();
        queue.shuffle();
        let mut after: Vec<String> = queue.entries.iter().map(|e| e.qid.clone()).collect();
        assert_ne!(before, after, "50 entries stay in order with odds of 1 in 50!");
        before.sort();
        after.sort();
        assert_eq!(before, after);
    }

    #[test]
    fn advance_follows_the_loop_mode() {
        let mut queue = playing(3);
        assert_eq!(queue.upcoming().map(|t| t.uri.clone()), Some(uri(1)));
        assert_eq!(queue.advance(Leave::Ended).map(|t| t.uri.clone()), Some(uri(1)));
        queue.loop_mode = SpotifyLoop::Track;
        assert_eq!(queue.upcoming().map(|t| t.uri.clone()), Some(uri(1)), "loop track preloads the same track");
        assert_eq!(queue.advance(Leave::Ended).map(|t| t.uri.clone()), Some(uri(1)));
        assert_eq!(queue.advance(Leave::Skipped).map(|t| t.uri.clone()), Some(uri(2)), "a skip moves on even in loop track");
        queue.loop_mode = SpotifyLoop::Queue;
        assert_eq!(queue.upcoming().map(|t| t.uri.clone()), Some(uri(2)), "nothing queued: the track itself");
        assert_eq!(queue.advance(Leave::Ended).map(|t| t.uri.clone()), Some(uri(2)));
        queue.add(tracks(7..9), 1, false);
        assert_eq!(queue.advance(Leave::Ended).map(|t| t.uri.clone()), Some(uri(7)));
        assert_eq!(queue.uris(), [uri(8), uri(2)], "the finished track goes to the end");
        queue.loop_mode = SpotifyLoop::Off;
        queue.entries.clear();
        assert!(queue.advance(Leave::Ended).is_none() && queue.current.is_none() && queue.upcoming().is_none());
    }

    #[test]
    fn an_unavailable_track_does_not_count_as_played() {
        let mut queue = playing(3);
        queue.loop_mode = SpotifyLoop::Queue;
        queue.advance(Leave::Unavailable);
        assert!(!queue.can_previous());
        assert_eq!(queue.uris(), [uri(2)], "and is not put back into a looping queue");
    }

    #[test]
    fn previous_restarts_late_and_steps_back_early() {
        let mut queue = playing(3);
        assert_eq!(queue.previous(10), Back::Restart, "no history yet");
        queue.advance(Leave::Ended);
        queue.advance(Leave::Ended);
        assert_eq!(queue.previous(RESTART_AFTER_MS + 1), Back::Restart);
        assert_eq!(queue.previous(RESTART_AFTER_MS), Back::Played);
        assert_eq!(queue.current.as_ref().map(|t| t.uri.clone()), Some(uri(1)));
        assert_eq!(queue.uris(), [uri(2)], "the track we left is next again");
        assert_eq!(queue.previous(0), Back::Played);
        assert_eq!(queue.current.as_ref().map(|t| t.uri.clone()), Some(uri(0)));
        assert!(!queue.can_previous());
    }

    #[test]
    fn history_is_bounded() {
        let mut queue = Queue::default();
        queue.play_now(track(0), tracks(1..40), 1);
        for _ in 0..30 {
            queue.advance(Leave::Skipped);
        }
        assert_eq!(queue.history.len(), HISTORY_MAX);
        assert_eq!(queue.history.first().map(|(t, _)| t.uri.clone()), Some(uri(10)));
    }
}
