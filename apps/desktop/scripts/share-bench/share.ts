// Screen-share bench page (docs/perf.md "Game screen share"), served by Vite from apps/desktop and driven by run.mjs.
// ?role=pub publishes a screen share with the app's own plan (buildScreenShare + publishOptions); ?codec= forces a codec
// for A/B runs. ?role=view watches it at full quality and measures the audio/video offset of load.html's tick.
// window.__bench.take() returns the stats since the last call.
import { Room, RoomEvent, Track, VideoQuality, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
import { publishOptions } from "../../src/voice/livekitVideo";
import { installHardwareH264Preference } from "../../src/voice/video/h264";
import { buildScreenShare, detectCodecSupport, hardwareH264Profiles, probeHardwareEncoders, type ScreenFps, type ScreenResolution, type VideoCodecName } from "../../src/voice/video/options";

const q = new URLSearchParams(location.search);
const role = q.get("role") ?? "pub";
const url = q.get("url") ?? "ws://127.0.0.1:1474";
const token = q.get("token") ?? "";

type Report = Record<string, unknown> & { id: string; type: string; timestamp: number };
let last = new Map<string, Report>();

async function rtpStats(pc: RTCRtpSender | RTCRtpReceiver | undefined, kind: "outbound-rtp" | "inbound-rtp") {
  if (!pc) return [];
  const all = new Map<string, Report>();
  (await pc.getStats()).forEach((r: Report) => all.set(r.id, r));
  const out = [];
  for (const r of all.values()) {
    if (r.type === "media-source" && r.kind === "video") out.push({ source: `${r.width}x${r.height}`, sourceFps: r.framesPerSecond });
    if (r.type !== kind || r.kind !== "video") continue;
    const prev = last.get(r.id);
    const dt = prev ? (r.timestamp - prev.timestamp) / 1000 : 0;
    const delta = (key: string) => (prev && dt > 0 ? (Number(r[key] ?? 0) - Number(prev[key] ?? 0)) / dt : undefined);
    const frames = prev ? Number(r.framesEncoded ?? r.framesDecoded ?? 0) - Number(prev.framesEncoded ?? prev.framesDecoded ?? 0) : 0;
    const time = prev ? Number(r.totalEncodeTime ?? r.totalDecodeTime ?? 0) - Number(prev.totalEncodeTime ?? prev.totalDecodeTime ?? 0) : 0;
    const codecReport = all.get(String(r.codecId));
    const codec = codecReport?.mimeType;
    const fmtp = codecReport?.sdpFmtpLine;
    out.push({
      rid: r.rid,
      codec,
      fmtp,
      scalabilityMode: r.scalabilityMode,
      impl: r.encoderImplementation ?? r.decoderImplementation,
      powerEfficient: r.powerEfficientEncoder ?? r.powerEfficientDecoder,
      size: `${r.frameWidth}x${r.frameHeight}`,
      fps: r.framesPerSecond,
      kbps: delta(kind === "outbound-rtp" ? "bytesSent" : "bytesReceived")! * 0.008,
      msPerFrame: frames > 0 ? (time * 1000) / frames : undefined,
      qualityLimitation: r.qualityLimitationReason,
      framesDropped: r.framesDropped,
    });
    last.set(r.id, r);
  }
  return out;
}

async function publish() {
  // In Chrome (--pub chrome) take the Windows app's codec choices too (windowsApp()); the WebView2 host already sets it.
  const g = globalThis as { isTauri?: boolean };
  if (!g.isTauri) g.isTauri = true;
  await probeHardwareEncoders();
  if (q.get("munge") !== "0") installHardwareH264Preference(hardwareH264Profiles);
  const support = detectCodecSupport();
  const forced = q.get("codec") as VideoCodecName | null;
  const choice = { resolution: (q.get("res") ?? "1080p") as ScreenResolution, fps: Number(q.get("fps") ?? "60") as ScreenFps, audio: q.get("audio") === "1" };
  const plan = buildScreenShare(choice, { ...support, svcSimulcast: true });
  if (forced) plan.publish.codec = forced;
  if (q.get("simulcast") === "0") Object.assign(plan.publish, { simulcast: false, layers: [] });
  const room = new Room();
  await room.connect(url, token);
  await room.localParticipant.setScreenShareEnabled(
    true,
    { audio: choice.audio, resolution: plan.capture.resolution, contentHint: plan.capture.contentHint, selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include" },
    publishOptions(plan.publish, true),
  );
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const settings = pub?.track?.mediaStreamTrack.getSettings();
  return {
    info: { ua: navigator.userAgent, support, plan: plan.publish, capture: settings, audio: !!room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio) },
    take: async () => rtpStats(pub?.track?.sender, "outbound-rtp"),
  };
}

// ?role=loop: no LiveKit, a plain two-PeerConnection loopback of the share with ?codec= and an optional H.264 ?profile=
// (profile-level-id), to see which encoder the browser picks for a given SDP format.
async function loop() {
  const res = (q.get("res") ?? "1080p") as ScreenResolution;
  const fps = Number(q.get("fps") ?? "60");
  const size = { "720p": [1280, 720], "1080p": [1920, 1080], "1440p": [2560, 1440], source: [3840, 2160] }[res];
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: size[0], height: size[1], frameRate: fps } });
  const track = stream.getVideoTracks()[0];
  track.contentHint = q.get("hint") ?? "motion";
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = e => void (e.candidate && b.addIceCandidate(e.candidate));
  b.onicecandidate = e => void (e.candidate && a.addIceCandidate(e.candidate));
  const tr = a.addTransceiver(track, { direction: "sendonly", sendEncodings: [{ maxBitrate: 8_000_000, maxFramerate: fps }] });
  const mime = `video/${q.get("codec") ?? "h264"}`.toLowerCase();
  const profile = q.get("profile");
  const caps = RTCRtpSender.getCapabilities("video")!.codecs.filter(c => c.mimeType.toLowerCase() === mime && (!profile || c.sdpFmtpLine?.includes(`profile-level-id=${profile}`)));
  tr.setCodecPreferences(caps);
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription();
  await a.setRemoteDescription(b.localDescription!);
  const types = ["video/H264", "video/H264;profile-level-id=42e01f;packetization-mode=1", "video/H264;profile-level-id=42001f;packetization-mode=1", "video/H264;profile-level-id=640032;packetization-mode=1", "video/VP9", "video/AV1", "video/H265"];
  const mc = Object.fromEntries(
    await Promise.all(
      types.map(async t => {
        const info = await navigator.mediaCapabilities.encodingInfo({ type: "webrtc", video: { contentType: t, width: 1920, height: 1080, framerate: 60, bitrate: 6_000_000 } }).catch((e: unknown) => String(e));
        return [t, typeof info === "string" ? info : `${info.supported}/${info.powerEfficient}`];
      }),
    ),
  );
  return { info: { capture: track.getSettings(), offered: caps.map(c => c.sdpFmtpLine), mc }, take: async () => rtpStats(tr.sender, "outbound-rtp") };
}

async function view() {
  const room = new Room({ adaptiveStream: false });
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  document.body.append(video);
  const audioEl = document.createElement("audio");
  audioEl.muted = true;
  document.body.append(audioEl);
  let videoTrack: RemoteTrack | undefined;
  const flashes: number[] = [];
  const onsets: number[] = [];
  const ctx = new AudioContext();

  // Video: sample the tick square on every presented frame.
  const canvas = new OffscreenCanvas(64, 36);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  let white = false;
  const onFrame = (now: number) => {
    g.drawImage(video, 0, 0, 64, 36);
    const [r] = g.getImageData(1, 1, 1, 1).data;
    const isWhite = r > 200;
    if (isWhite && !white) flashes.push(now);
    white = isWhite;
    video.requestVideoFrameCallback(onFrame);
  };

  // Audio: an onset is the first loud sample after 300 ms of quiet, in performance.now() time.
  const worklet = `registerProcessor("onset", class extends AudioWorkletProcessor {
    constructor() { super(); this.quiet = 0; }
    process([input]) { const ch = input[0]; if (!ch) return true;
      for (let i = 0; i < ch.length; i++) { if (Math.abs(ch[i]) > 0.05) { if (this.quiet > 0.3 * sampleRate) this.port.postMessage(currentTime + i / sampleRate); this.quiet = 0; } else this.quiet++; }
      return true; } });`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "onset");
  node.port.onmessage = (e: MessageEvent<number>) => {
    const ts = ctx.getOutputTimestamp();
    onsets.push(ts.performanceTime! + (e.data - ts.contextTime!) * 1000);
  };

  room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => pub.setSubscribed(true));
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
    if (track.kind === Track.Kind.Video) {
      pub.setVideoQuality(VideoQuality.HIGH);
      track.attach(video);
      videoTrack = track;
      video.requestVideoFrameCallback(onFrame);
    } else {
      track.attach(audioEl);
      ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(node);
    }
  });
  await room.connect(url, token, { autoSubscribe: true });
  return {
    info: { ua: navigator.userAgent },
    take: async () => {
      const stats = await rtpStats(videoTrack?.receiver, "inbound-rtp");
      // Pair each flash with the nearest onset within 500 ms: positive = audio later than the picture.
      const offsets = flashes.flatMap(f => {
        const near = onsets.reduce<number | undefined>((best, o) => (Math.abs(o - f) < 500 && (best === undefined || Math.abs(o - f) < Math.abs(best - f)) ? o : best), undefined);
        return near === undefined ? [] : [Math.round(near - f)];
      });
      const out = { stats, flashes: flashes.length, onsets: onsets.length, offsets };
      flashes.length = 0;
      onsets.length = 0;
      return out;
    },
  };
}

(window as unknown as { __bench: Promise<unknown> }).__bench = (role === "pub" ? publish() : role === "loop" ? loop() : view()).catch((e: unknown) => ({ error: String(e) }));
