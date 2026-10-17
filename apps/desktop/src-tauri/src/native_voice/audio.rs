//! Microphone and speakers for the native voice room: cpal on PulseAudio (PipeWire answers through pipewire-pulse), ALSA when
//! no Pulse server does. Everything is 48 kHz mono in 10 ms frames.
//!
//!   mic ─▶ capture callback ─┐                       ┌─▶ mic frames (to the published NativeAudioSource)
//!                            ├─▶ dsp thread: APM, VAD/PTT gate, input volume
//!   mixed speaker output ────┘   (reverse stream for the echo canceller)
//!
//! The WebRTC audio processing module is not Send, so one dsp thread owns it and the cpal callbacks only copy samples.

use super::gate::{GateOptions, VadGate, rms_db};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use livekit::webrtc::native::apm::AudioProcessingModule;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

pub const RATE: u32 = 48_000;
pub const FRAME: usize = 480;
/// A remote voice starts playing once this much is buffered (and again after running dry): absorbs network jitter.
const PRIME_SAMPLES: usize = FRAME * 4;
/// More than this queued for one voice means we fell behind: the oldest samples go.
const MAX_QUEUED: usize = FRAME * 20;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub device_id: String,
    pub label: String,
}

/// Settings the audio threads read on every frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    pub gate: GateOptions,
    pub input_gain: f32,
    /// Output volume x stream attenuation.
    pub output_gain: f32,
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
}

struct Voice {
    identity: String,
    queue: VecDeque<i16>,
    primed: bool,
}

/// State shared by the commands, the room task and the audio threads. One per app; a connect resets it.
pub struct Shared {
    pub muted: AtomicBool,
    pub deaf: AtomicBool,
    pub ptt: AtomicBool,
    pub params: Mutex<Params>,
    /// Per-user volume 0..2 from the page (1 when never set).
    pub volumes: Mutex<HashMap<String, f32>>,
    /// Remote microphone tracks by track sid.
    voices: Mutex<HashMap<String, Voice>>,
}

impl Shared {
    pub fn new(params: Params) -> Self {
        Self {
            muted: AtomicBool::new(false),
            deaf: AtomicBool::new(false),
            ptt: AtomicBool::new(false),
            params: Mutex::new(params),
            volumes: Mutex::new(HashMap::new()),
            voices: Mutex::new(HashMap::new()),
        }
    }

    pub fn params(&self) -> Option<Params> {
        self.params.lock().ok().map(|p| *p)
    }

    pub fn volume(&self, identity: &str) -> f32 {
        self.volumes.lock().ok().and_then(|v| v.get(identity).copied()).unwrap_or(1.0)
    }

    /// Decoded samples of a remote track (mono, 48 kHz).
    pub fn push_voice(&self, sid: &str, identity: &str, samples: &[i16]) {
        let Ok(mut voices) = self.voices.lock() else { return };
        let voice = voices.entry(sid.to_owned()).or_insert_with(|| Voice { identity: identity.to_owned(), queue: VecDeque::new(), primed: false });
        voice.queue.extend(samples);
        let excess = voice.queue.len().saturating_sub(MAX_QUEUED);
        voice.queue.drain(..excess);
    }

    pub fn drop_voice(&self, sid: &str) {
        if let Ok(mut voices) = self.voices.lock() {
            voices.remove(sid);
        }
    }

    pub fn clear_voices(&self) {
        if let Ok(mut voices) = self.voices.lock() {
            voices.clear();
        }
    }

    /// Fills `out` with the mix of every remote voice at its volume (silence while deafened; the queues drain anyway).
    fn mix(&self, out: &mut [i16]) {
        let deaf = self.deaf.load(Ordering::Relaxed);
        let output = self.params().map_or(1.0, |p| p.output_gain);
        let volumes = self.volumes.lock().map(|v| v.clone()).unwrap_or_default();
        let Ok(mut voices) = self.voices.lock() else { return };
        let mut acc = vec![0f32; out.len()];
        for voice in voices.values_mut() {
            if !voice.primed {
                if voice.queue.len() < PRIME_SAMPLES {
                    continue;
                }
                voice.primed = true;
            }
            let gain = if deaf { 0.0 } else { volumes.get(&voice.identity).copied().unwrap_or(1.0) * output };
            for slot in acc.iter_mut() {
                match voice.queue.pop_front() {
                    Some(sample) => *slot += f32::from(sample) * gain,
                    None => {
                        voice.primed = false;
                        break;
                    }
                }
            }
        }
        for (o, a) in out.iter_mut().zip(acc) {
            *o = a.clamp(-32768.0, 32767.0) as i16;
        }
    }
}

fn host() -> cpal::Host {
    match cpal::host_from_id(cpal::HostId::PulseAudio) {
        Ok(host) => host,
        Err(error) => {
            log::info!("native voice: no PulseAudio server ({error}), using ALSA");
            cpal::default_host()
        }
    }
}

fn device_id(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.id().to_owned())
}

/// Input and output devices (without the "Default" entry, which the page adds). Monitors of outputs are not microphones.
pub fn list_devices() -> (Vec<AudioDevice>, Vec<AudioDevice>) {
    let host = host();
    let describe = |devices: Vec<cpal::Device>| -> Vec<AudioDevice> {
        devices
            .iter()
            .filter_map(|d| {
                let device_id = device_id(d)?;
                let label = d.description().map(|desc| desc.name().to_owned()).unwrap_or_else(|_| device_id.clone());
                Some(AudioDevice { device_id, label })
            })
            .filter(|d| !d.device_id.ends_with(".monitor"))
            .collect()
    };
    let input = host.input_devices().map(|d| describe(d.collect())).unwrap_or_default();
    let output = host.output_devices().map(|d| describe(d.collect())).unwrap_or_default();
    (input, output)
}

/// The stored device, or the system default when it is "default" or gone.
fn pick(host: &cpal::Host, input: bool, wanted: &str) -> Option<cpal::Device> {
    if wanted != "default" {
        let devices = if input { host.input_devices().map(|d| d.collect::<Vec<_>>()) } else { host.output_devices().map(|d| d.collect()) };
        if let Some(device) = devices.ok().into_iter().flatten().find(|d| device_id(d).as_deref() == Some(wanted)) {
            return Some(device);
        }
        log::info!("native voice: {} device {wanted:?} not found, using the default", if input { "input" } else { "output" });
    }
    if input { host.default_input_device() } else { host.default_output_device() }
}

const CONFIG: cpal::StreamConfig = cpal::StreamConfig { channels: 1, sample_rate: RATE, buffer_size: cpal::BufferSize::Fixed(FRAME as u32) };

/// What the dsp thread is fed.
enum Dsp {
    Capture(Vec<i16>),
    Render(Vec<i16>),
}

/// The open microphone: its cpal stream and the dsp thread (which stops when the stream and its sender are dropped).
pub struct Capture {
    _stream: cpal::Stream,
    render: Arc<Mutex<Option<mpsc::SyncSender<Dsp>>>>,
}

impl Drop for Capture {
    /// The speakers stop feeding the dsp thread too, so its last sender is gone and it ends.
    fn drop(&mut self) {
        if let Ok(mut slot) = self.render.lock() {
            *slot = None;
        }
    }
}

/// Opens the microphone. Processed 10 ms frames (silence while the gate is closed) go to `frames`; gate changes to `speaking`.
pub fn start_capture(
    wanted: &str,
    shared: Arc<Shared>,
    render: &Playback,
    frames: tokio::sync::mpsc::Sender<Vec<i16>>,
    speaking: impl Fn(bool) + Send + 'static,
) -> Result<Capture, String> {
    let host = host();
    let device = pick(&host, true, wanted).ok_or("no microphone")?;
    let (tx, rx) = mpsc::sync_channel::<Dsp>(64);
    let reverse = tx.clone();
    std::thread::Builder::new().name("vokko-voice-dsp".into()).spawn(move || dsp_loop(rx, shared, frames, speaking)).map_err(|e| e.to_string())?;
    let mut pending: Vec<i16> = Vec::with_capacity(FRAME * 2);
    let stream = device
        .build_input_stream::<i16, _, _>(
            CONFIG,
            move |data: &[i16], _| {
                pending.extend_from_slice(data);
                while pending.len() >= FRAME {
                    let frame: Vec<i16> = pending.drain(..FRAME).collect();
                    // Full queue = the dsp thread is stuck: drop the frame rather than block the audio callback.
                    let _ = tx.try_send(Dsp::Capture(frame));
                }
            },
            |error| log::warn!("native voice: microphone stream error: {error}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    if let Ok(mut slot) = render.dsp.lock() {
        *slot = Some(reverse);
    }
    Ok(Capture { _stream: stream, render: render.dsp.clone() })
}

fn processor(p: &Params) -> Option<AudioProcessingModule> {
    (p.echo_cancellation || p.noise_suppression || p.auto_gain_control)
        .then(|| AudioProcessingModule::new(p.echo_cancellation, p.auto_gain_control, true, p.noise_suppression))
}

fn dsp_loop(rx: mpsc::Receiver<Dsp>, shared: Arc<Shared>, frames: tokio::sync::mpsc::Sender<Vec<i16>>, speaking: impl Fn(bool)) {
    let Some(mut params) = shared.params() else { return };
    let mut apm = processor(&params);
    let mut gate = VadGate::new(params.gate);
    let mut open = false;
    while let Ok(message) = rx.recv() {
        let current = shared.params().unwrap_or(params);
        if current != params {
            let processing = |p: &Params| (p.echo_cancellation, p.noise_suppression, p.auto_gain_control);
            if processing(&current) != processing(&params) {
                apm = processor(&current);
            }
            gate.configure(current.gate);
            params = current;
        }
        match message {
            Dsp::Render(mut frame) => {
                if let Some(apm) = apm.as_mut() {
                    let _ = apm.process_reverse_stream(&mut frame, RATE as i32, 1);
                }
            }
            Dsp::Capture(mut frame) => {
                if let Some(apm) = apm.as_mut() {
                    let _ = apm.process_stream(&mut frame, RATE as i32, 1);
                }
                gate.set_forced_closed(shared.muted.load(Ordering::Relaxed));
                gate.set_key(shared.ptt.load(Ordering::Relaxed));
                let now = gate.push(rms_db(&frame));
                if now != open {
                    open = now;
                    speaking(open);
                }
                if open {
                    for s in frame.iter_mut() {
                        *s = (f32::from(*s) * params.input_gain).clamp(-32768.0, 32767.0) as i16;
                    }
                } else {
                    frame.fill(0);
                }
                if frames.try_send(frame).is_err() && frames.is_closed() {
                    return;
                }
            }
        }
    }
}

/// The speakers: mixes every remote voice and feeds the mix to the echo canceller.
pub struct Playback {
    _stream: cpal::Stream,
    dsp: Arc<Mutex<Option<mpsc::SyncSender<Dsp>>>>,
}

pub fn start_playback(wanted: &str, shared: Arc<Shared>) -> Result<Playback, String> {
    let host = host();
    let device = pick(&host, false, wanted).ok_or("no speakers")?;
    let dsp: Arc<Mutex<Option<mpsc::SyncSender<Dsp>>>> = Arc::new(Mutex::new(None));
    let to_dsp = dsp.clone();
    let mut reverse: Vec<i16> = Vec::with_capacity(FRAME * 2);
    let stream = device
        .build_output_stream::<i16, _, _>(
            CONFIG,
            move |out: &mut [i16], _| {
                shared.mix(out);
                let Ok(slot) = to_dsp.lock() else { return };
                let Some(tx) = slot.as_ref() else { return };
                reverse.extend_from_slice(out);
                while reverse.len() >= FRAME {
                    let _ = tx.try_send(Dsp::Render(reverse.drain(..FRAME).collect()));
                }
            },
            |error| log::warn!("native voice: speaker stream error: {error}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Playback { _stream: stream, dsp })
}
