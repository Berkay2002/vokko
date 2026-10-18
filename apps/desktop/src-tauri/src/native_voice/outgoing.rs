//! Our camera and screen share. A capture thread turns each frame into I420, scales it down to the chosen size and hands
//! it to a NativeVideoSource, which libwebrtc encodes (VP8 simulcast, the layers the page planned with options.ts).
//! Cameras come from V4L2 (MJPEG preferred, YUYV otherwise); screens from libwebrtc's desktop capturer: the
//! xdg-desktop-portal ScreenCast + PipeWire path on Wayland (the portal shows its own picker), the whole X11 screen
//! otherwise. libwebrtc loads libpipewire / libX11 itself when a capture starts.

use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding, VideoPreset};
use livekit::prelude::*;
use livekit::webrtc::desktop_capturer::{CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, RtcVideoSource, VideoBuffer, VideoFrame, VideoResolution, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Camera,
    Screen,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Camera => "camera",
            Kind::Screen => "screen",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    width: u32,
    height: u32,
    max_bitrate: u64,
    max_framerate: f64,
}

/// What the page asks for: the top size and frame rate, its bitrate, the layers under it (lowest first) and, for a
/// camera, the V4L2 device path (absent or unknown: the first camera).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPlan {
    width: u32,
    height: u32,
    fps: u32,
    max_bitrate: u64,
    #[serde(default)]
    layers: Vec<Layer>,
    #[serde(default)]
    device_id: Option<String>,
}

/// Why a capture didn't start, in the page's videoFailed terms; Cancelled is the portal picker closed (not an error).
#[derive(Debug, PartialEq)]
pub enum StartError {
    Cancelled,
    Failed(&'static str),
}

/// Frames into a source, scaled down to fit the plan.
struct Feed {
    source: NativeVideoSource,
    width: u32,
    height: u32,
    stop: Arc<AtomicBool>,
}

impl Feed {
    fn push(&self, mut frame: I420Buffer) {
        let (width, height) = super::video::fit(frame.width(), frame.height(), self.width, self.height);
        if (width, height) != (frame.width(), frame.height()) {
            frame = frame.scale(width as i32, height as i32);
        }
        self.source.capture_frame(&VideoFrame { rotation: VideoRotation::VideoRotation0, timestamp_us: 0, frame_metadata: None, buffer: frame });
    }
}

/// A capture being published. Dropping it stops the capture thread (it exits at its next frame).
pub struct Outgoing {
    pub kind: Kind,
    pub publication: LocalTrackPublication,
    stop: Arc<AtomicBool>,
}

impl Drop for Outgoing {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// How long a capture may take to open: the portal's picker waits on the user, but not forever.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// Opens the capture, publishes it once the first frame is on its way, and calls `ended` when the capture stops on its
/// own (camera unplugged, the portal session closed). The caller unpublishes then. The caller keeps `stop` while the
/// capture opens: setting it cancels the start.
pub async fn start(
    room: &Room,
    kind: Kind,
    plan: VideoPlan,
    stop: Arc<AtomicBool>,
    ended: impl FnOnce() + Send + 'static,
) -> Result<(Outgoing, LocalVideoTrack), StartError> {
    let source = NativeVideoSource::new(VideoResolution { width: plan.width, height: plan.height }, kind == Kind::Screen);
    let feed = Feed { source: source.clone(), width: plan.width, height: plan.height, stop: stop.clone() };
    let (ready, started) = oneshot::channel();
    let fps = plan.fps.clamp(1, 60);
    let device = plan.device_id.clone();
    let spawned = std::thread::Builder::new().name(format!("native {}", kind.name())).spawn(move || {
        let stop = feed.stop.clone();
        match kind {
            Kind::Camera => camera(device, fps, &feed, ready),
            Kind::Screen => screen(fps, &feed, ready),
        }
        if !stop.load(Ordering::Relaxed) {
            ended();
        }
    });
    if let Err(error) = spawned {
        log::warn!("native voice: {} thread: {error}", kind.name());
        return Err(StartError::Failed("failed"));
    }
    let result = match tokio::time::timeout(START_TIMEOUT, started).await {
        Ok(result) => result.unwrap_or(Err(StartError::Failed("failed"))),
        Err(_) => {
            log::warn!("native voice: {} didn't start within {START_TIMEOUT:?}", kind.name());
            Err(StartError::Failed("failed"))
        }
    };
    if stop.load(Ordering::Relaxed) {
        return Err(StartError::Cancelled);
    }
    if let Err(error) = result {
        stop.store(true, Ordering::Relaxed);
        return Err(error);
    }
    let track = LocalVideoTrack::create_video_track(kind.name(), RtcVideoSource::Native(source));
    let encoding = |max_bitrate, max_framerate| VideoEncoding { max_bitrate, max_framerate };
    let options = TrackPublishOptions {
        source: if kind == Kind::Camera { TrackSource::Camera } else { TrackSource::Screenshare },
        video_codec: VideoCodec::VP8,
        simulcast: !plan.layers.is_empty(),
        video_encoding: Some(encoding(plan.max_bitrate, f64::from(fps))),
        simulcast_layers: (!plan.layers.is_empty()).then(|| {
            plan.layers.iter().map(|l| VideoPreset { encoding: encoding(l.max_bitrate, l.max_framerate), width: l.width, height: l.height }).collect()
        }),
        ..Default::default()
    };
    match room.local_participant().publish_track(LocalTrack::Video(track.clone()), options).await {
        Ok(publication) => Ok((Outgoing { kind, publication, stop }, track)),
        Err(error) => {
            stop.store(true, Ordering::Relaxed);
            log::warn!("native voice: {} publish failed: {error}", kind.name());
            Err(StartError::Failed("failed"))
        }
    }
}

type Ready = oneshot::Sender<Result<(), StartError>>;

// ---- camera ----

fn open_camera(path: Option<String>) -> Result<linuxvideo::Device, StartError> {
    let denied = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::PermissionDenied => StartError::Failed("permission_denied"),
        std::io::ErrorKind::NotFound => StartError::Failed("not_found"),
        _ => StartError::Failed("failed"),
    };
    if let Some(path) = path.filter(|p| p.starts_with("/dev/video")) {
        return linuxvideo::Device::open(std::path::Path::new(&path)).map_err(denied);
    }
    // The first device that captures video in a format we read (UVC cameras also list a metadata node).
    for device in linuxvideo::list().map_err(denied)? {
        let Ok(device) = device else { continue };
        if device.formats(linuxvideo::BufType::VIDEO_CAPTURE).any(|f| f.is_ok_and(|f| pixel_kind(f.pixel_format()).is_some())) {
            return Ok(device);
        }
    }
    Err(StartError::Failed("not_found"))
}

#[derive(Clone, Copy, PartialEq)]
enum Pixels {
    Mjpeg,
    Yuyv,
}

fn pixel_kind(format: linuxvideo::format::PixelFormat) -> Option<Pixels> {
    use linuxvideo::format::PixelFormat;
    match format {
        f if f == PixelFormat::MJPG || f == PixelFormat::JPEG => Some(Pixels::Mjpeg),
        f if f == PixelFormat::YUYV => Some(Pixels::Yuyv),
        _ => None,
    }
}

const EBUSY: i32 = 16;

struct Opened {
    stream: linuxvideo::stream::ReadStream,
    width: u32,
    height: u32,
    stride: u32,
    pixels: Pixels,
}

/// Opens the camera and starts streaming. Err(None): the device is busy.
fn open_stream(path: Option<String>, width: u32, height: u32, fps: u32) -> Result<Opened, Option<StartError>> {
    use linuxvideo::format::{PixFormat, PixelFormat};
    let failed = |what: &str, error: std::io::Error| {
        if error.raw_os_error() == Some(EBUSY) {
            return None;
        }
        log::warn!("native voice: camera {what}: {error}");
        Some(StartError::Failed("failed"))
    };
    let device = open_camera(path).map_err(Some)?;
    // MJPEG first: most USB cameras send 720p / 1080p at 30 fps only that way (YUYV tops out around 10 fps there).
    let formats: Vec<_> = device.formats(linuxvideo::BufType::VIDEO_CAPTURE).filter_map(|f| f.ok()).map(|f| f.pixel_format()).collect();
    let wanted = if formats.iter().any(|f| pixel_kind(*f) == Some(Pixels::Mjpeg)) { PixelFormat::MJPG } else { PixelFormat::YUYV };
    let capture = device.video_capture(PixFormat::new(width, height, wanted)).map_err(|e| failed("format", e))?;
    let format = capture.format();
    let (width, height, stride) = (format.width(), format.height(), format.bytes_per_line());
    let pixels = pixel_kind(format.pixel_format()).ok_or(Some(StartError::Failed("failed")))?;
    let _ = capture.set_frame_interval(linuxvideo::Fract::new(1, fps));
    let stream = capture.into_stream().map_err(|e| failed("stream", e))?;
    Ok(Opened { stream, width, height, stride, pixels })
}

fn camera(path: Option<String>, fps: u32, feed: &Feed, ready: Ready) {
    // The page's preview (WebKit) or our previous capture may still be letting go of the device: retry for a second.
    let deadline = Instant::now() + Duration::from_secs(1);
    let opened = loop {
        match open_stream(path.clone(), feed.width, feed.height, fps) {
            Ok(opened) => break opened,
            Err(None) if Instant::now() < deadline && !feed.stop.load(Ordering::Relaxed) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                if error.is_none() {
                    log::warn!("native voice: camera busy");
                }
                let _ = ready.send(Err(error.unwrap_or(StartError::Failed("failed"))));
                return;
            }
        }
    };
    let Opened { mut stream, width, height, stride, pixels } = opened;
    let _ = ready.send(Ok(()));
    while !feed.stop.load(Ordering::Relaxed) {
        let frame = stream.dequeue(|data| {
            Ok(match pixels {
                Pixels::Yuyv => yuyv_to_i420(&data, width, height, stride),
                Pixels::Mjpeg => mjpeg_to_i420(&data),
            })
        });
        match frame {
            Ok(Some(frame)) => feed.push(frame),
            // A corrupt MJPEG frame (USB hiccup): skip it.
            Ok(None) => {}
            Err(error) => {
                log::warn!("native voice: camera stopped: {error}");
                return;
            }
        }
    }
}

/// Packed 4:2:2 (Y0 U Y1 V) to I420: luma as is, chroma from the even rows. None for a short buffer: I420Buffer::new
/// isn't cleared, so every pixel must be written (even sizes only).
fn yuyv_to_i420(data: &[u8], width: u32, height: u32, stride: u32) -> Option<I420Buffer> {
    let (width, height) = (width & !1, height & !1);
    if width == 0 || height == 0 || data.len() < (height as usize - 1) * stride as usize + width as usize * 2 {
        return None;
    }
    let mut out = I420Buffer::new(width, height);
    let (stride_y, stride_u, stride_v) = out.strides();
    let (y, u, v) = out.data_mut();
    let (width, stride) = (width as usize, stride as usize);
    for row in 0..height as usize {
        let line = &data[row * stride..row * stride + width * 2];
        let luma = &mut y[row * stride_y as usize..][..width];
        for (dst, src) in luma.iter_mut().zip(line.iter().step_by(2)) {
            *dst = *src;
        }
        if row % 2 == 0 {
            let (u_row, v_row) = (&mut u[row / 2 * stride_u as usize..], &mut v[row / 2 * stride_v as usize..]);
            for (i, pair) in line.as_chunks::<4>().0.iter().enumerate() {
                u_row[i] = pair[1];
                v_row[i] = pair[3];
            }
        }
    }
    Some(out)
}

/// JPEG's YCbCr is full range (0-255), I420 for the encoder limited range: luma 16-235 (`span` 219), chroma 16-240 (224).
fn limited(value: u8, span: u32) -> u8 {
    let scaled = 16 + (u32::from(value) * span + 127) / 255;
    u8::try_from(scaled).unwrap_or(u8::MAX)
}

/// Decodes one MJPEG frame to YCbCr (no colour conversion), rescales it to limited range and subsamples the chroma to I420.
fn mjpeg_to_i420(data: &[u8]) -> Option<I420Buffer> {
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(data, DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::YCbCr));
    let pixels = decoder.decode().ok()?;
    let (width, height) = decoder.dimensions()?;
    // Three bytes a pixel, or the camera sent something other than colour JPEG.
    if pixels.len() != width * height * 3 {
        return None;
    }
    let src_width = width;
    let (width, height) = (width & !1, height & !1);
    if width == 0 || height == 0 {
        return None;
    }
    let mut out = I420Buffer::new(width as u32, height as u32);
    let (stride_y, stride_u, stride_v) = out.strides();
    let (y, u, v) = out.data_mut();
    for row in 0..height {
        let line = pixels.get(row * src_width * 3..(row * src_width + width) * 3)?;
        let luma = &mut y[row * stride_y as usize..][..width];
        for (dst, px) in luma.iter_mut().zip(line.as_chunks::<3>().0) {
            *dst = limited(px[0], 219);
        }
        if row % 2 == 0 {
            let (u_row, v_row) = (&mut u[row / 2 * stride_u as usize..], &mut v[row / 2 * stride_v as usize..]);
            for (i, px) in line.as_chunks::<6>().0.iter().enumerate() {
                u_row[i] = limited(px[1], 224);
                v_row[i] = limited(px[2], 224);
            }
        }
    }
    Some(out)
}

// ---- screen ----

fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland")
}

fn screen(fps: u32, feed: &Feed, ready: Ready) {
    let portal = wayland();
    let mut options = DesktopCapturerOptions::new(if portal { DesktopCaptureSourceType::Generic } else { DesktopCaptureSourceType::Screen });
    options.set_include_cursor(true);
    let Some(mut capturer) = DesktopCapturer::new(options) else {
        let _ = ready.send(Err(StartError::Failed("failed")));
        return;
    };
    // X11 has no picker here: the whole screen (all monitors). The portal asks the user in its own dialog.
    let source = if portal { None } else { capturer.get_source_list().into_iter().next() };
    let (frames_tx, frames_rx) = std::sync::mpsc::sync_channel::<Result<I420Buffer, CaptureError>>(1);
    capturer.start_capture(source, move |result| {
        let frame = result.and_then(|frame| {
            let (width, height) = (frame.width() & !1, frame.height() & !1);
            if width <= 0 || height <= 0 {
                return Err(CaptureError::Temporary);
            }
            let mut out = I420Buffer::new(width as u32, height as u32);
            let (stride_y, stride_u, stride_v) = out.strides();
            let (y, u, v) = out.data_mut();
            // DesktopFrame is BGRA in memory, which libyuv calls ARGB.
            yuv_helper::argb_to_i420(frame.data(), frame.stride(), y, stride_y, u, stride_u, v, stride_v, width, height);
            Ok(out)
        });
        let _ = frames_tx.try_send(frame);
    });
    let mut ready = Some(ready);
    let interval = Duration::from_secs_f64(1.0 / f64::from(fps));
    let mut next = Instant::now();
    while !feed.stop.load(Ordering::Relaxed) {
        capturer.capture_frame();
        match frames_rx.try_recv() {
            Ok(Ok(frame)) => {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Ok(()));
                }
                feed.push(frame);
            }
            // The portal picker was closed, or the session ended (the compositor's "stop sharing").
            Ok(Err(CaptureError::Permanent)) => {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Err(if portal { StartError::Cancelled } else { StartError::Failed("failed") }));
                }
                return;
            }
            _ => {}
        }
        next += interval;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{limited, yuyv_to_i420};

    #[test]
    fn full_range_maps_to_limited_range() {
        assert_eq!([limited(0, 219), limited(128, 219), limited(255, 219)], [16, 126, 235]);
        assert_eq!([limited(0, 224), limited(128, 224), limited(255, 224)], [16, 128, 240]);
    }

    #[test]
    fn yuyv_keeps_luma_and_takes_chroma_from_even_rows() {
        // 4x2, stride 10 (two bytes of padding per row): row 0 Y 10..13, U 1/3, V 2/4; row 1's chroma is dropped.
        let data = [10, 1, 11, 2, 12, 3, 13, 4, 0, 0, 20, 9, 21, 9, 22, 9, 23, 9, 0, 0];
        assert!(yuyv_to_i420(&data[..17], 4, 2, 10).is_none());
        let out = yuyv_to_i420(&data, 4, 2, 10).unwrap();
        let (y, u, v) = out.data();
        let (stride_y, _, _) = out.strides();
        assert_eq!(&y[..4], &[10, 11, 12, 13]);
        assert_eq!(&y[stride_y as usize..][..4], &[20, 21, 22, 23]);
        assert_eq!(&u[..2], &[1, 3]);
        assert_eq!(&v[..2], &[2, 4]);
    }
}
