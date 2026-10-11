//! Snowflake generator: 42 bits ms since the Discord epoch (2015-01-01), 5 worker, 5 process, 12 increment bits.
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const EPOCH_MS: u64 = 1_420_070_400_000;

pub struct SnowflakeGenerator {
    worker: u64,
    state: Mutex<(u64, u64)>,
}

impl SnowflakeGenerator {
    pub fn new(worker: u64) -> Self {
        Self { worker: worker & 0x1f, state: Mutex::new((0, 0)) }
    }

    pub fn next(&self) -> i64 {
        let now = now_ms().saturating_sub(EPOCH_MS);
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (last_ts, last_seq) = *state;
        let (ts, seq) = if now > last_ts {
            (now, 0)
        } else if last_seq >= 0xfff {
            (last_ts + 1, 0)
        } else {
            (last_ts, last_seq + 1)
        };
        *state = (ts, seq);
        compose(ts, self.worker, seq)
    }
}

fn compose(ts: u64, worker: u64, seq: u64) -> i64 {
    ((ts << 22) | (worker << 17) | (seq & 0xfff)) as i64
}

/// A snowflake for a fixed instant (used by the seed so reruns produce the same ids).
pub fn at(unix_ms: u64, worker: u64, seq: u64) -> i64 {
    compose(unix_ms.saturating_sub(EPOCH_MS), worker & 0x1f, seq)
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_increasing() {
        let generator = SnowflakeGenerator::new(1);
        let mut previous = generator.next();
        for _ in 0..20_000 {
            let next = generator.next();
            assert!(next > previous);
            previous = next;
        }
    }

    #[test]
    fn timestamp_bits_round_trip() {
        let id = at(EPOCH_MS + 5000, 2, 7);
        assert_eq!((id as u64) >> 22, 5000);
        assert_eq!(id & 0xfff, 7);
    }
}
