//! Text subtitles of the file: ffmpeg writes each text stream as WebVTT to a loopback socket, and these two small pieces turn
//! that stream into cues for the media room. No I/O, so both are unit-tested.

use std::time::{Duration, Instant};

use vokko_protocol::api::StremioCue;
use vokko_protocol::cues::parse_block;

/// A cue block is a few lines; whatever is longer than this is a broken or hostile stream and is cut.
const MAX_BLOCK_BYTES: usize = 8 * 1024;
/// Cues published per stream in one window. A film has far fewer; a hostile file does not get to flood the room.
const BUDGET_CUES: u32 = 30;
const BUDGET_WINDOW: Duration = Duration::from_secs(10);

/// Collects WebVTT lines into blocks (cues are separated by a blank line). Times in the output are media time:
/// ffmpeg's start from zero at the seek point, so `offset_ms` (the seek position) is added.
pub struct VttReader {
    block: String,
    offset_ms: u64,
}

impl VttReader {
    pub fn new(offset_ms: u64) -> Self {
        Self { block: String::new(), offset_ms }
    }

    pub fn push_line(&mut self, line: &str) -> Option<StremioCue> {
        if !line.trim().is_empty() {
            if self.block.len() < MAX_BLOCK_BYTES {
                self.block.push_str(line);
                self.block.push('\n');
            }
            return None;
        }
        let mut cue = parse_block(&std::mem::take(&mut self.block))?;
        cue.start_ms += self.offset_ms;
        cue.end_ms += self.offset_ms;
        Some(cue)
    }
}

/// At most `BUDGET_CUES` per `BUDGET_WINDOW`; the window starts at the first cue after the last one ended.
pub struct Budget {
    window_start: Instant,
    used: u32,
}

impl Budget {
    pub fn new(now: Instant) -> Self {
        Self { window_start: now, used: 0 }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_start) >= BUDGET_WINDOW {
            (self.window_start, self.used) = (now, 0);
        }
        self.used += 1;
        self.used <= BUDGET_CUES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(reader: &mut VttReader, text: &str) -> Vec<StremioCue> {
        text.lines().filter_map(|line| reader.push_line(line)).collect()
    }

    #[test]
    fn blocks_become_cues_at_media_time() {
        let mut reader = VttReader::new(60_000);
        let cues = feed(&mut reader, "WEBVTT\n\n00:01.000 --> 00:02.500\n<i>Hi</i>\nthere\n\n3\n00:03.000 --> 00:04.000 line:90%\n{\\an8}Bye\n\n");
        assert_eq!(cues.iter().map(|c| (c.start_ms, c.end_ms, c.text.as_str())).collect::<Vec<_>>(), [(61_000, 62_500, "Hi\nthere"), (63_000, 64_000, "Bye")]);
    }

    #[test]
    fn junk_and_oversized_blocks_give_nothing_or_stay_capped() {
        let mut reader = VttReader::new(0);
        assert!(feed(&mut reader, "WEBVTT\n\nNOTE x\n\n<b></b>\n\n").is_empty());
        let big = format!("00:01.000 --> 00:02.000\n{}\n\n", "line of text\n".repeat(10_000));
        let cues = feed(&mut reader, &big);
        assert_eq!(cues.len(), 1);
        assert!(cues[0].text.lines().count() <= 4 && cues[0].text.chars().count() <= 300);
        assert!(feed(&mut reader, "00:05.000 --> 00:06.000\nok\n\n").len() == 1, "the reader recovers");
    }

    #[test]
    fn the_budget_caps_a_window_and_then_starts_a_new_one() {
        let t0 = Instant::now();
        let mut budget = Budget::new(t0);
        assert_eq!((0..40).filter(|_| budget.allow(t0)).count(), 30);
        assert!(!budget.allow(t0 + Duration::from_secs(9)));
        assert!(budget.allow(t0 + Duration::from_secs(10)));
    }
}
