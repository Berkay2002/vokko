// Mock-mode transport (endpoint "mock://voice"): no getUserMedia, no WebRTC. Connecting walks through the same statuses as
// LiveKit, the other participants "speak" on a fixed rhythm and the push-to-talk key drives the self speaking ring.
// The fake microphone follows the LiveKit transport's publish rules (nothing published while self-muted, device switches keep
// the mute) so engine tests can observe them.

import type { Snowflake } from "../api/types";
import { VadGate } from "./vad";
import type { CameraStart, TransportCallbacks, TransportOptions, VoiceTransport } from "./transport";
import type { VoiceSettings } from "./reducer";
import type { VideoHandle, VideoSource } from "./mediaStore";
import type { ScreenShareChoice, StreamLayer, ViewerQuality } from "./video/options";

/** Speaking toggles every this many ms (on, off, on, …). */
export const FAKE_SPEAK_PERIOD_MS = 1500;
const STEP_MS = 60;

export interface FakeMic {
  deviceId: string;
  muted: boolean;
}

const FAKE_SCREEN_LAYERS: readonly StreamLayer[] = [
  { width: 640, height: 360, quality: "low" },
  { width: 1280, height: 720, quality: "medium" },
  { width: 1920, height: 1080, quality: "high" },
];

export class FakeTransport implements VoiceTransport {
  /** The published microphone, or null when nothing is published. */
  mic: FakeMic | null = null;
  /** Every publish / device switch with the mic state at that moment. */
  readonly micLog: ({ event: "publish" | "switch" } & FakeMic)[] = [];
  private connected = false;
  private selfMute = false;
  private settings: VoiceSettings | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private options: TransportOptions | null = null;
  private on = false;
  private deaf = false;
  private gate: VadGate | null = null;
  private gateTicker: ReturnType<typeof setInterval> | null = null;
  private selfOpen = false;
  private volumes = new Map<Snowflake, number>();
  /** Our published camera / screen share (null = off): what the engine asked for, observable by tests. */
  camera: CameraStart | null = null;
  screen: ScreenShareChoice | null = null;
  readonly watching = new Set<Snowflake>();
  readonly qualities = new Map<string, ViewerQuality>();
  private readonly remoteVideo = new Map<string, FakePicture>();
  private paintTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cb: TransportCallbacks) {}

  async connect(_endpoint: string, _token: string, options: TransportOptions): Promise<void> {
    await this.disconnect();
    this.options = options;
    this.deaf = options.selfDeaf;
    this.selfMute = options.selfMute;
    this.settings = options.settings;
    this.gate = new VadGate({ mode: options.settings.inputMode, thresholdDb: options.settings.vadThresholdDb, auto: options.settings.vadAuto, pttReleaseMs: options.settings.pttReleaseMs });
    this.gate.setForcedClosed(options.selfMute);
    this.timers.push(setTimeout(() => this.cb.status("rtc_connecting"), STEP_MS));
    this.timers.push(
      setTimeout(() => {
        this.connected = true;
        this.cb.status("connected");
        this.cb.quality("excellent", 12);
        if (!this.selfMute) this.publishMic();
        this.speakTick();
        this.ticker = setInterval(() => this.speakTick(), FAKE_SPEAK_PERIOD_MS);
      }, STEP_MS * 2),
    );
    // No microphone: the gate sees silence, so only push-to-talk opens it.
    this.gateTicker = setInterval(() => this.report(this.gate?.push(-100) ?? false), 10);
    void this.refreshDevices();
  }

  async disconnect(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ticker) clearInterval(this.ticker);
    if (this.gateTicker) clearInterval(this.gateTicker);
    this.ticker = this.gateTicker = null;
    this.dropVideos();
    void this.camera?.session?.stop();
    this.camera = null;
    this.screen = null;
    this.watching.clear();
    this.options = null;
    this.on = false;
    this.selfOpen = false;
    this.connected = false;
    this.mic = null;
  }

  async dispose(): Promise<void> {
    await this.disconnect();
  }

  setSelfMute(mute: boolean): void {
    this.selfMute = mute;
    this.gate?.setForcedClosed(mute);
    this.report(this.gate?.open ?? false);
    if (this.mic) this.mic.muted = mute;
    else if (!mute && this.connected) this.publishMic();
  }

  setSelfDeaf(deaf: boolean): void {
    this.deaf = deaf;
  }

  setUserVolume(userId: Snowflake, volume: number): void {
    this.volumes.set(userId, volume);
  }

  applySettings(settings: VoiceSettings): void {
    const prev = this.settings;
    this.settings = settings;
    if (this.mic && prev && prev.inputDeviceId !== settings.inputDeviceId) {
      this.mic = { deviceId: settings.inputDeviceId, muted: this.selfMute };
      this.micLog.push({ event: "switch", ...this.mic });
    }
    this.gate?.configure({ mode: settings.inputMode, thresholdDb: settings.vadThresholdDb, auto: settings.vadAuto, pttReleaseMs: settings.pttReleaseMs });
  }

  setPttPressed(pressed: boolean): void {
    this.report(this.gate?.setKey(pressed) ?? false);
  }

  async refreshDevices(): Promise<void> {
    this.cb.devices([{ deviceId: "default", label: "Default" }, { deviceId: "fake-mic", label: "Fake Microphone" }], [{ deviceId: "default", label: "Default" }], true);
  }

  async setCamera(on: boolean, start?: CameraStart): Promise<void> {
    const id = this.options?.selfId;
    if (!on || !start) {
      void this.camera?.session?.stop();
      this.camera = null;
      if (id) this.cb.video?.(id, "camera", null);
      this.releaseLocal("camera");
      return;
    }
    if (!this.connected) {
      this.cb.localVideoEnded?.("camera");
      return;
    }
    this.camera = start;
    const session = start.session;
    // A real preview capture is shown as is; without one (no camera in mock mode) a painted picture stands in.
    const handle: VideoHandle = session ? { attach: el => session.attach(el), detach: el => session.detach(el) } : this.picture(`self:camera`, "You", "camera").handle;
    if (id) this.cb.video?.(id, "camera", handle);
  }

  async setScreenShare(on: boolean, choice?: ScreenShareChoice): Promise<void> {
    const id = this.options?.selfId;
    if (!on || !choice) {
      this.screen = null;
      if (id) this.cb.video?.(id, "screen", null);
      this.releaseLocal("screen");
      return;
    }
    if (!this.connected) {
      this.cb.localVideoEnded?.("screen");
      return;
    }
    this.screen = choice;
    if (id) this.cb.video?.(id, "screen", this.picture(`self:screen`, "Your screen", "screen").handle);
  }

  watchStream(userId: Snowflake, watch: boolean): void {
    if (watch) this.watching.add(userId);
    else this.watching.delete(userId);
    this.syncVideo();
  }

  setViewerQuality(userId: Snowflake, source: VideoSource, quality: ViewerQuality): void {
    this.qualities.set(`${userId}:${source}`, quality);
  }

  /** Makes the remote pictures match the voice states: a camera while self_video, a screen while self_stream and watched. */
  syncVideo(): void {
    const options = this.options;
    if (!options?.videoOf || !this.connected) return;
    const wanted = new Map<string, { user: Snowflake; source: VideoSource }>();
    for (const user of options.participants()) {
      const live = options.videoOf(user);
      if (live.camera) wanted.set(`${user}:camera`, { user, source: "camera" });
      if (live.screen && this.watching.has(user)) wanted.set(`${user}:screen`, { user, source: "screen" });
    }
    for (const [key, picture] of this.remoteVideo) {
      if (wanted.has(key) || key.startsWith("self:")) continue; // our own pictures follow setCamera / setScreenShare, not the voice states
      const [user, source] = key.split(":") as [Snowflake, VideoSource];
      picture.stop();
      this.remoteVideo.delete(key);
      this.cb.video?.(user, source, null);
    }
    for (const [key, { user, source }] of wanted) {
      if (this.remoteVideo.has(key)) continue;
      const picture = this.picture(key, source === "camera" ? "Camera" : "Screen share", source);
      this.remoteVideo.set(key, picture);
      // Screens arrive like a 1080p share from the LiveKit transport: the stream quality menu offers its layers.
      this.cb.video?.(user, source, source === "screen" ? { ...picture.handle, layers: FAKE_SCREEN_LAYERS } : picture.handle);
    }
  }

  private picture(key: string, label: string, source: VideoSource): FakePicture {
    const existing = this.remoteVideo.get(key);
    if (existing) return existing;
    const picture = makePicture(label, source);
    if (key.startsWith("self:")) this.remoteVideo.set(key, picture);
    this.startPainting();
    return picture;
  }

  private releaseLocal(source: VideoSource): void {
    const key = `self:${source}`;
    this.remoteVideo.get(key)?.stop();
    this.remoteVideo.delete(key);
  }

  private startPainting(): void {
    if (this.paintTimer || typeof document === "undefined") return;
    this.paintTimer = setInterval(() => this.remoteVideo.forEach(p => p.paint()), 250);
  }

  private dropVideos(): void {
    if (this.paintTimer) clearInterval(this.paintTimer);
    this.paintTimer = null;
    this.remoteVideo.forEach(p => p.stop());
    this.remoteVideo.clear();
  }

  /** Volume the fake mixer would play a user at (tests / debugging). */
  volumeOf(userId: Snowflake): number {
    return this.volumes.get(userId) ?? this.options?.volumeOf(userId) ?? 1;
  }

  get deafened(): boolean {
    return this.deaf;
  }

  private publishMic(): void {
    this.mic = { deviceId: this.settings?.inputDeviceId ?? "default", muted: this.selfMute };
    this.micLog.push({ event: "publish", ...this.mic });
  }

  private speakTick(): void {
    if (!this.options) return;
    this.on = !this.on;
    // Speaking is what the SFU reports; a locally muted or deafened listener still sees rings (as with LiveKit).
    this.cb.speaking(this.on ? this.options.participants() : []);
    this.syncVideo();
  }

  private report(open: boolean): void {
    if (open === this.selfOpen) return;
    this.selfOpen = open;
    this.cb.selfSpeaking(open);
  }
}

interface FakePicture {
  handle: VideoHandle;
  paint(): void;
  stop(): void;
}

/** A painted stand-in for a video: a moving gradient on a canvas, exposed as a MediaStream (mock mode has no camera). */
function makePicture(label: string, source: VideoSource): FakePicture {
  if (typeof document === "undefined") return { handle: { attach() {}, detach() {} }, paint() {}, stop() {} };
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream?.(4) ?? null;
  let tick = 0;
  const paint = () => {
    if (!ctx) return;
    tick += 1;
    const hue = (tick * 6 + (source === "screen" ? 200 : 20)) % 360;
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${hue} 55% 30%)`);
    gradient.addColorStop(1, `hsl(${(hue + 70) % 360} 55% 42%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "hsl(0 0% 100% / 0.9)";
    ctx.font = "28px sans-serif";
    ctx.fillText(label, 24, 48);
    ctx.fillRect(24 + ((tick * 12) % 560), 300, 32, 32);
  };
  paint();
  return {
    handle: {
      attach: el => {
        if (stream) el.srcObject = stream;
        void el.play?.().catch(() => undefined);
      },
      detach: el => {
        if (el.srcObject === stream) el.srcObject = null;
      },
    },
    paint,
    stop: () => stream?.getTracks().forEach(t => t.stop()),
  };
}
