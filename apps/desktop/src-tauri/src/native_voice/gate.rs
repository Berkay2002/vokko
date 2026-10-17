//! Voice activity / push-to-talk gate: the Rust twin of `src/voice/vad.ts` (same constants and behaviour), fed one RMS level
//! per 10 ms frame by the capture thread. Keep the two in step.

pub const FRAME_MS: f64 = 10.0;
const HANGOVER_MS: f64 = 400.0;
/// Adaptive threshold sits this far above the tracked noise floor.
const AUTO_MARGIN_DB: f64 = 15.0;
pub const SILENCE_DB: f64 = -100.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateOptions {
    pub ptt: bool,
    /// Manual threshold in dBFS; ignored while `auto` is on.
    pub threshold_db: f64,
    pub auto: bool,
    pub ptt_release_ms: f64,
}

pub struct VadGate {
    options: GateOptions,
    open: bool,
    /// ms of gate time left after the last frame above the threshold (VAD) or after key release (PTT).
    remaining_ms: f64,
    key_held: bool,
    floor_db: f64,
    forced_closed: bool,
}

impl VadGate {
    pub fn new(options: GateOptions) -> Self {
        Self { options, open: false, remaining_ms: 0.0, key_held: false, floor_db: -70.0, forced_closed: false }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    fn threshold_db(&self) -> f64 {
        if self.options.auto { (self.floor_db + AUTO_MARGIN_DB).min(0.0) } else { self.options.threshold_db }
    }

    pub fn configure(&mut self, options: GateOptions) {
        if options.ptt != self.options.ptt {
            self.open = false;
            self.remaining_ms = 0.0;
        }
        self.options = options;
    }

    /// Self mute: the gate stays closed whatever the level or key.
    pub fn set_forced_closed(&mut self, closed: bool) {
        self.forced_closed = closed;
        if closed {
            self.open = false;
            self.remaining_ms = 0.0;
        }
    }

    /// Push-to-talk key: opens at once on press, closes `ptt_release_ms` after release (counted in frames).
    pub fn set_key(&mut self, pressed: bool) -> bool {
        if pressed == self.key_held {
            return self.open;
        }
        self.key_held = pressed;
        if !self.options.ptt || self.forced_closed {
            return self.open;
        }
        if pressed {
            self.open = true;
            self.remaining_ms = 0.0;
        } else {
            self.remaining_ms = self.options.ptt_release_ms;
            if self.remaining_ms <= 0.0 {
                self.open = false;
            }
        }
        self.open
    }

    /// One frame of input level (dBFS). Returns whether the gate is open after this frame.
    pub fn push(&mut self, level_db: f64) -> bool {
        let level = if level_db.is_finite() { level_db.max(SILENCE_DB) } else { SILENCE_DB };
        // Noise floor: follows quiet frames quickly, rises slowly (speech must not drag it up).
        self.floor_db += (level - self.floor_db) * if level < self.floor_db { 0.2 } else { 0.002 };
        if self.forced_closed {
            self.open = false;
            return false;
        }
        if self.options.ptt {
            if !self.key_held && self.open {
                self.remaining_ms -= FRAME_MS;
                if self.remaining_ms <= 0.0 {
                    self.open = false;
                }
            }
            return self.open;
        }
        if level >= self.threshold_db() {
            self.open = true;
            self.remaining_ms = HANGOVER_MS;
        } else if self.open {
            self.remaining_ms -= FRAME_MS;
            if self.remaining_ms <= 0.0 {
                self.open = false;
            }
        }
        self.open
    }
}

/// RMS of 16-bit samples in dBFS (-100 for silence).
pub fn rms_db(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return SILENCE_DB;
    }
    let sum: f64 = samples.iter().map(|&s| (f64::from(s) / 32768.0).powi(2)).sum();
    let rms = (sum / samples.len() as f64).sqrt();
    if rms > 0.0 { (20.0 * rms.log10()).max(SILENCE_DB) } else { SILENCE_DB }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAD: GateOptions = GateOptions { ptt: false, threshold_db: -40.0, auto: false, ptt_release_ms: 20.0 };

    #[test]
    fn vad_opens_on_loud_frames_and_holds_for_the_hangover() {
        let mut gate = VadGate::new(VAD);
        assert!(!gate.push(-60.0));
        assert!(gate.push(-30.0));
        // 400 ms hangover = 40 quiet frames still open, the 40th closes it.
        for _ in 0..39 {
            assert!(gate.push(-60.0));
        }
        assert!(!gate.push(-60.0));
    }

    #[test]
    fn ptt_follows_the_key_with_the_release_delay_and_mute_wins() {
        let mut gate = VadGate::new(GateOptions { ptt: true, ..VAD });
        assert!(!gate.push(0.0));
        assert!(gate.set_key(true));
        assert!(gate.set_key(false));
        assert!(gate.push(-100.0));
        assert!(!gate.push(-100.0));
        gate.set_forced_closed(true);
        assert!(!gate.set_key(true));
        assert!(!gate.push(0.0));
    }

    #[test]
    fn auto_threshold_tracks_the_noise_floor() {
        let mut gate = VadGate::new(GateOptions { auto: true, ..VAD });
        // Quiet room at -80 dBFS: the floor drops there fast, so the threshold settles near -65.
        for _ in 0..100 {
            gate.push(-80.0);
        }
        assert!(!gate.push(-70.0));
        assert!(gate.push(-60.0));
    }

    #[test]
    fn rms_of_silence_and_full_scale() {
        assert_eq!(rms_db(&[0; 480]), SILENCE_DB);
        assert!(rms_db(&[i16::MAX; 480]).abs() < 0.01);
    }
}
