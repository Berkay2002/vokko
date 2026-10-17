// Quality choices → LiveKit capture and publish options (docs/design/voice.md §4.3 / §4.4, everything unlocked: Vokko is free).
// Pure data in, plain objects out, so the mapping is unit-tested without livekit-client or a browser; the transport turns
// the plain simulcast layers into VideoPreset instances.

export type ScreenResolution = "720p" | "1080p" | "1440p" | "source";
export type ScreenFps = 15 | 30 | 60;
export type StreamContent = "motion" | "detail";
export type CameraResolution = "720p" | "1080p";
/** What a viewer asks the SFU for on a remote video: Auto follows the tile size, "<height>p" caps it at that layer. */
export type ViewerQuality = "auto" | "source" | `${number}p`;
export type VideoCodecName = "av1" | "vp9" | "h264" | "vp8";

export const SCREEN_RESOLUTIONS: readonly ScreenResolution[] = ["720p", "1080p", "1440p", "source"];
export const SCREEN_FPS: readonly ScreenFps[] = [15, 30, 60];
export const CAMERA_RESOLUTIONS: readonly CameraResolution[] = ["720p", "1080p"];
/** The settings default's choices (no stream to read layers from there). */
export const VIEWER_QUALITIES: readonly ViewerQuality[] = ["auto", "source", "720p", "480p"];

export interface ScreenShareChoice {
  resolution: ScreenResolution;
  fps: ScreenFps;
  /** Share the audio of the tab / window / system where the platform offers it. */
  audio: boolean;
  /** "detail" keeps text crisp (drops frames first), "motion" keeps it smooth (drops resolution first). Default: 60 fps = motion. */
  content?: StreamContent;
}

export const DEFAULT_SCREEN_SHARE: ScreenShareChoice = { resolution: "1080p", fps: 30, audio: true };

export const RESOLUTION_LABEL: Record<ScreenResolution, string> = { "720p": "720p", "1080p": "1080p", "1440p": "1440p", source: "Source" };

const DIMENSIONS: Record<Exclude<ScreenResolution, "source">, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
};
/** "Source" asks the browser for the largest capture it will give (the display's native size, up to 4K). */
const SOURCE_DIMENSIONS = { width: 3840, height: 2160 };

/** Target bitrate in bits per second, from the design doc's 720p30 = 2 Mbps and 1080p60 = 6 Mbps, scaled for the rest. */
const SCREEN_BITRATE: Record<ScreenResolution, Record<ScreenFps, number>> = {
  "720p": { 15: 1_200_000, 30: 2_000_000, 60: 3_000_000 },
  "1080p": { 15: 2_500_000, 30: 4_000_000, 60: 6_000_000 },
  "1440p": { 15: 4_500_000, 30: 7_000_000, 60: 10_000_000 },
  source: { 15: 6_000_000, 30: 9_000_000, 60: 12_000_000 },
};

export function dimensionsOf(resolution: ScreenResolution): { width: number; height: number } {
  return resolution === "source" ? SOURCE_DIMENSIONS : DIMENSIONS[resolution];
}

export function contentHintOf(choice: Pick<ScreenShareChoice, "fps" | "content">): StreamContent {
  return choice.content ?? (choice.fps >= 60 ? "motion" : "detail");
}

export interface PlainPreset {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
}

export interface EncodingPlan {
  codec: VideoCodecName;
  /** Codec for subscribers that cannot decode `codec` (only offered when `codec` is not already the broadest one). */
  backupCodec: "vp8" | "h264" | false;
  /** vp8 / h264 are published as simulcast layers; vp9 / av1 as one SVC stream (layers inside, `simulcast` is ignored). */
  simulcast: boolean;
  scalabilityMode?: "L1T3" | "L3T3_KEY";
  encoding: { maxBitrate: number; maxFramerate: number };
  /** Extra layers below the primary one, lowest first. Empty for SVC codecs. */
  layers: PlainPreset[];
  degradationPreference: "maintain-framerate" | "maintain-resolution";
}

export interface CodecSupport {
  av1?: boolean;
  vp9?: boolean;
  h264?: boolean;
  vp8?: boolean;
  /** Codecs the system reports it can encode in hardware (MediaCapabilities `powerEfficient`), once probed. */
  hardware?: Partial<Record<VideoCodecName, boolean>>;
  /** VP9 / AV1 can be sent as rid simulcast (Chromium 113+). False on WebKit, where LiveKit would fall back to one layer. */
  svcSimulcast?: boolean;
}

/**
 * Preferred codec order: VP9 (best screen-content tools, broad hardware decode), then AV1, then VP8 (every browser),
 * then H.264. AV1 goes first only for the largest streams and only when the system reports AV1 hardware encode:
 * software AV1 at 1440p or Source costs more CPU than the stream saves, so otherwise codecs the hardware encodes
 * lead and AV1 keeps its normal place.
 */
export function codecOrder(resolution: ScreenResolution | CameraResolution, hardware?: CodecSupport["hardware"]): VideoCodecName[] {
  const normal: VideoCodecName[] = ["vp9", "av1", "vp8", "h264"];
  const big = resolution === "1440p" || resolution === "source";
  if (!big) return normal;
  if (hardware?.av1) return ["av1", "vp9", "vp8", "h264"];
  const accelerated = normal.filter(codec => codec !== "av1" && hardware?.[codec]);
  return [...accelerated, ...normal.filter(codec => !accelerated.includes(codec))];
}

/** First supported codec in `order`; VP8 when nothing is known (the one every WebRTC browser must implement). */
export function pickCodec(order: readonly VideoCodecName[], support: CodecSupport): VideoCodecName {
  return order.find(codec => support[codec]) ?? "vp8";
}

function backupFor(codec: VideoCodecName, support: CodecSupport): "vp8" | "h264" | false {
  if (codec === "vp8" || codec === "h264") return false;
  if (support.vp8 !== false) return "vp8";
  return support.h264 ? "h264" : false;
}

/** Codecs the browser can send, from RTCRtpSender.getCapabilities("video") mime types. */
export function codecSupportFrom(mimeTypes: readonly string[] | null | undefined): CodecSupport {
  const lower = (mimeTypes ?? []).map(m => m.toLowerCase());
  const has = (name: string) => lower.includes(`video/${name}`);
  return { av1: has("av1"), vp9: has("vp9"), h264: has("h264"), vp8: has("vp8") };
}

let hardwareEncoders: CodecSupport["hardware"];
let hardwareProbe: Promise<void> | null = null;

/**
 * Asks MediaCapabilities which codecs the system encodes in hardware at the top stream size (2560x1440, 60 fps).
 * Fire and forget: the answer lands in `detectCodecSupport().hardware` a few milliseconds later, long before anyone
 * opens Go Live; until then (and where MediaCapabilities has no WebRTC support) nothing is assumed accelerated.
 */
export function probeHardwareEncoders(): Promise<void> {
  hardwareProbe ??= (async () => {
    const mediaCapabilities = typeof navigator === "undefined" ? undefined : navigator.mediaCapabilities;
    if (!mediaCapabilities?.encodingInfo) return;
    const types: Record<VideoCodecName, string> = { av1: "video/AV1", vp9: "video/VP9", h264: "video/H264", vp8: "video/VP8" };
    const found: Partial<Record<VideoCodecName, boolean>> = {};
    await Promise.all(
      (Object.keys(types) as VideoCodecName[]).map(async codec => {
        try {
          const info = await mediaCapabilities.encodingInfo({
            type: "webrtc",
            video: { contentType: types[codec], width: 2560, height: 1440, framerate: 60, bitrate: 10_000_000 },
          });
          found[codec] = info.supported && info.powerEfficient;
        } catch {
          found[codec] = false;
        }
      }),
    );
    hardwareEncoders = found;
  })();
  return hardwareProbe;
}

/** Reads what this browser can encode. Unknown (no WebRTC, SSR, tests): VP8 only. */
export function detectCodecSupport(): CodecSupport {
  try {
    void probeHardwareEncoders();
    const caps = typeof RTCRtpSender !== "undefined" ? RTCRtpSender.getCapabilities?.("video") : null;
    const found = codecSupportFrom(caps?.codecs.map(c => c.mimeType));
    const svcSimulcast = !isWebKit(typeof navigator === "undefined" ? "" : navigator.userAgent);
    return found.vp8 || found.vp9 || found.h264 || found.av1 ? { ...found, hardware: hardwareEncoders, svcSimulcast } : { vp8: true };
  } catch {
    return { vp8: true };
  }
}

/**
 * Whether the SFU takes VP9 / AV1 as rid simulcast: livekit-client only sends it to servers newer than 1.13.6
 * (isSVCSimulcastSupportedByServer) and otherwise silently publishes one SVC layer. Unknown counts as too old.
 */
export function serverTakesSvcSimulcast(version: string | undefined): boolean {
  const parts = (version ?? "").split(".").map(p => Number.parseInt(p, 10));
  if (parts.length < 3 || parts.some(Number.isNaN)) return false;
  const [major, minor, patch] = parts;
  return major !== 1 ? major > 1 : minor !== 13 ? minor > 13 : patch > 6;
}

/** Safari and WKWebView (the macOS app): no getDisplayMedia audio and only legacy SVC encodings. */
export function isWebKit(userAgent: string): boolean {
  return /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent);
}

/** Why a share asked for audio but got none, in the platform's terms. */
export function missingAudioNote(userAgent: string): string {
  if (isWebKit(userAgent)) return "Your stream has no sound: this system can't share audio from a screen share.";
  return 'Your stream has no sound: sound is only shared from a whole screen with "Share system audio" turned on (or a browser tab), not from a window.';
}

function layer(width: number, height: number, maxBitrate: number, maxFramerate: number): PlainPreset {
  return { width, height, maxBitrate, maxFramerate };
}

export interface ScreenShareRequest {
  /** getDisplayMedia constraints (LiveKit ScreenShareCaptureOptions without the `systemAudio`-style browser hints). */
  capture: {
    audio: boolean;
    resolution: { width: number; height: number; frameRate: number };
    contentHint: StreamContent;
  };
  publish: EncodingPlan;
}

/**
 * Simulcast layers under a share, lowest first, so viewers on Auto (a small tile, a slow link) switch down instead of
 * stalling: 360p at up to 30 fps under everything, plus 720p at the share's frame rate under the bigger sizes.
 */
export function screenLayers(choice: Pick<ScreenShareChoice, "resolution" | "fps">): PlainPreset[] {
  const low = layer(640, 360, 500_000, Math.min(choice.fps, 30));
  return choice.resolution === "720p" ? [low] : [low, layer(1280, 720, SCREEN_BITRATE["720p"][choice.fps], choice.fps)];
}

export function buildScreenShare(choice: ScreenShareChoice, support: CodecSupport = detectCodecSupport()): ScreenShareRequest {
  const size = dimensionsOf(choice.resolution);
  const content = contentHintOf(choice);
  // VP9 / AV1 screen shares go out as rid simulcast with L1T3 per layer. As one SVC stream LiveKit would force a single
  // spatial layer (and contentHint "motion"), so where that simulcast is unavailable VP8 / H.264 take over.
  const order = codecOrder(choice.resolution, support.hardware).filter(c => support.svcSimulcast !== false || (c !== "vp9" && c !== "av1"));
  const codec = pickCodec(order, support);
  const svc = codec === "vp9" || codec === "av1";
  const bitrate = SCREEN_BITRATE[choice.resolution][choice.fps];
  const layers = screenLayers(choice);
  return {
    capture: { audio: choice.audio, resolution: { ...size, frameRate: choice.fps }, contentHint: content },
    publish: {
      codec,
      backupCodec: backupFor(codec, support),
      simulcast: true,
      scalabilityMode: svc ? "L1T3" : undefined,
      encoding: { maxBitrate: bitrate, maxFramerate: choice.fps },
      layers,
      degradationPreference: content === "detail" ? "maintain-resolution" : "maintain-framerate",
    },
  };
}

export interface CameraRequest {
  capture: { width: number; height: number; frameRate: number };
  publish: EncodingPlan;
}

/** 180p / 360p / 720p at 30 fps with 150 / 500 / 1200 kbps (design §4.3); the 1080p option adds a top layer at 2.5 Mbps. */
export function buildCamera(resolution: CameraResolution, support: CodecSupport = detectCodecSupport()): CameraRequest {
  const full = resolution === "1080p";
  const codec = pickCodec(codecOrder(resolution, support.hardware), support);
  const svc = codec === "vp9" || codec === "av1";
  const top = full ? layer(1920, 1080, 2_500_000, 30) : layer(1280, 720, 1_200_000, 30);
  const layers = svc ? [] : full ? [layer(320, 180, 150_000, 30), layer(640, 360, 500_000, 30), layer(1280, 720, 1_200_000, 30)] : [layer(320, 180, 150_000, 30), layer(640, 360, 500_000, 30)];
  return {
    capture: { width: top.width, height: top.height, frameRate: 30 },
    publish: {
      codec,
      backupCodec: backupFor(codec, support),
      simulcast: !svc,
      scalabilityMode: svc ? "L3T3_KEY" : undefined,
      encoding: { maxBitrate: top.maxBitrate, maxFramerate: 30 },
      layers,
      degradationPreference: "maintain-framerate",
    },
  };
}

export type LayerQuality = "high" | "medium" | "low";

/** A layer a remote stream is published with (from its TrackInfo). */
export interface StreamLayer {
  width: number;
  height: number;
  quality: LayerQuality;
}

/** What a viewer's quality choice becomes on a RemoteTrackPublication. */
export type ViewerRequest = { kind: "quality"; quality: LayerQuality } | { kind: "dimensions"; width: number; height: number };

/**
 * Auto and Source both ask for the top layer: with adaptive stream on, LiveKit already lowers it to what the tile
 * shows, so Auto = "as big as the tile" and Source = "never less than the tile can show".
 * "<height>p" picks the tallest layer not above that height (the smallest when all are); without known layers it caps
 * the size by 16:9 dimensions (never above the tile either).
 */
export function viewerRequest(choice: ViewerQuality, layers?: readonly StreamLayer[]): ViewerRequest {
  if (choice === "auto" || choice === "source") return { kind: "quality", quality: "high" };
  const height = Number.parseInt(choice, 10);
  if (layers?.length) {
    const tallestFirst = [...layers].sort((a, b) => b.height - a.height);
    const fit = tallestFirst.find(l => l.height <= height) ?? tallestFirst[tallestFirst.length - 1];
    return { kind: "quality", quality: fit.quality };
  }
  return { kind: "dimensions", width: Math.round((height * 16) / 9), height };
}

/** The stream quality menu: Auto, Source and every lower layer the stream really has (the settings list while unknown). */
export function viewerChoices(layers?: readonly StreamLayer[]): ViewerQuality[] {
  if (!layers?.length) return [...VIEWER_QUALITIES];
  const heights = [...new Set(layers.map(l => l.height))].sort((a, b) => b - a);
  return ["auto", "source", ...heights.slice(1).map(h => `${h}p` as const)];
}

/**
 * The menu entry a quality stands for: itself when offered, else the tallest offered height not above it (the
 * smallest offered height, or Source when the stream has no lower layer).
 */
export function nearestChoice(choice: ViewerQuality, choices: readonly ViewerQuality[]): ViewerQuality {
  if (choices.includes(choice)) return choice;
  const height = Number.parseInt(choice, 10);
  const offered = choices.filter(c => c !== "auto" && c !== "source").sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
  return offered.find(c => Number.parseInt(c, 10) <= height) ?? offered[offered.length - 1] ?? "source";
}

export function viewerQualityLabel(choice: ViewerQuality): string {
  return choice === "auto" ? "Auto" : choice === "source" ? "Source" : choice;
}

export function describeScreenShare(choice: ScreenShareChoice): string {
  return `${RESOLUTION_LABEL[choice.resolution]} · ${choice.fps} fps`;
}

export function isScreenResolution(value: unknown): value is ScreenResolution {
  return typeof value === "string" && (SCREEN_RESOLUTIONS as readonly string[]).includes(value);
}
export function isScreenFps(value: unknown): value is ScreenFps {
  return typeof value === "number" && (SCREEN_FPS as readonly number[]).includes(value);
}
export function isCameraResolution(value: unknown): value is CameraResolution {
  return typeof value === "string" && (CAMERA_RESOLUTIONS as readonly string[]).includes(value);
}
export function isViewerQuality(value: unknown): value is ViewerQuality {
  return typeof value === "string" && (value === "auto" || value === "source" || /^[1-9]\d{1,3}p$/.test(value));
}
export function isStreamContent(value: unknown): value is StreamContent {
  return value === "motion" || value === "detail";
}
