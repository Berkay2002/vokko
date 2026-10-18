//! Remote cameras and screen shares for the page. The page pulls decoded frames one at a time (`native_voice_video_frame`)
//! while a tile shows them, so a slow page drops frames here (the stream keeps only the newest) instead of queueing them.
//! Same policy as livekitVideo.ts: cameras are always subscribed, a screen share and its audio only while watched.

use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::RtcVideoTrack;
use livekit::webrtc::prelude::VideoBuffer;
use livekit::webrtc::video_stream::native::{NativeVideoStream, NativeVideoStreamOptions};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long one pull waits for a frame before answering "none yet", so the page's loop can notice a detached tile.
const PULL_WAIT: Duration = Duration::from_millis(500);
const MAX_WIDTH: u32 = 3840;
const MAX_HEIGHT: u32 = 2160;

type Stream = Arc<tokio::sync::Mutex<NativeVideoStream>>;

#[derive(Default)]
pub struct Videos {
    /// Subscribed remote video tracks by track sid.
    streams: Mutex<HashMap<String, Stream>>,
    /// Users whose screen share we watch.
    watching: Mutex<HashSet<String>>,
    /// Stream quality menu choice by `{user}:{camera|screen}` ("auto", "source", "720p", ...).
    qualities: Mutex<HashMap<String, String>>,
}

pub fn source_name(source: TrackSource) -> Option<&'static str> {
    match source {
        TrackSource::Camera => Some("camera"),
        TrackSource::Screenshare => Some("screen"),
        _ => None,
    }
}

impl Videos {
    pub fn watching(&self, identity: &str) -> bool {
        self.watching.lock().is_ok_and(|w| w.contains(identity))
    }

    pub fn set_watching(&self, identity: &str, watch: bool) {
        if let Ok(mut watching) = self.watching.lock() {
            if watch {
                watching.insert(identity.to_owned());
            } else {
                watching.remove(identity);
            }
        }
    }

    pub fn set_quality(&self, identity: &str, source: &str, quality: String) {
        if let Ok(mut qualities) = self.qualities.lock() {
            qualities.insert(format!("{identity}:{source}"), quality);
        }
    }

    /// Subscription policy for one video-side publication; false when the publication isn't one of ours to handle.
    pub fn consider(&self, publication: &RemoteTrackPublication, identity: &str) -> bool {
        let wanted = match publication.source() {
            TrackSource::Camera => true,
            TrackSource::Screenshare | TrackSource::ScreenshareAudio => self.watching(identity),
            _ => return false,
        };
        if publication.is_subscribed() != wanted {
            publication.set_subscribed(wanted);
        }
        self.apply_quality(publication, identity);
        true
    }

    /// "480p"/"720p"/... caps the layer by size; anything else ("auto", "source") asks for the best one.
    pub fn apply_quality(&self, publication: &RemoteTrackPublication, identity: &str) {
        let Some(source) = source_name(publication.source()) else { return };
        if !publication.is_subscribed() {
            return;
        }
        let quality = self.qualities.lock().ok().and_then(|q| q.get(&format!("{identity}:{source}")).cloned()).unwrap_or_default();
        match quality.strip_suffix('p').and_then(|h| h.parse::<u32>().ok()) {
            Some(height) => publication.update_video_dimensions(TrackDimension(height * 16 / 9, height)),
            None if publication.simulcasted() => publication.set_video_quality(VideoQuality::High),
            None => {}
        }
    }

    pub fn add(&self, track: &RemoteVideoTrack) -> String {
        let sid = track.sid().to_string();
        self.insert(sid.clone(), track.rtc_track());
        sid
    }

    pub fn insert(&self, sid: String, track: RtcVideoTrack) {
        // A one-frame queue keeps only the newest frame: a page that pulls slower than the sender drops frames, never lags.
        let stream = NativeVideoStream::with_options(track, NativeVideoStreamOptions { queue_size_frames: Some(1) });
        if let Ok(mut streams) = self.streams.lock() {
            streams.insert(sid, Arc::new(tokio::sync::Mutex::new(stream)));
        }
    }

    pub fn remove(&self, sid: &str) -> bool {
        self.streams.lock().is_ok_and(|mut s| s.remove(sid).is_some())
    }

    pub fn clear(&self) {
        if let Ok(mut streams) = self.streams.lock() {
            streams.clear();
        }
        if let Ok(mut watching) = self.watching.lock() {
            watching.clear();
        }
        if let Ok(mut qualities) = self.qualities.lock() {
            qualities.clear();
        }
    }

    /// The next frame of a track as `width u32 LE, height u32 LE, RGBA`, scaled down to fit `max_width` x `max_height`
    /// (0 = no limit). Empty when no frame came within PULL_WAIT; an error when the track is gone.
    pub async fn frame(&self, sid: &str, max_width: u32, max_height: u32) -> Result<Vec<u8>, String> {
        let stream = self.streams.lock().ok().and_then(|s| s.get(sid).cloned()).ok_or("gone")?;
        let mut stream = stream.lock().await;
        let frame = match tokio::time::timeout(PULL_WAIT, futures_util::StreamExt::next(&mut *stream)).await {
            Ok(Some(frame)) => frame,
            Ok(None) => return Err("gone".into()),
            Err(_) => return Ok(Vec::new()),
        };
        drop(stream);
        tauri::async_runtime::spawn_blocking(move || {
            let mut i420 = frame.buffer.to_i420();
            // A remote peer picks the frame size: never hand the page more than 4K (and keep the size math small).
            let limit = |max: u32, cap: u32| if max == 0 { cap } else { max.min(cap) };
            let (width, height) = fit(i420.width(), i420.height(), limit(max_width, MAX_WIDTH), limit(max_height, MAX_HEIGHT));
            if (width, height) != (i420.width(), i420.height()) {
                i420 = i420.scale(width as i32, height as i32);
            }
            let mut out = vec![0u8; 8 + width as usize * height as usize * 4];
            out[..4].copy_from_slice(&width.to_le_bytes());
            out[4..8].copy_from_slice(&height.to_le_bytes());
            let (y, u, v) = i420.data();
            let (stride_y, stride_u, stride_v) = i420.strides();
            // libyuv names formats by 32-bit word order: its ABGR is R, G, B, A in memory, which is canvas ImageData.
            yuv_helper::i420_to_abgr(y, stride_y, u, stride_u, v, stride_v, &mut out[8..], width * 4, width as i32, height as i32);
            out
        })
        .await
        .map_err(|e| e.to_string())
    }
}

/// The largest size within the limits with the frame's aspect ratio, even (I420 halves chroma) and never upscaled.
pub(super) fn fit(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let scale = [(max_width, width), (max_height, height)]
        .iter()
        .filter(|(max, _)| *max > 0)
        .map(|(max, size)| f64::from(*max) / f64::from((*size).max(1)))
        .fold(1.0_f64, f64::min);
    if scale >= 1.0 {
        return (width, height);
    }
    let even = |v: f64| ((v.round() as u32) & !1).max(2);
    (even(f64::from(width) * scale), even(f64::from(height) * scale))
}

#[cfg(test)]
mod tests {
    use super::{Videos, fit};
    use livekit::prelude::*;
    use livekit::webrtc::prelude::{I420Buffer, RtcVideoSource, VideoFrame, VideoResolution, VideoRotation};
    use livekit::webrtc::video_source::native::NativeVideoSource;

    #[test]
    fn slow_puller_gets_the_newest_frame() {
        // The source starts a keepalive task, so it needs a runtime.
        tauri::async_runtime::block_on(newest_frame());
    }

    async fn newest_frame() {
        let source = NativeVideoSource::new(VideoResolution { width: 64, height: 64 }, false);
        let track = LocalVideoTrack::create_video_track("test", RtcVideoSource::Native(source.clone()));
        let videos = Videos::default();
        videos.insert("t".into(), track.rtc_track());
        // Five frames before the page pulls: widths 16, 18, ..., 24 tell them apart.
        for i in 0..5u32 {
            let frame = VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: i64::from(i) * 33_000,
                frame_metadata: None,
                buffer: I420Buffer::new(16 + 2 * i, 16),
            };
            source.capture_frame(&frame);
        }
        let pulled = videos.frame("t", 0, 0).await.unwrap();
        assert_eq!(u32::from_le_bytes([pulled[0], pulled[1], pulled[2], pulled[3]]), 24);
        // Nothing else was queued behind it.
        assert!(videos.frame("t", 0, 0).await.unwrap().is_empty());
    }

    #[test]
    fn fit_scales_down_only() {
        assert_eq!(fit(1920, 1080, 0, 0), (1920, 1080));
        assert_eq!(fit(1920, 1080, 3840, 2160), (1920, 1080));
        assert_eq!(fit(1920, 1080, 1280, 0), (1280, 720));
        assert_eq!(fit(1920, 1080, 1280, 360), (640, 360));
        assert_eq!(fit(641, 481, 320, 0), (320, 240));
    }
}
