//! The instance's default soundboard sounds: short tones synthesized here (no recorded or third-party audio, see
//! docs/assets-credits.md), rendered once to 16-bit mono WAV.
use std::f32::consts::TAU;
use std::sync::OnceLock;

pub const SAMPLE_RATE: u32 = 22_050;

pub struct DefaultSound {
    pub id: i64,
    pub name: &'static str,
    pub emoji: &'static str,
    pub volume: f64,
    render: fn() -> Vec<f32>,
}

pub const DEFAULT_SOUNDS: [DefaultSound; 6] = [
    DefaultSound { id: 1, name: "Chime", emoji: "🎐", volume: 1.0, render: chime },
    DefaultSound { id: 2, name: "Pop", emoji: "🫧", volume: 1.0, render: pop },
    DefaultSound { id: 3, name: "Ding", emoji: "🔔", volume: 0.9, render: ding },
    DefaultSound { id: 4, name: "Boop", emoji: "🤖", volume: 0.8, render: boop },
    DefaultSound { id: 5, name: "Fanfare", emoji: "🎺", volume: 0.8, render: fanfare },
    DefaultSound { id: 6, name: "Whoosh", emoji: "💨", volume: 1.0, render: whoosh },
];

pub fn find(id: i64) -> Option<&'static DefaultSound> {
    DEFAULT_SOUNDS.iter().find(|sound| sound.id == id)
}

/// The WAV file of a default sound.
pub fn file(id: i64) -> Option<&'static [u8]> {
    static FILES: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
    let files = FILES.get_or_init(|| DEFAULT_SOUNDS.iter().map(|sound| encode_wav(&(sound.render)(), SAMPLE_RATE)).collect());
    let index = DEFAULT_SOUNDS.iter().position(|sound| sound.id == id)?;
    files.get(index).map(Vec::as_slice)
}

/// 16-bit PCM mono WAV.
pub fn encode_wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes());
    }
    out
}

fn seconds(duration: f32) -> usize {
    (duration * SAMPLE_RATE as f32) as usize
}

/// Short linear attack and release so nothing clicks.
fn fade(samples: &mut [f32]) {
    let edge = seconds(0.005).min(samples.len() / 2).max(1);
    let length = samples.len();
    for index in 0..edge {
        let gain = index as f32 / edge as f32;
        samples[index] *= gain;
        samples[length - 1 - index] *= gain;
    }
}

/// A sine note with an exponential decay, added into `out` at `start` seconds.
fn note(out: &mut [f32], start: f32, frequency: f32, length: f32, decay: f32, gain: f32) {
    let offset = seconds(start);
    for index in 0..seconds(length) {
        let Some(slot) = out.get_mut(offset + index) else { break };
        let t = index as f32 / SAMPLE_RATE as f32;
        *slot += (TAU * frequency * t).sin() * (-t * decay).exp() * gain;
    }
}

fn finish(mut samples: Vec<f32>) -> Vec<f32> {
    fade(&mut samples);
    samples
}

fn chime() -> Vec<f32> {
    let mut out = vec![0.0; seconds(0.9)];
    note(&mut out, 0.0, 880.0, 0.9, 5.0, 0.45);
    note(&mut out, 0.18, 1318.5, 0.72, 5.0, 0.4);
    finish(out)
}

fn pop() -> Vec<f32> {
    let length = seconds(0.14);
    let mut phase = 0.0_f32;
    let out = (0..length)
        .map(|index| {
            let progress = index as f32 / length as f32;
            phase += TAU * (900.0 - 700.0 * progress) / SAMPLE_RATE as f32;
            phase.sin() * (1.0 - progress).powi(2) * 0.8
        })
        .collect();
    finish(out)
}

fn ding() -> Vec<f32> {
    let mut out = vec![0.0; seconds(1.3)];
    for (ratio, decay, gain) in [(1.0, 3.0, 0.5), (2.76, 5.0, 0.2), (5.4, 8.0, 0.12)] {
        note(&mut out, 0.0, 660.0 * ratio, 1.3, decay, gain);
    }
    finish(out)
}

fn boop() -> Vec<f32> {
    let mut out = vec![0.0; seconds(0.5)];
    for (start, frequency) in [(0.0, 220.0), (0.25, 330.0)] {
        let offset = seconds(start);
        for index in 0..seconds(0.24) {
            let t = index as f32 / SAMPLE_RATE as f32;
            out[offset + index] = ((TAU * frequency * t).sin() * 3.0).tanh() * 0.35;
        }
    }
    finish(out)
}

fn fanfare() -> Vec<f32> {
    let mut out = vec![0.0; seconds(1.1)];
    for (start, frequency, length) in [(0.0, 523.25, 0.16), (0.15, 659.25, 0.16), (0.3, 783.99, 0.16), (0.45, 1046.5, 0.65)] {
        for harmonic in 1..=5 {
            note(&mut out, start, frequency * harmonic as f32, length, 3.0, 0.22 / harmonic as f32);
        }
    }
    finish(out)
}

fn whoosh() -> Vec<f32> {
    let length = seconds(0.8);
    let mut seed = 0x2545_f491_u32;
    let mut low = 0.0_f32;
    let out = (0..length)
        .map(|index| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 8) as f32 / (1 << 24) as f32 * 2.0 - 1.0;
            let progress = index as f32 / length as f32;
            let cutoff = 0.02 + 0.25 * (progress * std::f32::consts::PI).sin();
            low += cutoff * (noise - low);
            low * (progress * std::f32::consts::PI).sin() * 1.6
        })
        .collect();
    finish(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::soundboard::audio::{AudioFormat, probe};

    #[test]
    fn every_default_sound_is_a_short_valid_wav() {
        for sound in &DEFAULT_SOUNDS {
            let bytes = file(sound.id).expect("rendered");
            let probed = probe(bytes).expect("parses as audio");
            assert_eq!(probed.format, AudioFormat::Wav, "{}", sound.name);
            assert!((100..=1500).contains(&probed.duration_ms), "{}: {} ms", sound.name, probed.duration_ms);
            assert!(bytes.len() < 64 * 1024, "{}", sound.name);
            let peak = bytes[44..].as_chunks::<2>().0.iter().map(|pair| i16::from_le_bytes(*pair).unsigned_abs()).max().unwrap_or(0);
            assert!(peak > 3000, "{} is audible", sound.name);
        }
        assert!(file(99).is_none());
    }
}
